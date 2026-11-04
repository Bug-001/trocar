// test/web-v2/browser/library-shots.test.mjs — the session library in real Chrome on the real face (1.8 §验收 7, 9, 10, 13, 14):
// the page fits 800 px with every agent name visible, one window control (the page head's), no number in the head or tool row,
// truncated cells titled; the keys; a failed read keeps the old list; the empty state reads /api/status once while the list polls.
// Shots: the library and its empty variant at 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot } from './harness.mjs'
import { INTERVAL } from '../../../web/legacy/core/poll.mjs'
import { UNTITLED, TITLE_PENDING } from '../../../web/legacy/labels/common.mjs'

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
// a session's title comes from the usage sidecar, which the query worker fills after the first `sessions` answer (3.5 §谁执行它
// `later`): the first answer of a fresh home has every title pending (title_source 'pending', 4.4 §人类标题的来源) and the library
// polls again only after INTERVAL.sessions. The rows are checked and shot once the face has no pending title (≤ 10 s), then remounted.
async function settledTitles(b) {
  const pending = async () => ((await b.get('sessions', {})).doc?.sessions || []).some((x) => x.title_source === 'pending')
  for (const t0 = Date.now(); (await pending()) && Date.now() - t0 < 10000;) await new Promise((r) => setTimeout(r, 250))
  await remount(b.page, '.lrow'); await b.page.waitForLoadState('networkidle')
}

// 1.8 §标题规则 / acceptance 2: a title not known yet (the sidecar not filled) is said as pending and drawn as such, never as untitled
test("1.8 §标题规则 the library's first answer draws its pending titles as not read yet, never untitled; the filled answer has every title", { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1280, chromium: gate.chromium })
  try {
    const first = b.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions', { timeout: 15000 })
    await go(b.page, '#/sessions', '.lrow')
    const firstRows = (await (await first).json()).sessions || []
    const drawn = await b.page.$$eval('.lrow .lt', (els, [u, p]) => ({ untitled: els.filter((e) => e.textContent === u).length,
      pending: els.filter((e) => e.textContent === p).length }), [UNTITLED, TITLE_PENDING])
    const pend = firstRows.filter((x) => x.title_source === 'pending').length
    assert.ok(pend > 0, 'a fresh home\'s first answer has titles not known yet')
    assert.deepEqual(firstRows.filter((x) => x.title == null && x.title_source !== 'pending').map((x) => x.session_id), [], 'no first-answer row says "no title"')
    assert.deepEqual(drawn, { untitled: 0, pending: pend }, 'rows drawn from the first answer: pending titles as not read yet, none untitled')
    await settledTitles(b)
    assert.deepEqual(((await b.get('sessions', {})).doc?.sessions || []).filter((x) => x.title == null), [], 'every session of this home has a title once the sidecar is filled')
    const filled = await b.page.$$eval('.lrow .lt', (els, [u, p]) => els.filter((e) => e.textContent === u || e.textContent === p).length, [UNTITLED, TITLE_PENDING])
    assert.equal(filled, 0, 'rows drawn from the filled answer show their titles')
  } finally { await b.stop() }
})

const layout = (page) => page.evaluate(() => {
  const txt = (e) => (e ? e.textContent : '')
  const head = document.querySelector('#libhead'), ra = head && head.querySelector('.readat')
  return {
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > innerWidth,
    untitled: [...document.querySelectorAll('#content *')].filter((e) => e.getClientRects().length && getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 0.5 && !e.closest('[title]'))
      .map((e) => `${e.className}: ${e.textContent.slice(0, 40)}`),
    segs: document.querySelectorAll('#content .seg').length,
    segInHead: document.querySelectorAll('#libhead .seg').length,
    // the head's words besides its read-at time and the window control's own options; the tool row as drawn (menus closed)
    headText: txt(head).replace(txt(ra), '').replace(txt(head && head.querySelector('.seg')), ''),
    toolText: document.querySelector('.libtools').innerText,
    hiddenNames: [...document.querySelectorAll('.lrow .lhn')].filter((e) => !e.getClientRects().length || e.getBoundingClientRect().width < 1).length,
  }
})

for (const width of [1280, 1024]) {
  for (const theme of ['light', 'dark']) {
    test(`(7)(14) the library and its empty state at ${width} in ${theme}: one window control, no head numbers, titled truncation`, { skip }, async () => {
      const b = await withBoard({ bytes: BYTES, width, theme, chromium: gate.chromium })
      try {
        await go(b.page, '#/sessions', '.lrow'); await settledTitles(b)
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

test('(14) at 800 px the page does not scroll sideways and every agent name is visible', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 800, chromium: gate.chromium })
  try {
    await go(b.page, '#/sessions', '.lrow'); await b.page.waitForLoadState('networkidle')
    const l = await layout(b.page)
    assert.equal(l.hscroll, false); assert.equal(l.hiddenNames, 0)
  } finally { await b.stop() }
})

test('(13) keys: ↑/↓ move the highlight, / focuses search, nothing fires while typing, Enter opens the replay', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  const { page } = b
  const sel = () => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('sel'))
  try {
    await go(page, '#/sessions', '.lrow')
    await page.click('#content .pagehead'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
    // the URL follows the highlight within the writer's gap (1.2 §路由: the last value lands), not in the same task
    await page.waitForFunction(() => { const r = document.querySelector('.lrow.sel'); return !!r && new URLSearchParams(location.hash.split('?')[1] || '').get('sel') === r.dataset.key })
    const moved = await sel()
    await page.keyboard.press('/')
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'libq')
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    assert.equal(await sel(), moved); assert.match(await page.evaluate(() => location.hash), /^#\/sessions/)
    await page.click('#content .pagehead'); await page.keyboard.press('Enter')
    await page.waitForFunction(() => location.hash.startsWith('#/replay/'))
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('(9)(10) a failed read keeps the old list with retry; the empty state reads /api/status once while sessions polls', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  const { page } = b
  try {
    await go(page, '#/sessions', '.lrow')
    await page.route('**/api/sessions?**', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))) // coming back to a visible page reads at once
    await page.waitForSelector('#libcap [data-act="retry"]', { timeout: 10000 })
    assert.ok(await page.locator('.lrow').count() > 0, 'the old list stays')
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
