// test/web-v2/browser/cells.test.mjs — the Raw cell's copy contract on the real face (RFC 2.3 §两种模式): for random selections inside
// a Raw cell, ends inside and next to the inserted layout (.lay), the copied text is exactly bytes.slice(a, b), where the bytes are
// the /api/block answer for the cell's ref and a, b are the selection's ends counted over the cell's text without .lay. "Copy bytes"
// copies the whole body. Chromium (system Chrome); WebKit only when its executable is already installed (never downloaded).
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { probe, withBoard } from './harness.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const PER_CELL = 60
const CELLS = 6

let webkitSkip = skip
if (!skip) {
  try {
    const { webkit } = await import('playwright-core')
    const exe = webkit.executablePath()
    if (!exe || !fs.existsSync(exe)) webkitSkip = 'the WebKit executable is not installed (not downloaded here)'
  } catch (e) { webkitSkip = `WebKit unavailable: ${String(e?.message || e).split('\n')[0]}` }
}

async function openBusiest(b) {
  const rows = (await b.get('sessions')).doc.sessions.filter((x) => x.calls > 0)
  const r = [...rows].sort((x, y) => (y.calls || 0) - (x.calls || 0))[0]
  await b.page.evaluate((h) => { location.hash = h }, `#/replay/${encodeURIComponent(r.project_slug)}/${encodeURIComponent(r.session_id)}`)
  await b.page.waitForFunction(() => !!document.querySelector('#ctxwin') && !document.querySelector('#ctxwin .cwload'), null, { timeout: 15000 })
  await b.page.waitForLoadState('networkidle')
}

// open request rows until CELLS Raw cells with .lay spans are drawn; returns their refs
async function openLaidCells(page) {
  const laid = () => page.evaluate(() => [...document.querySelectorAll('#ctxwin .cell[data-mode="raw"][data-ref]')].filter((c) => c.querySelector('.cellraw .lay')).length)
  const tried = new Set()
  for (let k = 0; k < 60 && (await laid()) < CELLS; k++) {
    const bi = await page.evaluate((t) => [...document.querySelectorAll('#ctxwin .cblk.collapsed[data-bi]')].find((e) => e.getClientRects().length && !t.includes(e.dataset.bi))?.dataset.bi, [...tried])
    if (bi == null) break
    tried.add(bi)
    const head = page.locator(`#ctxwin .cblk[data-bi="${bi}"] > .cbh`)
    await head.click()
    await page.waitForFunction((i) => !document.querySelector(`#ctxwin .cblk[data-bi="${i}"] .cellpend`), bi, { timeout: 10000 })
  }
  return page.evaluate((k) => [...document.querySelectorAll('#ctxwin .cell[data-mode="raw"][data-ref]')].filter((c) => c.querySelector('.cellraw .lay')).slice(0, k).map((c) => c.dataset.ref), CELLS)
}

// in the page: PER_CELL random selections inside the cell's .cellraw, each copied through a ClipboardEvent carrying a DataTransfer.
// a, b are counted here from the selection's ends over the text nodes that are not inside .lay.
const randomCopies = (page, ref, n) => page.evaluate(([ref, n]) => {
  const cell = [...document.querySelectorAll('#ctxwin .cell')].find((c) => c.dataset.ref === ref)
  const pre = cell.querySelector('.cellraw')
  const texts = []
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
  let acc = 0
  for (let t; (t = w.nextNode());) { const lay = !!t.parentElement.closest('.lay'); texts.push({ t, lay, at: acc }); if (!lay) acc += t.length }
  // a point: [container, offset, a] — inside a text node (verbatim or .lay), at either edge of one next to a .lay, or between pre's children
  const pts = []
  texts.forEach(({ t, lay, at }, i) => {
    const near = lay || texts[i - 1]?.lay || texts[i + 1]?.lay
    if (lay) { pts.push([t, 0, at], [t, t.length, at], [t, (t.length >> 1), at]); return }
    if (near) pts.push([t, 0, at], [t, t.length, at + t.length])
    pts.push([t, Math.floor(Math.random() * (t.length + 1)), null])
  })
  let before = 0
  ;[...pre.childNodes].forEach((c, i) => {
    pts.push([pre, i, before])
    before += c.nodeType === 3 ? c.length : texts.filter((x) => !x.lay && c.contains(x.t)).reduce((s, x) => s + x.t.length, 0)
  })
  pts.push([pre, pre.childNodes.length, acc])
  const off = ([c, o, a]) => a != null ? a : texts.find((x) => x.t === c).at + o
  const out = []
  let touchedLay = 0
  for (let k = 0; k < n; k++) {
    let p = pts[Math.floor(Math.random() * pts.length)], q = pts[Math.floor(Math.random() * pts.length)]
    const r = document.createRange()
    r.setStart(p[0], p[1]); r.setEnd(p[0], p[1])
    if (r.comparePoint(q[0], q[1]) < 0) [p, q] = [q, p]
    r.setStart(p[0], p[1]); r.setEnd(q[0], q[1])
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
    if ([p, q].some(([c]) => c.nodeType === 3 && c.parentElement.closest('.lay'))) touchedLay++
    const dt = new DataTransfer()
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })
    p[0].nodeType === 3 ? p[0].parentElement.dispatchEvent(ev) : p[0].dispatchEvent(ev)
    out.push({ a: off(p), b: off(q), got: dt.getData('text/plain'), prevented: ev.defaultPrevented })
  }
  getSelection().removeAllRanges()
  return { out, touchedLay, shown: acc }
}, [ref, n])

