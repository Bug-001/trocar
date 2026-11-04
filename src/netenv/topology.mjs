// topology.mjs (src/netenv) — the path each harness's traffic takes, from facts (RFC 1.6 §9.2–§9.4, D39⑩, D43). `buildTopology(facts)` is pure: no file, no process, no clock. It turns a NetFacts (src/netenv/facts.mjs:
// the daemon, the link, the listeners on this machine, and per harness its proxy setting, its processes and its entry) into `{ <harness>: HarnessTopology }`, the object `status --json` prints
// under `topology` and the board reads; the text (topology-text.mjs) is rendered from that object and from nothing else (V43).
//
// A harness has one or more branches: the path a connection of it takes, `path` with trocar on it and `off_path` with trocar taken out and every setting the same (the way out of trocar changes nothing of the
// agent's route: §9.5 「出口不变」). `on_path` is whether trocar is on the path (true / false / null = not known), `captured` and `reason` are `status`'s verdict on the harness (verdict.mjs, the same function).
// A hop that could not be read stays a node with `unknown: { reason }` (R11); it is never left out and never 「无」. The agent of a branch is the process the chain is drawn for: a steered one whose setting is
// the current one, else a process that is not steered (the chain without trocar is what it really does), else no process (a new one would take this path). Processes whose path is another one are `running`.
// Driver mode (Linux eBPF) is `driverTopology`; proxy mode (4.8 §10: the agent's proxy entry points at trocar's own kernel, one branch per form) is `proxyTopology`, from the facts the Windows branch's
// archFacts gives (`harnesses[h].forms`, `forwarder`); the macOS old capture (§4) is `legacyTopology`.
//
import { judgeHarness, certOfForms } from './verdict.mjs'
import { parseProxyUrl } from './redact.mjs'

export { renderCompact, renderDetail, renderPathBlock, verdictText, firstHopAfterTrocar, firstHopOff, hopKey, ROUTING_TEXT } from './topology-text.mjs' // the words of the topology, rendered from the object below

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const VIA = { http: 'proxy-http', https: 'proxy-https', socks4: 'proxy-socks', socks5: 'proxy-socks', socks5h: 'proxy-socks' }
const ID_PREFIX = { agent: 'a', 'trocar-engine': 'e', 'trocar-forwarder': 'f', 'legacy-mitm': 'm', proxy: 'p', upstream: 'u', egress: 'x', unknown: 'q' }
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
const base = (p) => String(p).split(/[\\/]/).pop()
const errorOf = (e) => (e && e.code) || String((e && e.message) || e)

