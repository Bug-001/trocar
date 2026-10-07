// topology.mjs (src/netenv) — the path each harness's traffic takes, from facts (RFC 1.6 §9.2–§9.4, D39⑩, D43). `buildTopology(facts)` is pure: no file, no process, no clock. It turns a NetFacts (src/netenv/facts.mjs:
// the daemon, the link, the listeners on this machine, the VPN product, and per harness its proxy setting, its processes and its entry) into `{ <harness>: HarnessTopology }`, the object `status --json` prints
// under `topology` and the board reads; the text (topology-text.mjs) is rendered from that object and from nothing else (V43).
//
// A harness has one or more branches: the path a connection of it takes, `path` with asight on it and `off_path` with asight taken out and every setting the same (the way out of asight changes nothing of the
// agent's route: §9.5 「出口不变」). `on_path` is whether asight is on the path (true / false / null = not known), `captured` and `reason` are `status`'s verdict on the harness (verdict.mjs, the same function).
// A hop that could not be read stays a node with `unknown: { reason }` (R11); it is never left out and never 「无」. The agent of a branch is the process the chain is drawn for: a steered one whose setting is
// the current one, else a process that is not steered (the chain without asight is what it really does), else no process (a new one would take this path). Processes whose path is another one are `running`.
//
import { judgeHarness } from './verdict.mjs'
import { parseProxyUrl } from './redact.mjs'

export { renderCompact, renderDetail, verdictText, firstHopAfterAsight, firstHopOff, hopKey, ROUTING_TEXT } from './topology-text.mjs' // the words of the topology, rendered from the object below

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const VIA = { http: 'proxy-http', https: 'proxy-https', socks4: 'proxy-socks', socks5: 'proxy-socks', socks5h: 'proxy-socks' }
const PRODUCT_NAME = { 'clash-verge': 'Clash Verge Rev', mihomo: 'mihomo' }
export const productName = (p) => PRODUCT_NAME[p] || p
const ID_PREFIX = { agent: 'a', 'asight-engine': 'e', 'asight-forwarder': 'f', 'legacy-mitm': 'm', proxy: 'p', upstream: 'u', egress: 'x', unknown: 'q' }
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
const base = (p) => String(p).split('/').pop()
const errorOf = (e) => (e && e.code) || String((e && e.message) || e)

/** The nodes and edges of one harness. A node is the same node when its kind and what names it are the same (`intern`), so the path with asight and the path without share their common hops. */
function graph() {
  const nodes = [], edges = [], keyed = new Map(), counts = {}
  const keyOf = (n) => [n.kind, n.pid ?? '', n.name, n.addr ?? '', n.port ?? '', n.chosen_by ?? '', n.unknown ? n.unknown.reason : ''].join('|')
  const node = (props) => {
    const n = drop(props), k = keyOf(n)
    if (keyed.has(k)) return keyed.get(k)
    const prefix = ID_PREFIX[n.kind]
    counts[prefix] = (counts[prefix] || 0) + 1
    const id = counts[prefix] === 1 ? prefix : `${prefix}${counts[prefix]}`
    nodes.push({ id, ...n })
    keyed.set(k, id)
    return id
  }
  const edge = (from, to, via, extra = {}) => { if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, via, ...drop(extra) }); return to }
  return { nodes, edges, node, edge }
}

/** The proxy a setting names, as a node: who listens on that port here (the listeners the facts hold, then the VPN product's own port), or a proxy on another machine. */
function proxyNode(g, F, host, port) {
  if (!LOOPBACK.has(host)) return g.node({ kind: 'proxy', name: `${host}:${port}`, addr: host, port, remote: true })
  const l = F.listeners.find((x) => x.port === port)
  const v = F.vpn && F.vpn.port === port ? F.vpn : null
  const name = `${host}:${port}`
  if (l && l.unknown) return g.node({ kind: 'proxy', name, addr: host, port, unknown: l.unknown })
  if (l) return g.node({ kind: 'proxy', name: l.product ? productName(l.product) : l.exe ? base(l.exe) : name, addr: host, port, product: l.product, version: l.version, pid: l.pid, mode: v ? v.mode : undefined, unknown: v && v.unknown })
  if (v) return g.node({ kind: 'proxy', name: productName(v.product), addr: host, port, product: v.product, version: v.version, pid: v.pid, mode: v.mode, unknown: v.unknown })
  const gone = F.unknowns.find((u) => u.where === 'listeners') // the listeners could not be read: that is why nobody is named, not that nobody listens
  return g.node({ kind: 'proxy', name, addr: host, port, ...(gone ? { unknown: { reason: gone.reason, detail: gone.detail } } : { down: true }) })
}

