// capture/capture-view.mjs — the pure renderers of the 采集 page (1.9): the 采集服务 row, one row per detected agent, the
// expand sections, the 改动 block and the commands. Everything is a string builder over ONE C.3 `status` document (field presence
// decides, never a version). No DOM, no timers: capture.mjs owns the mounting, the poll and the expand memory.
//
// Each agent row carries at most ONE control (core/harness-switch.mjs: the switch, or Set up; none where the board cannot act); the
// desired state is also TEXT, and the commands sit in 技术细节 filled in with the document's own spelling (never a front-end CLI name
// table). No restart, no 点名, no elevated, no install, no undo button (1.9 §开关).
import { esc, fmtStamp, fmtWhen, has } from '../core/fmt.mjs'
import { harnessIcon, harnessName, harnessKey } from '../core/chips.mjs'
import { mark, disclosureHtml } from '../core/ui.mjs'
import { copyBtn } from '../core/dom.mjs'
import { redactUrlCredentials } from '../core/sensitive.mjs'
import { agentVerdicts, reasonOf, AGENT_TIER } from '../core/capture-verdict.mjs'
import { controlFor, controlHtml } from '../core/harness-switch.mjs'
import { logRowsOf } from './capture-log.mjs'
import { failureWord } from '../../../src/cli/words.mjs'
import {
  CONDITION_KIND, SWITCH_WORD, CODE, residueLead, ROUTING, CHANGE_REMOVAL, CHANGE_KIND, CHANGE_FORMAT, RELAYED, COMMANDS,
  UNKNOWN_REASON, ERR_WHERE, FIX_IN_DETAILS,
} from '../labels/capture.mjs'

const mono = (s) => `<span class="mono">${esc(s)}</span>` // a machine fact: id, path, code, command
const when = (t) => esc(fmtWhen(t))
const list = (x) => (Array.isArray(x) ? x : [])
const lamp = (cls) => (cls ? `<span class="lamp ${esc(cls)}" aria-hidden="true"></span>` : '')
const okDot = '<span class="capdot" aria-hidden="true"></span>'
// a row's gutter: bad / warn lamps; the ok dot for 在采 / 没有发现问题; nothing for dim and unknown states (1.5: 正常不点灯,
// 不知道不点灯)
const gutOf = (cls, fine) => (cls === 'bad' ? lamp('bad') : cls === 'warn' ? lamp('warn') : fine ? okDot : '')

// the leading state word carries the severity colour; the rest of the sentence stays ink (visual doc). The head is the
// text up to the first ':' or ' ·' — the mark of a 采集服务 sentence, or 「没在采」/「可能连不上网」 of an agent's.
// A row's sentence starts with a capital (the verdict's own text otherwise unchanged; the 总览 page uses it mid-line).
const leadHtml = (text, cls) => {
  const s = String(text).replace(/\p{L}/u, (c) => c.toUpperCase())
  if (cls !== 'bad' && cls !== 'warn') return esc(s)
  const m = /^(.*?)(?::| · )/.exec(s)
  const head = m ? m[1] : s
  return `<span class="sw">${esc(head)}</span>${esc(s.slice(head.length))}`
}

// ── the commands (1.6's table) — only ever inside 技术细节 ─────────────────────────────────────────────────────────
// per harness, spelt the way the document itself spells it (`harnesses` keys); a row the document does not name gets none. The
// capture service row gets only the harness-less ones (status, doctor without <id>): a bare on / off would switch every harness.
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

