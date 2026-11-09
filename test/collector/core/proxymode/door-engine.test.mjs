// test/collector/core/proxymode/door-engine.test.mjs — the collector model's doors on a REAL engine (4.8 §3, §5.3; 4.6 §记录): createModelCollector
// bound to createEngine the way the daemon binds them (its doors are the engine's group listeners, its drain is the engine's), real loopback sockets,
// a plain TCP echo as the upstream. Only the OS readers are injected: who owns a client port (ownerOf) and what that process is (factsOf).
// (1) At a harness's door, a connection from a process that is not an agent, or whose owner cannot be read, is passed through untouched and leaves
// exactly one connection row and no envelope. (2) With two harnesses on, `off` of one closes its door only: the other's door, its upstream answer
// and its connection in flight are untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { createModelCollector } from '../../../../src/collector/core/proxymode/collector.mjs'
import { createEngine } from '../../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../../src/collector/core/tls/leaf.mjs'
import { certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { TEMPLATES } from '../../../../src/collector/harness/templates/index.mjs'
import { newManifest } from '../../../../src/off/manifest.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { within, closeWithin } from '../../../helpers/bounded.mjs'
import { freePort } from '../../../helpers/model-io.mjs'
import { descs, INSTALLED, newWorld, ctxOf } from './verdict-world.mjs'

const T = { timeout: 20_000 }
const TOKEN = 'ab'.repeat(16)
const stub = custodyStub(); stub.create()
const iso = (ms) => new Date(ms).toISOString()
const proxyOf = (u) => { const x = new URL(u); return { kind: x.protocol.startsWith('socks') ? 'socks5' : 'http', host: x.hostname, port: Number(x.port) } }
const formOf = (d) => d.proxyMode.forms.find((f) => f.os.includes('darwin') && (d.proxyMode.routes[f.route] || {}).auth !== false)
const pair = descs.filter((d) => formOf(d)).slice(0, 2)
const groupOf = (d) => `${d.name}:${formOf(d).route}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const canConnect = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

async function world(t) {
  const owners = new Map() // client port → pid (the socket table)
  const facts = new Map() // pid → facts
  const flows = [], envelopes = []
  const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s) })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const ctx0 = ctxOf(newWorld('darwin'))
  let c = null
  const engine = createEngine({
    redirector: { lookupIngress: (q) => c.lookupIngress(q) }, issuer: createLeafIssuer(loadCa(createCa())), ingressToken: TOKEN, systemCa: { certs: [] },
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } },
    isRecording: (meta) => c.isOn(meta && meta.agent), onFailure: () => {},
  })
  c = createModelCollector({
    harnesses: pair, dir: tmpDir(), custody: stub, rootPem: certPem(stub.rootDer), proxyOf, bypassOf: () => [], templates: TEMPLATES, ownUid: 501,
    ctx: { os: 'darwin', home: '/h', dirs: {}, join: path.posix.join, readFile: ctx0.readFile, readdir: ctx0.readdir, exists: ctx0.exists, policy: ctx0.policy },
    identify: (f) => (f.agent ? { reason: 'match', agent: f.agent } : { reason: 'no-match' }),
    ownerOf: async ({ peer }) => (owners.has(peer.port) ? { pid: owners.get(peer.port), source: 'socket-table', ms: 1 } : { pid: null, why: 'no-row' }),
    factsOf: async (pid) => facts.get(pid) ?? null,
    proc: { envOf: async () => ({}), cwdOf: async () => '/p', parentOf: async () => null },
    readState: () => null, readIngress: () => ({ groupPorts: {}, listenerToken: TOKEN }),
    readManifest: () => ({ ...newManifest(), liveness: Object.fromEntries(pair.map((d) => [d.name, { on_at: iso(INSTALLED) }])) }),
    procTable: async () => [...facts].map(([pid, f]) => ({ pid, startedAt: f.startedAt })), clock: () => INSTALLED + 5,
    drain: ({ harnesses: hs, now }) => engine.drain({ agents: hs ? new Set(hs) : null, now }), // as runModelDaemon (src/collector/daemon.mjs) wires the collector's drain
  })
  c.bindDoors({ open: (l) => engine.listen({ groups: l }), close: (ids) => Promise.resolve(engine.closeGroups(ids)) })
  await c.start()
  const open = []
  t.after(async () => { for (const s of open) s.destroy(); c.close(); echo.close(); await closeWithin(engine) })
  /** A CONNECT through a door to the echo, from a client port owned by `pid` (none: no row in the socket table). → the open tunnel. */
  async function tunnel(g, port, pid = null) {
    const local = await freePort()
    if (pid != null) owners.set(local, pid)
    const s = net.connect({ port, host: '127.0.0.1', localAddress: '127.0.0.1', localPort: local }); s.on('error', () => {}); open.push(s)
    let got = ''
    s.on('data', (d) => { got += d.toString('latin1') })
    const auth = Buffer.from(`${g}:${TOKEN}`).toString('base64')
    s.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
    const until = (want, what) => within((async () => { while (!got.includes(want)) await sleep(5) })(), 4000, what)
    await until('\r\n\r\n', 'the CONNECT answer')
    assert.match(got, /^HTTP\/1\.1 200 /)
    got = ''
    return { s, echoed: async (text) => { s.write(text); await until(text, `the echo of ${text}`); return true } }
  }
  const settled = async (n) => { for (let i = 0; i < 400 && flows.length < n; i++) await sleep(10) }
  return { c, engine, owners, facts, flows, envelopes, tunnel, settled }
}

test('at a harness\'s door, a process that is not an agent, or one whose owner cannot be read, is passed through: its bytes go both ways, one connection row, no envelope', T, async (t) => {
  const W = await world(t)
  const [A] = pair, g = groupOf(A), port = await freePort()
  await W.c.on({ harnesses: [A.name], groups: { [g]: port } })
  W.facts.set(9001, { exe: '/usr/bin/curl', uid: 501, startedAt: INSTALLED + 1 }) // another process: on no list
  for (const [i, pid] of [[1, 9001], [2, null]]) {
    const x = await W.tunnel(g, port, pid)
    assert.equal(await x.echoed('ping'), true, 'the client got its bytes back')
    x.s.end()
    await W.settled(i)
    assert.equal(W.flows.length, i, 'exactly one connection row per connection')
    const row = W.flows[i - 1]
    assert.deepEqual([row.pid ?? null, row.decision, !!row.not_captured], [pid, 'splice', true], JSON.stringify(row))
  }
  assert.equal(W.envelopes.length, 0, 'nothing of theirs is recorded as a call')
})

test('two harnesses on, off of one: only its door closes; the other\'s door, its upstream answer and its connection in flight are untouched', T, async (t) => {
  const W = await world(t)
  const [A, B] = pair, gA = groupOf(A), gB = groupOf(B)
  const ports = { [gA]: await freePort(), [gB]: await freePort() }
  await W.c.on({ harnesses: [A.name, B.name], groups: ports })
  W.facts.set(7001, { exe: '/bin/a', uid: 501, agent: A.name, startedAt: INSTALLED + 1 })
  const x = await W.tunnel(gA, ports[gA], 7001)
  assert.equal(await x.echoed('before'), true)
  const upstreamA = W.c.upstreams()[gA]
  assert.ok(upstreamA && upstreamA.length, 'A\'s door answered an upstream for its process')
  await W.c.off({ harnesses: [B.name] })
  // A's connection is spliced (no boundary to see): an off that reached it would leave it waiting, and it would still relay
  assert.deepEqual(W.engine.relayed({ agents: new Set([A.name]) }), { closing: 0, waiting: 0 }, 'off of B asked none of A\'s connections to close')
  assert.deepEqual(W.c.doors(), { [gA]: ports[gA] }, 'B\'s door is gone, A\'s is on its port')
  assert.deepEqual([await canConnect(ports[gA]), await canConnect(ports[gB])], [true, false], 'A\'s door listens, B\'s does not')
  assert.deepEqual(W.c.upstreams()[gA], upstreamA, 'A\'s upstream answer is unchanged')
  assert.equal(W.c.isOn(A.name), true)
  assert.equal(await x.echoed('after'), true, 'A\'s connection in flight still relays')
  assert.equal(x.s.destroyed, false)
})
