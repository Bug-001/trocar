// test/web-v2/asks.test.mjs — 第 K 次提问 and the ask ticks over D69 answers: the step head's K is the held main lane's
// user-event `k` (2.2 K row), never a count of the held events, and is not drawn when the held pages cannot know it; the
// ticks come from the `session` events, their hover's K / opening from the held `lane` event of that rid (1.3 §提问刻度);
// the outline's 「第 N 步起」 pairs with held lane events only (2.5:16). Held pages here start mid-lane (`prev` set).
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { renderSaw } from '../../src/web/v2/replay/timeline.mjs'
import { outlineHtml } from '../../src/web/v2/replay/outline.mjs'
import { applyLane } from '../../src/web/v2/replay/model.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
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
  return (playhead) => ({ desk, lanes, anchor, playhead, view: { lo: 0, hi: ROWS }, sawView: 'ctx', problems: [], navOpen: new Set(['msg']) })
}
const dataK = (h, cls) => { const m = new RegExp(`<span class="${cls}"[^>]*>`).exec(h); return m ? (/data-k="([^"]*)"/.exec(m[0]) || [])[1] ?? '' : null }

test('2.2 K: the step head\'s K is the held user event\'s k; not drawn where the held pages cannot know it', () => {
  for (const k of [2, 5, 9]) {
    // held from step 3 (index 2); the first held user event (index 3) is the lane's k-th ask: a count of held events says 1
    const at = world({ asks: [1, 3], from: 2, laneEvents: [{ type: 'user', rid: R(3), k, preview: 'p' }] })
    assert.equal(dataK(stepBarHtml(at(3)), 'sb-ask'), String(k), `k=${k} on its own step`)
    assert.equal(dataK(stepBarHtml(at(5)), 'sb-ask'), String(k), `k=${k} on a later step`)
    assert.equal(dataK(stepBarHtml(at(2)), 'sb-ask'), null, 'held, but its ask lies before the held pages: no K')
    assert.equal(dataK(stepBarHtml(at(1)), 'sb-ask'), null, 'the step is not held: no K')
  }
  // the lane from its first step without a user event at or before the step: no 「第 0 次」
  const none = world({ asks: [4], from: 0, laneEvents: [{ type: 'user', rid: R(4), k: 1, preview: 'p' }] })
  assert.equal(dataK(stepBarHtml(none(2)), 'sb-ask'), null)
  assert.equal(dataK(stepBarHtml(none(4)), 'sb-ask'), '1')
})

test('1.3 §提问刻度: the ask ticks come from the session events; the hover carries the held event\'s k and preview, no K when not held', () => {
  const preview = 'refactor the parser <b>'
  const at = world({ asks: [1, 3], from: 2, laneEvents: [{ type: 'user', rid: R(3), k: 5, preview }] })
  const nodes = new Map()
  const node = () => ({ innerHTML: '', textContent: '', title: '', style: { setProperty() {} }, classList: { toggle() {} } })
  const el = { querySelector: (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel) }, querySelectorAll: () => [] }
  renderSaw(el, at(3))
  const ticks = [...nodes.get('#askscale').innerHTML.matchAll(/<span class="atick"([^>]*)>/g)].map((m) => m[1])
  const tick = (i) => ticks.find((a) => a.includes(`data-i="${i}"`))
  assert.deepEqual(ticks.map((a) => /data-i="(\d+)"/.exec(a)[1]), ['1', '3'], 'one tick per session user event, on its step')
  assert.match(tick(3), /data-k="5"/)
  assert.ok(tick(3).includes('refactor the parser &lt;b&gt;'), 'the held preview, escaped')
  assert.ok(!/data-k=/.test(tick(1)), 'the page holding that ask is not held: no K')
})

test('2.5: the outline\'s 「第 N 步起」 is there when the user event is held, absent when not', () => {
  const q = 'fix the flaky test'
  // the playhead step (index 4) holds the question; its user event is on step index 3
  const held = world({ asks: [3], from: 2, queries: { 4: q }, laneEvents: [{ type: 'user', rid: R(3), k: 2, preview: q }] })
  assert.match(outlineHtml(held(4)), new RegExp(`data-jumprid="${R(3)}"`))
  // the same question whose event page is not held (held from index 4): the skeleton still has the event, no number
  const unheld = world({ asks: [3], from: 4, queries: { 4: q }, laneEvents: [] })
  assert.ok(!/data-jumprid/.test(outlineHtml(unheld(4))))
})
