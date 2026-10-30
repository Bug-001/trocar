// test/collector/harness/loader.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'

// Which harnesses there are is not restated here: the names are the descriptors' own (RFC 4.6 §结构: one file per harness), and the tables
// that must name each one are held to them where they live (test/cli/harness-names.test.mjs, test/web-v2/harness-seam.test.mjs).
test('harness loader: every descriptor file loads and validates; helpers are skipped', async () => {
  const all = await loadHarnesses()
  const names = all.map((d) => d.name)
  assert.ok(names.length > 0 && names.every((n) => typeof n === 'string' && n), 'each descriptor has a name')
  assert.equal(new Set(names).size, names.length, 'no name twice')
  assert.doesNotThrow(() => createRegistry(all))
  for (const d of all) for (const t of d.wsTerminal || []) for (const p of t.patterns) assert.doesNotThrow(() => new RegExp(p), `${d.name}: ${p}`)
})
