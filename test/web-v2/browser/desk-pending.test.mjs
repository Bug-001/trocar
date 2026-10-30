// test/web-v2/browser/desk-pending.test.mjs — 2.3 §读与画 (归约前沿) · D64② · D69 on the mounted desk while a big session is read for the
// first time: its session reads are answered from a generated world of 30,000 calls on three lanes (desk-world.mjs) whose mark moves on
// by 1,000 members at each head read and carries `pending` until the last one, so every poll brings hundreds of rows, relanes and
// events. While it grows the reader follows, scrubs 60 steps by ←/→ and jumps by the overlay rows' ticks: no task of the page's own
// runs over I-longtask's line, and a step change's p95 is within BOARD_LINES.stepClick. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, timed, stats } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { LIMITS } from './seq/invariants.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

// installed before the board's own scripts: every long task of the page, in ms
function observeLongTasks() {
  window.__lt = []
  try { new PerformanceObserver((l) => { for (const x of l.getEntries()) window.__lt.push(x.duration) }).observe({ type: 'longtask', buffered: true }) } catch { /* no long-task timing here */ }
}

test('2.3 归约前沿 · D64②: a session growing by 1,000 members a poll — following, scrubbing and lane jumps run no long task; step p95 within the line', { skip }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.02 }) // wide chapters: the window after End holds many steps
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium, setup: (page) => page.addInitScript(observeLongTasks) })
  try {
    const { page } = b
    const growth = await serveWorld(page, w, { from: 4000, grow: 1000, pack: 512 })
    await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
    const longTasks = () => page.evaluate(() => window.__lt.splice(0))
    const step = () => page.textContent('#stepbar .sb-no')
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    const answers = async (n) => { const to = growth.left() - n * 1000; while (growth.left() > to) await page.waitForTimeout(100) }
    await answers(1)
    await longTasks() // the open is D64①'s, not this case's
    const seen = { follow: [], scrub: [], lanes: [] }, samples = []

    // following while 8 answers land
    const first = await step()
    await answers(8)
    seen.follow = await longTasks()
    assert.notEqual(await step(), first, 'the followed step moved with the growth')

    // scrubbing: 30 steps back, 30 forward
    for (let i = 0; i < 60; i++) samples.push(await timed(page, 'step', await step(), () => page.keyboard.press(i < 30 ? 'ArrowLeft' : 'ArrowRight')))
    seen.scrub = await longTasks()

    // lane jumps: from the newest step, a tick of the overlay rows in the older half of the window; a last chapter too short to hold
    // one is left by [ to the chapter before it (1.3 §章: the window is the playhead's chapter)
    const ticks = page.locator('#rails .tick[data-lane]')
    const older = () => page.evaluate(() => [...document.querySelectorAll('#rails .tick[data-lane]')].flatMap((t, i) => (parseFloat(t.style.left) < 50 ? [i] : [])))
    for (let j = 0; j < 10; j++) {
      await page.keyboard.press('End')
      let idx = await older()
      for (let k = 0; k < 20 && !idx.length; k++) { if (k % 4 === 0) await page.keyboard.press('['); await page.waitForTimeout(50); idx = await older() }
      assert.ok(idx.length, 'the overlay rows draw ticks in the older half of the window')
      samples.push(await timed(page, 'step', await step(), () => ticks.nth(idx[j % idx.length]).click({ force: true })))
    }
    seen.lanes = await longTasks()

    const { p50, p95 } = stats(samples)
    console.log(`# pending growth: ${growth.left()} members still to come; long tasks follow [${seen.follow.map(Math.round)}] scrub [${seen.scrub.map(Math.round)}] lanes [${seen.lanes.map(Math.round)}]; step n=${samples.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.stepClick} ms`)
    assert.ok(growth.left() > 0, 'the session was still pending through every phase')
    for (const [phase, ms] of Object.entries(seen)) assert.ok(Math.max(0, ...ms) <= LIMITS.longtaskMs, `${phase}: a long task of ${Math.round(Math.max(...ms))} ms`)
    assert.ok(p95 <= BOARD_LINES.stepClick, `step change p95 ${p95.toFixed(1)} ms over the ${BOARD_LINES.stepClick} ms line`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// a world without compactions on its main lane: each answer brings sealed packs (three loader slots) while the followed step's bodies
// need a slot of their own from inside a redraw. A pack holding its slot while waiting on the redraws froze the poll for good
// (seed 12 stopped at 12,000 of 30,000 members); the desk follows the growth to its end.
test("2.3 加载器 · D64②: packs and the followed step's bodies share the loader without freezing the poll; the growth is followed to its end", { skip, timeout: 180_000 }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.002 })
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium })
  try {
    const { page } = b
    const growth = await serveWorld(page, w, { from: 4000, grow: 1000, pack: 512 })
    await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    // every answer is asked at once while the session is pending (core/poll.mjs): a stall is one left count unchanged for 20 s
    for (let left = growth.left(), t = Date.now(); growth.left() > 0; await page.waitForTimeout(250)) {
      if (growth.left() !== left) { left = growth.left(); t = Date.now() }
      assert.ok(Date.now() - t < 20000, `the poll stopped with ${left} members still to come`)
    }
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
