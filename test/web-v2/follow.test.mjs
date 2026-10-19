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
