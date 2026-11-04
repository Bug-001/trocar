// test/web-v2/browser/settings-shots.test.mjs — the three settings pages (1.11) in real Chrome on the real face (gen-dataset, temp HOME),
// reached by role and accessible name (the words from labels/settings.mjs). #25 / I24: at 1440 / 1280 / 1024 the 保存什么 table and the
// page do not scroll sideways, and the price template's copy button does not sit on the template text. #9 + #8 + #21 + D64③: the
// llm → log dialog opens with focus on Cancel and Esc gives focus back and sends no confirm; every settings button draws its answer
// within BOARD_LINES.button; the only write is POST /control/classes. #19: a store that throws still switches the theme and says it
// cannot be kept; a kept choice survives a reload and a new tab, System removes it. Shots: storage, prices, appearance at
// 1440 / 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot, stats, timed } from './harness.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { CLASS_NAME } from '../../../web/legacy/core/classes.mjs'
import { COPY_TEMPLATE, KEEP_NAME, LEVEL_OF, THEME_DARK, THEME_SYSTEM, WINDOWS } from '../../../web/legacy/labels/settings.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
const noSideScroll = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s), root = document.scrollingElement
  return { el: el ? el.scrollWidth - el.clientWidth : null, page: root.scrollWidth - root.clientWidth }
}, sel)

const level = (page, cls) => page.getByRole('radiogroup', { name: LEVEL_OF(CLASS_NAME[cls]) })
const themeIs = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
test('#25 / I24 no sideways scroll at 1440 / 1280 / 1024; the copy button clears the template; shots', { skip, timeout: 300_000 }, async () => {
  for (const width of [1440, 1280, 1024]) {
    for (const theme of ['light', 'dark']) {
      const b = await withBoard({ bytes: 2e6, width, theme, chromium: gate.chromium })
      try {
        await go(b.page, '#/settings/storage')
        await level(b.page, 'llm').waitFor({ timeout: 30000 })
        const s = await noSideScroll(b.page, '.scard .hscroll:has(.ctable)')
        assert.ok(s.el <= 0 && s.page <= 0, `storage ${width}: ${JSON.stringify(s)}`)
        await shoot(b.page, 'settings-storage', { width, theme })

        await go(b.page, '#/settings/prices')
        await b.page.getByRole('button', { name: COPY_TEMPLATE }).first().waitFor({ timeout: 30000 })
        const p = await noSideScroll(b.page, '.scard .hscroll')
        assert.ok(p.page <= 0, `prices ${width}: ${JSON.stringify(p)}`)
        const overlap = await b.page.evaluate(() => [...document.querySelectorAll('.tmpl')].some((t) => {
          const a = t.querySelector('.well').getBoundingClientRect(), c = t.querySelector('.copybtn').getBoundingClientRect()
          return !(a.right <= c.left || c.right <= a.left || a.bottom <= c.top || c.bottom <= a.top)
        }))
        assert.equal(overlap, false, `prices ${width}: the copy button sits on the template`)
        await shoot(b.page, 'settings-prices', { width, theme })

        await go(b.page, '#/settings/appearance')
        await b.page.getByRole('radio', { name: THEME_DARK }).waitFor({ timeout: 30000 })
        await shoot(b.page, 'settings-appearance', { width, theme })
        assert.deepEqual(b.errors, [])
      } finally { await b.stop() }
    }
  }
})

