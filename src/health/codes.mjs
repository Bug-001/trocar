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
export const STATE_EVENTS = Object.freeze(['switch', 'daemon-start', 'daemon-stop', 'agent-exit', 'agent-trusted', 'negative-cache-cleared', 'bundles-rebuilt', 'agent-transport', 'ca-ok', 'install-note', 'uninstall-note', 'mitm-start', 'mitm-stop', 'retention-ok', 'retention-set',
  'agent-list-ok', // ~/.asight/agents.json reads cleanly again, or is gone: ends the agent-list-invalid condition (D51③, 4.6 R6)
  'process-unknown']) // a process no list item claims used a door (where 'engine'; harness, door, name, wide, named = listed only with args it missed, pid; never its command line): once per (door group, name) per daemon life (D51⑥)

/** The `reason` of a door's `untracked` row (4.8 §5.2 · §5.3, 4.6 §连接行怎么落码): why the door could not vouch for the connection's process. */
export const UNTRACKED_REASONS = Object.freeze(['pid-unresolved', 'facts-unavailable', 'other-user', 'outside-host-set', 'agent-helper', 'cmdline-pending', 'not-an-agent', 'ambiguous', 'harness-off', 'group-off'])

/** Failure codes the failure recorder never folds by where + code: the reader folds each of them into a condition per
 *  (pid, host), so a folded line would make the pairs folded into it vanish (4.6 §事件与码, D1-1). Bounded: a (pid,
 *  host) is written at most once in the process's life. */
export const UNFOLDED_CODES = Object.freeze(['negative-cache', 'trust-rejected'])

/** The `level` a failure may carry (D51④, 4.6 §事件与码): `critical` — the reader puts it first, the daemon also tells stderr. No level = an ordinary failure. */
export const LEVELS = Object.freeze(['critical'])

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
  'kimi-not-via-shim', 'kimi-npm-no-shim', 'shim-not-on-path', 'desktop-ca-override', 'chromium-child',
  'route-without-ca', 'win-doors-rejected', // hermes: darwin's active route has no asight ssl_ca_cert; win32's doors rejected
])

/** Codes asight names itself, by part (the grouping is documentation; the set is flat). */
export const CODES_BY_PART = Object.freeze({
  daemon: ['not-installed', 'manifest-unreadable', 'root-refused', 'start-failed', 'unclean-stop', 'crash', 'stop-failed', 'control-error', 'check-error'],
  record: ['record-error', 'file-replaced'],
  tracker: ['judge-error', 'unwatch-error', 'ambiguous', 'exe-unreadable', 'watch-failed', 'config-error', 'settings-unparsable', 'settings-unreadable', 'environ-unreadable'],
  // a harness's configuration or files, read or written (the Claude Code settings layers have their own codes, above)
  harness: ['config-unreadable', 'config-unparsable', 'harness-note', 'shim-not-on-path', 'cert-not-merged', 'source-unreadable', 'relative-path', 'unit-env-not-carried', 'system-roots-unavailable', 'system-roots-unparsable', 'system-roots-partial',
    'agent-list-invalid'], // ~/.asight/agents.json cannot be read / parsed, or holds bad items (with `path` and `problems`; one per file version, D51③)
  trust: [...TRUST_REASONS],
  bundle: ['roots-changed', 'missing', 'system-roots-unavailable', 'system-roots-unparsable', 'system-roots-partial'], // the last three: the bundles of the harnesses that are on were (re)built with no OS root, without OS roots that did not parse, without a roots source whose read failed (4.6 「合并包」)
  note: ['ok'], // the code of an agent-trusted line
  helper: ['helper-error', 'heartbeat-failed', 'heartbeat-gap', 'loader-down', 'loader-timeout'],
  engine: ['lookup-miss', 'describe-error', 'engine-error', 'leaf-error', 'flow-write-failed', 'system-roots-unavailable', 'trust-store-error', 'upstream-ca-unreadable', 'framer-error', 'negative-cache', 'upstream-slow', 'unpaired-response',
    'trust-rejected'], // a decrypted connection whose client refused asight's leaf: level 'critical', one per (pid, host) (D51④)
  ws: ['write-failed', 'decode-failed', 'broken', 'recorder-error', 'pattern-invalid'],
  // retention.json cannot be read / parsed / holds a cell that is neither full nor log (the call is kept in full), or the
  // classifier threw; a traffic pattern that does not compile is `pattern-invalid` (above), also under where 'retention'; a hand edit whose line in
  // the change log could not be written is `retention-log-failed` (the edit applies; the record of it is missing)
  retention: ['retention-unparsable', 'retention-unreadable', 'classify-failed', 'pattern-invalid', 'retention-log-failed'],
  switch: ['state-mismatch', 'state-unparsable'],
  kernel: ['kernel-drops'],
  ca: ['ca-invalid'],
  install: ['install-error', 'uninstall-error', 'left-unparsable', 'left-link', 'entry-not-undone', 'reverted-not-identical', 'already-restored', 'missing', 'left-user-value', 'still-trusting', 'bundle-kept', 'residue-not-removed', 'unit-not-enabled', 'unit-not-disabled', 'optin-not-undone', 'needs-admin'], // the last two: the Windows collector's off-side — an opt-in item that could not be undone, a machine-level item left for the operator's elevated command (4.8 §4.2; the kernel-not-off row retired with the kernel, D47's twin)
  legacy: ['tls-client-error', 'client-rejected-leaf', 'upstream-aborted', 'decode-failed', 'autostart-load-failed', 'steer-unreadable', 'steer-missing', 'shard-failed'],
})
export const CODES = Object.freeze([...new Set(Object.values(CODES_BY_PART).flat())])

