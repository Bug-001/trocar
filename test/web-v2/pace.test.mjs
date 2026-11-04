// test/web-v2/pace.test.mjs — 2.3 §归约前沿 读者优先: when background work runs against a reader's input, on a clock of its own. Over generated
// input times: a slice waits for a paint only within WAY_MS of an input; a redraw comes REDRAW_MS after the last, after the reader
// stopped or HOLD_MS, never while a pointer is down short of PRESS_MS; urgent ends every wait but the pointer's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPace, WAY_MS, HOLD_MS, PRESS_MS, REDRAW_MS } from '../../web/legacy/replay/pace.mjs'

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
  const c = clock(), pace = createPace(c), log = []
  pace.drew()
  const t0 = c.now()
  done(c, pace.redraw(() => false), log)
  await c.to(t0 + REDRAW_MS - 1)
  assert.equal(log.length, 0)
  await c.to(t0 + REDRAW_MS + 1)
  assert.equal(log.length, 1)
  pace.drew()
  const hot = []
  done(c, pace.redraw(() => true), hot)
  await c.to(c.now())
  assert.equal(hot.length, 1)
})

test('2.3 读者优先: inputs every few ms hold a redraw at most HOLD_MS; one stop lets it go at once', async () => {
  for (const every of [10, 30, 60, 90]) {
    const c = clock(), pace = createPace(c), log = [], t0 = c.now()
    pace.input()
    done(c, pace.redraw(() => false), log)
    for (let t = t0; t < t0 + HOLD_MS + 200; t += every) { pace.input(); await c.to(t + every) }
    assert.equal(log.length, 1, `inputs every ${every} ms`)
    assert.ok(log[0] - t0 <= HOLD_MS + 60, `released ${log[0] - t0} ms after, inputs every ${every} ms`)
  }
})

test('2.3 读者优先: a pointer held down holds a redraw, urgent or not, until it comes up or PRESS_MS has passed', async () => {
  for (const urgent of [false, true]) {
    const c = clock(), pace = createPace(c), log = [], t0 = c.now()
    pace.press(true)
    done(c, pace.redraw(() => urgent), log)
    await c.to(t0 + 2000)
    assert.equal(log.length, 0)
    pace.press(false)
    await c.to(t0 + 2000 + WAY_MS + 60)
    assert.equal(log.length, 1)
    const held = [], t1 = c.now()
    pace.press(true)
    done(c, pace.redraw(() => urgent), held)
    await c.to(t1 + PRESS_MS + 100)
    assert.equal(held.length, 1, 'a pointer-up that never came holds nothing for good')
  }
})
