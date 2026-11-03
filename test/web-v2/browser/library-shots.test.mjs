// test/web-v2/browser/library-shots.test.mjs — the session library in real Chrome on the real face (1.8 §验收 7, 9, 10, 13, 14):
// the page fits 800 px with every agent name visible, one window control (the page head's), no number in the head or tool row,
// truncated cells titled; the keys; a failed read keeps the old list; the empty state reads /api/status once while the list polls.
// Shots: the library and its empty variant at 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot } from './harness.mjs'
import { INTERVAL } from '../../../web/legacy/core/poll.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 2e6
const EMPTY = { sessions: [], errors: [], next: null }

const go = async (page, hash, sel) => {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.waitForSelector(sel, { timeout: 15000 })
}
// a fresh mount of the library (via another screen), so a routed /api/sessions answer is what it starts from
const remount = async (page, sel) => { await go(page, '#/settings/appearance', '[data-theme-choice]'); await go(page, '#/sessions', sel) }

const layout = (page) => page.evaluate(() => {
  const txt = (e) => (e ? e.textContent : '')
  const head = document.querySelector('#libhead'), ra = head && head.querySelector('.readat')
  return {
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > innerWidth,
    untitled: [...document.querySelectorAll('#content *')].filter((e) => e.getClientRects().length && getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 0.5 && !e.closest('[title]'))
      .map((e) => `${e.className}: ${e.textContent.slice(0, 40)}`),
    segs: document.querySelectorAll('#content [role=radiogroup]').length,
    segInHead: document.querySelectorAll('#libhead [role=radiogroup]').length,
    // the head's words besides its read-at time and the window control's own options; the tool row as drawn (menus closed)
    headText: txt(head).replace(txt(ra), '').replace(txt(head && head.querySelector('[role=radiogroup]')), ''),
    toolText: document.querySelector('.libtools').innerText,
    hiddenNames: [...document.querySelectorAll('.lrow .lhn')].filter((e) => !e.getClientRects().length || e.getBoundingClientRect().width < 1).length,
  }
})

for (const width of [1280, 1024]) {
  for (const theme of ['light', 'dark']) {
    test(`(7)(14) the library and its empty state at ${width} in ${theme}: one window control, no head numbers, titled truncation`, { skip }, async () => {
      const b = await withBoard({ bytes: BYTES, width, theme, chromium: gate.chromium })
      try {
        await go(b.page, '#/sessions', '.lrow'); await b.page.waitForLoadState('networkidle')
        const l = await layout(b.page)
        assert.equal(l.hscroll, false); assert.deepEqual(l.untitled, [])
        assert.equal(l.segs, 1); assert.equal(l.segInHead, 1)
        assert.doesNotMatch(l.headText, /\d/); assert.doesNotMatch(l.toolText, /\d/); assert.equal(l.hiddenNames, 0)
        await shoot(b.page, 'library-rows', { width, theme })
        await b.page.route('**/api/sessions?**', (r) => r.fulfill({ json: EMPTY }))
        await remount(b.page, '.libempty a[href="#/capture"]')
        await b.page.waitForFunction(() => document.querySelector('.libempty .dimline').textContent.trim() !== '', null, { timeout: 15000 }) // the status sentence
        assert.equal((await layout(b.page)).hscroll, false)
        await shoot(b.page, 'library-empty', { width, theme })
        assert.deepEqual(b.errors, [])
      } finally { await b.stop() }
    })
  }
}

// down to phone width the page does not scroll sideways, every agent name is visible, and each title gets at least half the row
for (const width of [800, 600, 390]) {
  test(`(14) at ${width} px the page does not scroll sideways, every agent name is visible and titles keep half the row`, { skip }, async () => {
    const b = await withBoard({ bytes: BYTES, width, chromium: gate.chromium })
    try {
      await go(b.page, '#/sessions', '.lrow'); await b.page.waitForLoadState('networkidle')
      const l = await layout(b.page)
      assert.equal(l.hscroll, false); assert.equal(l.hiddenNames, 0)
      const narrow = await b.page.evaluate(() => [...document.querySelectorAll('.lrow')]
        .filter((r) => r.querySelector('.lt').getBoundingClientRect().width < r.getBoundingClientRect().width / 2).length)
      assert.equal(narrow, 0)
    } finally { await b.stop() }
  })
}

