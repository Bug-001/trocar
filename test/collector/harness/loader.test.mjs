// test/collector/harness/loader.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnesses, caEnvProblems } from '../../../src/collector/harness/index.mjs'
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

// CM45: the names install records in ca_env come from the descriptor's caEnv alone, so every variable its proxy-mode data reads a CA file from is in it
test('CM45: a userCertFiles, merges or add-key variable missing from caEnv is a load error', async () => {
  const all = await loadHarnesses()
  for (const d of all) assert.deepEqual(caEnvProblems(d), [], d.name)
  const named = all.filter((d) => caEnvProblems({ ...d, caEnv: [] }).length).map((d) => d.name)
  assert.ok(named.length >= 3, `the check bites on the shipped data: ${named}`)
  assert.ok(caEnvProblems({ ...all[0], caEnv: 'NODE_EXTRA_CA_CERTS' }).length, 'not a list')
})
