// labels/capture.mjs — the words of the capture page and the capture log. Every table keys ONLY asight's own closed sets for
// states that are not failures (the not_captured classes, the failure events that are not (where, code) pairs, the
// install-manifest roles, the residue results, the install / uninstall note codes). A failure's sentence is never here:
// it is the CLI's one table (src/cli/words.mjs FAILURE_WORDS, via failureBrief). A harness-defined code is never a key
// here — its words arrive with the data. A value a table does not know is rendered as UNKNOWN_REASON with the raw value
// in the technical details — never dropped, never guessed. Command templates carry a <id> placeholder that the page
// fills with the spelling the answer itself used.
export const UNKNOWN_REASON = 'reason unknown'

// ── 当前条件:foldFlows 写出的七种 kind(1.9 §条件的话)────────────────────────────────────────────────────────
// `untrusted` 的话按它的 code 取(§TRUST_REASON / harness 自带);`state-mismatch` 的话要拼 desired/actual;`negative-cache` 是一条带
// (where, code) 的失败,话归 CLI 的 FAILURE_WORDS(failureWord);其余是固定句。
export const CONDITION_KIND = Object.freeze({
  'ca-invalid': "asight's certificate cannot be used",
  degraded: 'the capture service lacks full system rights; some programs may not be captured',
  'helper-version': "the capture service's system component is the wrong version; some programs may not be captured",
})
// 期望态 on/off 的话(state-mismatch 的两个值、开关的期望态文字共用一份)
export const SWITCH_WORD = Object.freeze({ on: 'on', off: 'off' })

// ── 通用信任原因(src/health/codes.mjs GENERIC_TRUST_REASONS:resolver / tracker / 守护进程自己的码)──────────────
// 每码两句:为什么(状态句里「没在采:」后面接的话)与怎么办(展开里「为什么 · 怎么办」的话)。harness 自己定义的
// 码(HARNESS_CODES:各 harness 的 trust hint 与入口自有码)绝不在此:它们的话随数据来。
export const TRUST_REASON = Object.freeze({
  'var-missing': { why: "this process's environment has no asight trust entry in effect", fix: 'run asight install again; it restores the trust entry' },
  'env-frozen': { why: 'this process started before its trust entry existed', fix: 'restart this agent; the new process is captured' },
  'config-after-start': { why: 'the trust entry was written after this process started', fix: 'restart this agent; the new process is captured' },
  'start-time-unknown': { why: "this process's start time could not be read, so whether it started after the trust entry is unknown", fix: 'restart this agent once' },
  'file-unreadable': { why: 'the certificate file the trust entry points to could not be read', fix: 'fix the read permission of that file, then restart this agent' },
  'ca-not-in-file': { why: "the certificate file in effect does not hold asight's certificate", fix: 'run asight install again; it rewrites that file' },
  'replace-without-ca': { why: "a setting that replaces the root certificates points to a bundle without asight's certificate", fix: 'run asight install again; it merges the certificate into that bundle' },
  shadowed: { why: "a higher-priority setting without asight's certificate overrides asight's entry", fix: 'change that setting, or run asight install again' },
  'verify-disabled': { why: 'this agent turned off certificate checks on a connection itself; asight does not decrypt it', fix: 're-enable the checks to have that connection recorded' },
  'marker-stale': { why: "the trust plugin's marker belongs to an earlier process with the same pid", fix: 'restart this agent once' },
  'marker-pending': { why: "waiting for this process's trust plugin to report (up to tens of seconds after start)", fix: 'wait; this row updates itself' },
  'no-marker': { why: "this process's trust plugin did not report adding asight's certificate; reason unknown", fix: 'restart this agent once; if the plugin file is missing, run asight install again' },
  'ca-unusable': { why: "asight's capture certificate cannot be used, so no process's trust can be judged", fix: 'run asight install again (it issues a new certificate)' },
  'environ-unreadable': { why: "this process's environment could not be read, so its trust entry cannot be judged", fix: 'restart this agent once' },
  'config-unreadable': { why: 'one of its config files could not be read, so the trust entry in it does not count', fix: 'fix the read permission of that file, then restart this agent' },
  'settings-unparsable': { why: 'one of its settings files could not be parsed, so the trust entry in it does not count', fix: 'fix that file, then restart this agent' },
  'settings-unreadable': { why: 'one of its settings files could not be read; whether it holds the certificate is unknown', fix: 'fix the read permission of that file, then restart this agent' },
})
// 这两个码的话是「重启 <agent> 后生效」(1.9 §每个 agent 一行 第 3 条;不画按钮)
export const RESTART_CODES = Object.freeze(['config-after-start', 'env-frozen'])

// ── 连接行的 not_captured(src/health/codes.mjs 两个闭集)───────────────────────────────────────────────────────
// 失败类:进采集记录,组键 flow:<码>;预期类:按设计不记,只在页底技术细节计数。CLI 的 failureWord 已答的码不在这里。
export const NOT_CAPTURED = Object.freeze({
  untrusted: 'the connection belongs to a process that does not trust asight yet; not decrypted',
  untracked: 'the connection belongs to a process asight does not follow',
  'upstream-cert': "the upstream's certificate could not be read",
  'upstream-handshake': 'the handshake with the upstream did not finish',
  h2: 'an HTTP/2 connection could not be decrypted',
  'malformed-hello': "the program's handshake message could not be read",
  'ws-not-recorded': 'the WebSocket content was not recorded',
})
export const NOT_CAPTURED_EXPECTED = Object.freeze({
  policy: 'not recorded by policy',
  'not-trust-path': 'off the trust path',
  'https-proxy': 'through an HTTPS proxy',
  'proxy-refused': 'refused by the proxy',
  'upstream-first': 'upstream dialled first',
  'unknown-protocol': 'unknown protocol',
  'upgrade-not-followed': 'protocol upgrade not followed',
  error: 'connection error',
})

