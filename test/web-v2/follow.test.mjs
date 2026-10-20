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

// ── where a page sits (1.2 「跟随最新」 · 2.3 §未下发态 · 3.5 §分页 正文预算) ───────────────────────────────────────────
import { followCursor, pagePlace, createPoller, backoffMs, BACKOFF_MAX_MS } from '../../src/web/v2/replay/follow.mjs'
import { pageView } from '../../src/view/board.mjs'
import { PAGE_BODY_BYTES } from '../../src/query/named/index.mjs'

test('pagePlace: every step of a long session rides the page placed for it, with its body (the first steps too)', () => {
  const N = 3 * 60, size = Math.floor(PAGE_BODY_BYTES / 5.5) // the budget holds about five bodies
  const calls = Array.from({ length: N }, (_, gi) => ({ gi, ts: new Date(gi * 1000).toISOString(), comp: { messages: size }, flat: [{ sec: 'messages' }] }))
  const view = { analyzed: { lanes: [{ id: 'main', kind: 'main', calls }], steps: calls } }
  for (let gi = 0; gi < N; gi++) {
    const p = pagePlace(gi, 60)
    const out = pageView(view, { cursor: p.after, limit: p.limit }, { budget: PAGE_BODY_BYTES })
    const c = out.analyzed.lanes[0].calls.find((x) => x.gi === gi)
    assert.ok(c && !c.paged_out, `step ${gi} rides the page ${JSON.stringify(p)}`)
  }
})

test('followCursor: while following, the followed step sits at the middle of the next page, the session\'s first steps too', () => {
  for (const total of [1, 2, 7, 59, 60, 61, 333]) for (const limit of [1, 2, 7, 60]) for (const back of [0, 1, 5, 40, 332]) for (const returned of [0, 1, 60]) {
    const tailGi = Math.max(0, total - 1 - back)
    const p = followCursor({ follow: true, page: { total, returned }, pageCur: 250, pageLim: 60, limit, tailGi })
    assert.equal(p.after + Math.floor(p.limit / 2), tailGi, JSON.stringify({ total, limit, tailGi, returned, p }))
  }
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
