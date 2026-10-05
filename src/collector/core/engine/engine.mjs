// engine.mjs — the collector's TCP listener (RFC 4.6 §引擎). It accepts connections the platform
// redirector steered to it, asks the redirector who the peer is, and hands each known flow to
// handleFlow; unknown peers are dropped. close() stops accepting and waits for in-flight flows to
// finish rather than killing them (RFC 4.6 §开关: connections established while on keep relaying).
import net from 'node:net'
import { handleFlow } from './flow.mjs'

export function createEngine({ redirector, issuer, store, connectUpstream, upstreamCa, policy = () => true, isRecording = () => true, onError = () => {} }) {
  const counters = { active: 0, total: 0, decrypted: 0, spliced: 0, lookupMisses: 0 }
  const servers = []
  const active = new Set()
  const negCache = new Map()
  let flowSeq = 0
  const defaultConnect = (dst) => net.connect(dst.port, dst.address)

  async function onConnection(socket) {
    counters.total++
    let meta = null
    try { meta = await redirector.lookup({ address: socket.remoteAddress, port: socket.remotePort }) }
    catch (e) { onError(e) }
    if (!meta) { counters.lookupMisses++; socket.destroy(); return }
    counters.active++
    const ctx = {
      issuer, store, upstreamCa, policy, isRecording, negCache,
      connectUpstream: connectUpstream || defaultConnect,
      newFlowId: () => `flow_${String(++flowSeq).padStart(6, '0')}`,
    }
    const done = handleFlow(socket, meta, ctx).then((rec) => {
      if (rec && rec.decision === 'decrypt') counters.decrypted++
      else if (rec && rec.decision === 'splice') counters.spliced++
    }).catch((e) => onError(e)).finally(() => { active.delete(done); counters.active-- })
    active.add(done)
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
    return { active: counters.active, total: counters.total, decrypted: counters.decrypted, spliced: counters.spliced, lookupMisses: counters.lookupMisses, storeErrors }
  }

  return { listen, close, stats }
}