/** The nodes and edges of one harness. A node is the same node when its kind and what names it are the same (`intern`), so the path with trocar and the path without share their common hops. */
function graph() {
  const nodes = [], edges = [], keyed = new Map(), counts = {}
  const keyOf = (n) => [n.kind, n.pid ?? '', n.name, n.addr ?? '', n.port ?? '', n.unknown ? n.unknown.reason : '', n.role ?? ''].join('|')
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

/** The proxy a setting names, as a node (D49: trocar does not know products): who listens on that port here (named by its executable), or a proxy on another machine. */
function proxyNode(g, F, host, port) {
  if (!LOOPBACK.has(host)) return g.node({ kind: 'proxy', name: `${host}:${port}`, addr: host, port, remote: true })
  const l = F.listeners.find((x) => x.port === port)
  const name = `${host}:${port}`
  if (l && l.unknown) return g.node({ kind: 'proxy', name, addr: host, port, unknown: l.unknown })
  if (l) return g.node({ kind: 'proxy', name: l.exe ? base(l.exe) : name, addr: host, port, pid: l.pid })
  const gone = F.unknowns.find((u) => u.fact === 'listeners' || u.fact === 'arch') // the listeners could not be read (alone, or with the whole platform part): that is why nobody is named, not that nobody listens
  return g.node({ kind: 'proxy', name, addr: host, port, ...(gone ? { unknown: { reason: gone.reason, detail: gone.detail } } : { down: true }) })
}

/** What follows the proxy: the internet. A proxy hop that could not be read says so itself; the hop after it is the internet all the same (1.6 A.1). */
const egressOf = (g) => g.node({ kind: 'egress', name: 'internet' })

const sourceKey = (s) => (s.kind === 'env' ? `env:${s.where}` : s.kind === 'file' ? `file:${s.where}${s.key ? `#${s.key}` : ''}` : s.kind)

/**
 * The hops after the agent (or after trocar), from a setting: the agent's own proxy; else, when it follows the OS proxy (`follow`), the OS proxy; else the API host direct.
 * → { ids: [node ids in order], first: { via, evidence } } — the edge into `ids[0]` is the caller's, since it comes from the agent or from trocar. The edges between the hops are made here.
 */
function tail(g, F, hf, setting, follow) {
  if (setting.unknown) return { ids: [g.node({ kind: 'unknown', name: 'proxy setting', unknown: setting.unknown, ...(setting.inferred === true ? { inferred: true } : {}) })], first: { via: 'unknown', evidence: [] } }
  const ignored = setting.value && hf.behaviour && hf.behaviour.unsupported && hf.behaviour.unsupported[setting.scheme] === 'silent-direct' // the agent does not fail on a scheme it cannot speak: it goes straight out
  if (setting.value && !ignored) {
    const p = proxyNode(g, F, setting.host, setting.port), x = g.edge(p, egressOf(g, p), 'egress')
    return { ids: [p, x], first: { via: VIA[setting.scheme] || 'unknown', evidence: setting.source.map(sourceKey) } }
  }
  const sys = hf.systemProxy
  if (follow && sys) {
    const evidence = ['system-proxy']
    if (sys.unknown) return { ids: [g.node({ kind: 'unknown', name: 'system proxy', unknown: sys.unknown })], first: { via: 'system-proxy', evidence } }
    if (sys.pac) return { ids: [g.node({ kind: 'unknown', name: 'PAC', unknown: { reason: 'pac', detail: 'the OS proxy is a PAC script; trocar does not run it' } })], first: { via: 'system-proxy', evidence } }
    if (sys.value) {
      const u = parseProxyUrl(sys.value)
      if (u) { const p = proxyNode(g, F, u.host, u.port), x = g.edge(p, egressOf(g, p), 'egress'); return { ids: [p, x], first: { via: 'system-proxy', evidence } } }
    }
  }
  // the direct hop names only what was read from the agent's own config (1.6 A.1); a list of hosts it may use is not where it goes
  const hosts = (hf.apiHosts || []).filter(Boolean)
  const u = g.node(hosts.length === 1 ? { kind: 'upstream', name: hosts[0], addr: hosts[0] }
    : hosts.length ? { kind: 'upstream', name: `${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ` and ${hosts.length - 3} more` : ''}` } : { kind: 'upstream', name: 'the API host it uses' })
  const first = ignored ? { via: 'direct', evidence: [`unsupported-scheme:${setting.scheme}`], ...(hf.behaviour.measured === 'lab' ? {} : { inferred: true }) } : { via: 'direct', evidence: hosts.length ? ['config'] : [] } // not measured on this OS: said, not claimed
  return { ids: [u], first }
}

/** Is trocar's side of the platform up for this harness: wanted on, a daemon that answers, a helper, the kernel's links. true / false / null (not known). */
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
    desired: F.desired[h] ?? null, entryIntact: entryIntact(hf), entryWhy: hf.entry.state === 'changed' ? 'entry-changed' : 'entry-missing', attached: F.link.attached, helper: F.link.helper || 'ok', daemon: F.daemon.state,
    procs: hf.procs.map((p) => ({ pid: p.pid, startedAt: p.startedAt, trusted: p.trusted, reason: p.reason, negative: p.negative, start: p.start })), installedAt: hf.installedAt, formsHere: hf.formsHere ?? true,
  })
  return { captured: j.captured, reason: (j.rows.find((r) => r.reason) || {}).reason ?? null, rows: j.rows }
}

