// labels/capture.mjs — the words of the capture page and the capture log. Every table keys ONLY trocar's own closed sets for
// states that are not failures (the not_captured classes, the failure events that are not (where, code) pairs, the
// install-manifest roles). A failure's sentence — and an install / uninstall note's or residue result's — is never here:
// it is the CLI's one table (src/cli/words.mjs FAILURE_WORDS, via failureBrief). A harness-defined code is never a key
// here — its words arrive with the data. A value a table does not know is rendered as UNKNOWN_REASON with the raw value
// in the technical details — never dropped, never guessed. Command templates carry a <id> placeholder that the page
// fills with the spelling the answer itself used.
export const UNKNOWN_REASON = 'reason unknown'

// ── 当前条件:foldFlows 写出的七种 kind(1.9 §条件的话)────────────────────────────────────────────────────────
// `untrusted` 的话按它的 code 取(§TRUST_REASON / harness 自带);`state-mismatch` 的话要拼 desired/actual;`negative-cache` 是一条带
// (where, code) 的失败,话归 CLI 的 FAILURE_WORDS(failureWord);其余是固定句。
export const CONDITION_KIND = Object.freeze({
  degraded: 'the capture service lacks full system rights; some programs may not be captured',
  'helper-version': "the capture service's system component is the wrong version; some programs may not be captured",
})
// 期望态 on/off 的话(state-mismatch 的两个值、开关的期望态文字共用一份)
export const SWITCH_WORD = Object.freeze({ on: 'on', off: 'off' })

// ── 没在采的原因:话归共享目录 src/cli/words.mjs statusReason(CLI 的 NOTE 列,每个 status 原因码一句),看板不另写一份 ──
// 「为什么 · 怎么办」里原因带命令、却没有怎么办的话时说这一句,命令在技术细节(1.9 §展开)
export const FIX_IN_DETAILS = 'The command that fixes it is in the technical details'
// 这两个码的话是「重启 <agent> 后生效」(1.9 §每个 agent 一行 第 3 条;不画按钮)
export const RESTART_CODES = Object.freeze(['config-after-start', 'env-frozen'])

// ── 连接行的预期类 not_captured(src/health/codes.mjs NOT_CAPTURED_EXPECTED):按设计不记,只在页底技术细节计数。失败类的话归 CLI 的 FAILURE_WORDS。
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

// ── a residue result that is not a failure (every other result code is worded by the CLI's FAILURE_WORDS, failureWord) ──
export const CODE = Object.freeze({ ok: 'trusted' })

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
// ── 改动条目的种类(status changed[].what 的第一个词 = 安装清单的 kind,src/off/manifest.mjs KNOWN_KINDS 的成员;认不出的原样等宽)──
export const CHANGE_KIND = Object.freeze({
  'json-key': 'setting', 'json-array-item': 'list item', text: 'text block', 'owned-file': 'file trocar created',
  'proxy-entry': 'proxy setting', 'trust-entry': 'certificate setting',
})
// ── 还在转交的连接(status relayed 的三个计数,1.6 C.1 回执的键;只写不为 0 的)────────────────────────────────────
export const RELAYED = Object.freeze({ closing: 'closing', waiting: 'waiting to close', cut: 'dropped' })

// ── 命令(只出现在技术细节;每条都是 1.6 命令表 src/cli/commands.mjs 里的用法,cli-commands.test.mjs 守)──────────
// <id> 由页面按 status 文档 harnesses 的键填(前端不另存 CLI 名表)
export const COMMANDS = Object.freeze({
  on: 'trocar on <id>', off: 'trocar off <id>', status: 'trocar status <id>', doctor: 'trocar doctor <id>',
  install: 'trocar install', board: 'trocar board', setFull: 'trocar classes set <class> full', setLog: 'trocar classes set <class> log', helper: 'sudo trocar setup-helper', linger: 'loginctl enable-linger',
})

// ── `errors[].where` of the C.3 document this board reads (the closed set src/health/codes.mjs DOC_WHERE; not importable here) ──
export const ERR_WHERE = Object.freeze({ health: 'capture health', manifest: 'the install record' })

// ── 一行的控件(1.9 §开关):开关、Set up、确认框与回执 ─────────────────────────────────────────────────────────
export const CTL = Object.freeze({
  setup: 'Set up', turnOn: 'Start capturing', turnOff: 'Stop capturing',
  switchLabel: (name) => `Capture ${name}`,
  askOn: (name) => `Start capturing ${name}? Its new connections are recorded; trocar writes these files:`,
  askOff: (name) => `Stop capturing ${name}? Its new connections are no longer recorded; trocar undoes these changes:`,
  askSetup: (name) => `Set up ${name}? trocar adds what ${name} still needs to be captured:`,
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
