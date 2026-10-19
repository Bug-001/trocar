// library/logic.mjs — the session library's pure logic (1.8): no DOM, no window. Filters live in the URL hash, so
// the same parse / write pair serves the tool row, the router and the tests; the row view model says what a row
// shows and in which words. Agent names and icons come from core/chips.mjs only (invariant 3); a field the server
// does not carry is detected by key presence and the element stays out — never a guess, never 0 (invariant 4).
import { esc, relTime, fmtStamp } from '../core/fmt.mjs'
import { HARNESS_ORDER, harnessKey, harnessName, harnessIcon, harnessRaw } from '../core/chips.mjs'
import { formatHash } from '../core/router.mjs'
import { captureVerdict } from '../core/capture-verdict.mjs'
import * as W from '../labels/library.mjs'

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// ── filters ← → hash params (1.2 §路由: q · h repeatable · project · window · sort · sel) ───────────────────────────
export const WINDOWS = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, all: Infinity }
export function parseFilters(params = {}) {
  const p = params || {}
  return {
    q: p.q || '',
    // the route's ids go through harnessKey(), so a 1.6 cli id and the read-side id are one agent (1.8 §搜索; the alias
    // spellings themselves live only in core/chips.mjs)
    h: p.h ? String(p.h).split(',').map((x) => harnessKey(x)).filter(Boolean) : [],
    project: p.project || '',
    window: has(WINDOWS, p.window) ? p.window : 'all', // junk → the default
    sort: p.sort === 'calls' ? 'calls' : 'recent',      // 「最近」 is the default; `calls` is the only other value (the prototype's sort=steps alias is gone)
    sel: p.sel || '',
  }
}
// only what differs from the defaults is written, so a fresh library has a clean URL
export function filtersToParams(f) {
  const out = {}
  if (f.q) out.q = f.q
  if (f.h.length) out.h = f.h.join(',')
  if (f.project) out.project = f.project
  if (f.window !== 'all') out.window = f.window
  if (f.sort === 'calls') out.sort = 'calls'
  if (f.sel) out.sel = f.sel
  return out
}
export const hasFilters = (f) => !!(f.q.trim() || f.h.length || f.project || f.window !== 'all')

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// the harness id an agent-menu item stands for, read-side (the 1.6 cli's alias folds into it — 1.8 Edge
// cases: one menu item, both spellings filter to it); '-' = a session whose harness is not identified (h=- filters them alone)
export const facetId = (s) => (s.harness == null || s.harness === '') ? '-' : harnessKey(s.harness)
export const sessionKey = (s) => `${s.project_slug}::${s.session_id}`
// the unresolved bucket is not a project: its rows show no project, its name is not searched, it has no menu item
export function flattenSessions(data) {
  return ((data && data.projects) || []).flatMap((p) => p.sessions.map((s) => ({ ...s, project_name: p.slug === '_unresolved' ? '' : p.name, project_dir: p.slug === '_unresolved' ? '' : (p.path || '') })))
}
const lastMs = (s) => { const t = Date.parse(s.last_ts); return Number.isNaN(t) ? null : t }

// ── the title rule (1.8 §标题规则): agent 标题 → 第一条提问(「」包住, ≤80 字) → 未命名会话 ─────────────────────────
// Key presence decides each step: no `first_prompt` key at all is the S1-before state, a null one says "computed, none
// found". The hover word and the 「推测」 mark follow from { from, basis, hasKey }.
export function titleOf(s) {
  if (s.title) return { from: 'title', text: String(s.title), basis: null, hasKey: false }
  if (has(s, 'first_prompt')) {
    if (s.first_prompt != null) return { from: 'prompt', text: W.promptTitle(s.first_prompt), basis: s.first_prompt_basis ?? null, hasKey: true }
    return { from: 'none', text: W.UNTITLED, basis: null, hasKey: true }
  }
  return { from: 'none', text: W.UNTITLED, basis: null, hasKey: false }
}
export function titleTipOf(s, t) {
  const id = s.session_id
  if (t.from === 'title') return W.titleFromAgent(id)
  if (t.from === 'prompt') return W.titleFromPrompt(id) + (t.basis === 'guess' ? ` · ${W.TITLE_GUESS_MORE}` : '')
  return t.hasKey ? W.titleNoPrompt(id) : W.titleNoKey(id)
}

