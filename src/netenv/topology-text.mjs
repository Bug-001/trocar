// topology-text.mjs (src/netenv) — the words of the topology (RFC 1.6 §3.5, 附录 A). Everything printed is rendered from a HarnessTopology (topology.mjs) and from nothing else, so the text and `--json` cannot differ (V43):
// `renderCompact` is one line per branch, `renderRoutes` the `Routes` block of `status <harness>`, `firstHopAfterTrocar` / `firstHopOff` the two hops V45 compares. Pure.
// English, ASCII only (D58): a chain is `agent (pid N) -> [where it came from] hop -> internet`.
// What is never printed: a proxy URL's credentials (the facts never held them), a proxy product's name or node names (nothing here has them), and a hop's name when it could not be read — that
// hop says `unknown (<reason>)` (D58③).
import { unknownWords } from '../cli/words.mjs'

export const ROUTING_TEXT = Object.freeze({ driver: 'driver mode', proxy: 'proxy mode', legacy: 'the old capture', none: 'no capture', unknown: 'routing unknown' })
const BRANCH_TEXT = { http: 'HTTP', ws: 'WebSocket' }
const tri = (v, yes = 'yes', no = 'no') => (v === true ? yes : v === false ? no : 'unknown')
const base = (p) => String(p).split(/[\\/]/).pop()

const nodeOf = (t, id) => t.nodes.find((n) => n.id === id)
const isTrocar = (n) => !!n && n.trocar === true
const edgeOf = (t, from, to) => t.edges.find((e) => e.from === from && e.to === to) || null
const unknownText = (n) => `unknown: ${unknownWords(n.unknown.reason)}` // D58③: a code is never printed
const passText = (n) => (n.passthrough ? `forwarded only for ${n.passthrough.hosts.join(', ')}` : null)
const paren = (...parts) => { const p = parts.filter(Boolean); return p.length ? ` (${p.join('; ')})` : '' }

/** A hop as one short phrase (`detail`: with the pid and address a hop-per-line view has room for). `via` is the edge into it. */
function hopText(n, via, detail, inferred = false) {
  switch (n.kind) {
    case 'agent': return `${n.name}${n.pid ? ` (pid ${n.pid}${n.elevated ? `, elevated${n.elevatedInferred ? ', inferred' : ''}` : ''})` : n.elevated ? ' (elevated)' : ''}`
    case 'trocar-engine': return `${n.name}${n.port ? ` :${n.port}` : ''}${paren(passText(n))}` // a daemon that did not say its port is drawn without one: no `:undefined`
    case 'trocar-forwarder': return `${n.name} :${n.port}${paren(n.mode === 'forward-only' ? 'forwarded only' : n.mode === 'down' ? 'nothing listening' : null)}`
    case 'legacy-mitm': return `${n.name} :${n.port}`
    case 'proxy': {
      const at = n.port && !String(n.name).endsWith(`:${n.port}`) ? ` :${n.port}` : '' // every proxy hop has its port; a hop already named `host:port` says it once
      const name = n.port && /^(system proxy|proxy setting|upstream)$/.test(String(n.name)) ? '' : n.name // the edge already says where it came from: a hop with no name of its own is its port
      return `${name}${name ? at : at.trim()}${detail && n.pid ? ` (pid ${n.pid})` : ''}${paren(n.unknown ? unknownText(n) : n.down ? 'nothing listening' : null)}`
    }
    case 'upstream': return `${n.name}${via === 'direct' ? ` (direct${inferred ? ', inferred' : ''})` : ''}`
    case 'egress': return n.unknown ? 'unknown' : 'internet'
    default: return `${n.name}${n.unknown ? paren(`${unknownText(n)}${n.inferred === true ? ', inferred' : ''}`) : ''}`
  }
}

/** The word on an edge: how the connection gets from one hop to the next. */
function edgeLabel(e, from, to, detail) {
  if (!e) return ''
  if (to.kind === 'legacy-mitm') return 'the old capture'
  if (from.kind === 'legacy-mitm') return ''
  if (e.via === 'ebpf') return 'ebpf'
  if (e.via === 'system-proxy') return 'system proxy'
  if (e.via === 'proxy-http' || e.via === 'proxy-https' || e.via === 'proxy-socks') {
    if (e.entry) return `${base(e.entry.where)}${e.entry.opt_in ? ', you named it' : ', written by trocar'}`
    if (from.trocar) return e.via === 'proxy-socks' ? 'SOCKS passed on as it is' : 'CONNECT passed on as it is'
    const ev = (e.evidence || [])[0] || ''
    if (ev.startsWith('env:')) return ev.slice(4)
    if (ev.startsWith('file:')) { const [file, key] = ev.slice(5).split('#'); return key ? `${base(file)} ${key}` : base(file) }
    return ''
  }
  return ''
}

/** `agent -> [label] hop -> …` for a list of node ids. */
function chain(t, ids, detail = false, labels = true) {
  return ids.map((id, i) => {
    const n = nodeOf(t, id), e = i ? edgeOf(t, ids[i - 1], id) : null
    if (i && isTrocar(n) && isTrocar(nodeOf(t, ids[i - 1]))) return null // trocar's door and engine are one process (D47): one `trocar` hop
    const label = i && labels ? edgeLabel(e, nodeOf(t, ids[i - 1]), n, detail) : ''
    return `${label ? `[${label}] ` : ''}${hopText(n, e && e.via, detail, !!(e && e.inferred))}`
  }).filter((s) => s !== null).join(' -> ')
}

