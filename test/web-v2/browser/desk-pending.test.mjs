// test/web-v2/browser/desk-pending.test.mjs — 2.3 §读与画 (归约前沿) · D64② · D69 on the mounted desk while a big session is read for the
// first time: its session reads are answered from a generated world of 30,000 calls on three lanes (desk-world.mjs) whose mark moves on
// by 1,000 members at each answer and carries `pending` until the last one, so every answer brings hundreds of rows, relanes and
// events. The answers are paced by the case's own steps, not by the poll timer, so a slow machine sees the same growth, and some timed
// inputs run while an answer just taken is being read and drawn. While it grows the reader follows, scrubs 60 steps by ←/→ and jumps
// by the overlay rows' ticks: no task of the page's own runs over I-longtask's line, and a step change's p95 is within
// BOARD_LINES.stepClick. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, timed, stats } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { LIMITS } from './seq/invariants.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

// installed before the board's own scripts: every long task of the page, in ms, and the step head read once: its number (data-n) and
// the count after its "/" (Step n / m), or null while it is not drawn
function instrument() {
  window.__lt = []
  try { new PerformanceObserver((l) => { for (const x of l.getEntries()) window.__lt.push(x.duration) }).observe({ type: 'longtask', buffered: true }) } catch { /* no long-task timing here */ }
  window.__head = () => { const e = document.querySelector('#stepbar .sb-no'), m = e && /\/\s*(\d+)/.exec(e.textContent); return e && m ? { n: +e.dataset.n, m: +m[1] } : null }
}

test('2.3 归约前沿 · D64②: a session growing by 1,000 members an answer — following, scrubbing and lane jumps run no long task; step p95 within the line', { skip }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.02 }) // wide chapters: the window after End holds many steps
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium, setup: (page) => page.addInitScript(instrument) })
  try {
    const { page } = b
    const from = 4000, growth = await serveWorld(page, w, { from, grow: 1000, pack: 512, paced: true })
    let asked = 0
    await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
    const longTasks = () => page.evaluate(() => window.__lt.splice(0))
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    const stepN = async () => { const h = await page.evaluate(() => window.__head()); assert.ok(h, 'the step head is drawn'); return h.n }
    const until = (fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 30000, polling: 'raf' }).catch((e) => { throw new Error(`${what}: ${e.message}`) })
    // n more answers granted, and a wait until head reads have taken them (not until they are drawn); a stall is no head read in 20 s
    const grant = async (n) => {
      const to = growth.left() - n * 1000
      growth.more(n); asked += n
      for (let left = growth.left(), t = Date.now(); growth.left() > to; await page.waitForTimeout(50)) {
        if (growth.left() !== left) { left = growth.left(); t = Date.now() }
        assert.ok(Date.now() - t < 20000, `no head read took the granted answers: ${left} members still to come, ${to} asked for`)
      }
    }
    // every answer taken is drawn: the step head counts the main lane's steps at the mark the server is at (1.2 §会话头)
    const drawn = () => until((a) => window.__head()?.m === a, w.files(w.marks[w.marks.length - 1 - growth.left()], 512).head.steps, 'the answers taken were not drawn')
    await grant(1); await drawn()
    await longTasks() // the open is D64①'s, not this case's
    const seen = { follow: [], scrub: [], lanes: [] }, samples = []
    // a timed input: its step change, judged by the step number, so an input that moves nothing is red however the count grows
    const input = async (act) => samples.push(await timed(page, 'n', await stepN(), act))

    // following while 8 answers land
    const first = await stepN()
    await grant(8); await drawn()
    seen.follow = await longTasks()
    assert.notEqual(await stepN(), first, 'the followed step moved with the growth')

    // scrubbing: 30 steps back, 30 forward; every 6th input runs while an answer just taken by a head read is being read and drawn
    for (let i = 0; i < 60; i++) {
      if (i % 6 === 3) await grant(1)
      await input(() => page.keyboard.press(i < 30 ? 'ArrowLeft' : 'ArrowRight'))
    }
    await drawn()
    seen.scrub = await longTasks()

    // lane jumps: from the newest step, a tick of the overlay rows more than a bar left of the playhead, so the click moves the step;
    // a last chapter too short to hold one is left by [ to the chapter before it (1.3 §章: the window is the playhead's chapter).
    // The rows are redrawn by every answer, so the point is aimed and hit-checked in one task (as seq/actions.mjs clickIn) and clicked
    // as a point: a node or index read in one task and clicked in another can name another tick or a detached one. Every 2nd click
    // runs while an answer just taken is being read and drawn
    const older = (j) => page.evaluate((j) => {
      const cur = document.querySelector('#sawrow .bar.cur'), r0 = cur && cur.getBoundingClientRect()
      if (!r0) return null
      const mid = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2 }
      const ts = [...document.querySelectorAll('#rails .tick[data-lane]')].filter((t) => mid(t) < r0.left - r0.width), t = ts[j % Math.max(1, ts.length)]
      if (!t) return null
      const r = t.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
      return document.elementFromPoint(x, y) === t ? { x, y } : null
    }, j)
    for (let j = 0; j < 10; j++) {
      await page.keyboard.press('End')
      await until(() => { const h = window.__head(); return !!h && h.n === h.m }, undefined, 'End did not reach the newest step')
      let pt = await older(j)
      for (let k = 0; k < 5 && !pt; k++) {
        const n0 = await stepN()
        await page.keyboard.press('[')
        await until((a) => { const h = window.__head(); return !!h && h.n !== a }, n0, `[ did not move the step from ${n0}`)
        pt = await older(j)
      }
      assert.ok(pt, 'the overlay rows draw ticks in the older half of the window')
      if (j % 2 === 1) await grant(1)
      await input(() => page.mouse.click(pt.x, pt.y))
    }
    await drawn()
    seen.lanes = await longTasks()

    const { p50, p95 } = stats(samples)
    console.log(`# pending growth: ${growth.left()} members still to come; long tasks follow [${seen.follow.map(Math.round)}] scrub [${seen.scrub.map(Math.round)}] lanes [${seen.lanes.map(Math.round)}]; step n=${samples.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.stepClick} ms`)
    assert.equal(growth.left(), w.marks.length - 1 - from - asked * 1000, 'the growth moved by the answers asked, no more')
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
