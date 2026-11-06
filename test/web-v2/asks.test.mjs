// test/web-v2/asks.test.mjs — the ask ticks over D69 answers: the ticks come from the `session` events, their hover's K / opening
// from the held `lane` event of that rid (1.3 §提问刻度). Held pages here start mid-lane (`prev` set). The prompt rows' step numbers are overview-model.test.mjs's (2.5 #2).
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeModel } from '../../web/src/screens/replay/models.mjs'
import { askScaleTip, askScaleStepTip } from '../../web/legacy/labels/replay.mjs'
import { applyLane } from '../../web/legacy/replay/model.mjs'
import { buildLanes, anchorLane, stepRef } from '../../web/legacy/replay/lanes.mjs'
import { deskOf } from './desk-world.mjs'

const R = (i) => `R0-${i}`
const ROWS = 6
// the main lane's six skeleton rows with `session` user events (no k, no preview: the skeleton carries neither) at `asks`;
// the lane's tail page holds rows from..5 with `prev` naming the row before, its user events with `k` and `preview`
function world({ asks, from, laneEvents, queries = {} }) {
  const desk = deskOf([{ kind: 'main', rows: Array.from({ length: ROWS }, () => ({ usage: { read: 1, create: 1, fresh: 1, out: 1 } })) }],
    { events: asks.map((i) => ({ type: 'user', rid: R(i), lane: R(0) })) })
  const defs = [], steps = []
  for (let i = from; i < ROWS; i++) {
    const q = queries[i], bid = `q${i}`
    if (q) defs.push({ bid, fh: bid, sec: 'messages', kind: 'text', role: 'user', bytes: 10, chars: 10, head: { role: 'user', tag: 'user', label: 'x' } })
    steps.push({ rid: R(i), parent: null, ops: [[1, ...(q ? [bid] : [])]], reply: [], attrs: q ? { 0: { query: q } } : {}, detail: null })
  }
  applyLane(desk, { lane: R(0), base: null, next: null, prev: from ? R(from - 1) : null, steps, defs, resources: [], seen: [], events: laneEvents })
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  return (playhead) => ({ desk, lanes, anchor, playhead, playRid: anchor.calls[playhead].rid, view: { lo: 0, hi: ROWS }, sawView: 'ctx', problems: [], navOpen: new Set(['msg']) })
}
test('1.3 §提问刻度: the ask ticks come from the session events; the hover carries the held event\'s k and preview, no K when not held', () => {
  const preview = 'refactor the parser <b>'
  const at = world({ asks: [1, 3], from: 2, laneEvents: [{ type: 'user', rid: R(3), k: 5, preview }] })
  const s = at(3), ticks = scopeModel(s, ROWS).asks.ticks, tick = (i) => ticks.find((x) => x.i === i)
  assert.deepEqual(ticks.map((x) => x.i), [1, 3], 'one tick per session user event, on its step')
  assert.equal(tick(3).tip, askScaleTip(5, preview), 'the held event\'s k and preview')
  assert.equal(tick(1).tip, askScaleStepTip(stepRef(s.lanes, R(1))), 'the page holding that ask is not held: the step only, no K')
})
