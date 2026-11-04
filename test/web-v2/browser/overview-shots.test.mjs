// test/web-v2/browser/overview-shots.test.mjs — the overview in real Chrome on the real face (1.7): the recent-sessions rows fit
// their card at 1280 (titles whole, the date inside the card), the first-use page, and the K-30 page off the viewport's corner.
// the first-use page with its agent rows (1.7 §首次使用: one control per row, only GETs until a click), and an O1 item landing on its
// 采集 row opened (1.7 #16, ?h=). Elements are found by role and accessible name; the class names stay only for the fit checks.
// Shots: overview, overview-first-use, overview-first-use-agents and forbidden at 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { probe, withBoard, shoot } from './harness.mjs'
import { ALIASES, HARNESS_ORDER, harnessKey } from '../../../web/legacy/core/chips.mjs'
import { CARD } from '../../../web/legacy/labels/overview.mjs'
import { CTL } from '../../../web/legacy/labels/capture.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const EMPTY = { sessions: [], errors: [], next: null }
// the C.3 sample of spec 1.6 with two harnesses listed, the second still needing Set up
const C3 = fs.readFileSync(new URL('../../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8').split('### C.3')[1]
const SAMPLE = JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
const TWO = Object.keys(ALIASES).slice(0, 2)
const twoAgents = () => {
  const [h0] = Object.values(SAMPLE.harnesses)
  const row = (i) => ({ ...structuredClone(h0), setup: { state: i ? 'needed' : 'ready', missing: [] } })
  return { ...structuredClone(SAMPLE), health: { state: 'ok', since: new Date().toISOString() }, harnesses: Object.fromEntries(TWO.map((id, i) => [id, row(i)])), install: { state: 'complete', harnesses: TWO, pending: [] }, changed: [], holders: [], topology: {} }
}

// go to a hash and wait for the first element `at(page)` finds there
const go = async (page, hash, at) => {
  await page.evaluate((h) => { location.hash = h }, hash)
  await at(page).first().waitFor({ timeout: 15000 })
}
const card = (page, name) => page.getByRole('region', { name, exact: true })
const recentLinks = (page) => card(page, CARD.recent).getByRole('link')
// the agents card's controls: each switch (react-aria puts role=switch on its input) and each Set up button; data-hctl names the kind
const controls = (page) => { const a = card(page, CARD.agents); return a.getByRole('switch').or(a.getByRole('button', { name: CTL.setup, exact: true })) }
const themePage = (page) => page.locator('[data-theme-choice]')
// how the recent rows sit in their card: a cut title, or a date past the card's edge
const recentFit = (page) => page.evaluate(() => {
  const card = document.querySelector('.ovcard.recent').getBoundingClientRect()
  return [...document.querySelectorAll('.ovcard.recent .ovitem')].flatMap((a) => {
    const tx = a.querySelector('.ovtx'), wh = a.querySelector('.ovwhen')
    return [tx.scrollWidth > tx.clientWidth + 0.5 ? `cut: ${tx.textContent}` : null, wh.getBoundingClientRect().right > card.right ? `date out: ${wh.textContent}` : null].filter(Boolean)
  })
})
const hscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

for (const width of [1280, 1024]) {
  for (const theme of ['light', 'dark']) {
    test(`the overview and its first-use page at ${width} in ${theme}`, { skip }, async () => {
      const b = await withBoard({ bytes: 2e6, width, theme, chromium: gate.chromium })
      try {
        await go(b.page, '#/overview', recentLinks); await b.page.waitForLoadState('networkidle')
        if (width === 1280) assert.deepEqual(await recentFit(b.page), [])
        assert.equal(await hscroll(b.page), false)
        await shoot(b.page, 'overview', { width, theme })
        await b.page.route('**/api/sessions?**', (r) => r.fulfill({ json: EMPTY }))
        await go(b.page, '#/settings/appearance', themePage); await go(b.page, '#/overview', (p) => card(p, CARD.start))
        await b.page.waitForLoadState('networkidle')
        for (const name of [CARD.items, CARD.stats, CARD.recent]) assert.equal(await card(b.page, name).count(), 0, name)
        assert.equal(await hscroll(b.page), false)
        await shoot(b.page, 'overview-first-use', { width, theme })
        await b.page.route('**/api/status*', (r) => r.fulfill({ json: twoAgents() }))
        await b.page.route('**/control/status*', (r) => r.fulfill({ json: { control: true } }))
        await go(b.page, '#/settings/appearance', themePage); await go(b.page, '#/overview', controls)
        await b.page.waitForLoadState('networkidle')
        assert.deepEqual((await controls(b.page).evaluateAll((xs) => xs.map((x) => x.closest('[data-hctl]').dataset.hctl))).sort(), ['setup', 'switch'])
        assert.equal(await hscroll(b.page), false)
        await shoot(b.page, 'overview-first-use-agents', { width, theme })
        assert.deepEqual(b.requests.filter((r) => r.method !== 'GET'), [])
        assert.deepEqual(b.errors, [])
      } finally { await b.stop() }
    })

    test(`K-30 at ${width} in ${theme}: the page sits off the viewport's top-left corner`, { skip }, async () => {
      const b = await withBoard({ bytes: 0, token: false, width, theme, chromium: gate.chromium })
      try {
        await b.page.waitForSelector('main.forbidden')
        const box = await b.page.locator('main.forbidden').boundingBox()
        assert.ok(box.x > 0 && box.y > 0, JSON.stringify(box))
        await shoot(b.page, 'forbidden', { width, theme })
      } finally { await b.stop() }
    })
  }
}

// 1.7 #16 · L3: an O1 item opens the 采集 page on its row, expanded and in view. The C.3 sample's harness is on and not captured
// (config-after-start); five agents in that state fill Needs a look with ?h= links, and the last one's row sits below the fold
// until the landing scrolls it in (a problem row is open by default, so the scroll is what only ?h= gives).
test('an O1 item lands on its 采集 row, opened and in view (?h=)', { skip }, async () => {
  const b = await withBoard({ bytes: 2e6, chromium: gate.chromium })
  try {
    const [h0] = Object.values(SAMPLE.harnesses)
    assert.deepEqual([h0.desired, h0.captured, h0.reason], ['on', false, 'config-after-start'])
    const ids = HARNESS_ORDER.slice(0, 5)
    const doc = { ...structuredClone(SAMPLE), health: { state: 'ok', since: new Date().toISOString() }, critical: [], failures: { ...SAMPLE.failures, groups: [] },
      harnesses: Object.fromEntries(ids.map((id) => [id, structuredClone(h0)])), install: { state: 'complete', harnesses: ids, pending: [] } }
    await b.page.route('**/api/status*', (r) => r.fulfill({ json: doc }))
    const items = (p) => card(p, CARD.items).locator('a[href^="#/capture?h="]')
    await go(b.page, '#/overview', items)
    const link = items(b.page).last()
    const id = harnessKey(decodeURIComponent(new URL((await link.getAttribute('href')).slice(1), 'http://x').searchParams.get('h')))
    assert.ok(ids.map(harnessKey).includes(id), id)
    await link.click()
    const sel = `[data-caprow="cap-${id}"]`
    await b.page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', sel, { timeout: 15000 })
    const panel = await b.page.locator(sel).getAttribute('aria-controls')
    assert.ok(panel, 'the trigger names its panel')
    assert.equal(await b.page.locator(`[id="${panel}"]`).isVisible(), true)
    await b.page.waitForFunction((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }, sel, { timeout: 5000 })
    assert.deepEqual(b.requests.filter((r) => r.method !== 'GET'), [])
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