// 技术细节 for this page: a [key, value] grid where a value is a RAW plain string (escaped here, once), {m} (a machine fact — id,
// path, code, command — set in mono) or {h} (real markup, escaped inside once). The disclosure's copy button carries the PLAIN text of the pairs; the diagnostics
// copy carries the fields the row used (metadata only, credentials redacted).
const techPairGrid = (pairs) => `<div class="tech">${pairs.map(([k, v]) =>
  `<span class="k">${esc(k)}</span><span class="v">${v && v.m != null ? `<span class="mono">${esc(v.m)}</span>` : v && v.h != null ? v.h : esc(v)}</span>`).join('')}</div>`
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const plainOf = (v) => v && v.m != null ? v.m : v && v.h != null ? unesc(v.h.replace(/<[^>]*>/g, '')) : v
const detailsHtml = (id, pairs) => disclosureHtml({
  id, title: 'Technical details', open: false,
  body: techPairGrid(pairs) + copyBtn(pairs.map(([k, v]) => `${k}: ${plainOf(v)}`).join('\n')),
})
const M = (m) => ({ m })
const H = (h) => ({ h })
const diagCopy = (obj) => copyBtn(redactUrlCredentials(JSON.stringify(obj, null, 2)), 'Copy diagnostics')
const commandsHtml = (pairs) => pairs.map(([k, v]) => [k, M(v)])
// a condition's words: the CLI's failure table when the condition is a (where, code) failure (negative-cache), else the kind's own
const kindWord = (k) => failureWord(k && k.where, k && (k.code ?? k.kind), '', k && k.cause) || (k && has(CONDITION_KIND, k.kind) ? CONDITION_KIND[k.kind] : null)
// the topology fields this page shows (1.9 §技术细节) — the copy carries these and nothing else (an unknown field never leaks, D49)
const TOPO_KEYS = ['at', 'captured', 'reason', 'routing', 'findings', 'notes', 'running']
const topoUsed = (t) => {
  if (!t || typeof t !== 'object') return null
  const o = {}
  for (const k of TOPO_KEYS) if (t[k] !== undefined) o[k] = t[k]
  if (Array.isArray(t.nodes)) o.nodes = t.nodes.map((n) => n && { id: n.id, name: n.name, inferred: n.inferred, unknown: n.unknown })
  if (Array.isArray(t.branches)) o.branches = t.branches.map((b) => b && { path: b.path, via: b.via })
  return o
}

// the open state of every row of one paint: the reader's own choice (their folded / expanded rows) wins over the
// default (a problem row opens, the rest stay folded); the service row follows the reader only (1.9 §页面结构 重读不打断人)
export function openStates(ordered, openByReader) {
  const of = (h, def) => (openByReader && openByReader.has(h) ? openByReader.get(h) : def)
  const m = new Map([['*service', of('*service', false)]])
  for (const r of ordered) m.set(r.harness, of(r.harness, r.tier === AGENT_TIER.problem || r.tier === AGENT_TIER.forwarderDown))
  return m
}

// ── the 采集服务 row (1.9 §采集服务行) — the first row of the table, never empty (D38②) ───────────────────────────
// `v` is captureVerdict(capH) of the same document; the status sentence IS its text (one wording for the whole board).
export function serviceRowHtml(h, v, { open = false } = {}) {
  const d = (h && h.daemon) || {}
  // the agent-less current conditions (`critical[]` without `harness`), one sentence each with 自 T 起 (1.9 §条件的话)
  const condLine = (k) => {
    const t = when(k.since)
    if (k.kind === 'untrusted' || k.kind === 'negative-cache') {
      const what = k.kind === 'negative-cache' ? kindWord(k) || UNKNOWN_REASON : `a process of no known agent does not trust trocar (${k.code || k.reason || UNKNOWN_REASON})`
      return `<p>${esc(what)} · since ${t}</p>`
    }
    if (k.kind === 'state-mismatch') return `<p>wanted ${esc(SWITCH_WORD[k.desired] || k.desired || '?')}, actually ${esc(SWITCH_WORD[k.actual] || k.actual || '?')} · since ${t}</p>`
    const word = kindWord(k)
    return `<p>${esc(word || UNKNOWN_REASON)}${word ? '' : ` (${esc(k.kind)})`} · since ${t}</p>`
  }
  const daemonDown = d.running === false || d.responding === false
  const conds = daemonDown ? '' : list(h && h.critical).filter((k) => k && k.harness == null).map(condLine).join('')
  // the daemon's own state while the health is failing: 在跑 / 状态不知道
  let failingLine = ''
  if (v.state === 'failing') {
    if (d.running === true && d.responding === true) failingLine = '<p>The capture service is running</p>'
    else if (!daemonDown) failingLine = '<p>The capture service state is unknown</p>'
  }
  // the log, linked once (1.9): a failing sentence already carries the group count, so the sentence itself is the link;
  // otherwise a plain link without a number; an empty log draws nothing
  const logged = logRowsOf(h).rows.length > 0
  const lead = v.state === 'failing' && logged ? `<a href="#/capture/log">${leadHtml(v.text, v.cls)}</a>` : leadHtml(v.text, v.cls)
  const logLink = logged && v.state !== 'failing' ? '<a href="#/capture/log">capture log ›</a>' : ''
  const lingerStop = h && h.linger === false ? '<p>Capture stops at logout</p>' : ''
  return `<div class="crow" data-h="*service">` +
    `<div class="crow-t"><span class="gut">${gutOf(v.cls, v.state === 'ok')}</span>` +
    `<button type="button" class="nm cap-nm" data-caprow="cap-svc" aria-expanded="${open}" aria-controls="cap-svc-x"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>Capture service</button>` +
    '<span class="des"></span>' +
    `<span class="stt stt-${esc(v.cls)}"><p class="lead">${lead}</p>${conds}${failingLine}</span>` +
    `<span class="last">${logLink}${lingerStop}</span><span class="ctl"></span></div>` +
    `<div class="cexp" id="cap-svc-x"${open ? '' : ' hidden'}>${serviceTechHtml(h, v)}</div></div>`
}

