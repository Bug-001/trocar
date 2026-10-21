// test/web-v2/drawer.test.mjs — the call drawer (2.6 §B): which main step it sits near, its open / close state, the input's
// rows carrying the input's sizes, the >40-blocks rule, the review bracket by lane kind, and the monitor verdict passed
// through as-is. String level over constructed lanes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { detailHtml, openDetail, closeDetail } from '../../src/web/v2/replay/detail.mjs'
import { reviewing } from '../../src/web/v2/replay/rails.mjs'
import { buildLanes } from '../../src/web/v2/replay/lanes.mjs'
import { bodyCache } from '../../src/web/v2/replay/cell.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'
import { deskOf } from './desk-world.mjs'

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const mainCalls = Array.from({ length: 6 }, (_, i) => ({ gi: i, ts: ts(i), ctx: 100 }))
const main = { id: 'main', kind: 'main', calls: mainCalls, giLocal: new Map(mainCalls.map((c, i) => [c.gi, i])), peakCtx: 200, events: [], resources: [] }
const stateOf = (extra = {}) => ({ anchor: main, lanes: [main], anchorTs: mainCalls.map((c) => Date.parse(c.ts)), playhead: 0, pricing: null, root: { querySelectorAll: () => [], querySelector: () => null }, ...extra })
const blk = (o) => ({ sec: 'messages', kind: 'text', role: 'user', chars: 30, ref: 'r1', head: { role: 'user', tag: 'user', label: 'b' }, ...o })

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

// a side lane held on the desk: one call with `blocks` as its input and `reply` as its reply definitions
const sideDesk = (blocks, reply = [], row = {}) => deskOf([{ kind: 'main', rows: [{}], blocks: [[]] }, { kind: 'aux', rows: [{ ...row }], blocks: [blocks], replies: [reply] }])
const drawSide = (desk) => { const lanes = buildLanes(desk), lane = lanes.find((l) => l.kind === 'aux'); return detailHtml({ ...stateOf(), desk, lanes }, lane, 0) }

test('the input: a row per block of the held lane, each carrying its own size from the input', () => {
  const rows = drawSide(sideDesk([blk({}), blk({ chars: 900 }), blk({ chars: null, bytes: 700, ff: 'summarized' })])).body.split('class="dblk').slice(1)
  assert.equal(rows.length, 3)
  assert.match(rows[1], /\b900\b/); assert.match(rows[2], /\b700\b/)
})

test('2.6 §B: a call whose lane is not held draws busy frames for its input and reply (no text, no control) and asks the desk for that lane', () => {
  const desk = deskOf([{ kind: 'main', rows: [{}], blocks: [[]] }, { kind: 'aux', rows: [{ error: 'x' }] }])
  const lanes = buildLanes(desk), lane = lanes.find((l) => l.kind === 'aux')
  const { body } = detailHtml({ ...stateOf(), desk, lanes }, lane, 0)
  assert.equal((body.match(/aria-busy="true"/g) || []).length, 2)
  assert.ok(!body.includes(W.NO_INPUT) && !body.includes(W.FAILED_NO_REPLY))
  const asked = []
  const el = { className: '', innerHTML: '', querySelectorAll: () => [] }
  openDetail(el, { ...stateOf(), desk, lanes, wantLane: (k) => asked.push(k) }, lane, 0)
  assert.deepEqual(asked, [lane.id])
})

test('more than 40 input blocks: none auto-opens; 40 short ones all do', () => {
  assert.ok(!/dblk open/.test(drawSide(sideDesk(Array.from({ length: 41 }, () => blk({ chars: 5 })))).body))
  assert.equal((drawSide(sideDesk(Array.from({ length: 40 }, () => blk({ chars: 5 })))).body.match(/dblk open/g) || []).length, 40)
})

test('the review bracket is only for the kinds that read the conversation; a token-count tick shows its measured count', () => {
  const tcLane = { id: 'token-count', kind: 'token-count', label: 'tc', calls: [{ gi: 0, ts: ts(2), ctx: 12345, retention: 'full' }] }
  assert.match(detailHtml(stateOf(), tcLane, 0).body, /12k/) // 12345 from the input
  assert.equal(reviewing({ kind: 'probe' }), false)
  assert.equal(reviewing(tcLane), true)
  assert.equal(reviewing({ kind: 'monitor' }), true)
  assert.equal(reviewing({ kind: 'subagent' }), false)
})

test('a monitor verdict is passed through as-is, as the cell of its reply part', () => {
  const verdict = 'the change is safe <b>no</b> issue', ref = 's/x#m::resp.raw::0-40'
  bodyCache.set(ref, { status: 'ok', text: verdict, fidelity: 'verbatim' })
  try {
    const body = drawSide(sideDesk([], [{ kind: 'text', ref, chars: verdict.length, preview: 'v' }])).body
    assert.ok(body.includes('the change is safe &lt;b&gt;no&lt;/b&gt; issue'))
  } finally { bodyCache.delete(ref) }
})

test('the reply cell holds the reply part\'s own bytes: its Raw body and its size are those bytes', () => {
  const ENT = { lt: '<', gt: '>', quot: '"', '#39': "'", '#13': '\r', amp: '&' }
  for (const text of ['Hello\nworld', '{"type":"text","text":"x"}', 'a"b\\c\r\n<i>']) {
    const ref = `s/x#r::resp.raw::0-${text.length}`
    bodyCache.set(ref, { status: 'ok', text, fidelity: 'verbatim' })
    const body = drawSide(sideDesk([], [{ kind: 'text', ref, chars: text.length }])).body
    bodyCache.delete(ref)
    const m = /<div class="cell"[^>]*data-chars="(\d+)"[^>]*>[\s\S]*?<pre class="cellraw">([\s\S]*?)<\/pre>/.exec(body)
    assert.ok(m, 'a Raw reply cell')
    assert.equal(+m[1], text.length)
    const raw = m[2].replace(/<span class="lay" aria-hidden="true">[^<]*<\/span>/g, '').replace(/&(lt|gt|quot|#39|#13|amp);/g, (_, n) => ENT[n])
    assert.equal(raw.replace(/^\n/, ''), text)
  }
})
