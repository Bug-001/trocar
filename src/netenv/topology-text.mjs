// topology-text.mjs (src/netenv) — the words of the topology (RFC 1.6 §9.2). Everything printed is rendered from a HarnessTopology (topology.mjs) and from nothing else, so the text and `--json` cannot differ (V43):
// `renderCompact` is one line per branch for `status`, `renderDetail` a hop per line for `status <harness>`, `firstHopAfterAsight` / `firstHopOff` the two hops V45 compares. Pure.
// What is never printed: a proxy URL's credentials (the facts never held them), the VPN's secret, subscription address and node names (nothing here has them), and a hop's name when it could not be read — that
// hop says 「不知道 · <原因>」 (R11).
const MODE = { rule: '规则模式', global: '全局模式', direct: '直连模式', tun: 'TUN 模式', 'system-proxy': '系统代理模式', unknown: '模式不知道' }
export const ROUTING_TEXT = Object.freeze({ driver: '驱动模式(eBPF)', proxy: '代理模式', legacy: '旧采集', none: '没有采集', unknown: '引流模式不知道' })
const BRANCH_TEXT = { http: 'HTTP', ws: 'WebSocket' }
const tri = (v, yes = '是', no = '否') => (v === true ? yes : v === false ? no : '不知道')
const base = (p) => String(p).split('/').pop()

const nodeOf = (t, id) => t.nodes.find((n) => n.id === id)
const edgeOf = (t, from, to) => t.edges.find((e) => e.from === from && e.to === to) || null
const unknownText = (n) => `不知道 · ${n.unknown.reason}`
const passText = (n) => (n.passthrough ? `透传 · 负缓存 ${n.passthrough.hosts.join('、')}` : null)
const paren = (...parts) => { const p = parts.filter(Boolean); return p.length ? `(${p.join(';')})` : '' }

/** A hop as one short phrase (`detail`: with the pid, version and address a hop-per-line view has room for). `via` is the edge into it. */
function hopText(n, via, detail) {
  switch (n.kind) {
    case 'agent': return detail ? `${n.name}${n.pid ? ` pid ${n.pid}` : ''}${n.version ? ` · ${n.version}` : ''}${n.elevated ? ' · 提权' : ''}` : `${n.name}${n.pid ? ` ${n.pid}` : ''}${n.elevated ? '(提权)' : ''}`
    case 'asight-engine': return detail ? `${n.name}${n.pid ? ` pid ${n.pid}` : ''} · ${n.addr}:${n.port}${n.mode === 'decrypt' ? ' · 解密' : ''}${paren(passText(n))}` : `${n.name} :${n.port}${paren(passText(n))}`
    case 'asight-forwarder': return `${n.name} :${n.port}${paren(n.mode === 'forward-only' ? '只转发' : n.mode === 'down' ? '没人在听' : null)}`
    case 'legacy-mitm': return `${n.name} :${n.port}`
    case 'proxy': {
      const who = n.product ? `${n.name}${detail && n.version ? ` ${n.version}` : ''} :${n.port}` : n.name
      return `${who}${detail && n.pid ? ` · pid ${n.pid}` : ''}${detail && n.mode && n.mode !== 'unknown' ? ` · ${MODE[n.mode] || n.mode}` : ''}${paren(n.unknown ? unknownText(n) : n.down ? '没人在听' : null)}`
    }
    case 'upstream': return `${n.name}${via === 'direct' ? '(直连)' : ''}`
    case 'egress': return n.unknown ? '?' : `出口${n.chosen_by ? `(${n.chosen_by} 选)` : ''}`
    default: return `${n.name}${n.unknown ? paren(unknownText(n)) : ''}`
  }
}

/** The word on an edge: how the connection gets from one hop to the next. */
function edgeLabel(e, from, to, detail) {
  if (!e) return ''
  if (to.kind === 'legacy-mitm') return '旧块 · 旧采集' // the old capture's block in the VPN's script routes the connection into its MITM (1.6 §4)
  if (e.via === 'ebpf') return detail && (e.evidence || []).find((x) => x.startsWith('link:')) ? `eBPF · link ${e.evidence.find((x) => x.startsWith('link:')).slice(5)}` : 'eBPF'
  if (e.via === 'system-proxy') return '系统代理'
  if (e.via === 'tun') return 'TUN'
  if (e.via === 'proxy-http' || e.via === 'proxy-https' || e.via === 'proxy-socks') {
    if (e.entry) return `${e.entry.where} · ${e.entry.opt_in ? '你点名的' : 'asight 写的'}`
    if (from.asight) return e.via === 'proxy-socks' ? 'SOCKS 前导原样转' : 'CONNECT 原样转'
    const ev = (e.evidence || [])[0] || ''
    if (ev.startsWith('env:')) return ev.slice(4)
    if (ev.startsWith('file:')) { const [file, key] = ev.slice(5).split('#'); return key ? `${base(file)} ${key}` : base(file) }
    return ''
  }
  return ''
}

