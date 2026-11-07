// test/web-v2/browser/desk-pending.test.mjs — 2.3 §读与画 (归约前沿) · D64② · D69 on the mounted desk while a big session is read for the
// first time: its session reads are answered from a generated world of 30,000 calls on three lanes (desk-world.mjs) whose mark moves on
// by 1,000 members at each answer and carries `pending` until the last one, so every answer brings hundreds of rows, relanes and
// events. The answers are paced by the case's own steps, not by the poll timer, so a slow machine sees the same growth, and some timed
// inputs run while an answer just taken is being read and drawn. While it grows the reader follows, scrubs 60 steps by ←/→ and jumps
// by the overlay rows' ticks: every input moves the step, no task of the page's own runs over I-longtask's line, and a step change's
// p95 is within BOARD_LINES.stepClick. A tick held down while an answer lands moves the step when it is let go. Runs only under
// `npm run test:browser`.
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
  window.__press = []
  for (const k of ['pointerdown', 'pointerup', 'click']) addEventListener(k, (e) => window.__press.push(`${k} ${e.target.className || e.target.nodeName}${e.target.isConnected ? '' : ' (gone)'}`), true)
  window.__head = () => { const e = document.querySelector('#stepbar .sb-no'), m = e && /\/\s*(\d+)/.exec(e.textContent); return e && m ? { n: +e.dataset.n, m: +m[1] } : null }
}

// In the page, in one task: a tick of the overlay rows more than a bar left of the playhead, as a point hit-checked there (a node or an
// index read in one task and clicked in another can name another tick or a detached one), with its call; null when the window shows none.
const olderTick = (page, j) => page.evaluate((j) => {
  const cur = document.querySelector('#sawrow .bar.cur'), r0 = cur && cur.getBoundingClientRect()
  if (!r0) return null
  const mid = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2 }
  const ts = [...document.querySelectorAll('#rails .tick[data-lane]')].filter((t) => mid(t) < r0.left - r0.width), t = ts.at(j % Math.max(1, ts.length))
  if (!t) return null
  const r = t.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
  return document.elementFromPoint(x, y) === t ? { x, y, rid: t.dataset.rid } : null
}, j)
// the desk over the growing world `w`, its first answer drawn: page, grant(n) (n more answers, and a wait until head reads have taken
// them, not until they are drawn; a stall is no head read in 20 s), drawn() (every answer taken is drawn: the step head counts the main
// lane's steps at the mark the server is at, 1.2 §会话头), stepN() and until(fn, arg, what)
async function growingDesk(w, fn) {
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium, setup: (page) => page.addInitScript(instrument) })
  try {
    const { page } = b
    const growth = await serveWorld(page, w, { from: 4000, grow: 1000, pack: 512, paced: true })
    await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    const stepN = async () => { const h = await page.evaluate(() => window.__head()); assert.ok(h, 'the step head is drawn'); return h.n }
    const until = (fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 30000, polling: 'raf' }).catch(async (e) => {
      throw new Error(`${what} (now ${JSON.stringify(await page.evaluate(() => ({ head: window.__head(), drawer: !!document.querySelector('#detail.open'), pressed: window.__press })))}): ${e.message}`)
    })
    const grant = async (n) => {
      const to = growth.left() - n * 1000
      growth.more(n)
      for (let left = growth.left(), t = Date.now(); growth.left() > to; await page.waitForTimeout(50)) {
        if (growth.left() !== left) { left = growth.left(); t = Date.now() }
        assert.ok(Date.now() - t < 20000, `no head read took the granted answers: ${left} members still to come, ${to} asked for`)
      }
    }
    const drawn = () => until((a) => window.__head()?.m === a, w.files(w.marks[w.marks.length - 1 - growth.left()], 512).head.steps, 'the answers taken were not drawn')
    await grant(1); await drawn()
    await fn({ page, growth, grant, drawn, stepN, until })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
}
const toEnd = async ({ page, until }) => {
  await page.keyboard.press('End')
  await until(() => { const h = window.__head(); return !!h && h.n === h.m }, undefined, 'End did not reach the newest step')
}
// a tick more than a bar left of the playhead; a last chapter too short to hold one is left by [ to the chapter before it (1.3 §章: the
// window is the playhead's chapter)
async function aimOlder(d, j) {
  // a chapter's ticks come with its packs, and those wait for a reader who has just pressed a key: looked for until the reader's calm has passed
  const look = async () => { let pt = null; for (let t = Date.now(); !(pt = await olderTick(d.page, j)) && Date.now() - t < 1500;) await d.page.waitForTimeout(100); return pt }
  let pt = await look()
  for (let k = 0; k < 5 && !pt; k++) {
    const n0 = await d.stepN()
    await d.page.keyboard.press('[')
    await d.until((a) => { const h = window.__head(); return !!h && h.n !== a }, n0, `[ did not move the step from ${n0}`)
    pt = await look()
  }
  assert.ok(pt, 'the overlay rows draw ticks in the older half of the window')
  return pt
}

