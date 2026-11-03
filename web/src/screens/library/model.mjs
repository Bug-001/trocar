// screens/library/model.mjs — the session library as data (1.8): filters to and from hash params, the filtered and sorted list, the
// virtual list's keyed entries, the row view model with its marks, the menus, the caption facts and the stand-in states.
// Framework-free (D75②): no DOM, no timers, no HTML; LibraryScreen.tsx only renders what this returns. Agent names come from
// core/chips.mjs only (invariant 3); a field the server does not carry is detected by key presence and its element stays out —
// never a guess, never 0 (invariant 4). The shared read (loadSessions · freshSessions · sessionKey) stays in legacy/library/logic.mjs.
import { relTime, fmtStamp, fmtDate, fmtWeekday } from '../../../legacy/core/fmt.mjs'
import { HARNESS_ORDER, harnessKey, harnessName, harnessRaw } from '../../../legacy/core/chips.mjs'
import { formatHash } from '../../../legacy/core/router.mjs'
import { captureVerdict, capHealthPatch } from '../../../legacy/core/capture-verdict.mjs'
import { readFailure, mark } from '../../../legacy/core/ui.mjs'
import { sessionKey } from '../../../legacy/library/logic.mjs'
import * as W from '../../../legacy/labels/library.mjs'

export { sessionKey }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// ── filters ← → hash params (1.2 §路由: q · h repeatable · project · window · sort · sel) ───────────────────────────
export const WINDOWS = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, all: Infinity }
export function parseFilters(params = {}) {
  const p = params || {}
  return {
    q: p.q || '',
    // the route's ids go through harnessKey(), so a 1.6 cli id and the read-side id are one agent (1.8 §搜索)
    h: p.h ? String(p.h).split(',').map((x) => harnessKey(x)).filter(Boolean) : [],
    project: p.project || '',
    window: has(WINDOWS, p.window) ? p.window : 'all', // junk → the default
    sort: p.sort === 'calls' ? 'calls' : 'recent',      // 「最近」 is the default; `calls` is the only other value
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
// the harness id an agent-menu item stands for, read-side (the 1.6 cli's alias folds into it); '-' = a session whose
// harness is not identified (h=- filters them alone)
export const facetId = (s) => (s.harness == null || s.harness === '') ? '-' : harnessKey(s.harness)
// the unresolved bucket is not a project: its rows show no project, its name is not searched, it has no menu item.
// The project name is the last segment of project_path, else the slug (1.8 §一行).
const UNRESOLVED = '_unresolved'
const projectName = (s) => (s.project_path ? String(s.project_path).split('/').filter(Boolean).pop() : '') || s.project_slug || ''
export function flattenSessions(data) {
  return ((data && data.sessions) || []).map((s) => ({ ...s, project_name: s.project_slug === UNRESOLVED ? '' : projectName(s), project_dir: s.project_slug === UNRESOLVED ? '' : (s.project_path || '') }))
}
const lastMs = (s) => { const t = Date.parse(s.last_ts); return Number.isNaN(t) ? null : t }

// ── the title rule (1.8 §标题规则): `title` as it is, else 未命名会话; where it came from is `title_source` ─────────────
export const titleText = (s) => (s.title != null ? String(s.title) : W.UNTITLED)
export function titleTipOf(s) {
  const id = s.session_id
  if (s.title == null) return W.titleNoKey(id)
  return s.title_source === 'wire' ? W.titleFromWire(id) : W.titleFromAgent(id)
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

// groups, only in the 最近 order: one per local day of last_ts (YYYY-MM-DD from Date's local getters), no-time rows last in 'none'
const pad = (n) => String(n).padStart(2, '0')
export function groupOf(s) {
  const t = lastMs(s)
  if (t == null) return 'none'
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// a day head: today · yesterday as words, a weekday within the last six days, else the date itself (the year only when it is not
// this year); `date` rides beside the word unless the word already is the date. No counts (1.8 §表头与分组).
export function dayHead(key, now) {
  if (key === 'none') return { word: W.GROUPS.none, date: null }
  const [y, m, d] = key.split('-').map(Number), day = new Date(y, m - 1, d), n = new Date(now)
  const back = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - day.getTime()) / 86400e3) // round: DST days
  const date = fmtDate(day, now)
  const word = back === 0 ? W.GROUPS.today : back === 1 ? W.GROUPS.yesterday : back > 1 && back < 7 ? fmtWeekday(day) : null
  return word ? { word, date } : { word: date, date: null }
}
// the virtual list's entries, each with a stable key: rows, with a group entry before each new group only in the 最近 order
export function listEntries(rows, sort) {
  const out = []
  let last = null
  for (const s of rows) {
    if (sort === 'recent') { const g = groupOf(s); if (g !== last) { out.push({ key: 'g:' + g, g }); last = g } }
    out.push({ key: sessionKey(s), s })
  }
  return out
}

// ── the agent menu: 图标 + 名字, multi-select, NO counts (1.2 §页头: no numbers in the head zone) ────────────────────
// order: the chip table's, then ids the table does not know, then the unidentified one
export function agentMenuModel(list, f) {
  const present = new Set(list.map(facetId))
  const ids = [...HARNESS_ORDER.filter((h) => present.has(h)), ...[...present].filter((h) => !HARNESS_ORDER.includes(h) && h !== '-'), ...(present.has('-') ? ['-'] : [])]
  return ids.map((id) => ({ id, on: f.h.includes(id) }))
}

// ── the project menu: real projects only (the unresolved bucket is not a project); `path` is the hover. 「All projects」 is
// the component's. A chosen slug no row carries stays visible as its own item, marked missing.
export function projectMenuModel(list, selected) {
  const by = new Map()
  for (const s of list || []) if (s.project_slug && s.project_slug !== UNRESOLVED && !by.has(s.project_slug)) by.set(s.project_slug, { slug: s.project_slug, name: projectName(s), path: s.project_path || '', on: selected === s.project_slug, missing: false })
  const out = [...by.values()]
  if (selected && !by.has(selected)) out.push({ slug: selected, name: W.noSuchProject(selected), path: '', on: true, missing: true })
  return out
}

// ── the caption row's facts (1.8 §说明行: n = the entries whose level is not note — a note only says a read was slow; every
// entry, notes too, is listed in 技术细节 as where · reason) and `stored` (the list is the stored answer while a fresh one is made)
export function captionFacts(errors, stored = null) {
  const es = (errors || []).filter(Boolean), n = es.filter((e) => e.level !== 'note').length
  const facts = [...(n ? [{ kind: 'not-all', n }] : []), ...(stored ? [{ kind: 'stored', at: stored }] : [])]
  return { facts, tech: es.map((e) => `${e.where ?? ''} · ${e.reason ?? ''}`) }
}

// ── the row ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// the inferred mark's word is core/ui.mjs's, so it has one source with every other screen's inferred mark
const INFERRED = mark('inf', W.INFERRED_TIP).replace(/<[^>]*>/g, '')
export function rowModel(s, now) {
  const multi = Array.isArray(s.harnesses) && s.harnesses.length > 1 // S14: field presence — before it, never drawn
  const multiNames = multi ? [...new Set(s.harnesses.map((x) => harnessName(harnessKey(x))))] : null
  const entry = has(W.ENTRY, s.entrypoint) ? W.ENTRY[s.entrypoint] : (s.entrypoint ? String(s.entrypoint) : '')
  const entryTip = has(W.ENTRY_TIP, s.entrypoint) ? W.ENTRY_TIP[s.entrypoint] : ''
  const project = s.project_slug === UNRESOLVED ? null : { name: s.project_name || s.project_dir || s.project_slug, path: s.project_path || s.project_dir || '' }
  const logged = s.logged || 0, subagent = s.has_subagent === true, inferred = !!s.harness_inferred, synthesized = !!s.session_synthesized
  // the second line's marks, in this order, each only when its field says so (probe-only is `dim`, not a mark)
  const marks = [
    entry && { kind: 'entry', text: entry, tip: entryTip },
    project && { kind: 'project', text: project.name, tip: project.path || project.name },
    inferred && { kind: 'inferred', text: INFERRED, tip: W.INFERRED_TIP },
    synthesized && { kind: 'synthesized', text: W.SYNTHESIZED, tip: W.SYNTHESIZED_TIP },
    multi && { kind: 'multi', text: W.MULTI, tip: W.multiTip(multiNames) },
    subagent && { kind: 'subagent', text: W.SUBAGENT, tip: W.SUBAGENT_TIP },
    logged > 0 && { kind: 'logged', text: W.markLogged(logged), tip: W.loggedTip(logged) },
  ].filter(Boolean)
  const hn = harnessName(s.harness)
  return {
    key: sessionKey(s),
    href: formatHash({ area: 'replay', screen: 'replay', project: s.project_slug, id: s.session_id, params: {} }),
    harnessId: s.harness, harnessName: hn, harnessRaw: harnessRaw(s.harness),
    title: s.title ?? null, titleSource: s.title_source ?? null, untitled: s.title == null, titleText: titleText(s), titleTip: titleTipOf(s),
    dim: !s.calls && s.probes > 0, calls: s.calls || 0, probes: s.probes || 0,
    logged, subagent, inferred, synthesized, multi, multiNames, entry, entryTip, project,
    when: relTime(s.last_ts, now), whenTip: s.last_ts ? fmtStamp(s.last_ts) : '',
    marks, subTip: [hn, ...marks.map((m) => m.text)].join(' · '),
  }
}

// ── the list's scroll policy: what a new paint does. prevSig = the previous paint's filterSignature (null = a new list);
// the decision follows the highlighted session's KEY, not its index — a poll that re-sorts the rows above the highlight
// must not pull a list the reader has scrolled away.
//   top    — a filter changed after the first paint: the new result starts at the top
//   index  — bring row `index` into view: the first paint after mount, or a key press that moved the highlight
//   keep   — anything else (a poll): the scroll position stays
export const filterSignature = (f) => JSON.stringify([f.q, f.h, f.project, f.window, f.sort])
export function scrollDecision({ prevSig, sig, selKey, selIndex, prevSelKey }) {
  const hasSel = selKey != null && selIndex >= 0
  if (prevSig === null) return hasSel ? { kind: 'index', index: selIndex } : { kind: 'top' }
  if (sig !== prevSig) return { kind: 'top' }
  return hasSel && selKey !== prevSelKey ? { kind: 'index', index: selIndex } : { kind: 'keep' }
}
export const selectedKey = (rows, sel) => (!rows.length ? null : rows.some((s) => sessionKey(s) === sel) ? sel : sessionKey(rows[0]))

// wherever a chosen agent stands as a name, an id the chip table does not know rides along verbatim (1.8 Edge cases)
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
// The first caller fires the read, every caller while it is in flight shares it, and once it has an answer it is never
// read again for the life of the screen. `read()` → a promise of the settled shot; `settled` is null until then.
export function capShotMaker(fetchHealth, now = Date.now) {
  let p = null, done = null
  const read = () => {
    if (!p) p = (async () => {
      let r
      try { r = await fetchHealth() } catch (e) { r = { ok: false, status: 0, error: String((e && e.message) || e) } }
      const patch = capHealthPatch(r, now()) // the same reading of one answer as every capture-health card
      // a failure keeps the failed answer itself ({status, error}), so the line can say the cause class (K-29)
      done = patch.capH ? { h: patch.capH, asOf: patch.capHOkAt } : { fail: r && !r.ok ? r : { error: patch.capHErr } }
      return done
    })()
    return p
  }
  return { read, get settled() { return done } }
}

// ── the states that stand in for the table (1.8 空、载入、读不出) ─────────────────────────────────────────────────────
// the whole capture service being down replaces an agent-specific sentence; a state that only says "not perfect right
// now" (failing · unknown) does not — the agent's own line is still the useful one.
export const SERVICE_DOWN = new Set(['not-running', 'not-responding', 'not-installed', 'off'])
// the 空态's second line: the capture service's own sentence for its state — 采集在进行 says the inviting hint instead —
// plus the time that answer was read. The verdict is taken at that time (the shot is read once). A failed read or an
// unreadable capture health keeps its reason only in `tech`, [key, value] pairs for the collapsed technical details (K-29).
export function emptyBoardState(shot) {
  if (!shot) return { line: '', asOf: null, tech: null }
  if (shot.fail) {
    const r = shot.fail, status = typeof r.status === 'number' ? r.status : null
    const tech = [...(status != null ? [['status', String(status)]] : []), ['error', r.error == null || r.error === '' ? '—' : String(r.error)]]
    return { line: readFailure(W.CAPTURE_HEALTH, r).line, asOf: null, tech }
  }
  const v = captureVerdict(shot.h, { okAt: shot.asOf, now: shot.asOf })
  return { line: v.state === 'ok' ? W.CAPTURING_HINT : v.text, asOf: shot.asOf, tech: v.state === 'unreadable' ? [['reason', String(v.reason)]] : null, verdict: v }
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
