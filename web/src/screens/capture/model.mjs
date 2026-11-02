// screens/capture/model.mjs — the capture page as data (1.9): the capture service row, one row per detected agent, the expand
// sections, the machine-wide changes block, the commands and the empty-table foot, all from ONE C.3 `status` document (field presence
// decides, never a version). Framework-free (D75②): no DOM, no timers; CaptureScreen.tsx only renders what this returns.
//
// Each agent row carries at most ONE control (controlFor: the switch, or Set up, or none where the board cannot act); the desired
// state is text only where there is no control; the commands sit in the technical details, spelt with the document's own ids.
import { fmtStamp, fmtWhen, has } from '../../../legacy/core/fmt.mjs'
import { harnessName, harnessKey } from '../../../legacy/core/chips.mjs'
import { mark } from '../../../legacy/core/ui.mjs'
import { redactUrlCredentials } from '../../../legacy/core/sensitive.mjs'
import { agentVerdicts, reasonOf, AGENT_TIER } from '../../../legacy/core/capture-verdict.mjs'
import { controlFor } from '../../../legacy/core/harness-switch.mjs'
import { failureRows } from './log-model.mjs'
import { failureWord } from '../../../../src/cli/words.mjs'
import {
  CONDITION_KIND, SWITCH_WORD, CODE, residueLead, ROUTING, CHANGE_REMOVAL, CHANGE_KIND, CHANGE_FORMAT, RELAYED, COMMANDS,
  UNKNOWN_REASON, ERR_WHERE, FIX_IN_DETAILS,
} from '../../../legacy/labels/capture.mjs'

const list = (x) => (Array.isArray(x) ? x : [])
const T = (text) => ({ text: String(text) })
const M = (mono) => ({ mono: String(mono) })
const P = (...parts) => ({ parts: parts.filter(Boolean) })
const pair = (k, v) => ({ k, v: typeof v === 'string' ? T(v) : v })
const plain = (v) => (v.parts ? v.parts.map(plain).join('') : v.mono ?? v.text)
const copyOf = (pairs) => pairs.map(({ k, v }) => `${k}: ${plain(v)}`).join('\n')
const diagOf = (used) => redactUrlCredentials(JSON.stringify(used, null, 2))
const cap1 = (s) => String(s).replace(/\p{L}/u, (c) => c.toUpperCase()) // a row's sentence starts with a capital
// a row's gutter: bad / warn lamps; the ok dot for capturing / no problems found; nothing for dim and unknown states (1.5)
const gutOf = (cls, fine) => (cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : fine ? 'ok' : null)
const inferred = mark('inf').replace(/<[^>]*>/g, '')
// a condition's words: the CLI's failure table when the condition is a (where, code) failure, else the kind's own
const kindWord = (k) => failureWord(k && k.where, k && (k.code ?? k.kind), '', k && k.cause) || (k && has(CONDITION_KIND, k.kind) ? CONDITION_KIND[k.kind] : null)

/** The commands (1.6's table), only ever in the technical details: per harness spelt as the document spells it; the service row gets the
 *  harness-less ones (a bare on / off would switch every harness). → [label, command][] */
export function commandsFor(h, { row = null, service = false } = {}) {
  const out = [], cmds = COMMANDS
  if (service) out.push(['see the full status', cmds.status.replace(' <id>', '')], ['diagnose', cmds.doctor.replace(' <id>', '')])
  else if (row && row.cliId) {
    const fill = (s) => s.replace('<id>', row.cliId)
    out.push(['start capturing', fill(cmds.on)], ['stop capturing', fill(cmds.off)], ['see the full status', fill(cmds.status)], ['diagnose', fill(cmds.doctor)])
  }
  if (h && h.health && h.health.state === 'not-installed') out.push(['install', cmds.install])
  if (list(h && h.critical).some((k) => k && (k.kind === 'degraded' || k.kind === 'helper-version'))) out.push(['repair the capture helper (needs sudo)', cmds.helper])
  if (h && h.linger === false) out.push(['keep capturing after logout', cmds.linger])
  return out
}
const commandPairs = (cmds) => cmds.map(([k, c]) => pair(k, M(c)))

/** The order while rows are open (1.9 §行的次序): none open → the rule's order; else the rows on screen keep their order, the
 *  ones gone are dropped and the new ones follow in the rule's order. */
export function holdOrder(prevIds, ruleIds, anyOpen) {
  if (!anyOpen) return [...ruleIds]
  const rule = new Set(ruleIds), prev = new Set(prevIds)
  return [...prevIds.filter((id) => rule.has(id)), ...ruleIds.filter((id) => !prev.has(id))]
}

