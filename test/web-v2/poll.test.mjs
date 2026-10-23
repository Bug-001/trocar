// test/web-v2/poll.test.mjs — the board's one poll engine (core/poll.mjs; 1.5 K-29, 4.4 §live-poll): createPoller's policy over a
// fake clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPoller, backoffMs, BACKOFF_MAX_MS } from '../../src/web/v2/core/poll.mjs'

// ── the poll loop (1.5 K-29): a fake clock and a fake reader ────────────────────────────────────────────────────────────
function rig(answers) {
  let t = 0, reads = 0
  const p = createPoller({ base: 1500, now: () => t, run: async () => { reads++; return answers.length ? answers.shift() : {} } })
  return { p, at: (ms) => { t = ms }, reads: () => reads }
}

test('poller: after a failure no read happens before the back-off is due; it doubles to 30 s; a success resets it', async () => {
  let ms = 0
  for (let n = 1; n <= 8; n++) { const w = backoffMs(n, 1500); assert.ok(w > ms || w === BACKOFF_MAX_MS); assert.ok(w <= BACKOFF_MAX_MS); ms = w }
  assert.equal(backoffMs(20, 1500), BACKOFF_MAX_MS)
  const r = rig([{ ok: false }, { ok: false }, {}, {}])
  await r.p.poll(); assert.equal(r.reads(), 1)
  r.at(backoffMs(1, 1500) - 1); await r.p.poll(); assert.equal(r.reads(), 1, 'a tick before the back-off is due reads nothing')
  r.at(backoffMs(1, 1500)); await r.p.poll(); assert.equal(r.reads(), 2, 'due: it reads (and fails again)')
  const t2 = backoffMs(1, 1500) + backoffMs(2, 1500)
  r.at(t2 - 1); await r.p.poll(); assert.equal(r.reads(), 2, 'the second wait is longer')
  r.at(t2); await r.p.poll(); assert.equal(r.reads(), 3, 'a success')
  await r.p.poll(); assert.equal(r.reads(), 4, 'after a success the next tick reads at once')
})

test('poller: a reader\'s own action bypasses the back-off', async () => {
  const r = rig([{ ok: false }, { ok: false }])
  await r.p.poll(); await r.p.poll(); assert.equal(r.reads(), 1)
  await r.p.poll(true); assert.equal(r.reads(), 2, 'Retry / a jump / f read at once')
  await r.p.poll(); assert.equal(r.reads(), 2)
})

test('poller: one read in flight; a tick during it re-reads after a success, never after a failure', async () => {
  for (const [first, want] of [[{}, 2], [{ ok: false }, 1]]) {
    let release, reads = 0
    const answers = [first, {}, {}]
    const p = createPoller({ base: 1500, now: () => 0, run: () => { reads++; const a = answers.shift(); return reads === 1 ? new Promise((res) => { release = () => res(a) }) : Promise.resolve(a) } })
    const done = p.poll()
    await p.poll(); await p.poll() // ticks while the first read is in flight: no second concurrent read
    assert.equal(reads, 1)
    release(); await done
    assert.equal(reads, want, JSON.stringify(first))
  }
})

test('poller: while idle() holds (hidden tab, a session not listed) a timer tick reads nothing; a reader poll still reads', async () => {
  let idle = true, reads = 0
  const p = createPoller({ base: 1500, now: () => 0, idle: () => idle, run: async () => { reads++; return {} } })
  await p.poll(); await p.poll(); assert.equal(reads, 0, 'idle: the timer reads nothing')
  await p.poll(true); assert.equal(reads, 1, 'a reader poll reads')
  idle = false; await p.poll(); assert.equal(reads, 2, 'no longer idle: the next tick reads')
})

test('poller: after a slow success a timer tick waits 3x that read; a quick read keeps the plain interval', async () => {
  const base = 1500
  for (const D of [10 * base, 5 * base]) {
    let t = 0, reads = 0
    const p = createPoller({ base, now: () => t, run: async () => { reads++; t += D; return {} } })
    await p.poll(); assert.equal(reads, 1)
    t = 3 * D - 1; await p.poll(); assert.equal(reads, 1, `D=${D}: a tick before 3D reads nothing`)
    t = 3 * D; await p.poll(); assert.equal(reads, 2, `D=${D}: at 3D it reads`)
    await p.poll(true); assert.equal(reads, 3, 'a reader poll never waits')
  }
  let t = 0, reads = 0
  const D = Math.floor(base / 3) - 1
  const p = createPoller({ base, now: () => t, run: async () => { reads++; t += D; return {} } })
  await p.poll(); await p.poll(); assert.equal(reads, 2, 'a quick read: the next timer tick (one interval later) reads')
})

test('poller: a tick during a slow read does not chain a read before the 3x gap', async () => {
  let t = 0, reads = 0, release
  const p = createPoller({ base: 1500, now: () => t, run: () => { reads++; return new Promise((res) => { release = () => { t += 15000; res({}) } }) } })
  const done = p.poll(); await p.poll(); release(); await done
  assert.equal(reads, 1)
})

// ── C2 (4.4 live-poll): the 3x wait follows only a success without `pending` that did not end a back-off ──────────────
// a poller over scripted answers, each read taking `took` ms of the fake clock
function timed(script, base = 1500) {
  let t = 0, reads = 0
  const p = createPoller({ base, now: () => t, run: async () => { const [a, took] = script[reads++] || [{}, 0]; t += took; return a } })
  return { p, reads: () => reads, at: (ms) => { t = ms }, now: () => t }
}

test('A7 (C2): after a pending answer the next timer tick reads at the interval, however long the read took', async () => {
  const base = 1500
  for (const took of [base / 3 + 1, base, 10 * base]) {
    const r = timed([[{ pending: { done: 1, total: 9 } }, took]], base)
    await r.p.poll(); assert.equal(r.reads(), 1)
    r.at(took + base); await r.p.poll(); assert.equal(r.reads(), 2, `took ${took}: the tick one interval later reads`)
  }
})

test('A7 (C2): after k failures and then a slow success the next timer tick reads at the interval', async () => {
  const base = 1500
  for (const k of [1, 2, 5]) {
    const r = timed([...Array.from({ length: k }, () => [{ ok: false }, 10]), [{}, 22000]], base)
    for (let i = 0; i < k; i++) await r.p.poll(true)
    await r.p.poll(true); assert.equal(r.reads(), k + 1, 'the success')
    r.at(r.now() + base); await r.p.poll(); assert.equal(r.reads(), k + 2, `k=${k}: the back-off ended at once`)
  }
})

test('A7 (C2): after a slow success without pending no timer read comes before 3x its duration', async () => {
  const base = 1500
  for (const D of [base / 3 + 1, base, 7 * base]) {
    const r = timed([[{}, D]], base)
    await r.p.poll()
    for (let t = D; t < 3 * D; t += base / 2) { r.at(t); await r.p.poll() }
    assert.equal(r.reads(), 1, `D=${D}`)
    r.at(3 * D); await r.p.poll(); assert.equal(r.reads(), 2)
  }
})

