// model-liveness.test.mjs — the liveness record `trocar install` writes on macOS / Windows (4.11 P12, CM23 wiring): `rereads` and `per_request`
// come from the descriptor's proxyMode routes of the forms on that OS, so off's holder judge (holders.mjs) sees what the routes say; `trust_rereads`
// (trust.rereadsEntry) is uninstall's alone and never makes a door holder. Generated over
// every real descriptor × model OS; DeepSeek dsh (a per-request switch) and OpenCode (a re-read plugin route) are the regression seeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { livenessOf } from '../../src/collector/core/registry.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { holdersOf } from '../../src/off/holders.mjs'
import { readManifest } from '../../src/off/manifest.mjs'

const descs = await loadHarnesses()
const OSES = ['darwin', 'win32']

for (const d of descs.filter((x) => x.proxyMode)) {
  for (const os of OSES) {
    const routes = d.proxyMode.forms.filter((f) => f.os.includes(os)).map((f) => d.proxyMode.routes[f.route])
    test(`P12 · ${d.name} · ${os}: rereads iff a route here re-reads, trust_rereads iff the trust entry does, per_request iff every route here is per request`, () => {
      const l = livenessOf(d, { os })
      assert.equal(l.rereads, routes.some((r) => r.rereads === true))
      assert.equal(l.trust_rereads, !!(d.trust && d.trust.rereadsEntry))
      assert.equal(l.per_request === true, routes.length > 0 && routes.every((r) => r.perRequest === true))
    })
  }
  test(`P12 · ${d.name}: with no OS (Linux, the trust layer) no route re-reads; trust_rereads is the trust entry's`, () => {
    const l = livenessOf(d)
    assert.equal(l.rereads, false); assert.equal(l.trust_rereads, !!(d.trust && d.trust.rereadsEntry)); assert.equal(l.per_request, undefined)
  })
}

// through install and off's judge: an on window that closed a minute ago, the processes of the real presets
test('CM23 wiring: after install, a dsh started inside the on window is no holder (per request); an OpenCode alive at off_at is one (its plugin route re-reads)', async () => {
  const w = await modelWorld({ commands: ['dsh', 'opencode'] })
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify({ c: r.carriers, p: r.problems, pe: r.pending }))
  const m = readManifest(w.dir)
  assert.deepEqual([m.liveness['deepseek-dsh'].per_request, m.liveness.opencode.rereads], [true, true])
  const ON = Date.now() - 120_000, OFF = ON + 60_000
  for (const h of ['deepseek-dsh', 'opencode']) Object.assign(m.liveness[h], { on_at: new Date(ON).toISOString(), off_at: new Date(OFF).toISOString() })
  const proc = (pid, exe, argv, startedAt) => ({ pid, ppid: 1, uid: 501, startedAt, exe, argv, env: () => null, envRead: false })
  const dsh = proc(10, '/usr/local/bin/node', ['node', '/usr/local/bin/dsh'], ON + 1000)
  const oc = proc(11, '/usr/local/bin/opencode', ['opencode'], ON - 1000) // started before on, alive at off_at
  assert.deepEqual(holdersOf({ manifest: m, procs: [dsh, oc] }).map((x) => [x.harness, x.pid]), [['opencode', 11]])
  // the same table without the two flags: dsh is then a holder and OpenCode is not — the processes above are of the real presets, so the flags decide
  const bare = structuredClone(m); delete bare.liveness['deepseek-dsh'].per_request; bare.liveness.opencode.rereads = false
  assert.deepEqual(holdersOf({ manifest: bare, procs: [dsh, oc] }).map((x) => [x.harness, x.pid]), [['deepseek-dsh', 10]])
})

// Claude Code's trust entry re-reads (trust.rereadsEntry) but its settings route does not: a Claude started before on that never came through the
// door is no holder after off (seen on Windows: six Claude Desktop processes started before install were listed)
const ccWorld = async (doorSeen) => {
  const w = await modelWorld({ commands: ['claude'] })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify({ c: r.carriers, p: r.problems, pe: r.pending }))
  const m = readManifest(w.dir)
  const ON = Date.now() - 120_000, OFF = ON + 60_000
  Object.assign(m.liveness['claude-code'], { on_at: new Date(ON).toISOString(), off_at: new Date(OFF).toISOString() })
  const p = { pid: 21, ppid: 1, uid: 501, startedAt: ON - 3_600_000, exe: '/Applications/Claude.app/Contents/MacOS/Claude', argv: ['/Applications/Claude.app/Contents/MacOS/Claude'], env: () => null, envRead: false }
  return holdersOf({ manifest: m, procs: [p], doorSeen: doorSeen(p, ON) }).filter((x) => x.harness === 'claude-code').map((x) => [x.pid, x.why])
}
test('P12 · claude-code: a Claude started before on that never came through the door is no holder after off', async () => {
  assert.deepEqual(await ccWorld(() => []), [])
})
test('P12 · claude-code: the same Claude, seen by the door inside the on window, is a holder (door-seen)', async () => {
  assert.deepEqual(await ccWorld((p, ON) => [{ harness: 'claude-code', pid: p.pid, start: p.startedAt, at: new Date(ON + 1000).toISOString() }]), [[21, 'door-seen']])
})

test('P12 · install rewrites a record an older trocar wrote (rereads from the trust entry): rereads from the routes, trust_rereads added, the on window kept', async () => {
  const w = await modelWorld({ commands: ['claude'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const m = readManifest(w.dir), on_at = new Date(Date.now() - 120_000).toISOString(), off_at = new Date(Date.now() - 60_000).toISOString()
  m.liveness['claude-code'] = { identity: m.liveness['claude-code'].identity, rereads: true, on_at, off_at }
  fs.writeFileSync(path.join(w.dir, 'install-manifest.json'), JSON.stringify(m, null, 2))
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const l = readManifest(w.dir).liveness['claude-code']
  assert.deepEqual([l.rereads, l.trust_rereads, l.on_at, l.off_at], [false, true, on_at, off_at])
})
