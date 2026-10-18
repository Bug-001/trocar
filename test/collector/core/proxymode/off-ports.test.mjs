// test/collector/core/proxymode/off-ports.test.mjs — V55's port disposition (1.6 §V55, 4.11 P12): in proxy mode one `asight off` over two harnesses
// disposes of their local ports differently — the door of the harness that still has a holder stays open and forward-only (it decrypts nothing), the
// door of the harness with no holder is closed. The seam is the collector's own off() (createModelCollector, src/collector/core/proxymode/collector.mjs
// settle/kept): the decision lives there, and nothing but it decides which port survives. The door half, the process table, the manifest and the clock
// are injected (no real OS, no socket, no daemon).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createModelCollector } from '../../../../src/collector/core/proxymode/collector.mjs'
import { certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { TEMPLATES } from '../../../../src/collector/harness/templates/index.mjs'
import { newManifest } from '../../../../src/off/manifest.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { descs, INSTALLED, newWorld, ctxOf } from './verdict-world.mjs'

const stub = custodyStub(); stub.create()
const STUB_PEM = certPem(stub.rootDer)
const iso = (ms) => new Date(ms).toISOString()
const PEER = { address: '127.0.0.1', port: 50000 }
const proxyOf = (u) => { const x = new URL(u); return { kind: x.protocol.startsWith('socks') ? 'socks5' : 'http', host: x.hostname, port: Number(x.port) } }
const entry = (h) => ({ phase: 'install', harness: h, kind: 'json-key', path: '/x', installed_at: iso(INSTALLED) })
// POST /off reaches the daemon before the CLI writes off_at (orchestrate step 3 < 4): on_at only, the collector fills off_at itself
const manifestOf = (hs) => ({ ...newManifest(), entries: hs.map(entry), liveness: Object.fromEntries(hs.map((h) => [h, { on_at: iso(INSTALLED) }])) })

// two harnesses with a darwin form each: A keeps a live process of its own, B has none
const formOf = (d) => d.proxyMode.forms.find((f) => f.os.includes('darwin'))
const pair = descs.filter((d) => formOf(d)).slice(0, 2)

test('V55 · proxy mode off: the door of the harness with a holder stays, forward-only; the door of the harness with no holder is closed', async () => {
  const [A, B] = pair
  const gA = `${A.name}:${formOf(A).route}`, gB = `${B.name}:${formOf(B).route}`
  const ports = { [gA]: 18201, [gB]: 18202 }
  const opened = [], closed = []
  const w = { now: INSTALLED + 5, ctx: ctxOf(newWorld('darwin')), procs: [{ pid: 7001, startedAt: INSTALLED + 1 }] }
  const c = createModelCollector({
    harnesses: pair, dir: '/nowhere', custody: stub, rootPem: STUB_PEM, proxyOf, templates: TEMPLATES, ownUid: 501,
    ctx: { os: 'darwin', home: '/h', dirs: {}, join: path.posix.join, readFile: (p) => w.ctx.readFile(p), readdir: (d) => w.ctx.readdir(d), exists: (p) => w.ctx.exists(p), policy: (s) => w.ctx.policy(s) },
    identify: (f) => (f.agent ? { reason: 'match', agent: f.agent } : { reason: 'no-match' }),
    ownerOf: async () => ({ pid: 7001, source: 'socket-table', ms: 1 }), factsOf: async () => ({ agent: A.name, uid: 501, startedAt: INSTALLED + 1 }),
    proc: { envOf: async () => ({}), cwdOf: async () => '/p', parentOf: async () => null },
    readState: () => null, readIngress: () => ({ groupPorts: ports, listenerToken: 'ab'.repeat(16) }),
    readManifest: () => manifestOf([A.name, B.name]), procTable: async () => w.procs, clock: () => w.now,
  })
  c.bindDoors({ open: async (l) => { opened.push(...l) }, close: async (ids) => { closed.push(...ids) } })
  await c.start()
  await c.on({ harnesses: [A.name, B.name], groups: ports })
  assert.deepEqual(c.doors(), ports, 'both doors listen while both harnesses are on')
  // A's own process is seen at A's door while A is on — that is what makes it A's holder after off; nothing ever reaches B's door
  await c.lookupIngress({ peer: PEER, user: gA, target: { address: 'api.example', port: 443 } })

  w.now = INSTALLED + 10
  const reply = await c.off({ harnesses: [A.name, B.name] })
  assert.equal(reply.actual, 'off')
  assert.equal(reply.holders, 1, 'one holder: the process of A started inside its on window')
  assert.deepEqual(c.doors(), { [gA]: 18201 }, "A's port stays (it has a holder), B's does not")
  assert.deepEqual(closed, [gB], "only B's door was closed, and on the same port it was opened on")
  // forward-only: the port that stays relays, it does not decrypt
  const meta = await c.lookupIngress({ peer: PEER, user: gA, target: { address: 'api.example', port: 443 } })
  assert.equal(meta.decrypt, false)
  assert.deepEqual(meta.skip, { not_captured: 'untracked', reason: 'group-off' })
  assert.equal(c.mayExit(), false, 'a kept door is a reason not to exit')
  c.close()
})