/** `agent → [label] hop → …` for a list of node ids. */
function chain(t, ids, detail = false) {
  return ids.map((id, i) => {
    const n = nodeOf(t, id), e = i ? edgeOf(t, ids[i - 1], id) : null
    const label = i ? edgeLabel(e, nodeOf(t, ids[i - 1]), n, detail) : ''
    return `${label ? `[${label}] ` : ''}${hopText(n, e && e.via, detail)}`
  }).join(' → ')
}

const prefixOf = (t, b) => (b.form ? `${b.form} ` : t.branches.length > 1 && BRANCH_TEXT[b.name] ? `${BRANCH_TEXT[b.name]} ` : '')

/** One line per branch: the path with asight on it. */
export const renderCompact = (t) => t.branches.map((b) => `${prefixOf(t, b)}${chain(t, b.path)}`)

/** What `status` says after a branch's chain: 「在路径上 · 是」 / 「不在 · 否 · desired-off」 — whether asight is on the path, whether the harness is captured, and why not. */
export const verdictText = (b) => `${b.on_path === true ? '在路径上' : b.on_path === false ? '不在' : '在不在路径上不知道'} · ${tri(b.captured)}${b.reason ? ` · ${b.reason}` : ''}`

const isAsight = (n) => n.asight === true
/** The first hop after asight on a branch (the first one that is not asight's own), and the first hop of the same branch with asight taken out: §9.5 says they are the same. */
export function firstHopAfterAsight(t, b) {
  const nodes = b.path.map((id) => nodeOf(t, id))
  let last = 0
  nodes.forEach((n, i) => { if (isAsight(n)) last = i })
  return nodes[last + 1] || null
}
export const firstHopOff = (t, b) => nodeOf(t, b.off_path[1]) || null
/** What makes two hops the same hop: the same kind of thing at the same place (the same proxy, the same upstream host), whatever id the graph gave it. */
export const hopKey = (n) => (n ? [n.kind, n.addr ?? '', n.port ?? '', n.name].join('|') : null)

const CHANGE = {
  driver: (h) => `要换代理: 照常改 ${h} 的设置(或你的 VPN);新启动的进程按新设置走,asight 不用做什么`,
  proxy: (h) => `要换代理: 照常改 ${h} 的设置,再跑 asight on ${h},把 asight 接在新代理前面;系统代理变了不用做什么`,
  legacy: () => '要换代理: 照常改你的代理软件;旧采集的路由跟着它的 Clash 配置,asight 不用做什么',
  none: (h) => `要换代理: 照常改 ${h} 的设置(或你的 VPN);asight 现在不在路径上`,
  unknown: (h) => `要换代理: 照常改 ${h} 的设置`,
}

/** `status <harness>`: the harness's header, the path of each branch a hop to a line, the path with asight taken out, the processes that go another way, what could not be read, and how to change the proxy. */
export function renderDetail(t, { now = null } = {}) {
  const head = `${t.harness} · ${t.desired === 'on' ? '开' : t.desired === 'off' ? '关' : '期望态不知道'} · ${ROUTING_TEXT[t.routing]} · 被采集: ${t.captured === true ? '是' : t.captured === false ? `否${t.reason ? `(${t.reason})` : ''}` : '不知道'}`
  const ago = now != null && Number.isFinite(Date.parse(t.at)) ? ` · ${Math.max(0, Math.round((now - Date.parse(t.at)) / 1000))} 秒前探测` : ''
  const lines = [head]
  for (const b of t.branches) {
    lines.push(`新连接的路${prefixOf(t, b) ? `(${prefixOf(t, b).trim()})` : ''}${ago}  ${verdictText(b)}`)
    b.path.forEach((id, i) => {
      const n = nodeOf(t, id), e = i ? edgeOf(t, b.path[i - 1], id) : null
      const label = i ? edgeLabel(e, nodeOf(t, b.path[i - 1]), n, true) : ''
      lines.push(i ? `  → ${label ? `[${label}] ` : ''}${hopText(n, e && e.via, true)}` : `  ${hopText(n, null, true)}`)
    })
  }
  if (t.branches.some((b) => b.path.some((id) => isAsight(nodeOf(t, id))))) lines.push(`关掉 asight 时的路: ${t.branches.map((b) => `${prefixOf(t, b)}${chain(t, b.off_path)}`).join(' · ')}`)
  for (const r of t.running || []) lines.push(r.note === 'start-time-settings' ? `pid ${r.pid} 仍按启动时的设置:${chain(t, r.path)};重启后按上面的路` : `pid ${r.pid} 没有经过 asight${r.reason ? `(${r.reason})` : ''}:${chain(t, r.path)};重启后被采集`)
  for (const n of t.notes || []) lines.push(`说明: ${n}`)
  if (t.vpn && t.on_path === true) lines.push(`你的 VPN 按进程分流时,看到的来源是 asight,不是 ${t.harness}`)
  lines.push((CHANGE[t.routing] || CHANGE.unknown)(t.harness))
  return lines
}
