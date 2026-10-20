// words.mjs — the zh-CN wording table of the human-facing CLI text (D46): `(where, code) → 一句中文` for the failure groups capture health folds, the
// same closed-set pattern `status`'s REASON_TEXT already used, now the one place every renderer takes its health words from. The raw errno (EPERM, ENOSPC,
// ERR_*) is not translated — it stays as the head of the brief with the squashed reason after it, exactly as the approved sample shows (`EPERM chmod
// $TMPDIR ×93`); a (where, code) the table does not know falls back to `where/code` + reason. The FULL English reason is never changed or dropped by this
// module: `--json` and the flows/ records keep it verbatim (R5, R11) — this is the display layer only, and it is lossy by design, so every place that
// prints a brief also points at where the whole wall lives (`asight status --failures`, `doctor`, the board).
const ERRNO = /^(E[A-Z0-9_]+|Z_[A-Z_]+|ERR_[A-Z0-9_]+)$/ // Node's own error codes (errno, ERR_*, zlib's Z_*), as src/health/codes.mjs spells them

/** `(where, code)` -> one short English sentence, for the closed failure codes a person actually meets in a wall. */
export const FAILURE_WORDS = Object.freeze({
  'daemon/start-failed': 'the background process would not start',
  'daemon/crash': 'the background process crashed once',
  'daemon/unclean-stop': 'the last run did not stop cleanly',
  'daemon/stop-failed': 'it could not be stopped',
  'daemon/control-error': 'its control channel failed',
  'daemon/check-error': 'its self-check failed',
  'start/start-failed': 'it would not start',
  'start/root-refused': 'refused: it was run as root',
  'start/root-token': 'refused: it was run as root',
  'start/elevated-token': 'refused: it was run elevated',
  'record/record-error': 'a record could not be written',
  'record/file-replaced': 'the capture file was replaced',
  'events/log-gap': 'the event log has a gap',
  'bundle/system-roots-unavailable': 'the certificate bundle has no system roots',
  'bundle/system-roots-unparsable': 'some system roots would not parse and are not in the bundle',
  'bundle/system-roots-partial': 'the certificate bundle is missing some system roots',
  'tracker/watch-failed': 'a process could not be watched',
  'tracker/judge-error': 'a process could not be judged',
  'tracker/ambiguous': 'a process matches more than one harness',
  'engine/lookup-miss': 'a connection\'s destination could not be read',
  'engine/engine-error': 'the engine failed',
  'engine/flow-write-failed': 'a connection log line could not be written',
  'engine/negative-cache': 'a program refused asight\'s certificate, so its traffic to that host is passed on unread',
  'engine/trust-rejected': 'a program refused asight\'s certificate under TLS, so that host is not captured',
  'engine/upstream-slow': 'the upstream was slow',
  'engine/leaf-error': 'a certificate could not be issued',
  'engine/framer-error': 'a request could not be parsed',
  'kernel/kernel-drops': 'the kernel dropped packets',
  'helper/helper-error': 'the capture helper failed',
  'helper/heartbeat-failed': 'the helper\'s heartbeat failed',
  'helper/heartbeat-gap': 'the helper\'s heartbeat stopped',
  'helper/loader-down': 'the helper loader is not listening',
  'switch/state-mismatch': 'the kernel did not confirm the attach',
  'switch/state-unparsable': 'the saved on/off state could not be read',
  'install/launchd-register-failed': 'the login item could not be registered',
  'install/unit-not-enabled': 'the login item is not enabled',
  'install/install-error': 'the install step failed',
  'uninstall/left-unparsable': 'an uninstall left an item behind',
  'ingress/ingress-auth-failed': 'a program did not answer the proxy challenge',
  'ingress/engine-port-taken': 'asight\'s port is taken',
  'ingress/upstream-unavailable': 'the upstream could not be dialled',
  // a connection row the fold knows by its `not_captured` / `reason` alone (its group key is `flow:<code>`), not by a (where, code) pair
  'flow/client-rejected-leaf': 'a connection whose program refused asight\'s certificate',
})

/** The short reason of a `(where, code)` pair, or null when the table does not know it (errno and unknown codes keep their raw shape). */
export const failureWord = (where, code) => (where && code ? FAILURE_WORDS[`${where}/${code}`] || null : null)