// the 采集服务 row's 技术细节: the daemon's pid / since / error, the processes holding trocar, the relayed streams, an unseen
// state as it came, the read problems, the commands, and the copy of the fields this row used (metadata only)
function serviceTechHtml(h, v) {
  const d = (h && h.daemon) || {}
  const rows = []
  if (d.pid != null) rows.push(['pid', M(d.pid)])
  if (d.since) rows.push(['since', fmtWhen(d.since)])
  if (d.error) rows.push(['state could not be read', String(d.error)])
  if (v.raw != null) rows.push(['state', M(String(v.raw))])
  if (v.reason) rows.push(['reason', String(v.reason)])
  // Linux only: the OS keeps the service after logout or not; a boolean is said in the row (false) or not at all (true)
  if (h && h.linger === 'unknown') rows.push(['after logout', `not known${h.linger_reason ? ` · ${h.linger_reason}` : ''}`])
  for (const p of list(h && h.holders)) if (p) rows.push(['holder', M(`${p.harness ?? '?'} · pid ${p.pid ?? '?'}${p.name ? ` · ${p.name}` : ''}`)])
  // the connections still relayed after an off: only the non-zero counts, in words
  const rel = h && h.relayed
  if (rel === 'unknown') rows.push(['still relayed', `not known${h.relayed_reason ? ` · ${h.relayed_reason}` : ''}`])
  else if (rel && typeof rel === 'object') {
    const parts = Object.entries(rel).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${n} ${has(RELAYED, k) ? RELAYED[k] : k}`)
    if (parts.length) rows.push(['still relayed', parts.join(' · ')])
  }
  for (const e of list(h && h.errors)) if (e) rows.push(['could not be read', M(`${e.where ?? '?'}: ${redactUrlCredentials(String(e.reason ?? ''))}`)])
  rows.push(...commandsHtml(commandsFor(h, { service: true })))
  return detailsHtml('cap-svc-tech', rows) + `<div class="capcopy">${diagCopy({ health: h && h.health, daemon: d, critical: h && h.critical, errors: h && h.errors })}</div>`
}

// ── one agent per row (1.9 §每个 agent 一行) ───────────────────────────────────────────────────────────────────
// The union of every source that names an agent, each id folded by harnessKey — the rows come from agentVerdicts (the
// same sentences the 总览 page's items use); rowOrder() sorts them for display.
export const agentIdsOf = (h) => agentVerdicts(h).map((r) => r.harness)

// the row order (1.9 §行的次序): 可能连不上网 > 没在采、重启后生效 > 不知道 > 在采、没有发现问题 > 关着; within a
// tier the chip table's order, an id the table does not know last (agentVerdicts already yields that order — a stable
// sort by tier keeps it)
export const rowOrder = (verdicts) => [...verdicts].sort((a, b) => a.tier - b.tier)

export function agentRowHtml(row, h, { open = false, ov = null, control = null, ui = null } = {}) {
  const name = harnessName(row.harness)
  // the desired state as text only where the row draws no control (a switch already says it; 1.9 期望态)
  const ctl = controlFor({ control, status: h }, row.harness)
  const desired = !ctl.kind && (row.desired === 'on' || row.desired === 'off') ? SWITCH_WORD[row.desired] : ''
  const last = row.lastCaptured
    ? `<a href="#/sessions?h=${esc(row.harness)}" title="${esc(fmtStamp(row.lastCaptured))}">captured ${esc(relCap(row.lastCaptured))} ›</a>`
    : ov ? '<span>not captured in the last 24 hours</span>' : '' // the `overview` document's harnesses[].last_ts (1.9); unread → nothing is claimed
  const fail = row.lastFailure ? `<a href="#/capture/log?h=${esc(row.harness)}" title="${esc(fmtStamp(row.lastFailure))}">latest failure ${when(row.lastFailure)} · capture log ›</a>` : ''
  const problem = row.tier === AGENT_TIER.problem || row.tier === AGENT_TIER.forwarderDown
  return `<div class="crow" data-h="${esc(row.harness)}">` +
    `<div class="crow-t"><span class="gut">${gutOf(row.cls, row.tier === AGENT_TIER.fine)}</span>` +
    `<button type="button" class="nm cap-nm" data-caprow="cap-${esc(row.harness)}" aria-expanded="${open}" aria-controls="cap-${esc(row.harness)}-x">` +
    `<span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${harnessIcon(row.harness)}<span class="chipname">${esc(name)}</span></button>` +
    `<span class="des">${esc(desired)}</span>` +
    `<span class="stt stt-${esc(row.cls)}${row.tier === AGENT_TIER.off || row.wait ? ' dim' : ''}"><p class="lead">${leadHtml(row.text, row.cls)}</p></span>` +
    `<span class="last">${last}${fail}</span>` +
    `<span class="ctl">${controlHtml(ctl, (ui && ui.get(row.harness)) || {})}</span></div>` +
    `<div class="cexp" id="cap-${esc(row.harness)}-x"${open ? '' : ' hidden'}>${expandHtml(row, h, { problem })}</div></div>`
}

// 「N 分钟前」-style for the last capture (a link to the sessions of this harness)
function relCap(ts) {
  const d = Date.now() - Date.parse(ts)
  if (isNaN(d) || d < 0) return 'just now'
  if (d < 60e3) return 'just now'
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`
  return fmtWhen(ts)
}

// the expand of an agent row, at most three sections (1.9 §展开). `problem` rows get 为什么 · 怎么办; the changes section
// only while the answer carries S9 (or a prior-value note); 技术细节 is always there.
export function expandHtml(row, h, { problem = false } = {}) {
  const out = []
  if (problem) out.push(whyHtml(row))
  const ch = changesFor(row, h)
  if (ch) out.push(ch)
  return (out.length ? `<dl class="exp">${out.join('')}</dl>` : '') + `<div class="exp-tech">${agentTechHtml(row, h)}</div>`
}

// 为什么 · 怎么办 — only on a problem row. The why is the row's own reason (agentVerdicts' reasonOf: the board's why / fix, the
// data's words, else the shared catalog's clause, whose command sits in 技术细节); a restart-kind code names the restart; a cached
// verdict's further findings follow. Each fact is said once (1.5): a finding that repeats the reason is not said again. The last line
// says whether the row updates by itself (a live condition) or needs a re-check (a cached verdict).
function whyHtml(row) {
  const said = new Set(), ps = []
  const say = (t) => { const s = String(t).trim().replace(/\.$/, ''); if (s && !said.has(s)) { said.add(s); ps.push(`<p>${esc(s)}.</p>`) } }
  const nc = (row.conditions || []).find((k) => k && k.kind === 'negative-cache')
  const r = row.reason || (nc ? { why: kindWord(nc) || UNKNOWN_REASON } : { why: UNKNOWN_REASON })
  say(r.why)
  if (row.restart) say(`Restart ${harnessName(row.harness)}; the new process is captured`)
  else if (r.fix) say(r.fix)
  if (r.command && !r.fix && !row.restart) say(FIX_IN_DETAILS)
  for (const f of row.findings || []) if (typeof f === 'string') { const x = reasonOf(f, { harness: row.harness }); if (!x.unknown) say(x.why) }
  ps.push(row.fromCache ? '<p class="fine">After fixing it, check again (the command is in the technical details).</p>' : '<p class="fine">After fixing it, this row updates itself.</p>')
  return `<dt>Why, and what to do</dt><dd>${ps.join('')}</dd>`
}

// trocar 为它改了 — the `changed[]` items of this harness (path · what) plus the removal sentence; information only, no undo
// control (`undo` sits in 技术细节). No item → the whole section is not drawn, 「没有改动」 is never said.
function changesFor(row, h) {
  const items = list(h && h.changed).filter((e) => e && e.harness != null && harnessKey(e.harness) === row.harness)
  if (!items.length) return null
  const lines = changeLines(items)
  lines.push(`<p class="fine">${esc(CHANGE_REMOVAL)}</p>`)
  return `<dt>Changed for it by trocar</dt><dd>${lines.join('')}</dd>`
}

// `changed[]` items grouped by file: the path once (mono), then what trocar wrote there — `what` is the manifest kind followed by the
// key path or format (src/cli/status.mjs changedOf); a known format in words in place of its kind (CHANGE_FORMAT), a known kind in
// words (CHANGE_KIND), an unknown one as it came; one kind's keys
// joined. Shared by an agent row and the machine-wide block.
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
  const out = []
  for (const [p, kinds] of byPath) {
    const parts = [...kinds].flatMap(([k, all]) => {
      const fm = all.filter((r) => has(CHANGE_FORMAT, r)), rs = all.filter((r) => !has(CHANGE_FORMAT, r))
      return [...fm.map((r) => esc(CHANGE_FORMAT[r])), ...(rs.length || !fm.length ? [`${has(CHANGE_KIND, k) ? esc(CHANGE_KIND[k]) : mono(k)}${rs.length ? ` ${mono(rs.join(', '))}` : ''}`] : [])]
    })
    out.push(`<p>${mono(p)}</p><p>${parts.join(' · ')}</p>`)
  }
  return out
}

