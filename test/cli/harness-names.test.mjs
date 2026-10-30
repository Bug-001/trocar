// test/cli/harness-names.test.mjs — RFC 1.6 §1.6 (harness names): the CLI id is the code id (the descriptor's `name`), a few short
// aliases are accepted on input, the output is always the code id, a wrong name is listed with the known ones (exit 2, nothing
// touched — the exit is the dispatcher's, tested there). One table, src/off/harness-names.mjs, for the CLI and trocar-off alike.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HARNESS_IDS, NAME_ALIASES, resolveHarnesses } from '../../src/off/harness-names.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

test('harness names: the ids are the descriptor names — a harness added as a descriptor alone fails here until the table names it (1.6 §1.6: CLI 名 = 代码 id)', async () => {
  const names = (await loadHarnesses()).map((d) => d.name).sort()
  assert.deepEqual([...HARNESS_IDS].sort(), names)
  assert.equal(new Set(HARNESS_IDS).size, HARNESS_IDS.length, 'no id twice')
})

test('harness names: aliases are exactly the four of 1.6 §1.6 and each points at a code id', () => {
  assert.deepEqual({ ...NAME_ALIASES }, { claude: 'claude-code', dsh: 'deepseek-dsh', kimi: 'kimi-code', zcode: 'z-code' })
  for (const [alias, id] of Object.entries(NAME_ALIASES)) {
    assert.ok(HARNESS_IDS.includes(id), `${alias} -> ${id}`)
    assert.ok(!HARNESS_IDS.includes(alias), `${alias} is not itself an id`)
  }
})

test('harness names: aliases resolve; output is always the code id; unknown names are listed', () => {
  assert.deepEqual(resolveHarnesses([]), { ok: true, ids: null })
  assert.deepEqual(resolveHarnesses(['claude', 'claude-code', 'zcode']), { ok: true, ids: ['claude-code', 'z-code'] })
  assert.deepEqual(resolveHarnesses(['clade']), { ok: false, unknown: ['clade'], known: [...HARNESS_IDS, ...Object.keys(NAME_ALIASES)] })
})

test('harness names: every id and every alias resolves to its code id', () => {
  for (const id of HARNESS_IDS) assert.deepEqual(resolveHarnesses([id]), { ok: true, ids: [id] })
  for (const [alias, id] of Object.entries(NAME_ALIASES)) assert.deepEqual(resolveHarnesses([alias]), { ok: true, ids: [id] })
})

test('harness names: the order is the HARNESS_IDS order, whatever the order typed; a repeat collapses', () => {
  assert.deepEqual(resolveHarnesses(['zcode', 'kimi', 'codex', 'claude', 'codex']), { ok: true, ids: ['claude-code', 'codex', 'kimi-code', 'z-code'] })
})

test('harness names: one wrong name among right ones refuses the lot, and every wrong one is listed once, in the order typed', () => {
  const r = resolveHarnesses(['claude', 'nope', 'codex', 'nope', 'Claude', ''])
  assert.equal(r.ok, false)
  assert.deepEqual(r.unknown, ['nope', 'Claude', ''])
  assert.ok(!('ids' in r), 'a refusal carries no ids to act on')
})

test('harness names: object-prototype keys are not names (a plain lookup would answer them)', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = resolveHarnesses([name])
    assert.equal(r.ok, false, name)
    assert.deepEqual(r.unknown, [name])
  }
})

test('harness names: what is not a string is unknown, not a crash', () => {
  const r = resolveHarnesses([null, 7, 'codex'])
  assert.equal(r.ok, false)
  assert.deepEqual(r.unknown, ['null', '7'])
})

test('harness names: an id an install manifest names is a name too, after the table\'s (off of a harness this table does not know)', () => {
  assert.deepEqual(resolveHarnesses(['acme', 'claude'], ['codex', 'acme']), { ok: true, ids: ['claude-code', 'acme'] })
  assert.deepEqual(resolveHarnesses(['nope'], ['acme']).known, [...HARNESS_IDS, 'acme', ...Object.keys(NAME_ALIASES)])
  assert.equal(resolveHarnesses(['acme']).ok, false, 'without a manifest naming it, it is unknown')
})