/** One line out of many: newlines and runs of whitespace become one space (a launchctl stderr with line breaks must not break the digest's alignment). */
export const squashed = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The whole reason, or its head: the digest shows ~100 columns of it — the whole wall is one `--failures` away (R11: relocated, not dropped). */
const briefText = (s, max = 100) => { const t = squashed(s); return t.length > max ? `${t.slice(0, max - 1)}…` : t }

/** One failure group (C.3 `failures.groups[]`: { where, code, reason }) in one sentence, for `status --failures` and the board's capture log alike:
 *  the table's word when it knows (where, code), else the raw errno / `where/code`, with the squashed reason; the `×count` multiplier is the caller's. */
export function failureBrief(g) {
  const reason = briefText((g && g.reason) || '')
  const word = failureWord(g && g.where, g && g.code)
  if (word) return reason ? `${word} (${reason})` : word
  if (g && g.code && ERRNO.test(String(g.code))) return [g.code, reason].filter(Boolean).join(' ')
  return [[...new Set([g && g.where, g && g.code].filter(Boolean))].join('/') || 'a record', reason].filter(Boolean).join(' ') // an event with no code of its own is named once
}

/** The status reasons a single harness defines (its descriptor's trust hints and entry checks; the 「a harness's own」 part of
 *  src/health/codes.mjs TRUST_REASONS and kimi's shim checks). Their own words come with the data; the clause here is the fallback. */
const HARNESS_OWN = new Set(['settings-ignored-managed-by-host', 'settings-ignored-restricted', 'settings-ignored-setting-sources', 'dsh-use-openssl-ca', 'dsh-node-too-old',
  'kimi-not-via-shim', 'kimi-npm-no-shim', 'shim-not-on-path', 'desktop-ca-override'])

/** The reason an agent is not captured (RFC 1.6 §3.5 NOTE column, D38): the one catalog, a clause for every code of
 *  src/health/codes.mjs STATUS_REASONS. → { text, fix, command } — `text` what is wrong ('' for `desired-off`), `fix` what to do in
 *  words or null, `command` the asight command that fixes it or null — or null for a code with no clause (the caller says the reason
 *  is unknown). `harness` and `pid` are filled in where the clause names them. `asight status` prints statusNote (the three on one
 *  line); the board says the text and the fix and puts the command in its technical details (1.9), so the two faces word one reason
 *  one way. */
