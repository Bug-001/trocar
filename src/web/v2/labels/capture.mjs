// labels/capture.mjs — the words of the capture page and the capture log. Every table keys ONLY trocar's own closed sets for
// states that are not failures (the not_captured classes, the failure events that are not (where, code) pairs, the
// install-manifest roles, the residue results, the install / uninstall note codes). A failure's sentence is never here:
// it is the CLI's one table (src/cli/words.mjs FAILURE_WORDS, via failureBrief). A harness-defined code is never a key
// here — its words arrive with the data. A value a table does not know is rendered as UNKNOWN_REASON with the raw value
// in the technical details — never dropped, never guessed. Command templates carry a <id> placeholder that the page
// fills with the spelling the answer itself used.
export const UNKNOWN_REASON = 'reason unknown'

// ── 当前条件:foldFlows 写出的七种 kind(1.9 §条件的话)────────────────────────────────────────────────────────
// `untrusted` 的话按它的 code 取(§TRUST_REASON / harness 自带);`state-mismatch` 的话要拼 desired/actual;其余四种是固定句。
export const CONDITION_KIND = Object.freeze({
  'negative-cache': "one of its processes refused trocar's certificate",
  'ca-invalid': "trocar's certificate cannot be used",
  degraded: 'the capture service lacks full system rights; some programs may not be captured',
  'helper-version': "the capture service's system component is the wrong version; some programs may not be captured",
})
// 期望态 on/off 的话(state-mismatch 的两个值、开关的期望态文字共用一份)
export const SWITCH_WORD = Object.freeze({ on: 'on', off: 'off' })

// ── 通用信任原因(src/health/codes.mjs GENERIC_TRUST_REASONS:resolver / tracker / 守护进程自己的码)──────────────
// 每码两句:为什么(状态句里「没在采:」后面接的话)与怎么办(展开里「为什么 · 怎么办」的话)。harness 自己定义的
// 码(HARNESS_CODES:各 harness 的 trust hint 与入口自有码)绝不在此:它们的话随数据来。
export const TRUST_REASON = Object.freeze({
  'var-missing': { why: "this process's environment has no trocar trust entry in effect", fix: 'run trocar install again; it restores the trust entry' },
  'env-frozen': { why: 'this process started before its trust entry existed', fix: 'restart this agent; the new process is captured' },
  'config-after-start': { why: 'the trust entry was written after this process started', fix: 'restart this agent; the new process is captured' },
  'start-time-unknown': { why: "this process's start time could not be read, so whether it started after the trust entry is unknown", fix: 'restart this agent once' },
  'file-unreadable': { why: 'the certificate file the trust entry points to could not be read', fix: 'fix the read permission of that file, then restart this agent' },
  'ca-not-in-file': { why: "the certificate file in effect does not hold trocar's certificate", fix: 'run trocar install again; it rewrites that file' },
  'replace-without-ca': { why: "a setting that replaces the root certificates points to a bundle without trocar's certificate", fix: 'run trocar install again; it merges the certificate into that bundle' },
  shadowed: { why: "a higher-priority setting without trocar's certificate overrides trocar's entry", fix: 'change that setting, or run trocar install again' },
  'verify-disabled': { why: 'this agent turned off certificate checks on a connection itself; trocar does not decrypt it', fix: 're-enable the checks to have that connection recorded' },
  'marker-stale': { why: "the trust plugin's marker belongs to an earlier process with the same pid", fix: 'restart this agent once' },
  'marker-pending': { why: "waiting for this process's trust plugin to report (up to tens of seconds after start)", fix: 'wait; this row updates itself' },
  'no-marker': { why: "this process's trust plugin did not report adding trocar's certificate; reason unknown", fix: 'restart this agent once; if the plugin file is missing, run trocar install again' },
  'ca-unusable': { why: "trocar's capture certificate cannot be used, so no process's trust can be judged", fix: 'run trocar install again (it issues a new certificate)' },
  'environ-unreadable': { why: "this process's environment could not be read, so its trust entry cannot be judged", fix: 'restart this agent once' },
  'config-unreadable': { why: 'one of its config files could not be read, so the trust entry in it does not count', fix: 'fix the read permission of that file, then restart this agent' },
  'settings-unparsable': { why: 'one of its settings files could not be parsed, so the trust entry in it does not count', fix: 'fix that file, then restart this agent' },
  'settings-unreadable': { why: 'one of its settings files could not be read; whether it holds the certificate is unknown', fix: 'fix the read permission of that file, then restart this agent' },
})
// 这两个码的话是「重启 <agent> 后生效」(1.9 §每个 agent 一行 第 3 条;不画按钮)
export const RESTART_CODES = Object.freeze(['config-after-start', 'env-frozen'])

// ── 连接行的 not_captured(src/health/codes.mjs 两个闭集)───────────────────────────────────────────────────────
// 失败类:进采集记录,组键 flow:<码>;预期类:按设计不记,只在页底技术细节计数。
export const NOT_CAPTURED = Object.freeze({
  untrusted: 'the connection belongs to a process that does not trust trocar yet; not decrypted',
  untracked: 'the connection belongs to a process trocar does not follow',
  'client-rejected-leaf': "the program refused trocar's certificate",
  'negative-cache': "this process refused trocar's certificate before; not tried again for now",
  'upstream-cert': "the upstream's certificate could not be read",
  'upstream-handshake': 'the handshake with the upstream did not finish',
  'leaf-error': 'a certificate could not be issued',
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

// ── trocar's own codes of the last install / uninstall notes and of the residue results (not failures: a failure's words
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
  'reverted-not-identical': "trocar's text was removed, but the file was changed again since",
  'already-restored': 'that file was already restored',
  'left-user-value': 'a value of your own is still in the file',
  'still-trusting': "a running process still trusts trocar's certificate",
  'bundle-kept': 'a certificate bundle still in use is kept for now',
  'residue-not-removed': "files the agent wrote because of trocar's plugin are kept; reported, not deleted",
  'unit-not-disabled': 'the system refused to disable the login item during uninstall',

})

// ── 安装清单里 trocar 自己的文件(roles)────────────────────────────────────────────────────────────────────
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
  on: 'trocar on <id>', off: 'trocar off <id>', status: 'trocar status <id>', doctor: 'trocar doctor <id>',
  install: 'trocar install', board: 'trocar board', helper: 'sudo trocar setup-helper', linger: 'loginctl enable-linger',
})

// ── `errors[].where` of the C.3 document this board reads (the closed set src/health/codes.mjs DOC_WHERE; not importable here) ──
export const ERR_WHERE = Object.freeze({ health: 'capture health', manifest: 'the install record' })

// ── 采集记录的固定话 ─────────────────────────────────────────────────────────────────────────────────────
export const LOG = Object.freeze({
  who: 'capture service',
  window: (t) => `since ${t}`,
  filterRule: "by each group's own agent; a group counts once",
  truncated: 'only the latest part of the records was read; the list may be incomplete',
  none: 'no capture failures in the last 24 hours',
  metadataOnly: 'metadata only; no request or response bytes',
  manifestError: 'the install manifest could not be read',
  expectedTitle: 'not recorded by design (last 24 hours)',
})
