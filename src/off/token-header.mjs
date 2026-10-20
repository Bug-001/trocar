// src/off/token-header.mjs — the header a token-guarded request carries (RFC 4.4 §每用户口令, 4.6 §控制面). Pure and import-free:
// the board's page loads it from the daemon's shared-module allowlist (4.4 静态面), and the control client re-exports it, so the name
// is written once (0.1 §2).
export const CONTROL_TOKEN_HEADER = 'x-asight-token'
