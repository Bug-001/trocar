// words.mjs — the English wording table of the human-facing text the CLI and the board share (D46, D58): one sentence per failure code trocar can
// write (FAILURE_WORDS, via failureBrief) and per reason an agent is not captured (statusReason). The raw errno (EPERM, ENOSPC, ERR_*) is not
// translated; a code the table does not know falls back to `where/code` + reason, so nothing is hidden. The FULL reason is never changed or dropped
// by this module: `--json` and the flows/ records keep it verbatim (R5, R11) — this is the display layer only, and the code and reason a sentence
// stands for stay in the technical details (the board) and after the sentence (`trocar status --failures`).
const ERRNO = /^(E[A-Z0-9_]+|Z_[A-Z_]+|ERR_[A-Z0-9_]+)$/ // Node's own error codes (errno, ERR_*, zlib's Z_*), as src/health/codes.mjs spells them

/** One short English sentence per failure code trocar's writers can put into a log (src/health/codes.mjs's closed sets, the raw layer's journal
 *  outcomes and segment problems): the one catalog the CLI and the board word a failure group from (0.1 §2, D58②: no code on screen). A key is
 *  a bare `code`, or `where/code` where one code means two things under two `where`s (that key wins). A code that is also a status reason and
 *  has no key here reads statusReason's clause (below), so the two catalogs never word one code twice. */