// ── asight's own codes of the last install / uninstall notes and of the residue results (not failures: a failure's words
// are the CLI's FAILURE_WORDS, looked up by (where, code) first). A Node errno or a harness-defined code is not here.
export const CODE = Object.freeze({
  // harness (reading / writing an agent's config and files)
  'harness-note': 'a note from the install',
  'cert-not-merged': 'a block in your certificate file is not a certificate; it was not merged into the bundle',
  'source-unreadable': 'a certificate file named in the agent config could not be read',
  'relative-path': 'a certificate given by a relative path was not carried over',
  'unit-env-not-carried': "the login item's environment cannot carry the install's certificate variable",
  'config-unreadable': 'a config file could not be read', 'config-unparsable': 'a config file could not be parsed',
  // bundle
  'roots-changed': 'the system root certificates changed; the bundle was rebuilt',
  missing: 'missing', // bundle (the bundle is gone) and install (a file to undo is gone) share this code
  ok: 'trusted',
  // install / uninstall
  'uninstall-error': 'the uninstall step failed',
  'left-link': 'a change is a link and was not undone automatically',
  'entry-not-undone': 'a change written into a user file could not be undone',
  'reverted-not-identical': "asight's text was removed, but the file was changed again since",
  'already-restored': 'that file was already restored',
  'left-user-value': 'a value of your own is still in the file',
  'still-trusting': "a running process still trusts asight's certificate",
  'bundle-kept': 'a certificate bundle still in use is kept for now',
  'residue-not-removed': "files the agent wrote because of asight's plugin are kept; reported, not deleted",
  'unit-not-disabled': 'the system refused to disable the login item during uninstall',

})

// ── 安装清单里 asight 自己的文件(roles)────────────────────────────────────────────────────────────────────
export const FILE_ROLE = Object.freeze({
  'ca-key': "the capture certificate's private key", 'ca-cert': 'capture certificate', unit: 'login item', bundle: 'merged certificate bundle',
  'trust-file': 'certificate file for the agent', plugin: 'trust plugin', shim: 'launch shim',
})

// ── 残留(status install.pending[].result):两种开头 + 每个结果一句话 ─────────────────────────────────────────────
export const RESIDUE_LEAD = Object.freeze({ unfinished: 'the install did not finish; left:', left: 'left behind by the uninstall:' })
export const residueLead = (result) => (result === 'install did not finish' ? RESIDUE_LEAD.unfinished : RESIDUE_LEAD.left)

// ── 引流方式(topology[].routing;字段在才画)────────────────────────────────────────
export const ROUTING = Object.freeze({ driver: 'driver mode', proxy: 'proxy mode', none: 'all off', unknown: 'unknown' })
export const CHANGE_REMOVAL = 'removed when its capture is turned off'

// ── 命令(只出现在技术细节;每条都是 1.6 命令表 src/cli/commands.mjs 里的用法,cli-commands.test.mjs 守)──────────
// <id> 由页面按 status 文档 harnesses 的键填(前端不另存 CLI 名表)
export const COMMANDS = Object.freeze({
  on: 'asight on <id>', off: 'asight off <id>', status: 'asight status <id>', doctor: 'asight doctor <id>',
  install: 'asight install', board: 'asight board', setFull: 'asight classes set <class> full', setLog: 'asight classes set <class> log', helper: 'sudo asight setup-helper', linger: 'loginctl enable-linger',
})

// ── `errors[].where` of the C.3 document this board reads (the closed set src/health/codes.mjs DOC_WHERE; not importable here) ──
export const ERR_WHERE = Object.freeze({ health: 'capture health', manifest: 'the install record' })

// ── 一行的控件(1.9 §开关):开关、Set up、确认框与回执 ─────────────────────────────────────────────────────────
export const CTL = Object.freeze({
  setup: 'Set up', turnOn: 'Start capturing', turnOff: 'Stop capturing',
  switchLabel: (name) => `Capture ${name}`,
  askOn: (name) => `Start capturing ${name}? Its new connections are recorded; asight writes these files:`,
  askOff: (name) => `Stop capturing ${name}? Its new connections are no longer recorded; asight undoes these changes:`,
  askSetup: (name) => `Set up ${name}? asight adds what ${name} still needs to be captured:`,
  stale: 'The computer changed since the last plan; this is the new plan.',
  noFiles: 'No file changes.',
  doneOn: 'On; new connections are captured', doneOff: 'Off; new connections are not captured', doneSetup: 'Set up done',
  refused: 'Refused, reason unknown',
  failed: (status, error) => `Failed: ${status ? `HTTP ${status}` : 'no answer'}${error ? ` · ${error}` : ''}`,
})

// ── 采集记录的固定话 ─────────────────────────────────────────────────────────────────────────────────────
export const LOG = Object.freeze({
  who: 'capture service',
  window: (t) => `since ${t}`,
  filterRule: "by each group's own agent; a group counts once",
  truncated: 'only the latest part of the records was read; the list may be incomplete',
  none: 'No capture failures in the last 24 hours',
  metadataOnly: 'metadata only; no request or response bytes',
  manifestError: 'the install manifest could not be read',
  expectedTitle: 'not recorded by design (last 24 hours)',
})
