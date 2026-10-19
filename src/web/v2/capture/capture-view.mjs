// capture/capture-view.mjs — the pure renderers of the 采集 page (1.9): the 采集服务 row, one row per detected agent,
// the expand sections, the 旧采集 block, the 本机网络环境 card, the 改动 block and the per-era commands. Everything is
// a string builder over ONE /api/capture-health answer (or the honest absent state while a field is absent — field
// presence decides, never a version). No DOM, no timers: capture.mjs owns the mounting, the poll and the expand memory.
//
// The page is READ-ONLY by design (N-01): no switch is drawn anywhere, the desired state is TEXT, and the command that
// changes it sits in 技术细节 filled in with the answer's own spelling (never a front-end CLI name table). Nothing here
// draws a control the board cannot work (1.9 §砍掉的): no restart, no 点名, no elevated, no install button.
import { esc, fmtStamp, fmtWhen, has } from '../core/fmt.mjs'
import { harnessIcon, harnessName, harnessKey } from '../core/chips.mjs'
import { mark, disclosureHtml } from '../core/ui.mjs'
import { copyBtn } from '../core/dom.mjs'
import { redactUrlCredentials } from '../core/sensitive.mjs'
import { agentVerdicts, commandEra as eraOf, AGENT_TIER } from '../core/capture-verdict.mjs'
import {
  CONDITION_KIND, SWITCH_WORD, TRUST_REASON, RESTART_CODES, NOT_CAPTURED_EXPECTED, CODE, FILE_ROLE,
  residueLead, LEGACY_SOURCE, LEGACY_STATE, ROUTING, SCOPE, OPT_IN_STATE, ENTRY_STATE, CHANGE_REMOVAL, COMMANDS,
  UNKNOWN_REASON,
} from '../labels/capture.mjs'

export { commandEra } from '../core/capture-verdict.mjs'

const mono = (s) => `<span class="mono">${esc(s)}</span>` // a machine fact: id, path, code, command
const when = (t) => esc(fmtWhen(t))
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

// ── the commands of one era (1.9 §命令按哪一代) — only ever inside 技术细节 ───────────────────────────────────────
// era 1: the whole collector's switch lives on the 采集服务 row; agent rows carry no per-harness command (the bare
// on/off subcommands of this branch are the old onboarding commands). era 2: per harness, spelt the way the answer
// itself spells it; a row the answer does not name in switch.harnesses gets no per-harness command.
export function commandsFor(h, { row = null, service = false } = {}) {
  const era = eraOf(h), c = (h && h.collector) || {}, out = []
  const cmds = era === 2 ? COMMANDS.era2 : COMMANDS.era1
  const fill = (s) => row && row.cliId ? s.replace('<id>', row.cliId) : s
  if (service || era === 1) {
    out.push(['开采集', fill(cmds.on)], ['关采集', fill(cmds.off)], ['看详细状态', fill(cmds.status)])
    if (era === 2) out.push(['诊断', fill(cmds.doctor)])
  } else if (row && row.cliId) {
    out.push(['开采集', fill(cmds.on)], ['关采集', fill(cmds.off)], ['看详细状态', fill(cmds.status)], ['诊断', fill(cmds.doctor)])
  }
  if (c.installed === false) out.push(['安装', cmds.install])
  const conds = Array.isArray(c.conditions) ? c.conditions : []
  if (conds.some((k) => k && (k.kind === 'degraded' || k.kind === 'helper-version'))) out.push(['修系统组件(要 sudo)', cmds.helper])
  const linger = c.daemon && c.daemon.last_start && c.daemon.last_start.linger
  if (linger === false || linger == null) out.push(['登出后不停采', cmds.linger])
  return out
}

