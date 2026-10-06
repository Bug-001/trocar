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
import { createUpstreamTrust } from '../tls/roots.mjs'
import { socksHandshake } from './socks.mjs'

const msgOf = (e) => String((e && e.message) || e)
// host of a CONNECT authority or a SOCKS target: "[::1]:443" → "::1", "a.test:443" → "a.test"
const hostOf = (authority) => (authority.startsWith('[') ? authority.slice(1, Math.max(1, authority.indexOf(']'))) : authority.split(':')[0])
const closedBefore = (side) => ({ type: 'closed_before_decision', message: `the ${side} closed before a routing decision`, side })

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
  let selfClosed = false    // the engine tore this flow down itself (internalError)
  let upstream = null       // the TCP connection to the original destination
  let firstByteTimer = null
  let slowTimer = null      // the upstream-slow watch while the engine waits on the upstream (RFC 4.6 §记录)
  // Waiting on the upstream (our TLS handshake to it, a proxy's reply) has no time limit: cutting the
  // agent because its upstream or proxy is slow would break it (D31). Past `upstreamSlowMs` (5 s) the
  // wait is recorded once as an upstream-slow event (D38), and the connection goes on.
  function waitFor(phase, host) {
    waitDone()
    const ms = ctx.upstreamSlowMs ?? 5000, t0w = Date.now()
    slowTimer = setTimeout(() => { slowTimer = null; ctx.failure({ reason: 'upstream-slow', flow_id: rec.flow_id, host, phase, waited_ms: Date.now() - t0w }) }, ms)
    if (slowTimer.unref) slowTimer.unref()
  }
  function waitDone() { if (slowTimer) { clearTimeout(slowTimer); slowTimer = null } }
  // the row's not_captured code (closed set, codes.mjs) and why (RFC 4.6 §记录 连接行怎么落码)
  function notCaptured(code, reason) { rec.not_captured = code; if (reason != null) rec.reason = reason }
  // policy(meta, host): true = decrypt; {not_captured:'not-trust-path', reason} = the daemon's own expected
  // code; anything else = outside the decrypt policy. → null (decrypt) or [code, reason]
  function skipOf(host) {
    if (!meta.decrypt) return ['untrusted', null]
    const v = ctx.policy(meta, host)
    if (v && typeof v === 'object') return v.not_captured === 'not-trust-path' ? ['not-trust-path', v.reason ?? null] : ['policy', v.reason ?? null]
    return v ? null : ['policy', null]
  }
  function finish(decision, extra = {}) {
    if (finished) return
    finished = true
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    waitDone()
    if (decision && !rec.decision) rec.decision = decision
    Object.assign(rec, extra)
    if (rec.decision === 'error' && !rec.not_captured) rec.not_captured = 'error' // D38: every row the bytes missed has a code
    rec.duration_ms = Date.now() - t0
    // a WebSocket connection: the recorder's summary (frames, calls, tail_raw, failures, …; RFC 4.6 §记录)
    const ws = activeTee && activeTee.wsSummary && activeTee.wsSummary()
    if (ws) { rec.transport = 'ws'; rec.ws = ws }
    // envelopes the store did not write, and a decrypted connection whose later bytes were not framed (D38)
    const notes = activeTee && activeTee.rowNotes ? activeTee.rowNotes() : {}
    if (notes.writeFailed) rec.write_failed = notes.writeFailed
    if (notes.notFollowed && !rec.not_captured) notCaptured('upgrade-not-followed', notes.notFollowed)
    // bytes_up / bytes_down = the agent's own connection's wire bytes (RFC 4.6 §记录): read off the
    // accepted socket once it has closed, so proxy preludes, TLS records (and the closing alerts after
    // the flow ended) count on every path. A client that never closes its half gets written after 2 s.
    let written = false, cap = null
    const write = () => {
      if (written) return
      written = true
      if (cap) clearTimeout(cap)
      rec.bytes_up = client.bytesRead; rec.bytes_down = client.bytesWritten
      // recording never breaks teardown, and a record that was not written is not silent (D38)
      let ok = true, why = null
      try { ok = ctx.store.flow(rec) !== false } catch (e) { ok = false; why = e }
      if (!ok) ctx.failure({ code: 'flow-write-failed', flow_id: rec.flow_id, reason: msgOf(why || ctx.store.lastError || 'the store did not write the flow record') })
      resolveFlow(rec)
    }
    if (client.destroyed) return write()
    client.once('close', write)
    cap = setTimeout(write, 2000); if (cap.unref) cap.unref()
  }
  // An exception inside the engine's own handling (a bug, or daemon-supplied code such as the policy
  // throwing) costs this one flow, never the collector, and is recorded (RFC 4.6 §记录, D38): flows/
  // error + an engine-error failure event, both sockets closed. Every event handler that routes is guarded.
  function internalError(e) {
    ctx.failure({ code: 'engine-error', flow_id: rec.flow_id, reason: msgOf(e) })
    handedOff = true; selfClosed = true
    try { client.destroy() } catch { /* ignore */ }
    if (upstream) { try { upstream.destroy() } catch { /* ignore */ } }
    finish('error', { error: { type: 'engine_error', message: msgOf(e), side: 'engine' } })
  }
  const guard = (fn) => (...a) => { try { return fn(...a) } catch (e) { internalError(e) } }
  function teardown() {
    // open exchanges carry the connection's first error; a plain 'flow closed' only when there was none
    const why = rec.error ? { type: rec.error.type, message: rec.error.message } : { type: 'ECONNRESET', message: 'flow closed' }
    if (activeTee) { try { activeTee.abort(why) } catch (e) { ctx.failure({ code: 'engine-error', flow_id: rec.flow_id, reason: `recording stopped: ${msgOf(e)}` }) } }
    finish()
  }
  // inside a tunnel the row says decision:'tunnel' and what happened to the tunnelled bytes in `inner`;
  // reason / not_captured stay free for the why (RFC 4.6 §记录)
  function setDecision(inner, isTunnel) {
    if (isTunnel) { rec.decision = 'tunnel'; rec.inner = inner }
    else if (!rec.decision) rec.decision = inner
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

  // a synchronous throw (e.g. net.connect on a bad port) ends this flow with a record (D38)
  try { upstream = ctx.connectUpstream(meta.dst) } catch (e) { internalError(e); return flowDone }
  upstream.once('error', (err) => preTeardown({ type: err.code || 'upstream_error', message: msgOf(err), side: 'upstream' }))
  upstream.on('close', () => preTeardown(closedBefore('upstream')))
  client.on('close', () => preTeardown(closedBefore('client')))
  client.on('end', () => preTeardown(closedBefore('client')))
  // The client socket is ours from accept: an error on it (a reset before we have decided, a write
  // to a client that already left) MUST be handled here, or it is an uncaughtException that takes
  // the whole collector down (RFC 4.6 fail-open). relay() and the TLS wrap own it after the decision.
  client.on('error', (err) => preTeardown({ type: err.code || 'client_error', message: msgOf(err), side: 'client' }))

  // Passive bidirectional relay; forwards received bytes untouched and (optionally) tees a copy.
  // The upstream's FIN half-closes the client gracefully (the client drains the response, then
  // closes), so a mid-flight response is never truncated. Any client-side end/close/error means the
  // agent is gone → destroy the upstream TLS socket at once (acceptance T3: client disconnect tears
  // down the upstream). We destroy the TLS socket directly rather than end()-then-destroy, because a
  // destroy that follows a graceful end() does not RST the underlying connection.
  function relay(cSock, uSock) {
    handedOff = true // relay now owns teardown; the pre-decision handlers go quiet
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    let tee = activeTee
    // the recording side copy never throws into the forwarding path: a recorder that throws stops
    // recording this connection (recorded, D38) and the bytes keep flowing
    const copy = (fn) => { if (!tee) return; try { fn(tee) } catch (e) { tee = null; activeTee = null; ctx.failure({ code: 'engine-error', flow_id: rec.flow_id, reason: `recording stopped: ${msgOf(e)}` }) } }
    cSock.on('data', (d) => { copy((t) => t.fromClient(d)); if (uSock.writable && !uSock.write(d)) cSock.pause() })
    uSock.on('drain', () => cSock.resume())
    uSock.on('data', (d) => { copy((t) => t.fromUpstream(d)); if (cSock.writable && !cSock.write(d)) uSock.pause() })
    cSock.on('drain', () => uSock.resume())
    // the first socket error of the flow, with its side, goes to flows/ (D38)
    const noteError = (e, side) => { if (e instanceof Error && !rec.error) rec.error = { type: e.code || 'error', message: msgOf(e), side } }
    // 'error' passes the Error, 'end' nothing, 'close' a boolean: a reset reaches the ws recorder as an error
    const clientGone = (e) => { noteError(e, 'client'); copy((t) => t.clientEnded(e instanceof Error ? e : null)); teardown(); try { if (!uSock.destroyed) uSock.destroy() } catch { /* ignore */ }; try { if (!upstream.destroyed) upstream.destroy() } catch { /* ignore */ } }
    const upstreamGone = (e) => { noteError(e, 'upstream'); copy((t) => t.upstreamEnded(e instanceof Error ? e : null)); teardown(); try { if (cSock.writable) cSock.end() } catch { /* ignore */ } } // let the client drain, then it closes
    cSock.on('end', clientGone); cSock.on('error', clientGone); cSock.on('close', clientGone)
    uSock.on('end', upstreamGone); uSock.on('error', upstreamGone); uSock.on('close', upstreamGone)
  }

  // ── first-speaker race + client sniff ─────────────────────────────────────────────────────────
  function route(cSock, uSock, preBuf, hostDefault, isTunnel) {
    const chunks = preBuf && preBuf.length ? [preBuf] : []
    let decided = false
    const onClient = guard((d) => {
      if (decided) return
      chunks.push(d)
      if (classify(Buffer.concat(chunks)) === 'need-more') return
      decide()
    })
    const onUpFirst = guard((d) => {
      if (decided) return
      decided = true
      cleanup()
      // upstream spoke first → splice (RFC 4.6 §引擎 2)
      setDecision('splice', isTunnel); notCaptured('upstream-first')
      if (chunks.length) uSock.write(Buffer.concat(chunks))
      if (d && d.length) cSock.write(d)
      relay(cSock, uSock)
    })
    const cleanup = () => { cSock.removeListener('data', onClient); uSock.removeListener('data', onUpFirst) }
    function decide() {
      decided = true
      cleanup()
      // the client has spoken: the first-byte valve is done; any wait from here on is on the upstream
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
      dispatch(classify(Buffer.concat(chunks)), Buffer.concat(chunks), cSock, uSock, hostDefault, isTunnel)
    }
    cSock.on('data', onClient)
    uSock.on('data', onUpFirst)
    if (chunks.length && classify(Buffer.concat(chunks)) !== 'need-more') decide()
  }

  function dispatch(cls, buf, cSock, uSock, hostDefault, isTunnel) {
    if (cls === 'tls') return handleTls(buf, cSock, uSock, hostDefault, isTunnel)
    if (cls === 'connect' && !isTunnel) return handleConnect(buf, cSock, uSock)
    if (cls === 'socks' && !isTunnel) return handleSocks(buf, cSock, uSock)
    if (cls === 'http') return handleHttp(buf, cSock, uSock, hostDefault, isTunnel)
    // unknown (or a nested CONNECT / SOCKS prelude) → splice verbatim
    setDecision('splice', isTunnel); notCaptured('unknown-protocol', `first-byte 0x${buf.subarray(0, 1).toString('hex')}`)
    if (buf.length) uSock.write(buf)
    relay(cSock, uSock)
  }

  // ── TLS: wait for the whole ClientHello, then decide decrypt vs splice ─────────────────────────
  function handleTls(initial, cSock, uSock, hostDefault, isTunnel) {
    const chunks = [initial]
    const onData = guard((d) => {
      chunks.push(d)
      const ch = parseClientHello(Buffer.concat(chunks))
      if (!ch.complete) return
      cSock.removeListener('data', onData); cSock.pause()
      decideTls(ch, Buffer.concat(chunks), cSock, uSock, hostDefault, isTunnel)
    })
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
    const skip = !meta.decrypt ? ['untrusted', null] : ch.malformed ? ['malformed-hello', null] : skipOf(sni ?? meta.dst.address)
    if (!skip && h1 && !neg) return decrypt(buf, cSock, uSock, sni, host, isTunnel, key)
    // Every splice says why in flows/ (invariant 4, D38): untrusted / malformed / outside the policy, or a
    // host we would decrypt but do not — the negative cache (RFC 4.6 §引擎 5) or an offer without
    // http/1.1 (h2 only: T8). Spliced either way; the redirector is never told.
    if (skip) notCaptured(...skip)
    else if (neg) { notCaptured('negative-cache', neg.cause); ctx.counters.notCaptured.negative++ }
    else if (alpn.includes('h2')) { notCaptured('h2', 'alpn-h2-only'); ctx.counters.notCaptured.h2++ }
    else notCaptured('unknown-protocol', `alpn ${alpn.join(',')}`)
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
  //   A leaf we cannot issue (cause 'leaf-error', an internal error) steps aside the same way, but is
  // not negative-cached (asight's fault, not the host's) and is a leaf-error failure event (D38).
  function stepAside(upTls, buf, cSock, host, isTunnel, key, cause, why) {
    handedOff = true                                    // the original upstream closes under us; we own teardown
    try { upTls.destroy() } catch { /* ignore */ }
    if (cause === 'upstream-cert') { ctx.negCache.mark(key, { cause, meta, host }); ctx.counters.notCaptured.upstreamCert++ }
    else { ctx.counters.notCaptured.leafError++; ctx.failure({ code: 'leaf-error', flow_id: rec.flow_id, host, reason: why }) }
    rec.not_captured = cause; rec.reason = why
    if (isTunnel) {
      try { cSock.destroy() } catch { /* ignore */ }
      return finish('tunnel', { host, error: { type: cause.replace('-', '_'), message: why, side: cause === 'upstream-cert' ? 'upstream' : 'engine' } })
    }
    setDecision('splice', false)
    const fresh = ctx.connectUpstream(meta.dst)
    fresh.write(buf)                                    // the ClientHello, byte for byte
    cSock.resume(); relay(cSock, fresh)
  }

  function decrypt(buf, cSock, uSock, sni, host, isTunnel, key) {
    // the OS store ∪ Node's roots ∪ NODE_EXTRA_CA_CERTS (+ upstreamCa), one context (tls/roots.mjs)
    if (!ctx.upstreamTrust) ctx.upstreamTrust = createUpstreamTrust({ extra: ctx.upstreamCa })
    // rejectUnauthorized:false only so the two upstream failures can be told apart: an 'error' before
    // 'secureConnect' is a network / protocol failure (the client is closed); a 'secureConnect' that is
    // not `authorized` (Node still checks chain and hostname) is a certificate that did not verify
    // (stepAside). Nothing is ever written on an unverified connection (§引擎 5).
    const upTls = tls.connect({ socket: uSock, servername: sni || undefined, ALPNProtocols: ['http/1.1'], secureContext: ctx.upstreamTrust.secureContext, rejectUnauthorized: false })
    let clientTls = null
    waitFor('tls', host)
    upTls.on('error', (err) => {
      waitDone()
      if (!clientTls) { try { cSock.destroy() } catch { /* ignore */ }; finish(isTunnel ? 'tunnel' : 'decrypt', { host, not_captured: 'error', error: { type: err.code || 'upstream_tls_error', message: msgOf(err), side: 'upstream' } }) }
    })
    upTls.on('secureConnect', guard(() => {
      waitDone()
      if (!upTls.authorized) return stepAside(upTls, buf, cSock, host, isTunnel, key, 'upstream-cert', String(upTls.authorizationError || 'upstream certificate not verified'))
      let leaf
      try { leaf = ctx.issuer.secureContextFor(host) } catch (e) { return stepAside(upTls, buf, cSock, host, isTunnel, key, 'leaf-error', msgOf(e)) }
      setDecision('decrypt', isTunnel)
      cSock.unshift(buf)                                    // replay the ClientHello to our TLS server
      clientTls = new tls.TLSSocket(cSock, { isServer: true, secureContext: leaf, ALPNProtocols: ['http/1.1'] })
      // Rejection (§引擎 5, D37): the client closes or resets without one byte of application data, alert
      // or not, Finished or not — Node sends no alert, and under TLS 1.2 our side of the handshake
      // completes before the client checks our leaf and hangs up. Judged on whichever of error / end /
      // close comes first, by listeners added BEFORE relay()'s: the reason is on the record before relay's
      // teardown writes it (the store serializes at call time). A connection that carried data resets
      // the (pid, host) count. The rule is about the CLIENT going: an idle connection the upstream closed
      // first (a preconnect timing out), or one the engine tore down, says nothing about our leaf.
      let appData = false, judged = false, notClient = false
      clientTls.once('data', () => { appData = true })
      const otherSide = () => { if (!judged) notClient = true }
      upTls.on('end', otherSide); upTls.on('error', otherSide); upTls.on('close', otherSide)
      const judge = () => {
        if (judged) return
        judged = true
        if (appData) return ctx.negCache.observe(key, { rejected: false, meta, host })
        if (notClient || selfClosed) return
        notCaptured('client-rejected-leaf', 'client-rejected-leaf')
        ctx.negCache.observe(key, { rejected: true, meta, host })
      }
      clientTls.on('error', judge); clientTls.on('end', judge); clientTls.on('close', judge)
      activeTee = createExchangeTee({
        flow: { id: rec.flow_id, host, scheme: 'https', dst: meta.dst, proc: { pid: meta.pid, exe: meta.exe ?? null, agent: meta.agent } },
        recordStore: ctx.store, isRecording: ctx.isRecording, wsTerminal: meta.wsTerminal ?? null, onFailure: ctx.failure,
      })
      relay(clientTls, upTls)
    }))
  }

  // ── CONNECT: relay the proxy exchange verbatim, then route the tunnelled bytes ─────────────────
  function handleConnect(initial, cSock, uSock) {
    const chunks = [initial]
    const onData = guard((d) => {
      chunks.push(d)
      const h = parseHead(Buffer.concat(chunks))
      if (!h) return
      cSock.removeListener('data', onData)
      afterConnectHead(h, Buffer.concat(chunks), cSock, uSock)
    })
    const h0 = parseHead(initial)
    if (h0) afterConnectHead(h0, initial, cSock, uSock)
    else cSock.on('data', onData)
  }

  function afterConnectHead(h, buf, cSock, uSock) {
    const authority = (h.startLine.split(' ')[1] || '')
    const connectHost = hostOf(authority)
    // client bytes after the CONNECT head (usually none: the client waits for the 2xx). An eager client's
    // next bytes (its ClientHello) are held here until the proxy has answered — a flowing socket with no
    // 'data' listener would drop them.
    const early = [buf.subarray(h.headLength)]
    const hold = (d) => { early.push(d) }
    cSock.on('data', hold)
    uSock.write(buf.subarray(0, h.headLength))                // forward the CONNECT head verbatim
    waitFor('proxy-reply', connectHost)
    const upChunks = []
    const onUp = guard((d) => {
      upChunks.push(d)
      const ph = parseHead(Buffer.concat(upChunks))
      if (!ph) return
      uSock.removeListener('data', onUp); waitDone()
      cSock.removeListener('data', hold)
      const innerPre = Buffer.concat(early)
      const all = Buffer.concat(upChunks)
      cSock.write(all.subarray(0, ph.headLength))             // relay the proxy reply head verbatim
      const after = all.subarray(ph.headLength)
      const status = parseInt(ph.startLine.split(' ')[1], 10)
      // the prelude both ways, verbatim (Proxy-Authorization is a credential: flows/ is 0600, RFC 4.1)
      rec.prelude = { kind: 'connect', target: authority, client_b64: buf.subarray(0, h.headLength).toString('base64'), proxy_b64: all.subarray(0, ph.headLength).toString('base64') }
      if (status >= 200 && status < 300) {
        if (after.length) cSock.write(after)
        route(cSock, uSock, innerPre, connectHost, true)      // decrypt/splice the tunnelled TLS
      } else {
        rec.decision = 'tunnel'; notCaptured('proxy-refused', `proxy-status-${status}`); rec.host = connectHost
        if (after.length) cSock.write(after)
        if (innerPre.length) uSock.write(innerPre)            // whatever the client sent on, verbatim
        relay(cSock, uSock)
      }
    })
    uSock.on('data', onUp)
  }

  // ── SOCKS4 / 4a / 5: relay the prelude verbatim, then route the tunnelled bytes (§引擎 3, D37) ──
  // Each side's bytes are held until a whole prelude message has arrived, then forwarded unchanged and in
  // order; the proxy's answer — success or refusal — is the only answer the client gets (RFC 4.6 §记录 代理前导).
  function handleSocks(initial, cSock, uSock) {
    const side = (sock, pre) => {
      let buf = pre, want = null
      const pump = () => {
        if (!want) return
        const r = want.parser(buf)
        if (!r) return
        const w = want; want = null
        if (r.invalid) return w.resolve(r)
        const raw = buf.subarray(0, r.length); buf = buf.subarray(r.length)
        w.resolve({ ...r, raw })
      }
      const onData = guard((d) => { buf = Buffer.concat([buf, d]); pump() })
      sock.on('data', onData)
      return {
        take: (parser) => new Promise((resolve) => { want = { parser, resolve }; pump() }),
        rest: () => { sock.removeListener('data', onData); const b = buf; buf = Buffer.alloc(0); return b },
      }
    }
    const c = side(cSock, initial), u = side(uSock, Buffer.alloc(0))
    const seen = { c: [], s: [] }
    socksHandshake({
      client: c.take,
      proxy: (parser) => { waitFor('proxy-reply', null); return u.take(parser).then((r) => { waitDone(); return r }) },
      toProxy: (b) => { seen.c.push(b); uSock.write(b) },
      toClient: (b) => { seen.s.push(b); cSock.write(b) },
    }, initial[0]).then(guard((r) => {
      if (finished) return
      // what was forwarded, both ways, verbatim; RFC 1929 username/password are a proxy credential → 0600 (RFC 4.1)
      if (seen.c.length) rec.prelude = { kind: r.kind ?? (initial[0] === 4 ? 'socks4' : 'socks5'), target: r.host != null ? `${r.host}:${r.port}` : null, client_b64: Buffer.concat(seen.c).toString('base64'), proxy_b64: Buffer.concat(seen.s).toString('base64') }
      const cRest = c.rest(), uRest = u.rest()
      const host = r.host != null ? hostOf(`${r.host}:${r.port}`) : null
      if (r.ok) { if (uRest.length) cSock.write(uRest); return route(cSock, uSock, cRest, host, true) }
      rec.decision = 'tunnel'; rec.host = host
      notCaptured(r.opaque ? 'unknown-protocol' : 'proxy-refused', r.reason)
      if (cRest.length) uSock.write(cRest)
      if (uRest.length) cSock.write(uRest)
      relay(cSock, uSock)
    }), internalError)
  }

  // ── plain HTTP (scheme http) ───────────────────────────────────────────────────────────────────
  function handleHttp(buf, cSock, uSock, hostDefault, isTunnel) {
    const h = parseHead(buf)
    let host = hostDefault ?? meta.dst.address
    if (h) for (const [k, v] of h.headers) if (k.toLowerCase() === 'host') host = v.split(':')[0]
    rec.host = host
    const skip = skipOf(host)
    if (!skip) {
      setDecision('decrypt', isTunnel)
      activeTee = createExchangeTee({
        flow: { id: rec.flow_id, host, scheme: 'http', dst: meta.dst, proc: { pid: meta.pid, exe: meta.exe ?? null, agent: meta.agent } },
        recordStore: ctx.store, isRecording: ctx.isRecording, wsTerminal: meta.wsTerminal ?? null, onFailure: ctx.failure,
      })
      activeTee.fromClient(buf)
      uSock.write(buf)
      relay(cSock, uSock)
    } else {
      setDecision('splice', isTunnel); notCaptured(...skip)
      if (buf.length) uSock.write(buf)
      relay(cSock, uSock)
    }
  }

  // Kick off once the upstream TCP is usable. connectUpstream returns a connecting socket; we can
  // write/route as soon as a side speaks — route() buffers client bytes until a decision.
  route(client, upstream, Buffer.alloc(0), null, false)

  // First-byte safety valve: if neither side ever speaks, finalize and drop the connection rather
  // than leak it. unref so a pending timer can't hold the event loop open.
  firstByteTimer = setTimeout(() => preTeardown({ type: 'first_byte_timeout', message: 'no bytes before timeout', side: 'engine' }), ctx.firstByteTimeoutMs ?? 5000)
  if (firstByteTimer.unref) firstByteTimer.unref()

  // Catch a client that was already gone before our listeners attached (accept/lookup raced the close).
  if (client.destroyed) queueMicrotask(() => preTeardown(client.errored ? { type: client.errored.code || 'client_error', message: msgOf(client.errored), side: 'client' } : closedBefore('client')))

  return flowDone
}
