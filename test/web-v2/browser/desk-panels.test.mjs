// test/web-v2/browser/desk-panels.test.mjs — 2.3 #31 (三个面板按键打补丁) on the mounted desk: a generated session (desk-world.mjs)
// whose main lane's ledger holds several hundred resources, opened mid-lane with the right page's groups open. Stepping by ← and →,
// each step adds and removes at most 64 nodes in #resexp (descendants counted), and after each step #resexp is the DOM that its
// units drawn directly into a detached element make. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const NODE_CAP = 64 // spec 2.3:192

test('2.3 #31: a step adds and removes at most 64 nodes in the resource explorer, and the patched explorer equals the direct draw', { skip }, async (t) => {
  const w = world(5, { calls: 2100, page: 2100, files: 1500, talk: { pre: 10, len: 300, every: 40, tail: 0 } })
  const main = w.full().lanes.find((l) => l.kind === 'main')
  const M = w.laneRidsAt().get(main.lane).length, mid = Math.floor(M / 2)
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium })
  try {
    const { page } = b
    await serveWorld(page, w)
    const drawn = (n) => page.waitForFunction((n) => {
      const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
      const res = document.querySelector('#resexp')
      return !!x && +x[1] === n && !document.querySelector('#ctxwin .cwload') && !!res && res.children.length > 1 && !res.querySelector('[aria-busy]')
    }, n, { timeout: 30000, polling: 'raf' }).then(() => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))))
    await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, mid)
    await drawn(mid)
    for (const g of ['life-others', 'life-seen']) {
      const head = page.locator(`#resexp [data-navtoggle="${g}"]`)
      if (await head.count()) await head.first().click()
    }
    const rows = await page.evaluate(() => document.querySelectorAll('#resexp [data-navres], #resexp .navchip').length)
    if (rows < 200) return t.skip(`the explorer shows ${rows} rows: the world does not have the shape this case is about`)
    await page.evaluate(() => {
      window.__mut = 0
      const size = (n) => 1 + (n.querySelectorAll ? n.querySelectorAll('*').length : 0)
      new MutationObserver((rs) => { for (const r of rs) for (const n of [...r.addedNodes, ...r.removedNodes]) window.__mut += size(n) })
        .observe(document.querySelector('#resexp'), { childList: true, subtree: true })
    })
    const direct = () => page.evaluate(async () => {
      const el = document.querySelector('#resexp'), { serialize } = await import(new URL('./core/units.mjs', document.baseURI).href)
      const off = document.createElement('div')
      off.innerHTML = serialize(el.__units)
      return off.innerHTML === el.innerHTML
    })
    let at = mid, worst = 0
    for (const [key, d] of [['ArrowLeft', -1], ['ArrowRight', 1]]) {
      for (let i = 0; i < 20; i++) {
        await page.evaluate(() => { window.__mut = 0 })
        await page.keyboard.press(key)
        at += d
        await drawn(at)
        const n = await page.evaluate(() => window.__mut)
        worst = Math.max(worst, n)
        assert.ok(n <= NODE_CAP, `${key} to step ${at}: ${n} nodes added and removed in #resexp`)
        assert.ok(await direct(), `${key} to step ${at}: the patched explorer differs from its units drawn directly`)
      }
    }
    console.log(`# resource explorer: ${rows} rows, worst step ${worst} nodes added + removed (cap ${NODE_CAP})`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