const agentOf = (g, h, p) => g.node({ kind: 'agent', name: p ? p.name : h, pid: p ? p.pid : undefined, version: p ? p.version : undefined, path: p ? p.exe : undefined, elevated: p && p.elevated === true ? true : undefined, ...(p && p.elevated === true && p.elevatedInferred === true ? { elevatedInferred: true } : {}) })

/** The branches a harness has: HTTP and WebSocket apart when it reads the OS proxy for one and not the other and there is an OS proxy to read (the path of each differs), else one. */
function branchNames(hf) {
  const b = hf.behaviour || {}
  return (b.branches || []).join() === 'http,ws' && hf.systemProxy ? ['http', 'ws'] : ['all']
}
const followsOf = (hf, name) => !!(hf.behaviour && hf.behaviour.follows && hf.behaviour.follows[name === 'ws' ? 'ws' : 'http'])

function driverTopology(F, h, hf) {
  const g = graph(), v = judged(F, h, hf), up = platformUp(F, h), notes = new Set()
  const current = (p) => p.startSetting == null
  const main = hf.procs.find((p) => current(p) && steeredOf(p) === true) || hf.procs.find((p) => current(p)) || null
  const steered = main ? steeredOf(main) : entryIntact(hf)
  const trocar = up === false || steered === false ? false : up === null || steered === null ? null : true
  const negative = main ? hf.negatives.filter((n) => n.pid === main.pid) : []
  const engine = () => g.node({ kind: 'trocar-engine', name: 'trocar', pid: F.daemon.pid, addr: '127.0.0.1', port: F.daemon.enginePort, mode: 'decrypt', trocar: true, passthrough: negative.length ? { reason: 'negative-cache', hosts: negative.map((n) => n.host) } : undefined })
  const evidenceEbpf = [...(F.link.ids || []).slice(0, 1).map((id) => `link:${id}`), ...(main ? [`watch:${main.pid}`] : [])]
  const build = (p, setting, withTrocar, follow) => {
    const a = agentOf(g, h, p), t = tail(g, F, hf, setting, follow)
    if (t.note) notes.add(t.note)
    const path = [a], off = [a, ...t.ids]
    let from = a
    if (withTrocar) { const e = engine(); g.edge(a, e, 'ebpf', { evidence: evidenceEbpf }); path.push(e); from = e }
    g.edge(from, t.ids[0], t.first.via, { evidence: t.first.evidence, inferred: t.first.inferred })
    if (from !== a) g.edge(a, t.ids[0], t.first.via, { evidence: t.first.evidence, inferred: t.first.inferred }) // the off path: the agent's own way to the same first hop
    return { path: [...path, ...t.ids], off_path: off }
  }
  const branches = branchNames(hf).map((name) => ({ name, ...build(main, hf.setting, trocar === true, followsOf(hf, name)), on_path: trocar, captured: v.captured, reason: v.reason }))
  const running = []
  const mainSteered = main ? steeredOf(main) : trocar
  for (const p of hf.procs) {
    if (p === main) continue
    const stale = !current(p), s = steeredOf(p)
    if (!stale && s === mainSteered) continue
    const b = build(p, stale ? p.startSetting : hf.setting, s === true && up === true, followsOf(hf, 'http'))
    running.push({ pid: p.pid, path: b.path, note: stale ? 'start-time-settings' : 'not-steered', reason: (v.rows.find((r) => r.pid === p.pid) || {}).reason ?? null })
  }
  // NO_PROXY: an agent with a proxy of its own may keep its API host off it. Whether this agent honours the variable is not measured, so the path is drawn by its proxy setting and the note says what may differ.
  const bypass = main && Array.isArray(main.noProxy) ? main.noProxy : hf.noProxy || []
  if (bypass.length && hf.setting && hf.setting.value) notes.add(`NO_PROXY lists ${bypass.join(', ')}: ${h} may reach those without a proxy; the path below follows its proxy setting`)
  return { harness: h, at: F.at, routing: F.routing, desired: F.desired[h] ?? null, on_path: branches[0].on_path, captured: v.captured, reason: v.reason, nodes: g.nodes, edges: g.edges, branches, running, notes: [...notes], findings: [] }
}

