// test/collector/engine-data.test.mjs — the engine's per-call / per-flow data both daemons build through engine-data.mjs (D40; Plan 3c §2): for every shipped
// harness, a retention.json cell `log` reaches the level the engine samples for that harness's agent, a cell for another harness does not, and the
// descriptor's WebSocket terminators are what describe() hands the engine (none for a harness without them, none for an unknown agent).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { retentionHook, wsTerminalHook } from '../../src/collector/engine-data.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { harnessIdOfAgent } from '../../src/dissect/traffic.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const list = await loadHarnesses()
const sink = () => { const recs = []; return { recs, failure: { event: (r) => recs.push(r), write: (r) => recs.push(r) } } }

for (const d of list) {
  test(`${d.name}: retention.json says log for its harness → the engine samples log; another harness's cell leaves it full`, () => {
    const dir = tmpDir('asight-keep-'), file = path.join(dir, 'retention.json')
    const id = harnessIdOfAgent(d.name), other = list.map((x) => harnessIdOfAgent(x.name)).find((x) => x !== id)
    const write = (h) => fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { [h]: { llm: 'log', other: 'log' } } }))
    write(id)
    const s = sink()
    const r1 = retentionHook({ file, failure: s.failure })({ agent: d.name }, 'example.test', 'POST', '/v1/x')
    assert.equal(r1.level, 'log', JSON.stringify({ r1, recs: s.recs }))
    write(other)
    const r2 = retentionHook({ file, failure: s.failure })({ agent: d.name }, 'example.test', 'POST', '/v1/x')
    assert.equal(r2.level, 'full')
  })
  test(`${d.name}: describe hands the engine exactly the descriptor's WebSocket terminators`, () => {
    assert.deepEqual(wsTerminalHook(list)({ agent: d.name }), d.wsTerminal ? { wsTerminal: d.wsTerminal } : {})
  })
}
test('describe: an unknown agent or no meta gets no terminators', () => {
  assert.deepEqual(wsTerminalHook(list)({ agent: 'not-a-harness' }), {})
  assert.deepEqual(wsTerminalHook(list)(null), {})
})
