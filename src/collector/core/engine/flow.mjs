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
import { createDrain } from './drain.mjs'

const msgOf = (e) => String((e && e.message) || e)
// host of a CONNECT authority or a SOCKS target: "[::1]:443" → "::1", "a.test:443" → "a.test". An IPv6 literal is
// written compressed whatever form the client sent ("[0:0:0:0:0:0:0:1]:443" → "::1"), as SOCKS5 targets are (RFC 4.6
// §记录 代理前导): one spelling per host on the row and in the negative-cache key.
const hostOf = (authority) => {
  if (!authority.startsWith('[')) return authority.split(':')[0]
  const raw = authority.slice(1, Math.max(1, authority.indexOf(']')))
  try { return new URL(`http://[${raw}]`).hostname.slice(1, -1) } catch { return raw }
}
// the prelude's target: the authority as sent, its IPv6 literal compressed ("[0:0::1]:443" → "[::1]:443")
const targetOf = (authority) => (authority.startsWith('[') && authority.includes(']') ? `[${hostOf(authority)}]${authority.slice(authority.indexOf(']') + 1)}` : authority)
// the codes the daemon's policy() may hand the engine for a row (RFC 4.6 §记录 连接行怎么落码)
const DAEMON_CODES = ['not-trust-path', 'untracked', 'untrusted']
const IDLE = { boundary: () => ({ idle: true, headPending: false, seq: null, blind: false }) } // the drain gate's view of a connection that has carried nothing yet
const closedBefore = (side) => ({ type: 'closed_before_decision', message: `the ${side} closed before a routing decision`, side })

