// test/collector/harness/z-code-desktop-blocker.test.mjs — ruling ⑩ for Z-Code's desktop CA setting (4.11 Z-Code limits): with httpProxyCaCertPath set in
// ~/.zcode/v2/setting.json the desktop hands its agent ZCODE_AGENT_CA_CERT, under which Z-Code ignores the config's httpProxy and goes direct (macOS test
// machine, 2026-11-07: 0 records, 0 failures, while status said captured). The setting blocks the desktop form only: the CLI forms, on the same config
// file and route, keep their door; the plan names the setting's place. Every OS fact is injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import zcode from '../../../src/collector/harness/z-code.mjs'
import { writeRoutes } from '../../../src/collector/core/proxymode/entries.mjs'
import { world, door } from '../core/proxymode/fixtures/entries-ctx.mjs'

for (const os of ['darwin', 'win32']) {
  test(`ruling ⑩ · z-code · ${os}: httpProxyCaCertPath set → the desktop form gets no entry and says where; the CLI forms keep the shared route`, () => {
    const w = world({ os })
    const forms = zcode.proxyMode.forms.filter((f) => f.os.includes(os) && !(f.verified[os] && f.verified[os].reason))
    for (const f of forms) w.present(f)
    assert.ok(w.plant({ file: { base: 'home', env: 'ZCODE_DESKTOP_HOME_DIR', path: '.zcode/v2/setting.json' }, format: 'json', keys: ['httpProxyCaCertPath'] }))
    const out = writeRoutes(zcode, w.ctx, () => door())
    assert.deepEqual(out.notRouted.map((x) => [x.form, x.reason]), [['z-code.desktop', 'blocker']])
    assert.match(out.notRouted[0].at, /setting\.json#httpProxyCaCertPath$/, 'the plan names the setting and its file')
    assert.deepEqual(out.results.map((x) => [x.route, x.ok]), [['cli-config', true]], 'the CLI forms keep their door')
  })
}
