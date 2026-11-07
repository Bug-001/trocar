// 2.3 读者优先, the overlay rows: an answer's paint waits while the pointer is on the rows, at most HOLD_RAILS_MS; leaving draws it,
// the reader's own draw is at once. Generated sequences of the four inputs on an injected clock; the invariants are the spec's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRailsHold, HOLD_RAILS_MS } from '../../web/legacy/replay/rails-hold.mjs'

function rig() {
  let t = 0, timer = null
  const draws = []
  const h = createRailsHold({
    setTimer: (fn, ms) => (timer = { fn, at: t + ms }),
    clearTimer: (x) => { if (timer === x) timer = null },
    draw: () => draws.push(t),
  })
  const advance = (ms) => { const end = t + ms; while (timer && timer.at <= end) { const x = timer; t = x.at; timer = null; x.fn() } t = end }
  return { h, draws, advance, now: () => t }
}

test('2.3 读者优先: not over the rows, an answer draws at once; over them it waits for leave or HOLD_RAILS_MS, then draws once', () => {
  const a = rig()
  a.h.answer(); assert.deepEqual(a.draws, [0])
  const b = rig()
  b.h.over(true); b.h.answer(); b.advance(300); b.h.answer(); b.advance(100)
  assert.deepEqual(b.draws, [], 'held while the pointer is on the rows')
  b.h.over(false); assert.deepEqual(b.draws, [400], 'leaving draws it')
  b.advance(2000); assert.deepEqual(b.draws, [400], 'and once')
  const c = rig()
  c.h.over(true); c.h.answer(); c.advance(HOLD_RAILS_MS - 1); assert.deepEqual(c.draws, [])
  c.advance(1); assert.deepEqual(c.draws, [HOLD_RAILS_MS], 'a pointer that stays gets the paint at HOLD_RAILS_MS')
  const d = rig()
  d.h.over(true); d.h.answer(); d.advance(200); d.h.reader(); assert.deepEqual(d.draws, [200], 'the reader\'s draw is at once')
  d.advance(2000); assert.deepEqual(d.draws, [200], 'and ends the hold')
  const e = rig()
  e.h.over(true); e.h.over(false); e.advance(2000); assert.deepEqual(e.draws, [], 'leaving with nothing held draws nothing')
  const f = rig()
  f.h.over(true); f.h.answer(); f.advance(900); f.h.press(true); f.advance(500)
  assert.deepEqual(f.draws, [], 'the time is up while the pointer is down: the paint waits for it to come up')
  f.h.press(false); assert.deepEqual(f.draws, [1400], 'and comes when it does')
})

test('2.3 读者优先: over any sequence, a held paint never waits past HOLD_RAILS_MS and the last answer is always drawn', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let run = 0; run < 300; run++) {
    const r = rig()
    let since = null // when the oldest answer not yet drawn came
    const check = () => { if (since != null) assert.ok(r.now() - since <= HOLD_RAILS_MS, `run ${run}: an answer waited ${r.now() - since} ms`) }
    const drawn = () => { since = null }
    const n0 = () => r.draws.length
    let down = false
    // the bound holds whenever the pointer is up; while it is down, nothing but the reader's own draw paints the rows
    const quiet = (b, what) => { if (down) assert.equal(n0(), b, `run ${run}: ${what} painted the rows under a pressed pointer`) }
    for (let k = 0; k < 40; k++) {
      const x = rnd(), before = n0()
      if (x < 0.3) { if (since == null) since = r.now(); r.h.answer(); quiet(before, 'an answer') } else if (x < 0.4) r.h.reader()
      else if (x < 0.55) { r.h.over(rnd() < 0.5); quiet(before, 'a move') } else if (x < 0.7) { down = rnd() < 0.5; r.h.press(down); if (down) quiet(before, 'a press') }
      else {
        // time passes in small steps, so the bound is read at every timer
        for (let left = Math.floor(rnd() * 1500); left > 0; left -= 50) { const b = n0(); r.advance(Math.min(50, left)); quiet(b, 'the timer'); if (n0() > b) drawn(); if (!down) check() }
        continue
      }
      if (n0() > before) drawn()
      if (!down) check()
    }
    down = false; r.h.press(false)
    r.h.over(false); if (since != null) assert.ok(r.draws.length > 0 && r.draws.at(-1) === r.now(), `run ${run}: leaving drew the last answer`)
  }
})