test('#9 #8 #21 D64③ the llm → log dialog: focus on Cancel, Esc gives it back, no confirm; every settings button within its line; only POST /control/classes', { skip, timeout: 180_000 }, async () => {
  const b = await withBoard({ bytes: 2e5, chromium: gate.chromium })
  const kinds = { level: [], window: [], details: [], copy: [], theme: [] }
  try {
    const { page } = b
    await go(page, '#/settings/storage')
    const llmLog = level(page, 'llm').getByRole('radio', { name: KEEP_NAME.log })
    await llmLog.waitFor({ timeout: 30000 })
    await llmLog.click()
    await page.getByRole('dialog').waitFor({ timeout: 30000 })
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.confirm), 'cancel')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.waitForFunction(() => !document.querySelector('[data-lvl="llm"][aria-busy]'))
    assert.equal(await llmLog.evaluate((el) => el === document.activeElement), true, 'focus is back on the radio that opened the dialog')
    assert.equal(b.requests.filter((r) => r.method === 'POST' && r.body && 'confirm' in JSON.parse(r.body)).length, 0)

    const telLog = level(page, 'telemetry').getByRole('radio', { name: KEEP_NAME.log })
    kinds.level.push(await timed(page, 'sel', 'tr[data-class="telemetry"] [data-receipt]', () => telLog.click()))
    const week = WINDOWS.find((w) => w.value === '7d')
    kinds.window.push(await timed(page, 'sel', `a[aria-current="true"][href*="window=${week.value}"]`,
      () => page.getByRole('link', { name: week.label }).click()))
    kinds.details.push(await timed(page, 'sel', '#smain button[aria-expanded="true"]',
      () => page.getByRole('button', { name: 'Technical details' }).first().click()))

    await go(page, '#/settings/prices')
    const copy = page.getByRole('button', { name: COPY_TEMPLATE }).first()
    await copy.waitFor({ timeout: 30000 })
    // the copy button says Copied (or Copy failed) on itself: no selector names that, so the same marks as harness timed, by its text
    await page.evaluate(() => {
      performance.clearMarks('in'); performance.clearMarks('out')
      const arm = () => { performance.mark('in'); removeEventListener('pointerdown', arm, true) }
      addEventListener('pointerdown', arm, true)
    })
    await copy.click()
    await page.waitForFunction((t) => {
      if (!performance.getEntriesByName('in').length || ![...document.querySelectorAll('.tmpl .copybtn')].some((c) => c.textContent !== t)) return false
      performance.mark('out'); return true
    }, COPY_TEMPLATE, { polling: 'raf', timeout: 10000 })
    kinds.copy.push(await page.evaluate(() => performance.measure('m', 'in', 'out').duration))

    await go(page, '#/settings/appearance')
    await page.getByRole('radio', { name: THEME_DARK }).waitFor({ timeout: 30000 })
    kinds.theme.push(await timed(page, 'sel', 'html[data-theme="dark"]', () => page.getByRole('radio', { name: THEME_DARK }).click()))

    const all = Object.values(kinds).flat()
    for (const [k, v] of Object.entries({ ...kinds, 'settings button': all })) {
      const { p50, p95 } = stats(v)
      console.log(`# D64 ${k}: n=${v.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.button} ms ${p95 <= BOARD_LINES.button ? 'within' : 'OVER'}`)
    }
    assert.ok(all.every((ms) => ms <= BOARD_LINES.button), `a settings button over ${BOARD_LINES.button} ms: ${JSON.stringify(kinds)}`)
    const writes = new Set(b.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${new URL(r.url, 'http://x').pathname}`))
    assert.deepEqual([...writes], ['POST /control/classes'])
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('#19 a store that throws still switches the theme and says so; a kept choice survives a reload and a new tab; System removes it', { skip, timeout: 120_000 }, async () => {
  const dark = (page) => page.getByRole('radio', { name: THEME_DARK })
  const b0 = await withBoard({ bytes: 0, chromium: gate.chromium })
  try {
    await b0.page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('blocked') }; Storage.prototype.removeItem = () => { throw new Error('blocked') } })
    await go(b0.page, '#/settings/appearance')
    await dark(b0.page).click({ timeout: 30000 })
    assert.equal(await themeIs(b0.page), 'dark')
    assert.equal(await b0.page.locator('.themewarn').isVisible(), true)
  } finally { await b0.stop() }

  const b = await withBoard({ bytes: 0, chromium: gate.chromium })
  try {
    const kept = async (page) => {
      await dark(page).waitFor({ timeout: 30000 })
      assert.equal(await themeIs(page), 'dark')
      assert.equal(await dark(page).getAttribute('aria-checked'), 'true')
    }
    await go(b.page, '#/settings/appearance')
    await dark(b.page).click({ timeout: 30000 })
    await b.page.reload({ waitUntil: 'load' })
    await kept(b.page)
    const tab = await b.page.context().newPage()
    await tab.goto(`${b.url}/#t=${encodeURIComponent(b.face.token)}`, { waitUntil: 'load' })
    await go(tab, '#/settings/appearance')
    await kept(tab)
    await tab.close()
    await b.page.getByRole('radio', { name: THEME_SYSTEM }).click()
    await b.page.reload({ waitUntil: 'load' })
    await dark(b.page).waitFor({ timeout: 30000 })
    assert.equal(await themeIs(b.page), null)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 1.2 §键盘 (layers go with their screen): the confirm opened on Storage closes when Back leaves the screen; nothing stays over the
// next screen
test('1.2 §键盘: the llm → log confirm closes when Back leaves Storage', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: 2e5, chromium: gate.chromium })
  try {
    await go(b.page, '#/settings/storage')
    const seg = '[data-lvl="llm"] [data-keep="log"]'
    await b.page.waitForSelector(seg, { timeout: 30000 })
    await b.page.click(seg)
    await b.page.waitForSelector('[role=dialog][aria-modal=true]', { timeout: 30000 })
    await b.page.goBack()
    await b.page.waitForFunction(() => !location.hash.startsWith('#/settings') && !document.querySelector('#screen .ctable'))
    assert.equal(await b.page.locator('[role=dialog][aria-modal=true]').count(), 0)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
