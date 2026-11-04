// test/web-v2/browser/desk-splits.test.mjs — 1.2 #9, the gesture half, on the mounted desk (a generated session, desk-world.mjs).
// The new desk: a drag writes only its boundary's key and survives a reload, a double-click deletes it, a stored non-table reads as the
// default, the collapsed sidebar survives a reload, and an untouched scope follows its content. The legacy desk:
// - by default the outline column is --outline-w and the right page is --rightpage-w, the base.css tokens, and nothing is stored;
// - dragging a boundary stores its own key only and the width survives a reload;
// - a double-click removes the key and the inline property: the width is the token again;
// - an out-of-range stored width (5000) is read back clamped inside the page.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, DESK_NEXT } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const legacyOnly = skip || (DESK_NEXT ? "the legacy desk's boundaries (旧台)" : false)
const nextOnly = skip || (DESK_NEXT ? false : "the new desk's boundaries (D80①)")
const KEY = { outline: 'trocar.v2.split.outline', rightpage: 'trocar.v2.split.rightpage' } // spec 1.2 §拖动边界
const SPLIT = { outline: { prop: '--outline-w', div: '#maindiv' }, rightpage: { prop: '--rightpage-w', div: '#divider' } }

// in the page: the token, the inline override, the stored value and the drawn width of each split
const state = () => {
  const root = document.documentElement, main = document.querySelector('#leftpage > main'), rp = document.querySelector('#rightpage')
  const token = (p) => { const s = root.style.getPropertyValue(p); root.style.removeProperty(p); const v = parseFloat(getComputedStyle(root).getPropertyValue(p)); if (s) root.style.setProperty(p, s); return v }
  return {
    outline: { token: token('--outline-w'), inline: root.style.getPropertyValue('--outline-w'), stored: localStorage.getItem('trocar.v2.split.outline'), width: parseFloat(getComputedStyle(main).gridTemplateColumns) },
    rightpage: { token: token('--rightpage-w'), inline: root.style.getPropertyValue('--rightpage-w'), stored: localStorage.getItem('trocar.v2.split.rightpage'), width: parseFloat(getComputedStyle(rp).width) },
    page: document.querySelector('#pages').getBoundingClientRect().width,
  }
}

async function open(page, M) {
  await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, M)
  await page.waitForFunction((m) => {
    const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
    return !!x && +x[1] === m && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#rightpage, #desk-side')
  }, M, { timeout: 30000, polling: 'raf' })
}

test('1.2 #9: the splits default to the tokens; a drag stores only its own key and survives a reload; a double-click returns to the token; a stored 5000 is clamped', { skip: legacyOnly }, async () => {
  const w = world(3, { calls: 40, page: 40, talk: { pre: 4, len: 120, every: 20, tail: 40 } })
  const M = w.laneRidsAt().get(w.full().lanes.find((l) => l.kind === 'main').lane).length
  const b = await withBoard({ bytes: 1e5, width: 1440, height: 900, chromium: gate.chromium })
  try {
    const { page } = b
    await serveWorld(page, w)
    await open(page, M)
    let s = await page.evaluate(state)
    for (const k of ['outline', 'rightpage']) {
      assert.ok(s[k].token > 0, `${k}: the token is set`)
      assert.equal(s[k].width, s[k].token, `${k}: the default width is the token`)
      assert.equal(s[k].stored, null, `${k}: nothing stored by default`)
      assert.equal(s[k].inline, '', `${k}: no inline width by default`)
    }

    for (const [k, other, dx] of [['outline', 'rightpage', 60], ['rightpage', 'outline', -60]]) {
      const box = await page.locator(SPLIT[k].div).boundingBox()
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y); await page.mouse.move(x + dx, y); await page.mouse.up()
      s = await page.evaluate(state)
      assert.ok(s[k].stored != null, `${k}: a drag stores its key`)
      assert.equal(s[other].stored, null, `${k}: a drag leaves ${other}'s key alone`)
      assert.notEqual(s[k].width, s[k].token, `${k}: the drag moved the width`)
      const dragged = s[k].width
      await page.reload(); await open(page, M)
      s = await page.evaluate(state)
      assert.equal(s[k].width, dragged, `${k}: the dragged width survives a reload`)
      await page.locator(SPLIT[k].div).dblclick()
      s = await page.evaluate(state)
      assert.equal(s[k].stored, null, `${k}: a double-click removes the key`)
      assert.equal(s[k].inline, '', `${k}: a double-click removes the inline property`)
      assert.equal(s[k].width, s[k].token, `${k}: a double-click returns to the token`)
    }

    await page.evaluate((key) => localStorage.setItem(key, '5000'), KEY.rightpage)
    await page.reload(); await open(page, M)
    s = await page.evaluate(state)
    assert.ok(s.rightpage.width < 5000 && s.rightpage.width < s.page, `a stored 5000 reads back clamped inside the page: ${s.rightpage.width} of ${s.page}`)
    assert.ok(s.outline.width > 0, 'the outline keeps its column')
  } finally { await b.stop() }
})

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
async function desk(run) {
  const w = world(3, { calls: 40, page: 40, talk: { pre: 4, len: 120, every: 20, tail: 40 } })
  const M = w.laneRidsAt().get(w.full().lanes.find((l) => l.kind === 'main').lane).length
  const b = await withBoard({ bytes: 1e5, width: 1440, height: 900, chromium: gate.chromium })
  try {
    await serveWorld(b.page, w)
    await open(b.page, M)
    await run(b.page, () => b.page.reload().then(() => open(b.page, M)))
  } finally { await b.stop() }
}

test('1.2 #9: a drag stores only its own key and survives a reload; a double-click deletes the key and returns to the default', { skip: nextOnly }, async () => {
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

test('1.2 #9: a stored value that is no table of numbers reads as the default; the collapsed sidebar survives a reload', { skip: nextOnly }, async () => {
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

test('1.2 §回放台布局: an untouched scope follows its content; once dragged it stays put', { skip: nextOnly }, async () => {
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
