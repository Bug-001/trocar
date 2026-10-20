// capture/capture-view.mjs — the pure renderers of the 采集 page (1.9): the 采集服务 row, one row per detected agent, the
// expand sections, the 改动 block and the commands. Everything is a string builder over ONE C.3 `status` document (field presence
// decides, never a version). No DOM, no timers: capture.mjs owns the mounting, the poll and the expand memory.
//
// The page is READ-ONLY here (N-01): the desired state is TEXT, and the command that changes it sits in 技术细节 filled in with
// the document's own spelling (never a front-end CLI name table). No restart, no 点名, no elevated, no install button (1.9 §砍掉的).
import { esc, fmtStamp, fmtWhen, has } from '../core/fmt.mjs'
import { harnessIcon, harnessName, harnessKey } from '../core/chips.mjs'
import { mark, disclosureHtml } from '../core/ui.mjs'
import { copyBtn } from '../core/dom.mjs'
import { redactUrlCredentials } from '../core/sensitive.mjs'
import { agentVerdicts, AGENT_TIER } from '../core/capture-verdict.mjs'
import {
  CONDITION_KIND, SWITCH_WORD, TRUST_REASON, RESTART_CODES, CODE, residueLead, ROUTING, CHANGE_REMOVAL, COMMANDS,
  UNKNOWN_REASON, ERR_WHERE,
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
const leadHtml = (text, cls) => {
  if (cls !== 'bad' && cls !== 'warn') return esc(text)
  const m = /^(.*?)(?::| · )/.exec(String(text))
  const head = m ? m[1] : String(text)
  return `<span class="sw">${esc(head)}</span>${esc(String(text).slice(head.length))}`
}

// ── the commands (1.6's table) — only ever inside 技术细节 ─────────────────────────────────────────────────────────
// per harness, spelt the way the document itself spells it (`harnesses` keys); a row the document does not name gets none.
export function commandsFor(h, { row = null, service = false } = {}) {
  const out = [], cmds = COMMANDS
  const fill = (s) => row && row.cliId ? s.replace('<id>', row.cliId) : s
  if (service || (row && row.cliId)) {
    out.push(['start capturing', fill(cmds.on)], ['stop capturing', fill(cmds.off)], ['see the full status', fill(cmds.status)], ['diagnose', fill(cmds.doctor)])
  }
  if (h && h.health && h.health.state === 'not-installed') out.push(['install', cmds.install])
  if (list(h && h.critical).some((k) => k && (k.kind === 'degraded' || k.kind === 'helper-version'))) out.push(['repair the capture helper (needs sudo)', cmds.helper])
  if (h && h.linger === false) out.push(['keep capturing after logout', cmds.linger])
  return out
}

// 技术细节 for this page: a [key, value] grid where a value is a plain string (escaped) or {m} (a machine fact — id,
// path, code, command — set in mono). The disclosure's copy button carries the PLAIN text of the pairs; the diagnostics
// copy carries the fields the row used (metadata only, credentials redacted).
const techPairGrid = (pairs) => `<div class="tech">${pairs.map(([k, v]) =>
  `<span class="k">${esc(k)}</span><span class="v">${v && v.m != null ? `<span class="mono">${esc(v.m)}</span>` : v && v.h != null ? v.h : esc(v)}</span>`).join('')}</div>`
const plainOf = (v) => v && v.m != null ? v.m : v && v.h != null ? v.h.replace(/<[^>]*>/g, '') : v
const detailsHtml = (id, pairs) => disclosureHtml({
  id, title: 'Technical details', open: false,
  body: techPairGrid(pairs) + copyBtn(pairs.map(([k, v]) => `${k}: ${plainOf(v)}`).join('\n')),
})
const M = (m) => ({ m })
const H = (h) => ({ h })
const diagCopy = (obj) => copyBtn(redactUrlCredentials(JSON.stringify(obj, null, 2)), 'Copy diagnostics')
const commandsHtml = (pairs) => pairs.map(([k, v]) => [k, M(v)])

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
      const what = k.kind === 'negative-cache' ? CONDITION_KIND['negative-cache'] : `a process of no known agent does not trust trocar (${k.code || k.reason || UNKNOWN_REASON})`
      return `<p>${esc(what)} · since ${t}</p>`
    }
    if (k.kind === 'state-mismatch') return `<p>wanted ${esc(SWITCH_WORD[k.desired] || k.desired || '?')}, actually ${esc(SWITCH_WORD[k.actual] || k.actual || '?')} · since ${t}</p>`
    const word = has(CONDITION_KIND, k.kind) ? CONDITION_KIND[k.kind] : UNKNOWN_REASON
    return `<p>${esc(word)}${has(CONDITION_KIND, k.kind) ? '' : ` (${esc(k.kind)})`} · since ${t}</p>`
  }
  const daemonDown = d.running === false || d.responding === false
  const conds = daemonDown ? '' : list(h && h.critical).filter((k) => k && k.harness == null).map(condLine).join('')
  // the daemon's own state while the health is failing: 在跑 / 状态不知道
  let failingLine = ''
  if (v.state === 'failing') {
    if (d.running === true && d.responding === true) failingLine = '<p>The capture service is running</p>'
    else if (!daemonDown) failingLine = '<p>The capture service state is unknown</p>'
  }
  // the failure groups of the last 24 h → the log; zero groups draws nothing
  const groups = list(h && h.failures && h.failures.groups).length
  const failLink = groups ? `<a href="#/capture/log">${groups} failure group${groups === 1 ? '' : 's'} in the last 24 hours · capture log ›</a>` : ''
  const lingerStop = h && h.linger === false ? '<p>Capture stops at logout</p>' : ''
  return `<div class="crow" data-h="*service">` +
    `<div class="crow-t"><span class="gut">${gutOf(v.cls, v.state === 'ok')}</span>` +
    `<button type="button" class="nm cap-nm" data-caprow="cap-svc" aria-expanded="${open}" aria-controls="cap-svc-x"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>Capture service</button>` +
    '<span class="des"></span>' +
    `<span class="stt stt-${esc(v.cls)}"><p class="lead">${leadHtml(v.text, v.cls)}</p>${conds}${failingLine}</span>` +
    `<span class="last">${failLink}${lingerStop}</span></div>` +
    `<div class="cexp" id="cap-svc-x"${open ? '' : ' hidden'}>${serviceTechHtml(h, v)}</div></div>`
}

