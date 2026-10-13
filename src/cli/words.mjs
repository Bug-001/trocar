// words.mjs — the zh-CN wording table of the human-facing CLI text (D46): `(where, code) → 一句中文` for the failure groups capture health folds, the
// same closed-set pattern `status`'s REASON_TEXT already used, now the one place every renderer takes its health words from. The raw errno (EPERM, ENOSPC,
// ERR_*) is not translated — it stays as the head of the brief with the squashed reason after it, exactly as the approved sample shows (`EPERM chmod
// $TMPDIR ×93`); a (where, code) the table does not know falls back to `where/code` + reason. The FULL English reason is never changed or dropped by this
// module: `--json` and the flows/ records keep it verbatim (R5, R11) — this is the display layer only, and it is lossy by design, so every place that
// prints a brief also points at where the whole wall lives (`asight status --failures`, `doctor`, the board).
const ERRNO = /^(E[A-Z0-9_]+|Z_[A-Z_]+|ERR_[A-Z0-9_]+)$/ // Node's own error codes (errno, ERR_*, zlib's Z_*), as src/health/codes.mjs spells them

/** `(where, code) → 短中文`,for the closed failure codes of 4.6 / 4.8 / 4.9 a person actually meets in a wall. */
export const FAILURE_WORDS = Object.freeze({
  // daemon / start
  'daemon/start-failed': '守护进程没起来', 'daemon/crash': '守护进程崩过一次', 'daemon/unclean-stop': '上次没停干净', 'daemon/stop-failed': '没停成', 'daemon/control-error': '控制面出错', 'daemon/check-error': '自检出错',
  'start/start-failed': '没起来', 'start/root-refused': '拒绝了 root 运行', 'start/root-token': '拒绝了 root 运行', 'start/elevated-token': '拒绝了提权运行',
  // record / events (R11's own failures)
  'record/record-error': '采集写不进', 'record/file-replaced': '采集文件被换掉了', 'events/log-gap': '事件日志有缺口',
  // tracker / trust / bundle
  'bundle/system-roots-unavailable': '合并包里没有系统根证书', 'tracker/watch-failed': '进程没看住', 'tracker/judge-error': '进程判不了', 'tracker/ambiguous': '进程认不出是哪一个 harness',
  // engine
  'engine/lookup-miss': '拿不到连接的原目的地', 'engine/engine-error': '引擎出错', 'engine/flow-write-failed': '流写不进', 'engine/negative-cache': '客户端拒了证书,那个 host 之后透传', 'engine/upstream-slow': '上游慢', 'engine/leaf-error': '出证书失败', 'engine/framer-error': '解析请求失败',
  // kernel / helper
  'kernel/kernel-drops': '内核丢了包', 'helper/helper-error': '能力助手出错', 'helper/heartbeat-failed': '助手心跳失败', 'helper/heartbeat-gap': '助手心跳断了', 'helper/loader-down': '助手装载器没在听',
  // switch / state
  'switch/state-mismatch': '内核没确认引流', 'switch/state-unparsable': '期望态文件读不了',
  // install / unit
  'install/launchd-register-failed': '自启单元没注册上(launchd 是唯一的自启)', 'install/unit-not-enabled': '自启单元没启用', 'install/install-error': '安装出错',
  // the proxy-mode ingress (4.8; the engines are their own proxies since D47 and its win32 twin — the kernel's words went with it)
  'ingress/ingress-auth-failed': '代理入口没答上', 'ingress/engine-port-taken': '引擎端口被占', 'ingress/upstream-unavailable': '上游拨不出去',
})

/** The short Chinese reason of a `(where, code)` pair, or null when the table does not know it (errno and unknown codes keep their raw shape). */
export const failureWord = (where, code) => (where && code ? FAILURE_WORDS[`${where}/${code}`] || null : null)

/** One line out of many: newlines and runs of whitespace become one space (a launchctl stderr with line breaks must not break the digest's alignment). */
export const squashed = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The whole reason, or its head: the digest shows ~100 columns of it — the whole wall is one `--failures` away (R11: relocated, not dropped). */
const briefText = (s, max = 100) => { const t = squashed(s); return t.length > max ? `${t.slice(0, max - 1)}…` : t }

/** One failure group as the digest's 「最新」 brief: the zh word when the table knows the code, else the raw errno / `where/code` with the squashed reason.
 *  `g` is what captureHealth's fold produced ({ count, last_ts, last: { event, where, code, reason, … } }); the `×count` multiplier is the caller's. */
export function failureBrief(g) {
  const l = (g && g.last) || {}
  const reason = briefText(l.reason || (l.error && l.error.message) || '')
  const word = failureWord(l.where, l.code)
  if (word) return reason ? `${word}(${reason})` : word
  if (l.code && ERRNO.test(String(l.code))) return [l.code, reason].filter(Boolean).join(' ')
  const head = [l.where, l.code].filter(Boolean).join('/')
  return [head || String(l.event || g.key || '记录'), reason].filter(Boolean).join(' ') // a row the fold knows only by its key still says which it was (R11)
}

/** The codex WebSocket hint (measured on a Windows test machine): Codex's WebSocket client on Windows does not read the `.env` block's `SSL_CERT_FILE`, so the
 *  WebSocket's TLS is not decrypted through the block asight writes — the door that works is the NAMED `cert-store-current-user` item (the CA into `CurrentUser\\Root`, Windows's own confirm
 *  dialog, never installed without the name). `on`'s plan and `doctor` print this line exactly while codex is a target on win32 and the item is not in the ledger; NOTHING is ever installed by it. */
export const CODEX_WS_CERT_HINT = 'Windows 上采 Codex 的 WebSocket 需要点名装证书: asight on codex --opt-in cert-store-current-user(会弹 Windows 自己的确认框,不弹不装)'

/** The Claude Desktop steering hint (measured on a macOS test machine): Desktop's model traffic lives in the Chromium
 *  network service, which ignores every proxy env var — the door that works is the NAMED `desktop-launcher` item (a launcher at ~/.asight/collector/bin/claude-desktop-asight that starts
 *  the real app with Chromium's --proxy-server at asight's loopback listener; the system proxy is never touched, D43⑥). `on`'s plan and `doctor` print this line exactly while claude-code
 *  is a target on darwin and the item is not in the ledger; NOTHING is ever installed by it. The needs_restart honesty rides in the line itself: only instances started through the
 *  launcher are steered, a running Desktop is untouched. */
export const DESKTOP_LAUNCHER_HINT = 'macOS 上采 Claude Desktop 需要点名建启动器: asight on claude-code --opt-in claude-code.desktop(写 ~/.asight/collector/bin/claude-desktop-asight;只有经它启动的 Desktop 才被引流,已在跑的 Desktop 不受影响——先退出再用它启动)'