test('(13) keys: ↑/↓ move the highlight, / focuses search, nothing fires while typing, Enter opens the replay, Back lands on that row', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  const { page } = b
  const sel = () => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('sel'))
  try {
    await go(page, '#/sessions', '.lrow')
    await page.locator('#libhead').getByRole('heading').click(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
    // the URL follows the highlight within the writer's gap (1.2 §路由: the last value lands), not in the same task
    await page.waitForFunction(() => { const r = document.querySelector('.lrow.sel'); return !!r && new URLSearchParams(location.hash.split('?')[1] || '').get('sel') === r.dataset.key })
    const moved = await sel()
    await page.keyboard.press('/')
    assert.equal(await page.getByRole('searchbox', { name: 'Search sessions' }).evaluate((e) => e === document.activeElement), true)
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    assert.equal(await sel(), moved); assert.match(await page.evaluate(() => location.hash), /^#\/sessions/)
    await page.locator('#libhead').getByRole('heading').click(); await page.keyboard.press('Enter')
    await page.waitForFunction(() => location.hash.startsWith('#/replay/'))
    // Back returns to the opened row: highlighted and inside the list's box (1.8 #13)
    await page.goBack()
    await page.waitForFunction((k) => { const r = document.querySelector(`.lrow[data-key="${CSS.escape(k)}"]`); return !!r && r.getAttribute('aria-current') === 'true' }, moved, { timeout: 15000 })
    const box = await page.evaluate((k) => {
      const r = document.querySelector(`.lrow[data-key="${CSS.escape(k)}"]`).getBoundingClientRect(), l = document.querySelector('#liblist').getBoundingClientRect()
      return r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5 && r.left >= l.left - 0.5 && r.right <= l.right + 0.5
    }, moved)
    assert.equal(box, true, 'the opened row is inside the list')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('(9)(10) a failed read keeps the old list with Retry and its reason out of sight; with no list the empty state has Retry; status is read once', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  const { page } = b
  const TOKEN = `reason-${process.pid}-${Date.now()}` // the server's `error` (1.5 K-29: only in the collapsed technical details)
  const fail = (r) => r.fulfill({ status: 500, json: { error: TOKEN } })
  const visible = () => page.locator('#content').innerText()
  try {
    // no list yet: the failed read is the whole page, with Retry and without the reason in sight (1.8 #9)
    await page.route('**/api/sessions?**', fail)
    await go(page, '#/sessions', '.libempty')
    await page.locator('.libempty').getByRole('button', { name: 'Retry' }).waitFor({ timeout: 10000 })
    assert.ok(!(await visible()).includes(TOKEN), 'the reason is not in the visible text')
    await page.unroute('**/api/sessions?**')
    await page.locator('.libempty').getByRole('button', { name: 'Retry' }).click()
    await page.waitForSelector('.lrow', { timeout: 15000 })
    // a list on screen: a failed re-read keeps it, says so in the caption with Retry, the reason still out of sight
    await page.route('**/api/sessions?**', fail)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))) // coming back to a visible page reads at once
    await page.locator('#libcap').getByRole('button', { name: 'Retry' }).waitFor({ timeout: 10000 })
    assert.ok(await page.locator('.lrow').count() > 0, 'the old list stays')
    assert.ok(!(await visible()).includes(TOKEN), 'the reason is not in the visible text')
    await page.unroute('**/api/sessions?**')
    await page.route('**/api/sessions?**', (r) => r.fulfill({ json: EMPTY }))
    await go(page, '#/settings/appearance', '[data-theme-choice]'); await page.waitForLoadState('networkidle') // a screen that reads no status
    const from = b.requests.length
    await go(page, '#/sessions', '.libempty a[href="#/capture"]')
    await page.waitForTimeout(INTERVAL.sessions + 1000) // one more `sessions` poll: the empty state does not re-read status with it
    const urls = b.requests.slice(from).map((r) => r.url.split('?')[0])
    assert.equal(urls.filter((u) => u === '/api/status').length, 1, String(urls))
  } finally { await b.stop() }
})