function matches(s, f, now, titleText) {
  const q = f.q.trim().toLowerCase()
  if (q && ![titleText, s.first_prompt, s.project_name, s.session_id].some((x) => x != null && String(x).toLowerCase().includes(q))) return false
  if (f.project && s.project_slug !== f.project) return false
  if (f.window !== 'all') { const t = lastMs(s); if (t == null || now - t > WINDOWS[f.window]) return false } // no time → only in 全部; boundary inclusive
  return true
}
const byTimeDesc = (a, b) => { const x = lastMs(a), y = lastMs(b); return x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : y - x }
export function applyFilters(list, f, now) {
  const out = []
  for (const s of list) {
    // the agent filter matches the session's own harness, or — S14 present — any of its harnesses
    if (f.h.length && !f.h.includes(facetId(s)) && !(Array.isArray(s.harnesses) && s.harnesses.some((x) => f.h.includes(harnessKey(x))))) continue
    if (!matches(s, f, now, titleOf(s).text)) continue
    out.push(s)
  }
  return out.sort(f.sort === 'calls' ? (a, b) => (b.calls || 0) - (a.calls || 0) || byTimeDesc(a, b) : byTimeDesc)
}

// group names, only in the 最近 order: local dates; no-time rows sort last and land in their own group
export function groupOf(s, now) {
  const t = lastMs(s)
  if (t == null) return 'none'
  const n = new Date(now)
  const d0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  return t >= d0 ? 'today' : t >= d0 - 86400e3 ? 'yesterday' : 'earlier'
}

// ── the agent menu: 图标 + 名字, multi-select, NO counts (1.2 §页头: no numbers in the head zone) ────────────────────
// order: the chip table's, then ids the table does not know (each 「未识别的 agent」 + the raw id), then the unidentified one
export function agentMenuModel(list, f) {
  const present = new Set(list.map(facetId))
  const ids = [...HARNESS_ORDER.filter((h) => present.has(h)), ...[...present].filter((h) => !HARNESS_ORDER.includes(h) && h !== '-'), ...(present.has('-') ? ['-'] : [])]
  return ids.map((id) => ({ id, on: f.h.includes(id) }))
}
// the layer's items are re-rendered when this changes — a poll that moves nothing does not touch an open menu
export const agentMenuSignature = (m) => JSON.stringify(m.map((c) => [c.id, c.on]))

// ── the project menu: real projects only (the unresolved bucket is not a project); hover carries the path ────────────
export function projectOptions(projects, selected) {
  const ps = (projects || []).filter((p) => p.slug !== '_unresolved')
  const item = (slug, name, title, on) => `<button type="button" role="menuitem" data-project="${esc(slug)}"${title ? ` title="${esc(title)}"` : ''}${on ? ' class="on"' : ''}>${esc(name)}</button>`
  let html = item('', W.ALL_PROJECTS, '', !selected)
  for (const p of ps) html += item(p.slug, p.name, p.path || '', selected === p.slug)
  if (selected && !ps.some((p) => p.slug === selected)) html += item(selected, W.noSuchProject(selected), '', true) // the choice stays visible
  return { html, sig: html }
}

// ── the caption row and its 技术细节: what changes trust stays visible; bookkeeping rides below ─────────────────────
// facts: 没读全 (errors[] by file + skipped[] with attention, N = the deduped sum — the link goes to 存储) · 坏行 · 没有 id.
// tech rows: per unreadable file its own line (basename · reason · kind · unreadableRecords), then 未计数 · 半行 · 重读 · 其余没读.
export function captionFacts(source) {
  const h = source || {}
  const byFile = new Map()
  for (const e of h.errors || []) if (e && e.file && !byFile.has(e.file)) byFile.set(e.file, e)
  const attention = (h.skipped || []).filter((x) => x && x.attention)
  const notAll = byFile.size + attention.length
  const corrupt = h.corrupt_lines == null ? 0 : Object.values(h.corrupt_lines).reduce((a, c) => a + c, 0)
  const unid = h.unidentified_lines || 0
  const facts = []
  if (notAll) facts.push({ kind: 'not-all', n: notAll })
  if (corrupt) facts.push({ kind: 'corrupt', n: corrupt })
  if (unid) facts.push({ kind: 'no-id', n: unid })
  const tail = (f) => String(f).split('/').pop()
  const tech = []
  for (const e of byFile.values()) tech.push(`${tail(e.file)} · ${e.reason || ''}${e.kind ? ` · ${e.kind}` : ''}${e.unreadableRecords != null ? ` · ${e.unreadableRecords} records unreadable` : ''}`)
  if (h.corrupt_lines == null) tech.push(W.TECH_UNCOUNTED)
  const pending = Object.keys(h.tail_pending || {})
  if (pending.length) tech.push(W.techTail(pending.map(tail)))
  if (h.resets && h.resets.length) tech.push(W.techResets(h.resets.map(tail)))
  const rest = (h.skipped || []).filter((x) => x && !x.attention)
  if (rest.length) tech.push(W.techSkipped(rest.map((x) => tail(x.name))))
  return { facts, tech }
}