/** What follows the proxy: where the connection comes out, chosen by the VPN product when there is one; unknown when the proxy was. */
function egressOf(g, p) {
  const n = g.nodes.find((x) => x.id === p)
  if (n.unknown && !n.product) return g.node({ kind: 'egress', name: '出口', unknown: n.unknown })
  return g.node({ kind: 'egress', name: '出口', chosen_by: n.product ? productName(n.product) : undefined })
}

const sourceKey = (s) => (s.kind === 'env' ? `env:${s.where}` : s.kind === 'file' ? `file:${s.where}${s.key ? `#${s.key}` : ''}` : s.kind)

/**
 * The hops after the agent (or after asight), from a setting: the agent's own proxy; else, when it follows the OS proxy (`follow`), the OS proxy; else the API host direct, into the VPN's TUN when that is on.
 * → { ids: [node ids in order], first: { via, evidence } } — the edge into `ids[0]` is the caller's, since it comes from the agent or from asight. The edges between the hops are made here.
 */
function tail(g, F, hf, setting, follow) {
  if (setting.unknown) return { ids: [g.node({ kind: 'unknown', name: '代理设置', unknown: setting.unknown })], first: { via: 'unknown', evidence: [] } }
  if (setting.value) {
    const p = proxyNode(g, F, setting.host, setting.port), x = g.edge(p, egressOf(g, p), 'egress')
    return { ids: [p, x], first: { via: VIA[setting.scheme] || 'unknown', evidence: setting.source.map(sourceKey) } }
  }
  const sys = hf.systemProxy
  if (follow && sys) {
    const evidence = ['system-proxy']
    if (sys.unknown) return { ids: [g.node({ kind: 'unknown', name: '系统代理', unknown: sys.unknown })], first: { via: 'system-proxy', evidence } }
    if (sys.pac) return { ids: [g.node({ kind: 'unknown', name: 'PAC', unknown: { reason: 'pac', detail: 'the OS proxy is a PAC script; asight does not run it' } })], first: { via: 'system-proxy', evidence } }
    if (sys.value) {
      const u = parseProxyUrl(sys.value)
      if (u) { const p = proxyNode(g, F, u.host, u.port), x = g.edge(p, egressOf(g, p), 'egress'); return { ids: [p, x], first: { via: 'system-proxy', evidence } } }
    }
  }
  const host = (hf.apiHosts || [])[0] || 'api'
  const u = g.node({ kind: 'upstream', name: `${host}:443`, addr: host, port: 443 })
  if (F.vpn && F.vpn.tun === true) return { ids: [u, g.edge(u, g.node({ kind: 'egress', name: '出口', chosen_by: productName(F.vpn.product) }), 'tun')], first: { via: 'direct', evidence: [] } }
  return { ids: [u], first: { via: 'direct', evidence: [] } }
}

/** Is asight's side of the platform up for this harness: wanted on, a daemon that answers, a helper, the kernel's links. true / false / null (not known). */
function platformUp(F, h) {
  if (F.desired[h] === 'off') return false
  if (F.desired[h] !== 'on') return null
  if (F.daemon.state === 'not-running' || F.daemon.state === 'not-responding') return false
  if (F.daemon.state !== 'running') return null
  if (F.link.helper === 'missing' || F.link.attached === false) return false
  return F.link.attached === true ? true : null
}
const entryIntact = (hf) => (hf.entry.state === 'intact' ? true : hf.entry.state === 'unknown' ? null : false)
const steeredOf = (p) => (p.watched === 'decrypt' ? true : p.watched === 'unknown' ? null : false)

/** `status`'s verdict on the harness, from the same facts and the same function: { captured, reason, rows }. */
function judged(F, h, hf) {
  const j = judgeHarness({
    desired: F.desired[h] ?? null, entryIntact: entryIntact(hf), entryWhy: hf.entry.state === 'changed' ? 'entry-changed' : 'entry-missing', linkAttached: F.link.attached, helper: F.link.helper || 'ok', daemon: F.daemon.state,
    procs: hf.procs.map((p) => ({ pid: p.pid, startedAt: p.startedAt, trusted: p.trusted, reason: p.reason, negative: p.negative })), installedAt: hf.installedAt,
  })
  return { captured: j.captured, reason: (j.rows.find((r) => r.reason) || {}).reason ?? null, rows: j.rows }
}

const agentOf = (g, h, p) => g.node({ kind: 'agent', name: p ? p.name : h, pid: p ? p.pid : undefined, version: p ? p.version : undefined, path: p ? p.exe : undefined, elevated: p && p.elevated === true ? true : undefined })

/** The branches a harness has: HTTP and WebSocket apart when it reads the OS proxy for one and not the other and there is an OS proxy to read (the path of each differs), else one. */
function branchNames(hf) {
  const b = hf.behaviour || {}
  return (b.branches || []).join() === 'http,ws' && hf.systemProxy ? ['http', 'ws'] : ['all']
}
const followsOf = (hf, name) => !!(hf.behaviour && hf.behaviour.follows && hf.behaviour.follows[name === 'ws' ? 'ws' : 'http'])

function driverTopology(F, h, hf) {
  const g = graph(), v = judged(F, h, hf), up = platformUp(F, h)
  const current = (p) => p.startSetting == null
  const main = hf.procs.find((p) => current(p) && steeredOf(p) === true) || hf.procs.find((p) => current(p)) || null
  const steered = main ? steeredOf(main) : entryIntact(hf)
  const asight = up === false || steered === false ? false : up === null || steered === null ? null : true
  const negative = main ? hf.negatives.filter((n) => n.pid === main.pid) : []
  const engine = () => g.node({ kind: 'asight-engine', name: 'asight 引擎', pid: F.daemon.pid, addr: '127.0.0.1', port: F.daemon.enginePort, mode: 'decrypt', asight: true, passthrough: negative.length ? { reason: 'negative-cache', hosts: negative.map((n) => n.host) } : undefined })
  const evidenceEbpf = [...(F.link.ids || []).slice(0, 1).map((id) => `link:${id}`), ...(main ? [`watch:${main.pid}`] : [])]
  const build = (p, setting, withAsight, follow) => {
    const a = agentOf(g, h, p), t = tail(g, F, hf, setting, follow)
    const path = [a], off = [a, ...t.ids]
    let from = a
    if (withAsight) { const e = engine(); g.edge(a, e, 'ebpf', { evidence: evidenceEbpf }); path.push(e); from = e }
    g.edge(from, t.ids[0], t.first.via, { evidence: t.first.evidence })
    if (from !== a) g.edge(a, t.ids[0], t.first.via, { evidence: t.first.evidence }) // the off path: the agent's own way to the same first hop
    return { path: [...path, ...t.ids], off_path: off }
  }
  const branches = branchNames(hf).map((name) => ({ name, ...build(main, hf.setting, asight === true, followsOf(hf, name)), on_path: asight, captured: v.captured, reason: v.reason }))
  const running = []
  const mainSteered = main ? steeredOf(main) : asight
  for (const p of hf.procs) {
    if (p === main) continue
    const stale = !current(p), s = steeredOf(p)
    if (!stale && s === mainSteered) continue
    const b = build(p, stale ? p.startSetting : hf.setting, s === true && up === true, followsOf(hf, 'http'))
    running.push({ pid: p.pid, path: b.path, note: stale ? 'start-time-settings' : 'not-steered', reason: (v.rows.find((r) => r.pid === p.pid) || {}).reason ?? null })
  }
  return { harness: h, at: F.at, routing: F.routing, desired: F.desired[h] ?? null, on_path: branches[0].on_path, captured: v.captured, reason: v.reason, vpn: vpnOf(F), nodes: g.nodes, edges: g.edges, branches, running, notes: [], findings: [] }
}

/** The VPN / proxy product the machine has, as the topology states it (read-only facts: no node, no rule, no secret): what the one line of `status <h>` about per-process rules needs. */
const vpnOf = (F) => (F.vpn ? drop({ product: F.vpn.product, version: F.vpn.version, mode: F.vpn.mode, tun: F.vpn.tun }) : null)

/** `{ <harness>: HarnessTopology }` for every harness the facts have. Pure. A harness the platform has no way to draw (routing unknown) gets the chain without asight and an on_path of null. */
export function buildTopology(F) {
  const out = {}
  for (const [h, hf] of Object.entries(F.harnesses)) {
    try { out[h] = driverTopology(F, h, hf) } catch (e) {
      out[h] = { harness: h, at: F.at, routing: 'unknown', desired: F.desired[h] ?? null, on_path: null, captured: null, reason: null, vpn: null, nodes: [{ id: 'a', kind: 'agent', name: h }], edges: [], branches: [{ name: 'all', path: ['a'], off_path: ['a'], on_path: null, captured: null, reason: null }], running: [], notes: [`the path could not be worked out: ${errorOf(e)}`], findings: [] }
    }
  }
  return out
}
