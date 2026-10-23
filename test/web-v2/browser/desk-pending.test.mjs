// test/web-v2/browser/desk-pending.test.mjs — 2.3 §读与画 (归约前沿) · D64② · D69 on the mounted desk while a big session is read for the
// first time: its session reads are answered from a generated world of 30,000 calls on three lanes (desk-world.mjs) whose mark moves on
// by 1,000 members at each `since` read and carries `pending` until the last one, so every poll brings hundreds of rows, relanes and
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
  const w = world(12, { calls: 30000, page: 1500, files: 600 })
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium, setup: (page) => page.addInitScript(observeLongTasks) })
  try {
    const { page } = b
    const growth = await serveWorld(page, w, { from: 4000, grow: 1000 })
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

    // lane jumps: from the newest step, a tick of the overlay rows in the older half of the window
    const ticks = page.locator('#rails .tick[data-lane]')
    for (let j = 0; j < 10; j++) {
      await page.keyboard.press('End')
      const n = await ticks.count()
      assert.ok(n > 1, 'the overlay rows draw ticks')
      samples.push(await timed(page, 'step', await step(), () => ticks.nth(Math.floor((n / 2) * (j / 10))).click({ force: true })))
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
