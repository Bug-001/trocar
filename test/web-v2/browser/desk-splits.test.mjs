// test/web-v2/browser/desk-splits.test.mjs — 1.2 #9, the gesture half, on the mounted desk (a generated session, desk-world.mjs).
// A drag writes only its boundary's key and survives a reload and a poll, a double-click deletes it, a stored out-of-range size reads
// back clamped, a stored non-table reads as the default, the collapsed sidebar survives a reload, and an untouched scope follows its content.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
async function open(page, M) {
  await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, M)
  await page.waitForFunction((m) => {
    const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
    return !!x && +x[1] === m && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#rightpage, #desk-side')
  }, M, { timeout: 30000, polling: 'raf' })
}

const inView = () => {
  const row = document.querySelector('#saw .tkrow-ovw').getBoundingClientRect(), cell = document.querySelector('#desk-scope').getBoundingClientRect()
  return row.bottom <= cell.bottom + 1 && row.top >= cell.top - 1
}
const NEXT = { side: 'trocar.v2.split.side', scope: 'trocar.v2.split.scope' } // 1.2 §回放台布局
const EDGE = { side: '.deskpanes > [data-separator]', scope: '.deskcol > [data-separator]' }
const SIDE_PX = 352
const sizes = () => {
  const box = (sel) => document.querySelector(sel).getBoundingClientRect()
  return { side: box('#desk-side').width, scope: box('#desk-scope').height, content: box('.scopefit').height, col: box('.deskcol').height, head: box('#stepbar').height,
    stored: { side: localStorage.getItem('trocar.v2.split.side'), scope: localStorage.getItem('trocar.v2.split.scope') } }
}
const fitted = (z) => Math.max(48, Math.min(z.content, z.col / 2 - z.head)) // 1.2: as tall as the content, up to half the column less the step head
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 2, `${what}: ${a} against ${b}`)
async function drag(page, edge, dx, dy) {
  const box = await page.locator(edge).boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y + dy / 2); await page.mouse.move(x + dx, y + dy); await page.mouse.up()
}
// `behind`: the server starts that many members before the last mark and moves on one per granted head read (run's third argument)
async function desk(run, behind = 0) {
  const w = world(3, { calls: 40, page: 40, talk: { pre: 4, len: 120, every: 20, tail: 40 } })
  const from = w.marks.length - 1 - behind
  const M = w.laneRidsAt(w.marks[from]).get(w.full().lanes.find((l) => l.kind === 'main').lane).length
  const b = await withBoard({ bytes: 1e5, width: 1440, height: 900, chromium: gate.chromium })
  try {
    const growth = await serveWorld(b.page, w, behind ? { from, grow: 1, paced: true } : {})
    await open(b.page, M)
    await run(b.page, () => b.page.reload().then(() => open(b.page, M)), growth)
  } finally { await b.stop() }
}

test('1.2 #9: a drag stores only its own key and survives a reload; a double-click deletes the key and returns to the default', { skip }, async () => {
  await desk(async (page, reload) => {
    let z = await page.evaluate(sizes)
    near(z.side, SIDE_PX, 'the sidebar default')
    near(z.scope, fitted(z), 'the scope default')
    assert.deepEqual(z.stored, { side: null, scope: null }, 'nothing stored by default')
    for (const [k, other, dx, dy] of [['side', 'scope', -60, 0], ['scope', 'side', 0, -40]]) {
      const was = z[k]
      await drag(page, EDGE[k], dx, dy)
      z = await page.evaluate(sizes)
      assert.ok(z.stored[k] != null, `${k}: a drag stores its key`)
      assert.equal(z.stored[other], null, `${k}: a drag leaves the other key alone`)
      near(z[k], was + (dx ? -dx : dy), `${k}: the drag moved it`)
      assert.ok(await page.evaluate(inView), `${k}: the whole-session row stays in view`)
      const dragged = z[k]
      await reload()
      z = await page.evaluate(sizes)
      near(z[k], dragged, `${k}: the size survives a reload`)
      await page.locator(EDGE[k]).dblclick()
      z = await page.evaluate(sizes)
      assert.equal(z.stored[k], null, `${k}: a double-click removes the key`)
      near(z[k], k === 'side' ? SIDE_PX : fitted(z), `${k}: a double-click returns to the default`)
    }
  })
})

