// test/web-v2/browser/sidebar-fly.test.mjs — 1.2 §侧栏 (当前位置的样子): in the rail the fly-out shows after the hover delay
// (--t-tip), hides as soon as the pointer leaves, and shows at once on keyboard focus. Real mouse moves and a real Tab key in
// the real Chrome, at 1024 px where the rail is always on. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from './harness.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
const tipMs = (page) => page.evaluate(() => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--t-tip').trim()
  return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000
})

test('the rail fly-out waits --t-tip on hover, hides at once on leave, shows at once on focus', { skip }, async () => {
  const b = await withBoard({ chromium: gate.chromium, width: 1024, height: 900 })
  try {
    const { page } = b
    const hit = page.locator('#sidebar a.hit[data-id="capture"]')
    await hit.waitFor()
    const item = page.locator('#sidebar li.item', { has: page.locator('a.hit[data-id="capture"]') })
    const fly = item.locator('.fly')
    const anyFly = page.locator('#sidebar .fly:visible')
    const tip = await tipMs(page)
    assert.ok(tip > 0, 'the hover delay token is set')
    await page.mouse.move(1000, 880) // start off the sidebar
    await frame(page)
    assert.equal(await anyFly.count(), 0, 'no fly-out before any hover')

    // (a) hover: hidden at half the delay, shown by the delay + 250 ms
    const box = await hit.boundingBox()
    const t0 = Date.now()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const half = tip / 2 - (Date.now() - t0)
    if (half > 0) await page.waitForTimeout(half)
    if (Date.now() - t0 < tip) assert.equal(await anyFly.count(), 0, 'a fly-out shows before the hover delay')
    while (!(await fly.isVisible()) && Date.now() - t0 <= tip + 250) await page.waitForTimeout(10)
    assert.ok(await fly.isVisible(), 'the fly-out shows by the hover delay + 250 ms')

    // (b) leave: hidden within a frame (+50 ms)
    await page.mouse.move(1000, 880)
    await frame(page)
    await page.waitForTimeout(50)
    assert.equal(await anyFly.count(), 0, 'the fly-out stays after the pointer left')

    // (c) keyboard: Tab onto the item's link shows its fly-out within a frame
    const prev = item.locator('xpath=preceding-sibling::li[1]').locator('a.hit')
    await prev.focus()
    await page.keyboard.press('Tab')
    assert.ok(await hit.evaluate((el) => el === document.activeElement), 'Tab lands on the item link')
    await frame(page)
    assert.ok(await fly.isVisible(), 'the fly-out shows at once on keyboard focus')
  } finally { await b.stop() }
})
