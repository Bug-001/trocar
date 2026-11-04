// test/web-v2/browser/cell-head.test.mjs — 2.3 #38 on the real virtual list: an open row's head holds the cell's controls (the preview gone: Window.test.tsx).
// Reading a block far longer than the window, the controls stay in the visible box, clear of the sticky section header,
// and the body's text never shows through them; a click flips the cell and leaves the row open; at 600 px and narrower they take a line
// of their own; a cell with only Raw has no switch. Chromium (system Chrome); WebKit only when its executable is already installed.
// Runs only under `npm run test:browser -- --desk-next`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DESK_NEXT, probe, serveWorld, webkitGate, withBoard } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? DESK_NEXT ? false : "the new desk's row head" : gate.reason
const webkitSkip = await webkitGate(skip)
const LONG = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of a block far longer than the window it is read in.`).join('\n\n')

const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

// every block answers LONG; once `only.raw` is set, without a view
async function board(chromium, opts) {
  const only = { raw: false }, b = await withBoard({ bytes: 1e5, chromium, ...opts })
  await serveWorld(b.page, world(11, { calls: 12, page: 12 }))
  await b.page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 2, command: 'block', ok: true, errors: [],
    blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: LONG, encoding: 'utf8', fidelity: 'verbatim', truncated: false,
      ...(only.raw ? null : { view: { r: { as: 'markdown', f: { body: ['text'] } }, body: { text: LONG } } }) })) }) }))
  await b.page.evaluate(() => { location.hash = '#/replay/p/S' })
  await b.page.waitForSelector('#ctxwin .cblk.collapsed[data-bi]')
  return { b, only }
}

// the first closed row in view, opened and drawn: its data-bi
async function openRow(page) {
  const bi = await page.evaluate(() => {
    const box = document.querySelector('#ctxwin').getBoundingClientRect()
    return [...document.querySelectorAll('#ctxwin .cblk.collapsed[data-bi]')].find((e) => e.getBoundingClientRect().top >= box.top).dataset.bi
  })
  await page.click(`#ctxwin .cblk[data-bi="${bi}"] > .cbh`)
  await page.waitForSelector(`#ctxwin .cblk[data-bi="${bi}"]:not(.collapsed) .cell`)
  return bi
}

async function headCase(chromium) {
  const { b, only } = await board(chromium, { height: 700 })
  const { page } = b
  try {
    const bi = await openRow(page)
    const row = `#ctxwin .cblk[data-bi="${bi}"]`
    assert.deepEqual(await page.locator(`${row} > .cbh [data-cellmode]`).evaluateAll((x) => x.map((e) => e.dataset.cellmode).sort()), ['raw', 'read'], 'the open head holds the switch')
    const first = await page.evaluate((row) => {
      const r = document.createRange(); r.selectNodeContents(document.querySelector(`${row} .cellread`))
      return { text: r.getClientRects()[0].top, head: document.querySelector(`${row} > .cbh`).getBoundingClientRect().bottom }
    }, row)
    assert.ok(first.text >= first.head, `the body starts below the head: ${first.text} / ${first.head}`)

    // the middle of the block
    await page.evaluate((row) => {
      const W = document.querySelector('#ctxwin'), r = document.querySelector(row).getBoundingClientRect()
      W.scrollTop += r.top - W.getBoundingClientRect().top + r.height / 2
    }, row)
    await page.waitForFunction(() => !!document.querySelector('#ctxwin .cwstick'))
    await page.waitForTimeout(200)
    const mid = await page.evaluate((row) => {
      const W = document.querySelector('#ctxwin'), box = W.getBoundingClientRect(), el = document.querySelector(row), head = el.querySelector(':scope > .cbh')
      const btns = [...head.querySelectorAll('[data-cellmode]')], rect = (e) => { const { left, right, top, bottom } = e.getBoundingClientRect(); return { left, right, top, bottom } }
      const inset = (r) => [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]]
      return { box: { left: box.left, right: box.right, top: box.top + W.clientTop, bottom: box.top + W.clientTop + W.clientHeight }, row: rect(el), stick: rect(document.querySelector('#ctxwin .cwstick')),
        btns: btns.map(rect), onTop: btns.every((x) => inset(x.getBoundingClientRect()).every(([a, c]) => x.contains(document.elementFromPoint(a, c)))), background: getComputedStyle(head).backgroundColor }
    }, row)
    assert.ok(mid.row.top < mid.box.top && mid.row.bottom > mid.box.bottom, 'the row runs past both ends of the box')
    assert.equal(mid.btns.length, 2)
    for (const r of mid.btns) {
      assert.ok(r.top >= mid.box.top && r.bottom <= mid.box.bottom && r.left >= mid.box.left && r.right <= mid.box.right, `a control in the visible box: ${JSON.stringify(r)} in ${JSON.stringify(mid.box)}`)
      assert.ok(!hit(r, mid.stick), `a control clear of the section header: ${JSON.stringify(r)} / ${JSON.stringify(mid.stick)}`)
    }
    // text scrolling under the head is hidden by it: the controls are what is hit, over a background nothing shows through
    assert.ok(mid.onTop, 'the controls are on top of the body')
    assert.doesNotMatch(mid.background, /transparent|rgba\([^)]*, 0(\.\d+)?\)/, 'the head is opaque')

    await page.click(`${row} > .cbh [data-cellmode="raw"]`)
    await page.waitForSelector(`${row} .cell[data-mode="raw"]`)
    assert.equal(await page.locator(`${row}.collapsed`).count(), 0, 'the row stays open')

    // a cell with only Raw
    await page.evaluate(() => { document.querySelector('#ctxwin').scrollTop = 0 })
    await page.waitForTimeout(200)
    only.raw = true
    const raw = `#ctxwin .cblk[data-bi="${await openRow(page)}"]`
    assert.equal(await page.locator(`${raw} .cell`).getAttribute('data-only'), 'raw')
    assert.equal(await page.locator(`${raw} [data-cellmode]`).count(), 0, 'no switch on a cell with one mode')

    // at 600 px and narrower the controls take a line of their own
    await page.setViewportSize({ width: 560, height: 700 })
    await page.waitForTimeout(200)
    const narrow = await page.evaluate((row) => {
      const head = document.querySelector(`${row} > .cbh`)
      return { tog: head.querySelector('.cbtog').getBoundingClientRect().bottom, bar: head.querySelector('.cellbar').getBoundingClientRect().top }
    }, raw)
    assert.ok(narrow.bar >= narrow.tog, `the controls are on the head's second line: ${JSON.stringify(narrow)}`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
}

test('2.3 #38: an open head holds the controls, in view and clear of the header in the middle of a long block; a click leaves the row open (Chromium)', { skip }, async () => {
  await headCase(gate.chromium)
})

test('2.3 #38 in WebKit', { skip: webkitSkip }, async () => {
  const { webkit } = await import('playwright-core')
  await headCase({ launch: () => webkit.launch() })
})
