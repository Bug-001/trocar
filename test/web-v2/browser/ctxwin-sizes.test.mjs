// test/web-v2/browser/ctxwin-sizes.test.mjs — 2.3 #35: off screen a closed row and a folded turn card are laid out at their real
// size, so a placeholder drawn as its rows, and those rows coming on screen, move nothing below it. A generated conversation
// (desk-world.mjs `talk` with `heads`: rows with marks and without, no / short / long labels; folded cards and one long open card in
// groups), in both themes, at a width where a row's head is one line and one where its label takes a line of its own:
// - after the step is drawn, and after each scroll below, the window comes to rest: no node added or removed for 30 frames running;
// - a fresh copy of each kind of closed row (into the open card) and of each kind of folded card (before the first card), far from the
//   visible box, is measured while its content is skipped and again on screen: the two block sizes are equal;
// - a placeholder of the open card is scrolled to the top of the window and drawn: the span from its rows' top to the next unit's top
//   equals the span the placeholder held.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, DESK_NEXT } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
// which desk a case is about (2.3 #35): the legacy desk's skipped content and placeholders, or the new desk's estimates
const legacyOnly = skip || (DESK_NEXT ? "the legacy desk's groups (2.3 rule 4, 旧台)" : false)
const nextOnly = skip || (DESK_NEXT ? false : "the new desk's virtual list (2.3 rule 4)")
const WIDTHS = [1440, 480]