// the 采集服务 row's 技术细节: the daemon's pid / since / error, the processes holding trocar, the relayed streams, an unseen
// state as it came, the read problems, the commands, and the copy of the fields this row used (metadata only)
function serviceTechHtml(h, v) {
  const d = (h && h.daemon) || {}
  const rows = []
  if (d.pid != null) rows.push(['pid', M(d.pid)])
  if (d.since) rows.push(['since', when(d.since)])
  if (d.error) rows.push(['state could not be read', esc(d.error)])
  if (v.raw != null) rows.push(['state', M(String(v.raw))])
  if (v.reason && v.state !== 'unreadable') rows.push(['reason', esc(v.reason)])
  if (h && h.linger == null && h.daemon) rows.push(['capture after logout', 'unknown'])
  for (const p of list(h && h.holders)) if (p) rows.push(['holder', M(`${p.harness ?? '?'} · pid ${p.pid ?? '?'}${p.name ? ` · ${p.name}` : ''}`)])
  const rel = h && h.relayed
  if (rel && typeof rel === 'object') rows.push(['relayed', M(Object.entries(rel).map(([k, n]) => `${k} ${n}`).join(' · '))])
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

export function agentRowHtml(row, h, { open = false, ov = null } = {}) {
  const name = harnessName(row.harness)
  const desired = (row.desired === 'on' || row.desired === 'off') ? SWITCH_WORD[row.desired] : ''
  const last = row.lastCaptured
    ? `<a href="#/sessions?h=${esc(row.harness)}" title="${esc(fmtStamp(row.lastCaptured))}">captured ${esc(relCap(row.lastCaptured))} ›</a>`
    : ov ? 'not captured in the last 24 hours' : '' // the `overview` document's harnesses[].last_ts (1.9); unread → nothing is claimed
  const fail = row.lastFailure ? `<a href="#/capture/log?h=${esc(row.harness)}" title="${esc(fmtStamp(row.lastFailure))}">latest failure ${when(row.lastFailure)} · capture log ›</a>` : ''
  const problem = row.tier === AGENT_TIER.problem || row.tier === AGENT_TIER.forwarderDown
  return `<div class="crow" data-h="${esc(row.harness)}">` +
    `<div class="crow-t"><span class="gut">${gutOf(row.cls, row.tier === AGENT_TIER.fine)}</span>` +
    `<button type="button" class="nm cap-nm" data-caprow="cap-${esc(row.harness)}" aria-expanded="${open}" aria-controls="cap-${esc(row.harness)}-x">` +
    `<span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${harnessIcon(row.harness)}<span class="chipname">${esc(name)}</span></button>` +
    `<span class="des">${esc(desired)}</span>` +
    `<span class="stt stt-${esc(row.cls)}${row.tier === AGENT_TIER.off || row.wait ? ' dim' : ''}"><p class="lead">${leadHtml(row.text, row.cls)}</p></span>` +
    `<span class="last">${last}${fail}</span></div>` +
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
  if (problem) out.push(whyHtml(row, h))
  const ch = changesFor(row, h)
  if (ch) out.push(ch)
  out.push(agentTechHtml(row, h))
  return `<dl class="exp">${out.join('')}</dl>`
}

// 为什么 · 怎么办 — only on a problem row. The why is the sentence's own reason; the fix is the same code's fix words
// (harness-defined codes carry their own sentence with the data); a restart-kind code names the restart; the last line
// says whether the row updates by itself (a live condition) or needs a re-check (a cached verdict).
function whyHtml(row, h) {
  const name = harnessName(row.harness)
  const ps = []
  const lead = row.conditions && row.conditions.length ? row.conditions[0] : null
  const code = lead ? lead.code ?? null : row.code
  if (lead && lead.kind === 'negative-cache') {
    ps.push(`<p>${esc(CONDITION_KIND['negative-cache'])}.</p>`)
  } else if (code != null && RESTART_CODES.includes(code)) {
    ps.push(`<p>${esc(TRUST_REASON[code].why)}.</p><p>Restart ${esc(name)}; the new process is captured.</p>`)
  } else if (code != null && has(TRUST_REASON, code)) {
    ps.push(`<p>${esc(TRUST_REASON[code].why)}.</p><p>${esc(TRUST_REASON[code].fix)}.</p>`)
  } else {
    const own = lead && (lead.text || lead.reason)
    ps.push(`<p>${esc(own || (row.tier === AGENT_TIER.forwarderDown ? "trocar's forwarder is not running, so it cannot reach the network." : UNKNOWN_REASON))}.</p>`)
  }
  // a cached verdict may carry more findings, each with its own sentence
  for (const f of row.findings || []) if (typeof f === 'string' && has(TRUST_REASON, f)) ps.push(`<p>${esc(TRUST_REASON[f].why)}</p>`)
  ps.push(row.fromCache ? '<p class="fine">After fixing it, check again (the command is in the technical details).</p>' : '<p class="fine">After fixing it, this row updates itself.</p>')
  return `<dt>Why, and what to do</dt><dd>${ps.join('')}</dd>`
}

// trocar 为它改了 — the `changed[]` items of this harness (path · what) plus the removal sentence; information only, no undo
// control (`undo` sits in 技术细节). No item → the whole section is not drawn, 「没有改动」 is never said.
function changesFor(row, h) {
  const items = list(h && h.changed).filter((e) => e && e.harness != null && harnessKey(e.harness) === row.harness)
  if (!items.length) return null
  const lines = items.map((e) => `<p>${mono(e.path || '')} ${mono(e.what || '')}</p>`)
  lines.push(`<p class="fine">${esc(CHANGE_REMOVAL)}</p>`)
  return `<dt>Changed for it by trocar</dt><dd>${lines.join('')}</dd>`
}

// an agent row's 技术细节: the condition codes / pids / hosts, the routing and branches (redacted), the running processes, the
// findings, the undo commands of its changes, the commands, the copy of the fields the row used
function agentTechHtml(row, h) {
  const rows = []
  for (const k of row.conditions || []) {
    rows.push([`condition ${k.kind || '?'}`, H(`${k.code ? `<span class="mono">${esc(k.code)}</span> ` : ''}${k.pid != null ? `pid ${esc(k.pid)} ` : ''}${k.host ? `<span class="mono">${esc(redactUrlCredentials(k.host))}</span> ` : ''}since ${when(k.since)}`)])
  }
  if (row.code && !(row.conditions || []).length) rows.push(['code', M(row.code)])
  const t = row.topology
  if (t) {
    if (t.routing) rows.push(['routing', has(ROUTING, t.routing) ? ROUTING[t.routing] : t.routing])
    const name = new Map(list(t.nodes).filter((n) => n && n.id != null).map((n) => [n.id, n]))
    for (const b of list(t.branches)) {
      const nodes = list(b && b.path).map((id) => {
        const n = name.get(id)
        return n && n.name != null ? `${redactUrlCredentials(String(n.name))}${n.inferred ? ' ' + mark('inf').replace(/<[^>]*>/g, '') : ''}` : `unknown${n && n.unknown && n.unknown.reason ? ` · ${n.unknown.reason}` : ''}`
      })
      if (nodes.length) rows.push(['path', nodes.join(' → ')])
    }
    for (const p of list(t.running)) if (p && p.pid != null) rows.push(['process', M(`${p.pid}${p.note ? ` · ${p.note}` : ''}`)])
    for (const n of list(t.notes)) if (n != null) rows.push(['note', String(n)])
    for (const f of list(t.findings)) if (f != null) rows.push(['finding code', M(String(f))])
    if (t.routing === 'proxy') rows.push(['VPN', `if your VPN routes by process, it sees trocar as the source, not ${harnessName(row.harness)}`])
  }
  for (const e of list(h && h.changed)) if (e && e.harness != null && harnessKey(e.harness) === row.harness && e.undo) rows.push([`undo ${e.path || ''}`, M(e.undo)])
  rows.push(...commandsHtml(commandsFor(h, { row })))
  const used = { harness: row.harness, verdict: { text: row.text, tier: row.tier, code: row.code, at: row.at }, conditions: row.conditions, topology: row.topology, last_failure: row.lastFailure }
  return detailsHtml(`cap-${row.harness}-tech`, rows) + `<div class="capcopy">${diagCopy(used)}</div>`
}

// ── trocar 在这台电脑上做的改动 (1.9 §改动块) — the changes that are no harness's; information only, no undo ────
// Auto-expands when the install left something pending or the install record cannot be read.
export function changesHtml(h) {
  const items = list(h && h.changed).filter((e) => e && e.harness == null)
  const pending = list(h && h.install && h.install.pending).filter((x) => x && typeof x === 'object')
  const manifest = list(h && h.errors).filter((e) => e && e.where === ERR_WHERE.manifest)
  if (!items.length && !pending.length && !manifest.length) return ''
  const lines = items.map((e) => `<p>${mono(e.path || '')} ${mono(e.what || '')}</p>`)
  if (pending.length) {
    lines.push(`<p>${esc(residueLead(pending.some((x) => x.result === 'install did not finish') ? 'install did not finish' : ''))}</p>`)
    for (const x of pending) lines.push(`<p>${mono(x.path || '')}${x.harness != null ? ` ${harnessIcon(x.harness)}<span class="chipname">${esc(harnessName(harnessKey(x.harness)))}</span>` : ''} <span class="fine">${esc(has(CODE, x.result) ? CODE[x.result] : String(x.result ?? ''))}</span></p>`)
  }
  if (manifest.length) lines.push('<p>The install manifest could not be read</p>')
  const tech = manifest.length ? detailsHtml('cap-changes-tech', manifest.map((e) => ['could not be read', String(e.reason ?? '')])) : ''
  return `<section class="cblock" aria-label="Changes trocar made on this computer">` +
    disclosureHtml({ id: 'cap-changes', title: `Changes trocar made on this computer · ${items.length + pending.length}`, body: lines.join('') + tech, open: pending.length > 0 || manifest.length > 0 }) + `</section>`
}

// the whole page in one string: the table (采集服务 row + one row per agent, in row order) and the blocks under it.
// `v` is captureVerdict of the same answer; `openByReader` is the expand memory (a Map the mount owns). The 503 state
// (v.state 'unreadable') draws the service row alone — there is no data for agent rows.
// `ov` = the `overview` document of the last 24 h (its harnesses[].last_ts is the 最近采到 column), null while unread.
export function pageHtml(h, v, { openByReader = null, ov = null } = {}) {
  const verdicts = v.state === 'unreadable' ? [] : agentVerdicts(h, ov)
  const ordered = rowOrder(verdicts)
  const open = openStates(ordered, openByReader)
  const rows = [serviceRowHtml(h, v, { open: open.get('*service') })]
  for (const row of ordered) rows.push(agentRowHtml(row, h, { open: open.get(row.harness), ov }))
  return `<section class="crows" aria-label="agent">${rows.join('')}${tableFootHtml(h, verdicts)}</section>` + changesHtml(h)
}

// ── the two table-foot lines of the honest empty cases (1.9 §Edge cases) ────────────────────────────────────────
export function tableFootHtml(h, verdicts) {
  if (h == null || h.unreadable != null) return '' // not answered yet, or could not be read: whether any agent was recorded is unknown
  if (!verdicts.length) {
    return '<p class="capfoot">The capture service recorded no agent in the last 24 hours</p>'
  }
  return ''
}