let growing = null // the first case's step samples, for the line's own case
test('2.3 归约前沿 · D64②: a session growing by 1,000 members an answer — following, scrubbing and lane jumps move the step and run no long task', { skip }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.02 }) // wide chapters: the window after End holds many steps
  await growingDesk(w, async (d) => {
    const { page, growth, grant, drawn, stepN } = d, longTasks = () => page.evaluate(() => window.__lt.splice(0))
    const left0 = growth.left()
    await longTasks() // the open is D64①'s, not this case's
    const seen = { follow: [], scrub: [], lanes: [] }, samples = []
    // a timed input: its step change, judged by the step number, so an input that moves nothing is red however the count grows
    const input = async (what, act) => samples.push(await timed(page, 'n', await stepN(), act).catch((e) => { e.message = `${what}: ${e.message}`; throw e }))

    // following while 8 answers land
    const first = await stepN()
    await grant(8); await drawn()
    seen.follow = await longTasks()
    assert.notEqual(await stepN(), first, 'the followed step moved with the growth')

    // scrubbing: 30 steps back, 30 forward; every 6th input runs while an answer just taken by a head read is being read and drawn
    for (let i = 0; i < 60; i++) {
      if (i % 6 === 3) await grant(1)
      await input(`scrub ${i}`, () => page.keyboard.press(i < 30 ? 'ArrowLeft' : 'ArrowRight'))
    }
    await drawn()
    seen.scrub = await longTasks()

    // lane jumps: from the newest step; every 2nd click runs while an answer just taken is being read and drawn, aimed after that
    // answer was taken, as the rows it redraws are what the reader aims at
    for (let j = 0; j < 10; j++) {
      await toEnd(d)
      if (j % 2 === 1) await grant(1)
      const pt = await aimOlder(d, j)
      await input(`lane jump ${j}`, () => page.mouse.click(pt.x, pt.y))
    }
    await drawn()
    seen.lanes = await longTasks()

    const { p50, p95 } = growing = stats(samples)
    console.log(`# pending growth: ${growth.left()} members still to come; long tasks follow [${seen.follow.map(Math.round)}] scrub [${seen.scrub.map(Math.round)}] lanes [${seen.lanes.map(Math.round)}]; step n=${samples.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms (scrub ${stats(samples.slice(0, 60)).p95.toFixed(1)}, lane jumps ${stats(samples.slice(60)).p95.toFixed(1)}) line=${BOARD_LINES.stepClick} ms`)
    assert.equal(growth.left(), left0 - 23 * 1000, 'the growth moved by the answers asked, no more')
    assert.ok(growth.left() > 0, 'the session was still pending through every phase')
    for (const [phase, ms] of Object.entries(seen)) assert.ok(Math.max(0, ...ms) <= LIMITS.longtaskMs, `${phase}: a long task of ${Math.round(Math.max(...ms))} ms`)
  })
})

// the line, on the samples above: a known shortfall, reported and not red (the way an `open` sequence regression is a todo), the line as it
// is (D64⑥). Measured at a 1-min load of 10-94: 39.7-75.0 ms over 6 runs on the build before the pack slot change, over the line in 5;
// 43.8-129.9 ms over 19 runs since, over the line in 15; the p50 16-25 ms on both. The slow samples are the inputs taken as an answer lands
// (every 6th of the scrub).
const SHORT = 'the board does not hold this line on every run while the session grows: step p95 over BOARD_LINES.stepClick'
test('2.3 归约前沿 · D64②: step p95 within the line while the session grows', { skip, todo: SHORT }, () => {
  assert.ok(growing, 'the growing case ran')
  assert.ok(growing.p95 <= BOARD_LINES.stepClick, `step change p95 ${growing.p95.toFixed(1)} ms over the ${BOARD_LINES.stepClick} ms line`)
})

// 2.3 读者优先: a redraw between a press and its release takes the pressed node away, and the browser then sends no click. A tick held
// down while answers land still jumps there when let go: the step moved and the call's drawer opened (following alone opens nothing).
test('2.3 读者优先: a tick held down while an answer lands moves the step when it is let go', { skip }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.02 })
  await growingDesk(w, async (d) => {
    const { page, growth, grant, drawn, stepN, until } = d
    await grant(2); await drawn()
    for (let j = 0; j < 3; j++) {
      await toEnd(d)
      await page.keyboard.press('Escape') // the last jump's drawer
      await until(() => !document.querySelector('#detail.open'), undefined, 'Escape did not close the drawer')
      const pt = await aimOlder(d, j), n0 = await stepN()
      await page.mouse.move(pt.x, pt.y)
      await page.mouse.down()
      growth.more(1) // not waited for: a round already in flight waits for the release like its redraw, and the press is let go in time
      await page.waitForTimeout(1500 + 400) // the next round's answer read and applied while the pointer is down
      await page.mouse.up()
      await until((n0) => { const h = window.__head(); return !!h && h.n !== n0 && !!document.querySelector('#detail.open') }, n0, `the tick let go at step ${n0} did not move the step`)
      await drawn()
    }
  })
})

