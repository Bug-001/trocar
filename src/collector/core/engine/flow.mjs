// flow.mjs — per-connection routing (RFC 4.6 §引擎). For each redirected connection the engine
// opens the original destination, watches which side speaks first, sniffs the client's first bytes,
// and then decrypts / splices / tunnels. On the default path it only forwards the bytes it received
// (passive relay); a decrypted flow additionally feeds a copy to the exchange tee. Any failure is
// fail-open at the byte level: we destroy our own sockets and never inject bytes of our own.
import net from 'node:net'
import tls from 'node:tls'
import { classify, parseClientHello, parseHead } from './sniff.mjs'
import { createExchangeTee } from './exchange.mjs'
import { negKey } from './negcache.mjs'

export function handleFlow(client, meta, ctx) {
  const t0 = Date.now()
  const rec = {
    ts: new Date().toISOString(), flow_id: ctx.newFlowId(), pid: meta.pid, agent: meta.agent,
    dst: meta.dst, host: null, decision: null, reason: null, bytes_up: 0, bytes_down: 0, duration_ms: 0,
  }
  let resolveFlow
  const flowDone = new Promise((res) => { resolveFlow = res })

  let activeTee = null
  let finished = false
  let handedOff = false     // true once a routing decision hands the sockets to relay()
  let firstByteTimer = null
  function finish(decision, extra = {}) {
    if (finished) return
    finished = true
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    if (decision && !rec.decision) rec.decision = decision
    Object.assign(rec, extra)
    rec.duration_ms = Date.now() - t0
    // a WebSocket connection: the recorder's summary (frames, calls, tail_raw, failures, …; RFC 4.6 §记录)
    const ws = activeTee && activeTee.wsSummary && activeTee.wsSummary()
    if (ws) { rec.transport = 'ws'; rec.ws = ws }
    try { ctx.store.flow(rec) } catch { /* recording never breaks teardown */ }
    resolveFlow(rec)
  }
  function teardown() {
    if (activeTee) { try { activeTee.abort({ type: 'ECONNRESET', message: 'flow closed' }) } catch { /* ignore */ } }
    finish()
  }
  function setDecision(inner, isTunnel) {
    if (isTunnel) { rec.decision = 'tunnel'; if (!rec.reason) rec.reason = inner }
    else if (!rec.decision || rec.decision === null) rec.decision = inner
  }

  // Before any routing decision, a side closing/erroring/ending (or nobody ever speaking, or the
  // upstream connect failing) must still finalize the flow and drop the peer — otherwise the flow
  // promise never resolves and engine.close() hangs on it. Disarmed once relay() owns teardown.
  function preTeardown(errObj) {
    if (handedOff || finished) return
    finish('error', errObj ? { error: errObj } : {})
    try { if (!client.destroyed) client.destroy() } catch { /* ignore */ }
    try { if (!upstream.destroyed) upstream.destroy() } catch { /* ignore */ }
  }

  const upstream = ctx.connectUpstream(meta.dst)
  upstream.once('error', (err) => preTeardown({ type: err.code || 'upstream_error', message: String((err && err.message) || err) }))
  upstream.on('close', () => preTeardown())
  client.on('close', () => preTeardown())
  client.on('end', () => preTeardown())
  // The client socket is ours from accept: an error on it (a reset before we have decided, a write
  // to a client that already left) MUST be handled here, or it is an uncaughtException that takes
  // the whole collector down (RFC 4.6 fail-open). relay() and the TLS wrap own it after the decision.
  client.on('error', (err) => preTeardown({ type: err.code || 'client_error', message: String((err && err.message) || err) }))

  // Passive bidirectional relay; forwards received bytes untouched and (optionally) tees a copy.
  // The upstream's FIN half-closes the client gracefully (the client drains the response, then
  // closes), so a mid-flight response is never truncated. Any client-side end/close/error means the
  // agent is gone → destroy the upstream TLS socket at once (acceptance T3: client disconnect tears
  // down the upstream). We destroy the TLS socket directly rather than end()-then-destroy, because a
  // destroy that follows a graceful end() does not RST the underlying connection.
  function relay(cSock, uSock) {
    handedOff = true // relay now owns teardown; the pre-decision handlers go quiet
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    const tee = activeTee
    cSock.on('data', (d) => { rec.bytes_up += d.length; if (tee) tee.fromClient(d); if (uSock.writable && !uSock.write(d)) cSock.pause() })
    uSock.on('drain', () => cSock.resume())
    uSock.on('data', (d) => { rec.bytes_down += d.length; if (tee) tee.fromUpstream(d); if (cSock.writable && !cSock.write(d)) uSock.pause() })
    cSock.on('drain', () => uSock.resume())
    // 'error' passes the Error, 'end' nothing, 'close' a boolean: a reset reaches the ws recorder as an error
    const clientGone = (e) => { if (tee) tee.clientEnded(e instanceof Error ? e : null); teardown(); try { if (!uSock.destroyed) uSock.destroy() } catch { /* ignore */ }; try { if (!upstream.destroyed) upstream.destroy() } catch { /* ignore */ } }
    const upstreamGone = (e) => { if (tee) tee.upstreamEnded(e instanceof Error ? e : null); teardown(); try { if (cSock.writable) cSock.end() } catch { /* ignore */ } } // let the client drain, then it closes
    cSock.on('end', clientGone); cSock.on('error', clientGone); cSock.on('close', clientGone)
    uSock.on('end', upstreamGone); uSock.on('error', upstreamGone); uSock.on('close', upstreamGone)
  }

  // ── first-speaker race + client sniff ─────────────────────────────────────────────────────────
  function route(cSock, uSock, preBuf, hostDefault, isTunnel) {
    const chunks = preBuf && preBuf.length ? [preBuf] : []
    let decided = false
    const onClient = (d) => {
      if (decided) return
      chunks.push(d)
      if (classify(Buffer.concat(chunks)) === 'need-more') return
      decide()
    }
    const onUpFirst = (d) => {
      if (decided) return
      decided = true
      cleanup()
      // upstream spoke first → splice (RFC 4.6 §引擎 2)
      setDecision('splice', isTunnel)
      if (chunks.length) uSock.write(Buffer.concat(chunks))
      if (d && d.length) { rec.bytes_down += d.length; cSock.write(d) }
      relay(cSock, uSock)
    }
    const cleanup = () => { cSock.removeListener('data', onClient); uSock.removeListener('data', onUpFirst) }
    function decide() {
      decided = true
      cleanup()
      dispatch(classify(Buffer.concat(chunks)), Buffer.concat(chunks), cSock, uSock, hostDefault, isTunnel)
    }
    cSock.on('data', onClient)
    uSock.on('data', onUpFirst)
    if (chunks.length && classify(Buffer.concat(chunks)) !== 'need-more') decide()
  }

  function dispatch(cls, buf, cSock, uSock, hostDefault, isTunnel) {
    if (cls === 'tls') return handleTls(buf, cSock, uSock, hostDefault, isTunnel)
    if (cls === 'connect' && !isTunnel) return handleConnect(buf, cSock, uSock)
    if (cls === 'http') return handleHttp(buf, cSock, uSock, hostDefault, isTunnel)
    // unknown (or a nested CONNECT) → splice verbatim
    setDecision('splice', isTunnel)
    if (buf.length) uSock.write(buf)
    relay(cSock, uSock)
  }

  // ── TLS: wait for the whole ClientHello, then decide decrypt vs splice ─────────────────────────
  function handleTls(initial, cSock, uSock, hostDefault, isTunnel) {
    const chunks = [initial]
    const onData = (d) => {
      chunks.push(d)
      const ch = parseClientHello(Buffer.concat(chunks))
      if (!ch.complete) return
      cSock.removeListener('data', onData); cSock.pause()
      decideTls(ch, Buffer.concat(chunks), cSock, uSock, hostDefault, isTunnel)
    }
    const ch0 = parseClientHello(initial)
    if (ch0.complete) { cSock.pause(); decideTls(ch0, initial, cSock, uSock, hostDefault, isTunnel) }
    else cSock.on('data', onData)
  }

  function decideTls(ch, buf, cSock, uSock, hostDefault, isTunnel) {
    const sni = ch.malformed ? null : ch.sni
    const alpn = ch.malformed ? null : ch.alpn
    const host = sni ?? hostDefault ?? meta.dst.address
    rec.host = host
    const key = negKey(meta, host)
    const h1 = alpn === null || alpn.includes('http/1.1')
    const neg = ctx.negCache.get(key)
    const target = meta.decrypt && !ch.malformed && ctx.policy(meta, sni ?? meta.dst.address)
    if (target && h1 && !neg) return decrypt(buf, cSock, uSock, sni, host, isTunnel, key)
    // A host we would decrypt but do not: say why in flows/ (invariant 4) — the negative cache (RFC 4.6
    // §引擎 5) or an only-h2 offer (§传输与帧级记录 · T8). Spliced either way; the redirector is never told.
    if (target && neg) { rec.not_captured = 'negative-cache'; rec.reason = neg.cause; ctx.counters.notCaptured.negative++ }
    else if (target && alpn.includes('h2')) { rec.not_captured = 'h2'; rec.reason = 'alpn-h2-only'; ctx.counters.notCaptured.h2++ }
    setDecision('splice', isTunnel); cSock.unshift(buf); cSock.resume(); relay(cSock, uSock)
  }

  // The upstream's certificate did not verify (private CA, expired, wrong name; RFC 4.6 §引擎 5, D37).
  // We do not stand in for it, and the agent must not lose its connection either: drop our handshake
  // (nothing of the client's was written on it), open a fresh connection to the original destination,
  // replay the client's buffered bytes (its ClientHello) verbatim and splice — the client then runs its
  // own handshake with the real upstream and judges the certificate itself. Inside a CONNECT / SOCKS
  // tunnel there is no fresh connection to open without re-sending the client's proxy prelude (its
  // credentials) on our own initiative (invariant 1 / D30), so that one flow is closed; (pid, host) is
  // negative at once either way, so later flows (the client's retry) splice without trying.
  function stepAside(upTls, buf, cSock, host, isTunnel, key) {
    const why = String(upTls.authorizationError || 'upstream certificate not verified')
    handedOff = true                                    // the original upstream closes under us; we own teardown
    try { upTls.destroy() } catch { /* ignore */ }
    ctx.negCache.mark(key, { cause: 'upstream-cert', meta, host })
    ctx.counters.notCaptured.upstreamCert++
    rec.not_captured = 'upstream-cert'; rec.reason = why
    if (isTunnel) {
      try { cSock.destroy() } catch { /* ignore */ }
      return finish('tunnel', { host, error: { type: 'upstream_cert', message: why } })
    }
    setDecision('splice', false)
    const fresh = ctx.connectUpstream(meta.dst)
    fresh.write(buf)                                    // the ClientHello, byte for byte
    cSock.resume(); relay(cSock, fresh)
  }

  function decrypt(buf, cSock, uSock, sni, host, isTunnel, key) {
    const ca = [...tls.rootCertificates, ...(ctx.upstreamCa ? [].concat(ctx.upstreamCa) : [])]
    // rejectUnauthorized:false only so the two upstream failures can be told apart: an 'error' before
    // 'secureConnect' is a network / protocol failure (the client is closed); a 'secureConnect' that is
    // not `authorized` (Node still checks chain and hostname) is a certificate that did not verify
    // (stepAside). Nothing is ever written on an unverified connection (§引擎 5).
    const upTls = tls.connect({ socket: uSock, servername: sni || undefined, ALPNProtocols: ['http/1.1'], ca, rejectUnauthorized: false })
    let clientTls = null
    upTls.on('error', (err) => {
      if (!clientTls) { try { cSock.destroy() } catch { /* ignore */ }; finish(isTunnel ? 'tunnel' : 'decrypt', { host, error: { type: err.code || 'upstream_tls_error', message: String((err && err.message) || err) } }) }
    })
    upTls.on('secureConnect', () => {
      if (!upTls.authorized) return stepAside(upTls, buf, cSock, host, isTunnel, key)
      setDecision('decrypt', isTunnel)
      cSock.unshift(buf)                                    // replay the ClientHello to our TLS server
      clientTls = new tls.TLSSocket(cSock, { isServer: true, secureContext: ctx.issuer.secureContextFor(host), ALPNProtocols: ['http/1.1'] })
      // Rejection (§引擎 5, D37): the client closes or resets without one byte of application data, alert
      // or not, Finished or not — Node sends no alert, and under TLS 1.2 our side of the handshake
      // completes before the client checks our leaf and hangs up. Judged on whichever of error / end /
      // close comes first, by listeners added BEFORE relay()'s: the reason is on the record before relay's
      // teardown writes it (the store serializes at call time). A connection that carried data resets
      // the (pid, host) count.
      let appData = false, judged = false
      clientTls.once('data', () => { appData = true })
      const judge = () => {
        if (judged) return
        judged = true
        if (!appData) rec.reason = 'client-rejected-leaf'
        ctx.negCache.observe(key, { rejected: !appData, meta, host })
      }
      clientTls.on('error', judge); clientTls.on('end', judge); clientTls.on('close', judge)
      activeTee = createExchangeTee({
        flow: { id: rec.flow_id, host, scheme: 'https', dst: meta.dst, proc: { pid: meta.pid, exe: meta.exe ?? null, agent: meta.agent } },
        recordStore: ctx.store, isRecording: ctx.isRecording, wsTerminal: meta.wsTerminal ?? null,
      })
      relay(clientTls, upTls)
    })
  }

  // ── CONNECT: relay the proxy exchange verbatim, then route the tunnelled bytes ─────────────────
  function handleConnect(initial, cSock, uSock) {
    const chunks = [initial]
    const onData = (d) => {
      chunks.push(d)
      const h = parseHead(Buffer.concat(chunks))
      if (!h) return
      cSock.removeListener('data', onData)
      afterConnectHead(h, Buffer.concat(chunks), cSock, uSock)
    }
    const h0 = parseHead(initial)
    if (h0) afterConnectHead(h0, initial, cSock, uSock)
    else cSock.on('data', onData)
  }

  function afterConnectHead(h, buf, cSock, uSock) {
    const authority = (h.startLine.split(' ')[1] || '')
    const connectHost = authority.split(':')[0]
    const innerPre = buf.subarray(h.headLength)               // usually empty (client waits for 2xx)
    uSock.write(buf.subarray(0, h.headLength))                // forward the CONNECT head verbatim
    const upChunks = []
    const onUp = (d) => {
      upChunks.push(d)
      const ph = parseHead(Buffer.concat(upChunks))
      if (!ph) return
      uSock.removeListener('data', onUp)
      const all = Buffer.concat(upChunks)
      cSock.write(all.subarray(0, ph.headLength))             // relay the proxy reply head verbatim
      const after = all.subarray(ph.headLength)
      const status = parseInt(ph.startLine.split(' ')[1], 10)
      if (status >= 200 && status < 300) {
        if (after.length) cSock.write(after)
        route(cSock, uSock, innerPre, connectHost, true)      // decrypt/splice the tunnelled TLS
      } else {
        setDecision('tunnel'); rec.reason = `proxy-status-${status}`; rec.host = connectHost
        if (after.length) cSock.write(after)
        relay(cSock, uSock)
      }
    }
    uSock.on('data', onUp)
  }

  // ── plain HTTP (scheme http) ───────────────────────────────────────────────────────────────────
  function handleHttp(buf, cSock, uSock, hostDefault, isTunnel) {
    const h = parseHead(buf)
    let host = hostDefault ?? meta.dst.address
    if (h) for (const [k, v] of h.headers) if (k.toLowerCase() === 'host') host = v.split(':')[0]
    rec.host = host
    if (meta.decrypt && ctx.policy(meta, host)) {
      setDecision('decrypt', isTunnel)
      activeTee = createExchangeTee({
        flow: { id: rec.flow_id, host, scheme: 'http', dst: meta.dst, proc: { pid: meta.pid, exe: meta.exe ?? null, agent: meta.agent } },
        recordStore: ctx.store, isRecording: ctx.isRecording, wsTerminal: meta.wsTerminal ?? null,
      })
      activeTee.fromClient(buf)
      rec.bytes_up += buf.length
      uSock.write(buf)
      relay(cSock, uSock)
    } else {
      setDecision('splice', isTunnel)
      if (buf.length) uSock.write(buf)
      relay(cSock, uSock)
    }
  }

  // Kick off once the upstream TCP is usable. connectUpstream returns a connecting socket; we can
  // write/route as soon as a side speaks — route() buffers client bytes until a decision.
  route(client, upstream, Buffer.alloc(0), null, false)

  // First-byte safety valve: if neither side ever speaks, finalize and drop the connection rather
  // than leak it. unref so a pending timer can't hold the event loop open.
  firstByteTimer = setTimeout(() => preTeardown({ type: 'first_byte_timeout', message: 'no bytes before timeout' }), ctx.firstByteTimeoutMs ?? 5000)
  if (firstByteTimer.unref) firstByteTimer.unref()

  // Catch a client that was already gone before our listeners attached (accept/lookup raced the close).
  if (client.destroyed) queueMicrotask(() => preTeardown(client.errored ? { type: client.errored.code || 'client_error', message: String(client.errored.message || client.errored) } : undefined))

  return flowDone
}