export function statusReason(code, { harness = '', pid = null } = {}) {
  const h = harness || 'it', who = pid != null ? `pid ${pid}` : h
  const M = {
    'desired-off': [''],
    'config-after-start': [`${who} started before capture was on`, `restart ${h}`],
    'env-frozen': [`${who} started before capture was on`, `restart ${h}`],
    'start-time-unknown': [`when ${pid != null ? `pid ${pid}` : 'it'} started could not be read`, `restart ${h}`],
    'no-marker': [`${who} started before capture was on`, `restart ${h}`],
    'kimi-not-via-shim': [`${h} did not start through the program asight installed`],
    'negative-cache': [`${h}${pid != null ? ` (pid ${pid})` : ''} refused asight's certificate`, 'restart it'],
    'daemon-not-running': ['asight is not running in the background'],
    'daemon-not-responding': ['asight runs in the background but does not answer'],
    'helper-missing': ["asight's capture helper is missing or is the wrong version"],
    'link-missing': ['asight is not attached'],
    'entry-missing': ['the setting that points at asight is gone', null, `asight on ${h}`],
    'entry-changed': ['the setting that points at asight holds something else'],
    'forwarder-down': [`asight is not listening, so ${h} cannot connect`],
    'not-routed': [`new connections from ${h} do not go through asight`],
    'route-loop': [`asight's upstream for ${h} would be asight itself`],
    'proxy-changed': [`${h}'s proxy setting is not the one asight connected to`],
    'proxy-dead': [`the proxy ${h} is set to use is not running`],
    'proxy-unsupported': [`${h} does not support the proxy scheme it is set to use`],
    'elevated-agent': [`${h}${pid != null ? ` (pid ${pid})` : ''} runs elevated, so asight only forwards it`],
    'upstream-unreachable': [`asight cannot reach the proxy it uses for ${h}`],
    'cert-not-installed': ['certificates are not installed', null, 'asight install'],
    'cert-root-missing': ["asight's root certificate is no longer trusted", null, 'asight install'],
    'cert-root-pending': ["asight's root certificate is not trusted yet", null, 'asight install'],
    'cert-root-declined': ["you declined asight's root certificate"],
    'cert-key-missing': ["the key for asight's root is gone"],
    'cert-intermediate-unavailable': ['asight cannot sign certificates right now, so it only forwards'],
    'cert-bundle-missing': [`${h}'s certificate file no longer holds asight's root`],
    'cert-tier-unreachable': [`this form of ${h} has no way to reach a certificate`],
    'not-verified': [`this form of ${h} is not verified yet, so asight passes its traffic on without reading it`],
    'not-users-file': [`${h} points at a certificate file that is not yours`],
    'shim-not-on-path': [`${h} did not start through the program asight installed`],
    'form-unsupported': [`this form of ${h} cannot be captured with the proxy it is set to use`],
    'outside-host-set': [`${h} talked to a host outside the ones asight reads for it, so that traffic is only forwarded`],
    'chromium-child': [`a helper process of ${h} that makes no model calls; it is never decrypted`],
    // the trust resolver's generic reasons (src/collector/core/trust)
    'var-missing': ["this process's environment has no asight trust entry in effect", null, 'asight install'],
    'file-unreadable': ['the certificate file the trust entry points to could not be read', `fix the read permission of that file, then restart ${h}`],
    'ca-not-in-file': ["the certificate file in effect does not hold asight's certificate", null, 'asight install'],
    'replace-without-ca': ["a setting that replaces the root certificates points to a bundle without asight's certificate", null, 'asight install'],
    shadowed: ["a higher-priority setting without asight's certificate overrides asight's entry", 'change that setting', 'asight install'],
    'verify-disabled': [`${h} turned off certificate checks on a connection itself, so asight does not decrypt it`, 'turn the checks back on to have that connection recorded'],
    'marker-stale': ["the trust plugin's marker belongs to an earlier process with the same pid", `restart ${h} once`],
    'marker-pending': ["waiting for this process's trust plugin to report (up to tens of seconds after start)", 'this updates itself'],
    'ca-unusable': ["asight's capture certificate cannot be used", null, 'asight install'],
    'environ-unreadable': ["this process's environment could not be read, so its trust entry cannot be judged", `restart ${h} once`],
    'config-unreadable': ['one of its config files could not be read, so the trust entry in it does not count', `fix the read permission of that file, then restart ${h}`],
    'settings-unparsable': ['one of its settings files could not be parsed, so the trust entry in it does not count', `fix that file, then restart ${h}`],
    'settings-unreadable': ['one of its settings files could not be read, so whether it holds the certificate is not known', `fix the read permission of that file, then restart ${h}`],
    // a harness's own reasons (HARNESS_OWN): the words the data carries for them come first on the board
    'settings-ignored-managed-by-host': [`${h} is told by its host app to ignore the certificate setting in its settings files`],
    'settings-ignored-restricted': [`${h} runs in restricted mode, which ignores the certificate setting in its settings`],
    'settings-ignored-setting-sources': [`${h} was started with settings sources that leave out asight's certificate setting`],
    'dsh-use-openssl-ca': [`${h} runs with --use-openssl-ca, under which asight cannot add its certificate`, 'start it without that flag'],
    'dsh-node-too-old': [`${h} runs on a Node too old to add a certificate while running`, 'run it on a newer Node'],
    'kimi-npm-no-shim': [`this is the npm build of ${h}; asight sets up only the installed one`],
    'desktop-ca-override': [`the desktop certificate setting of ${h} overrides the one asight wrote`],
    'smart-app-control': [`Smart App Control is on, so asight could not set up the install folder of ${h}`],
  }
  if (!Object.hasOwn(M, code)) return null
  const [text, fix = null, command = null] = M[code]
  return { text, fix, command, harnessOwn: HARNESS_OWN.has(code) }
}

/** statusReason as the CLI's one line: what is wrong; what to do; `run: <command>`. null for a code with no clause. */
export function statusNote(code, opts) {
  const r = statusReason(code, opts)
  return r && [r.text, r.fix, r.command && `run: ${r.command}`].filter(Boolean).join('; ')
}