// an agent row's 技术细节: the condition codes / pids / hosts, the routing and branches (redacted), the running processes, the
// findings, the undo commands of its changes, the commands, the copy of the fields the row used
function agentTechHtml(row, h) {
  const rows = []
  for (const k of row.conditions || []) {
    rows.push([`condition ${k.kind || '?'}`, H(`${k.code ? `<span class="mono">${esc(k.code)}</span> ` : ''}${k.pid != null ? `pid ${esc(k.pid)} ` : ''}${k.host ? `<span class="mono">${esc(redactUrlCredentials(k.host))}</span> ` : ''}since ${when(k.since)}`)])
  }
  if (row.code && !(row.conditions || []).length) rows.push(['code', M(row.code)])
  const fix = row.reason && row.reason.command
  if (fix && (row.cliId || !fix.includes('<id>'))) rows.push(['fix it', M(fix.replace('<id>', row.cliId))])
  const t = row.topology
  if (t) {
    if (t.routing) rows.push(['routing', has(ROUTING, t.routing) ? ROUTING[t.routing] : t.routing])
    const name = new Map(list(t.nodes).filter((n) => n && n.id != null).map((n) => [n.id, n]))
    // one row per distinct chain (adjacent repeats of one node said once), with the forms that take it
    const chains = new Map()
    for (const b of list(t.branches)) {
      const nodes = list(b && b.path).map((id) => {
        const n = name.get(id)
        return n && n.name != null ? `${redactUrlCredentials(String(n.name))}${n.inferred ? ' ' + unesc(mark('inf').replace(/<[^>]*>/g, '')) : ''}` : `unknown${n && n.unknown && n.unknown.reason ? ` · ${n.unknown.reason}` : ''}`
      }).filter((x, i, a) => i === 0 || x !== a[i - 1])
      if (!nodes.length) continue
      const chain = nodes.join(' → ')
      if (!chains.has(chain)) chains.set(chain, new Set())
      const label = [b.form, b.name].filter((x) => x != null && x !== '').join(' ')
      if (label) chains.get(chain).add(label)
    }
    for (const [chain, labels] of chains) rows.push(['path', labels.size ? `${chain} · ${[...labels].join(', ')}` : chain])
    for (const p of list(t.running)) if (p && p.pid != null) rows.push(['process', M(`${p.pid}${p.note ? ` · ${p.note}` : ''}`)])
    for (const n of list(t.notes)) if (n != null) rows.push(['note', String(n)])
    for (const f of new Set(list(t.findings).filter((x) => x != null).map(String))) {
      const x = reasonOf(f, { harness: row.harness })
      rows.push(['finding', x.unknown ? M(f) : H(`${esc(x.why)} · ${mono(f)}`)])
    }
    if (t.routing === 'proxy') rows.push(['VPN', `if your VPN routes by process, it sees trocar as the source, not ${harnessName(row.harness)}`])
  }
  // each undo command once; one the row's commands already list is not said again
  const cmds = commandsFor(h, { row })
  const undos = new Set(list(h && h.changed).filter((e) => e && e.harness != null && harnessKey(e.harness) === row.harness && e.undo).map((e) => String(e.undo)))
  for (const u of undos) if (!cmds.some(([, c]) => c === u)) rows.push(['undo', M(u)])
  rows.push(...commandsHtml(cmds))
  const used = { harness: row.harness, verdict: { text: row.text, tier: row.tier, code: row.code, at: row.at }, conditions: row.conditions, topology: topoUsed(row.topology), last_failure: row.lastFailure }
  return detailsHtml(`cap-${row.harness}-tech`, rows) + `<div class="capcopy">${diagCopy(used)}</div>`
}

