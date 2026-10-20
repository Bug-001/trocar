// test/web-v2/follow.test.mjs — the replay desk's live-follow policy (replay/follow.mjs): the live checkbox gates the timer, and the
// URL's step stays in step with a playhead that moves by itself. The controller (replay.mjs) has no DOM test; this is its pure part.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pollWhenLive, landPlayhead } from '../../src/web/v2/replay/follow.mjs'

test('pollWhenLive: the timer polls only while "live" is checked — unchecking freezes, rechecking resumes', () => {
  let on = true, polls = 0
  const tick = pollWhenLive(() => on, () => { polls++ })
  tick(); tick(); assert.equal(polls, 2)
  on = false; tick(); tick(); tick(); assert.equal(polls, 2, 'unchecked: nothing is fetched')
  on = true; tick(); assert.equal(polls, 3, 'rechecked: it resumes')
})

test('landPlayhead: a URL step is honoured and clamped; the URL is rewritten only when it was out of range', () => {
  assert.deepEqual(landPlayhead({ N: 60, playhead: 0, follow: true, initialStep: 20 }), { playhead: 19, follow: false, syncUrl: false })
  assert.deepEqual(landPlayhead({ N: 60, playhead: 0, follow: true, initialStep: 60 }), { playhead: 59, follow: true, syncUrl: false }) // the live end
  assert.deepEqual(landPlayhead({ N: 60, playhead: 0, follow: true, initialStep: 999 }), { playhead: 59, follow: true, syncUrl: true })
  assert.deepEqual(landPlayhead({ N: 60, playhead: 5, follow: false, initialStep: 1 }), { playhead: 0, follow: false, syncUrl: false })
})

test('landPlayhead: following the live end moves the playhead AND asks for the URL step to be rewritten', () => {
  // the review's case: parked at step 50, the session grows to 60 — a reload must not land on 50 with follow off
  assert.deepEqual(landPlayhead({ N: 60, playhead: 49, follow: true, initialStep: null }), { playhead: 59, follow: true, syncUrl: true })
  // the first landing of a link without a step lands on the last call, and the URL says so
  assert.deepEqual(landPlayhead({ N: 12, playhead: 0, follow: true, initialStep: null }), { playhead: 11, follow: true, syncUrl: true })
  // already there: nothing moved, nothing to write (a poll with no growth must not touch the URL)
  assert.deepEqual(landPlayhead({ N: 60, playhead: 59, follow: true, initialStep: null }), { playhead: 59, follow: true, syncUrl: false })
  assert.deepEqual(landPlayhead({ N: 1, playhead: 0, follow: true, initialStep: null }), { playhead: 0, follow: true, syncUrl: false })
})

test('landPlayhead: a reader who scrubbed away stays put; a lane that shrank clamps the playhead and the URL follows', () => {
  assert.deepEqual(landPlayhead({ N: 60, playhead: 10, follow: false, initialStep: null }), { playhead: 10, follow: false, syncUrl: false })
  assert.deepEqual(landPlayhead({ N: 8, playhead: 49, follow: false, initialStep: null }), { playhead: 7, follow: false, syncUrl: true })
})

// ── followCursor (1.2 「跟随最新」): generated over (total, tailGi, pageCur, limit, returned, follow) ───────────────────
import { followCursor, centerCursor, createPoller, backoffMs, BACKOFF_MAX_MS } from '../../src/web/v2/replay/follow.mjs'
const axes = []
for (const total of [1, 2, 7, 59, 60, 61, 333]) for (const limit of [1, 2, 7, 60]) for (const back of [0, 1, 5, 40]) for (const pageCur of [0, 3, 250]) for (const returned of [0, 1, 60]) for (const follow of [true, false])
  axes.push({ total, limit, tailGi: Math.max(0, total - 1 - back), pageCur, returned, follow })

test('followCursor: while following, the followed step (this answer\'s own tail) is on the next page, at its middle', () => {
  for (const a of axes.filter((x) => x.follow)) {
    const c = followCursor({ follow: true, page: { total: a.total, returned: a.returned }, pageCur: a.pageCur, limit: a.limit, tailGi: a.tailGi })
    assert.ok(Number.isInteger(c) && c >= 0, JSON.stringify(a))
    assert.ok(c <= a.tailGi && a.tailGi < c + a.limit, `on the page: ${JSON.stringify(a)} → ${c}`)
    assert.equal(c, centerCursor(a.tailGi, a.limit))
    // without a tailGi the answer's own last call is followed — never an earlier answer's total
    const c2 = followCursor({ follow: true, page: { total: a.total, returned: a.returned }, pageCur: a.pageCur, limit: a.limit })
    assert.ok(c2 <= a.total - 1 && a.total - 1 < c2 + a.limit)
  }
})

test('followCursor: not following keeps the reader\'s window, unless the answer held no call (then the tail is placed)', () => {
  for (const a of axes.filter((x) => !x.follow)) {
    const c = followCursor({ follow: false, page: { total: a.total, returned: a.returned }, pageCur: a.pageCur, limit: a.limit, tailGi: a.tailGi })
    if (a.returned !== 0) assert.equal(c, a.pageCur, JSON.stringify(a))
    else assert.ok(c <= a.tailGi && a.tailGi < c + a.limit, JSON.stringify(a))
  }
  assert.equal(followCursor({ follow: true, page: null, pageCur: 9, limit: 60 }), 9, 'no page: nothing to place by')
  assert.equal(followCursor({ follow: true, page: { total: 0, returned: 0 }, pageCur: 9, limit: 60 }), 9, 'an empty session')
})

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

test('poller: a reader\'s own action bypasses the back-off; reset() clears it', async () => {
  const r = rig([{ ok: false }, { ok: false }])
  await r.p.poll(); await r.p.poll(); assert.equal(r.reads(), 1)
  await r.p.poll(true); assert.equal(r.reads(), 2, 'Retry / load this step / f read at once')
  await r.p.poll(); assert.equal(r.reads(), 2)
  r.p.reset(); await r.p.poll(); assert.equal(r.reads(), 3, 'another session starts clean')
})

test('poller: one read in flight; a tick during it re-reads after a success, never after a failure; {again} reads once more', async () => {
  for (const [first, want] of [[{}, 2], [{ ok: false }, 1], [{ again: true }, 2]]) {
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
