// test/web-v2/follow.test.mjs — the replay desk's live-follow policy (replay/follow.mjs): where the playhead lands after a fetch.
// 1.2 §路由: a URL naming a step pins that step (clamped) and opens with 跟随最新 off, even when it is the newest; without one the
// desk follows. The controller (replay.mjs) is covered in the browser (desk-url.test.mjs); this is its pure part.
import test from 'node:test'
import assert from 'node:assert/strict'
import { landPlayhead } from '../../src/web/v2/replay/follow.mjs'

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

test('1.2 #13 landPlayhead: a named step pins the clamped step with follow off; without one a follower goes to the last call', () => {
  for (const N of [1, 2, 7, 60]) {
    for (const initialStep of [-3, 0, 1, Math.ceil(N / 2), N - 1, N, N + 1, 999]) {
      for (const follow of [true, false]) {
        const got = landPlayhead({ N, playhead: 0, follow, initialStep })
        assert.equal(got.follow, false, `N=${N} step=${initialStep}`)
        assert.equal(got.playhead, clamp(initialStep - 1, 0, N - 1), `N=${N} step=${initialStep}`)
      }
    }
    for (const playhead of [0, N - 1, N + 5]) {
      for (const follow of [true, false]) {
        const got = landPlayhead({ N, playhead, follow, initialStep: null })
        assert.equal(got.follow, follow)
        assert.equal(got.playhead, follow ? N - 1 : Math.min(playhead, N - 1))
      }
    }
  }
})