// ── the capture service row (1.9 §采集服务行) — never empty (D38②) ───────────────────────────────────────────────
function serviceOf(h, v) {
  const d = (h && h.daemon) || {}
  const daemonDown = d.running === false || d.responding === false
  const tech = [], conds = []
  // the agent-less current conditions, one sentence each with since T; while the daemon is down they are a past fact in the details
  for (const k of list(h && h.critical).filter((x) => x && x.harness == null)) {
    let what
    if (k.kind === 'untrusted') what = `a process of no known agent does not trust trocar (${k.code || k.reason || UNKNOWN_REASON})`
    else if (k.kind === 'state-mismatch') what = `wanted ${SWITCH_WORD[k.desired] || k.desired || '?'}, actually ${SWITCH_WORD[k.actual] || k.actual || '?'}`
    else what = kindWord(k) || UNKNOWN_REASON
    if (!kindWord(k) && !['untrusted', 'state-mismatch'].includes(k.kind)) tech.push(pair('condition', M(k.kind ?? '?')))
    if (daemonDown) tech.push(pair('condition', `${what} · as of ${fmtWhen(k.since)}`))
    else conds.push(`${what} · since ${fmtWhen(k.since)}`)
  }
  let failing = null
  if (v.state === 'failing') {
    if (d.running === true && d.responding === true) failing = 'The capture service is running'
    else if (!daemonDown) failing = 'The capture service state is unknown'
  }
  // the log, linked once: a failing sentence already carries the group count, so the sentence is the link; else a plain link
  const logged = failureRows(h).length > 0
  if (d.pid != null) tech.push(pair('pid', M(d.pid)))
  if (d.since) tech.push(pair('since', fmtWhen(d.since)))
  if (d.error) tech.push(pair('state could not be read', String(d.error)))
  if (v.raw != null) tech.push(pair('state', M(v.raw)))
  if (v.reason) tech.push(pair('reason', String(v.reason)))
  if (h && h.linger === 'unknown') tech.push(pair('after logout', `not known${h.linger_reason ? ` · ${h.linger_reason}` : ''}`))
  for (const p of list(h && h.holders)) if (p) tech.push(pair('holder', M(`${p.harness ?? '?'} · pid ${p.pid ?? '?'}${p.name ? ` · ${p.name}` : ''}`)))
  const rel = h && h.relayed
  if (rel === 'unknown') tech.push(pair('still relayed', `not known${h.relayed_reason ? ` · ${h.relayed_reason}` : ''}`))
  else if (rel && typeof rel === 'object') {
    const parts = Object.entries(rel).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${n} ${has(RELAYED, k) ? RELAYED[k] : k}`)
    if (parts.length) tech.push(pair('still relayed', parts.join(' · ')))
  }
  for (const e of list(h && h.errors)) if (e) tech.push(pair('could not be read', M(`${e.where ?? '?'}: ${redactUrlCredentials(String(e.reason ?? ''))}`)))
  tech.push(...commandPairs(commandsFor(h, { service: true })))
  return {
    id: '*service', gut: gutOf(v.cls, v.state === 'ok'),
    lead: { text: cap1(v.text), cls: v.cls, toLog: v.state === 'failing' && logged },
    conds, failing, logLink: logged && v.state !== 'failing',
    lingerStop: h && h.linger === false ? 'Capture stops at logout' : null,
    tech, copy: copyOf(tech), diag: diagOf({ health: h && h.health, daemon: d, critical: h && h.critical, errors: h && h.errors }),
  }
}

// ── one agent per row (1.9 §每个 agent 一行) ──────────────────────────────────────────────────────────────────
function relCap(ts) {
  const d = Date.now() - Date.parse(ts)
  if (isNaN(d) || d < 60e3) return 'just now'
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`
  return fmtWhen(ts)
}

// why, and what to do — only on a problem row; each fact said once (1.5)
function whyOf(row) {
  const lines = []
  const say = (t) => { const s = String(t).trim().replace(/\.$/, ''); if (s && !lines.includes(`${s}.`)) lines.push(`${s}.`) }
  const nc = (row.conditions || []).find((k) => k && k.kind === 'negative-cache')
  const r = row.reason || (nc ? { why: kindWord(nc) || UNKNOWN_REASON } : { why: UNKNOWN_REASON })
  say(r.why)
  if (row.restart) say(`Restart ${harnessName(row.harness)}; the new process is captured`)
  else if (r.fix) say(r.fix)
  if (r.command && !r.fix && !row.restart) say(FIX_IN_DETAILS)
  for (const f of row.findings || []) if (typeof f === 'string') { const x = reasonOf(f, { harness: row.harness }); if (!x.unknown) say(x.why) }
  return { lines, tail: row.fromCache ? 'After fixing it, check again (the command is in the technical details).' : 'After fixing it, this row updates itself.' }
}

// `changed[]` items grouped by file: the path once, then what trocar wrote there (a known format or kind in words, else as it came)
function changeLines(items) {
  const byPath = new Map()
  for (const e of items) {
    const p = String(e.path ?? ''), w = String(e.what ?? ''), i = w.indexOf(' ')
    const kind = i < 0 ? w : w.slice(0, i), rest = i < 0 ? '' : w.slice(i + 1)
    if (!byPath.has(p)) byPath.set(p, new Map())
    const kinds = byPath.get(p)
    if (!kinds.has(kind)) kinds.set(kind, [])
    if (rest && !kinds.get(kind).includes(rest)) kinds.get(kind).push(rest)
  }
  return [...byPath].map(([path, kinds]) => {
    const groups = [...kinds].flatMap(([k, all]) => {
      const fm = all.filter((r) => has(CHANGE_FORMAT, r)), rs = all.filter((r) => !has(CHANGE_FORMAT, r))
      return [...fm.map((r) => [T(CHANGE_FORMAT[r])]),
        ...(rs.length || !fm.length ? [[has(CHANGE_KIND, k) ? T(CHANGE_KIND[k]) : M(k), ...(rs.length ? [T(' '), M(rs.join(', '))] : [])]] : [])]
    })
    return { path, parts: groups.flatMap((g, i) => (i ? [T(' · '), ...g] : g)) }
  })
}

const ownChanges = (h, id) => list(h && h.changed).filter((e) => e && e.harness != null && harnessKey(e.harness) === id)

function agentTech(row, h) {
  const tech = []
  for (const k of row.conditions || []) {
    const bits = [k.code ? M(k.code) : null, k.pid != null ? T(`pid ${k.pid}`) : null, k.host ? M(redactUrlCredentials(k.host)) : null, T(`since ${fmtWhen(k.since)}`)].filter(Boolean)
    tech.push(pair(`condition ${k.kind || '?'}`, P(...bits.flatMap((b, i) => (i ? [T(' '), b] : [b])))))
  }
  if (row.code && !(row.conditions || []).length) tech.push(pair('code', M(row.code)))
  const fix = row.reason && row.reason.command
  if (fix && (row.cliId || !fix.includes('<id>'))) tech.push(pair('fix it', M(fix.replace('<id>', row.cliId))))
  const t = row.topology
  if (t) {
    if (t.routing) tech.push(pair('routing', has(ROUTING, t.routing) ? ROUTING[t.routing] : String(t.routing)))
    const byId = new Map(list(t.nodes).filter((n) => n && n.id != null).map((n) => [n.id, n]))
    const chains = new Map() // one row per distinct chain (adjacent repeats said once), with the forms that take it
    for (const b of list(t.branches)) {
      const nodes = list(b && b.path).map((id) => {
        const n = byId.get(id)
        return n && n.name != null ? `${redactUrlCredentials(String(n.name))}${n.inferred ? ` ${inferred}` : ''}` : `unknown${n && n.unknown && n.unknown.reason ? ` · ${n.unknown.reason}` : ''}`
      }).filter((x, i, a) => i === 0 || x !== a[i - 1])
      if (!nodes.length) continue
      const chain = nodes.join(' → ')
      if (!chains.has(chain)) chains.set(chain, new Set())
      const label = [b.form, b.name].filter((x) => x != null && x !== '').join(' ')
      if (label) chains.get(chain).add(label)
    }
    for (const [chain, labels] of chains) tech.push(pair('path', labels.size ? `${chain} · ${[...labels].join(', ')}` : chain))
    for (const p of list(t.running)) if (p && p.pid != null) tech.push(pair('process', M(`${p.pid}${p.note ? ` · ${p.note}` : ''}`)))
    for (const n of list(t.notes)) if (n != null) tech.push(pair('note', String(n)))
    for (const f of new Set(list(t.findings).filter((x) => x != null).map(String))) {
      const x = reasonOf(f, { harness: row.harness })
      tech.push(pair('finding', x.unknown ? M(f) : P(T(x.why), T(' · '), M(f))))
    }
    if (t.routing === 'proxy') tech.push(pair('VPN', `if your VPN routes by process, it sees trocar as the source, not ${harnessName(row.harness)}`))
  }
  const cmds = commandsFor(h, { row })
  const undos = new Set(ownChanges(h, row.harness).filter((e) => e.undo).map((e) => String(e.undo)))
  for (const u of undos) if (!cmds.some(([, c]) => c === u)) tech.push(pair('undo', M(u)))
  tech.push(...commandPairs(cmds))
  return tech
}

// the topology fields this page shows (1.9 §技术细节): the diagnostics carry these and nothing else (an unknown field never leaks, D49)
const TOPO_KEYS = ['at', 'captured', 'reason', 'routing', 'findings', 'notes', 'running']
function topoUsed(t) {
  if (!t || typeof t !== 'object') return null
  const o = {}
  for (const k of TOPO_KEYS) if (t[k] !== undefined) o[k] = t[k]
  if (Array.isArray(t.nodes)) o.nodes = t.nodes.map((n) => n && { id: n.id, name: n.name, inferred: n.inferred, unknown: n.unknown })
  if (Array.isArray(t.branches)) o.branches = t.branches.map((b) => b && { path: b.path, via: b.via })
  return o
}

function rowOf(row, h, { ov, control }) {
  const id = row.harness
  const ctl = controlFor({ control, status: h }, id)
  const problem = row.tier === AGENT_TIER.problem || row.tier === AGENT_TIER.forwarderDown
  const items = ownChanges(h, id)
  const tech = agentTech(row, h)
  const used = { harness: id, verdict: { text: row.text, tier: row.tier, code: row.code, at: row.at }, conditions: row.conditions, topology: topoUsed(row.topology), last_failure: row.lastFailure }
  return {
    id, name: harnessName(id), gut: gutOf(row.cls, row.tier === AGENT_TIER.fine),
    sentence: { text: cap1(row.text), cls: row.cls, dim: row.tier === AGENT_TIER.off || row.wait },
    desired: !ctl.kind && (row.desired === 'on' || row.desired === 'off') ? SWITCH_WORD[row.desired] : '',
    control: ctl,
    last: row.lastCaptured
      ? { href: `#/sessions?h=${encodeURIComponent(id)}`, text: `captured ${relCap(row.lastCaptured)}`, title: fmtStamp(row.lastCaptured) }
      : ov ? { text: 'not captured in the last 24 hours' } : null, // the overview document's last_ts; unread → nothing is claimed
    fail: row.lastFailure ? { href: `#/capture/log?h=${encodeURIComponent(id)}`, text: `latest failure ${fmtWhen(row.lastFailure)} · capture log`, title: fmtStamp(row.lastFailure) } : null,
    defaultOpen: problem,
    why: problem ? whyOf(row) : null,
    changes: items.length ? { lines: changeLines(items), removal: CHANGE_REMOVAL } : null,
    tech, copy: copyOf(tech), diag: diagOf(used),
  }
}

// ── the changes trocar made on this computer (1.9 §改动块): no harness's; information only, no undo ──────────────────────────────
function machineChanges(h) {
  const items = list(h && h.changed).filter((e) => e && e.harness == null)
  const pending = list(h && h.install && h.install.pending).filter((x) => x && typeof x === 'object')
  const manifest = list(h && h.errors).filter((e) => e && e.where === ERR_WHERE.manifest)
  if (!items.length && !pending.length && !manifest.length) return null
  return {
    title: `Changes trocar made on this computer · ${items.length + pending.length}`,
    open: pending.length > 0 || manifest.length > 0, // the install left something pending, or its record cannot be read
    lines: changeLines(items),
    pendingLead: pending.length ? residueLead(pending.some((x) => x.result === 'install did not finish') ? 'install did not finish' : '') : null,
    pending: pending.map((x) => ({
      path: String(x.path || ''), harness: x.harness != null ? harnessKey(x.harness) : null, name: x.harness != null ? harnessName(harnessKey(x.harness)) : null,
      result: failureWord(null, x.result) || (has(CODE, x.result) ? CODE[x.result] : String(x.result ?? '')),
    })),
    manifestError: manifest.length ? 'The install manifest could not be read' : null,
    tech: manifest.length ? manifest.map((e) => pair('could not be read', String(e.reason ?? ''))) : null,
  }
}

/**
 * The capture page of one `status` document. `verdict` = captureVerdict of the same answer; `ov` = the overview document of the last
 * 24 h (null while unread); `control` = the control plane's answer (null before it). → { service, rows, foot, changes }: rows in the
 * rule's order (1.9 §行的次序: the verdict tiers, within a tier the chip table's order); foot = the honest empty-table line or null.
 */
export function pageModel(doc, verdict, { ov = null, control = null } = {}) {
  const verdicts = agentVerdicts(doc, ov)
  const rows = [...verdicts].sort((a, b) => a.tier - b.tier).map((r) => rowOf(r, doc, { ov, control }))
  // not answered yet, or unreadable: whether any agent is set up is unknown; an unreadable install record is said by the changes block
  const foot = doc == null || doc.unreadable != null || verdicts.length || list(doc.errors).some((e) => e && e.where === ERR_WHERE.manifest)
    ? null : 'No agent is set up for capture on this computer'
  return { service: serviceOf(doc, verdict), rows, foot, changes: machineChanges(doc) }
}
