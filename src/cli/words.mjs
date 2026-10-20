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

