// test/web-v2/pace.test.mjs — 2.3 §归约前沿 读者优先: when background work runs against a reader's input, on a clock of its own. Over generated
// input times: a slice waits for a paint only within WAY_MS of an input; a redraw comes REDRAW_MS after the last, after the reader
// stopped or HOLD_MS, never while a pointer is down short of PRESS_MS, nor while it rests on the overlay rows short of HOVER_MS after its last move; urgent ends every wait but the pointer's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPace, WAY_MS, HOLD_MS, PRESS_MS, REDRAW_MS, HOVER_MS } from '../../web/legacy/replay/pace.mjs'

// a virtual clock: sleep and frame resolve as it is run forward; frames every 16 ms
function clock() {
  let t = 1000
  const q = []
  const at = (when, f) => { q.push({ when, f }); q.sort((a, b) => a.when - b.when) }
  const c = {
    now: () => t, sleep: (ms) => new Promise((r) => at(t + ms, r)), frame: (f) => at(Math.ceil((t + 1) / 16) * 16, f),
    async to(end) {
      for (;;) {
        await new Promise((r) => setImmediate(r))
        if (!q.length || q[0].when > end) break
        const e = q.shift(); t = Math.max(t, e.when); e.f()
      }
      t = end
      await new Promise((r) => setImmediate(r))
    },
  }
  return c
}
const done = (c, p, log) => p.then(() => log.push(c.now()))

test('2.3 读者优先: a slice runs at once with no input, and after a paint within WAY_MS of one', async () => {
  const c = clock(), pace = createPace(c)
  assert.equal(pace.slice(), undefined)
  pace.input()
  const log = [], t0 = c.now()
  done(c, pace.slice(), log)
  await c.to(t0 + 60)
  assert.equal(log.length, 1)
  await c.to(t0 + WAY_MS + 1)
  assert.equal(pace.slice(), undefined)
})

test('2.3 读者优先: a redraw comes REDRAW_MS after the last one, and urgent ends the wait', async () => {
  let hot = false
  const c = clock(), pace = createPace({ ...c, urgent: () => hot }), log = []
  pace.drew()
  const t0 = c.now()
  done(c, pace.redraw(), log)
  await c.to(t0 + REDRAW_MS - 1)
  assert.equal(log.length, 0)
  await c.to(t0 + REDRAW_MS + 1)
  assert.equal(log.length, 1)
  pace.drew()
  hot = true
  const now = []
  done(c, pace.redraw(), now)
  await c.to(c.now())
  assert.equal(now.length, 1)
  pace.input()
  assert.equal(pace.slice(), undefined, 'the reader waits for this slice')
})

test('2.3 读者优先: inputs every few ms hold a redraw at most HOLD_MS; one stop lets it go at once', async () => {
  for (const every of [10, 30, 60, 90]) {
    const c = clock(), pace = createPace(c), log = [], t0 = c.now()
    pace.input()
    done(c, pace.redraw(), log)
    for (let t = t0; t < t0 + HOLD_MS + 200; t += every) { pace.input(); await c.to(t + every) }
    assert.equal(log.length, 1, `inputs every ${every} ms`)
    assert.ok(log[0] - t0 <= HOLD_MS + 60, `released ${log[0] - t0} ms after, inputs every ${every} ms`)
  }
})

test('2.3 读者优先: a pointer held down holds a redraw, urgent or not, until it comes up or PRESS_MS has passed', async () => {
  for (const urgent of [false, true]) {
    const c = clock(), pace = createPace({ ...c, urgent: () => urgent }), log = [], t0 = c.now()
    pace.press(true)
    done(c, pace.redraw(), log)
    await c.to(t0 + 2000)
    assert.equal(log.length, 0)
    pace.press(false)
    await c.to(t0 + 2000 + WAY_MS + 60)
    assert.equal(log.length, 1)
    const held = [], t1 = c.now()
    pace.press(true)
    done(c, pace.redraw(), held)
    await c.to(t1 + PRESS_MS + 100)
    assert.equal(held.length, 1, 'a pointer-up that never came holds nothing for good')
  }
})

// a mark must stay where the reader aimed until the press: the overlay rows hold their redraw while the pointer is over them, until it
// leaves, rests HOVER_MS, or HOVER_MS have passed in all; urgent or not (as a press: the rows exist only once a step is drawn)
test('2.3 读者优先: a pointer on the overlay rows holds a redraw until it leaves, rests HOVER_MS, or HOVER_MS have passed', async () => {
  for (const moves of [0, 3]) {
    const c = clock(), pace = createPace(c), log = [], t0 = c.now()
    pace.hover(true)
    done(c, pace.redraw(), log)
    for (let i = 1; i <= moves; i++) { await c.to(t0 + i * 250); pace.hover(true) } // a pointer still moving there
    await c.to(t0 + HOVER_MS - 50)
    assert.equal(log.length, 0, `${moves} move(s): still held`)
    await c.to(t0 + HOVER_MS + 60)
    assert.equal(log.length, 1, `${moves} move(s): let go at HOVER_MS, moving or not`)
  }
  const c = clock(), pace = createPace(c), log = [], t0 = c.now()
  pace.hover(true)
  done(c, pace.redraw(), log)
  await c.to(t0 + 300)
  pace.hover(false)
  await c.to(t0 + 300 + REDRAW_MS + 60)
  assert.equal(log.length, 1, 'leaving the rows lets it go')
  const u = clock(), up = createPace({ ...u, urgent: () => true }), ul = [], u0 = u.now()
  up.hover(true)
  done(u, up.redraw(), ul)
  await u.to(u0 + HOVER_MS - 50)
  assert.equal(ul.length, 0, 'urgent: still held, as a press')
  await u.to(u0 + HOVER_MS + 60)
  assert.equal(ul.length, 1)
})

