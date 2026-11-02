// test/web-v2/browser/select-toggle.test.mjs — 1.2 §点击与选中文字 (验收 #25) in real Chrome with real mouse moves: dragging to
// select text inside an expanded row, or a plain click there, never folds the row; a selection left over from before does not
// block the head; while the reader holds a selection the status poll does not redraw it away, and the next draw keeps the row
// and the Technical details the reader opened. The capture page, the capture log, and one replay-desk block head.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from './harness.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

// every /api/status answer carries one problem group whose count moves, so every poll answer differs from the last
async function setup(page) {
  let n = 0
  const now = new Date().toISOString()
  await page.route((u) => new URL(u).pathname === '/api/status', async (r) => {
    const res = await r.fetch(), j = await res.json()
    j.failures = { ...(j.failures || {}), groups: [{ level: 'problem', where: 'engine', code: 'trust-rejected', count: ++n, first_ts: now, last_ts: now, harness: 'codex', reason: 'the root was rejected by the client' }] }
    await r.fulfill({ response: res, json: j })
  })
}

// a real mouse drag across the first visible text run inside `sel` (trimmed ≥ 4 chars, not in a link or a button, ≥ 20 px wide)
async function dragSelect(page, sel, { max = 60 } = {}) {
  const box = await page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return null
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.data.trim().length < 4 || n.parentElement.closest('a, button')) continue
      const r = document.createRange(); r.selectNodeContents(n)
      const b = r.getBoundingClientRect()
      if (b.width < 20 || b.height === 0) continue
      return { left: b.left, top: b.top, w: b.width, h: b.height }
    }
    return null
  }, sel)
  assert.ok(box, `a text run to select in ${sel}`)
  const y = box.top + box.h / 2
  await page.mouse.move(box.left + 1, y)
  await page.mouse.down()
  await page.mouse.move(box.left + Math.min(max, box.w - 2), y, { steps: 5 })
  await page.mouse.up()
  return { x: box.left + 1, y }
}

const selText = (page) => page.evaluate(() => String(document.getSelection()))
const statusAnswers = (b) => b.requests.filter((r) => r.url.startsWith('/api/status')).length
async function polls(b, k) {
  const want = statusAnswers(b) + k, until = Date.now() + 15_000
  while (statusAnswers(b) < want) {
    assert.ok(Date.now() < until, `${k} fresh /api/status answers within 15 s`)
    await b.page.waitForTimeout(200)
  }
  await b.page.waitForTimeout(300) // the answer is painted
}
// head → {exp, hidden} of the row it controls; disc → open
const rowState = (page, head) => page.evaluate((head) => {
  const e = document.querySelector(head), p = document.getElementById(e.getAttribute('aria-controls'))
  return { exp: e.getAttribute('aria-expanded'), hidden: p.hasAttribute('hidden') }
}, head)
const discOpen = (page, disc) => page.evaluate((d) => { const t = document.querySelector(d); return !document.getElementById(t.getAttribute('aria-controls')).hasAttribute('hidden') }, disc)
async function openBoth(page, head, disc) {
  if ((await rowState(page, head)).exp !== 'true') await page.locator(head).first().click()
  await page.waitForSelector(disc)
  if (!(await discOpen(page, disc))) await page.locator(disc).first().click()
  assert.deepEqual(await rowState(page, head), { exp: 'true', hidden: false })
  assert.equal(await discOpen(page, disc), true)
}