// ── trocar 在这台电脑上做的改动 (1.9 §改动块) — the changes that are no harness's; information only, no undo ────
// Auto-expands when the install left something pending or the install record cannot be read.
export function changesHtml(h) {
  const items = list(h && h.changed).filter((e) => e && e.harness == null)
  const pending = list(h && h.install && h.install.pending).filter((x) => x && typeof x === 'object')
  const manifest = list(h && h.errors).filter((e) => e && e.where === ERR_WHERE.manifest)
  if (!items.length && !pending.length && !manifest.length) return ''
  const lines = changeLines(items)
  if (pending.length) {
    lines.push(`<p>${esc(residueLead(pending.some((x) => x.result === 'install did not finish') ? 'install did not finish' : ''))}</p>`)
    for (const x of pending) lines.push(`<p>${mono(x.path || '')}${x.harness != null ? ` ${harnessIcon(x.harness)}<span class="chipname">${esc(harnessName(harnessKey(x.harness)))}</span>` : ''} <span class="fine">${esc(failureWord(null, x.result) || (has(CODE, x.result) ? CODE[x.result] : String(x.result ?? '')))}</span></p>`)
  }
  if (manifest.length) lines.push('<p>The install manifest could not be read</p>')
  const tech = manifest.length ? detailsHtml('cap-changes-tech', manifest.map((e) => ['could not be read', String(e.reason ?? '')])) : ''
  return `<section class="cblock" aria-label="Changes trocar made on this computer">` +
    disclosureHtml({ id: 'cap-changes', title: `Changes trocar made on this computer · ${items.length + pending.length}`, body: lines.join('') + tech, open: pending.length > 0 || manifest.length > 0 }) + `</section>`
}

