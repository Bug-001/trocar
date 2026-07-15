// onboard.mjs — CA generation + keychain import + proxy steering (RFC 4.1 §onboard, lines 55-61)
// and its acceptance gate §验收5 "CA 无系统信任" (line 84: assert `security find-certificate`
// hits the login keychain AND the cert carries NO trust settings — never `add-trusted-cert -r
// trustRoot`).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// DEFERRED (onboard · macOS-host-specific) — mirrors relay-tee's "X" marker.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EXPLICIT RFC-SCOPE REDUCTION (recorded here, not buried): RFC 4.1 lists SIX acceptance tests
// (line 79). This offline data-spine unit delivers FIVE of them as offline node:test suites
// (envelope parity, byte-transparency, verbatim req_body, selective-decrypt routing, interruption
// → error envelope). The SIXTH — §验收5 "CA 无系统信任" — is carved OUT of the offline unit into
// THIS deferred sub-unit, because it is intrinsically macOS-host-specific: it can only be asserted
// by shelling out to `security find-certificate` / inspecting real login-keychain trust settings,
// which (a) cannot run in a hermetic offline test and (b) MUST NOT be executed as a side effect of
// `node --test` (the 必拒 采集安全#3 invariant — CA is import-only, never a system-wide TLS weakener;
// tests do not mutate the developer's keychain). The CA/leaf openssl recipe is instead exercised
// import-only + throwaway inside test/capture/mitm.test.mjs (no system trust), proving the MITM
// decrypt path works without touching machine trust.
//
// This throws (like relay-tee) rather than silently no-op'ing so no caller mistakes the absence of
// onboard automation for coverage. When this sub-unit lands it MUST ship, alongside atrace-mkca /
// atrace-on / atrace-off, the §验收5 gate:
//   1. `security find-certificate -c '<CA CN>' ~/Library/Keychains/login.keychain-db` succeeds
//      (CA present in the LOGIN keychain, import-only via `security add-certificates`);
//   2. the cert has NO trust settings — `security dump-trust-settings` / `trust-settings-export`
//      shows it is absent (never added with `add-trusted-cert -r trustRoot`);
//   3. removal is clean/reversible (`security delete-certificate`).
const DEFERRED = 'onboard not implemented (RFC 4.1 §验收5 CA-no-system-trust — deferred, macOS-host-specific). '
  + 'Out of scope for the offline capture data-spine unit; ship with atrace-mkca / atrace-on onboard sub-unit.'

// CA + leaf generation. Deferred — host onboard concern.
export function generateCa() { throw new Error(DEFERRED) }

// Import the CA into the login keychain (import-only, NO trust flag) + steer the proxy. Deferred.
export function atraceOn() { throw new Error(DEFERRED) }

// §验收5 gate: assert the CA is in the login keychain with zero trust settings. Deferred —
// requires the macOS `security` toolchain and MUST NOT mutate/inspect the real keychain in tests.
export function verifyCaNoSystemTrust() { throw new Error(DEFERRED) }
