// test/web-v2/browser/settings-shots.test.mjs — the three settings pages (1.11) in real Chrome on the real face (gen-dataset, temp HOME).
// #25 / I24: at 1440 / 1280 / 1024 the 保存什么 table and the page do not scroll sideways, and the price template's copy button does not
// sit on the template text. #9: the llm → log dialog opens with focus on Cancel; Esc sends no confirm. #19: a store that throws still
// switches the theme and shows the cannot-store state. Shots: storage, prices, appearance at 1440 / 1280 / 1024 × light / dark.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot } from './harness.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
const noSideScroll = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s), root = document.scrollingElement
  return { el: el ? el.scrollWidth - el.clientWidth : null, page: root.scrollWidth - root.clientWidth }
}, sel)

test('#25 / I24 no sideways scroll at 1440 / 1280 / 1024; the copy button clears the template; shots', { skip, timeout: 300_000 }, async () => {
  for (const width of [1440, 1280, 1024]) {
    for (const theme of ['light', 'dark']) {
      const b = await withBoard({ bytes: 2e6, width, theme, chromium: gate.chromium })
      try {
        await go(b.page, '#/settings/storage')
        await b.page.waitForSelector('.ctable [data-lvl]', { timeout: 30000 })
        const s = await noSideScroll(b.page, '.scard .hscroll:has(.ctable)')
        assert.ok(s.el <= 0 && s.page <= 0, `storage ${width}: ${JSON.stringify(s)}`)
        await shoot(b.page, 'settings-storage', { width, theme })

        await go(b.page, '#/settings/prices')
        await b.page.waitForSelector('.tmpl .copybtn', { timeout: 30000 })
        const p = await noSideScroll(b.page, '.scard .hscroll')
        assert.ok(p.page <= 0, `prices ${width}: ${JSON.stringify(p)}`)
        const overlap = await b.page.evaluate(() => [...document.querySelectorAll('.tmpl')].some((t) => {
          const a = t.querySelector('.well').getBoundingClientRect(), c = t.querySelector('.copybtn').getBoundingClientRect()
          return !(a.right <= c.left || c.right <= a.left || a.bottom <= c.top || c.bottom <= a.top)
        }))
        assert.equal(overlap, false, `prices ${width}: the copy button sits on the template`)
        await shoot(b.page, 'settings-prices', { width, theme })

        await go(b.page, '#/settings/appearance')
        await b.page.waitForSelector('[data-theme-choice]', { timeout: 30000 })
        await shoot(b.page, 'settings-appearance', { width, theme })
        assert.deepEqual(b.errors, [])
      } finally { await b.stop() }
    }
  }
})

test('#9 the llm → log dialog opens with focus on Cancel; Esc closes it and sends no confirm', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: 2e5, chromium: gate.chromium })
  try {
    await go(b.page, '#/settings/storage')
    const seg = '[data-lvl="llm"] [data-keep="log"]'
    await b.page.waitForSelector(seg, { timeout: 30000 })
    await b.page.click(seg)
    await b.page.waitForSelector('[data-confirm-back] [role="dialog"]', { timeout: 30000 })
    assert.equal(await b.page.evaluate(() => document.activeElement && document.activeElement.dataset.confirm), 'cancel')
    await b.page.keyboard.press('Escape')
    await b.page.waitForSelector('[data-confirm-back]', { state: 'detached' })
    await b.page.waitForFunction(() => !document.querySelector('[data-lvl="llm"][aria-busy]'))
    assert.equal(b.requests.filter((r) => r.method === 'POST' && r.body && 'confirm' in JSON.parse(r.body)).length, 0)
  } finally { await b.stop() }
})

test('#19 a store that throws: the theme still switches and the cannot-store state shows', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: 0, chromium: gate.chromium })
  try {
    await b.page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('blocked') }; Storage.prototype.removeItem = () => { throw new Error('blocked') } })
    await go(b.page, '#/settings/appearance')
    await b.page.waitForSelector('[data-theme-choice="dark"]', { timeout: 30000 })
    await b.page.click('[data-theme-choice="dark"]')
    assert.equal(await b.page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark')
    assert.equal(await b.page.locator('.themewarn').isVisible(), true)
  } finally { await b.stop() }
})

// 1.2 §键盘 (layers go with their screen): the confirm opened on Storage closes when Back leaves the screen; nothing stays over the
// next screen and no confirm is sent
test('1.2 §键盘: the llm → log confirm closes when Back leaves Storage, and sends no confirm', { skip, timeout: 120_000 }, async () => {
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
    assert.equal(b.requests.filter((r) => r.method === 'POST' && r.body && 'confirm' in JSON.parse(r.body)).length, 0)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
