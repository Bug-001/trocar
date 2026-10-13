// test/netenv/fixtures/rows-win32.mjs — one NetFacts per row a–s of RFC 4.8 §10.2 (Windows, proxy mode), with what `buildTopology` must say of it written out literally (W29). The rows 8–19 of
// 1.6 §9.3 are the same situations cross-platform (fixtures/rows.mjs, drawn with injected facts); these are Windows's own: v2rayN, the TUN of a Verge in service mode, the opt-in forms (Kimi's VS Code
// extension with its host set, Claude Desktop's policy value), the entry bypassed from the taskbar and the install path asight has not measured. The expected values are written by hand, not computed by
// the code under test; `compact` is the chain of each distinct way as `renderCompact` prints it (whitespace squashed by the test) — the 「链」 column of §10.2 is an example for a reader, the ports and
// product names there are examples (V41's wording). `vpnLine`: the row's machine has a VPN / proxy product, so `status <h>` ends with the one line about per-process rules (§9.2); row f has none.
import { facts, form, fwForm, proc, proxyOf, CLASH, clashVpn, pfacts } from './rows.mjs'

const ENV = '.env HTTPS_PROXY', SETTINGS = 'settings env.HTTPS_PROXY', POLICY = '策略 egressProxyUrl', VSCODE = 'settings.json http.proxy'
const sysProxy = (port = 7897) => ({ value: `http://127.0.0.1:${port}`, pac: false })
const viaSystemProxy = (port = 7897) => ({ listeners: [{ ...CLASH, port }], vpn: clashVpn({ port }) })
const CODEX_PROC = { name: 'codex app-server', exe: 'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\ab12\\codex.exe', version: '0.160.1' }
const CLAUDE_PROC = { name: 'claude', exe: 'C:\\Users\\u\\.local\\bin\\claude.exe', version: '2.1.291' }
const ENGINE_AND_KERNEL = ['agent', 'asight-forwarder', 'asight-engine']
/** v2rayN on its own port: the listener and the probe's product row (4.7's table), as the Windows facts give them. */
const V2RAYN = { addr: '127.0.0.1', port: 10808, pid: 23001, exe: 'C:\\Program Files\\v2rayN\\v2rayN.exe', product: 'v2rayn' }
const v2raynVpn = () => ({ product: 'v2rayn', version: '6.55.6', pid: null, port: 10808, mode: 'rule', tun: false })

/** Each row: { n, title, h, facts, kinds (per branch), forms (per branch), on_path, captured, reason, compact (a line per distinct way), vpnLine, notes? }. */
export const ROWS = []
const row = (r) => { ROWS.push(r); return r }

row({ n: 'a', title: 'Verge with the system proxy on, a form that follows it (Codex): the kernel, the engine, then the system proxy; the WebSocket used to go direct', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], systemProxy: sysProxy(), follows: { http: true, ws: false } }), fwForm(17992, { upstream: 'http://127.0.0.1:7897', source: 'system-proxy' }), viaSystemProxy()),
  kinds: [[...ENGINE_AND_KERNEL, 'proxy', 'egress'], [...ENGINE_AND_KERNEL, 'proxy', 'egress']], forms: ['codex.app', 'codex.app'], names: ['http', 'ws'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY · asight 写的] asight 本地代理 :17992 → asight 引擎 :17990 → [系统代理] Clash Verge Rev :7897 → 出口(Clash Verge Rev 选)'] })

