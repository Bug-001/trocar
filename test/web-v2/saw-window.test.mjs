// The replay desk's brush window (replay/timeline.mjs): how many steps the saw row can draw at once, and which of a long session's
// steps it shows when a session opens. Task 5 item 2: on the mock's 640-call session (485 steps) the row held 485 bars of at least
// 2 px + 1 px gap = 1454 px inside a 526 px lane, so the latest steps — and the playhead parked on the last one — were cut off.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SAW_BAR_PX, barsThatFit, fitWindow, capWindow, renderOverview, repositionBrush } from '../../src/web/v2/replay/timeline.mjs'

const css = fs.readFileSync(new URL('../../src/web/v2/css/replay.css', import.meta.url), 'utf8')
const rule = (sel) => { const m = css.match(new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); assert.ok(m, sel); return m[1] }

test('the pixel budget per bar is the CSS one: min-width 2px + a 1px gap, for the bars and for the cache band', () => {
  assert.equal(SAW_BAR_PX, 3)
  for (const [row, cell] of [['.sawrow', '.bar'], ['.cacherow', '.cbar']]) {
    assert.match(rule(row), /gap:\s*1px/, row); assert.match(rule(cell), /min-width:\s*2px/, cell)
  }
})
test('barsThatFit: floor(width / 3), never below 1', () => {
  assert.equal(barsThatFit(526), 175); assert.equal(barsThatFit(1454), 484); assert.equal(barsThatFit(3), 1)
  assert.equal(barsThatFit(2), 1); assert.equal(barsThatFit(1), 1); assert.equal(barsThatFit(0), 1)
})

test('a session that fits is shown whole; a longer one shows its last K steps when the playhead is among them', () => {
  assert.deepEqual(fitWindow({ lo: 0, hi: 40, K: 175, playhead: 39 }), { lo: 0, hi: 40 })
  assert.deepEqual(fitWindow({ lo: 0, hi: 175, K: 175, playhead: 0 }), { lo: 0, hi: 175 }, 'exactly K fits')
  assert.deepEqual(fitWindow({ lo: 0, hi: 485, K: 175, playhead: 484 }), { lo: 310, hi: 485 }, 'the 485-step session at 1024px: last 175, playhead at the end')
  assert.deepEqual(fitWindow({ lo: 0, hi: 485, K: 175, playhead: 310 }), { lo: 310, hi: 485 }, 'the first of the last K is still inside')
})
test('a playhead earlier than N-K gets a K-window centred on it, clamped to the session', () => {
  assert.deepEqual(fitWindow({ lo: 0, hi: 485, K: 175, playhead: 200 }), { lo: 113, hi: 288 }, 'centred: 200 - floor(175/2)')
  assert.deepEqual(fitWindow({ lo: 0, hi: 485, K: 175, playhead: 39 }), { lo: 0, hi: 175 }, '?step=40: clamped at the start')
  assert.deepEqual(fitWindow({ lo: 0, hi: 485, K: 175, playhead: 0 }), { lo: 0, hi: 175 })
  assert.deepEqual(fitWindow({ lo: 0, hi: 485, K: 1, playhead: 7 }), { lo: 7, hi: 8 }, 'one bar: exactly the playhead')
})
test('fitWindow works inside a wider window (a resize narrowed the lane): it stays within [lo, hi)', () => {
  assert.deepEqual(fitWindow({ lo: 100, hi: 300, K: 50, playhead: 299 }), { lo: 250, hi: 300 })
  assert.deepEqual(fitWindow({ lo: 100, hi: 300, K: 50, playhead: 100 }), { lo: 100, hi: 150 })
  assert.deepEqual(fitWindow({ lo: 100, hi: 300, K: 50, playhead: 180 }), { lo: 155, hi: 205 })
  assert.deepEqual(fitWindow({ lo: 100, hi: 120, K: 50, playhead: 110 }), { lo: 100, hi: 120 }, 'already fits: untouched')
})
test('property: the window is never wider than K, stays inside the session and keeps the playhead', () => {
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  for (let t = 0; t < 2000; t++) {
    const N = 1 + rnd(900), K = 1 + rnd(300), playhead = rnd(N), w = fitWindow({ lo: 0, hi: N, K, playhead })
    assert.ok(w.lo >= 0 && w.hi <= N && w.lo < w.hi, JSON.stringify({ N, K, playhead, w }))
    assert.equal(w.hi - w.lo, Math.min(K, N), JSON.stringify({ N, K, playhead, w }))
    assert.ok(playhead >= w.lo && playhead < w.hi, JSON.stringify({ N, K, playhead, w }))
  }
})

