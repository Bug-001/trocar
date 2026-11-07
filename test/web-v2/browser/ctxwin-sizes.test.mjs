// test/web-v2/browser/ctxwin-sizes.test.mjs — 2.3 #35: the desk's virtual list estimates every item at its real height. A generated
// conversation (desk-world.mjs `talk` with `heads`), in both themes, at a width where a row's head is one line and one where its label
// takes a line of its own.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const WIDTHS = [1440, 480]
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

// 2.3 #35: the list estimates every item at its real height, so from the top to the bottom, half a window at a time, #ctxwin's
// scrollHeight never changes and an item in view before a scroll moves on screen by exactly the scroll distance; after the step is
// drawn and after each scroll the window comes to rest (30 frames without a node added or removed). The same world, both themes, a
// width where a row's head is one line and one where its label takes a line of its own.
for (const theme of ['light', 'dark']) for (const width of WIDTHS) {
  test(`2.3 #35: the estimated height is the real height: scrolling half a window keeps scrollHeight and moves what is in view by the scroll (${theme}, ${width})`, { skip }, async () => {
    const w = world(11, { calls: 80, page: 80, heads: true, talk: { pre: 10, len: 700, every: 40, tail: 500 } })
    const main = w.full().lanes.find((l) => l.kind === 'main')
    const M = w.laneRidsAt().get(main.lane).length
    const b = await withBoard({ bytes: 1e5, width, theme, chromium: gate.chromium })
    try {
      const { page } = b
      await serveWorld(page, w)
      await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, M)
      await page.waitForFunction((m) => {
        const x = window.__stepNo()
        return !!x && x.n === m && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#ctxwin .cblk')
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
