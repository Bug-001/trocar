// codes.mjs — the D38 closed sets (RFC 4.6 §记录「失败不静默」): every name a collector record may carry in
// `event`, `where`, `code` and `not_captured`, and which of them are failures. Writers (src/collector/**) and
// readers (`asight collector status`; later GET /api/capture-health) take the names from here and nowhere else.
// Leaf module (0.1 §2): it imports nothing.
//   A failure turns the board's indicator ⚠; an expected `not_captured` (not captured by design) is counted and
// listed, never ⚠. A Node errno (ENOSPC, EACCES, ERR_SSL_…) goes into `code` unchanged; free text only in `reason`.

/** not_captured on a connection row — capture went wrong. */
export const NOT_CAPTURED_FAILURE = Object.freeze(['untrusted', 'untracked', 'client-rejected-leaf', 'negative-cache', 'upstream-cert', 'upstream-handshake', 'leaf-error', 'h2', 'malformed-hello', 'ws-not-recorded'])
/** not_captured on a connection row — not captured by design. */
export const NOT_CAPTURED_EXPECTED = Object.freeze(['policy', 'not-trust-path', 'https-proxy', 'proxy-refused', 'upstream-first', 'unknown-protocol', 'upgrade-not-followed', 'error'])

/** Event lines that are failures. Every other event is a state change the reader folds conditions with. */
export const FAILURE_EVENTS = Object.freeze(['failure', 'agent-untrusted', 'helper-down', 'helper-version-mismatch', 'attach-failed', 'detach-failed', 'log-gap'])
export const STATE_EVENTS = Object.freeze(['switch', 'daemon-start', 'daemon-stop', 'agent-exit', 'agent-trusted', 'negative-cache-cleared', 'bundles-rebuilt', 'agent-transport', 'ca-ok', 'install-note', 'uninstall-note', 'mitm-start', 'mitm-stop', 'retention-ok', 'retention-set'])

/** Failure codes the failure recorder never folds by where + code: the reader folds each of them into a condition per
 *  (pid, host), so a folded line would make the pairs folded into it vanish (4.6 §事件与码, D1-1). Bounded: a (pid,
 *  host) is written at most once in the process's life. */
export const UNFOLDED_CODES = Object.freeze(['negative-cache'])

/** The part of asight a record comes from. */
export const WHERE = Object.freeze(['start', 'daemon', 'control', 'record', 'events', 'watch', 'harness', 'tracker', 'engine', 'ws', 'helper', 'heartbeat', 'state', 'switch', 'kernel', 'ca', 'bundle', 'install', 'uninstall',
  // the old capture (RFC 4.1 过渡期, ~/.asight/logs/mitm-events.ndjson; deleted with it)
  'mitm', 'proxy', 'sink', 'autostart', 'steer', 'shard',
  // the retention settings (D40, RFC 4.6 §记录「保存级别」): read by the collector's engine and by the old MITM / reverse proxy
  'retention'])

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
  // retention.json cannot be read / parsed / holds a cell that is neither full nor log (the call is kept in full), or the
  // classifier threw; a traffic pattern that does not compile is `pattern-invalid` (above), also under where 'retention'; a hand edit whose line in
  // the change log could not be written is `retention-log-failed` (the edit applies; the record of it is missing)
  retention: ['retention-unparsable', 'retention-unreadable', 'classify-failed', 'pattern-invalid', 'retention-log-failed'],
  switch: ['state-mismatch', 'state-unparsable'],
  kernel: ['kernel-drops'],
  ca: ['ca-invalid'],
  install: ['install-error', 'uninstall-error', 'left-unparsable', 'left-link', 'entry-not-undone', 'reverted-not-identical', 'already-restored', 'missing', 'left-user-value', 'still-trusting', 'bundle-kept', 'residue-not-removed', 'unit-not-enabled', 'unit-not-disabled'],
  legacy: ['tls-client-error', 'client-rejected-leaf', 'upstream-aborted', 'decode-failed', 'autostart-load-failed', 'steer-unreadable', 'steer-missing', 'shard-failed'],
})
export const CODES = Object.freeze([...new Set(Object.values(CODES_BY_PART).flat())])

const ERRNO = /^(E[A-Z0-9_]+|Z_[A-Z_]+)$/ // Node's own error codes (errno, ERR_*, zlib's Z_*), written as they are
const sets = { nc: new Set([...NOT_CAPTURED_FAILURE, ...NOT_CAPTURED_EXPECTED]), ncFail: new Set(NOT_CAPTURED_FAILURE), fail: new Set(FAILURE_EVENTS), event: new Set([...FAILURE_EVENTS, ...STATE_EVENTS]), where: new Set(WHERE), code: new Set(CODES) }

export const isCode = (c) => sets.code.has(c) || ERRNO.test(String(c))

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