// Which words a branch's line needs in front: its form when the harness has more than one, HTTP / WebSocket when the branches of its form do not all go the same way (`key`: the path with trocar, or without).
const sameWay = (t, b, key) => new Set(t.branches.filter((x) => x.form === b.form).map((x) => x[key].join())).size === 1
const prefixOf = (t, b, key = 'path') => [new Set(t.branches.map((x) => x.form).filter(Boolean)).size > 1 ? b.form : null, sameWay(t, b, key) ? null : BRANCH_TEXT[b.name]].filter(Boolean).map((x) => `${x} `).join('')
// the branches that go the same way (same form, same path) are one line
const distinct = (t) => t.branches.filter((b, i) => t.branches.findIndex((x) => x.form === b.form && x.path.join() === b.path.join()) === i)

/** One line per way a harness's traffic goes: the path with trocar on it (HTTP and WebSocket that take the same path are one line). */
export const renderCompact = (t) => distinct(t).map((b) => `${prefixOf(t, b)}${chain(t, b.path)}`)

/** What `status` says after a branch's chain: `on trocar's path: yes · captured: no (desired-off)`. */
export const verdictText = (b) => `on trocar's path: ${tri(b.on_path)} · captured: ${tri(b.captured)}${b.reason ? ` (${b.reason})` : ''}`

/** The first hop after trocar on a branch (the first one that is not trocar's own), and the first hop of the same branch with trocar taken out: 附录 A says they are the same. */
export function firstHopAfterTrocar(t, b) {
  const nodes = b.path.map((id) => nodeOf(t, id))
  let last = 0
  nodes.forEach((n, i) => { if (isTrocar(n)) last = i })
  return nodes[last + 1] || null
}
export const firstHopOff = (t, b) => nodeOf(t, b.off_path[1]) || null
/** What makes two hops the same hop: the same kind of thing at the same place (the same proxy, the same upstream host), whatever id the graph gave it. */
export const hopKey = (n) => (n ? [n.kind, n.addr ?? '', n.port ?? '', n.name].join('|') : null)

const CHANGE = {
  driver: (h) => `To change the proxy: edit ${h}'s own settings; new processes follow them.`,
  proxy: (h) => `To change the proxy: edit ${h}'s own settings, then run: trocar on ${h}`,
  legacy: () => 'To change the proxy: edit your proxy\'s own settings.',
  none: (h) => `To change the proxy: edit ${h}'s own settings; trocar is not on its path now.`,
  unknown: (h) => `To change the proxy: edit ${h}'s own settings.`,
}
/** The one sentence 附录 A asks for whenever trocar is on the path, and the line that says how to change the proxy. */
export const routeNotes = (t) => [...(t.on_path === true ? [`If your VPN or proxy routes by process, it sees trocar, not ${t.harness}.`] : []), (CHANGE[t.routing] || CHANGE.unknown)(t.harness)]

/** The `Routes` rows of `status <harness>` (§3.5): `[[label, chain], …]` — the path of new connections, the path with trocar taken out, and each running process that goes another way. */
function routeRows(t, { labels = true } = {}) {
  const rows = []
  // a branch drawn from a process its door group saw is that process's; else it is the path a new process takes (1.6 A.1)
  const who = (b) => { const a = nodeOf(t, b.path[0]); return a && a.pid ? `pid ${a.pid}` : 'new processes' }
  for (const b of distinct(t)) rows.push([`${who(b)}${prefixOf(t, b) ? ` (${prefixOf(t, b).trim()})` : ''}`, chain(t, b.path, true, labels)])
  if (t.branches.some((b) => b.path.some((id) => isTrocar(nodeOf(t, id))))) for (const b of distinct(t)) rows.push([`without trocar${prefixOf(t, b, 'off_path') ? ` (${prefixOf(t, b, 'off_path').trim()})` : ''}`, chain(t, b.off_path, true, labels)])
  for (const r of t.running || []) rows.push([`pid ${r.pid} now`, chain(t, r.path, true, labels)])
  return rows
}

/** `status <harness>`: the `Routes` block, a hop chain to a line, then what could not be read. */
export function renderRoutes(t, { width = 80 } = {}) {
  let rows = routeRows(t)
  if (!rows.length) return []
  const w = () => Math.max(...rows.map(([l]) => l.length))
  const fits = () => rows.every(([l, c]) => 6 + w() + c.length <= width)
  if (!fits()) rows = routeRows(t, { labels: false }) // 附录 A: a chain that does not fit drops where each hop came from first, and never folds
  const pad = w()
  return ['  Routes', ...rows.flatMap(([l, c]) => (6 + pad + c.length <= width ? [`    ${l.padEnd(pad)}  ${c}`] : [`    ${l}`, `      ${c}`])), ...(t.notes || []).map((n) => `    note: ${n}`)]
}

/** The `Routes` block with the two sentences 附录 A asks for after it (kept for callers that want the whole detail in one call). */
export const renderDetail = (t) => [...renderRoutes(t), ...routeNotes(t).map((s) => `  ${s}`)]

/**
 * One line per harness, for a caller that wants the paths of several of them at once (the board and `--json` read the topology itself).
 * `topo` = { <h>: HarnessTopology }, `ids` the order.
 */
export function renderPathBlock(topo, { ids = Object.keys(topo) } = {}) {
  const list = ids.filter((h) => topo[h])
  if (!list.length) return []
  const lines = []
  for (const h of list) {
    const t = topo[h], rows = renderCompact(t)
    rows.forEach((r, i) => lines.push(`  ${i ? ' '.repeat(13) : h.padEnd(13)} ${r}`))
  }
  return lines
}
