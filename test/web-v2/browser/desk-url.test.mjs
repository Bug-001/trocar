// test/web-v2/browser/desk-url.test.mjs — 1.2 §路由 #13 on the mounted desk: the URL reproduces what the reader sees, the follow chip
// included. A following desk's URL names no step, so a reload of it on a grown session lands on the newest step, still following; a
// URL naming a step pins it with 跟随最新 off, even the newest; a lone step change is in the URL before a reload can start. The session
// reads are answered from desk-world (3.5 §会话读's reference server). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { WRITE_GAP_MS } from '../../../src/web/v2/core/router.mjs'

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
    // the chip turns following off: the drawn step is in the URL in the same task (1.2 §路由: a lone change), on the chip's path too
    const off = await page.evaluate(() => {
      document.querySelector('.sh-follow').click()
      return { follow: document.querySelector('.sh-follow').getAttribute('aria-pressed'), step: new URLSearchParams(location.hash.split('?')[1] || '').get('step') }
    })
    assert.deepEqual(off, { follow: 'false', step: String(m1) })
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