row({ n: 'b', title: 'Verge with the system proxy on, a form that does not follow it (Claude Code CLI): the engine dials the API host direct', h: 'claude-code',
  facts: pfacts('claude-code', form('claude-code.cli', { entry: { where: SETTINGS, asight: true, opt_in: false, intact: true }, procs: [proc(7712, CLAUDE_PROC)] }), fwForm(17991), viaSystemProxy()),
  kinds: [[...ENGINE_AND_KERNEL, 'upstream']], forms: ['claude-code.cli'], names: ['all'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['claude 7712 → [settings env.HTTPS_PROXY · asight 写的] asight 本地代理 :17991 → asight 引擎 :17990 → api.anthropic.com:443(直连)'] })

row({ n: 'c', title: 'the agent had a proxy of its own, and it was Verge: it is the upstream, the entry points at the kernel', h: 'claude-code',
  facts: pfacts('claude-code', form('claude-code.cli', { entry: { where: SETTINGS, asight: true, opt_in: false, intact: true }, setting: proxyOf('http://127.0.0.1:7897', [{ kind: 'file', where: 'C:\\Users\\u\\.claude\\settings.json', key: 'env.HTTPS_PROXY' }]), procs: [proc(7712, CLAUDE_PROC)] }), fwForm(17991, { upstream: 'http://127.0.0.1:7897', source: 'agent' }), viaSystemProxy()),
  kinds: [[...ENGINE_AND_KERNEL, 'proxy', 'egress']], forms: ['claude-code.cli'], names: ['all'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['claude 7712 → [settings env.HTTPS_PROXY · asight 写的] asight 本地代理 :17991 → asight 引擎 :17990 → [CONNECT 原样转] Clash Verge Rev :7897 → 出口(Clash Verge Rev 选)'] })

row({ n: 'd', title: 'Verge with TUN on (service mode): the engine dials the API host as the agent would, into the TUN', h: 'claude-code',
  facts: pfacts('claude-code', form('claude-code.cli', { entry: { where: SETTINGS, asight: true, opt_in: false, intact: true }, procs: [proc(7712, CLAUDE_PROC)] }), fwForm(17991), { listeners: [CLASH], vpn: clashVpn({ tun: true }) }),
  kinds: [[...ENGINE_AND_KERNEL, 'upstream', 'egress']], forms: ['claude-code.cli'], names: ['all'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['claude 7712 → [settings env.HTTPS_PROXY · asight 写的] asight 本地代理 :17991 → asight 引擎 :17990 → api.anthropic.com:443(直连) → [TUN] 出口(Clash Verge Rev 选)'] })

row({ n: 'e', title: 'v2rayN with the system proxy on: the same follower shape with a product the adapter does not read (a unit fixture; the end-to-end suite covers it in W67)', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], systemProxy: { value: 'http://127.0.0.1:10808', pac: false }, follows: { http: true, ws: false } }), fwForm(17992, { upstream: 'http://127.0.0.1:10808', source: 'system-proxy' }), { listeners: [V2RAYN], vpn: v2raynVpn() }),
  kinds: [[...ENGINE_AND_KERNEL, 'proxy', 'egress'], [...ENGINE_AND_KERNEL, 'proxy', 'egress']], forms: ['codex.app', 'codex.app'], names: ['http', 'ws'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY · asight 写的] asight 本地代理 :17992 → asight 引擎 :17990 → [系统代理] v2rayN :10808 → 出口(v2rayN 选)'] })

row({ n: 'f', title: 'no VPN: the kernel and the engine dial the API host', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)] }), fwForm(17992)),
  kinds: [[...ENGINE_AND_KERNEL, 'upstream']], forms: ['codex.app'], names: ['all'], on_path: true, captured: true, reason: null, vpnLine: false,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY · asight 写的] asight 本地代理 :17992 → asight 引擎 :17990 → chatgpt.com:443(直连)'] })

row({ n: 'g', title: 'the system proxy is a PAC and the form follows it: asight does not run a PAC, the form is not wired', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], systemProxy: { value: null, pac: true }, follows: { http: true, ws: false }, entry: null }), fwForm(17992, { state: 'forward-only' })),
  kinds: [['agent', 'unknown'], ['agent', 'upstream']], forms: ['codex.app', 'codex.app'], names: ['http', 'ws'], on_path: false, captured: false, reason: 'not-routed', vpnLine: false,
  compact: ['HTTP codex app-server 5530 → [系统代理] PAC(不知道 · pac)', 'WebSocket codex app-server 5530 → chatgpt.com:443(直连)'] })

row({ n: 'h', title: 'the agent runs elevated: the kernel cannot tell the process and only forwards', h: 'claude-code',
  facts: pfacts('claude-code', form('claude-code.cli', { entry: { where: SETTINGS, asight: true, opt_in: false, intact: true }, procs: [proc(7712, { ...CLAUDE_PROC, elevated: true })] }), fwForm(17991)),
  kinds: [['agent', 'asight-forwarder', 'upstream']], forms: ['claude-code.cli'], names: ['all'], on_path: true, captured: false, reason: 'elevated-agent', vpnLine: false,
  compact: ['claude 7712(提权) → [settings env.HTTPS_PROXY · asight 写的] asight 本地代理 :17991(只转发) → api.anthropic.com:443(直连)'] })

row({ n: 'i', title: 'the engine is gone: the kernel falls back to the upstream and only forwards', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], systemProxy: sysProxy(), follows: { http: true, ws: false } }), fwForm(17992, { upstream: 'http://127.0.0.1:7897', source: 'system-proxy' }), { daemon: { state: 'not-running', pid: null, enginePort: null }, ...viaSystemProxy() }),
  kinds: [['agent', 'asight-forwarder', 'proxy', 'egress'], ['agent', 'asight-forwarder', 'proxy', 'egress']], forms: ['codex.app', 'codex.app'], names: ['http', 'ws'], on_path: true, captured: false, reason: 'daemon-not-running', vpnLine: true,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY · asight 写的] asight 本地代理 :17992(只转发) → [系统代理] Clash Verge Rev :7897 → 出口(Clash Verge Rev 选)'] })