// 技术细节 for this page: a [key, value] grid where a value is a plain string (escaped) or {m} (a machine fact — id,
// path, code, command — set in mono). The disclosure's copy button carries the PLAIN text of the pairs; the diagnostics
// copy carries the fields the row used (metadata only, credentials redacted).
const techPairGrid = (pairs) => `<div class="tech">${pairs.map(([k, v]) =>
  `<span class="k">${esc(k)}</span><span class="v">${v && v.m != null ? `<span class="mono">${esc(v.m)}</span>` : v && v.h != null ? v.h : esc(v)}</span>`).join('')}</div>`
const plainOf = (v) => v && v.m != null ? v.m : v && v.h != null ? v.h.replace(/<[^>]*>/g, '') : v
const detailsHtml = (id, pairs) => disclosureHtml({
  id, title: '技术细节', open: false,
  body: techPairGrid(pairs) + copyBtn(pairs.map(([k, v]) => `${k}: ${plainOf(v)}`).join('\n')),
})
const M = (m) => ({ m })
const H = (h) => ({ h })
const diagCopy = (obj) => copyBtn(redactUrlCredentials(JSON.stringify(obj, null, 2)), '复制诊断信息')
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
// `v` is captureVerdict(capH) of the same answer; the status sentence IS its text (one wording for the whole board).
export function serviceRowHtml(h, v, { open = false } = {}) {
  const c = (h && h.collector) || {}, era = eraOf(h), d = c.daemon || {}
  const sw = c.switch || {}
  // the desired state: era 1 draws it here (the whole collector's switch); era 2 leaves the cell to the per-agent rows
  const desired = era === 1
    ? (sw.desired === 'on' || sw.desired === 'off' ? SWITCH_WORD[sw.desired] : `不知道:${sw.error || '读不出期望态'}`)
    : ''
  // the agent-less conditions, one sentence each with 自 T 起 (1.9 §条件的话); an untrusted / negative-cache condition
  // with no agent names a process asight cannot pin to an agent
  const condLine = (k) => {
    const t = when(k && k.since)
    if (!k) return ''
    if (k.kind === 'untrusted' || k.kind === 'negative-cache') {
      const what = k.kind === 'negative-cache' ? CONDITION_KIND['negative-cache'] : `一个认不出是哪个 agent 的进程没被信任(${k.code || k.reason || UNKNOWN_REASON})`
      return `<p>${esc(what)} · 自 ${t} 起</p>`
    }
    if (k.kind === 'state-mismatch') return `<p>期望 ${esc(SWITCH_WORD[k.desired] || k.desired || '?')},实际 ${esc(SWITCH_WORD[k.actual] || k.actual || '?')} · 自 ${t} 起</p>`
    if (k.kind === 'retention') return `<p>${CONDITION_KIND.retention} · <a href="#/settings/storage">去设置 ›</a> · 自 ${t} 起</p>`
    const word = has(CONDITION_KIND, k.kind) ? CONDITION_KIND[k.kind] : UNKNOWN_REASON
    return `<p>${esc(word)}${has(CONDITION_KIND, k.kind) ? '' : `(${esc(k.kind)})`} · 自 ${t} 起</p>`
  }
  const daemonDown = d.state === 'not-running' || d.state === 'not-responding'
  const conds = daemonDown ? '' : (Array.isArray(c.conditions) ? c.conditions : []).filter((k) => !k || k.agent == null).map(condLine).join('')
  // the daemon's own state while the summary is failing: 在跑 / 状态不知道; when only the old capture or the raw layer
  // fails and the collector is not installed, the old capture's state says it instead
  let failingLine = ''
  if (v.state === 'failing') {
    if (d.state === 'running') failingLine = '<p>采集服务在跑</p>'
    else if (d.state === 'unknown') failingLine = '<p>采集服务状态不知道</p>'
    else if (c.installed !== true && h && h.legacy && h.legacy.present) failingLine = `<p>${esc(h.legacy.summary ? h.legacy.summary.state : '')}</p>`
  }
  // the failure groups of the last 24 h across all three parts → the log; zero groups draws nothing
  const nGroups = (x) => (Array.isArray(x) ? x.length : 0)
  const groups = nGroups(c.failures) + nGroups(h && h.legacy && h.legacy.failures) + nGroups(h && h.raw && h.raw.failures)
  const failLink = groups ? `<a href="#/capture/log">最近 24 小时 ${groups} 组失败 · 采集记录 ›</a>` : ''
  const lingerStop = d.last_start && d.last_start.linger === false ? '<p>登出后会停采</p>' : ''
  const stt = v.text
  const tech = serviceTechHtml(h, v, era)
  return `<div class="crow" data-h="*service">` +
    `<div class="crow-t"><span class="gut">${gutOf(v.cls, v.state === 'ok')}</span>` +
    `<button type="button" class="nm cap-nm" data-caprow="cap-svc" aria-expanded="${open}" aria-controls="cap-svc-x"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>采集服务</button>` +
    `<span class="des">${esc(desired)}</span>` +
    `<span class="stt stt-${esc(v.cls)}"><p class="lead">${leadHtml(stt, v.cls)}</p>${conds}${failingLine}</span>` +
    `<span class="last">${failLink}${lingerStop}</span></div>` +
    `<div class="cexp" id="cap-svc-x"${open ? '' : ' hidden'}>${tech}</div></div>`
}