// ── what the read failed with: a dead server is not an HTTP error ────────────────────────────────────────────────────
export function readFailWording(r) {
  if (r && r.status === 0) return { line: W.CAP_CONN_FAIL, code: null }
  const code = r && r.status != null ? r.status : null
  return { line: W.capReadFail(code != null ? code : 'unknown reason'), code }
}

// ── the row ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function rowModel(s, now) {
  const title = titleOf(s)
  const multi = Array.isArray(s.harnesses) && s.harnesses.length > 1 // S14: field presence — before it, never drawn
  const probeOnly = !s.calls && s.probes > 0
  const entry = has(W.ENTRY, s.entrypoint) ? W.ENTRY[s.entrypoint] : (s.entrypoint ? String(s.entrypoint) : '')
  const inferred = !!s.harness_inferred
  return {
    key: sessionKey(s),
    href: formatHash({ area: 'replay', screen: 'replay', project: s.project_slug, id: s.session_id, params: {} }),
    harnessId: s.harness, harnessName: harnessName(s.harness), harnessIcon: harnessIcon(s.harness), harnessRaw: harnessRaw(s.harness),
    title, titleTip: titleTipOf(s, title), titleGuess: title.from === 'prompt' && title.basis === 'guess',
    dim: probeOnly, calls: s.calls || 0, probes: s.probes || 0,
    logged: s.logged || 0, subagent: s.has_subagent === true, inferred, synthesized: !!s.session_synthesized,
    multi, multiNames: multi ? [...new Set(s.harnesses.map((x) => harnessName(harnessKey(x))))] : null,
    entry, project: s.project_slug === '_unresolved' ? null : { name: s.project_name || s.project_dir || s.project_slug, path: s.project_path || s.project_dir || '' },
    when: relTime(s.last_ts, now), whenTip: s.last_ts ? fmtStamp(s.last_ts) : '',
  }
}

// ── repaint policy ───────────────────────────────────────────────────────────────────────────────────────────────────
// the poll repaints only when this changes: every field a row shows — including S1 / S14's (first_prompt, basis,
// harnesses, logged) — plus what the project menu shows. Checked against the rendered row in the tests, so a field
// added to the row later cannot be left out here.
const ROW_FIELDS = ['project_slug', 'session_id', 'title', 'first_prompt', 'first_prompt_basis', 'harnesses', 'logged', 'harness', 'harness_inferred', 'session_synthesized', 'entrypoint', 'project_name', 'project_dir', 'project_path', 'calls', 'probes', 'has_subagent', 'last_ts']
export function listSignature(data, error) {
  const ss = flattenSessions(data).map((s) => ROW_FIELDS.map((k) => s[k]).join('|')).join(';')
  const ps = ((data && data.projects) || []).map((p) => [p.slug, p.name, p.path, p.sessions.length].join('|')).join(';')
  return `${error || ''}#${ss}#${ps}#${JSON.stringify((data && data.source) || null)}`
}
// the list's scroll policy: what a new paint does. prevSig = the previous paint's filterSignature (null = a new list);
// the decision follows the highlighted session's KEY, not its index — a poll that re-sorts the rows above the highlight
// must not pull a list the reader has scrolled away.
//   top    — a filter changed after the first paint: the new result starts at the top
//   index  — bring row `index` into view: the first paint after mount, or a key press that moved the highlight
//   keep   — a repaint that moved no selection: leave the scroll where the reader put it
export const filterSignature = (f) => JSON.stringify([f.q, f.h, f.project, f.window, f.sort])
export function scrollDecision({ prevSig, sig, selKey, selIndex, prevSelKey }) {
  const has = selKey != null && selIndex >= 0
  if (prevSig === null) return has ? { kind: 'index', index: selIndex } : { kind: 'top' }
  if (sig !== prevSig) return { kind: 'top' }
  return has && selKey !== prevSelKey ? { kind: 'index', index: selIndex } : { kind: 'keep' }
}
export const selectedKey = (rows, sel) => (!rows.length ? null : rows.some((s) => sessionKey(s) === sel) ? sel : sessionKey(rows[0]))

