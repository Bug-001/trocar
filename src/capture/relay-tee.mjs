// relay-tee.mjs — Codex source. DEFERRED (X): Codex is already
// OpenAI-via-local-relay; the tee that emits the same D10 envelope is a build-RFC gap. Until it
// lands, Codex capture is INCOMPLETE and MUST be labeled so in the UI (invariant 4). This throws
// rather than silently no-op'ing so no caller mistakes absence for coverage.
export function createRelayTee() {
  throw new Error('relay-tee not implemented (RFC 4.1 Codex — deferred X). Codex capture is incomplete; label it in the UI.')
}