test('dragging the brush wider than the lane draws stops at K: the edge being dragged halts, the other stays', () => {
  const prev = { lo: 300, hi: 400 }
  assert.deepEqual(capWindow({ lo: 150, hi: 400, prev, K: 175, playhead: 399 }), { lo: 225, hi: 400 }, 'left edge dragged out')
  assert.deepEqual(capWindow({ lo: 300, hi: 480, prev, K: 175, playhead: 350 }), { lo: 300, hi: 475 }, 'right edge dragged out')
  assert.deepEqual(capWindow({ lo: 150, hi: 380, prev, K: 175, playhead: 350 }), { lo: 205, hi: 380 }, 'both edges moved: fit around the playhead')
  assert.deepEqual(capWindow({ lo: 320, hi: 420, prev, K: 175, playhead: 350 }), { lo: 320, hi: 420 }, 'a pan keeps its width untouched')
})
test('「全部」 on a session that does not fit gives the window that fits around the playhead, not a clipped row', () => {
  assert.deepEqual(capWindow({ lo: 0, hi: 485, prev: { lo: 100, hi: 200 }, K: 175, playhead: 484 }), { lo: 310, hi: 485 })
  assert.deepEqual(capWindow({ lo: 0, hi: 40, prev: { lo: 10, hi: 20 }, K: 175, playhead: 5 }), { lo: 0, hi: 40 }, 'it fits: truly all')
})


// ── the mid-drag guard: a repaint during a brush drag must not destroy the strip's DOM (the pointer capture rides it) ──
test('renderOverview with brushDragging: the backdrop is left untouched, only the brush geometry is written back', () => {
  const mk = () => {
    const map = new Map([['ovstrip', { innerHTML: '' }], ['ovbrush', { style: {} }], ['ovpin', { style: {} }]])
    return { map, el: { querySelector: (sel) => map.get(sel.replace(/^#/, '')) || null } }
  }
  const anchor = { calls: Array.from({ length: 8 }, (_, i) => ({ gi: i, ctx: 10 + i })), peakCtx: 20 }
  const s = { anchor, view: { lo: 0, hi: 8 }, playhead: 0, brushDragging: false }
  const { map, el } = mk()
  renderOverview(el, s)
  assert.ok(map.get('ovstrip').innerHTML.includes('ovbars'), 'not dragging: the strip is (re)built')
  // mid-drag: a poll repaint must not reassign innerHTML (the brush and its pointer capture live in that DOM)
  s.brushDragging = true
  s.view = { lo: 2, hi: 6 }
  map.get('ovstrip').innerHTML = 'SENTINEL-DOM'
  renderOverview(el, s)
  assert.equal(map.get('ovstrip').innerHTML, 'SENTINEL-DOM', 'dragging: the backdrop is not rebuilt')
  assert.equal(map.get('ovbrush').style.left, '25.000%', 'left = lo/N = 2/8')
  assert.equal(map.get('ovbrush').style.width, '50.000%', 'width = (hi-lo)/N = 4/8')
  assert.ok(Math.abs(parseFloat(map.get('ovpin').style.left) - 6.25) < 0.01, 'pin at (playhead+0.5)/N = 0.5/8')
  // the drag ends: the next render rebuilds the backdrop for the new view
  s.brushDragging = false
  renderOverview(el, s)
  assert.notEqual(map.get('ovstrip').innerHTML, 'SENTINEL-DOM', 'drag over: the strip is rebuilt')
  assert.ok(map.get('ovstrip').innerHTML.includes('ovbrush'), 'the brush comes back with it')
  assert.equal(map.get('ovbrush').style.left, '25.000%', 'and the geometry still matches the view')
})

// A5 (1.3 §主轨 compaction): the compaction cell is a mark with no visible text; its words ride the aria-label
test('the problem lane\'s compaction cell has no text content and a non-empty aria-label', async () => {
  const { renderSaw } = await import('../../src/web/v2/replay/timeline.mjs')
  for (const inferred of [false, true]) {
    const calls = Array.from({ length: 4 }, (_, i) => ({ gi: i, ts: new Date(Date.UTC(2026, 9, 7, 0, 0, i)).toISOString(), ctx: 100 + i, usage: { read: 90, create: 5, fresh: 5, out: 1 }, ...(i === 2 ? { compaction: true, compactionInferred: inferred } : {}) }))
    const anchor = { kind: 'main', calls, giLocal: new Map(calls.map((c, i) => [i, i])), events: [], peakCtx: 103 }
    const nodes = new Map()
    const node = () => ({ innerHTML: '', textContent: '', title: '', style: { setProperty() {} }, classList: { toggle() {} } })
    const el = { querySelector: (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel) }, querySelectorAll: () => [] }
    renderSaw(el, { anchor, view: { lo: 0, hi: 4 }, playhead: 0, sawView: 'ctx', problems: [] })
    const m = nodes.get('#probrow').innerHTML.match(/<span class="pcompact[^"]*"([^>]*)>([^<]*)<\/span>/)
    assert.ok(m, 'the compaction cell is drawn')
    assert.equal(m[2], '', 'no text content')
    assert.match(m[1], /aria-label="[^"]+"/)
  }
})