test('1.2 #9: a stored out-of-range size reads back clamped; a dragged size survives a poll', { skip }, async () => {
  await desk(async (page, reload, growth) => {
    // the panels' own limits (DeskFrame.tsx): the sidebar 220-720 px beside a main area of at least 480, the scope at most 75% of the column
    await page.evaluate((k) => { localStorage.setItem(k.side, '{"desk-main":1,"desk-side":99}'); localStorage.setItem(k.scope, '{"desk-scope":99,"desk-read":1}') }, NEXT)
    await reload()
    let z = await page.evaluate(sizes)
    const main = await page.evaluate(() => document.querySelector('#desk-main').getBoundingClientRect().width)
    assert.ok(z.side >= 218 && z.side <= 722 && main >= 478, `a stored 99% sidebar reads back clamped: ${z.side} px beside ${main} px`)
    assert.ok(z.scope <= 0.75 * z.col + 2, `a stored 99% scope reads back clamped: ${z.scope} of ${z.col}`)
    await page.evaluate((k) => { localStorage.removeItem(k.side); localStorage.removeItem(k.scope) }, NEXT)
    await reload()
    for (const [k, dx, dy] of [['side', -60, 0], ['scope', 0, -40]]) await drag(page, EDGE[k], dx, dy)
    const dragged = await page.evaluate(sizes)
    const left = growth.left()
    growth.more(1) // the next head read takes one member more: a poll answer that differs
    for (const t = Date.now(); growth.left() === left; await page.waitForTimeout(50)) assert.ok(Date.now() - t < 20000, 'no poll took the granted member')
    await page.waitForTimeout(300) // the answer is drawn
    z = await page.evaluate(sizes)
    near(z.side, dragged.side, 'the sidebar after a poll')
    near(z.scope, dragged.scope, 'the scope after a poll')
    assert.deepEqual(z.stored, dragged.stored, 'a poll writes no key')
  }, 2)
})

test('1.2 #9: a stored value that is no table of numbers reads as the default; the collapsed sidebar survives a reload', { skip }, async () => {
  await desk(async (page, reload) => {
    for (const junk of ['{"x":"junk"}', 'junk', '[1,2]']) {
      await page.evaluate(([k, v]) => { localStorage.setItem(k.side, v); localStorage.setItem(k.scope, v) }, [NEXT, junk])
      await reload()
      const z = await page.evaluate(sizes)
      near(z.side, SIDE_PX, `${junk}: the sidebar default`)
      near(z.scope, fitted(z), `${junk}: the scope default`)
    }
    await page.evaluate((k) => { localStorage.removeItem(k.side); localStorage.removeItem(k.scope) }, NEXT)
    await reload()
    await page.locator('.sidefold').click()
    near((await page.evaluate(sizes)).side, 40, 'collapsed')
    const tab = page.locator('.deskside [role=tab]').first()
    await tab.waitFor({ state: 'detached', timeout: 5000 }) // the strip holds no tab
    await reload()
    near((await page.evaluate(sizes)).side, 40, 'still collapsed after a reload')
    await tab.waitFor({ state: 'detached', timeout: 5000 })
    await page.locator('.sidefold').click()
    near((await page.evaluate(sizes)).side, SIDE_PX, 'expanded')
    await tab.waitFor({ timeout: 5000 }) // the tabs are back
  })
})

test('1.2 §回放台布局: an untouched scope follows its content; once dragged it stays put', { skip }, async () => {
  await desk(async (page) => {
    const content = (h) => page.evaluate((px) => { document.querySelector('.scopefit').style.height = px + 'px' }, h)
    const settled = (h) => page.waitForFunction((px) => Math.abs(document.querySelector('#desk-scope').getBoundingClientRect().height - px) <= 2, h, { timeout: 5000 })
    for (const h of [120, 200, 90]) { await content(h); await settled(h) } // both ways
    await content(5000)
    const z = await page.evaluate(sizes)
    await settled(z.col / 2 - z.head) // never past half the column less the step head
    await content(120); await settled(120)
    await drag(page, EDGE.scope, 0, 30)
    const dragged = (await page.evaluate(sizes)).scope
    await content(200)
    await page.waitForTimeout(200)
    assert.equal((await page.evaluate(sizes)).scope, dragged, 'a dragged scope no longer follows')
  })
})
