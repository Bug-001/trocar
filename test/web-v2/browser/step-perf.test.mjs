// test/web-v2/browser/step-perf.test.mjs — a step change on the replay desk (D64② · 1.2 §键盘 · 1.5 K-18), on the real face in
// the real Chrome: a step change sends no request, the step bar and the brush show a focus ring, a step outside the loaded page
// paints its head at once and the honest "not on this page" state, and the ms are printed against BOARD_LINES (never asserted,
// D64⑥: acceptance numbers come from the test machines, not this one). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, stats } from './harness.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 5e6
// gen-dataset sizes its long sessions from the budget (about √(bytes · 0.08 / 3500) turns): 5 MB gives 11 calls, all on one page;
// 200 MB gives sessions past the desk's 60-call page, so the first step of one is paged out
const PAGED_BYTES = 2e8
const samples = { stepClick: [], stepKey: [], largeStep: [] }

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

test('K-18: Home onto a step outside the loaded page paints step 1 in one frame and "load this step", and fetches only when asked', { skip }, async () => {
  const b = await withBoard({ bytes: PAGED_BYTES, chromium: gate.chromium })
  try {
    const list = (await b.get('sessions')).doc.sessions
    const longest = [...list].sort((x, y) => y.calls - x.calls)[0]
    // the face's own session document says its first step is outside the tail page the desk opens on
    const tail = (await b.get('session', { id: longest.session_id, after: Math.max(0, longest.calls - 60), limit: 60 })).doc
    const main = (tail.analyzed.lanes || []).find((l) => l.kind === 'main')
    assert.ok(main && main.calls.length > 1 && main.calls[0].paged_out, `${longest.session_id}: its first step is paged out on the tail page`)
    await openSession(b.page, longest.session_id)

    // largest step: the tail step carries the whole grown context; bounce onto it 20 times from its neighbour
    for (let i = 0; i < 20; i++) {
      const last = await b.page.textContent('#stepbar .sb-no')
      await b.page.keyboard.press('ArrowLeft')
      await b.page.waitForFunction((t) => document.querySelector('#stepbar .sb-no').textContent !== t && !document.querySelector('#ctxwin .cwload'), last)
      const prev = await b.page.textContent('#stepbar .sb-no')
      samples.largeStep.push(await timed(b.page, prev, () => b.page.keyboard.press('End')))
    }
    await b.page.waitForTimeout(300)

    const t0 = Date.now()
    const inOneFrame = await b.page.evaluate(() => new Promise((resolve) => {
      // our rAF is queued before the desk's (capture phase); the frame after both is the first one painted after the key
      addEventListener('keydown', () => requestAnimationFrame(() => setTimeout(() => resolve(document.querySelector('#stepbar .sb-no').textContent), 0)), { capture: true, once: true })
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    }))
    assert.match(inOneFrame, /^\D*1\s*\//, 'the step head reads step 1 in the first painted frame')
    assert.ok(await b.page.locator('#ctxwin #loadpage').count(), 'the window shows its load-this-step control')
    assert.ok((await b.page.textContent('#ctxwin')).trim().length > 0, 'never an empty window')
    await b.page.waitForTimeout(2000) // past the desk's 1.5 s timer: a fetch the step change caused would have answered
    assert.deepEqual(since(b, t0).filter((u) => /^\/api\/session\?/.test(u)), [], 'no body fetched before the control is used')
    const t1 = Date.now()
    await b.page.click('#ctxwin #loadpage')
    await b.page.waitForFunction(() => !document.querySelector('#ctxwin #loadpage'), null, { timeout: 10000 })
    assert.ok(since(b, t1).some((u) => /^\/api\/session\?/.test(u)), 'the control fetches the page that holds the step')
    assert.deepEqual(b.errors, [])
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
