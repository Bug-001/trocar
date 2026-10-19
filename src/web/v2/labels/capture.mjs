// labels/capture.mjs — the words of 采集 + 采集记录 (1.9). Every table keys ONLY asight's own closed sets (1.5 §数据规则):
// the D38 codes of src/health/codes.mjs CODES_BY_PART minus the harness-defined part, the not_captured classes, the
// failure events, the install-manifest roles, the residue results. A harness-defined code (HARNESS_CODES) is never a
// key here — its words arrive with the data (`text`, S15; before that the server's `reason` as-is) and the code rides
// in 技术细节. A value a table does not know is rendered as 「原因未知」 with the raw value in 技术细节 — never dropped,
// never guessed. The tables of switch.harnesses / netenv / opt_in are only read when the answer carries the field; the
// command templates carry a <id> placeholder that the page fills with the spelling the answer itself used.
// 一个值表里没有 → 「原因未知」,原值留在技术细节(1.5 §数据规则 / 1.9 §条件的话)
export const UNKNOWN_REASON = '原因未知'

// ── 当前条件:foldFlows 写出的七种 kind(1.9 §条件的话)────────────────────────────────────────────────────────
// `untrusted` 的话按它的 code 取(§TRUST_REASON / harness 自带);`state-mismatch` 的话要拼 desired/actual;其余四种是固定句。
export const CONDITION_KIND = Object.freeze({
  'negative-cache': '它的一个进程不认 asight 的证书',
  'ca-invalid': 'asight 的证书不能用',
  degraded: '采集服务没有完整的系统权限,部分程序可能采不到',
  'helper-version': '采集服务的系统组件版本不对,部分程序可能采不到',
})
// 期望态 on/off 的话(state-mismatch 的两个值、开关的期望态文字共用一份)
export const SWITCH_WORD = Object.freeze({ on: '开着', off: '关着' })

// ── 通用信任原因(src/health/codes.mjs GENERIC_TRUST_REASONS:resolver / tracker / 守护进程自己的码)──────────────
// 每码两句:为什么(状态句里「没在采:」后面接的话)与怎么办(展开里「为什么 · 怎么办」的话)。harness 自己定义的
// 码(HARNESS_CODES:各 harness 的 trust hint 与入口自有码)绝不在此:它们的话随数据来。
export const TRUST_REASON = Object.freeze({
  'var-missing': { why: '这个进程的环境里没有生效的 asight 信任入口', fix: '重新安装一次采集,asight 会把信任入口补上' },
  'env-frozen': { why: '这个进程活得比信任入口久,它启动时还没有这个入口', fix: '重启这个 agent,新启动的进程会被采集' },
  'config-after-start': { why: '信任入口是在这个进程启动之后写进去的', fix: '重启这个 agent,新启动的进程会被采集' },
  'start-time-unknown': { why: '读不出这个进程的启动时间,没法判断它是不是在信任入口写好之后才启动', fix: '重启一次这个 agent' },
  'file-unreadable': { why: '信任入口指向的证书文件读不出来', fix: '修好那个文件的读取权限,再重启这个 agent' },
  'ca-not-in-file': { why: '生效的证书文件里没有 asight 的证书', fix: '重新安装一次采集,asight 会重写这个文件' },
  'replace-without-ca': { why: '一项替换根证书的设置指向的证书包里没有 asight 的证书', fix: '重新安装一次采集,asight 会把证书并进那个包' },
  shadowed: { why: '一项优先级更高、不含 asight 证书的设置盖住了 asight 的入口', fix: '调整那项设置,或重新安装一次采集' },
  'verify-disabled': { why: '这个 agent 自己把某条链路的证书校验关了,asight 不解密它', fix: '让它恢复校验,这条链路才会被记录' },
  'marker-stale': { why: '信任插件的标记属于更早的一个同号进程', fix: '重启一次这个 agent' },
  'marker-pending': { why: '还在等这个进程里的信任插件报告(它启动后至多几十秒)', fix: '稍等,这一行会自己更新' },
  'no-marker': { why: '这个进程的信任插件没有报告加上 asight 的证书,原因不明', fix: '重启一次这个 agent;插件文件不在时,重新安装一次采集' },
  'ca-unusable': { why: 'asight 的采集证书本身不能用,任何进程的信任都没法判', fix: '重新安装一次采集(会换一张证书)' },
  'environ-unreadable': { why: '这个进程的环境变量读不出来,信任入口没法判', fix: '重启一次这个 agent' },
  'config-unreadable': { why: '它的一份配置文件读不出来,里面的信任入口没法算数', fix: '修好那个文件的读取权限,再重启这个 agent' },
  'settings-unparsable': { why: '它的一份设置文件解析不了,里面的信任入口没法算数', fix: '修好那个文件,再重启这个 agent' },
  'settings-unreadable': { why: '它的一份设置文件读不出来,是否含着证书不知道', fix: '修好那个文件的读取权限,再重启这个 agent' },
})
// 这两个码的话是「重启 <agent> 后生效」(1.9 §每个 agent 一行 第 3 条;不画按钮)
export const RESTART_CODES = Object.freeze(['config-after-start', 'env-frozen'])