row({ n: 'j', title: 'the kernel is not running: nobody listens on the port the entry points at', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)] }), fwForm(17992), { forwarder: { pid: null, up: false, forms: { 'codex.app': fwForm(17992) } } }),
  kinds: [['agent', 'asight-forwarder']], forms: ['codex.app'], names: ['all'], on_path: true, captured: false, reason: 'forwarder-down', vpnLine: false,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY · asight 写的] asight 本地代理 :17992(没人在听)'] })

// row k's facts are the shape a REAL `off` leaves: the entry record is gone from the manifest (undo.mjs takes it out) and the file holds the user's own value again, so `entry` is null — what says
// the agent is still on the kernel is its live connection to the group's port (`clients`). The shape with `entry.intact: true` under `desired: 'off'` (rows.mjs row 14, the cross-platform twin)
// is the mid-off / failed-undo window, a different moment; the two must not be conflated (review 2026-10-10, finding 2).
row({ n: 'k', title: 'after off, an agent started while it was on is still connected to the kernel, which only forwards', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], systemProxy: sysProxy(), follows: { http: true, ws: false }, entry: null }), fwForm(17992, { state: 'forward-only', upstream: 'http://127.0.0.1:7897', source: 'system-proxy', clients: [5530] }), { desired: { codex: 'off' }, ...viaSystemProxy() }),
  kinds: [['agent', 'asight-forwarder', 'proxy', 'egress'], ['agent', 'asight-forwarder', 'proxy', 'egress']], forms: ['codex.app', 'codex.app'], names: ['http', 'ws'], on_path: true, captured: false, reason: 'desired-off', vpnLine: true,
  compact: ['codex app-server 5530 → asight 本地代理 :17992(只转发) → [系统代理] Clash Verge Rev :7897 → 出口(Clash Verge Rev 选)'], notes: ['还有 1 个 agent 连着 asight 的门,重启它们之后 asight 就完全退出'] })

row({ n: 'l', title: 'the user changed the agent\'s own proxy: it no longer points at the kernel and goes where the setting says', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], setting: proxyOf('http://proxy.new:3128', [{ kind: 'file', where: 'C:\\Users\\u\\.codex\\.env', key: 'HTTPS_PROXY' }]), entry: { where: ENV, asight: true, opt_in: false, intact: false } }), fwForm(17992, { upstream: 'http://proxy.corp:8080', source: 'agent' })),
  kinds: [['agent', 'proxy', 'egress']], forms: ['codex.app'], names: ['all'], on_path: false, captured: false, reason: 'proxy-changed', vpnLine: false,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY] proxy.new:3128 → 出口'], notes: ['接上: asight on codex'] })

