// test/web-v2/browser/overview-shots.test.mjs — the overview in real Chrome on the real face (1.7): the recent-sessions rows fit
// their card at 1280 (titles whole, the date inside the card), the first-use page, and the K-30 page off the viewport's corner.
// the first-use page with its agent rows (1.7 §首次使用: one control per row, only GETs until a click).
// Shots: overview, overview-first-use, overview-first-use-agents and forbidden at 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { probe, withBoard, shoot } from './harness.mjs'
import { ALIASES } from '../../../src/web/v2/core/chips.mjs'

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

const go = async (page, hash, sel) => {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.waitForSelector(sel, { timeout: 15000 })
}
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
        await go(b.page, '#/overview', '.ovcard.recent .ovitem'); await b.page.waitForLoadState('networkidle')
        if (width === 1280) assert.deepEqual(await recentFit(b.page), [])
        assert.equal(await hscroll(b.page), false)
        await shoot(b.page, 'overview', { width, theme })
        await b.page.route('**/api/sessions?**', (r) => r.fulfill({ json: EMPTY }))
        await go(b.page, '#/settings/appearance', '[data-theme-choice]'); await go(b.page, '#/overview', '.ovcard.start')
        await b.page.waitForLoadState('networkidle')
        assert.equal(await b.page.locator('.ovcard.items, .ovcard.stats, .ovcard.recent').count(), 0)
        assert.equal(await hscroll(b.page), false)
        await shoot(b.page, 'overview-first-use', { width, theme })
        await b.page.route('**/api/status*', (r) => r.fulfill({ json: twoAgents() }))
        await b.page.route('**/control/status*', (r) => r.fulfill({ json: { control: true } }))
        await go(b.page, '#/settings/appearance', '[data-theme-choice]'); await go(b.page, '#/overview', '#ovagents [data-hctl]')
        await b.page.waitForLoadState('networkidle')
        assert.deepEqual((await b.page.locator('#ovagents [data-hctl]').evaluateAll((xs) => xs.map((x) => x.dataset.hctl))).sort(), ['setup', 'switch'])
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
