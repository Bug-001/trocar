// codes.mjs — the D38 closed sets (RFC 4.6 §记录「失败不静默」): every name a collector record may carry in
// `event`, `where`, `code` and `not_captured`, and which of them are failures. Writers (src/collector/**) and
// readers (`asight collector status`; later GET /api/capture-health) take the names from here and nowhere else.
// Leaf module (0.1 §2): it imports nothing.
//   A failure turns the board's indicator ⚠; an expected `not_captured` (not captured by design) is counted and
// listed, never ⚠. A Node errno (ENOSPC, EACCES, ERR_SSL_…) goes into `code` unchanged; free text only in `reason`.

/** not_captured on a connection row — capture went wrong. */
export const NOT_CAPTURED_FAILURE = Object.freeze(['untrusted', 'untracked', 'client-rejected-leaf', 'negative-cache', 'upstream-cert', 'leaf-error', 'h2', 'malformed-hello', 'ws-not-recorded'])
/** not_captured on a connection row — not captured by design. */
export const NOT_CAPTURED_EXPECTED = Object.freeze(['policy', 'not-trust-path', 'https-proxy', 'proxy-refused', 'upstream-first', 'unknown-protocol', 'upgrade-not-followed', 'error'])

/** Event lines that are failures. Every other event is a state change the reader folds conditions with. */
export const FAILURE_EVENTS = Object.freeze(['failure', 'agent-untrusted', 'helper-down', 'helper-version-mismatch', 'attach-failed', 'detach-failed', 'log-gap'])
export const STATE_EVENTS = Object.freeze(['switch', 'daemon-start', 'daemon-stop', 'agent-exit', 'agent-trusted', 'negative-cache-cleared', 'bundles-rebuilt', 'agent-transport', 'ca-ok', 'install-note', 'uninstall-note', 'mitm-start', 'mitm-stop'])

/** Failure codes the failure recorder never folds by where + code: the reader folds each of them into a condition per
 *  (pid, host), so a folded line would make the pairs folded into it vanish (4.6 §事件与码, D1-1). Bounded: a (pid,
 *  host) is written at most once in the process's life. */
export const UNFOLDED_CODES = Object.freeze(['negative-cache'])

/** The part of asight a record comes from. */
export const WHERE = Object.freeze(['start', 'daemon', 'control', 'record', 'events', 'watch', 'harness', 'tracker', 'engine', 'ws', 'helper', 'heartbeat', 'state', 'switch', 'kernel', 'ca', 'bundle', 'install', 'uninstall',
  // the old capture (RFC 4.1 过渡期, ~/.asight/logs/mitm-events.ndjson; deleted with it)
  'mitm', 'proxy', 'sink', 'autostart', 'steer', 'shard'])

/** The reasons a running agent is not (yet) trusted — the `code` of `agent-untrusted`, and of the `agent-exit` that ends
 *  it. Generic ones come from the resolver (core/trust/confirm.mjs, core/tracker.mjs); the rest are a harness's own
 *  (its descriptor's `trust.hints` keys, or the `ignored` reason of one of its settings layers). Core code names no
 *  harness (4.6 §结构), so the harness-defined slugs are listed here once, and test/health/codes.test.mjs fails when a
 *  descriptor defines one that is not. */
export const TRUST_REASONS = Object.freeze([
  'var-missing', 'env-frozen', 'config-after-start', 'start-time-unknown', 'file-unreadable', 'ca-not-in-file', 'replace-without-ca', 'shadowed',
  'verify-disabled', 'marker-stale', 'marker-pending', 'no-marker', 'ca-unusable', 'environ-unreadable', 'config-unreadable',
  'settings-unparsable', 'settings-unreadable',
  // a harness's own
  'settings-ignored-managed-by-host', 'settings-ignored-restricted', 'settings-ignored-setting-sources', 'dsh-use-openssl-ca', 'dsh-node-too-old',
  'kimi-not-via-shim', 'kimi-npm-no-shim', 'shim-not-on-path', 'desktop-ca-override',
])

/** Codes asight names itself, by part (the grouping is documentation; the set is flat). */
export const CODES_BY_PART = Object.freeze({
  daemon: ['not-installed', 'manifest-unreadable', 'root-refused', 'start-failed', 'unclean-stop', 'crash', 'stop-failed', 'control-error', 'check-error'],
  record: ['record-error', 'file-replaced'],
  tracker: ['judge-error', 'unwatch-error', 'ambiguous', 'exe-unreadable', 'watch-failed', 'config-error', 'settings-unparsable', 'settings-unreadable', 'environ-unreadable'],
  // a harness's configuration or files, read or written (the Claude Code settings layers have their own codes, above)
  harness: ['config-unreadable', 'config-unparsable', 'harness-note', 'shim-not-on-path', 'cert-not-merged', 'source-unreadable', 'relative-path', 'unit-env-not-carried'],
  trust: [...TRUST_REASONS],
  bundle: ['roots-changed', 'missing'],
  note: ['ok'], // the code of an agent-trusted line
  helper: ['helper-error', 'heartbeat-failed', 'heartbeat-gap', 'loader-down', 'loader-timeout'],
  engine: ['lookup-miss', 'describe-error', 'engine-error', 'leaf-error', 'flow-write-failed', 'system-roots-unavailable', 'trust-store-error', 'upstream-ca-unreadable', 'framer-error', 'negative-cache', 'upstream-slow', 'unpaired-response'],
  ws: ['write-failed', 'decode-failed', 'broken', 'recorder-error', 'pattern-invalid'],
  switch: ['state-mismatch', 'state-unparsable'],
  kernel: ['kernel-drops'],
  ca: ['ca-invalid'],
  install: ['install-error', 'uninstall-error', 'left-unparsable', 'left-link', 'entry-not-undone', 'reverted-not-identical', 'already-restored', 'missing', 'left-user-value', 'still-trusting', 'bundle-kept', 'residue-not-removed', 'unit-not-enabled', 'unit-not-disabled'],
  legacy: ['tls-client-error', 'client-rejected-leaf', 'upstream-aborted', 'decode-failed', 'autostart-load-failed', 'steer-unreadable', 'steer-missing', 'shard-failed'],
})
export const CODES = Object.freeze([...new Set(Object.values(CODES_BY_PART).flat())])

