// test/web-v2/drawer.test.mjs — the call drawer (2.6 §B): which main step it sits near, its open / close state, the input's
// rows carrying the input's sizes, the >40-blocks rule, the review bracket by lane kind, and the monitor verdict passed
// through as-is. String level over constructed lanes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { detailHtml, openDetail, closeDetail } from '../../src/web/v2/replay/detail.mjs'
import { reviewing } from '../../src/web/v2/replay/rails.mjs'

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const mainCalls = Array.from({ length: 6 }, (_, i) => ({ gi: i, ts: ts(i), ctx: 100 }))
const main = { id: 'main', kind: 'main', calls: mainCalls, giLocal: new Map(mainCalls.map((c, i) => [c.gi, i])), peakCtx: 200, events: [], resources: [] }
const stateOf = (extra = {}) => ({ anchor: main, lanes: [main], anchorTs: mainCalls.map((c) => Date.parse(c.ts)), playhead: 0, pricing: null, root: { querySelectorAll: () => [], querySelector: () => null }, ...extra })
const blk = (o) => ({ sec: 'messages', kind: 'text', role: 'user', chars: 30, text_ref: 'r1', faithfulness: 'verbatim', head: { role: 'user', tag: 'user', label: 'b' }, ...o })

test('a side-lane call sits near the main step closest in time; opening sets the lane kind on the drawer', () => {
  const call = { gi: 9, ts: ts(3), ctx: 5, norm: {}, flat: [], rec: { request: { model: 'm' } } }
  const lane = { id: 'sub1', kind: 'subagent', task: 't', label: 'subagent: t', calls: [call] }
  assert.equal(detailHtml(stateOf(), lane, 0).near, 3) // nearest main step by time (index 3)
  const el = { className: '', innerHTML: '', classList: { contains: () => false }, querySelectorAll: () => [] }
  openDetail(el, stateOf({ drawerFlat: [] }), lane, 0)
  assert.equal(el.className, 'open k-subagent')
})

test('closeDetail clears the selection; Esc is wired by the desk (replay.mjs owns v2:escape)', () => {
  const el = { className: 'open k-aux', innerHTML: '', querySelectorAll: () => [] }
  const s = stateOf({ selTick: { laneId: 'x', i: 0 }, drawerFlat: [1] })
  closeDetail(el, s)
  assert.equal(el.className, ''); assert.equal(s.selTick, null); assert.deepEqual(s.drawerFlat, [])
})

test('the input: a row per block, each carrying its own size from the input', () => {
  const flat = [blk({}), blk({ chars: 900 }), blk({ chars: null, bytes: 700, faithfulness: 'summarized' })]
  const call = { gi: 9, ts: ts(1), ctx: 5, norm: {}, usage: null, flat, rec: { request: { model: 'm' } } }
  const rows = detailHtml(stateOf(), { id: 'a', kind: 'aux', label: 'x', calls: [call] }, 0).body.split('class="dblk').slice(1)
  assert.match(rows[1], /\b900\b/); assert.match(rows[2], /\b700\b/)
})

test('more than 40 input blocks: none auto-opens', () => {
  const call = { gi: 9, ts: ts(1), ctx: 5, norm: {}, usage: null, flat: Array.from({ length: 41 }, () => blk({ chars: 5 })), rec: { request: { model: 'm' } } }
  assert.ok(!/dblk open/.test(detailHtml(stateOf(), { id: 'a', kind: 'aux', label: 'x', calls: [call] }, 0).body))
})

test('the review bracket is only for the kinds that read the conversation; a token-count tick shows its measured count', () => {
  const tcLane = { id: 'token-count', kind: 'token-count', label: 'tc', calls: [{ gi: 0, ts: ts(2), ctx: 12345, retention: 'full' }] }
  assert.match(detailHtml(stateOf(), tcLane, 0).body, /12k/) // 12345 from the input
  assert.equal(reviewing({ kind: 'probe' }), false)
  assert.equal(reviewing(tcLane), true)
  assert.equal(reviewing({ kind: 'monitor' }), true)
  assert.equal(reviewing({ kind: 'subagent' }), false)
})

test('a monitor verdict is passed through as-is', () => {
  const verdict = 'the change is safe <b>no</b> issue'
  const call = { gi: 9, ts: ts(2), ctx: 900, norm: { text: verdict }, flat: [], usage: null, rec: { request: { model: 'm' } }, flagged: false }
  const body = detailHtml(stateOf(), { id: 'm', kind: 'monitor', label: 'mon', calls: [call] }, 0).body
  assert.ok(body.includes('the change is safe &lt;b&gt;no&lt;/b&gt; issue'))
})