// ── 连接行的 not_captured(src/health/codes.mjs 两个闭集)───────────────────────────────────────────────────────
// 失败类:进采集记录,组键 flow:<码>;预期类:按设计不记,只在页底技术细节计数。
export const NOT_CAPTURED = Object.freeze({
  untrusted: '连接属于一个还没被信任的进程,没有解密',
  untracked: '连接属于一个 asight 没在跟的进程',
  'client-rejected-leaf': '客户端拒绝了 asight 签的叶子证书',
  'negative-cache': '这个进程之前拒绝过 asight 的证书,先不再尝试',
  'upstream-cert': '上游的证书读不到',
  'upstream-handshake': '和上游的握手没有完成',
  'leaf-error': '签叶子证书时出错',
  h2: 'HTTP/2 连接没能解密',
  'malformed-hello': '客户端的握手消息读不懂',
  'ws-not-recorded': 'WebSocket 的内容没有记下',
})
export const NOT_CAPTURED_EXPECTED = Object.freeze({
  policy: '按策略不记的连接',
  'not-trust-path': '不经信任路径的连接',
  'https-proxy': 'HTTPS 代理的连接',
  'proxy-refused': '代理拒绝的连接',
  'upstream-first': '先连上游的连接',
  'unknown-protocol': '认不出的协议',
  'upgrade-not-followed': '没有跟随的协议升级',
  error: '出错的连接',
})

// ── 失败事件(FAILURE_EVENTS 里除 failure / agent-untrusted 之外的固定话)──────────────────────────────────────
export const FAILURE_EVENT = Object.freeze({
  'helper-down': '按进程截流的系统组件没在运行',
  'helper-version-mismatch': '按进程截流的系统组件版本不对',
  'attach-failed': '开始截流一个进程时失败',
  'detach-failed': '停止截流一个进程时失败',
  'log-gap': '事件日志中断了一段时间',
})

// ── asight 自己的失败码(CODES_BY_PART 去掉 harness 定义的部分;一张平表,键是码本身)──────────────────────────
// 采集记录的组、上次安装 / 卸载的笔记、改动块的残留结果都从这里取话。Node 自己的错误码(E*、ERR_*、Z_*)不在此,
// 渲染成「系统错误 <码>」;harness 定义的码不在闭集里,用数据自带的话。
export const CODE = Object.freeze({
  // daemon
  'not-installed': '采集服务还没有安装',
  'manifest-unreadable': '安装清单读不出来',
  'root-refused': '系统拒绝了需要 root 的一步',
  'start-failed': '采集服务启动失败',
  'unclean-stop': '采集服务没有干净地停下',
  crash: '采集服务崩溃了',
  'stop-failed': '停止采集服务时有一步失败',
  'control-error': '控制命令出错',
  'check-error': '检查采集状态时出错',
  // record
  'record-error': '写采集记录时出错',
  'file-replaced': '采集文件被别的程序换掉了',
  // tracker
  'judge-error': '判断一个进程属于哪个 agent 时出错',
  'unwatch-error': '停止监视一个进程时出错',
  ambiguous: '一个进程认不出属于哪个 agent',
  'exe-unreadable': '进程的可执行文件读不出来',
  'watch-failed': '开始监视一个进程时失败',
  'config-error': '读一个 agent 的配置时出错',
  // harness(读 / 写一个 agent 的配置与文件)
  'harness-note': '安装时的一句提示',
  'cert-not-merged': '用户证书文件里有一块不是证书,没有并进证书包',
  'source-unreadable': 'agent 配置里点名的用户证书文件读不出来',
  'relative-path': '一条相对路径的用户证书没有带过去',
  'unit-env-not-carried': '自启服务的环境里带不上安装时的证书变量',
  // trust 的通用码在 TRUST_REASON(键相同,话分两句);config-unparsable 是 asight 自己的码。shim-not-on-path
  // 是 harness 定义的码(一个 harness 的 trust hint),不在此:harness 码的话随数据来,码进技术细节
  'config-unreadable': '一份配置文件读不出来', 'config-unparsable': '一份配置文件解析不了',
  // bundle
  'roots-changed': '系统根证书变了,证书包已重建',
  missing: '该在的东西已经不在了', // bundle(证书包不在)与 install(要撤的文件不在)共用这一个码
  // note
  ok: '已信任',
  // helper
  'helper-error': '与按进程截流的系统组件通信出错',
  'heartbeat-failed': '系统组件的心跳没有来',
  'heartbeat-gap': '系统组件的心跳断了一段',
  'loader-down': 'eBPF 加载器没在运行',
  'loader-timeout': '等 eBPF 加载器超时',
  // engine
  'lookup-miss': '一条引擎对不上的连接',
  'describe-error': '向引擎描述一个进程时出错',
  'engine-error': '引擎出错',
  'flow-write-failed': '写连接记录时失败',
  'system-roots-unavailable': '系统根证书读不出来',
  'trust-store-error': '读信任库时出错',
  'upstream-ca-unreadable': '上游的 CA 证书读不出来',
  'framer-error': '拆连接的帧时出错',
  'upstream-slow': '上游响应太慢',
  'unpaired-response': '一条响应配不上它的请求',
  // ws
  'write-failed': '写 WebSocket 记录时失败',
  'decode-failed': '解 WebSocket 的帧时出错',
  broken: 'WebSocket 连接断了',
  'recorder-error': 'WebSocket 记录器出错',
  'pattern-invalid': '一个正则表达式编译不过',
  'classify-failed': '给调用分类时出错',
  // switch
  'state-mismatch': '期望的状态和内核里的不一致',
  'state-unparsable': '期望态文件解析不了',
  // kernel
  'kernel-drops': '内核丢了一部分包',
  // ca
  'ca-invalid': 'asight 的证书不能用',
  // install / uninstall
  'install-error': '安装时出错',
  'uninstall-error': '卸载时出错',
  'left-unparsable': '卸载留下的清单解析不了',
  'left-link': '一项改动是一个链接,没有自动撤掉',
  'entry-not-undone': '一条写进用户文件的改动没能撤掉',
  'reverted-not-identical': 'asight 的文字撤掉了,但那之后文件又被改过',
  'already-restored': '那个文件已经恢复过了',
  'left-user-value': '一条用户自己的值还留在文件里',
  'still-trusting': '一个还在跑的进程仍然信任 asight 的证书',
  'bundle-kept': '一个还在被使用的证书包先留着',
  'residue-not-removed': 'agent 因为 asight 的插件写下的文件留着,只报告,不删',
  'unit-not-enabled': '自启服务写好了,但系统拒绝启用它',
  'unit-not-disabled': '卸载时系统拒绝停用自启服务',
})