test('selecting text inside an expanded row, or clicking there, leaves it open; the head still closes it', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: 3e5, chromium: gate.chromium, setup })
  try {
    const { page } = b
    // A · the capture page
    const head = '.crow [data-caprow]'
    await page.evaluate(() => { location.hash = '#/capture' })
    await page.waitForSelector(head, { timeout: 30_000 })
    const disc = '.cexp:not([hidden]) .disc-t'
    await openBoth(page, head, disc)
    const at = await dragSelect(page, '.cexp:not([hidden]) .tech')
    assert.deepEqual(await rowState(page, head), { exp: 'true', hidden: false }, 'capture: a drag-select keeps the row open')
    assert.equal(await discOpen(page, disc), true, 'capture: a drag-select keeps Technical details open')
    assert.ok((await selText(page)).trim().length > 0, 'capture: the selection stays')
    await page.mouse.click(at.x, at.y)
    assert.deepEqual(await rowState(page, head), { exp: 'true', hidden: false }, 'capture: a plain click in the expansion keeps the row open')
    await dragSelect(page, '.cexp:not([hidden]) .tech')
    assert.ok((await selText(page)).trim().length > 0)
    const hb = await page.locator(head).first().boundingBox()
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2)
    assert.equal((await rowState(page, head)).exp, 'false', 'capture: with an old selection, a click on the head closes the row')

    // B · the capture log
    const lhead = '.crows .lr:not(.h) [data-lrow]', ldisc = '.lx:not([hidden]) .disc-t'
    await page.evaluate(() => { location.hash = '#/capture/log' })
    await page.waitForSelector(lhead, { timeout: 30_000 })
    await openBoth(page, lhead, ldisc)
    const lat = await dragSelect(page, '.lx:not([hidden]) .tech')
    const picked = await selText(page)
    assert.ok(picked.trim().length > 0, 'log: the selection stays')
    assert.deepEqual(await rowState(page, lhead), { exp: 'true', hidden: false }, 'log: a drag-select keeps the row open')
    assert.equal(await discOpen(page, ldisc), true, 'log: a drag-select keeps Technical details open')
    await page.evaluate(() => { window.__held = document.querySelector('.lx:not([hidden]) .tech') })
    const stamp = () => page.evaluate(() => document.querySelector('.pagehead .readat').textContent)
    const st0 = await stamp()
    await polls(b, 2)
    assert.equal(await page.evaluate(() => window.__held.isConnected), true, 'log: the poll does not redraw the selected text away')
    assert.equal(await selText(page), picked, 'log: the selection survives the poll')
    assert.equal(await stamp(), st0, 'log: while the rows are held the read stamp keeps the time of the rows on screen')
    const cnt = () => page.evaluate(() => [...document.querySelectorAll('.lr:not(.h) .cnt')].map((n) => n.textContent).join('|'))
    const before = await cnt()
    await page.evaluate(() => document.getSelection().removeAllRanges())
    await polls(b, 1)
    assert.notEqual(await cnt(), before, 'log: with no selection the next poll draws the new answer')
    assert.deepEqual(await rowState(page, lhead), { exp: 'true', hidden: false }, 'log: the redraw keeps the row open')
    assert.equal(await discOpen(page, ldisc), true, 'log: the redraw keeps Technical details open')
    await page.mouse.click(lat.x, lat.y)
    assert.deepEqual(await rowState(page, lhead), { exp: 'true', hidden: false }, 'log: a plain click in the expansion keeps the row open')
    // a focused row head is still the focused element after a poll whose answer differs
    await page.evaluate(() => document.getSelection().removeAllRanges())
    await page.locator(lhead).first().focus()
    const fid = await page.evaluate(() => document.activeElement.getAttribute('aria-controls'))
    const c1 = await cnt()
    await polls(b, 1)
    assert.notEqual(await cnt(), c1, 'log: the poll redrew the rows')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-controls')), fid, 'log: focus returns to the same row head')

    // C · a replay-desk block head: a short drag over its label selects, a plain click on its role toggles
    await page.evaluate(() => { location.hash = '#/sessions' })
    await page.locator('a.lrow').first().click()
    const lbl = '.cblk[data-bi] > .cbh .cblabel'
    await page.waitForSelector(lbl, { timeout: 30_000 })
    const bi = await page.evaluate((s) => document.querySelector(s).closest('.cblk').dataset.bi, lbl)
    const blk = `.cblk[data-bi="${bi}"]`
    const state = () => page.evaluate((s) => { const e = document.querySelector(s); return { collapsed: e.classList.contains('collapsed'), exp: e.querySelector(':scope > .cbh').getAttribute('aria-expanded') } }, blk)
    const s0 = await state()
    await dragSelect(page, `${blk} > .cbh .cblabel`, { max: 30 })
    assert.deepEqual(await state(), s0, 'desk: a drag over a block head label does not open or close the block')
    assert.ok((await selText(page)).trim().length > 0, 'desk: the selection stays')
    await page.locator(`${blk} > .cbh .cbrole`).click()
    assert.notEqual((await state()).collapsed, s0.collapsed, 'desk: a plain click on the head still toggles')
    assert.deepEqual(b.errors, [])
  } finally { await b.page.unrouteAll({ behavior: "ignoreErrors" }); await b.stop() }
})
