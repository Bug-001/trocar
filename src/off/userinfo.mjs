// src/off/userinfo.mjs — the one rule that hides a URL's userinfo (RFC 1.6 §1.2「不印凭据」, 1.9 §保真边界). Pure and import-free: the CLI's
// receipts and flows lines (io.mjs) and the board's page (web/v2/core/sensitive.mjs, through the daemon's shared-module allowlist, 4.4 静态面)
// hide by it, so the rule is written once (0.1 §2).

// A URL's `user:password@` is `***@`. The userinfo runs to the LAST `@` before the authority ends (a password may hold an `@` it did not escape,
// as a URL parser reads it) and never past a character a URL cannot hold raw — white space, `/ ? #`, `"`, a backtick, `< >` or a backslash — so it
// never runs out of a JSON string either. The sub-delims RFC 3986 lets a password carry raw (`!$&'()*+,;=`) are inside it. A user alone and a
// password alone are hidden the same way. Idempotent; text without a URL passes as it is.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"`<>\\@]*(?:@[^\s/?#"`<>\\@]*)*@/gi
export const hideUserinfo = (s) => String(s).replace(USERINFO, '$1***@')
/** The same over a JSON value (a receipt, a key's value): every string in it, as JSON; hideUserinfo never runs out of a JSON string. */
export const hideUserinfoIn = (v) => (v === undefined ? v : JSON.parse(hideUserinfo(JSON.stringify(v))))
