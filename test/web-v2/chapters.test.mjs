// test/web-v2/chapters.test.mjs — 1.3 §章 (D71④), acceptance 18, pure half: over generated chapter tables (one chapter, many,
// inferred boundaries, one-step chapters) and every playhead — where ‹ / › and [ / ] land, the fitted window stays inside the
// playhead's chapter, the label's data attributes, the first chapter's ‹ and the last's › disabled, a tick at every chapter start.
// Asserted on data attributes and step numbers, never on words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chapterAt, chapterJump, chapterNavHtml, chapterTicksHtml, placeView, roughWindow } from '../../src/web/v2/replay/timeline.mjs'
import { keyAction } from '../../src/web/v2/replay/keymap.mjs'

// a head's chapter table (ctx-files.mjs headDoc's shape) over N steps, starting a chapter at each of `starts` (ascending, > 0)
const table = (N, starts, inferred = new Set()) => [0, ...starts].map((s0, k, a) => ({ k, s0, s1: k + 1 < a.length ? a[k + 1] : N, ts0: null, inferred: inferred.has(s0) }))
let seed = 7
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
function tables() {
  const out = [table(1, []), table(5, []), table(6, [1, 2, 3, 4, 5]), table(9, [8], new Set([8])), table(12, [3, 4, 9], new Set([4]))]
  for (let t = 0; t < 30; t++) {
    const N = 2 + rnd(80), starts = [...new Set(Array.from({ length: rnd(8) }, () => 1 + rnd(N - 1)))].sort((a, b) => a - b)
    out.push(table(N, starts, new Set(starts.filter(() => rnd(2)))))
  }
  return out
}
const attrs = (html, sel) => { const m = html.match(new RegExp(`<[^>]*${sel}[^>]*>`)); assert.ok(m, sel); return Object.fromEntries([...m[0].matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] ?? ''])) }
const holder = (chs, g) => chs.find((c) => g >= c.s0 && g < c.s1)

test('1.3 §章 · 18: ‹ / › and [ / ] land on the previous chapter\'s last step / the next chapter\'s first; none past either end', () => {
  for (const chs of tables()) {
    const N = chs.at(-1).s1
    for (let g = 0; g < N; g++) {
      const k = chs.indexOf(holder(chs, g)), why = `step ${g} of ${JSON.stringify(chs.map((c) => [c.s0, c.s1]))}`
      assert.equal(chapterAt(chs, g), k, why)
      const prev = k > 0 ? chs[k - 1].s1 - 1 : null, next = k + 1 < chs.length ? chs[k + 1].s0 : null
      assert.equal(chapterJump(chs, g, -1), prev, why)
      assert.equal(chapterJump(chs, g, 1), next, why)
      const key = (k2) => keyAction({ key: k2 }, { at: g, n: N, problems: [], chapters: chs, step: g })
      assert.deepEqual(key('['), prev == null ? null : { chapter: prev }, why)
      assert.deepEqual(key(']'), next == null ? null : { chapter: next }, why)
    }
  }
})

test('1.3 §章 · 18: the fitted window is inside the playhead\'s chapter, holds the playhead, and is no wider than the row draws', () => {
  for (const chs of tables()) {
    const N = chs.at(-1).s1, head = { steps: N, chapters: chs }
    for (const K of [1, 2, 3, 7, 1000]) for (let g = 0; g < N; g++) {
      const c = holder(chs, g), why = `K ${K} step ${g}`
      const views = [roughWindow(head, g, K), placeView({ lo: 0, hi: N }, g, c.s0, c.s1, K), placeView({ lo: c.s0, hi: c.s0 + 1 }, g, c.s0, c.s1, K),
        placeView({ lo: Math.max(0, g - 1), hi: Math.min(N, g + 2) }, g, c.s0, c.s1, K)]
      for (const v of views) {
        assert.ok(v.lo >= c.s0 && v.hi <= c.s1 && v.lo < v.hi, `inside the chapter: ${why} ${JSON.stringify(v)}`)
        assert.ok(g >= v.lo && g < v.hi, `holds the playhead: ${why} ${JSON.stringify(v)}`)
        assert.ok(v.hi - v.lo <= K, `fits: ${why}`)
      }
      assert.equal(roughWindow(head, g, K).hi - roughWindow(head, g, K).lo, Math.min(K, c.s1 - c.s0), `a chapter that fits is shown whole: ${why}`)
    }
  }
})

test('1.3 §章 · 18: the label names part k of n, its steps and an inferred start; the first ‹ and the last › are disabled', () => {
  for (const chs of tables()) {
    const N = chs.at(-1).s1
    for (let g = 0; g < N; g++) {
      const k = chs.indexOf(holder(chs, g)), c = chs[k], html = chapterNavHtml(chs, g, N), why = `step ${g}`
      const lab = attrs(html, 'data-part')
      assert.equal(lab['data-part'], String(k + 1), why); assert.equal(lab['data-of'], String(chs.length), why)
      assert.equal(lab['data-s0'], String(c.s0), why); assert.equal(lab['data-s1'], String(c.s1), why)
      assert.equal(lab['data-inferred'], String(c.inferred), why)
      const prev = attrs(html, 'id="chapPrev"'), next = attrs(html, 'id="chapNext"')
      assert.equal('disabled' in prev, k === 0, why); assert.equal('disabled' in next, k === chs.length - 1, why)
      if (k > 0) assert.equal(prev['data-to'], String(chs[k - 1].s1 - 1), why)
      if (k < chs.length - 1) assert.equal(next['data-to'], String(chs[k + 1].s0), why)
    }
    // live growth past the head: the last chapter holds the new steps, the label's end follows them
    const more = attrs(chapterNavHtml(chs, N + 2, N + 3), 'data-part')
    assert.equal(more['data-part'], String(chs.length)); assert.equal(more['data-s1'], String(N + 3))
  }
})

test('1.3 §章 · 18: the overview draws one tick per chapter, the k-th at s0 / N', () => {
  for (const chs of tables()) {
    const N = chs.at(-1).s1, html = chapterTicksHtml(chs, (g) => g, N)
    const ticks = [...html.matchAll(/class="ovchap"[^>]*style="left:([\d.]+)%"/g)].map((m) => Number(m[1]))
    assert.equal(ticks.length, chs.length)
    chs.forEach((c, k) => assert.ok(Math.abs(ticks[k] - (c.s0 / N) * 100) < 0.001, `tick ${k}`))
  }
})