// the whole page in one string: the table (采集服务 row + one row per agent, in row order) and the blocks under it.
// `v` is captureVerdict of the same answer; `openByReader` is the expand memory (a Map the mount owns). A capture health the server could not read
// (v.state 'unreadable') is the service row's sentence; the agent rows are drawn from the rest of the document as when `health` is absent (K-28).
// `ov` = the `overview` document of the last 24 h (its harnesses[].last_ts is the 最近采到 column), null while unread.
// `control` = api.controlStatus()'s answer (null before it), `ui` = the Map read-side id → {busy, receipt} of the row controls.
export function pageHtml(h, v, { openByReader = null, ov = null, control = null, ui = null } = {}) {
  const verdicts = agentVerdicts(h, ov)
  const ordered = rowOrder(verdicts)
  const open = openStates(ordered, openByReader)
  const rows = [serviceRowHtml(h, v, { open: open.get('*service') })]
  for (const row of ordered) rows.push(agentRowHtml(row, h, { open: open.get(row.harness), ov, control, ui }))
  return `<section class="crows" aria-label="agent">${rows.join('')}${tableFootHtml(h, verdicts)}</section>` + changesHtml(h)
}

// ── the table foot of the honest empty case (1.9 §Edge cases 表空) ───────────────────────────────────────────────
// not answered yet, or could not be read: whether any agent is set up is unknown; an unreadable install record is said by
// the changes block, so the foot does not claim the empty table on top of it
export function tableFootHtml(h, verdicts) {
  if (h == null || h.unreadable != null || verdicts.length) return ''
  if (list(h.errors).some((e) => e && e.where === ERR_WHERE.manifest)) return ''
  return '<p class="capfoot">No agent is set up for capture on this computer</p>'
}
