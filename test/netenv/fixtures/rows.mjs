// test/netenv/fixtures/rows.mjs — one NetFacts per row of RFC 1.6 §9.3, with what `buildTopology` must say of it written out literally (V41, V42, V45). A NetFacts is what src/netenv/facts.mjs hands the
// topology: the daemon, the link, the listeners, the VPN product, and per harness its setting, its processes and its entry. The expected values here are the spec's: they are not computed by
// the code under test. `compact` is the chain of each branch as `renderCompact` prints it (whitespace is squashed by the test). Rows the spec gives as a different chain than the builder draws are
// noted where they are.
export const squash = (s) => String(s).replace(/\s+/g, '')

const API = { 'claude-code': 'api.anthropic.com', codex: 'chatgpt.com', hermes: 'api.openai.com', 'kimi-code': 'api.moonshot.cn' }
const NOW = '2026-10-07T10:02:12.000Z'
const ENTRY_AT = '2026-10-07T09:00:00.000Z'
const BEFORE = '2026-10-07T08:00:00.000Z' // a process that started before `on` wrote its entry
const AFTER = '2026-10-07T09:30:00.000Z'

/** A harness's setting: none, or a proxy URL from `source` (`{ kind: 'env' | 'file', where }`). */
export const none = () => ({ value: null, scheme: null, host: null, port: null, source: [], sha256: null })
export const proxyOf = (value, source = [{ kind: 'env', where: 'HTTPS_PROXY' }], over = {}) => {
  const u = new URL(value)
  return { value, scheme: u.protocol.slice(0, -1), host: u.hostname, port: Number(u.port), source, sha256: `sha-${value}`, ...over }
}
export const MIHOMO = { addr: '127.0.0.1', port: 7890, pid: 777, exe: '/usr/bin/mihomo', product: 'mihomo', version: '1.19.32' }
export const mihomoVpn = (over = {}) => ({ product: 'mihomo', version: '1.19.32', pid: 777, port: 7890, mode: 'rule', tun: false, ...over })

/** A steered process (watched with decrypt, trusted) of harness `h`. */
export const proc = (pid, over = {}) => ({ pid, name: 'claude', exe: '/home/u/.local/share/claude/versions/2.1.291', version: '2.1.291', startedAt: AFTER, watched: 'decrypt', trusted: true, reason: null, negative: false, startSetting: null, elevated: null, ...over })

