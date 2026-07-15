import test from 'node:test'
import assert from 'node:assert/strict'
import { generateCa, atraceOn, verifyCaNoSystemTrust } from '../../src/capture/onboard.mjs'

// The onboard concern (atrace-mkca CA generation / atrace-on + RFC 4.1 §验收5 "CA 无系统信任")
// is carved into an EXPLICITLY-FLAGGED deferred sub-unit (mirrors relay-tee's X marker). It is
// macOS-host-specific onboard, OUT OF SCOPE for this offline capture data-spine unit, and MUST NOT
// run `security` keychain commands in tests (必拒 采集安全#3: CA is import-only, never a system
// TLS weakener; tests never mutate/inspect the real keychain). Each export throws so the absence of
// onboard automation is never mistaken for coverage.
test('onboard §验收5 (CA-no-system-trust) is an explicit deferred gap, not a silent no-op', () => {
  for (const fn of [generateCa, atraceOn, verifyCaNoSystemTrust]) {
    assert.throws(() => fn(), /onboard not implemented .*验收5 CA-no-system-trust.*deferred/)
  }
})