export function handleFlow(client, meta, ctx) {
  const t0 = Date.now()
  const rec = {
    ts: new Date().toISOString(), flow_id: ctx.newFlowId(), pid: meta.pid, agent: meta.agent,
    // who started this agent (4.6 子进程与嵌套 agent): the board marks a nested agent by parent_agent; parent_pid is whatever
    // started it, an agent or not (review B-4(a))
    ...(meta.parentPid != null ? { parent_pid: meta.parentPid } : {}), ...(meta.parentAgent ? { parent_agent: meta.parentAgent } : {}),
    dst: meta.dst, host: null, decision: null, reason: null, bytes_up: 0, bytes_down: 0, duration_ms: 0,
  }
  let resolveFlow
  const flowDone = new Promise((res) => { resolveFlow = res })

  let activeTee = null
  let finished = false
  let handedOff = false     // true once a routing decision hands the sockets to relay()
  let relaying = false      // relay() owns teardown (armPre's handlers on a decrypted pair go quiet)
  let tunnelAsked = false   // the client sent CONNECT inside a TLS connection we terminated (an https:// proxy)
  const connectPrelude = { c: [], s: [] } // every CONNECT round trip on this connection, for the prelude record
  let selfClosed = false    // the engine tore this flow down itself (internalError, or the drain gate closing it: RFC 1.6 §1.3)
  // off (RFC 1.6 §1.3): the engine closes a connection that is still relayed where it can see a boundary (engine/drain.mjs).
  // `socks` = every socket of this flow, for the cut (`off --now`); `gate` = the drain gate once relay() owns the
  // connection (before the client's first request on a terminated TLS connection: a gate that closes it at once);
  // `drainAsked` = off came before either, the gate starts when relay() begins
  const socks = new Set()
  const track = (s) => { if (s) socks.add(s); return s }
  const destroyAll = () => { for (const s of socks) { try { s.destroy() } catch { /* already gone */ } } }
  let gate = null
  let drainAsked = false
  // the gate says it is about to close (or cut) the connection: the engine did it, not the client (the leaf-rejection judge ignores it), and a
  // cut says so on the row — before the sockets are destroyed, because a TLS socket emits its close events inside destroy()
  const onGateClosed = (kind) => { selfClosed = true; if (kind === 'cut' && !rec.error) rec.error = { type: 'cut-by-off', message: 'the connection was cut by asight off --now', side: 'engine' } }
  let upstream = null       // the TCP connection to the original destination
  let firstByteTimer = null
  let slowTimer = null      // the upstream-slow watch while the engine waits on the upstream (RFC 4.6 §记录)
  // Waiting on the upstream (our TLS handshake to it, a proxy's reply) has no time limit: cutting the
  // agent because its upstream or proxy is slow would break it (D31). Past `upstreamSlowMs` (5 s) the
  // wait is recorded once as an upstream-slow event (D38), and the connection goes on.
  function waitFor(phase, host) {
    waitDone()
    const ms = ctx.upstreamSlowMs ?? 5000, t0w = Date.now()
    slowTimer = setTimeout(() => { slowTimer = null; ctx.failure({ code: 'upstream-slow', flow_id: rec.flow_id, host, phase, waited_ms: Math.max(ms, Date.now() - t0w), reason: `${host} has not answered the ${phase === 'proxy-reply' ? 'proxy request' : 'TLS handshake'} for ${Math.max(ms, Date.now() - t0w)} ms; still waiting` }) }, ms) // a timer can fire a ms early
    if (slowTimer.unref) slowTimer.unref()
  }
  function waitDone() { if (slowTimer) { clearTimeout(slowTimer); slowTimer = null } }
  // the row's not_captured code (closed set, codes.mjs) and why (RFC 4.6 §记录 连接行怎么落码)
  function notCaptured(code, reason) { rec.not_captured = code; if (reason != null) rec.reason = reason }
  // policy(meta, host): true = decrypt; false = outside the decrypt policy; or the daemon's own code
  // {not_captured, reason} when it can say more (DAEMON_CODES). A process the kernel steers without decrypt is
  // untrusted (with the resolver's reason when the daemon gives one) or untracked. → null (decrypt) or [code, reason]
  function skipOf(host) {
    let v = null
    if (meta.decrypt) v = ctx.policy(meta, host) // a throw is this flow's engine-error (guard)
    else try { v = ctx.policy(meta, host) } catch (e) { ctx.failure({ code: 'engine-error', flow_id: rec.flow_id, reason: `policy threw: ${msgOf(e)}` }) }
    const own = v && typeof v === 'object' && DAEMON_CODES.includes(v.not_captured) ? [v.not_captured, v.reason ?? null] : null
    if (!meta.decrypt) return own && own[0] !== 'not-trust-path' ? own : ['untrusted', null]
    if (own) return own
    return v && typeof v !== 'object' ? null : ['policy', null]
  }
  function finish(decision, extra = {}) {
    if (finished) return
    finished = true
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    waitDone()
    if (decision && !rec.decision) rec.decision = decision
    Object.assign(rec, extra)
    // D38: every row the bytes missed has a code — an error row, and a tunnel whose inner bytes were never decided
    // (a side went while a CONNECT retried after a refusal waited for the proxy's answer)
    if ((rec.decision === 'error' || (rec.decision === 'tunnel' && !rec.inner)) && !rec.not_captured) rec.not_captured = 'error'
    rec.duration_ms = Date.now() - t0
    // a WebSocket connection: the recorder's summary (frames, calls, tail_raw, failures, …; RFC 4.6 §记录)
    const ws = activeTee && activeTee.wsSummary && activeTee.wsSummary()
    if (ws) { rec.transport = 'ws'; rec.ws = ws }
    // envelopes the store did not write, and a decrypted connection whose later bytes were not framed (D38)
    const notes = activeTee && activeTee.rowNotes ? activeTee.rowNotes() : {}
    if (notes.writeFailed) rec.write_failed = notes.writeFailed
    if (notes.framerError) rec.framer_error = notes.framerError
    if (notes.asightAdded) rec.asight_added = notes.asightAdded // what the drain gate put into the bytes the client got (1.6 §1.3), recorded or not
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
  track(client); track(upstream)
  // What the engine's drain() asks of this flow (RFC 1.6 §1.3). start() → 'closing' | 'waiting' | 'closed' | 'cut';
  // state() → 'open' (not asked) | 'closing' | 'waiting' | 'closed' | 'cut' | 'done'.
  if (ctx.register) ctx.register({
    start({ now = false } = {}) {
      if (finished) return 'closed'
      if (gate) {
        return gate.start({ now })
      }
      if (now) { // not yet relayed (the TLS handshake, a proxy prelude): cut as well
        onGateClosed('cut')
        if (!handedOff) preTeardown(rec.error); else destroyAll()
        return 'cut'
      }
      drainAsked = true // relay() starts the gate when it owns the connection
      return 'closing'
    },
    state: () => (finished ? 'done' : gate ? gate.state() : drainAsked ? 'closing' : 'open'),
  })
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
    handedOff = true; relaying = true // relay now owns teardown; the pre-decision handlers (and armPre's) go quiet
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    let tee = activeTee
    // the recording side copy never throws into the forwarding path: a recorder that throws stops
    // recording this connection (recorded, D38) and the bytes keep flowing
    const copy = (fn) => { if (!tee) return; try { fn(tee) } catch (e) { tee = null; activeTee = null; drain.loseTee(); ctx.failure({ code: 'engine-error', flow_id: rec.flow_id, reason: `recording stopped: ${msgOf(e)}` }) } }
    // The drain gate (RFC 1.6 §1.3, engine/drain.mjs) sits between the upstream and the client. It runs before the tee sees
    // a chunk (an envelope that ends in this very chunk then already says what the gate added) and after the chunk is
    // written (a response that ended closes the connection); the tee still reads the upstream's own bytes.
    const drain = gate = createDrain({ flowId: rec.flow_id, tee, client: cSock, upstream: uSock, timeoutMs: ctx.drainTimeoutMs ?? 5000, destroy: destroyAll, onClosed: onGateClosed, onFailure: ctx.failure })
    track(cSock); track(uSock)
    if (drainAsked) { drainAsked = false; drain.start({ now: false }) }
    cSock.on('data', (d) => { copy((t) => t.fromClient(d)); if (uSock.writable && !uSock.write(d)) cSock.pause() })
    uSock.on('drain', () => cSock.resume())
    uSock.on('data', (d) => {
      const parts = drain.beforeUpstream(d)
      copy((t) => t.fromUpstream(d))
      for (const p of parts) if (cSock.writable && !cSock.write(p)) uSock.pause()
      drain.afterUpstream()
    })
    cSock.on('drain', () => uSock.resume())
    // the first socket error of the flow, with its side, goes to flows/ (D38)
    const noteError = (e, side) => { if (e instanceof Error && !rec.error) rec.error = { type: e.code || 'error', message: msgOf(e), side } }
    // 'error' passes the Error, 'end' nothing, 'close' a boolean: a reset reaches the ws recorder as an error
    const clientGone = (e) => { noteError(e, 'client'); copy((t) => t.clientEnded(e instanceof Error ? e : null)); teardown(); try { if (!uSock.destroyed) uSock.destroy() } catch { /* ignore */ }; try { if (!upstream.destroyed) upstream.destroy() } catch { /* ignore */ } }
    const upstreamGone = (e) => { noteError(e, 'upstream'); copy((t) => t.upstreamEnded(e instanceof Error ? e : null)); teardown(); try { for (const p of drain.flush()) if (cSock.writable) cSock.write(p); if (cSock.writable) cSock.end() } catch { /* ignore */ } } // let the client drain, then it closes; bytes the gate still held are the client's
    cSock.on('end', clientGone); cSock.on('error', clientGone); cSock.on('close', clientGone)
    uSock.on('end', upstreamGone); uSock.on('error', upstreamGone); uSock.on('close', upstreamGone)
  }

  // ── first-speaker race + client sniff ─────────────────────────────────────────────────────────
  // upPre: upstream bytes that arrived in the same chunk as a proxy's success reply (RFC 4.6 §记录 代理前导)
  function route(cSock, uSock, preBuf, hostDefault, isTunnel, upPre = null) {
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
    // the client has not spoken yet: those upstream bytes mean the upstream spoke first; otherwise they go
    // on to the client as they would have
    if (upPre && upPre.length) { if (!chunks.length) return onUpFirst(upPre); cSock.write(upPre) }
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
    let skip = !meta.decrypt ? skipOf(sni ?? meta.dst.address) : ch.malformed ? ['malformed-hello', null] : skipOf(sni ?? meta.dst.address)
    // An https:// proxy from the daemon's table for this process (RFC 4.6 §引擎 3 / §记录 https:// 代理): an own
    // one is terminated even outside the decrypt policy (it is part of `auto`); a listed one that is not the
    // process's own is spliced and labelled, unless the policy covers its host (`all`).
    const proxy = isTunnel ? null : (meta.proxies || []).find((p) => p && p.scheme === 'https' && Number(p.port) === meta.dst.port && String(p.host).toLowerCase() === String(sni ?? meta.dst.address).toLowerCase())
    if (proxy) {
      rec.via_proxy = { scheme: 'https', host: proxy.host, port: Number(proxy.port), source: proxy.source ?? null, terminated: false }
      if (skip && skip[0] === 'policy') skip = proxy.own ? null : ['https-proxy', 'proxy-not-own']
    }
    if (!skip && h1 && !neg) return decrypt(buf, cSock, uSock, sni, host, isTunnel, key)
    if (skip && skip[0] === 'https-proxy') ctx.counters.notCaptured.httpsProxy++
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

  // Terminate TLS on both legs: first to the upstream (SNI as the client sent it, ALPN http/1.1, the
  // upstream trust set), then — only once that verified — to the client with a per-SNI leaf; then hand the
  // two plaintext sockets to onSecure(clientTls, upTls). We never stand in for an upstream (§引擎 5); the
  // step-aside and the D37 rejection rule live here, so every path that terminates TLS gets both.
  function terminate(buf, cSock, uSock, sni, host, isTunnel, key, onSecure) {
    // the OS store ∪ Node's roots ∪ NODE_EXTRA_CA_CERTS (+ upstreamCa), one context (tls/roots.mjs)
    if (!ctx.upstreamTrust) ctx.upstreamTrust = createUpstreamTrust({ extra: ctx.upstreamCa })
    // rejectUnauthorized:false only so the two upstream failures can be told apart: an 'error' before
    // 'secureConnect' is a network / protocol failure (the client is closed); a 'secureConnect' that is
    // not `authorized` (Node still checks chain and hostname) is a certificate that did not verify
    // (stepAside). Nothing is ever written on an unverified connection (§引擎 5).
    const upTls = tls.connect({ socket: uSock, servername: sni || undefined, ALPNProtocols: ['http/1.1'], secureContext: ctx.upstreamTrust.secureContext, rejectUnauthorized: false })
    let clientTls = null
    waitFor('tls', host)
    // While we wait for the upstream, the client socket keeps flowing into `held`: a paused socket never
    // reports the client's FIN, and a client that gave up on a silent upstream would leave this flow (and
    // engine.close()) hanging forever. Its 'end' / 'close' reach preTeardown like any pre-decision close.
    const held = []
    const hold = (d) => { held.push(d) }
    cSock.on('data', hold); cSock.resume()
    const takeHeld = () => { cSock.removeListener('data', hold); cSock.pause(); return held.length ? Buffer.concat([buf, ...held]) : buf }
    upTls.on('error', (err) => {
      waitDone()
      if (!clientTls) { try { cSock.destroy() } catch { /* ignore */ }; finish(isTunnel ? 'tunnel' : 'decrypt', { host, not_captured: 'error', error: { type: err.code || 'upstream_tls_error', message: msgOf(err), side: 'upstream' } }) }
    })
    upTls.on('secureConnect', guard(() => {
      waitDone()
      const all = takeHeld()                                // the ClientHello and anything the client sent after it
      if (!upTls.authorized) return stepAside(upTls, all, cSock, host, isTunnel, key, 'upstream-cert', String(upTls.authorizationError || 'upstream certificate not verified'))
      let leaf
      try { leaf = ctx.issuer.secureContextFor(host) } catch (e) { return stepAside(upTls, all, cSock, host, isTunnel, key, 'leaf-error', msgOf(e)) }
      cSock.unshift(all)                                    // replay the ClientHello to our TLS server
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
      const judge = (e) => {
        if (judged) return
        judged = true
        if (appData) return ctx.negCache.observe(key, { rejected: false, meta, host })
        if (notClient || selfClosed) return
        notCaptured('client-rejected-leaf', 'client-rejected-leaf')
        // how the client went, as far as the engine can see (RFC 4.6 §记录): its TLS alert, a reset, or a close
        // with no error (a Node client checks our leaf after the handshake and sends no alert). Its own
        // certificate-check code never reaches us.
        if (!rec.error) rec.error = e instanceof Error ? { type: e.code || 'error', message: msgOf(e), side: 'client' }
          : { type: 'closed_without_app_data', message: 'the client closed after the TLS handshake without sending application data', side: 'client' }
        ctx.negCache.observe(key, { rejected: true, meta, host })
      }
      clientTls.on('error', judge); clientTls.on('end', judge); clientTls.on('close', judge)
      onSecure(clientTls, upTls)
    }))
  }

  // the decrypted call(s) on this connection go to the exchange tee
  const startTee = (host, scheme) => {
    activeTee = createExchangeTee({
      flow: { id: rec.flow_id, host, scheme, dst: meta.dst, proc: { pid: meta.pid, exe: meta.exe ?? null, agent: meta.agent } },
      recordStore: ctx.store, isRecording: () => ctx.isRecording(meta), wsTerminal: meta.wsTerminal ?? null, onFailure: ctx.failure,
      onTurnEnd: () => { if (gate) gate.onTurnEnd() }, // a WebSocket call closed on its terminal message: the gate closes after this chunk
    })
    return activeTee
  }

  function decrypt(buf, cSock, uSock, sni, host, isTunnel, key) {
    terminate(buf, cSock, uSock, sni, host, isTunnel, key, (clientTls, upTls) => {
      setDecision('decrypt', isTunnel)
      if (rec.via_proxy) rec.via_proxy.terminated = true
      routeInner(clientTls, upTls, host, isTunnel)
    })
  }

  // What the client says first on a terminated TLS connection decides what it is (RFC 4.6 §记录 https:// 代理):
  // a CONNECT makes this TLS server a proxy (an own https:// proxy, or any proxy under `all`) — relayed as in
  // §引擎 3, the tunnelled TLS routed again; anything else is the decrypted call itself, for the exchange tee.
  function routeInner(cTls, uTls, host, isTunnel) {
    handedOff = true                                    // the raw sockets' pre-decision handlers go quiet
    armPre(cTls, uTls)
    const chunks = []
    let decided = false
    const stop = () => { decided = true; gate = null; cTls.removeListener('data', onC); uTls.removeListener('data', onU) }
    const onC = guard((d) => {
      if (decided) return
      chunks.push(d)
      const buf = Buffer.concat(chunks), cls = classify(buf)
      if (cls === 'need-more') return
      stop()
      if (cls === 'connect' && !isTunnel) {
        rec.via_proxy = rec.via_proxy || { scheme: 'https', host, port: meta.dst.port, source: null, terminated: true }
        tunnelAsked = true; rec.decision = 'tunnel'
        return handleConnect(buf, cTls, uTls)
      }
      startTee(host, 'https').fromClient(buf); uTls.write(buf); relay(cTls, uTls)
    })
    const onU = guard((d) => {
      if (decided) return
      stop()
      const pre = Buffer.concat(chunks)
      startTee(host, 'https')
      if (pre.length) { activeTee.fromClient(pre); uTls.write(pre) }
      activeTee.fromUpstream(d); cTls.write(d); relay(cTls, uTls)
    })
    cTls.on('data', onC); uTls.on('data', onU)
    // TLS is terminated on both legs and the client has said nothing yet: nothing is in flight, off closes it at once
    track(cTls); track(uTls)
    gate = createDrain({ flowId: rec.flow_id, tee: IDLE, client: cTls, upstream: uTls, timeoutMs: ctx.drainTimeoutMs ?? 5000, destroy: destroyAll, onClosed: onGateClosed, onFailure: ctx.failure })
  }

  // Between terminating TLS and relay() owning the connection nothing else listens for a side going (the raw
  // sockets' handlers went quiet), so a side that goes must still finish the flow here. Before the client asked
  // for a tunnel, quietly, as relay() would (an idle connection, a client rejecting our leaf); after a CONNECT
  // inside the TLS and before the tunnel's decision, as a close before a decision (not_captured 'error').
  function armPre(cS, uS) {
    const go = (side) => (e) => {
      if (relaying || finished) return
      relaying = true
      if (e instanceof Error && !rec.error) rec.error = { type: e.code || 'error', message: msgOf(e), side }
      if (tunnelAsked && !rec.inner) { notCaptured('error'); if (!rec.error) rec.error = closedBefore(side) }
      teardown()
      for (const s of [cS, uS, client, upstream]) { try { s.destroy() } catch { /* ignore */ } }
    }
    for (const ev of ['end', 'close', 'error']) { cS.on(ev, go('client')); uS.on(ev, go('upstream')) }
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
      // the prelude both ways, verbatim (Proxy-Authorization is a credential: flows/ is 0600, RFC 4.1); every
      // round trip on this connection (a CONNECT retried after a 407), each direction in order
      connectPrelude.c.push(buf.subarray(0, h.headLength)); connectPrelude.s.push(all.subarray(0, ph.headLength))
      rec.prelude = { kind: 'connect', target: targetOf(authority), client_b64: Buffer.concat(connectPrelude.c).toString('base64'), proxy_b64: Buffer.concat(connectPrelude.s).toString('base64') }
      if (status >= 200 && status < 300) {
        route(cSock, uSock, innerPre, connectHost, true, after) // decrypt/splice the tunnelled TLS
      } else {
        rec.decision = 'tunnel'; notCaptured('proxy-refused', `proxy-status-${status}`); rec.host = connectHost
        if (after.length) cSock.write(after)
        afterRefusal(cSock, uSock, innerPre)
      }
    })
    uSock.on('data', onUp)
  }

  // After a refused CONNECT the client may try again on the same connection (407, then CONNECT with
  // Proxy-Authorization to a keep-alive proxy): the refusal's body keeps flowing to the client while the
  // client's next bytes are read — another CONNECT head is followed like the first (RFC 4.6 §记录 代理前导);
  // anything else is spliced on, the row staying proxy-refused. A side going here ends the flow as relay()
  // would: the client's close drops the proxy, the proxy's close lets the client drain the refusal.
  function afterRefusal(cSock, uSock, pre) {
    handedOff = true; relaying = true                    // these handlers own teardown until the next decision
    const cChunks = pre.length ? [pre] : []
    let done = false
    const onUp = guard((d) => { if (cSock.writable) cSock.write(d) })
    const onC = guard((d) => { cChunks.push(d); check() })
    const gone = (side) => guard((e) => {
      if (done || finished) return
      stop()
      if (e instanceof Error && !rec.error) rec.error = { type: e.code || 'error', message: msgOf(e), side }
      teardown()
      if (side === 'client') { try { uSock.destroy() } catch { /* ignore */ }; try { upstream.destroy() } catch { /* ignore */ } } else { try { if (cSock.writable) cSock.end() } catch { /* ignore */ } }
    })
    const handlers = [[cSock, 'data', onC], [uSock, 'data', onUp]]
    for (const ev of ['end', 'close', 'error']) handlers.push([cSock, ev, gone('client')], [uSock, ev, gone('upstream')])
    const stop = () => { done = true; for (const [s, ev, fn] of handlers) s.removeListener(ev, fn) }
    for (const [s, ev, fn] of handlers) s.on(ev, fn)
    function check() {
      if (done || !cChunks.length) return
      const buf = Buffer.concat(cChunks), cls = classify(buf)
      if (cls === 'need-more') return
      if (cls === 'connect') {
        const h = parseHead(buf); if (!h) return
        stop(); delete rec.not_captured; rec.reason = null
        relaying = false; if (cSock === client) handedOff = false // a pre-decision state again (preTeardown / armPre watch it)
        return afterConnectHead(h, buf, cSock, uSock)
      }
      stop(); uSock.write(buf); relay(cSock, uSock)
    }
    check()
  }

  // ── SOCKS4 / 4a / 5: relay the prelude verbatim, then route the tunnelled bytes (§引擎 3, D37) ──
  // Each side's bytes are held until a whole prelude message has arrived, then forwarded unchanged and in
  // order; the proxy's answer — success or refusal — is the only answer the client gets (RFC 4.6 §记录 代理前导).
  function handleSocks(initial, cSock, uSock) {
    // The engine never holds bytes for either side (RFC 4.6 §记录 代理前导): while it waits for one side's next
    // message and bytes it has not forwarded are held — a partial message on that side (a protocol whose first
    // byte merely looks like SOCKS, waiting for its peer), or anything on the other side (a whole message that
    // only looked like SOCKS, its peer waiting for the rest; an eager client meeting a silent proxy) — the side
    // waited on gets preludeStallMs to send a new byte. Then the wait resolves as not followed and the caller
    // passes everything held through, both ways. Bytes from the other side do not restart the clock. With
    // nothing held the wait has no limit (a slow proxy: upstream-slow only).
    const stallMs = ctx.preludeStallMs ?? 5000
    const sides = []
    let stall = null
    const unstall = () => { if (stall) { clearTimeout(stall); stall = null } }
    const valve = (restart) => {
      const w = sides.find((s) => s.waiting())
      if (!w || !sides.some((s) => s.held())) return unstall()
      if (stall && !restart) return
      unstall()
      stall = setTimeout(() => { stall = null; w.giveUp() }, stallMs)
      if (stall.unref) stall.unref()
    }
    const side = (sock, pre, name) => {
      let buf = pre, want = null
      const pump = (restart) => {
        if (!want) return valve(false)
        const r = want.parser(buf)
        if (!r) return valve(restart)
        const w = want; want = null; unstall()
        if (r.invalid) return w.resolve(r)
        const raw = buf.subarray(0, r.length); buf = buf.subarray(r.length)
        w.resolve({ ...r, raw })
      }
      const onData = guard((d) => { buf = Buffer.concat([buf, d]); pump(true) })
      sock.on('data', onData)
      const s = {
        waiting: () => want !== null,
        held: () => buf.length,
        giveUp() {
          const w = want; want = null
          if (!w) return
          const other = sides.find((o) => o !== s)
          w.resolve({ invalid: buf.length ? `incomplete message, no new byte for ${stallMs} ms`
            : `incomplete exchange, the ${name} sent nothing for ${stallMs} ms while ${other.held()} bytes were held` })
        },
        take: (parser) => new Promise((resolve) => { want = { parser, resolve }; pump(true) }),
        rest: () => { sock.removeListener('data', onData); const b = buf; buf = Buffer.alloc(0); return b },
      }
      sides.push(s)
      return s
    }
    const c = side(cSock, initial, 'client'), u = side(uSock, Buffer.alloc(0), 'proxy')
    const seen = { c: [], s: [] }
    let target = meta.dst.address // the host the proxy is asked for, once the request has been read
    socksHandshake({
      client: (parser) => c.take(parser).then((r) => { if (r && r.host) target = r.host; return r }),
      proxy: (parser) => { waitFor('proxy-reply', target); return u.take(parser).then((r) => { waitDone(); return r }) },
      toProxy: (b) => { seen.c.push(b); uSock.write(b) },
      toClient: (b) => { seen.s.push(b); cSock.write(b) },
    }, initial[0]).then(guard((r) => {
      if (finished) return
      // what was forwarded, both ways, verbatim; RFC 1929 username/password are a proxy credential → 0600 (RFC 4.1)
      if (seen.c.length) rec.prelude = { kind: r.kind ?? (initial[0] === 4 ? 'socks4' : 'socks5'), target: r.host != null ? `${r.host.includes(':') ? `[${r.host}]` : r.host}:${r.port}` : null, client_b64: Buffer.concat(seen.c).toString('base64'), proxy_b64: Buffer.concat(seen.s).toString('base64') }
      const cRest = c.rest(), uRest = u.rest()
      const host = r.host ?? null
      if (r.ok) return route(cSock, uSock, cRest, host, true, uRest)
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
      startTee(host, 'http').fromClient(buf)
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