// ── proxy mode (D43; 4.8 §10): agent → [its proxy entry, written by trocar] trocar's own kernel → trocar's engine → the upstream the agent would have had without trocar ─────────────────────────────────────────────
// A form is one way of running a harness (codex.cli, claude-code.vscode, …). Per form the facts say: `setting` (the proxy the agent would use without trocar, as of now), `systemProxy`, the `entry` it was
// wired through ({ where, trocar, intact }) or null when it is not, `procs`, `route` (the group's own plan: why it was left unwired — `form-unsupported`
// is a verdict of its own, 4.8 §2.2) and `entryPlace` (where the entry lives, filled in — the doctor's commands that name the place read it, 4.8 §10.4); and the kernel's own `forwarder.forms[id]` ({ port, state: 'on' | 'forward-only',
// upstream, source, clients, upstream_error? }) and `routeLoop` on a form it refused to wire. The upstream is what the kernel and the engine dial: the agent's own proxy, else the OS proxy a form that follows it has, else the API host direct (4.8 §2.2).

/** The verdict on one form: [on_path, captured, reason, engine] — `engine`: whether the engine is on the path (the kernel only forwards for a process it cannot tell, for an agent that is off or when the engine is gone). */
function formVerdict(F, h, hf, fm, fwf) {
  const none = (on, captured, reason) => ({ on, captured, reason, engine: false })
  const main = fm.procs.find((p) => p.elevated === true) || null
  if (fm.routeLoop === true) return none(false, false, 'route-loop') // the platform refused to wire a form whose upstream would be trocar itself (4.8 §2.2)
  // before the entry checks, like judgeHarness's own order: after a real `off` the entry record is gone from the manifest and the file holds the user's own value again, so the entry checks would
  // answer not-routed and the drain window would never be drawn (4.8 §10.2 row k / 1.6 §9.3 row 14) — what says the agent is still on the kernel is its live connection to the group's port.
  if (F.desired[h] === 'off') return none(!!(fwf && fwf.clients && fwf.clients.length), false, 'desired-off')
  // the plan's own word for a group it left unwired — the entry that takes no login given a credentialed upstream (4.8 §2.2 · §6.4) — before the entry checks, like desired-off above: a named group
  // the plan gated off still has its ledger records, and the entry edge they give it (`intact` unknown until checkEntries lands) would mask the verdict the same way the entry checks used to
  // mask the drain window — through the real facts path the form-unsupported verdict was unreachable and `doctor` could never emit its row.
  if (fm.route && fm.route.reason === 'form-unsupported') return none(false, false, 'form-unsupported')
  if (fm.hook) return none(false, false, fm.hook) // the wrapper / plugin that applies the route was replaced or is gone: the agent runs without it (1.6 §9.3 row 31; its command is `trocar install`)
  if (!fm.entry) return none(false, false, 'not-routed') // anything else the plan left unwired is not-routed, the why on the form's `route`
  if (fm.entry.intact === null) return none(null, null, null)
  if (fm.entry.intact === false) return none(false, false, 'proxy-changed')
  if (!F.forwarder || F.forwarder.up === false || !fwf || fwf.down) return none(true, false, 'forwarder-down')
  if (main) return none(true, false, 'elevated-agent')
  if (F.daemon.state === 'not-running' || F.daemon.state === 'not-responding') return none(true, false, `daemon-${F.daemon.state}`)
  if (fwf.upstream_error) return { on: true, captured: false, reason: 'upstream-unreachable', engine: true } // the engine could not dial the upstream (the platform's last 60 s of it)
  const j = judgeHarness({ localUpstream: hf.localUpstream === true, desired: 'on', entryIntact: entryIntact(hf), entryWhy: 'entry-missing', attached: fwf.state === 'on', helper: 'ok', daemon: F.daemon.state, procs: fm.procs.map((p) => ({ pid: p.pid, startedAt: p.startedAt, trusted: p.trusted, reason: p.reason, negative: p.negative, start: p.start })), installedAt: hf.installedAt, cert: certOfForms([fm]) })
  const reason = (j.rows.find((r) => r.reason) || {}).reason ?? null
  if (reason === 'local-upstream' && j.captured !== true) return none(false, false, reason) // its config names only hosts on this machine: loopback never reaches the door (4.11 P6), trocar is off its path
  return { on: true, captured: j.captured, reason, engine: true }
}

