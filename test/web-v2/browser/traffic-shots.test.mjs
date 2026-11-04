// test/web-v2/browser/traffic-shots.test.mjs — 流量, the host page and the request detail (1.10) in real Chrome on the real face
// (gen-dataset, temp HOME). M7: with the detail open at 1280 / 1024 the list's time · endpoint · class · sent · received header boxes
// sit inside the viewport and nothing covers them (1.10 §一件事只说一处). I21: a class chip lands in ?class=. R18 / R20: no text node
// between the page head and the first table row on either page (1.2 §页头). Shots: the table, the host page and the detail open at
// 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot, layoutFaults } from './harness.mjs'
import { FILTER_CLASS } from '../../../web/legacy/labels/traffic.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
// the React markup by its roles (1.10 §组件与状态): a table row is a link to its host page; the host list is the list named
// Requests; the request detail is the complementary region named Request details
const hostLinks = (page) => page.locator('.traf').getByRole('link').and(page.locator('[href^="#/traffic/host/"]'))
const requests = (page) => page.getByRole('list', { name: 'Requests' })
const detail = (page) => page.getByRole('complementary', { name: 'Request details' })
const openRequest = async (page) => {
  await requests(page).getByRole('link').first().click()
  await detail(page).locator('.rqd').waitFor({ timeout: 30000 })
  await page.waitForTimeout(400) // the sheet's own transition
}

// text nodes after the page head and before `stop` (the caption row, the first row of the table)
const textBetween = (page, stop) => page.evaluate((sel) => {
  const head = document.querySelector('.pagehead'), end = document.querySelector(sel)
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), out = []
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (head.contains(n) || !(head.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
    if (end.contains(n) || end.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) break
    if (n.textContent.trim()) out.push(n.textContent)
  }
  return out
}, stop)

async function openPages(b) {
  await go(b.page, '#/traffic?window=all')
  await hostLinks(b.page).first().waitFor({ timeout: 30000 })
  return (await hostLinks(b.page).evaluateAll((as) => as.map((a) => a.getAttribute('href')))).find((h) => /host\/[^/]+\/[^?]*\?/.test(h))
}

