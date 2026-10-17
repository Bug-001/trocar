// backendsFor's ctx.policy on the product path: no injected backends — the OS arm's own policy reader, called with every policy spec
// the harness descriptors declare, for each model OS. The reader's tools answer through a stub runner (no real plutil / reg.exe); the invariant
// is the reader's answer shape ({ set } | { error, where }), never a throw. Before the fix both arms threw `.read is not a function`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpDir } from '../../helpers/tmp.mjs'
import { backendsFor } from '../../../src/collector/arch/model-backends.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'

const specsOf = (x, out = []) => {
  if (Array.isArray(x)) x.forEach((v) => specsOf(v, out))
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) (k === 'policy' && v && typeof v === 'object' ? out.push(v) : specsOf(v, out))
  return out
}
// a tool that answers "not set" in each OS's words: plutil's missing key, reg.exe's missing key
const run = () => ({ status: 1, stdout: '', stderr: 'Could not extract value, error: No value at that key path' })

for (const os of ['darwin', 'win32']) {
  test(`backendsFor(${os}).policy reads every declared policy spec without throwing`, async () => {
    const specs = specsOf((await loadHarnesses()).map((h) => h.proxyMode)).map((s) => s[os]).filter(Boolean)
    assert.ok(specs.length > 0, `some harness declares a ${os} policy source`)
    const b = await backendsFor({ os, home: tmpDir(), run, env: { ...process.env, ASIGHT_TEST_SANDBOX: '1' } })
    for (const spec of specs) {
      const r = b.policy(spec)
      assert.ok(r && (typeof r.set === 'boolean' || typeof r.error === 'string'), `${os} ${JSON.stringify(spec)} → ${JSON.stringify(r)}`)
      assert.equal(r.set ?? false, false, 'the stub tool says not set')
    }
  })
}