// wherever a chosen agent stands as a name (the active chips, the not-captured line), an id the chip table does
// not know rides along verbatim after 「未识别的 agent」 (1.8 Edge cases: 路由带来未知的 agent id — 照样筛,那一行跟着那个 id)
export const agentLabel = (id) => {
  const n = harnessName(id === '-' || id == null ? null : id)
  const raw = id === '-' || id == null ? null : harnessRaw(id)
  return raw ? `${n} ${raw}` : n
}

// ── the agent-not-captured check (1.8 空态, [待 #45] fields — read by key presence, never by version) ────────────────
// A picked agent is not being captured when the operator's switch says off for it, the cached 判词 says not captured,
// or a live condition names it. Anything absent is unknown, not "off".
export function agentNotCaptured(health, id) {
  const k = harnessKey(id)
  const sw = health && health.collector && health.collector.switch && health.collector.switch.harnesses
  if (sw && sw[k] && sw[k].desired === 'off') return true
  const topo = health && health.netenv && health.netenv.topology
  if (topo && topo[k] && topo[k].captured === false) return true
  const conds = health && health.collector && Array.isArray(health.collector.conditions) ? health.collector.conditions : []
  if (conds.some((c) => c && harnessKey(c.agent) === k)) return true
  return false
}

// ── the one-shot capture-health read (1.8 数据与刷新: the 空态 and the filtered agent read it ONCE, no polling) ────────
// The first caller fires the read, every caller while it is in flight shares it, and once it has an answer it is
// never read again for the life of the screen. `read()` → a promise of the settled shot; `settled` is null until then.
export function capShotMaker(fetchHealth, now = Date.now) {
  let p = null, done = null
  const read = () => {
    if (!p) p = (async () => {
      let r
      try { r = await fetchHealth() } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
      done = (r && r.ok && r.data) ? { h: r.data, asOf: now() } : { fail: (r && (r.error || (r.status != null ? 'HTTP ' + r.status : null))) || 'unknown reason' }
      return done
    })()
    return p
  }
  return { read, get settled() { return done } }
}

// ── the states that stand in for the table (1.8 空、载入、读不出) ─────────────────────────────────────────────────────
// the whole capture service being down replaces an agent-specific sentence (the 空态表's last row); a state that
// only says "not perfect right now" (failing · unknown) does not — the agent's own line is still the useful one.
export const SERVICE_DOWN = new Set(['not-running', 'not-responding', 'not-installed', 'off'])
// the 空态's second line: the capture service's own sentence for its state — 采集在进行 says the inviting hint
// instead — plus the time that answer was read (「截至」). A shot that never arrived says nothing yet.
export function emptyBoardState(shot, now) {
  if (!shot) return { line: '' }
  if (shot.fail) return { line: W.readCapFail(shot.fail), asOf: null }
  const v = captureVerdict(shot.h, { okAt: shot.asOf, now })
  return { line: v.state === 'ok' ? W.CAPTURING_HINT : v.text, asOf: shot.asOf, verdict: v }
}
// the filtered agent's line, when exactly one agent was picked and nothing matched (1.8 空态表): is it even being
// captured? → null (nothing to add) | {service:true,…} (the whole service's sentence) | {line, href} (this agent's)
export function filteredAgentLine(shot, id, now) {
  if (!shot || shot.fail) return null
  const v = captureVerdict(shot.h, { okAt: shot.asOf, now })
  if (SERVICE_DOWN.has(v.state)) return { service: true, line: v.text, asOf: shot.asOf }
  if (agentNotCaptured(shot.h, id)) return { line: W.agentNotCaptured(agentLabel(id)), href: formatHash({ area: 'capture', screen: 'capture', params: { h: id } }) }
  return null
}
