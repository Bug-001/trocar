// engine.mjs — the collector's TCP listener (RFC 4.6 §引擎). It accepts connections the platform
// redirector steered to it, asks the redirector who the peer is, and hands each known flow to
// handleFlow; unknown peers are dropped. close() stops accepting and waits for in-flight flows to
// finish rather than killing them (RFC 4.6 §开关: connections established while on keep relaying).
//   describe(meta) → FlowExtras {wsTerminal, proxies} (Plan 3c §2): the daemon's per-process data
// (harness WS terminal patterns, the process's own proxies), merged into the flow's meta. Core knows no
// harness; it only reads that data.
import net from 'node:net'
import { handleFlow } from './flow.mjs'
import { createNegativeCache } from './negcache.mjs'
import { createUpstreamTrust, systemRoots } from '../tls/roots.mjs'

// upstreamCa: extra CAs the engine trusts upstream (test seam); systemCa: stands in for the OS store
// (tests; undefined = read it). The upstream trust set is built once (RFC 4.6 §引擎 5, tls/roots.mjs).
export function createEngine({ redirector, issuer, store, connectUpstream, upstreamCa, systemCa, policy = () => true, isRecording = () => true, describe = () => ({}), onError = () => {} }) {
  const counters = { active: 0, total: 0, decrypted: 0, spliced: 0, lookupMisses: 0, notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }
  const servers = []
  const active = new Set()
  // (pid, host) pairs the engine no longer tries to decrypt (RFC 4.6 §引擎 5). A hit is spliced and
  // labelled in flows/; the redirector is never told (the kernel can only stop a whole process).
  const negCache = createNegativeCache()
  let flowSeq = 0
  const defaultConnect = (dst) => net.connect(dst.port, dst.address)
  // A capture failure is never silent (D38): written to failures/ when it happens. A
  // store without failure() is a wiring fault, reported like a failed write (via onError).
  function failure(rec) {
    try {
      if (typeof store.failure !== 'function') throw new Error(`capture failure not recorded (the store has no failure()): ${rec.reason}`)
      store.failure({ ts: new Date().toISOString(), ...rec })
    } catch (e) { onError(e) }
  }
  const upstreamTrust = createUpstreamTrust({
    system: systemCa === undefined ? systemRoots() : { certs: [].concat(systemCa).map(String).filter((p) => p.includes('BEGIN CERTIFICATE')), sources: ['option:systemCa'], errors: [] },
    extra: upstreamCa,
  })
  if (upstreamTrust.missingSystem) { // the engine still verifies against Node's roots; corporate CAs are missing
    const error = `no OS trust store found${upstreamTrust.errors.length ? ` (${upstreamTrust.errors.join('; ')})` : ''}: upstreams signed by a system-only CA will step aside`
    onError(new Error(error)); failure({ reason: 'system-roots-unavailable', error })
  }

  async function onConnection(socket) {
    counters.total++
    // The accepted socket is ours from here. Until handleFlow attaches its own listeners (after the
    // lookup), a client reset would be an uncaughtException that takes the collector down (RFC 4.6
    // fail-open). handleFlow then sees the socket already destroyed and finalizes the flow.
    const duringLookup = () => {}
    socket.on('error', duringLookup)
    let meta = null
    try { meta = await redirector.lookup({ address: socket.remoteAddress, port: socket.remotePort }) }
    catch (e) { onError(e) }
    if (!meta) { counters.lookupMisses++; socket.destroy(); return }
    // FlowExtras from the daemon. A throw must not cost the agent its connection: the flow goes on with
    // none (fail-open: no WS patterns → fallback cut), and the throw is recorded (D38).
    try { meta = { ...meta, ...(describe(meta) || {}) } } catch (e) {
      onError(e)
      failure({ reason: 'describe-error', pid: meta.pid ?? null, agent: meta.agent ?? null, dst: meta.dst, error: String((e && e.message) || e) })
    }
    counters.active++
    const ctx = {
      issuer, store, upstreamCa, upstreamTrust, policy, isRecording, negCache, counters, failure,
      connectUpstream: connectUpstream || defaultConnect,
      newFlowId: () => `flow_${String(++flowSeq).padStart(6, '0')}`,
    }
    const done = handleFlow(socket, meta, ctx).then((rec) => {
      if (rec && rec.decision === 'decrypt') counters.decrypted++
      else if (rec && rec.decision === 'splice') counters.spliced++
    }).catch((e) => onError(e)).finally(() => { active.delete(done); counters.active-- })
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
        srv.listen(boundPort, host, () => { boundPort = srv.address().port; servers.push(srv); bindNext() })
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
  return { listen, close, stats, negatives: () => negCache.list(), forgetPid: (pid) => negCache.forgetPid(pid) }
}