// ── 原始层(封存 / 校验 / 导出)的 op(raw: 组键)────────────────────────────────────────────────────────────
export const RAW_OP = Object.freeze({
  seal: '压缩保存', 'seal-legacy': '压缩保存旧文件', verify: '校验', 'delete-original': '删除原件', lock: '加锁', 'log-gap': '记录中断', export: '导出',
})

// ── 安装清单里 asight 自己的文件(roles)────────────────────────────────────────────────────────────────────
export const FILE_ROLE = Object.freeze({
  'ca-key': '采集证书的私钥', 'ca-cert': '采集证书', unit: '开机自启的用户服务', bundle: '合并的证书包',
  'trust-file': '给 agent 读的证书文件', plugin: '信任插件', shim: '启动入口',
})

// ── 残留(collector.residue[].result):两种开头 + 每个结果一句话 ─────────────────────────────────────────────
export const RESIDUE_LEAD = Object.freeze({ unfinished: '安装没做完,留下:', left: '卸载后还留着:' })
export const residueLead = (result) => (result === 'install did not finish' ? RESIDUE_LEAD.unfinished : RESIDUE_LEAD.left)

// ── 第二契约代([待 #45]:字段在才画;这些表只在载荷带着那些字段时被读)────────────────────────────────────────
export const ROUTING = Object.freeze({ driver: '驱动模式', proxy: '代理模式', none: '全部关着', unknown: '不知道' })
export const SCOPE = Object.freeze({ agent: '自动', user: '你点名的 · 用户级', machine: '你点名的 · 机器级' })
export const OPT_IN_STATE = Object.freeze({
  needed: '还没点名', done: '已点名', broken: '已点名,但入口失效', 'pending-admin': '等管理员',
  'needs-admin': '关掉之后还没撤,要管理员',
})
export const ENTRY_STATE = Object.freeze({ intact: '完好', 'entry-missing': '不在了', 'entry-changed': '你之后改过' })
export const CHANGE_REMOVAL = '关掉它的采集时一并移除'

// ── 命令(只出现在技术细节;每条都是 1.6 命令表 src/cli/commands.mjs 里的用法,cli-commands.test.mjs 守)──────────
// <id> 由页面按 collector.switch.harnesses 里的拼法填(前端不另存 CLI 名表);opt_in 的命令随数据原样给
export const COMMANDS = Object.freeze({
  on: 'asight on <id>', off: 'asight off <id>', status: 'asight status <id>', doctor: 'asight doctor <id>',
  install: 'asight install', helper: 'sudo asight setup-helper', linger: 'loginctl enable-linger',
})

// ── 采集记录的固定话 ─────────────────────────────────────────────────────────────────────────────────────
export const LOG = Object.freeze({
  who: Object.freeze({ collector: '采集服务', raw: '压缩保存与读取' }),
  window: (h) => `最近 ${h} 小时`,
  filterRule: '按每组最近一次的 agent,和这个 agent 最近一次失败所在的组',
  truncated: '只读了最近的一部分记录,可能不全',
  unreadable: (n) => `${n} 个文件读不出`,
  none: '最近 24 小时没有采集失败',
  metadataOnly: '只有元数据,不含请求或响应的字节',
  install: '上次安装', uninstall: '上次卸载', manifestError: '安装清单读不出',
  resultLine: (outcome) => `结果:${outcome}`,
  priorValue: '替换了原来的值',
  expectedTitle: '按设计不记录的连接(最近 24 小时)',
  rawTitle: '原始层最近的非成功结果',
  filesTitle: '读过的文件',
})
