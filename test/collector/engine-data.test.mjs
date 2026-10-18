// test/collector/engine-data.test.mjs — the engine's per-call / per-flow data both daemons build through engine-data.mjs (D60③; Plan 3c §2): for every
// shipped harness, the class table's level reaches the level the engine samples, a rule bound to another harness does not match it, and the descriptor's
// WebSocket terminators are what describe() hands the engine (none for a harness without them, none for an unknown agent).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { classesHook, wsTerminalHook } from '../../src/collector/engine-data.mjs'
import { BUILTIN } from '../../src/classes/table.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const list = await loadHarnesses()
const sink = () => { const recs = []; return { recs, failure: { event: (r) => recs.push(r), write: (r) => recs.push(r) } } }

for (const d of list) {
  test(`${d.name}: a class whose rule names its harness gives the engine that class and its level; the same rule bound to another harness does not`, () => {
    const home = tmpDir('asight-classes-')
    const id = d.name, other = list.map((x) => x.name).find((x) => x !== id) // a rule names its harness by the descriptor's name, as the CLI does
    const table = (h) => fs.writeFileSync(path.join(home, 'classes.json'), JSON.stringify({ version: 1, classes: [{ class: 'mine', keep: 'log', rules: [{ host: 'example\\.test', harness: h }] }, ...BUILTIN] }))
    const s = sink()
    const sample = () => classesHook({ home, failure: s.failure })({ agent: d.name }, 'example.test', 'POST', '/x')
    table(id)
    assert.deepEqual(sample(), { class: 'mine', level: 'log' }, JSON.stringify(s.recs))
    table(other)
    assert.deepEqual(sample(), { class: 'other', level: 'full' }, 'the rule is another harness\'s: nothing else matches, so `other` at its own level')
    assert.deepEqual(s.recs, [], 'a usable table is no event')
  })
  test(`${d.name}: describe hands the engine exactly the descriptor's WebSocket terminators`, () => {
    assert.deepEqual(wsTerminalHook(list)({ agent: d.name }), d.wsTerminal ? { wsTerminal: d.wsTerminal } : {})
  })
}
test('describe: an unknown agent or no meta gets no terminators', () => {
  assert.deepEqual(wsTerminalHook(list)({ agent: 'not-a-harness' }), {})
  assert.deepEqual(wsTerminalHook(list)(null), {})
})
