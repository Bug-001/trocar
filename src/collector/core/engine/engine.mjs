// engine.mjs — the collector's TCP listener (RFC 4.6 §引擎). It accepts connections the platform
// redirector steered to it, asks the redirector who the peer is, and hands each known flow to
// handleFlow; unknown peers are dropped. close() stops accepting and waits for in-flight flows to
// finish rather than killing them (RFC 4.6 §开关: connections established while on keep relaying).
//   retention(proc, host, method, path) → {class, level} (D40, RFC 4.6 §记录「保存级别」): the daemon's callback — which
// traffic class a call is and how much of it to keep (`full` | `log`); sampled when the request starts. The core knows no
// harness and no pattern; absent = every call `full`.
//   describe(meta) → FlowExtras {wsTerminal, proxies} (Plan 3c §2): the daemon's per-process data
// (harness WS terminal patterns, the process's own proxies), merged into the flow's meta. Core knows no
// harness; it only reads that data.
import net from 'node:net'
import { handleFlow } from './flow.mjs'
import { createNegativeCache } from './negcache.mjs'
import { createUpstreamTrust, systemRoots } from '../tls/roots.mjs'

// upstreamCa: extra CAs the engine trusts upstream (test seam); systemCa: stands in for the OS store
// (tests; undefined = read it): PEM text / array, or a systemRoots()-shaped {certs, errors}. The upstream trust set is built once (RFC 4.6 §引擎 5, tls/roots.mjs).
// timing (tests): {firstByteTimeoutMs, upstreamSlowMs, preludeStallMs} — the engine's waits, 5 s each by default.
export function createEngine({ redirector, issuer, store, connectUpstream, upstreamCa, systemCa, policy = () => true, isRecording = () => true, retention = null, describe = () => ({}), onError = () => {}, onFailure = null, timing = {} }) {
  const counters = { active: 0, total: 0, decrypted: 0, spliced: 0, lookupMisses: 0, notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }
  const servers = []
  const active = new Set()
  // (pid, host) pairs the engine no longer tries to decrypt (RFC 4.6 §引擎 5). A hit is spliced and
  // labelled in flows/; the redirector is never told (the kernel can only stop a whole process).
  // Every write into it is a failure event (D-12, 4.6 §记录 负缓存写入): from then on this (pid, host) is spliced, not
  // captured, until the process exits (the daemon calls forgetPid and records the clearing).
  const neg = createNegativeCache()
  const negWritten = (made, key, o) => { if (made) { const e = neg.get(key); failure({ code: 'negative-cache', pid: e.pid ?? null, agent: e.agent, host: e.host, cause: e.cause, reason: `${e.host} is no longer decrypted for pid ${e.pid} (${e.cause}${e.rejections > 1 ? `, ${e.rejections} times in a row` : ''}); its connections there are passed through until it exits` }) } return made }
  const negCache = { ...neg, observe: (key, o) => negWritten(neg.observe(key, o), key, o), mark: (key, o) => negWritten(neg.mark(key, o), key, o) }
  let flowSeq = 0
  const defaultConnect = (dst) => net.connect(dst.port, dst.address)
  // A capture failure is never silent (D38, 4.6 §记录): one shaped record {event:'failure', where:'engine', code,
  // reason, …} the moment it happens, handed to onFailure — the daemon's failure recorder, which writes it to flows/
  // with its own descriptor, folded per where + code (core/events.mjs). The WebSocket recorder's go the same way
  // (where:'ws'). No sink wired is a wiring fault, reported through onError (stderr) instead of being dropped.
  function failure(rec) {
    const r = { event: 'failure', where: 'engine', ...rec }
    try {
      if (typeof onFailure !== 'function') throw Object.assign(new Error(`capture failure with nowhere to be recorded: ${r.where} ${r.code}: ${r.reason}`), { code: r.code })
      onFailure(r)
    } catch (e) { onError(e) }
  }
  const upstreamTrust = createUpstreamTrust({
    system: systemCa === undefined ? systemRoots()
      : Array.isArray(systemCa.certs) ? { sources: ['option:systemCa'], errors: [], ...systemCa }
        : { certs: [].concat(systemCa).map(String).filter((p) => p.includes('BEGIN CERTIFICATE')), sources: ['option:systemCa'], errors: [] },
    extra: upstreamCa,
  })
  // a trust-store source that is there but unreadable, or no OS store at all: the engine still verifies
  // against what it has, but upstreams signed by a CA only the missing part holds will step aside (D38)
  for (const error of upstreamTrust.errors) { onError(new Error(error)); failure({ code: 'trust-store-error', reason: error }) }
  if (upstreamTrust.missingSystem) {
    const error = 'no OS trust store found: upstreams signed by a system-only CA will step aside'
    onError(new Error(error)); failure({ code: 'system-roots-unavailable', reason: error })
  }

  async function onConnection(socket) {
    counters.total++
    // The accepted socket is ours from here. Until handleFlow attaches its own listeners (after the
    // lookup), a client reset would be an uncaughtException that takes the collector down (RFC 4.6
    // fail-open). handleFlow then sees the socket already destroyed and finalizes the flow.
    const duringLookup = () => {}
    socket.on('error', duringLookup)
    const peer = { address: socket.remoteAddress, port: socket.remotePort }
    let meta = null
    try { meta = await redirector.lookup(peer) }
    catch (e) { // the helper could not be asked: not a miss (4.6 §引擎 1, D38) — loader-timeout, or loader-down with its error
      const code = e && e.code === 'loader-timeout' ? 'loader-timeout' : 'loader-down'
      const detail = `${e && e.code && e.code !== code ? `${e.code}: ` : ''}${String((e && e.message) || e)}` // the helper's own errno stays in the text
      const reason = `looking up the original destination of ${peer.address}:${peer.port} failed (${detail}); the steered connection was closed`
      socket.destroy()
      failure({ code, peer, reason })
      onError(Object.assign(new Error(reason), { code }))
      return
    }
    // RFC 4.6 §引擎 1: no envelope, no connection row — but the connection is closed, so it is not silent (D38)
    if (!meta) {
      counters.lookupMisses++
      const reason = `no original destination for ${peer.address}:${peer.port}; the steered connection was closed`
      failure({ code: 'lookup-miss', peer, reason })
      socket.destroy()
      onError(Object.assign(new Error(reason), { code: 'lookup-miss' }))
      return
    }
    // FlowExtras from the daemon. A throw must not cost the agent its connection: the flow goes on with
    // none (fail-open: no WS patterns → fallback cut), and the throw is recorded (D38).
    try { meta = { ...meta, ...(describe(meta) || {}) } } catch (e) {
      onError(e)
      failure({ code: 'describe-error', pid: meta.pid ?? null, agent: meta.agent ?? null, dst: meta.dst, reason: String((e && e.message) || e) })
    }
    counters.active++
    const ctx = {
      ...timing, issuer, store, upstreamCa, upstreamTrust, policy, isRecording, retention, negCache, counters, failure,
      connectUpstream: connectUpstream || defaultConnect,
      newFlowId: () => `flow_${String(++flowSeq).padStart(6, '0')}`,
    }
    let started
    try { started = handleFlow(socket, meta, ctx) } catch (e) { // a synchronous throw (e.g. net.connect on a bad port): this connection only
      onError(e); failure({ code: 'engine-error', pid: meta.pid ?? null, agent: meta.agent ?? null, dst: meta.dst, reason: String((e && e.message) || e) })
      socket.destroy(); counters.active--; return
    }
    const done = started.then((rec) => {
      if (rec && rec.decision === 'decrypt') counters.decrypted++
      else if (rec && rec.decision === 'splice') counters.spliced++
    }).catch((e) => { failure({ code: 'engine-error', pid: meta.pid ?? null, dst: meta.dst, reason: `handling the connection failed: ${String((e && e.message) || e)}` }); onError(e) }).finally(() => { active.delete(done); counters.active-- })
    active.add(done)
    socket.removeListener('error', duringLookup) // handleFlow's own listener has taken over
  }

  function listen({ port = 0, hosts = ['127.0.0.1'] } = {}) {
    // Bind the first host on `port` (0 → OS picks), then reuse the resolved port for the rest, so
    // Plan 2 can listen on 127.0.0.1 and ::1 at the same port.
    return new Promise((resolve, reject) => {
      let boundPort = port
      let i = 0
      const bindNext = () => {
        if (i >= hosts.length) { resolve({ port: boundPort }); return }
        const host = hosts[i++]
        const srv = net.createServer(onConnection)
        srv.once('error', reject)
        srv.listen(boundPort, host, () => {
          srv.removeListener('error', reject)
          // after listen (e.g. EMFILE on accept): recorded and reported, never an uncaught exception
          srv.on('error', (e) => { failure({ code: (e && e.code) || 'engine-error', reason: `the engine's listener on ${host}: ${String((e && e.message) || e)}` }); onError(e) })
          boundPort = srv.address().port; servers.push(srv); bindNext()
        })
      }
      bindNext()
    })
  }

  async function close() {
    await Promise.all(servers.map((s) => new Promise((res) => s.close(res))))
    await Promise.allSettled([...active]) // let in-flight flows finish; never destroy them
  }

  function stats() {
    const storeErrors = store && typeof store.errors === 'number' ? store.errors : 0
    return { active: counters.active, total: counters.total, decrypted: counters.decrypted, spliced: counters.spliced, lookupMisses: counters.lookupMisses, storeErrors, notCaptured: { ...counters.notCaptured } }
  }

  // negatives() is for status only; forgetPid(pid) is called by the daemon when that process exits.
  return { listen, close, stats, negatives: () => neg.list(), forgetPid: (pid) => neg.forgetPid(pid) }
}