// how each harness reads a proxy (the proxy export of its file, 1.6 §9.7), as the facts carry it for this platform: written here by hand from the spec's table, not read from the descriptors
const SOCKS_FAILS = { socks4: 'fails', socks5: 'fails', socks5h: 'fails' }
const SOCKS_SILENT = { socks4: 'silent-direct', socks5: 'silent-direct', socks5h: 'silent-direct' }
const BEHAVE = {
  'claude-code': { follows: { http: false, ws: false }, schemes: ['http', 'https'], unsupported: SOCKS_FAILS, branches: ['all'], restart: { hint: '退出这个 Claude Code,再重新启动(它只在启动时读一次代理设置)', processes: 'claude' } },
  codex: { follows: { http: true, ws: false }, schemes: ['http', 'https'], unsupported: SOCKS_SILENT, branches: ['http', 'ws'], restart: { hint: '关掉所有 codex 窗口,再结束托管的 codex app-server --managed-daemon 进程', processes: 'codex app-server --managed-daemon' } },
  hermes: { follows: { http: true, ws: true }, schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'], unsupported: {}, branches: ['all'], restart: { hint: '退出这个 Hermes,再重新启动', processes: 'hermes' } },
  'kimi-code': { follows: { http: false, ws: false }, schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'], unsupported: {}, branches: ['all'], restart: { hint: '退出这个 kimi,在新开的终端里重新启动', processes: 'kimi' } },
  'deepseek-dsh': { follows: { http: false, ws: false }, schemes: ['http', 'https'], unsupported: SOCKS_SILENT, branches: ['all'], restart: { hint: '退出这个 dsh,再重新启动', processes: 'dsh' } },
}
export const harness = (h, over = {}) => ({
  installed: true, entry: { state: 'intact' }, installedAt: ENTRY_AT, setting: none(), systemProxy: null, behaviour: { ...BEHAVE[h], measured: 'inferred' },
  procs: [proc(4121)], negatives: [], apiHosts: [API[h]], adopted: null, forms: null, ...over,
})

export const facts = (h, over = {}, hOver = {}) => ({
  at: NOW, platform: 'linux', routing: 'driver', desired: { [h]: 'on' },
  daemon: { state: 'running', pid: 4012, enginePort: 47123 }, link: { attached: true, helper: 'ok', ids: [17] },
  listeners: [], vpn: null, forwarder: null, harnesses: { [h]: harness(h, hOver) }, unknowns: [], ...over,
})

const viaMihomo = { setting: proxyOf('http://127.0.0.1:7890'), procs: [proc(4121)] }

/** Each row: { n, title, h, facts, kinds (per branch), on_path, captured, reason, compact (a line per branch), findings (codes diagnose must give) }. */
export const ROWS = []
const row = (r) => { ROWS.push(r); return r }

// ── driver mode (Linux eBPF; 4.6 「eBPF 模式下的网络拓扑」) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
row({ n: 1, title: 'no proxy in the agent: eBPF → engine → the API host, direct', h: 'claude-code', facts: facts('claude-code'),
  kinds: [['agent', 'asight-engine', 'upstream']], on_path: true, captured: true, reason: null,
  compact: ['claude 4121 → [eBPF] asight 引擎 :47123 → api.anthropic.com:443(直连)'], findings: [] })

row({ n: 2, title: 'the agent has its own proxy (HTTPS_PROXY → mihomo, rule mode): the engine hands the CONNECT on', h: 'claude-code',
  facts: facts('claude-code', { listeners: [MIHOMO], vpn: mihomoVpn() }, viaMihomo),
  kinds: [['agent', 'asight-engine', 'proxy', 'egress']], on_path: true, captured: true, reason: null,
  compact: ['claude 4121 → [eBPF] asight 引擎 :47123 → [CONNECT 原样转] mihomo :7890 → 出口(mihomo 选)'], findings: ['inferred-behaviour'] })

row({ n: 3, title: 'the VPN has TUN on and the agent has no proxy: the engine dials the API host as the agent would, into the TUN', h: 'claude-code',
  facts: facts('claude-code', { vpn: mihomoVpn({ product: 'clash-verge', tun: true }) }),
  kinds: [['agent', 'asight-engine', 'upstream', 'egress']], on_path: true, captured: true, reason: null,
  compact: ['claude 4121 → [eBPF] asight 引擎 :47123 → api.anthropic.com:443(直连) → [TUN] 出口(Clash Verge Rev 选)'], findings: [] })

row({ n: 4, title: 'asight is off (after `asight off`): the agent goes to its own proxy', h: 'claude-code',
  facts: facts('claude-code', { desired: { 'claude-code': 'off' }, listeners: [MIHOMO], vpn: mihomoVpn() }, { ...viaMihomo, procs: [proc(4121, { watched: 'absent', trusted: false, reason: 'off' })] }),
  kinds: [['agent', 'proxy', 'egress']], on_path: false, captured: false, reason: 'desired-off',
  compact: ['claude 4121 → [HTTPS_PROXY] mihomo :7890 → 出口(mihomo 选)'], findings: ['desired-off', 'inferred-behaviour'] })

row({ n: 5, title: 'on, and this process started before `on`: the kernel does not rewrite its connections', h: 'claude-code',
  facts: facts('claude-code', { listeners: [MIHOMO], vpn: mihomoVpn() }, { ...viaMihomo, procs: [proc(4121, { startedAt: BEFORE, watched: 'no-decrypt', trusted: false, reason: 'config-after-start' })] }),
  kinds: [['agent', 'proxy', 'egress']], on_path: false, captured: false, reason: 'config-after-start',
  compact: ['claude 4121 → [HTTPS_PROXY] mihomo :7890 → 出口(mihomo 选)'], findings: ['config-after-start', 'inferred-behaviour'] })

row({ n: 6, title: 'on, and (pid, host) is in the negative cache: the engine is on the path and passes the connection through', h: 'claude-code',
  facts: facts('claude-code', { listeners: [MIHOMO], vpn: mihomoVpn() }, { ...viaMihomo, procs: [proc(4121, { negative: true })], negatives: [{ pid: 4121, host: 'api.anthropic.com', reason: 'negative-cache' }] }),
  kinds: [['agent', 'asight-engine', 'proxy', 'egress']], on_path: true, captured: false, reason: 'negative-cache',
  compact: ['claude 4121 → [eBPF] asight 引擎 :47123(透传 · 负缓存 api.anthropic.com) → [CONNECT 原样转] mihomo :7890 → 出口(mihomo 选)'], findings: ['negative-cache', 'inferred-behaviour'] })

row({ n: 7, title: 'wanted on and the daemon is not running: the links went with the helper, the agent goes to its own proxy', h: 'claude-code',
  facts: facts('claude-code', { daemon: { state: 'not-running', pid: null, enginePort: null }, link: { attached: null, helper: 'ok', ids: [] }, listeners: [MIHOMO], vpn: mihomoVpn() }, { ...viaMihomo, procs: [proc(4121, { watched: 'unknown', trusted: null })] }),
  kinds: [['agent', 'proxy', 'egress']], on_path: false, captured: false, reason: 'daemon-not-running',
  compact: ['claude 4121 → [HTTPS_PROXY] mihomo :7890 → 出口(mihomo 选)'], findings: ['daemon-not-running', 'inferred-behaviour'] })

// ── the unknowns ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Rows 21 and 22 say 「不知道」 under 「在路径上」. The builder judges on_path from asight's own facts (the watch table, the link), which an unreadable proxy owner or a PAC does not change, so these rows
// are steered ones: a hop that cannot be read is said, and the verdict is the one the rest of the facts give (§9.2: a single unknown hop does not make `captured` unknown).
row({ n: 21, title: 'the owner of the proxy port cannot be read: that hop is 「不知道 · owner-unreadable」, the hop after it is unknown too', h: 'hermes',
  facts: facts('hermes', { listeners: [{ addr: '127.0.0.1', port: 7891, unknown: { reason: 'owner-unreadable', detail: 'ss lists no process for it' } }] },
    { setting: proxyOf('http://127.0.0.1:7891', [{ kind: 'env', where: 'ALL_PROXY' }]), procs: [proc(6001, { name: 'hermes', exe: '/usr/bin/python3', version: null })] }),
  kinds: [['agent', 'asight-engine', 'proxy', 'egress']], on_path: true, captured: true, reason: null,
  compact: ['hermes 6001 → [eBPF] asight 引擎 :47123 → [CONNECT 原样转] 127.0.0.1:7891(不知道 · owner-unreadable) → ?'], findings: ['inferred-behaviour'] })

row({ n: 22, title: 'the OS proxy is a PAC and the agent follows it for HTTP (not for WebSocket): the HTTP branch ends at 「不知道 · pac」', h: 'codex',
  facts: facts('codex', {}, { systemProxy: { value: null, pac: true }, procs: [proc(5530, { name: 'codex app-server', exe: '/home/u/.codex/codex', version: '0.160.1' })] }),
  kinds: [['agent', 'asight-engine', 'unknown'], ['agent', 'asight-engine', 'upstream']], on_path: true, captured: true, reason: null,
  compact: ['HTTP codex app-server 5530 → [eBPF] asight 引擎 :47123 → [系统代理] PAC(不知道 · pac)', 'WebSocket codex app-server 5530 → [eBPF] asight 引擎 :47123 → chatgpt.com:443(直连)'], findings: ['system-proxy-pac', 'inferred-behaviour'] })

/** The same facts with the OS proxy off / without a VPN product (V45). */
export const withSystemProxyOff = (f) => ({ ...f, harnesses: Object.fromEntries(Object.entries(f.harnesses).map(([h, x]) => [h, { ...x, systemProxy: x.systemProxy ? { value: null, pac: false } : null, forms: x.forms ? x.forms.map((fm) => ({ ...fm, systemProxy: { value: null, pac: false } })) : null }])) })
export const withoutVpn = (f) => ({ ...f, vpn: null })