async function copyCase(chromium) {
  const b = await withBoard({ chromium })
  try {
    await openBusiest(b)
    const refs = await openLaidCells(b.page)
    assert.ok(refs.length >= 1, 'a Raw cell with layout spans was opened')
    for (const ref of refs) {
      const bytes = (await b.get('block', { ref })).doc.bytes
      assert.equal(typeof bytes, 'string', `GET /api/block answered bytes for ${ref}`)
      const { out, touchedLay, shown } = await randomCopies(b.page, ref, PER_CELL)
      assert.ok(touchedLay > 0, 'some selections end inside a .lay span')
      assert.equal(bytes.slice(0, shown).length, shown, 'the drawn text is a prefix length of the bytes')
      for (const { a, b: e, got, prevented } of out) {
        assert.ok(prevented, 'the cell answered the copy')
        assert.equal(got, bytes.slice(a, e), `copy of [${a}, ${e}) in ${ref}`)
      }
      // Copy bytes: the whole body, through navigator.clipboard.writeText
      await b.page.evaluate(() => {
        window.__copied = null
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t } } })
      })
      const cell = b.page.locator(`#ctxwin .cell[data-ref="${ref.replace(/"/g, '\\"')}"]`).first()
      await cell.locator('[data-cellcopy]').click()
      await b.page.waitForFunction(() => window.__copied != null, null, { timeout: 5000 })
      assert.equal(await b.page.evaluate(() => window.__copied), bytes, `Copy bytes copies the whole body of ${ref}`)
    }
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
}

test('a Raw cell copies exactly bytes.slice(a, b) for random selections; Copy bytes copies the whole body (Chromium)', { skip }, async () => {
  await copyCase(gate.chromium)
})

test('the same copy contract in WebKit', { skip: webkitSkip }, async () => {
  const { webkit } = await import('playwright-core')
  await copyCase({ launch: () => webkit.launch() })
})

// An open cell is a ref into the bounded body cache (RFC 2.3): once its bytes are evicted, switching view and Copy bytes
// ask for them again and give exactly the stored bytes; two needs at once share one request, and nothing asks again per frame.
test('an open cell whose bytes left the cache asks once per need and gives the stored bytes again (Chromium)', { skip }, async () => {
  const b = await withBoard({ chromium: gate.chromium })
  try {
    await openBusiest(b)
    const [ref] = await openLaidCells(b.page)
    assert.ok(ref, 'a Raw cell was opened')
    const bytes = (await b.get('block', { ref })).doc.bytes
    const asks = () => b.requests.filter((r) => r.url.startsWith('/api/block?') && new URLSearchParams(r.url.split('?')[1]).get('ref') === ref).length
    const sel = `#ctxwin .cell[data-ref="${ref.replace(/"/g, '\\"')}"]`
    const evict = () => b.page.evaluate(async (r) => (await import('/replay/cell.mjs')).bodyCache.delete(r), ref)
    const frames = () => b.page.evaluate(() => new Promise((r) => { let n = 30; const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f) }))
    await b.page.evaluate(() => {
      window.__copied = null
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t } } })
    })
    const shownText = () => b.page.evaluate((s) => { const c = document.querySelector(s), w = document.createTreeWalker(c.querySelector('.cellraw'), NodeFilter.SHOW_TEXT); let t = ''; for (let n; (n = w.nextNode());) if (!n.parentElement.closest('.lay')) t += n.data; return { t, shown: +c.dataset.shown } }, sel)

    // a view switch after eviction: one request, the Readable cell over the whole stored body
    let before = asks()
    assert.equal(await evict(), true, 'the bytes were in the cache')
    await b.page.locator(`${sel} [data-cellmode="read"]`).first().click()
    await b.page.waitForSelector(`${sel}[data-mode="read"]`, { timeout: 10000 })
    await frames()
    assert.equal(asks() - before, 1, 'one request for the switch')
    assert.equal(Number(await b.page.locator(sel).first().getAttribute('data-chars')), bytes.length)

    // a switch back and Copy bytes in the same task after eviction: one request between them, Raw shows a prefix of the bytes, Copy gives all
    before = asks()
    await evict()
    await b.page.evaluate((s) => { const c = document.querySelector(s); c.querySelector('[data-cellmode="raw"]').click(); c.querySelector('[data-cellcopy]').click() }, sel)
    await b.page.waitForSelector(`${sel}[data-mode="raw"]`, { timeout: 10000 })
    await b.page.waitForFunction(() => window.__copied != null, null, { timeout: 10000 })
    await frames()
    assert.equal(asks() - before, 1, 'two needs at once share one request')
    assert.equal(await b.page.evaluate(() => window.__copied), bytes, 'Copy bytes gives exactly the stored bytes')
    const { t, shown } = await shownText()
    assert.equal(t, bytes.slice(0, shown), 'Raw shows the stored bytes again')

    // Copy alone after eviction: one request, the stored bytes; then nothing more while frames pass
    before = asks()
    await b.page.evaluate(() => { window.__copied = null })
    await evict()
    await b.page.locator(`${sel} [data-cellcopy]`).first().click()
    await b.page.waitForFunction(() => window.__copied != null, null, { timeout: 10000 })
    await frames()
    assert.equal(asks() - before, 1, 'one request for the copy')
    assert.equal(await b.page.evaluate(() => window.__copied), bytes)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
