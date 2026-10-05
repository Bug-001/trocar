// test/collector/harness/loader.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'

// Every later harness task appends its name here (RFC 4.6 §结构: one file per harness).
const EXPECTED = ['claude-code', 'opencode']

test('harness loader: every descriptor file loads and validates; helpers are skipped', async () => {
  const all = await loadHarnesses()
  assert.deepEqual(all.map((d) => d.name).sort(), [...EXPECTED].sort())
  assert.doesNotThrow(() => createRegistry(all))
  for (const d of all) for (const t of d.wsTerminal || []) for (const p of t.patterns) assert.doesNotThrow(() => new RegExp(p), `${d.name}: ${p}`)
})