const frames = () => new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)))
// an evaluate that may not settle (a frame loop in the page) fails the case instead of hanging it
const within = (ms, what, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms} ms`)), ms).unref())])
// the window at rest: no node added or removed under #ctxwin for 30 frames running, within 10 s (polled in frames, which still run
// when a loop of the page's own keeps every other task waiting)
let rests = 0
const atRest = (page, when) => page.waitForFunction((tok) => {
  const W = document.querySelector('#ctxwin')
  let z = window.__rest
  if (!z || z.tok !== tok || z.W !== W) { z?.mo?.disconnect(); z = window.__rest = { tok, W, n: 0, seen: -1, quiet: 0 } }
  if (W && !z.mo) { z.mo = new MutationObserver((rs) => { z.n += rs.length }); z.mo.observe(W, { subtree: true, childList: true }) }
  z.quiet = z.n === z.seen ? z.quiet + 1 : 0
  z.seen = z.n
  return z.quiet >= 30
}, ++rests, { timeout: 10000, polling: 'raf' }).catch(() => assert.fail(`${when}, the window kept adding and removing nodes for 10 s`))

// in the page: every kind of closed row and folded card, copied far from the visible box → [{kind, off, real}] (block sizes in px;
// null where the copy was not skipped off screen, or still skipped on screen)
async function copiesMeasured(frames) {
  const W = document.querySelector('#ctxwin')
  const len = (el) => (el ? (el.textContent.length > 200 ? 'long' : 'short') : 'none')
  const marked = (head) => [...head.children].some((c) => parseFloat(getComputedStyle(c).borderTopWidth) > 0)
  const kindOf = (x) => x.classList.contains('cwturn')
    ? `card · ${x.querySelector('.qlabel') ? 'prompt' : 'no prompt'} · label ${len(x.querySelector('.cwturnq'))}`
    : `row · ${marked(x.firstElementChild) ? 'marks' : 'no marks'} · label ${len(x.querySelector('.cblabel'))}`
  const kinds = new Map()
  for (const x of W.querySelectorAll('.cblk.collapsed, .cwturn.collapsed')) if (!kinds.has(kindOf(x))) kinds.set(kindOf(x), x)
  const copies = [...kinds].map(([kind, x]) => { const c = x.cloneNode(true); c.removeAttribute('data-bi'); return { kind, c, row: !c.classList.contains('cwturn') } })
  W.querySelector('.cwturn:not(.collapsed) > .cwturnbody').prepend(...copies.filter((k) => k.row).map((k) => k.c))
  W.querySelector('.cwturn').before(...copies.filter((k) => !k.row).map((k) => k.c))
  const skipped = (k) => !k.c.firstElementChild.checkVisibility({ contentVisibilityAuto: true })
  const size = (k) => Math.round(k.c.getBoundingClientRect().height * 100) / 100
  await frames()
  const out = copies.map((k) => ({ kind: k.kind, off: skipped(k) ? size(k) : null, real: null }))
  for (const [i, k] of copies.entries()) {
    k.c.scrollIntoView({ block: 'center' })
    for (let f = 0; f < 30 && skipped(k); f++) await frames() // content is shown a frame or two after it comes on screen
    out[i].real = skipped(k) ? null : size(k)
  }
  for (const k of copies) k.c.remove()
  return out
}

// in the page: the open card's first placeholder that has a unit after it, scrolled to the window's top and drawn → {before, after,
// rows}: px from its top to the next unit's top, then from its rows' top to the same unit's top
async function placeholderDrawn(frames) {
  const W = document.querySelector('#ctxwin')
  const top = (el) => (getComputedStyle(el).display === 'contents' ? top(el.firstElementChild) : el.getBoundingClientRect().top)
  const h = [...W.querySelectorAll('.cwturn:not(.collapsed) .cwgroup[aria-busy]')].find((g) => g.nextElementSibling)
  if (!h) throw new Error('the open card has no placeholder followed by another unit')
  const parent = h.parentElement, i = [...parent.children].indexOf(h) // a group is swapped in place: its slot keeps its index
  const before = top(h.nextElementSibling) - top(h)
  h.scrollIntoView({ block: 'start' })
  const shown = () => !parent.children[i].hasAttribute('aria-busy') && parent.children[i].firstElementChild.firstElementChild.checkVisibility({ contentVisibilityAuto: true })
  for (let f = 0; f < 300 && !shown(); f++) await frames()
  if (!shown()) throw new Error('its rows were not drawn and shown in 300 frames')
  await frames()
  const g = parent.children[i]
  return { before, after: top(parent.children[i + 1]) - top(g.firstElementChild), rows: g.children.length }
}

for (const theme of ['light', 'dark']) for (const width of WIDTHS) {
  test(`2.3 #35: a closed row and a folded card are their real size off screen; a placeholder drawn moves nothing below (${theme}, ${width})`, { skip: legacyOnly }, async () => {
    const w = world(11, { calls: 80, page: 80, heads: true, talk: { pre: 10, len: 700, every: 40, tail: 500 } })
    const main = w.full().lanes.find((l) => l.kind === 'main')
    const M = w.laneRidsAt().get(main.lane).length
    const b = await withBoard({ bytes: 1e5, width, theme, chromium: gate.chromium })
    try {
      const { page } = b
      await serveWorld(page, w)
      await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, M)
      await page.waitForFunction((m) => {
        const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
        return !!x && +x[1] === m && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#ctxwin .cwturn:not(.collapsed) .cwgroup[aria-busy]')
      }, M, { timeout: 30000, polling: 'raf' })
      await atRest(page, 'after the step was drawn')

      const sizes = await within(20000, 'the copies', page.evaluate(`(${copiesMeasured})(${frames})`))
      const kinds = sizes.map((s) => s.kind)
      for (const want of [/^row · marks/, /^row · no marks/, /^row .* label none$/, /^row .* label long$/, /^card /])
        assert.ok(kinds.some((k) => want.test(k)), `the world has no closed row or card of the kind ${want}: ${kinds.join('; ')}`)
      for (const s of sizes) {
        assert.notEqual(s.off, null, `${s.kind}: the copy far from the visible box was drawn, so its off-screen size was not measured`)
        assert.notEqual(s.real, null, `${s.kind}: the copy on screen was still skipped`)
      }
      assert.deepEqual(sizes.filter((s) => s.off !== s.real), [], 'off screen, these were laid out at another block size than their real one')

      await atRest(page, 'after the copies were measured')
      const swap = await within(10000, 'the placeholder', page.evaluate(`(${placeholderDrawn})(${frames})`))
      console.log(`# ${theme} ${width}: ${sizes.length} kinds, sizes ${[...new Set(sizes.map((s) => s.real))].join('/')} px; a placeholder of ${swap.rows} rows held ${swap.before} px, drawn ${swap.after} px`)
      assert.equal(swap.after, swap.before, 'drawing the placeholder and bringing its rows on screen moved the unit below it')
      await atRest(page, 'after the placeholder was drawn')
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  })
}