// What `asight off` writes (RFC 1.6 R1 / R2 / R3, D39⑦). A block of its own, below CODES and apart from the lists above (which carry D40's
// `retention` names): the branch that owned the blocks below is merged into this tree now, and they stay blocks all the same — each is held
// against its own RFC table by its own test (W38 below, V53 for the NET_* names), and folding them into WHERE / STATE_EVENTS / CODES_BY_PART
// is a closed-set restructuring that goes with the unit that owns those tables (1.6 §9.7), not a drive-by here; `sets` below adds them.
// src/off/names.mjs holds the same names (src/off may import nothing outside itself); test/health/codes.test.mjs holds the two equal.
export const OFF_WHERE = Object.freeze(['off'])
export const OFF_EVENTS = Object.freeze(['off-note']) // a state change (the last one of a run carries kind:'result'), not a failure
export const OFF_CODES = Object.freeze(['backup-failed', 'backup-kept', 'undone-by-marker'])

// What the Windows collector writes (RFC 4.8 §12; the kernel-era rows retired with the kernel — D47's darwin conversion and its win32 twin: the forwarder-* family, the download pair,
// the probe refresh and the fallback verdict have no producer on any arch now) and the names it shares with the netenv side (4.7 §5, D41; read-only since D43) and the CLI (1.6 §9.7).
// Blocks of their own, below OFF_*, for the reason OFF_* is: D40 edits WHERE / STATE_EVENTS / CODES_BY_PART, and the lists that
// another branch appends to stay edit-free here; `sets` below adds the blocks. test/health/codes.test.mjs holds each against the
// RFC's table written out by hand (W38).
export const ROUTE_WHERE = Object.freeze(['routing', 'ingress', 'optin']) // the choice and effect of a routing · the engine's proxy ingress (its per-group doors are the only local proxy) · the doing of an opt-in item
export const ROUTE_EVENTS = Object.freeze(['route-applied', 'optin-applied', 'optin-removed']) // state changes, not failures
/** `code` of a failure event, by the `where` the §12 table gives it. Every row of the table is the class 失败, so the next list is this one. */
export const ROUTE_CODES = Object.freeze([
  'ingress-auth-failed', 'ingress-unknown', 'engine-port-taken', 'upstream-unavailable', // ingress (`upstream-unavailable`: the group's upstream cannot be dialled at all, no login to dial it with or none to dial: the lookup refused, the agent got a 502)
  'optin-failed', // optin: an item the user named was not done (a refused prompt, a script error); a refused UAC is not this: it is `pending-admin` (1.6 §1.7)
  'socktable-unavailable', 'helper-start-failed', // helper
  'task-register-failed', // install: `on` still succeeds, through the HKCU Run fallback (4.8 §7)
  'launchd-register-failed', // install, darwin: the LaunchAgent would not register (4.9 §4) — launchd is the only autostart, so `on`'s receipt says it; no fallback exists to succeed through
  'elevated-token', // start
  'root-token', // start, darwin: `elevated-token`'s refusal under the darwin name — the daemon runs as the user and root is refused (4.9 §11)
])
/** The codes of ROUTE_CODES a writer puts on a `failure` event. Today that is all of them; a later notice-class code goes into ROUTE_CODES only. */
export const ROUTE_FAILURE_CODES = Object.freeze([...ROUTE_CODES])
/** Reasons a running agent is not trusted that the Windows collector adds (4.8 §5.4, §6.3): the `code` of `agent-untrusted`, as TRUST_REASONS' are. `env-unreadable-fill` is the tracker's fill-layer
 *  verdict of 4.8 §5.4 (landed with 8(v) without its list entry; named here by Task 10(b), whose finding-code list and status reasons both read this block); `smart-app-control` is the
 *  opt-in shim step's own refusal (4.8 §6.3, fail-closed).
 *  Listed apart from TRUST_REASONS (a list D40's neighbours read); test/health/codes.test.mjs counts both when it checks a harness's own. */
