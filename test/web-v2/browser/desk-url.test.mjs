// test/web-v2/browser/desk-url.test.mjs — 1.2 §路由 #13 on the mounted desk: the URL reproduces what the reader sees, the follow chip
// included. A following desk's URL names no step, so a reload of it on a grown session lands on the newest step, still following; a
// URL naming a step pins it with 跟随最新 off, even the newest; a lone step change is in the URL before a reload can start. The session
// reads are answered from desk-world (3.5 §会话读's reference server). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { WRITE_GAP_MS } from '../../../web/legacy/core/router.mjs'
import { compareStep } from '../../../src/view/step-order.mjs'
import { CALL_NOT_HERE } from '../../../web/legacy/labels/replay.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

const w = world(5, { calls: 40 })
const last = w.marks.length - 1
const mainAt = (k) => w.full(w.marks[k]).lanes.find((l) => l.kind === 'main').count
// what the reader sees: the step bar's two numbers, the follow chip, the URL's step
const view = (page) => page.evaluate(() => {
  const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
  return { n: x ? +x[1] : null, m: x ? +x[2] : null, follow: document.querySelector('.sh-follow')?.getAttribute('aria-pressed') ?? null,
    step: new URLSearchParams(location.hash.split('?')[1] || '').get('step') }
})
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000, polling: 'raf' })
const bar = (page, n, m) => until(page, ([a, b]) => {
  const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
  return !!x && +x[1] === a && (b == null || +x[2] === b) && !!document.querySelector('.sh-follow')
}, [n, m])

async function desk(opts) {
  const b = await withBoard({ bytes: 1e5, width: 1280, chromium: gate.chromium })
  const growth = await serveWorld(b.page, w, opts)
  await b.page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
  return { b, growth }
}

test('1.2 #13 a following desk reloaded on a grown session lands on the newest step, still following, and its URL names no step', { skip }, async () => {
  let from = last - 1
  while (from > 0 && mainAt(from) === mainAt(last)) from--
  const m0 = mainAt(from), m1 = mainAt(last)
  assert.ok(m1 > m0, 'the world grows the main lane')
  const { b, growth } = await desk({ from, grow: last - from })
  try {
    const { page } = b
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await until(page, () => document.querySelector('.sh-follow')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('#stepbar .sb-no'))
    await bar(page, m1, m1) // the next poll grew the session
    await page.reload({ waitUntil: 'load' })
    await bar(page, m1, m1)
    assert.equal(growth.left(), 0)
    const v = await view(page)
    assert.deepEqual(v, { n: m1, m: m1, follow: 'true', step: null })
    // the chip turns following off: the drawn step is in the URL in the same task (1.2 §路由: a lone change), on the chip's path too;
    // the chip itself is drawn by the next frame (the React desk paints on its commit)
    const step = await page.evaluate(() => {
      document.querySelector('.sh-follow').click()
      return new URLSearchParams(location.hash.split('?')[1] || '').get('step')
    })
    assert.equal(step, String(m1))
    await until(page, () => document.querySelector('.sh-follow')?.getAttribute('aria-pressed') === 'false')
  } finally { await b.stop() }
})

test('1.2 #13 a lone step change is in the URL before a reload; a URL naming the newest step opens with follow off', { skip }, async () => {
  const M = mainAt(last), K = Math.ceil(M / 2)
  const { b } = await desk({ from: last })
  try {
    const { page } = b
    await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}` }, K)
    await bar(page, K, M)
    assert.equal((await view(page)).follow, 'false')
    await page.waitForTimeout(WRITE_GAP_MS * 2)
    await page.keyboard.press('ArrowLeft')
    await bar(page, K - 1, M)
    await page.reload({ waitUntil: 'load' })
    await bar(page, K - 1, M)
    assert.deepEqual(await view(page), { n: K - 1, m: M, follow: 'false', step: String(K - 1) })

    await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}`; location.reload() }, M)
    await bar(page, M, M)
    assert.deepEqual(await view(page), { n: M, m: M, follow: 'false', step: String(M) })
  } finally { await b.stop() }
})