// the 采集服务 row's 技术细节: pid, the lock, the starts and stops, what was read and what could not be, this era's
// commands, and the copy of the fields this row used (metadata only — the endpoint never returns record bytes)
function serviceTechHtml(h, v, era) {
  const c = (h && h.collector) || {}, d = c.daemon || {}, r = (h && h.read) || {}
  const rows = []
  if (d.pid != null) rows.push(['pid', mono(d.pid)])
  if (d.lock_refreshed_at) rows.push(['锁刷新于', when(d.lock_refreshed_at)])
  if (d.verified === false) rows.push(['进程身份', '这台电脑上核对不了进程身份,只按 pid 与刷新时间判'])
  if (d.last_start && d.last_start.ts) rows.push(['上次启动', `${when(d.last_start.ts)}${d.last_start.linger === false ? ' · 登出后会停采' : d.last_start.linger == null ? ' · 登出后会不会停采:不知道' : ''}`])
  if (d.last_stop && d.last_stop.ts) rows.push(['上次停止', `${when(d.last_stop.ts)}${d.last_stop.signal ? ` · ${esc(d.last_stop.signal)}` : ''}${d.last_stop.reason ? ` · ${esc(d.last_stop.reason)}` : ''}`])
  if (d.why) rows.push(['没干净地停', esc(d.why)])
  if (d.error) rows.push(['状态读不出', esc(d.error)])
  if (v.reason && v.state !== 'unreadable') rows.push(['原因', esc(v.reason)])
  if (c.conditions_as_of) rows.push(['条件截至', `${when(c.conditions_as_of)}(采集服务没在跑)`])
  if (c.conditions_partial) rows.push(['条件', '只读了一部分:最近一次启动早于读到的部分,可能还有没列出的'])
  if (c.manifest_error) rows.push(['安装清单', c.manifest_error])
  if (Array.isArray(r.files) && r.files.length) rows.push(['读了哪些文件', M(r.files.map((f) => redactUrlCredentials(f)).join('\n'))])
  for (const e of Array.isArray(r.errors) ? r.errors : []) rows.push(['读不出', M(`${redactUrlCredentials(e.file)}: ${e.error}`)])
  if (r.truncated) rows.push(['记录', '只读了最近的一部分'])
  if (r.unparsable) rows.push(['解析不了', `${r.unparsable} 行`])
  rows.push(...commandsHtml(commandsFor(h, { service: true })))
  return detailsHtml('cap-svc-tech', rows) + `<div class="capcopy">${diagCopy({ summary: h && h.summary, daemon: d, switch: c.switch, conditions: c.conditions, read: r })}</div>`
}