export const FAILURE_WORDS = Object.freeze({
  // the background process (daemon) and its start
  'daemon/start-failed': 'the background process would not start',
  'start/start-failed': 'it would not start',
  crash: 'the background process crashed once',
  'unclean-stop': 'the last run did not stop cleanly',
  'stop-failed': 'it could not be stopped',
  'control-error': 'its control channel failed',
  'check-error': 'its self-check failed',
  'not-installed': 'trocar is not installed',
  'manifest-unreadable': 'the install record could not be read',
  'control-endpoint-held': "another process holds trocar's control channel, so the background process did not start",
  'query-failed': 'a query worker failed; the query was answered another way',
  'root-refused': 'refused: it was run as root',
  'root-token': 'refused: it was run as root',
  'elevated-token': 'refused: it was run elevated',
  // records and the raw layer (sealing, indexing, reading capture files)
  'record-error': 'a record could not be written',
  'file-replaced': 'the capture file was replaced',
  'log-gap': 'the event log has a gap',
  'seal-failed': 'a capture file could not be compressed; its plain copy is kept',
  'index-failed': 'the index of a capture file fell behind; the next read rebuilds it',
  'raw/failed': 'a capture file could not be compressed; its plain copy is kept',
  'raw/refused': 'a capture file was left uncompressed because it is still being written or is not a capture file',
  'record-unparseable': 'a captured record is not valid JSON, so it is left out of the index',
  'record-unreadable': 'a captured record could not be read',
  'segment-unreadable': 'a capture file could not be read',
  'index-unwritable': 'the index of a capture file could not be saved; answers are read from the file itself',
  // certificates and bundles
  'ca-invalid': "trocar's certificate cannot be used",
  'system-roots-unavailable': 'the certificate bundle has no system roots',
  'system-roots-unparsable': 'some system roots would not parse and are not in the bundle',
  'system-roots-partial': 'the certificate bundle is missing some system roots',
  'roots-changed': 'the system root certificates changed; the bundle was rebuilt',
  'bundle/missing': 'the certificate bundle is gone',
  missing: 'the file is gone',
  'cert-not-merged': 'a block in your certificate file is not a certificate; it was not merged into the bundle',
  'source-unreadable': 'a certificate file named in the agent config could not be read',
  'relative-path': 'a certificate given by a relative path was not carried over',
  // processes trocar follows
  'watch-failed': 'a process could not be watched',
  'unwatch-error': 'a process could not stop being watched',
  'judge-error': 'a process could not be judged',
  ambiguous: 'a process matches more than one agent',
  'exe-unreadable': "a process's program file could not be read",
  'config-error': "an agent's settings could not be read",
  'config-unreadable': 'a config file could not be read',
  'config-unparsable': 'a config file could not be parsed',
  'agent-list-invalid': 'the list of agent names could not be read, or holds items trocar cannot use',
  'harness-note': 'a note from the install',
  'unit-env-not-carried': "the login item's environment cannot carry the install's certificate variable",
  'holders-unreadable': 'the list of running processes could not be read',
  // connections (the engine, its doors, a connection row's not_captured)
  'lookup-miss': "a connection's destination could not be read",
  'describe-error': "a connection's program could not be described",
  'engine-error': 'the engine failed',
  'flow-write-failed': 'a connection log line could not be written',
  'trust-store-error': "the engine's certificate store failed",
  'negative-cache': "a program refused trocar's certificate, so its traffic to that host is passed on unread",
  'trust-rejected': "a program refused trocar's certificate under TLS, so that host is not captured",
  'client-rejected-leaf': "a connection whose program refused trocar's certificate",
  'upstream-slow': 'the upstream was slow',
  'leaf-error': 'a certificate could not be issued',
  'framer-error': 'a request could not be parsed',
  'unpaired-response': 'a response arrived with no request to pair it with',
  'prior-proxy-unknown': 'the proxy in use before trocar could not be told',
  'pac-peer-refused': "trocar's proxy auto-config door refused a program not shown to be yours",
  'pac-owner-unread': "trocar's proxy auto-config door could not tell whose program asked, so it answered without routing through trocar",
  'upstream-header-ignored': 'a routing header from a program that should not send one was ignored',
  untrusted: 'a connection from a program that does not trust trocar yet; passed on unread',
  untracked: 'a connection from a program trocar does not follow; passed on unread',
  'upstream-cert': "the upstream's certificate could not be read",
  'upstream-handshake': 'the handshake with the upstream did not finish',
  h2: 'an HTTP/2 connection could not be decrypted',
  'malformed-hello': "a program's handshake message could not be read",
  'ingress-auth-failed': 'a program did not answer the proxy challenge',
  'ingress-unknown': 'a program spoke something other than a proxy request to trocar',
  'engine-port-taken': "trocar's port is taken",
  'upstream-unavailable': 'the upstream could not be dialled',
  // a connection row forwarded by design (4.6 §记录「连接行」的预期类; `where` is the row's 'flow'): the reason when the reason decided the class, else not_captured
  'flow/not-an-agent': 'connections of programs that are not agents, passed on unread',
  'flow/agent-helper': "connections of an agent's helper programs, passed on unread",
  'flow/harness-off': 'connections of agents that are turned off, passed on unread',
  'flow/group-off': 'connections of agents still running after off, passed on unread',
  'flow/outside-host-set': 'connections of agents to hosts trocar does not read for them, passed on unread',
  'flow/other-user': "connections of another user's programs, passed on unread",
  'flow/not-verified': 'connections of agent forms or hosts not verified for capture yet, passed on unread',
  'flow/policy': 'connections to hosts trocar does not read, passed on unread',
  'flow/not-trust-path': "connections an agent makes without reading trocar's certificate, passed on unread",
  'flow/https-proxy': "connections through a proxy the agent did not set itself, passed on unread",
  'flow/proxy-refused': "connections the agent's proxy refused, its answer passed back",
  'flow/upstream-first': 'connections where the server spoke first, passed on unread',
  'flow/unknown-protocol': 'connections in a protocol trocar does not read, passed on unread',
  'flow/upgrade-not-followed': 'connections switched to a protocol trocar does not follow, passed on from there',
  'flow/error': 'connections that ended before anything was forwarded',
  // WebSocket recording
  'write-failed': 'a WebSocket message could not be written',
  'decode-failed': 'a WebSocket message could not be decoded',
  broken: 'a WebSocket connection broke mid-message',
  'recorder-error': 'the WebSocket recorder failed',
  // traffic classes and retention
  'pattern-invalid': 'a traffic pattern does not compile',
  'classes-unparsable': 'the traffic class table could not be parsed; the built-in one applies',
  'classes-unreadable': 'the traffic class table could not be read; the built-in one applies',
  'classes-bad-entry': 'the traffic class table holds an entry trocar cannot use',
  'classes-write-failed': 'the traffic class table could not be saved',
  'classes-log-failed': 'a change to the traffic class table was made but not logged',
  'classify-failed': 'a call could not be classified, so it is kept in full',
  // the capture helper and the kernel
  'helper-error': 'the capture helper failed',
  'heartbeat-failed': "the helper's heartbeat failed",
  'heartbeat-gap': "the helper's heartbeat stopped",
  'loader-down': 'the helper loader is not listening',
  'loader-timeout': 'the helper loader did not answer in time',
  'helper-start-failed': 'the capture helper would not start',
  'socktable-unavailable': "the system's connection table could not be read",
  'kernel-drops': 'the kernel dropped packets',
  // on / off, install / uninstall
  'state-mismatch': 'the kernel did not confirm the attach',
  'state-unparsable': 'the saved on/off state could not be read',
  'launchd-register-failed': 'the login item could not be registered',
  'task-register-failed': 'the login task could not be registered; a fallback is used',
  'unit-not-enabled': 'the login item is not enabled',
  'unit-not-disabled': 'the system refused to disable the login item during uninstall',
  'install-error': 'the install step failed',
  'install-pending': 'an install step is still waiting',
  'setup-needed': 'an agent needs setting up before capture can be turned on',
  'uninstall-error': 'the uninstall step failed',
  'left-unparsable': 'an uninstall left an item behind',
  'left-link': 'a change is a link and was not undone automatically',
  'entry-not-undone': 'a change written into a user file could not be undone',
  'reverted-not-identical': "trocar's text was removed, but the file was changed again since",
  'already-restored': 'that file was already restored',
  'left-user-value': 'a value of your own is still in the file',
  'still-trusting': "a running process still trusts trocar's certificate",
  'bundle-kept': 'a certificate bundle still in use is kept for now',
  'residue-not-removed': "files the agent wrote because of trocar's plugin are kept; reported, not deleted",
  'collectors-online': 'uninstall was refused: capture is still on for an agent, or a program may still be using trocar',
  // failure events that carry no code of their own (the group's code is the event)
  failure: 'a problem was recorded',
  'agent-untrusted': "a running agent does not trust trocar's certificate yet",
  'helper-down': 'the capture helper stopped',
  'helper-version-mismatch': 'the capture helper is the wrong version',
  'attach-failed': 'capture could not be attached',
  'detach-failed': 'capture could not be detached',
})