export const ROUTE_TRUST_REASONS = Object.freeze(['smart-app-control', 'env-unreadable-fill'])
/** What `status` says when a form is not captured, that the Windows collector adds (4.8 §2.3, §12). The status reason set itself is the CLI's
 *  (1.6 §2); its list takes these in. */
export const ROUTE_STATUS_REASONS = Object.freeze(['form-unsupported'])
/** The envelope's `capture`: how the call reached the engine (4.1 信封表, 4.8 §5.6): `transparent` (Linux, and the other per-process captures) or `proxy` (Windows: the call came through asight's own kernel, D43). */
export const CAPTURE_KINDS = Object.freeze(['transparent', 'proxy'])

// What the network topology and `asight doctor` write and say (RFC 1.6 §9.7, D39⑩, D43). A block of its own, like the ones above (they stay apart from WHERE / STATE_EVENTS / CODES_BY_PART for the same reason); `sets` below adds it.
// `netenv-change` is a state change (the topology moved: a proxy setting, the machine's network environment); `failure` with `where: 'netenv'` is written for the codes in NET_FAILURE_CODES, and for
// `proxy-changed` only when it leaves a harness that is on uncaptured (proxy mode, where the changed entry bypasses asight). D43 withdrew the VPN-block codes: the new collector writes nothing into a VPN.
// `route-loop`, `forwarder-down` and `egress-differs` are shared with 4.7 / 4.8 (D41, D43): each is defined here, once (test/health/codes.test.mjs W38 counts the literals).
export const NET_WHERE = Object.freeze(['netenv'])
export const NET_EVENTS = Object.freeze(['netenv-change'])
const ROUTE_LOOP = 'route-loop', FORWARDER_DOWN = 'forwarder-down', EGRESS_DIFFERS = 'egress-differs' // the names shared with 4.7 / 4.8: written once, used by name below
const NET_FAILURE_OWN = ['not-routed', 'proxy-dead', 'proxy-unsupported', 'elevated-agent', 'upstream-unreachable', 'shim-not-on-path', 'not-via-entry']
export const NET_CODES = Object.freeze([...NET_FAILURE_OWN, 'proxy-changed', 'netenv-changed', 'opt-in-needed', 'needs-admin', 'linger-off', 'system-proxy-pac', 'other-redirector', 'fake-ip', 'inferred-behaviour', 'cause-unknown', ROUTE_LOOP, FORWARDER_DOWN, EGRESS_DIFFERS])
export const NET_FAILURE_CODES = Object.freeze([...NET_FAILURE_OWN, ROUTE_LOOP, FORWARDER_DOWN])
// the net names `status` gives as the reason an agent is not captured (1.6 §9.7); the proxy-mode reasons of 4.8 §12 (`form-unsupported`) is ROUTE_STATUS_REASONS above; a process on no name list is `process-unknown` (a state event, D51⑥), not a status reason
const NET_STATUS_REASONS = Object.freeze(['not-routed', 'proxy-changed', 'elevated-agent', 'upstream-unreachable', 'opt-in-needed', 'shim-not-on-path', 'not-via-entry', ROUTE_LOOP, FORWARDER_DOWN])

// What `asight status` says of an agent that is not captured (RFC 1.6 §2 / V32, 4.6 §记录「事件与码的名字」): one name from this closed set, whatever the reason. asight's own, then every trust
// reason above (the resolver's and the harnesses' own). A block of its own, as the ones above are. The Windows collector's reasons (ROUTE_STATUS_REASONS: what a form that is not captured says; ROUTE_TRUST_REASONS: why a running agent is not trusted) are part of it. `negative-cache` is also a code of the engine.
export const STATUS_OWN_REASONS = Object.freeze(['desired-off', 'entry-missing', 'entry-changed', 'link-missing', 'daemon-not-running', 'daemon-not-responding', 'helper-missing', 'negative-cache'])
export const STATUS_REASONS = Object.freeze([...new Set([...STATUS_OWN_REASONS, ...NET_STATUS_REASONS, ...ROUTE_STATUS_REASONS, ...TRUST_REASONS, ...ROUTE_TRUST_REASONS])])

const ERRNO = /^(E[A-Z0-9_]+|Z_[A-Z_]+)$/ // Node's own error codes (errno, ERR_*, zlib's Z_*), written as they are
const sets = { nc: new Set([...NOT_CAPTURED_FAILURE, ...NOT_CAPTURED_EXPECTED]), ncFail: new Set(NOT_CAPTURED_FAILURE), fail: new Set(FAILURE_EVENTS), event: new Set([...FAILURE_EVENTS, ...STATE_EVENTS, ...OFF_EVENTS, ...ROUTE_EVENTS, ...NET_EVENTS]), where: new Set([...WHERE, ...OFF_WHERE, ...ROUTE_WHERE, ...NET_WHERE]),
  code: new Set([...CODES, ...OFF_CODES, ...ROUTE_CODES, ...ROUTE_TRUST_REASONS, ...NET_CODES]) }

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