test('M7 · I21 · R18 / R20: the detail never covers the list\'s five columns; class chips land in ?class=; nothing between head and table', { skip, timeout: 240_000 }, async () => {
  for (const width of [1280, 1024]) {
    const b = await withBoard({ bytes: 2e6, width, chromium: gate.chromium })
    try {
      const host = await openPages(b)
      assert.deepEqual(await textBetween(b.page, '.tcap'), [], 'traffic: head → table')
      // I21: the class menu's first item → ?class=
      await b.page.getByRole('button', { name: FILTER_CLASS, exact: true }).click() // the menu's word from its label, not a copy of it
      await b.page.getByRole('menuitem').first().click()
      await b.page.waitForFunction(() => /[?&]class=/.test(location.hash))
      await b.page.getByRole('link', { name: new RegExp(`^${FILTER_CLASS}:`) }).waitFor({ timeout: 10000 })

      await go(b.page, host)
      await requests(b.page).getByRole('link').first().waitFor({ timeout: 30000 })
      assert.deepEqual(await textBetween(b.page, '.tcap'), [], 'host page: head → table')
      await openRequest(b.page)
      const boxes = await b.page.evaluate(() => {
        const sheet = document.querySelector('#hdetail').getBoundingClientRect()
        return [...document.querySelectorAll('.hhead > span')].slice(0, 5).map((c) => {
          const r = c.getBoundingClientRect(), x = r.left + Math.min(8, r.width / 2), y = r.top + r.height / 2
          const top = document.elementFromPoint(x, y)
          return { r: [r.left, r.top, r.right, r.bottom], inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0,
            covered: !(top && c.contains(top)), underSheet: !(r.bottom <= sheet.top || r.top >= sheet.bottom || r.right <= sheet.left || r.left >= sheet.right) }
        })
      })
      assert.equal(boxes.length, 5)
      for (const x of boxes) assert.deepEqual({ inView: x.inView, covered: x.covered, underSheet: x.underSheet }, { inView: true, covered: false, underSheet: false }, `${width}: ${JSON.stringify(x.r)}`)
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
})

test('shots: the table, the host page and the detail at 1280 / 1024 × light / dark', { skip, timeout: 240_000 }, async () => {
  for (const width of [1280, 1024]) for (const theme of ['light', 'dark']) {
    const b = await withBoard({ bytes: 2e6, width, theme, chromium: gate.chromium })
    try {
      const host = await openPages(b)
      await shoot(b.page, 'traffic', { width, theme })
      await go(b.page, host)
      await requests(b.page).getByRole('link').first().waitFor({ timeout: 30000 })
      await shoot(b.page, 'traffic-host', { width, theme })
      await openRequest(b.page)
      await shoot(b.page, 'traffic-detail', { width, theme })
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
})

// 1.10 收回 · 1.5: a row whose received bytes are partly not recorded says 「≥ N」 and 「k not recorded」 inside its own cell — nothing runs into
// 主要类别 — and every agent cell carries its icon. The real answer, with each row's received side made partial (a macOS machine's shape).
test('收回 partly not recorded stays in its cell; every agent cell has its icon (1440 / 1280 / 1024)', { skip, timeout: 240_000 }, async () => {
  for (const width of [1440, 1280, 1024]) {
    const b = await withBoard({ bytes: 2e6, width, chromium: gate.chromium })
    try {
      await b.page.route((u) => new URL(u).pathname === '/api/traffic', async (r) => {
        const res = await r.fetch(), j = await res.json()
        for (const h of j.hosts || []) if ((h.requests || 0) > 1) Object.assign(h, { received_bytes: 7.4e6, received_unrecorded: h.requests - 1 })
        await r.fulfill({ response: res, json: j })
      })
      await go(b.page, '#/traffic?window=all')
      await hostLinks(b.page).locator('.c2').first().waitFor({ timeout: 30000 })
      await b.page.waitForLoadState('networkidle')
      assert.deepEqual(await layoutFaults(b.page), { overlap: [], cut: [], untitled: [], emptyIcons: [] }, `traffic ${width}`)
      await shoot(b.page, 'traffic-unrecorded', { width, theme: 'light' })
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
})

// 1.10 行高固定: the host list is a fixed-height virtual list, so each row (the class folded under the endpoint on a small screen)
// lies inside its own `.vrow` slot and its class line inside the row — no row spills into the next one's slot. 390 (folded) / 1280.
// 1.10 §窄屏: below 900 px only 收回 leaves the row (it stays in the detail); 发出 keeps its cell inside the row. 1.10 端点任何宽度都不隐藏:
// every row's endpoint has width and lies inside the row, also for the widest marks — the list page's rows made sent-not-recorded,
// log-only and failed in turn with length-only (the real answer otherwise).
test('every host row, its class line and its sent cell lie inside the row\'s fixed-height slot; received leaves a narrow row (390 / 1280)', { skip, timeout: 240_000 }, async () => {
  for (const width of [390, 1280]) {
    const b = await withBoard({ bytes: 2e6, width, chromium: gate.chromium })
    try {
      await b.page.route((u) => { const x = new URL(u); return x.pathname === '/api/calls' && x.searchParams.has('host') }, async (r) => {
        const res = await r.fetch(), j = await res.json()
        for (const [i, c] of (j.records || []).entries()) Object.assign(c, i % 2 ? { retention: 'legacy-meta' } : { sent_bytes: null, retention: 'log', error: true })
        await r.fulfill({ response: res, json: j })
      })
      const host = await openPages(b)
      await go(b.page, host)
      await requests(b.page).locator('.vrow > .hrow').first().waitFor({ timeout: 30000 })
      const out = await b.page.evaluate(() => {
        const inside = (a, b) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5
        const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
        return [...document.querySelectorAll('#hlist .vrow > .hrow')].map((a) => {
          const slot = box(a.parentElement), row = box(a), cls = box(a.querySelector('.cell.class')), sent = box(a.querySelector('.cell.sent')), end = box(a.querySelector('.cell-endpoint'))
          const shown = (e) => e.getClientRects().length > 0
          return { rowInSlot: inside(row, slot), classInRow: inside(cls, row), sentInRow: shown(a.querySelector('.cell.sent')) && inside(sent, row), recvShown: shown(a.querySelector('.cell.recv')),
            endpointShown: end.right - end.left > 0 && inside(end, row), slot, row, cls, sent, end }
        })
      })
      assert.ok(out.length > 0)
      for (const x of out) {
        assert.deepEqual({ rowInSlot: x.rowInSlot, classInRow: x.classInRow, sentInRow: x.sentInRow, recvShown: x.recvShown, endpointShown: x.endpointShown },
          { rowInSlot: true, classInRow: true, sentInRow: true, recvShown: width >= 900, endpointShown: true }, `${width}: ${JSON.stringify(x)}`)
      }
      await shoot(b.page, 'traffic-host-rows', { width, theme: 'light' })
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
})
