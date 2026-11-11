// test/web-v2/browser/tracks-menu.test.mjs — the Tracks menu on the mounted desk (2.1 #19, the Tracks half of 1.2 #8, 1.2 #26): a
// generated session with two sub-agents and failed main-lane rows. The button lives between 600 and 900 px and adds no row to the
// legend; the menu and the track gutter read one state; Next problem lands where `n` lands; the menu is a layer above the bottom panel
// and leaves with the desk; its box is on screen, unclipped by the scope. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const OPTS = { timeout: 120_000, skip }
const HASH = '#/replay/p/S'

// the first world with the shape these cases are about: the sub group in the menu, and problems for the pager to walk
function shaped() {
  for (let seed = 1; ; seed++) {
    const w = world(seed, { calls: 200 }), { lanes, calls } = w.full(), main = lanes.find((l) => l.kind === 'main')
    if (lanes.filter((l) => l.kind === 'subagent').length >= 2 && calls.filter((c) => c.lane === main.lane && c.status !== 200).length >= 2) return { w, steps: w.laneRidsAt().get(main.lane).length }
  }
}

// `fn(page, b)` on the opened session at `width`; no page error along the way
async function onDesk(width, fn) {
  const { w, steps } = shaped()
  const b = await withBoard({ bytes: 1e5, width, height: 900, chromium: gate.chromium })
  try {
    await serveWorld(b.page, w)
    await b.page.evaluate((h) => { location.hash = h }, HASH)
    await b.page.waitForSelector('#stepbar .sb-no', { timeout: 30_000 })
    await fn(b.page, steps)
    assert.deepEqual(b.errors, [], 'no page error')
  } finally { await b.stop() }
}
const resize = async (page, width) => {
  await page.setViewportSize({ width, height: 900 })
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))))
}
const shown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0), sel)
const button = (page) => page.locator('#saw .tracksbtn')
const menu = (page) => page.locator('[role=menu]')
const openMenu = async (page) => { await button(page).click(); await menu(page).waitFor() }
const gone = (page, sel) => page.waitForFunction((s) => !document.querySelector(s), sel)
const atStep = (page, n) => page.waitForSelector(`#stepbar .sb-no[data-n="${n}"]`, { timeout: 15_000 })
const goStep = async (page, n) => { await page.evaluate((h) => { location.hash = h }, `${HASH}?step=${n}`); await atStep(page, n) }
const nextItem = (page) => page.getByRole('menuitem').nth(1) // the pager's two items, Previous then Next (2.1 ⑥)

test('1.2 #8: the Tracks button is there from 600 up to 900 px and the gutter from 900 px', OPTS, async () => {
  await onDesk(1280, async (page) => {
    for (const w of [1280, 900, 899, 800, 600, 599, 500]) {
      await resize(page, w)
      assert.equal(await shown(page, '#saw .tracksbtn'), w >= 600 && w < 900, `${w}: the button`)
      assert.equal(await shown(page, '#saw .tgut'), w >= 900, `${w}: the gutter`)
    }
  })
})

test('2.1 #19: the button adds no row to the legend, and the rails draw no fold row of their own', OPTS, async () => {
  await onDesk(800, async (page) => {
    assert.equal(await page.locator('#rails [data-railunfold]').count(), 0, 'the fold row')
    const legend = () => page.locator('#saw .sawlegend').evaluate((e) => e.getBoundingClientRect().height)
    const withIt = await legend()
    await button(page).evaluate((e) => { e.style.display = 'none' })
    assert.equal(withIt, await legend())
  })
})

test('2.1 #19: the menu and the gutter read one state', OPTS, async () => {
  await onDesk(800, async (page) => {
    const sub = page.getByRole('menuitemcheckbox').first()
    await openMenu(page)
    await sub.click()
    await page.waitForSelector('#rails .subkids', { state: 'attached' })
    assert.equal(await menu(page).count(), 1, 'the menu stays through a toggle')
    await page.keyboard.press('Escape')
    await gone(page, '[role=menu]')
    await resize(page, 1280)
    const row = page.locator('[data-grouptoggle=sub]')
    assert.ok(await row.isVisible(), 'the gutter shows the group')
    assert.equal(await row.evaluate((e) => e.classList.contains('col')), false, 'open, as the menu left it')
    await row.click()
    await page.waitForSelector('[data-grouptoggle=sub].col')
    await resize(page, 800)
    await openMenu(page)
    assert.equal(await sub.getAttribute('aria-checked'), 'false', 'closed, as the gutter left it')
  })
})

test('2.1 #19: Next problem lands on the step `n` lands on, and is off past the last problem', OPTS, async () => {
  await onDesk(800, async (page, steps) => {
    // what the page shows around each leg, carried by a failure: the step, the URL and the problem steps the axis marks (0-based)
    const state = () => page.evaluate(() => ({ n: document.querySelector('#stepbar .sb-no')?.dataset.n, url: location.hash,
      marks: [...document.querySelectorAll('#probrow [data-i]')].map((e) => +e.dataset.i) }))
    await goStep(page, 1)
    const beforeN = await state()
    await page.keyboard.press('n')
    await page.waitForFunction(() => document.querySelector('#stepbar .sb-no')?.dataset.n !== '1')
    const landed = await page.locator('#stepbar .sb-no').getAttribute('data-n'), afterN = await state()
    await goStep(page, 1)
    await openMenu(page)
    const beforeNext = await state()
    await nextItem(page).click()
    await atStep(page, landed).catch(async (e) => {
      throw new Error(`Next problem did not land where n did (${landed}): ${JSON.stringify({ beforeN, afterN, beforeNext, now: await state() })}: ${e.message}`)
    })
    await page.keyboard.press('End')
    await atStep(page, steps)
    await openMenu(page)
    assert.equal(await nextItem(page).getAttribute('aria-disabled'), 'true')
  })
})

test('1.2 #26: over a raised panel Esc closes the menu first, the panel on the second press', OPTS, async () => {
  await onDesk(800, async (page) => {
    await page.locator('.deskside.bottom [role=tab]').first().click()
    await page.locator('.deskside.bottom .sidepanel').waitFor()
    await openMenu(page)
    await page.keyboard.press('Escape')
    await gone(page, '[role=menu]')
    assert.ok(await shown(page, '.deskside.bottom .sidepanel'), 'the panel stays up')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => ![...document.querySelectorAll('.deskside.bottom .sidepanel')].some((e) => e.getClientRects().length > 0))
  })
})

test('1.2 #26: the menu leaves with the desk and is not open on the way back', OPTS, async () => {
  await onDesk(800, async (page) => {
    await openMenu(page)
    await page.evaluate(() => { location.hash = '#/overview' })
    await gone(page, '[role=menu]')
    await page.evaluate(() => history.back())
    await page.locator('.desk #stepbar .sb-no').waitFor()
    assert.equal(await menu(page).count(), 0, 'the menu')
    assert.notEqual(await button(page).getAttribute('aria-expanded'), 'true', 'the button')
  })
})

test('2.1 #19: the popover is on screen and on top, not clipped by the scope', OPTS, async () => {
  await onDesk(800, async (page) => {
    await openMenu(page)
    const r = await page.locator('.pop.menu').evaluate((pop) => {
      const b = pop.getBoundingClientRect()
      return { inView: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, hit: pop.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)) }
    })
    assert.deepEqual(r, { inView: true, hit: true })
  })
})
