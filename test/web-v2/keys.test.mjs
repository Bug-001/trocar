// test/web-v2/keys.test.mjs — the replay desk's keys (1.2 §键盘 MUST): generated over key × shift × playhead × length × problem
// list; asserts the clamp, the step each key lands on, and the two toggles.
import test from 'node:test'
import assert from 'node:assert/strict'
import { keyAction } from '../../web/legacy/replay/keymap.mjs'

const KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'n', 'p']
const problemSets = (n) => [[], [0], [...new Set([0, 1, Math.floor(n / 2), n - 1])].filter((i) => i < n).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i).filter((i) => i % 3 === 1)]

test('keys: every step key lands inside [0, n-1] on the step 1.2 §键盘 names; f and ? are the two toggles', () => {
  for (const n of [1, 2, 11, 30]) for (const problems of problemSets(n)) for (let at = 0; at < n; at++) for (const shiftKey of [false, true]) for (const key of KEYS) {
    const a = keyAction({ key, shiftKey }, { at, n, problems })
    const why = `${key}${shiftKey ? '+shift' : ''} at ${at} of ${n}, problems [${problems}]`
    if (a) assert.ok(Number.isInteger(a.to) && a.to >= 0 && a.to <= n - 1, `in range: ${why}`)
    const by = shiftKey ? 10 : 1
    if (key === 'ArrowLeft') assert.deepEqual(a, { to: Math.max(0, at - by) }, why)
    if (key === 'ArrowRight') assert.deepEqual(a, { to: Math.min(n - 1, at + by) }, why)
    if (key === 'Home') assert.deepEqual(a, { to: 0 }, why)
    if (key === 'End') assert.deepEqual(a, { to: n - 1 }, why)
    if (key === 'n') { const x = problems.find((p) => p > at); assert.deepEqual(a, x == null ? null : { to: x }, why) }
    if (key === 'p') { const x = [...problems].reverse().find((p) => p < at); assert.deepEqual(a, x == null ? null : { to: x }, why) }
  }
  for (const n of [1, 30]) {
    assert.deepEqual(keyAction({ key: 'f', shiftKey: false }, { at: 0, n, problems: [] }), { follow: true })
    assert.deepEqual(keyAction({ key: '?', shiftKey: true }, { at: 0, n, problems: [] }), { keys: true })
  }
})