// 2.3 #35 (新台): the list estimates every item at its real height, so from the top to the bottom, half a window at a time, #ctxwin's
// scrollHeight never changes and an item in view before a scroll moves on screen by exactly the scroll distance; after the step is
// drawn and after each scroll the window comes to rest (30 frames without a node added or removed). The same world, both themes, a
// width where a row's head is one line and one where its label takes a line of its own.
for (const theme of ['light', 'dark']) for (const width of WIDTHS) {
  test(`2.3 #35: the estimated height is the real height: scrolling half a window keeps scrollHeight and moves what is in view by the scroll (${theme}, ${width})`, { skip: nextOnly }, async () => {
    const w = world(11, { calls: 80, page: 80, heads: true, talk: { pre: 10, len: 700, every: 40, tail: 500 } })
    const main = w.full().lanes.find((l) => l.kind === 'main')
    const M = w.laneRidsAt().get(main.lane).length
    const b = await withBoard({ bytes: 1e5, width, theme, chromium: gate.chromium })
    try {
      const { page } = b
      await serveWorld(page, w)
      await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, M)
      await page.waitForFunction((m) => {
        const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
        return !!x && +x[1] === m && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#ctxwin .cblk')
      }, M, { timeout: 30000, polling: 'raf' })
      await atRest(page, 'after the step was drawn')
      const sh0 = await page.evaluate(() => document.querySelector('#ctxwin').scrollHeight) // before any scroll: nothing above the landing was measured yet
      await page.evaluate(() => { document.querySelector('#ctxwin').scrollTop = 0 })
      await atRest(page, 'after scrolling to the top')
      // in the page: the window's scroll numbers and the last item starting inside the visible box
      const look = () => page.evaluate(() => {
        const W = document.querySelector('#ctxwin'), box = W.getBoundingClientRect()
        const it = [...W.querySelectorAll('.cwit')].filter((e) => { const r = e.getBoundingClientRect(); return r.top >= box.top && r.top < box.bottom }).pop()
        return { top: W.scrollTop, sh: W.scrollHeight, h: W.clientHeight, key: it?.dataset.key ?? null, y: it ? it.getBoundingClientRect().top : null }
      })
      const yOf = (key) => page.evaluate((k) => document.querySelector(`#ctxwin .cwit[data-key="${CSS.escape(k)}"]`)?.getBoundingClientRect().top ?? null, key)
      const r2 = (x) => Math.round(x * 100) / 100
      let at = await look(), scrolls = 0
      const moved = []
      assert.equal(at.sh, sh0, `at the top: scrollHeight ${sh0} became ${at.sh}`)
      while (at.top + at.h < at.sh - 1) {
        assert.notEqual(at.key, null, `no item in view at scrollTop ${at.top}`)
        await page.evaluate((d) => { document.querySelector('#ctxwin').scrollTop += d }, Math.floor(at.h / 2))
        await atRest(page, `after scroll ${++scrolls}`)
        const now = await look(), y = await yOf(at.key)
        moved.push({ key: at.key, by: y == null ? null : r2(at.y - y), scrolled: r2(now.top - at.top) })
        assert.equal(now.sh, sh0, `scroll ${scrolls}: scrollHeight ${sh0} became ${now.sh}`)
        at = now
      }
      console.log(`# ${theme} ${width}: ${scrolls} half-window scrolls over ${sh0} px`)
      assert.ok(scrolls > 2, 'the window is several screens tall (the shape this case is about)')
      assert.deepEqual(moved.filter((m) => m.by !== m.scrolled), [], 'an item in view moved by another distance than the scroll')
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  })
}
