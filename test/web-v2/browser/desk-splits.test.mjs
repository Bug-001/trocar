// test/web-v2/browser/desk-splits.test.mjs — 1.2 #9, the gesture half, on the mounted desk (a generated session, desk-world.mjs):
// - by default the outline column is --outline-w and the right page is --rightpage-w, the base.css tokens, and nothing is stored;
// - dragging a boundary stores its own key only and the width survives a reload;
// - a double-click removes the key and the inline property: the width is the token again;
// - an out-of-range stored width (5000) is read back clamped inside the page.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
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
    return !!x && +x[1] === m && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#rightpage')
  }, M, { timeout: 30000, polling: 'raf' })
}

test('1.2 #9: the splits default to the tokens; a drag stores only its own key and survives a reload; a double-click returns to the token; a stored 5000 is clamped', { skip }, async () => {
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