/** The sentence of a failure `code` (under `where`, when given), or null when neither this table nor statusReason knows it (an errno, an unknown code). */
export function failureWord(where, code, harness = '') {
  if (!code) return null
  const k = (key) => (Object.hasOwn(FAILURE_WORDS, key) ? FAILURE_WORDS[key] : null)
  const r = (where && k(`${where}/${code}`)) || k(code)
  if (r) return r
  const s = statusReason(code, { harness })
  return (s && s.text) || null
}

/** One line out of many: newlines and runs of whitespace become one space (a launchctl stderr with line breaks must not break the digest's alignment). */
export const squashed = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The whole reason, or its head (cut with ASCII dots: 1.6 §1.1 ⑦, the old Windows console prints no other symbol): the digest shows ~100 columns of it — the whole wall is one `--failures` away (R11: relocated, not dropped). */
export const briefText = (s, max = 100) => { const t = squashed(s); return t.length > max ? `${t.slice(0, max - 3)}...` : t }

/** One failure group (C.3 `failures.groups[]`: { where, code, reason, harness? }) in one sentence, for `status --failures`, the board's capture log and
 *  the overview alike: the catalog's sentence when it knows the code — the code and the raw reason are then the technical details' (the CLI prints the
 *  reason after it) — else the raw errno / `where/code` with the squashed reason, so an unknown code is never hidden; the `×count` multiplier is the caller's. */
export function failureBrief(g) {
  const word = failureWord(g && g.where, g && g.code, (g && g.harness) || '')
  if (word) return word
  const reason = briefText((g && g.reason) || '')
  if (g && g.code && ERRNO.test(String(g.code))) return [g.code, reason].filter(Boolean).join(' ')
  return [[...new Set([g && g.where, g && g.code].filter(Boolean))].join('/') || 'a record', reason].filter(Boolean).join(' ') // an event with no code of its own is named once
}

/** The status reasons a single harness defines (its descriptor's trust hints and entry checks; the 「a harness's own」 part of
 *  src/health/codes.mjs TRUST_REASONS and kimi's shim checks). Their own words come with the data; the clause here is the fallback. */
const HARNESS_OWN = new Set(['settings-ignored-managed-by-host', 'settings-ignored-restricted', 'settings-ignored-setting-sources', 'dsh-use-openssl-ca', 'dsh-node-too-old',
  'kimi-not-via-shim', 'kimi-npm-no-shim', 'shim-not-on-path', 'desktop-ca-override'])