/** The hops after the kernel: what it dials as its upstream (4.8 §2.2). */
function upstreamTail(g, F, hf, fm, fwf) {
  if (fwf.upstream === 'DIRECT' || fwf.source === 'direct') return tail(g, F, hf, { value: null, source: [] }, false)
  const u = parseProxyUrl(fwf.upstream)
  if (!u) return { ids: [g.node({ kind: 'unknown', name: 'upstream', unknown: { reason: 'unparseable', detail: 'the upstream trocar dials is not a URL' } })], first: { via: 'unknown', evidence: [] } }
  if (fwf.source === 'system-proxy') return tail(g, F, { ...hf, systemProxy: { value: fwf.upstream, pac: false } }, { value: null, source: [] }, true)
  return tail(g, F, hf, { value: fwf.upstream, ...u, source: fm.setting.source || [] }, false)
}

function proxyTopology(F, h, hf) {
  const g = graph(), branches = [], notes = []
  // a process on none of the harness's forms here (status's `start` not-routed, 4.11 P5: another install of it): it goes its own way, so it is no form's
  const strays = hf.procs.filter((p) => p.start === 'not-routed'), stray = new Set(strays.map((p) => p.pid))
  for (const f0 of hf.forms || []) {
    const fm = { ...f0, procs: f0.procs.filter((p) => !stray.has(p.pid)) }
    const fwf = F.forwarder && F.forwarder.forms ? F.forwarder.forms[fm.id] : null
    const vd = formVerdict(F, h, hf, fm, fwf)
    const main = fm.procs.find((p) => p.elevated === true) || fm.procs[0] || null
    // what wires the kernel hop: the entry holding the kernel's address (the form is on), or — in the post-off drain window, where a real `off` has taken the record out of the manifest and the
    // file is the user's own again — the agent's live connection to the group's port (row k). In the drain the edge names no entry: the file no longer points here; the agent holds the address it
    // read at startup, and the note says what restart ends it.
    const wired = !!(fwf
      && (F.desired[h] === 'off' ? (fwf.clients || []).length > 0 : !fm.hook && fm.entry && fm.entry.intact === true && vd.reason !== 'local-upstream'))
    const hfSys = { ...hf, systemProxy: fm.systemProxy }
    const split = (hf.behaviour.branches || []).join() === 'http,ws' && fm.systemProxy
    if (vd.reason === 'desired-off' && fwf && (fwf.clients || []).length) notes.push(`${fwf.clients.length} process(es) are still connected through trocar, forwarded only; trocar exits once they do`)
    if (fm.hosts && wired) {
      // the host-tree lines of 4.8 §3 (W69): the host program's other connections only forward, only the form's host set reaches the engine; the extension's own settings, when they
      // cannot be read, leave the set at the defaults and extra_hosts (said, never silent); and a fresh read that differs from what the daemon reports as applied means the door's
      // set is old — the line names the command that recomputes it, `status` itself changes nothing (read-only).
      const program = fm.hosts.program || 'the host program', extension = fm.hosts.extension || 'this form'
      notes.push(`${program}'s other connections are forwarded only; only the hosts of ${extension} are captured`)
      if (fm.hosts.settings && fm.hosts.settings.unreadable) {
        const u = fm.hosts.settings.unreadable
        notes.push(`${extension}'s own settings could not be read (${u.reason}${u.detail ? `: ${u.detail}` : ''}): only its default hosts (${(fm.hosts.defaults || []).join(', ')}) are captured`)
      }
      if (Array.isArray(fm.hosts.applied) && [...fm.hosts.applied].sort().join('|') !== [...fm.hosts.hosts].sort().join('|')) {
        notes.push(`the host set in use is older than ${extension}'s settings; to bring it up to date run: trocar on ${h}`)
      }
    }
    for (const name of split ? ['http', 'ws'] : ['all']) {
      const a = agentOf(g, h, main), off = tail(g, F, hfSys, fm.setting, (fm.follows || hf.behaviour.follows)[name === 'ws' ? 'ws' : 'http'])
      let path = [a, ...off.ids]
      g.edge(a, off.ids[0], off.first.via, { evidence: off.first.evidence, inferred: off.first.inferred })
      if (wired) {
        const forwardOnly = F.desired[h] === 'off' || vd.reason === 'elevated-agent' || !vd.engine && vd.on
        const f = g.node({ kind: 'trocar-forwarder', name: 'trocar', pid: F.forwarder.pid, addr: '127.0.0.1', port: fwf.port, trocar: true, mode: vd.reason === 'forwarder-down' ? 'down' : forwardOnly ? 'forward-only' : 'on' })
        g.edge(a, f, 'proxy-http', { trocar: true, ...(fm.entry ? { entry: { where: fm.entry.where, opt_in: fm.entry.opt_in === true } } : {}) })
        if (vd.reason === 'forwarder-down') path = [a, f]
        else {
          const up = upstreamTail(g, F, hfSys, fm, fwf)
          if (vd.engine) {
            const e = g.node({ kind: 'trocar-engine', name: 'trocar', pid: F.daemon.pid, addr: '127.0.0.1', port: F.daemon.enginePort, mode: 'decrypt', trocar: true })
            g.edge(f, e, 'forward'); g.edge(e, up.ids[0], up.first.via, { evidence: up.first.evidence, inferred: up.first.inferred }); path = [a, f, e, ...up.ids]
          } else { g.edge(f, up.ids[0], up.first.via, { evidence: up.first.evidence, inferred: up.first.inferred }); path = [a, f, ...up.ids] }
        }
      }
      branches.push({ name, form: fm.id, path, off_path: [a, ...off.ids], on_path: vd.on, captured: vd.captured, reason: vd.reason })
    }
  }
  // each such process, and with none of its forms on this machine the harness itself: a direct path, trocar on none of it (`form: null`)
  for (const p of strays.length ? strays : !branches.length && hf.formsHere === false ? [hf.procs[0] || null] : []) {
    const a = agentOf(g, h, p), off = tail(g, F, hf, hf.setting || { value: null, source: [] }, followsOf(hf, 'http'))
    g.edge(a, off.ids[0], off.first.via, { evidence: off.first.evidence, inferred: off.first.inferred })
    branches.push({ name: 'all', form: null, path: [a, ...off.ids], off_path: [a, ...off.ids], on_path: false, captured: false, reason: F.desired[h] === 'off' ? 'desired-off' : 'not-routed' })
  }
  if (!branches.length) throw new Error('the harness has no form to draw')
  // the drift of a field trocar owns (4.8 §10.3): the user changed the entry's key, trocar is bypassed — the line names the one command that re-adopts it. Driver mode's proxy-changed is
  // expected (the kernel steers whatever the setting says; 1.6 附录 B gives it no command), so the note is this drawing's, said once per harness however many forms share the group.
  if (branches.some((x) => x.reason === 'proxy-changed')) notes.push(`To put trocar back on its path: trocar on ${h}`)
  for (const u of F.unknowns.filter((x) => x.reason === 'kernel-filter-invisible')) notes.push('A kernel filter such as WFP is not visible to your user.')
  // the harness's own captured / reason are its verdict, which status fills in (statusDocOf); on_path is every branch's
  const on = branches.map((x) => x.on_path), onPath = on.every((v) => v === true) ? true : on.every((v) => v === false) ? false : null
  return { harness: h, at: F.at, routing: F.routing, desired: F.desired[h] ?? null, on_path: onPath, captured: null, reason: null, nodes: g.nodes, edges: g.edges, branches, running: [], notes: [...new Set(notes)], findings: [] }
}