row({ n: 'm', title: 'the system proxy changed its port: the kernel was reloaded, the agent\'s own setting did not change', h: 'codex',
  facts: pfacts('codex', form('codex.app', { procs: [proc(5530, CODEX_PROC)], systemProxy: sysProxy(7898), follows: { http: true, ws: false } }), fwForm(17992, { upstream: 'http://127.0.0.1:7898', source: 'system-proxy' }), viaSystemProxy(7898)),
  kinds: [[...ENGINE_AND_KERNEL, 'proxy', 'egress'], [...ENGINE_AND_KERNEL, 'proxy', 'egress']], forms: ['codex.app', 'codex.app'], names: ['http', 'ws'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['codex app-server 5530 → [.env HTTPS_PROXY · asight 写的] asight 本地代理 :17992 → asight 引擎 :17990 → [系统代理] Clash Verge Rev :7898 → 出口(Clash Verge Rev 选)'] })

row({ n: 'n', title: 'an opt-in form that was not named (Kimi CLI\'s shim on the PATH): asight is not wired in', h: 'kimi-code',
  facts: pfacts('kimi-code', form('kimi-code.cli', { entry: null, optIn: { state: 'needed', code: 'opt-in-needed', enable: 'asight on kimi-code --opt-in kimi-code.cli' }, procs: [proc(7001, { name: 'kimi', exe: 'C:\\Users\\u\\.kimi-code\\bin\\kimi.exe', version: '1.4.0' })] }), fwForm(17993)),
  kinds: [['agent', 'upstream']], forms: ['kimi-code.cli'], names: ['all'], on_path: false, captured: false, reason: 'opt-in-needed', vpnLine: false,
  compact: ['kimi 7001 → api.moonshot.cn:443(直连)'], notes: ['要采它: asight on kimi-code --opt-in kimi-code.cli'] })

row({ n: 'o', title: 'the entry is bypassed: the machine PATH\'s same-named command comes first', h: 'kimi-code',
  facts: pfacts('kimi-code', form('kimi-code.cli', { entry: null, optIn: { state: 'broken', code: 'shim-not-on-path', enable: 'asight on kimi-code --opt-in kimi-code.cli' }, procs: [proc(7001, { name: 'kimi', exe: 'C:\\Program Files\\kimi\\kimi.exe', version: '1.4.0' })] }), fwForm(17993)),
  kinds: [['agent', 'upstream']], forms: ['kimi-code.cli'], names: ['all'], on_path: false, captured: false, reason: 'shim-not-on-path', vpnLine: false,
  compact: ['kimi 7001 → api.moonshot.cn:443(直连)'] })

row({ n: 'p', title: 'OpenCode Desktop started from a taskbar pin: not through asight\'s launcher', h: 'opencode',
  facts: pfacts('opencode', form('opencode.desktop', { entry: null, optIn: { state: 'broken', code: 'not-via-entry' }, procs: [proc(9100, { name: 'OpenCode', exe: 'C:\\Users\\u\\AppData\\Local\\Programs\\opencode\\OpenCode.exe', version: '0.9.1' })] }), fwForm(17994)),
  kinds: [['agent', 'upstream']], forms: ['opencode.desktop'], names: ['all'], on_path: false, captured: false, reason: 'not-via-entry', vpnLine: false,
  compact: ['OpenCode 9100 → api.anthropic.com:443(直连)'] })

row({ n: 'q', title: 'Kimi\'s VS Code extension, named: the editor\'s setting points at the kernel, only Kimi\'s host set goes to the engine', h: 'kimi-code',
  facts: pfacts('kimi-code', form('kimi-code.vscode', { entry: { where: VSCODE, asight: true, opt_in: true, intact: true }, optIn: { state: 'done' }, procs: [proc(8100, { name: 'Code', exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', version: null })], hosts: { program: 'VS Code', extension: 'Kimi', defaults: ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn'], hosts: ['api.moonshot.cn', 'relay.corp.example'], settings: 'read', dropped: [] } }), fwForm(17995)),
  kinds: [[...ENGINE_AND_KERNEL, 'upstream']], forms: ['kimi-code.vscode'], names: ['all'], on_path: true, captured: true, reason: null, vpnLine: false,
  compact: ['Code 8100 → [settings.json http.proxy · 你点名的] asight 本地代理 :17995 → asight 引擎 :17990 → api.moonshot.cn:443(直连)'],
  notes: ['VS Code 别的连接经 asight 的内核(只转发),只有到 Kimi 的 host 集的连接进引擎'] })

row({ n: 'r', title: 'Claude Desktop, named: the policy value points at the kernel\'s own port, the upstream is the system proxy', h: 'claude-code',
  facts: pfacts('claude-code', form('claude-code.desktop', { entry: { where: POLICY, asight: true, opt_in: true, intact: true }, optIn: { state: 'done' }, systemProxy: sysProxy(), follows: { http: true, ws: false }, procs: [proc(8801, { name: 'Claude', exe: 'C:\\Program Files\\Claude\\Claude.exe', version: null })] }), fwForm(17996, { upstream: 'http://127.0.0.1:7897', source: 'system-proxy' }), viaSystemProxy()),
  kinds: [[...ENGINE_AND_KERNEL, 'proxy', 'egress']], forms: ['claude-code.desktop'], names: ['all'], on_path: true, captured: true, reason: null, vpnLine: true,
  compact: ['Claude 8801 → [策略 egressProxyUrl · 你点名的] asight 本地代理 :17996 → asight 引擎 :17990 → [系统代理] Clash Verge Rev :7897 → 出口(Clash Verge Rev 选)'] })

row({ n: 's', title: 'the image name matches, the install path was never measured: the form is not claimed and the path shape is said', h: 'claude-code',
  facts: pfacts('claude-code', form('claude-code.cli', { entry: { where: SETTINGS, asight: true, opt_in: false, intact: true }, reason: 'form-path-unknown', unknownPaths: ['…\\scoop\\apps\\claude\\current\\claude.exe'], procs: [proc(7712, { name: 'claude', exe: 'C:\\Users\\u\\scoop\\apps\\claude\\current\\claude.exe', version: null })] }), fwForm(17991)),
  kinds: [['agent', 'upstream']], forms: ['claude-code.cli'], names: ['all'], on_path: false, captured: false, reason: 'form-path-unknown', vpnLine: false,
  compact: ['claude 7712 → api.anthropic.com:443(直连)'],
  notes: ['这个安装方式的路径 asight 还不认识(…\\scoop\\apps\\claude\\current\\claude.exe);把它报给 asight'] })

/** What the gatherWin32Facts-driven tests reach the facts through: the parts the rows fix by hand (the helper's reads, the collector dir's files). */
export { ENV, SETTINGS, POLICY, VSCODE, CODEX_PROC, CLAUDE_PROC, sysProxy, viaSystemProxy }