// 1.2 §路由 `call=<record id>` (#13 「`call=` 的三种情况」): the skeleton row whose rid it names. The expected steps come from the world's
// rows in step order (3.5 §会话读); a small pack size puts the early steps in sealed packs, read after the tails.
const rows = w.full(w.marks[last]).calls.slice().sort((a, b) => compareStep(a.ts, a.rid, b.ts, b.rid))
const mainKey = w.full(w.marks[last]).lanes.find((l) => l.kind === 'main').lane
const mains = rows.filter((r) => r.lane === mainKey), M0 = mains.length
const nearest = (ts) => { let b = 0; mains.forEach((r, i) => { if (Math.abs(Date.parse(r.ts) - Date.parse(ts)) < Math.abs(Date.parse(mains[b].ts) - Date.parse(ts))) b = i }); return b }
const urlOf = (page) => page.evaluate(() => Object.fromEntries(['step', 'call'].map((k) => [k, new URLSearchParams(location.hash.split('?')[1] || '').get(k)])))

test('1.2 #13 call= of the main lane lands on its step with follow off, from a following desk and on a reload; the URL keeps it until follow is turned on', { skip }, async () => {
  const K = Math.ceil(M0 / 2), rid = mains[K - 1].rid
  const { b } = await desk({ from: last, pack: 2 })
  try {
    const { page } = b
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await bar(page, M0, M0)
    await page.evaluate((r) => { location.hash = `#/replay/p/S?call=${encodeURIComponent(r)}` }, rid)
    await bar(page, K, M0)
    assert.equal((await view(page)).follow, 'false')
    await page.waitForTimeout(WRITE_GAP_MS * 2)
    assert.deepEqual(await urlOf(page), { step: null, call: rid })
    await page.reload({ waitUntil: 'load' })
    await bar(page, K, M0)
    await page.waitForTimeout(WRITE_GAP_MS * 2)
    assert.equal((await view(page)).follow, 'false')
    assert.deepEqual(await urlOf(page), { step: null, call: rid })
    await page.evaluate(() => document.querySelector('.sh-follow').click())
    await bar(page, M0, M0)
    assert.deepEqual(await urlOf(page), { step: null, call: null })
  } finally { await b.stop() }
})

test('1.2 #13 call= of another lane lands on the main step nearest in time, follow off, the call open in the drawer; a reload does the same', { skip }, async () => {
  const c = rows.filter((r) => r.lane !== mainKey)[1], n = nearest(c.ts) + 1, kind = w.full(w.marks[last]).lanes.find((l) => l.lane === c.lane).kind
  const { b } = await desk({ from: last, pack: 2 })
  try {
    const { page } = b
    const drawer = () => until(page, ([k, back]) => {
      const d = document.querySelector('#detail.open')
      return !!d && d.classList.contains('k-' + k) && d.querySelector('.dback')?.dataset.back === back
    }, [kind, mains[n - 1].rid])
    await page.evaluate((r) => { location.hash = `#/replay/p/S?call=${encodeURIComponent(r)}` }, c.rid)
    await bar(page, n, M0)
    await drawer()
    assert.equal((await view(page)).follow, 'false')
    await page.waitForTimeout(WRITE_GAP_MS * 2)
    assert.deepEqual(await urlOf(page), { step: null, call: c.rid })
    await page.reload({ waitUntil: 'load' })
    await bar(page, n, M0)
    await drawer()
    assert.deepEqual(await urlOf(page), { step: null, call: c.rid })
  } finally { await b.stop() }
})

test('1.2 #13 call= naming no row of the session lands on step 1 with the note, and only after every pack has been read', { skip }, async () => {
  const { b } = await desk({ from: last, pack: 2, latency: 50 })
  try {
    const { page } = b
    let packEnd = 0
    page.on('requestfinished', (req) => { if (/\/api\/d\/p\d+\./.test(req.url())) packEnd = Date.now() })
    await page.evaluate((note) => {
      window.__noteAt = null
      new MutationObserver(() => { if (window.__noteAt == null && [...document.querySelectorAll('.toast')].some((e) => e.textContent === note)) window.__noteAt = Date.now() })
        .observe(document.body, { childList: true, subtree: true })
      location.hash = '#/replay/p/S?call=no-such-call'
    }, CALL_NOT_HERE)
    await bar(page, 1, M0)
    await until(page, () => window.__noteAt != null)
    assert.ok(packEnd > 0, 'the session came in packs')
    assert.ok(await page.evaluate(() => window.__noteAt) >= packEnd, 'the note waits for the last pack')
    assert.equal((await view(page)).follow, 'false')
  } finally { await b.stop() }
})
