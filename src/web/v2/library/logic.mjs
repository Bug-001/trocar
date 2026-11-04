// library/logic.mjs — the session library's pure logic (1.8): no DOM, no window. Filters live in the URL hash, so
// the same parse / write pair serves the tool row, the router and the tests; the row view model says what a row
// shows and in which words. Agent names and icons come from core/chips.mjs only (invariant 3); a field the server
// does not carry is detected by key presence and the element stays out — never a guess, never 0 (invariant 4).
import { esc, relTime, fmtStamp } from '../core/fmt.mjs'
import { HARNESS_ORDER, harnessKey, harnessName, harnessIcon, harnessRaw } from '../core/chips.mjs'
import { formatHash } from '../core/router.mjs'
import { captureVerdict, capHealthPatch } from '../core/capture-verdict.mjs'
import { readFailure, techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/library.mjs'
import { INTERVAL } from '../core/poll.mjs'

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
// the unresolved bucket is not a project: its rows show no project, its name is not searched, it has no menu item.
// The project name is the last segment of project_path, else the slug (1.8 §一行): grouping is the board's, not the server's.
const UNRESOLVED = '_unresolved'
const projectName = (s) => (s.project_path ? String(s.project_path).split('/').filter(Boolean).pop() : '') || s.project_slug || ''
export function flattenSessions(data) {
  return ((data && data.sessions) || []).map((s) => ({ ...s, project_name: s.project_slug === UNRESOLVED ? '' : projectName(s), project_dir: s.project_slug === UNRESOLVED ? '' : (s.project_path || '') }))
}
// every page of `sessions` (C.5: paged, `next` → `after` until null). → {ok:true, data:{sessions, errors, as_of, stored}} or the
// first failed read as it came. The pages are one list, so a session is never missing because it sat past page one. A page
// may be the daemon's stored answer (4.4 §存下的答案): the list is stored when any page is, as of the oldest `stored.at`; pages
// answered at two moments may overlap at their boundary, so a session is kept once, as first seen (1.8 §数据与刷新).
export async function loadSessions(api, { limit = 500 } = {}) {
  const sessions = [], errors = [], seen = new Set()
  let after = null, as_of = null, stored = null
  for (;;) {
    const r = await api.get('sessions', { limit, after })
    if (!r || !r.ok) return r || { ok: false, error: 'no answer' }
    const d = r.data || {}
    for (const s of d.sessions || []) { const k = sessionKey(s); if (!seen.has(k)) { seen.add(k); sessions.push(s) } }
    errors.push(...(d.errors || [])); as_of = as_of || d.as_of || null
    const at = d.stored && d.stored.at
    if (at && (stored == null || Date.parse(at) < Date.parse(stored))) stored = at
    if (d.next == null || d.next === after) return { ok: true, data: { sessions, errors, as_of, stored } }
    after = d.next
  }
}
/** freshSessions(api, {alive}) → a `sessions` answer without `stored`: loadSessions, read again INTERVAL.session after every answer that
 *  carries `stored` (the worker's last, older list, 4.4 §存下的答案) while `alive()`. For a screen that draws a conclusion from the
 *  list (the traffic page's coverage note, the overview, #/session/<id>); the Sessions page shows the stored list itself (1.8). */
export async function freshSessions(api, { alive = () => true } = {}) {
  let r = await loadSessions(api)
  while (r && r.ok && r.data.stored && alive()) {
    await new Promise((d) => setTimeout(d, INTERVAL.session))
    if (!alive()) break
    r = await loadSessions(api)
  }
  return r
}
const lastMs = (s) => { const t = Date.parse(s.last_ts); return Number.isNaN(t) ? null : t }

// ── the title rule (1.8 §标题规则): `title` as it is, else 标题还没读到 while it is pending, else 未命名会话; where it came from is `title_source`
const pendingTitle = (s) => s.title == null && s.title_source === 'pending'
export const titleText = (s) => (s.title != null ? String(s.title) : pendingTitle(s) ? W.TITLE_PENDING : W.UNTITLED)
export function titleTipOf(s) {
  const id = s.session_id
  if (pendingTitle(s)) return W.titlePending(id)
  if (s.title == null) return W.titleNoKey(id)
  return W.titleFromWire(id) // a title always comes from the wire (4.4 §人类标题的来源)
}

function matches(s, f, now, title) {
  const q = f.q.trim().toLowerCase()
  if (q && ![title, s.project_name, s.session_id].some((x) => x != null && String(x).toLowerCase().includes(q))) return false
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
    if (!matches(s, f, now, s.title)) continue
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
// the list's entries: rows, with a group name before each new group only in the 最近 order ({g} | {s})
export function listEntries(rows, sort, now) {
  const out = []
  let last = null
  for (const s of rows) {
    if (sort === 'recent') { const g = groupOf(s, now); if (g !== last) { out.push({ g }); last = g } }
    out.push({ s })
  }
  return out
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
// the projects are grouped here, from each row's project_slug / project_path (C.5 `sessions` is flat)
function projectsOf(list) {
  const by = new Map()
  for (const s of list || []) if (s.project_slug && s.project_slug !== UNRESOLVED && !by.has(s.project_slug)) by.set(s.project_slug, { slug: s.project_slug, name: projectName(s), path: s.project_path || '' })
  return [...by.values()]
}
export function projectOptions(list, selected) {
  const ps = projectsOf(list)
  const item = (slug, name, title, on) => `<button type="button" role="menuitem" data-project="${esc(slug)}"${title ? ` title="${esc(title)}"` : ''}${on ? ' class="on"' : ''}>${esc(name)}</button>`
  let html = item('', W.ALL_PROJECTS, '', !selected)
  for (const p of ps) html += item(p.slug, p.name, p.path || '', selected === p.slug)
  if (selected && !ps.some((p) => p.slug === selected)) html += item(selected, W.noSuchProject(selected), '', true) // the choice stays visible
  return { html, sig: html }
}

// ── the caption row and its 技术细节: the document's errors[] (1.8 §说明行: N = the entries whose level is not note — a
// note only says a read was slow; every entry, notes too, is listed in 技术细节 as where · reason) and its `stored` (the list
// is the stored answer while a fresh one is being made: 「更新于 … · 正在刷新」) ──
export function captionFacts(errors, stored = null) {
  const es = (errors || []).filter(Boolean), n = es.filter((e) => e.level !== 'note').length
  const facts = [...(n ? [{ kind: 'not-all', n }] : []), ...(stored ? [{ kind: 'stored', at: stored }] : [])]
  return { facts, tech: es.map((e) => `${e.where ?? ''} · ${e.reason ?? ''}`) }
}

// ── the row ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function rowModel(s, now) {
  const multi = Array.isArray(s.harnesses) && s.harnesses.length > 1 // S14: field presence — before it, never drawn
  const probeOnly = !s.calls && s.probes > 0
  const entry = has(W.ENTRY, s.entrypoint) ? W.ENTRY[s.entrypoint] : (s.entrypoint ? String(s.entrypoint) : '')
  const entryTip = has(W.ENTRY_TIP, s.entrypoint) ? W.ENTRY_TIP[s.entrypoint] : ''
  const inferred = !!s.harness_inferred
  return {
    key: sessionKey(s),
    href: formatHash({ area: 'replay', screen: 'replay', project: s.project_slug, id: s.session_id, params: {} }),
    harnessId: s.harness, harnessName: harnessName(s.harness), harnessIcon: harnessIcon(s.harness), harnessRaw: harnessRaw(s.harness),
    title: s.title ?? null, titleSource: s.title_source ?? null, untitled: s.title == null && !pendingTitle(s), titlePending: pendingTitle(s), titleText: titleText(s), titleTip: titleTipOf(s),
    dim: probeOnly, calls: s.calls || 0, probes: s.probes || 0,
    logged: s.logged || 0, subagent: s.has_subagent === true, inferred, synthesized: !!s.session_synthesized,
    multi, multiNames: multi ? [...new Set(s.harnesses.map((x) => harnessName(harnessKey(x))))] : null,
    entry, entryTip, project: s.project_slug === '_unresolved' ? null : { name: s.project_name || s.project_dir || s.project_slug, path: s.project_path || s.project_dir || '' },
    when: relTime(s.last_ts, now), whenTip: s.last_ts ? fmtStamp(s.last_ts) : '',
  }
}

// ── repaint policy ───────────────────────────────────────────────────────────────────────────────────────────────────
// the poll repaints only when this changes: every field a row shows (the project menu is built from the same rows)
const ROW_FIELDS = ['project_slug', 'session_id', 'title', 'title_source', 'harnesses', 'logged', 'harness', 'harness_inferred', 'session_synthesized', 'entrypoint', 'project_name', 'project_dir', 'project_path', 'calls', 'probes', 'has_subagent', 'last_ts']
export function listSignature(data, error) {
  const ss = flattenSessions(data).map((s) => ROW_FIELDS.map((k) => s[k]).join('|')).join(';')
  return `${error || ''}#${ss}#${JSON.stringify((data && data.errors) || null)}#${(data && data.stored) || ''}`
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

// ── the agent-not-captured check (1.8 空态): the C.3 `status` document, read by key presence ─────────────────────────────
// A picked agent is not being captured when its `harnesses` entry says desired off or captured false, its `topology`
// entry says captured false, or a `critical[]` entry names it. Anything absent is unknown, not "off".
export function agentNotCaptured(doc, id) {
  const k = harnessKey(id)
  const mine = (o) => Object.entries((o && typeof o === 'object') ? o : {}).filter(([h]) => harnessKey(h) === k).map(([, v]) => v || {})
  if (mine(doc && doc.harnesses).some((h) => h.desired === 'off' || h.captured === false)) return true
  if (mine(doc && doc.topology).some((t) => t.captured === false)) return true
  return ((doc && Array.isArray(doc.critical)) ? doc.critical : []).some((c) => c && c.harness != null && harnessKey(c.harness) === k)
}

// ── the one-shot capture-health read (1.8 数据与刷新: the 空态 and the filtered agent read it ONCE, no polling) ────────
// The first caller fires the read, every caller while it is in flight shares it, and once it has an answer it is
// never read again for the life of the screen. `read()` → a promise of the settled shot; `settled` is null until then.
export function capShotMaker(fetchHealth, now = Date.now) {
  let p = null, done = null
  const read = () => {
    if (!p) p = (async () => {
      let r
      try { r = await fetchHealth() } catch (e) { r = { ok: false, status: 0, error: String((e && e.message) || e) } }
      const p = capHealthPatch(r, now()) // the same reading of one answer as every capture-health card (an unreadable capture health is {unreadable})
      // a failure keeps the failed answer itself ({status, error}), so the line can say the cause class (K-29)
      done = p.capH ? { h: p.capH, asOf: p.capHOkAt } : { fail: r && !r.ok ? r : { error: p.capHErr } }
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
// instead — plus the time that answer was read (「截至」). A shot that never arrived says nothing yet. The verdict is taken
// at that time: the shot is read once, so judging it against a later clock would call it stale. A failed read or an unreadable capture health
// keeps its reason only in `tech`, the collapsed technical details (K-29).
export function emptyBoardState(shot) {
  if (!shot) return { line: '', tech: '' }
  if (shot.fail) { const f = readFailure(W.CAPTURE_HEALTH, shot.fail, { id: 'lib-cap-fail' }); return { line: f.line, tech: f.tech, asOf: null } }
  const v = captureVerdict(shot.h, { okAt: shot.asOf, now: shot.asOf })
  const tech = v.state === 'unreadable' ? techDetailsHtml([['reason', String(v.reason)]], { id: 'lib-cap-tech' }) : ''
  return { line: v.state === 'ok' ? W.CAPTURING_HINT : v.text, tech, asOf: shot.asOf, verdict: v }
}
// the filtered agent's line, when exactly one agent was picked and nothing matched (1.8 空态表): is it even being
// captured? → null (nothing to add) | {service:true,…} (the whole service's sentence) | {line, href} (this agent's)
export function filteredAgentLine(shot, id) {
  if (!shot || shot.fail) return null
  const v = captureVerdict(shot.h, { okAt: shot.asOf, now: shot.asOf })
  if (SERVICE_DOWN.has(v.state)) return { service: true, line: v.text, asOf: shot.asOf }
  if (agentNotCaptured(shot.h, id)) return { line: W.agentNotCaptured(agentLabel(id)), href: formatHash({ area: 'capture', screen: 'capture', params: { h: id } }) }
  return null
}