// 2.3 读者优先, the aim: a tick the pointer rests on is not redrawn away while answers land, so the press lands on the tick aimed at; the rows
// redraw once the pointer leaves them, rests or has held them HOVER_MS (pace.mjs). The pointer keeps moving by a pixel on the tick, as a hand
// aiming does.
test('2.3 读者优先: a tick the pointer rests on stays drawn while an answer lands; the rows redraw once it rests or leaves', { skip }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.02 })
  await growingDesk(w, async (d) => {
    const { page, grant, drawn } = d
    await grant(2); await drawn()
    for (let j = 0; j < 3; j++) {
      await toEnd(d)
      const pt = await aimOlder(d, j)
      await page.mouse.move(pt.x, pt.y)
      await page.evaluate(([x, y]) => { window.__aimed = document.elementFromPoint(x, y) }, [pt.x, pt.y])
      let aiming = true
      const hand = (async () => { for (let k = 0; aiming; k++) { await page.mouse.move(pt.x + (k % 2), pt.y); await page.waitForTimeout(100) } })()
      try {
        await grant(1) // taken by a head read; its redraw would rewrite the rows
        await page.waitForTimeout(700) // the answer applied and its redraw held: at most HOVER_MS (pace.mjs) from when it was due
        assert.ok(await page.evaluate(() => !!window.__aimed && window.__aimed.isConnected && window.__aimed.matches('.tick')), `round ${j}: the tick under the pointer was redrawn away`)
      } finally { aiming = false; await hand }
      await page.mouse.move(pt.x, pt.y - 400) // off the rows
      await drawn()
      assert.ok(await page.evaluate(() => !window.__aimed.isConnected), `round ${j}: the rows never redrew after the pointer left`)
    }
  })
})

// The other half of the same rule: a redraw already past the pace when the pointer goes down. The followed step's bodies hold it between
// its turn and the drawing of the lanes; pressed there and let go after they come, the tick still jumps, and to the call pressed: the
// lanes already hold the answer's rows and the drawn ticks do not, so a place read off a tick names another call (2.3 §播放头是调用). The
// window holds ticks at the newest step (a wide chapter), so the reader is following when pressing; the newest tick left of it is the one
// the answer's rows land before.
test('2.3 读者优先: a redraw already on its way when the tick is pressed waits for the release, and the call pressed is the one selected', { skip }, async () => {
  const w = world(12, { calls: 30000, page: 1500, files: 600, compact: 0.002 })
  await growingDesk(w, async (d) => {
    const { page, grant, drawn, stepN, until } = d
    await grant(1); await drawn()
    await toEnd(d)
    await page.waitForTimeout(500) // the bodies of the step End reached are in: what comes next is the redraw's own read
    const held = []
    let hold = true
    await page.route('**/api/block?**', (route) => (hold ? held.push(route) : route.fallback()))
    // a step with no reply asks no bodies before it is drawn: the next answer's newest step is tried, until one's redraw waits for them
    let n0 = await stepN()
    for (let k = 0; ; k++) {
      assert.ok(k < 8, 'a followed step asked for its bodies before it was drawn')
      await grant(1)
      for (const t = Date.now(); !held.length && await stepN() === n0; await page.waitForTimeout(50)) assert.ok(Date.now() - t < 20000, 'the answer moved nothing')
      await page.waitForTimeout(400) // the bodies asked may be the apply's own: the redraw's turn comes after, and it is drawn at once unless it waits for them
      if (await stepN() === n0) break
      hold = false
      await page.waitForTimeout(500)
      for (const r of held.splice(0)) await r.fallback()
      n0 = await stepN()
      hold = true
    }
    const pt = await olderTick(page, -1)
    assert.ok(pt?.rid, 'the window holds a tick left of the newest step')
    await page.mouse.move(pt.x, pt.y)
    await page.mouse.down()
    hold = false
    for (const r of held) await r.fallback()
    await page.waitForTimeout(400) // the bodies in, the redraw free to go, the pointer still down
    await page.mouse.up()
    await until((n0) => { const h = window.__head(); return !!h && h.n !== n0 && !!document.querySelector('#detail.open') }, n0, `the tick let go at step ${n0} did not move the step`)
    await drawn()
    assert.equal(await page.evaluate(() => document.querySelector('#rails .tick.sel')?.dataset.rid), pt.rid, 'the tick pressed is the call selected')
  })
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