// ── the macOS old capture: the system proxy → the VPN's script block → trocar's old MITM → the VPN again ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The facts bring the old capture's verdict: `legacy: { mitm: { addr, port, pid } | null, on_path, captured, reason }`. The MITM and the VPN that routes into it and out of it
// are two nodes of the same product (`role`), so the path is a path of distinct nodes.
function legacyTopology(F, h, hf) {
  const g = graph(), main = hf.procs[0] || null, a = agentOf(g, h, main), l = hf.legacy || {}
  const sys = hf.systemProxy && hf.systemProxy.value ? parseProxyUrl(hf.systemProxy.value) : null
  if (!sys) throw new Error('the old capture is drawn from the OS proxy it routes through, and the facts have none')
  const p = proxyNode(g, F, sys.host, sys.port), x = g.edge(p, egressOf(g, p), 'egress'), off = [a, p, x]
  g.edge(a, p, 'system-proxy', { evidence: ['system-proxy'] })
  let path = off
  if (l.mitm && l.on_path !== false) {
    const m = g.node({ kind: 'legacy-mitm', name: 'trocar old MITM', pid: l.mitm.pid, addr: l.mitm.addr, port: l.mitm.port, trocar: true })
    const pn = g.nodes.find((n) => n.id === p), p2 = g.node({ ...pn, id: undefined, role: 'upstream', unknown: pn.unknown })
    g.edge(p, m, 'proxy-http', { evidence: ['legacy-block'] }); g.edge(m, p2, 'proxy-http', { evidence: [] }); g.edge(p2, x, 'egress')
    path = [a, p, m, p2, x]
  }
  return { harness: h, at: F.at, routing: 'legacy', desired: F.desired[h] ?? null, on_path: l.on_path ?? null, captured: l.captured ?? null, reason: l.reason ?? null, nodes: g.nodes, edges: g.edges,
    branches: [{ name: 'all', path, off_path: off, on_path: l.on_path ?? null, captured: l.captured ?? null, reason: l.reason ?? null }], running: [], notes: [], findings: [] }
}

const BY_ROUTING = { driver: driverTopology, none: driverTopology, unknown: driverTopology, proxy: proxyTopology, legacy: legacyTopology }

/** `{ <harness>: HarnessTopology }` for every harness the facts have. Pure. A harness the facts cannot be drawn from gets the one node it is, an on_path of null and the reason in `notes` (not known is said). */
export function buildTopology(F) {
  const out = {}
  for (const [h, hf] of Object.entries(F.harnesses)) {
    try { out[h] = (BY_ROUTING[F.routing] || driverTopology)(F, h, hf) } catch (e) {
      out[h] = { harness: h, at: F.at, routing: 'unknown', desired: F.desired[h] ?? null, on_path: null, captured: null, reason: null, nodes: [{ id: 'a', kind: 'agent', name: h }], edges: [], branches: [{ name: 'all', path: ['a'], off_path: ['a'], on_path: null, captured: null, reason: null }], running: [], notes: [`the path could not be worked out: ${errorOf(e)}`], findings: [] }
    }
  }
  return out
}
