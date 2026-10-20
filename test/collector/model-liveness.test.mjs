// model-liveness.test.mjs — the liveness record `trocar install` writes on macOS / Windows (4.11 P12, CM23 wiring): `rereads` and `per_request`
// come from the descriptor's proxyMode routes of the forms on that OS, so off's holder judge (holders.mjs) sees what the routes say. Generated over
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
    test(`P12 · ${d.name} · ${os}: liveness says rereads iff a route here re-reads (or the trust entry does), per_request iff every route here is per request`, () => {
      const l = livenessOf(d, { os })
      assert.equal(l.rereads, !!(d.trust && d.trust.rereadsEntry) || routes.some((r) => r.rereads === true))
      assert.equal(l.per_request === true, routes.length > 0 && routes.every((r) => r.perRequest === true))
    })
  }
  test(`P12 · ${d.name}: with no OS (Linux, the trust layer) the proxyMode routes say nothing`, () => {
    const l = livenessOf(d)
    assert.equal(l.rereads, !!(d.trust && d.trust.rereadsEntry)); assert.equal(l.per_request, undefined)
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