// ── one agent per row (1.9 §每个 agent 一行) ───────────────────────────────────────────────────────────────────
// The union of every source that names an agent, each id folded by harnessKey — the rows come from agentVerdicts (the
// same sentences the 总览 page's items use); rowOrder() sorts them for display.
export const agentIdsOf = (h) => agentVerdicts(h).map((r) => r.harness)

// the row order (1.9 §行的次序): 可能连不上网 > 没在采、重启后生效 > 不知道 > 在采、没有发现问题 > 关着; within a
// tier the chip table's order, an id the table does not know last (agentVerdicts already yields that order — a stable
// sort by tier keeps it)
export const rowOrder = (verdicts) => [...verdicts].sort((a, b) => a.tier - b.tier)

export function agentRowHtml(row, h, { open = false } = {}) {
  const era = eraOf(h), c = (h && h.collector) || {}
  const name = harnessName(row.harness)
  const desired = era === 2 && (row.desired === 'on' || row.desired === 'off') ? SWITCH_WORD[row.desired] : ''
  const last = row.lastCaptured
    ? `<a href="#/sessions?h=${esc(row.harness)}" title="${esc(fmtStamp(row.lastCaptured))}">${esc(relCap(row.lastCaptured))} 采到 ›</a>`
    : '<span class="c3">24 小时内没采到</span>'
  const fail = row.lastFailure ? `<a href="#/capture/log?h=${esc(row.harness)}" title="${esc(fmtStamp(row.lastFailure))}">最近一次失败 ${when(row.lastFailure)} · 采集记录 ›</a>` : ''
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
  if (isNaN(d) || d < 0) return '刚刚'
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`
  return fmtWhen(ts)
}

// the expand of an agent row, at most three sections (1.9 §展开). `problem` rows get 为什么 · 怎么办; the changes section
// only while the answer carries S9 (or a prior-value note); 技术细节 is always there.
export function expandHtml(row, h, { problem = false } = {}) {
  const c = (h && h.collector) || {}, era = eraOf(h)
  const out = []
  if (problem) out.push(whyHtml(row, h))
  const ch = changesFor(row, h)
  if (ch) out.push(ch)
  out.push(agentTechHtml(row, h, era))
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
    ps.push(`<p>${esc(CONDITION_KIND['negative-cache'])}。</p>`)
  } else if (code != null && RESTART_CODES.includes(code)) {
    ps.push(`<p>${esc(TRUST_REASON[code].why)}。</p><p>重启 ${esc(name)},新启动的进程会被采集。</p>`)
  } else if (code != null && has(TRUST_REASON, code)) {
    ps.push(`<p>${esc(TRUST_REASON[code].why)}。</p><p>${esc(TRUST_REASON[code].fix)}。</p>`)
  } else {
    const own = lead && (lead.text || lead.reason)
    ps.push(`<p>${esc(own || (row.tier === AGENT_TIER.forwarderDown ? 'asight 的转发程序没在运行,它连不上网。' : UNKNOWN_REASON))}。</p>`)
  }
  // a cached verdict may carry more findings, each with its own sentence (era 2)
  for (const f of row.findings || []) {
    const t = f && (f.text || (f.code != null && has(TRUST_REASON, f.code) ? TRUST_REASON[f.code].why : null))
    if (t) ps.push(`<p>${esc(t)}</p>`)
  }
  ps.push(row.fromCache ? '<p class="fine">处理之后重新检查一次(命令见技术细节)。</p>' : '<p class="fine">处理之后,这一行会自己更新。</p>')
  return `<dt>为什么,怎么办</dt><dd>${ps.join('')}</dd>`
}

// asight 为它改了 — the S9 changes of this harness plus the era's removal sentence; information only, no undo control
// Missing S9 and no prior-value note → the whole section is not drawn, 「没有改动」 is never said.
function changesFor(row, h) {
  const c = (h && h.collector) || {}, era = eraOf(h)
  const ch = c.changes
  const entries = ch && Array.isArray(ch.entries) ? ch.entries.filter((e) => e && harnessKey(e.harness) === row.harness) : []
  const files = ch && Array.isArray(ch.files) ? ch.files.filter((f) => f && harnessKey(f.harness) === row.harness) : []
  const prior = (c.install && Array.isArray(c.install.install) ? c.install.install : [])
    .filter((n) => n && n.kind === 'prior-value' && n.harness != null && harnessKey(n.harness) === row.harness)
  if (!entries.length && !files.length && !prior.length) return null
  const lines = []
  for (const e of entries) {
    const what = Array.isArray(e.keys) ? e.keys.join('.') : e.what
    let extra = ''
    if (era === 2) {
      const bits = []
      if (e.scope && has(SCOPE, e.scope)) bits.push(SCOPE[e.scope])
      if (e.backup) bits.push(`备份在 ${e.backup}`)
      if (e.state && has(ENTRY_STATE, e.state)) bits.push(ENTRY_STATE[e.state])
      if (bits.length) extra = ` <span class="fine">${esc(bits.join(' · '))}</span>`
    }
    lines.push(`<p>${mono(e.path || '')} ${mono(what || '')}${extra}</p>`)
  }
  for (const f of files) lines.push(`<p>${esc(has(FILE_ROLE, f.role) ? FILE_ROLE[f.role] : String(f.role))} ${mono(f.path || '')}</p>`)
  for (const p of prior) lines.push(`<p>替换了你原来的值 ${mono(p.path || '')}${p.reason ? ` <span class="fine">${esc(p.reason)}</span>` : ''}</p>`)
  // the era's removal sentence: era 1's collector does not undo trust entries when capture turns off (4.6 §身份与信任)
  lines.push(`<p class="fine">${esc(era === 2 ? CHANGE_REMOVAL.era2 : CHANGE_REMOVAL.era1)}</p>`)
  // the 点名 items (era 2, only when the answer carries the field): read-only, the commands stay in 技术细节
  const opts = (h && h.opt_in && typeof h.opt_in === 'object') ? h.opt_in : null
  if (opts) {
    for (const [id, list] of Object.entries(opts)) {
      if (harnessKey(id) !== row.harness || !Array.isArray(list)) continue
      for (const o of list) {
        const st = o && has(OPT_IN_STATE, o.state) ? OPT_IN_STATE[o.state] : `不知道:${(o && o.why) || ''}`
        lines.push(`<p>点名项 ${mono(o && o.form || '')} · ${esc(st)}${o && o.implies ? ` · ${esc(o.implies)}` : ''}${o && o.admin ? ' · 要管理员' : ''}</p>`)
      }
    }
  }
  return `<dt>asight 为它改了</dt><dd>${lines.join('')}</dd>`
}

// an agent row's 技术细节: the condition codes / pids / hosts, the daemon-stopped conditions with their 截至, the era-2
// routing and branches (redacted), this era's commands, the copy of the fields the row used
function agentTechHtml(row, h, era) {
  const c = (h && h.collector) || {}
  const rows = []
  for (const k of row.conditions || []) {
    rows.push([`条件 ${k.kind || '?'}`, H(`${k.code ? `<span class="mono">${esc(k.code)}</span> ` : ''}${k.pid != null ? `pid ${esc(k.pid)} ` : ''}${k.host ? `<span class="mono">${esc(redactUrlCredentials(k.host))}</span> ` : ''}自 ${when(k.since)} 起`)])
  }
  if (row.code && !(row.conditions || []).length) rows.push(['码', M(row.code)])
  if (c.daemon && c.daemon.state !== 'running' && (row.conditions || []).length && c.conditions_as_of) rows.push(['条件截至', `${when(c.conditions_as_of)}(采集服务没在跑)`])
  const t = row.topology
  if (t) {
    if (t.routing) rows.push(['引流方式', has(ROUTING, t.routing) ? ROUTING[t.routing] : t.routing])
    for (const b of Array.isArray(t.branches) ? t.branches : []) {
      const nodes = (Array.isArray(b && b.path) ? b.path : []).map((n) => n && n.name != null
        ? `${redactUrlCredentials(String(n.name))}${n.inferred ? ' ' + mark('inf').replace(/<[^>]*>/g, '') : ''}${n.error ? ` · 不知道:${n.error}` : ''}`
        : '不知道')
      if (nodes.length) rows.push(['路', nodes.join(' → ')])
    }
    for (const p of Array.isArray(t.running) ? t.running : []) if (p && p.pid != null) rows.push(['进程', { m: `${p.pid}${p.note ? ` · ${p.note}` : ''}` }])
    for (const n of Array.isArray(t.notes) ? t.notes : []) if (n != null) rows.push(['提示', String(n)])
    for (const f of Array.isArray(t.findings) ? t.findings : []) if (f && f.code != null) rows.push(['判词码', M(f.code)])
    if (t.routing === 'proxy' && h.netenv && Array.isArray(h.netenv.products) && h.netenv.products.length) {
      rows.push(['VPN', `你的 VPN 按进程分流时,看到的来源是 asight,不是 ${harnessName(row.harness)}`])
    }
    if (t.via != null) rows.push(['via', M(redactUrlCredentials(String(t.via)))])
  }
  rows.push(...commandsHtml(commandsFor(h, { row })))
  const used = { harness: row.harness, verdict: { text: row.text, tier: row.tier, code: row.code, at: row.at }, conditions: row.conditions, topology: row.topology, last_captured: row.lastCaptured, last_failure: row.lastFailure }
  return detailsHtml(`cap-${row.harness}-tech`, rows) + `<div class="capcopy">${diagCopy(used)}</div>`
}

// ── the 旧采集 block (1.9 §旧采集) — its records carry no harness, so it is no agent's row ───────────────────────
export function legacyHtml(h) {
  const l = h && h.legacy
  if (!l || !l.present) return ''
  const rows = []
  for (const s of Array.isArray(l.sources) ? l.sources : []) {
    const name = has(LEGACY_SOURCE, s.source) ? LEGACY_SOURCE[s.source] : `旧采集 · ${s.source}`
    const st = has(LEGACY_STATE, s.state) ? LEGACY_STATE[s.state] : String(s.state)
    const start = s.last_start && s.last_start.ts ? `最后启动 ${when(s.last_start.ts)}` : ''
    const stop = s.last_stop && s.last_stop.ts ? ` · 最后停止 ${when(s.last_stop.ts)}${s.last_stop.signal ? `(${esc(s.last_stop.signal)})` : ''}` : ''
    rows.push(`<p><b>${esc(name)}</b> · ${esc(st)}${start ? ` · ${start}` : ''}${stop}</p>`)
  }
  if (!rows.length) {
    if (l.state === 'no-events') rows.push(`<p>旧采集 · 没有事件记录(重启后才有)${l.capture ? ` · 采集文件最后写入于 ${when(l.capture.mtime)}` : ''}</p>`)
    else if (l.state === 'unknown') rows.push(`<p>旧采集 · 不知道:${esc(l.error || (l.summary && l.summary.reason) || '')}</p>`)
  }
  if (l.last_record_at) rows.push(`<p class="fine">最后记录 ${when(l.last_record_at)}</p>`)
  const tech = []
  for (const s of Array.isArray(l.sources) ? l.sources : []) {
    if (s && s.last_start && s.last_start.pid != null) tech.push([`pid(${s.source || '旧采集'})`, M(s.last_start.pid)])
    if (s && s.last_stop && s.last_stop.reason) tech.push(['停止原因', s.last_stop.reason])
  }
  if (l.capture && l.capture.file) tech.push(['采集文件', M(l.capture.file)])
  return `<section class="cblock" aria-label="旧采集"><h2 class="sec-h">旧采集</h2>${rows.join('')}` +
    (tech.length ? detailsHtml('cap-legacy-tech', tech) : '') + `</section>`
}

// ── the 本机网络环境 card (1.9 §本机网络环境) — only when the answer carries the field; asight only reads it ─────
// Never 「无」: an unreadable product says 读不到, an unknown fact says 不知道 with its reason (1.6 §5 R11).
export function netenvHtml(h) {
  const n = h && h.netenv
  if (n == null) return '' // the field is absent: no card (field presence, never a version)
  const at = n.at ? ` · 截至 ${when(n.at)}` : ''
  const rows = []
  if (n.present === false) {
    rows.push(`<p>还没有探测结果</p>`)
    return `<section class="cblock" aria-label="本机网络环境"><h2 class="sec-h">本机网络环境</h2>${rows.join('')}` +
      detailsHtml('cap-netenv-tech', [['原因', n.reason || ''], ['看详细状态', M('asight status')]]) + `</section>`
  }
  if (n.error) rows.push(`<p>读不到探测结果:${esc(n.error)}</p>`)
  const topo = n.topology && typeof n.topology === 'object' ? n.topology : {}
  for (const p of Array.isArray(n.products) ? n.products : []) {
    if (!p) continue
    if (p.reason) { rows.push(`<p>读不到 ${esc(p.product || '一个产品')} 的状态(${esc(p.reason)})</p>`); continue }
    const tun = p.tun === true ? '开' : p.tun === false ? '关' : '不知道'
    const who = Object.entries(topo)
      .filter(([, t]) => t && Array.isArray(t.nodes) && t.nodes.some((x) => x && x.kind === 'proxy' && x.product === p.product))
      .map(([id]) => `${harnessIcon(id)}<span class="chipname">${esc(harnessName(harnessKey(id)))}</span>`)
    rows.push(`<p><b>${esc(p.product || '')}${p.version ? ` ${esc(String(p.version))}` : ''}</b> · ${esc(p.mode || '')} · TUN ${tun}` +
      `${p.system_proxy ? ` · 系统代理 ${mono(redactUrlCredentials(String(p.system_proxy)))}` : ''}${at}` +
      `${who.length ? `<br>经过它的:${who.join(' ')}` : ''}</p>`)
  }
  const unknown = Array.isArray(n.unknown) ? n.unknown : []
  if (!rows.length && unknown.length) for (const u of unknown) rows.push(`<p>不知道:${esc((u && u.reason) || '')}</p>`)
  if (!rows.length) rows.push('<p>没有探测到 asight 认得的代理或 VPN 软件</p>')
  const tech = []
  if (n.mixed_port != null) tech.push(['mixed_port', M(n.mixed_port)])
  if (n.live != null) tech.push(['live', String(n.live)])
  for (const [id, t] of Object.entries(topo)) {
    if (t && t.via != null) tech.push([`via(${id})`, M(redactUrlCredentials(String(t.via)))])
  }
  return `<section class="cblock" aria-label="本机网络环境"><h2 class="sec-h">本机网络环境</h2>${rows.join('')}` +
    (tech.length ? detailsHtml('cap-netenv-tech', tech) : '') + `</section>`
}

// ── asight 在这台电脑上做的改动 (1.9 §改动块) — the changes that are no harness's; information only, no undo ────
// Auto-expands when there is residue, when the manifest cannot be read, or (era 2) when an entry is not intact.
export function changesHtml(h) {
  const c = (h && h.collector) || {}, era = eraOf(h)
  const ch = c.changes
  const files = ch && Array.isArray(ch.files) ? ch.files.filter((f) => f && f.harness == null) : []
  const entries = ch && Array.isArray(ch.entries) ? ch.entries.filter((e) => e && e.harness == null) : []
  const residue = Array.isArray(c.residue) ? c.residue : []
  const manifestError = c.manifest_error || null
  if (!files.length && !entries.length && !residue.length && !manifestError) return ''
  const n = files.length + entries.length + residue.length
  const intact = era === 2 && ch && [...(ch.files || []), ...(ch.entries || [])].every((x) => !x || x.state == null || x.state === 'intact')
  const stateBit = (x) => (era === 2 && x && x.state && has(ENTRY_STATE, x.state) ? ` <span class="fine">${ENTRY_STATE[x.state]}</span>` : '')
  const lines = []
  for (const f of files) lines.push(`<p>${esc(has(FILE_ROLE, f.role) ? FILE_ROLE[f.role] : String(f.role))} ${mono(f.path || '')}${stateBit(f)}</p>`)
  for (const e of entries) lines.push(`<p>${mono(e.path || '')} ${mono(Array.isArray(e.keys) ? e.keys.join('.') : e.what || '')}${stateBit(e)}</p>`)
  if (residue.length) {
    const lead = residue.some((x) => x && x.result === 'install did not finish') ? residueLead('install did not finish') : residueLead('')
    const items = residue.map((x) => `<p>${mono(x.path || '')}${x && x.harness != null ? ` ${harnessIcon(x.harness)}<span class="chipname">${esc(harnessName(harnessKey(x.harness)))}</span>` : ''} <span class="fine">${esc(has(CODE, x.result) ? CODE[x.result] : String(x.result))}</span></p>`)
    lines.push(`<p>${esc(lead)}</p>`, ...items)
  }
  if (manifestError) lines.push('<p>安装清单读不出</p>')
  lines.push(`<p class="fine">${esc(era === 2 ? CHANGE_REMOVAL.era2 : CHANGE_REMOVAL.era1)}</p>`)
  const open = residue.length > 0 || !!manifestError || (era === 2 && !intact)
  const tech = manifestError ? detailsHtml('cap-changes-tech', [['读不出', manifestError]]) : ''
  return `<section class="cblock" aria-label="asight 在这台电脑上做的改动">` +
    disclosureHtml({ id: 'cap-changes', title: `asight 在这台电脑上做的改动 · ${n} 项${intact ? ' · 都完好' : ''}`, body: lines.join('') + tech, open }) + `</section>`
}

// the whole page in one string: the table (采集服务 row + one row per agent, in row order) and the blocks under it.
// `v` is captureVerdict of the same answer; `openByReader` is the expand memory (a Map the mount owns). The 503 state
// (v.state 'unreadable') draws the service row alone — there is no data for agent rows.
export function pageHtml(h, v, { openByReader = null } = {}) {
  const verdicts = v.state === 'unreadable' ? [] : agentVerdicts(h)
  const ordered = rowOrder(verdicts)
  const open = openStates(ordered, openByReader)
  const rows = [serviceRowHtml(h, v, { open: open.get('*service') })]
  for (const row of ordered) rows.push(agentRowHtml(row, h, { open: open.get(row.harness) }))
  return `<section class="crows" aria-label="agent">${rows.join('')}${tableFootHtml(h, verdicts)}</section>` +
    legacyHtml(h) + netenvHtml(h) + changesHtml(h)
}

// ── the two table-foot lines of the honest empty cases (1.9 §Edge cases) ────────────────────────────────────────
export function tableFootHtml(h, verdicts) {
  const c = (h && h.collector) || {}
  if (h && h.unreadable != null) return '' // the health could not be read: whether any agent was recorded is unknown
  if (!verdicts.length) {
    if (h && h.legacy && h.legacy.present && c.present === false) return '<p class="capfoot">这台电脑上只有旧采集,它的记录分不出是哪个 agent</p>'
    return '<p class="capfoot">最近 24 小时采集服务没有记下任何 agent</p>'
  }
  return ''
}
