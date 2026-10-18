// test/off/mode.test.mjs — proxy mode or driver mode (D47), the fact src/off/ keeps its own copy of because the standalone `asight-off`
// runs without the repo (0.1 §2): the two copies MUST agree, or an `off` taken from the copy would steer one way and the collector the
// other. The consequence the copies decide (D62 ⑥): whether an `off` with no names asks the daemon to exit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isProxyMode } from '../../src/off/mode.mjs'
import { isModelOs, MODEL_OS } from '../../src/collector/model-install.mjs'

test('D47: src/off/ and the collector answer "proxy mode?" alike for every platform value either of them can see', () => {
  for (const p of [...MODEL_OS, 'linux', 'freebsd', 'aix', 'android', 'sunos', 'openbsd', undefined, null, '']) {
    assert.equal(isProxyMode(p), isModelOs(p), `the two copies disagree about ${JSON.stringify(p)}`)
  }
  assert.deepEqual([...MODEL_OS].sort(), ['darwin', 'win32'], 'and the list itself is the engine-as-local-proxy pair (D47)')
})