// What `asight off` writes (RFC 1.6 R1 / R2 / R3, D39⑦). A block of its own, below CODES and apart from the lists above, so that
// the lists other branches append to (D40: WHERE, STATE_EVENTS, CODES_BY_PART) stay edit-free here; `sets` below adds them.
// src/off/names.mjs holds the same names (src/off may import nothing outside itself); test/health/codes.test.mjs holds the two equal.
export const OFF_WHERE = Object.freeze(['off'])
export const OFF_EVENTS = Object.freeze(['off-note']) // a state change (the last one of a run carries kind:'result'), not a failure
export const OFF_CODES = Object.freeze(['backup-failed', 'backup-kept', 'undone-by-marker'])

// What `asight status` says of an agent that is not captured (RFC 1.6 §2 / V32, 4.6 §记录「事件与码的名字」): one name from this closed set, whatever the reason. asight's own, then every trust
// reason above (the resolver's and the harnesses' own). A block of its own, as the one above is, so the lists D40 appends to stay edit-free. `negative-cache` is also a code of the engine.
export const STATUS_OWN_REASONS = Object.freeze(['desired-off', 'entry-missing', 'entry-changed', 'link-missing', 'daemon-not-running', 'daemon-not-responding', 'helper-missing', 'negative-cache'])
export const STATUS_REASONS = Object.freeze([...new Set([...STATUS_OWN_REASONS, ...TRUST_REASONS])])

const ERRNO = /^(E[A-Z0-9_]+|Z_[A-Z_]+)$/ // Node's own error codes (errno, ERR_*, zlib's Z_*), written as they are
const sets = { nc: new Set([...NOT_CAPTURED_FAILURE, ...NOT_CAPTURED_EXPECTED]), ncFail: new Set(NOT_CAPTURED_FAILURE), fail: new Set(FAILURE_EVENTS), event: new Set([...FAILURE_EVENTS, ...STATE_EVENTS, ...OFF_EVENTS]), where: new Set([...WHERE, ...OFF_WHERE]), code: new Set([...CODES, ...OFF_CODES]) }

export const isCode = (c) => sets.code.has(c) || ERRNO.test(String(c))
export const isEvent = (e) => sets.event.has(e) // the sets checkRecord() judges by, for the static scans (test/health/codes.test.mjs): one rule, not two
export const isWhere = (w) => sets.where.has(w)

/** 'failure' | 'expected' | null — the class of a connection row's not_captured. */
export function notCapturedClass(nc) {
  if (nc == null) return null
  return sets.ncFail.has(nc) ? 'failure' : sets.nc.has(nc) ? 'expected' : null
}

/** A record that turns the indicator ⚠: a failure event, or a connection row the capture failed on. A row whose
 *  leaf the client refused says so in `reason` too (until every writer also sets not_captured). */
export function isFailure(r) {
  if (!r || typeof r !== 'object') return false
  if (r.event != null) return sets.fail.has(r.event)
  return notCapturedClass(r.not_captured) === 'failure' || r.reason === 'client-rejected-leaf'
}

/** Problems with one record against the closed sets ([] = fine). Tests run it over every line a writer produced. */
export function checkRecord(r) {
  const bad = []
  if (!r || typeof r !== 'object') return ['not an object']
  if (r.event != null) {
    if (!sets.event.has(r.event)) bad.push(`event ${JSON.stringify(r.event)}`)
    if (sets.fail.has(r.event) && typeof r.reason !== 'string') bad.push(`${r.event} without a reason`)
    if (r.event === 'failure' && (r.where == null || r.code == null)) bad.push('failure without where and code') // the fold key (D-3)
  } else if (r.not_captured != null && !sets.nc.has(r.not_captured)) bad.push(`not_captured ${JSON.stringify(r.not_captured)}`)
  if (r.where != null && !sets.where.has(r.where)) bad.push(`where ${JSON.stringify(r.where)}`)
  if (r.code != null && r.event != null && !isCode(r.code)) bad.push(`code ${JSON.stringify(r.code)}`)
  return bad
}
