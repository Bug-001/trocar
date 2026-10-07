// The REAL engine and proxy ingress (src/collector/core/engine) as the W57 contract test's "engine" (4.8 §3.3, plan Task 3 (b2)): where
// engine-fixture.mjs stood in for them, this is them. Same shape — `{ port, events, closeAll, close }` — so the contract test changes only
// where it starts the engine, and engine-fixture.mjs stays the Windows spike's stand-in.
//
// mihomo reaches the ingress through a recording tap (the tap's port is what the config's `asight-in-<g>` outbound names), so the bytes the
// real mihomo sent are still recorded (test/netenv/fixtures/mihomo-probe.bytes comes from `probe-closed`.raw), and an agent connection is
// told from a probe by what the ingress answered. Events, as the fixture's: `probe-closed` {raw}, `agent-connect` (the ingress said 200 for
// a target that is not the re-entry point), `agent-dial-failed` (502), `auth-failed` (407), `unknown` (an ingress-unknown failure).
// An agent connection is dialled DIRECT (the contract has no VPN behind the engine); `decrypt:false`, so the bytes are spliced as they are.
import net from 'node:net'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'

/**
 * @param {{port?:number, host?:string, token:string, reenterPort:number, group?:string, onEvent?:(e:object)=>void}} o
 * @returns {Promise<{port:number, events:object[], failures:object[], flows:object[], engine:object, closeAll:()=>void, close:()=>Promise<void>}>}
 */
export async function startRealEngine({ port = 0, host = '127.0.0.1', token, reenterPort, group = 'spike', onEvent = () => {} }) {
  const events = [], failures = [], flows = [], sockets = new Set()
  const emit = (e) => { const ev = { t: Date.now(), ...e }; events.push(ev); onEvent(ev) }
  const redirector = createStaticRedirector()
  const who = ({ target }) => (target.address === '127.0.0.1' && target.port === reenterPort ? { health: true, group }
    : { pid: null, agent: null, decrypt: false, capture: 'vpn-block', negKey: `vb.${group}`, pid_source: null, pid_ms: null, upstream: { kind: 'direct' } })
  for (const route of ['vb', 'of']) redirector.setIngress(`${route}.${group}`, who)
  const engine = createEngine({
    redirector, issuer: createLeafIssuer(loadCa(createCa())), ingressToken: token,
    store: { envelope() { return true }, flow: (f) => { flows.push(f); return true } },
    onFailure: (f) => { failures.push(f); if (f.code === 'ingress-unknown') emit({ kind: 'unknown', reason: f.reason }) },
  })
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  const tap = net.createServer((a) => {
    const b = net.connect(ingressPort, '127.0.0.1')
    sockets.add(a); sockets.add(b)
    const raw = []; let probe = null, said = false
    a.on('data', (d) => {
      raw.push(d)
      if (probe === null) { const s = Buffer.concat(raw).toString('latin1'); if (s.includes('\r\n')) probe = s.startsWith(`CONNECT 127.0.0.1:${reenterPort} `) } // known once the request line is whole
      b.write(d)
    })
    b.on('data', (d) => {
      if (!said && probe !== null) { // the ingress's first words: 200 (a tunnel), 407 (not let in), 502 (the upstream was not reachable)
        said = true; const status = d.toString('latin1', 9, 12)
        if (status === '200' && !probe) emit({ kind: 'agent-connect' }); else if (status === '502') emit({ kind: 'agent-dial-failed' }); else if (status === '407') emit({ kind: 'auth-failed' })
      }
      a.write(d)
    })
    for (const [x, y] of [[a, b], [b, a]]) { x.on('end', () => y.end()); x.on('error', () => y.destroy()); x.on('close', () => y.destroy()) }
    a.on('close', () => { if (probe) emit({ kind: 'probe-closed', raw: Buffer.concat(raw).toString('base64') }) })
  })
  await new Promise((resolve, reject) => { tap.once('error', reject); tap.listen(port, host, resolve) })
  const closeAll = () => { for (const s of sockets) s.destroy() }
  return {
    port: tap.address().port, events, failures, flows, engine, closeAll,
    async close() { closeAll(); await new Promise((r) => tap.close(() => r())); await engine.close() },
  }
}
