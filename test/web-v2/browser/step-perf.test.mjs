// test/web-v2/browser/step-perf.test.mjs — a step change on the replay desk (D64② · 1.2 §键盘), on the real face in the real
// Chrome: a step change sends no request, the step bar and the brush show a focus ring, and the ms are printed against BOARD_LINES (never asserted,
// D64⑥: acceptance numbers come from the test machines, not this one). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, stats } from './harness.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 5e6
const samples = { stepClick: [], stepKey: [] }

// the timed() pattern of screens.test.mjs: armed before the input, marks the first pointerdown / keydown, polls frames until the
// step head no longer reads `prev` and the window is drawn, lets that frame paint, then measures input → painted
async function timed(page, prev, act) {
  await page.evaluate(() => {
    performance.clearMarks('in')
    const arm = () => { performance.mark('in'); removeEventListener('pointerdown', arm, true); removeEventListener('keydown', arm, true) }
    addEventListener('pointerdown', arm, true); addEventListener('keydown', arm, true)
  })
  await act()
  return page.evaluate((a) => new Promise((resolve, reject) => {
    const q = (s) => document.querySelector(s)
    const holds = () => !!q('#stepbar .sb-no') && q('#stepbar .sb-no').textContent !== a && !q('#ctxwin .cwload')
    const t0 = performance.now()
    const tick = () => {
      if (performance.getEntriesByName('in').length && holds()) return setTimeout(() => resolve(performance.measure('m', 'in').duration), 0)
      if (performance.now() - t0 > 10000) return reject(new Error(`step not drawn in 10 s (was ${a})`))
      requestAnimationFrame(tick)
    }
    tick()
  }), prev)
}

const stepNo = async (page) => (await page.textContent('#stepbar .sb-no')).match(/(\d+)\s*\/\s*(\d+)/).slice(1).map(Number)

// open a session from the library by a real click; `id` = that session, or the first row
async function openSession(page, id) {
  await page.evaluate(() => { location.hash = '#/sessions' })
  await page.waitForSelector('.lrow')
  const all = page.locator('.pagehead a', { hasText: 'All' }).first()
  if (await all.count()) { await all.click(); await page.waitForSelector('.lrow') }
  const row = id ? page.locator(`.lrow[href*="/${encodeURIComponent(id)}"]`).first() : page.locator('.lrow').first()
  await row.click()
  await page.waitForSelector('#stepbar .sb-no')
  await page.waitForFunction(() => !document.querySelector('#ctxwin .cwload'))
  await page.waitForLoadState('networkidle')
}

// the /api requests that began at or after t0, as paths
const since = (b, t0) => b.requests.filter((r) => r.start >= t0).map((r) => r.url)

test('D64②: 20 step changes by click and 20 by ←/→ send no request', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  try {
    await openSession(b.page, null)
    const t0 = Date.now()
    for (const [kind, by] of [['stepClick', 'click'], ['stepKey', 'key']]) {
      let dir = -1
      for (let i = 0; i < 20; i++) {
        const [n, m] = await stepNo(b.page)
        if (n === 1) dir = 1
        if (n === m) dir = -1
        if (m === 1) break
        const prev = await b.page.textContent('#stepbar .sb-no')
        const act = by === 'click'
          ? () => b.page.click(`#stepbar .sbbtn[data-step="${dir < 0 ? 'prev' : 'next'}"]`)
          : () => b.page.keyboard.press(dir < 0 ? 'ArrowLeft' : 'ArrowRight')
        samples[kind].push(await timed(b.page, prev, act))
      }
    }
    // the desk's own 1.5 s timer re-reads the session list while it is open; that is not a step change, everything else is
    const during = since(b, t0).filter((u) => !/^\/api\/(sessions|pricing)\b/.test(u))
    console.log(`# requests during ${samples.stepClick.length + samples.stepKey.length} step changes (besides the timer's list): ${during.length}`)
    assert.ok(samples.stepClick.length > 0 && samples.stepKey.length > 0, 'the session has more than one step')
    assert.deepEqual(during, [])
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('1.2 §键盘: Tab reaches the step bar and the brush, and each shows an outline', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  try {
    await openSession(b.page, null)
    const seen = new Set()
    for (let i = 0; i < 200 && seen.size < 2; i++) {
      await b.page.keyboard.press('Tab')
      const hit = await b.page.evaluate(() => {
        const a = document.activeElement
        const where = a && a.closest('#stepbar') ? 'stepbar' : a && a.id === 'ovbrush' ? 'brush' : null
        return where && { where, outline: getComputedStyle(a).outlineStyle }
      })
      if (hit && !seen.has(hit.where)) { assert.notEqual(hit.outline, 'none', `${hit.where} has a focus ring`); seen.add(hit.where) }
    }
    assert.deepEqual([...seen].sort(), ['brush', 'stepbar'])
  } finally { await b.stop() }
})

// D64④⑥: p50 and p95 next to the line, printed; this run is a baseline — acceptance numbers come from the test machines, not from it (PR 6)
test.after(() => {
  for (const [k, v] of Object.entries(samples)) {
    if (!v.length) continue
    const { p50, p95 } = stats(v)
    console.log(`# D64 ${k}: n=${v.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.stepClick} ms ${p95 <= BOARD_LINES.stepClick ? 'within' : 'OVER'}`)
  }
})