/** The reason an agent is not captured (RFC 1.6 §3.5 NOTE column, D38): the one catalog, a clause for every code of
 *  src/health/codes.mjs STATUS_REASONS. → { text, fix, command } — `text` what is wrong ('' for `desired-off`), `fix` what to do in
 *  words or null, `command` the trocar command that fixes it or null — or null for a code with no clause (the caller says the reason
 *  is unknown). `harness` and `pid` are filled in where the clause names them. `trocar status` prints statusNote (the three on one
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
    'kimi-not-via-shim': [`${h} did not start through the program trocar installed`],
    'negative-cache': [`${h}${pid != null ? ` (pid ${pid})` : ''} refused trocar's certificate`, 'restart it'],
    'daemon-not-running': ['trocar is not running in the background'],
    'daemon-not-responding': ['trocar runs in the background but does not answer'],
    'helper-missing': ["trocar's capture helper is missing or is the wrong version"],
    'link-missing': ['trocar is not attached'],
    'entry-missing': ['the setting that points at trocar is gone', null, `trocar on ${h}`],
    'entry-changed': ['the setting that points at trocar holds something else'],
    'forwarder-down': [`trocar is not listening, so ${h} cannot connect`],
    'not-routed': [`new connections from ${h} do not go through trocar`],
    'route-loop': [`trocar's upstream for ${h} would be trocar itself`],
    'proxy-changed': [`${h}'s proxy setting is not the one trocar connected to`],
    'proxy-dead': [`the proxy ${h} is set to use is not running`],
    'proxy-unsupported': [`${h} does not support the proxy scheme it is set to use`],
    'elevated-agent': [`${h}${pid != null ? ` (pid ${pid})` : ''} runs elevated, so trocar only forwards it`],
    'upstream-unreachable': [`trocar cannot reach the proxy it uses for ${h}`],
    'cert-not-installed': ['certificates are not installed', null, 'trocar install'],
    'cert-root-missing': ["trocar's root certificate is no longer trusted", null, 'trocar install'],
    'cert-root-pending': ["trocar's root certificate is not trusted yet", null, 'trocar install'],
    'cert-root-declined': ["you declined trocar's root certificate"],
    'cert-key-missing': ["the key for trocar's root is gone"],
    'cert-intermediate-unavailable': ['trocar cannot sign certificates right now, so it only forwards'],
    'cert-bundle-missing': [`${h}'s certificate file no longer holds trocar's root`],
    'cert-tier-unreachable': [`this form of ${h} has no way to reach a certificate`],
    'not-verified': [`this form of ${h} is not verified yet, so trocar passes its traffic on without reading it`],
    'not-users-file': [`${h} points at a certificate file that is not yours`],
    'shim-not-on-path': [`${h} did not start through the program trocar installed`],
    'form-unsupported': [`this form of ${h} cannot be captured with the proxy it is set to use`],
    'outside-host-set': [`${h} talked to a host outside the ones trocar reads for it, so that traffic is only forwarded`],
    'chromium-child': [`a helper process of ${h} that makes no model calls; it is never decrypted`],
    // the trust resolver's generic reasons (src/collector/core/trust)
    'var-missing': ["this process's environment has no trocar trust entry in effect", null, 'trocar install'],
    'file-unreadable': ['the certificate file the trust entry points to could not be read', `fix the read permission of that file, then restart ${h}`],
    'ca-not-in-file': ["the certificate file in effect does not hold trocar's certificate", null, 'trocar install'],
    'replace-without-ca': ["a setting that replaces the root certificates points to a bundle without trocar's certificate", null, 'trocar install'],
    shadowed: ["a higher-priority setting without trocar's certificate overrides trocar's entry", 'change that setting', 'trocar install'],
    'verify-disabled': [`${h} turned off certificate checks on a connection itself, so trocar does not decrypt it`, 'turn the checks back on to have that connection recorded'],
    'marker-stale': ["the trust plugin's marker belongs to an earlier process with the same pid", `restart ${h} once`],
    'marker-pending': ["waiting for this process's trust plugin to report (up to tens of seconds after start)", 'this updates itself'],
    'ca-unusable': ["trocar's capture certificate cannot be used", null, 'trocar install'],
    'environ-unreadable': ["this process's environment could not be read, so its trust entry cannot be judged", `restart ${h} once`],
    'config-unreadable': ['one of its config files could not be read, so the trust entry in it does not count', `fix the read permission of that file, then restart ${h}`],
    'settings-unparsable': ['one of its settings files could not be parsed, so the trust entry in it does not count', `fix that file, then restart ${h}`],
    'settings-unreadable': ['one of its settings files could not be read, so whether it holds the certificate is not known', `fix the read permission of that file, then restart ${h}`],
    // a harness's own reasons (HARNESS_OWN): the words the data carries for them come first on the board
    'settings-ignored-managed-by-host': [`${h} is told by its host app to ignore the certificate setting in its settings files`],
    'settings-ignored-restricted': [`${h} runs in restricted mode, which ignores the certificate setting in its settings`],
    'settings-ignored-setting-sources': [`${h} was started with settings sources that leave out trocar's certificate setting`],
    'dsh-use-openssl-ca': [`${h} runs with --use-openssl-ca, under which trocar cannot add its certificate`, 'start it without that flag'],
    'dsh-node-too-old': [`${h} runs on a Node too old to add a certificate while running`, 'run it on a newer Node'],
    'kimi-npm-no-shim': [`this is the npm build of ${h}; trocar sets up only the installed one`],
    'desktop-ca-override': [`the desktop certificate setting of ${h} overrides the one trocar wrote`],
    'smart-app-control': [`Smart App Control is on, so trocar could not set up the install folder of ${h}`],
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
