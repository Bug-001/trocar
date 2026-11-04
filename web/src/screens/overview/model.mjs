// screens/overview/model.mjs — the overview (1.7) as data: the first screen, answering three questions at one glance — is capture
// healthy, is there anything to handle, what did the agents cost. Framework-free (D75②): no DOM, no timers, no HTML; each card's
// model carries its texts (labels/*.mjs), hrefs and stable ids, and OverviewScreen.tsx only renders what these return.
// Every number names its source: stats come ONLY from the C.5 `overview` document (D24), the recent list is live from `sessions`,
// and the two may disagree by a few sessions — the stats card says 截至, it never back-fills from the live list. The disk footer is
// `classes.disk.trocar_bytes`.
//
// s = the read state: { w, caph: {data, okAt, err, ok}, sessions | classes | pricing | traffic | segments: {data, ok, err},
// stats: {data, ok, err, other}, control }. `ok` is null before the first answer and false after a failed read; `data` keeps the last
// good answer; `stats.other` says the numbers on hand were asked for another window.
import { COMMANDS, ERR_WHERE } from '../../../legacy/labels/capture.mjs'
import { TITLE_FROM_WIRE } from '../../../legacy/labels/replay.mjs'
import { fmtWhen, relTime, bytes, usd } from '../../../legacy/core/fmt.mjs'
import { harnessKey, harnessName, UNIDENTIFIED } from '../../../legacy/core/chips.mjs'
import { captureVerdict, agentVerdicts, failureSentence, AGENT_TIER } from '../../../legacy/core/capture-verdict.mjs'
import { priceMatch, costOf, hitRatio, priceTableOf } from '../../../legacy/core/metrics.mjs'
import { INTERVAL } from '../../../legacy/core/poll.mjs'
import { unpricedModels } from '../../../legacy/settings/prices.mjs'
import { controlFor } from '../../../legacy/core/harness-switch.mjs'
import { failureBrief, failureWord } from '../../../../src/cli/words.mjs'
import * as W from '../../../legacy/labels/overview.mjs'
import { WINDOW_LABEL, UNTITLED, PROMPT_UNREAD, PROMPT_UNREAD_TIP, READ_FAIL } from '../../../legacy/labels/common.mjs'

const DAY = 24 * 3600e3

// the route's window param, or 24h when it is not one of the three (1.7 §页头)
export const parseWindow = (p) => (p === '7d' || p === 'all') ? p : '24h'

// ── shared small helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const list = (x) => Array.isArray(x) ? x : []
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null
const parseTs = (t) => { const x = t == null ? NaN : Date.parse(t); return Number.isNaN(x) ? null : x }
const agentKey = (a) => (a == null || a === '') ? null : harnessKey(a)
const when = (t, now) => { const x = parseTs(t); return x == null ? '—' : relTime(x, now) }

// ── 要处理的事 · the items model ─────────────────────────────────────────────────────────────────────────────────────
// → {rows:[{cls,key,chip,subject,text,href,tip}], more:{cls→n}, partial:[names]}. Rows come in the 1.7 table's order, five per
// class at most (the rest is one 「N more」 link). A source that failed its last read keeps its last good data (items still
// computed from it) and names itself in `partial`; 「没有要处理的事」 is said only when partial is empty, every source answered and
// nothing triggered — never as a stand-in for unknown (invariant 4).
const SLOTS = ['sessions', 'classes', 'pricing', 'stats', 'traffic', 'segments'] // every read besides `status`
const ORDER = ['O1', 'O1p', 'O2', 'O3', 'O4', 'O5', 'O6', 'O9']
const QUIET = ['ok', 'off', 'not-installed'] // the capture states that need no item (1.7 §事项目录 MUST)
export function overviewItems(s, now) {
  const all = []
  const H = s.caph && s.caph.data ? s.caph.data : null
  const push = (cls, key, o) => all.push({ cls, key, ...o })

  // ── O1 · an agent with a problem, worded as its 采集 page row (agentVerdicts); the net-blocked ones lead the table ──
  if (H) {
    for (const r of agentVerdicts(H).filter((r) => r.tier <= AGENT_TIER.problem).sort((a, b) => a.tier - b.tier))
      push('O1', r.harness, { chip: r.harness, href: `#/capture?h=${encodeURIComponent(r.harness)}`, text: r.text })
    // ── O1′ · problems that hang on no harness: critical[] without one, the agent name list, the certificate ──────
    for (const c of list(H.critical)) if (c && c.harness == null) push('O1p', `c:${c.kind}`, { subject: W.SVC_ITEM(c.reason || failureWord(c.where, c.code ?? c.kind) || c.kind || ''), href: '#/capture' })
    for (const p of list(H.agent_list && H.agent_list.problems)) push('O1p', 'agent-list', { subject: W.SVC_ITEM(String((p && (p.reason || p.code)) ?? p)), href: '#/capture' })
    const ca = Object.values(H.cert || {}).find((x) => x && x.code === 'ca-invalid')
    if (ca) push('O1p', 'cert', { subject: W.SVC_ITEM(ca.reason || failureWord(null, 'ca-invalid')), href: '#/capture' })
  }

  // ── O2 · the capture service is stopped or not answering (the server's health, never re-folded here, 1.5), its state
  // cannot be said (daemon.error, with its reason), or the capture health in `status` could not be read ─────────────────────────────
  const cv = captureVerdict(s.caph && s.caph.data, { now })
  if (['unreadable', 'not-running', 'not-responding'].includes(cv.state)) push('O2', 'collector', { text: cv.text, href: '#/capture' })
  else if (H && H.daemon && H.daemon.error) push('O2', 'collector', { text: W.UNKNOWN_ITEM(String(H.daemon.error)), href: '#/capture' })

  // ── O3 · problem-level failure groups of the last 24 h, newest first; the sentence is the capture log's own ──────
  if (H) for (const g of list(H.failures && H.failures.groups).filter((g) => g && g.level === 'problem')) {
    const a = agentKey(g.harness), f = failureSentence(g)
    push('O3', `${g.where}/${g.code}/${g.harness ?? ''}`, {
      chip: a ?? undefined, subject: a != null ? null : W.SVC_SUBJECT,
      text: `${W.FAILURES} · ${f.unknown ? `${g.where ?? '—'}/${g.code ?? '—'} ${g.reason ?? ''}`.trim() : f.text} · ${W.FAIL_TIMES(g.count)} · ${when(g.last_ts, now)}`,
      href: a != null ? `#/capture?h=${encodeURIComponent(a)}` : '#/capture/log', tip: [g.level, g.where, g.code].filter(Boolean).join(' · '),
    })
  }
  // … and the raw layer's: `segments` problems[] of the segments written in the last 24 h, one group per code
  for (const g of rawGroups(s.segments && s.segments.data, now))
    push('O3', `raw/${g.code}`, { subject: W.RAW_SUBJECT, text: `${failureBrief(g)} · ${W.FAIL_TIMES(g.count)} · ${when(g.last, now)}`, href: '#/capture/log', tip: g.code })

  // ── O4 / O5 · the last install did not finish, left items, or its record cannot be read ─────────────────────────
  if (H) {
    if (list(H.errors).some((e) => e && e.where === ERR_WHERE.manifest)) push('O4', 'manifest', { text: W.MANIFEST_ERROR, href: '#/capture/log' })
    const inst = H.install || {}, n = list(inst.pending).length, unfinished = inst.state != null && inst.state !== 'complete'
    if (unfinished && n === 0) push('O4', 'unfinished', { text: W.INSTALL_UNFINISHED, href: '#/capture/log' })
    if (n > 0) push('O5', 'pending', { text: (H.health && H.health.state === 'residue' ? W.RESIDUE_LEFT : unfinished ? W.RESIDUE_UNFINISHED : W.INSTALL_PENDING)(n), href: '#/capture' })
  }

  // ── O6 · capture files the library could not read whole: the sessions document's errors[] (1.8's same count) ──────
  // an entry with level 'note' says a read was slow (a cold index), not that anything was lost: it stays in technical details
  const nErr = list(s.sessions && s.sessions.data && s.sessions.data.errors).filter((e) => e && e.level !== 'note').length
  if (nErr > 0) push('O6', 'files', { text: W.FILES_NOT_READ(nErr), href: '#/settings/storage' })

  // ── O9 · a host an agent connected to for the first time (traffic ?since=24h; first_seen and harness_since are the whole
  // index's): a harness first seen less than 24 h ago says nothing — a new install is not news ─────────────────────────
  const T = s.traffic && s.traffic.data
  if (T) {
    const since = T.harness_since || {}
    for (const r of list(T.hosts).filter((r) => {
      const fs = parseTs(r && r.first_seen), hs = parseTs(since[r && r.harness])
      return r && r.host != null && fs != null && hs != null && now - fs < DAY && now - hs >= DAY
    }).sort((a, b) => parseTs(b.first_seen) - parseTs(a.first_seen))) push('O9', `${r.harness} ${r.host}`, {
      chip: agentKey(r.harness) ?? undefined, subject: agentKey(r.harness) == null ? UNIDENTIFIED : null, // no agent: the unidentified name is the subject
      text: `${W.NEW_HOST(r.host)} (${W.BY_STATS})`,
      href: `#/traffic/host/${encodeURIComponent(harnessKey(r.harness))}/${encodeURIComponent(r.host)}`,
    })
  }

  // a capture state that is not fine and that no field above explains still gets its one line (1.7: never a false 「没有」)
  if (H && !all.length && !QUIET.includes(cv.state)) push('O2', 'collector', { text: cv.text, href: '#/capture' })

  const rows = [], more = {}
  for (const cls of ORDER) {
    const mine = all.filter((r) => r.cls === cls)
    rows.push(...mine.slice(0, 5))
    if (mine.length > 5) more[cls] = mine.length - 5
  }
  const partial = []
  if (s.caph && s.caph.ok === false) partial.push(W.SRC_NAME.health)
  for (const k of SLOTS) if (s[k] && s[k].ok === false) partial.push(W.SRC_NAME[k])
  return { rows, more, partial }
}

// the raw layer's problem groups: `segments` problems[] ({code, reason}) of the segments whose time range reaches into the
// last 24 h, folded by code → [{code, reason (the newest segment's), count, last}], newest first
function rawGroups(doc, now) {
  const by = new Map()
  for (const seg of list(doc && doc.segments)) {
    const to = parseTs(seg && seg.to)
    if (to == null || now - to >= DAY) continue
    for (const p of list(seg.problems)) {
      if (!p || p.code == null || p.level === 'note') continue // a note (a slow read) is not a failure (1.7 O3)
      const g = by.get(p.code) || { where: 'raw', code: p.code, reason: null, count: 0, last: null }
      g.count++
      if (g.last == null || to >= parseTs(g.last)) { g.last = seg.to; g.reason = p.reason ?? null }
      by.set(p.code, g)
    }
  }
  return [...by.values()].sort((a, b) => parseTs(b.last) - parseTs(a.last))
}

const usageOfRow = (r) => ({ fresh: r.input, out: r.output, create: r.cache_write, read: r.cache_read })
const metered = (r) => (r.calls || 0) - (r.failed || 0) - (r.no_usage || 0)

// 主对话缓存命中 over some usage rows: Σread ÷ Σ(read + write + input) of the main lane; uncertain when a main row's cache figures
// are not known or it reported no cache write (that term is then left out of the denominator) — never shown as a 0
function mainHit(rows) {
  const main = rows.filter((r) => r.lane === 'main')
  const u = { read: 0, create: 0, fresh: 0 }
  let uncertain = false
  for (const r of main) { u.read += r.cache_read || 0; u.create += r.cache_write || 0; u.fresh += r.input || 0; if (r.cache_known === false || r.cache_write == null) uncertain = true }
  return { hit: main.length ? hitRatio(u) : null, uncertain, main: main.length }
}

// ── 统计 · the stats model (every number from the `overview` document alone, D24) ────────────────────────────────────
// doc = the overview document, pricingDoc = /api/pricing. Money is an estimate (D14): a row that cannot be priced is left out and
// marks the sum 「起」, and so does a usage read that did not cover the window; nothing unknown is ever a 0.
export function overviewStats(doc, pricingDoc) {
  const table = priceTableOf(pricingDoc)
  const usage = (doc && doc.usage) || {}
  const rows = list(usage.rows), cov = usageCoverage(usage.coverage)
  const partial = cov.partial
  // the money is a lower bound when a call returned no usage, a metered row has no unit price, or usage is not read in full;
  // `why` keeps each cause so the hover can say it
  const priced = (rs) => {
    let cost = 0, any = false, noUsage = 0, unpriced = false
    for (const r of rs) {
      noUsage += r.no_usage || 0
      if (metered(r) <= 0) continue
      const pm = priceMatch(table, r.model)
      if (!pm) { unpriced = true; continue }
      any = true; cost += costOf(pm.row, usageOfRow(r)) || 0
    }
    return { cost: any ? cost : null, floor: noUsage > 0 || unpriced || partial, why: { noUsage, unpriced, partial } }
  }
  const byAgent = list(doc && doc.harnesses).map((h) => {
    const k = agentKey(h.harness), mine = rows.filter((r) => agentKey(r.harness) === k)
    return { harness: k, sessions: h.sessions, calls: h.calls, last: h.last_ts, ...priced(mine), ...mainHit(mine) }
  })
  const hit = mainHit(rows)
  return {
    sessions: doc && doc.sessions ? doc.sessions.total : null, calls: doc && doc.calls ? doc.calls.llm : null,
    ...priced(rows), partial, coverage: cov, hit: hit.hit, hitUncertain: hit.uncertain, main: hit.main,
    unpriced: unpricedModels(rows, table).length, byAgent,
  }
}

// how much of the window's usage was read (1.7 估价规则): the calls pair when the document has it, else the sessions pair;
// either may be missing or not a number — then nothing is claimed partial
function usageCoverage(c) {
  const cov = c || {}
  const cr = num(cov.calls_read), ct = num(cov.calls_in_window), sr = num(cov.sessions_read), st = num(cov.sessions_in_window)
  if (cr != null && ct != null) return { partial: cr < ct, callsLeft: ct - cr }
  return { partial: sr != null && st != null && sr < st, read: sr, total: st }
}

// ── 最近的会话 · the live list (the `sessions` document, never a statistic) ───────────────────────────────────────────
export function recentRows(sessionsData) {
  if (!sessionsData || !Array.isArray(sessionsData.sessions)) return null
  return [...sessionsData.sessions].filter(Boolean).sort((a, b) => (parseTs(b.last_ts) ?? -1) - (parseTs(a.last_ts) ?? -1)).slice(0, 5).map((m) => ({
    key: `${m.project_slug}::${m.session_id}`, id: m.session_id, harness: m.harness, inferred: !!m.harness_inferred,
    title: m.title ?? null, titleSource: m.title_source ?? null, calls: m.calls ?? 0, probes: m.probes ?? 0, last: m.last_ts || null,
    href: `#/replay/${encodeURIComponent(m.project_slug || '')}/${encodeURIComponent(m.session_id || '')}`,
  }))
}

// ── 盘上占用 · the stats card's footer: `classes.disk.trocar_bytes`, or nothing when the classes read failed ─────────
export function diskBytes(slot) {
  if (!slot || slot.ok === false || !slot.data || !slot.data.disk) return null
  return num(slot.data.disk.trocar_bytes)
}

// the agents in the live list that the overview document does not have yet (1.7 §统计 · 覆盖): a sentence, never a number
const WINDOW_MS = { '24h': DAY, '7d': 7 * DAY }
const coverageOf = (s, now) => {
  const D = s.stats && s.stats.data, S = s.sessions && s.sessions.data
  if (!D || !S) return null
  const inStats = new Set(list(D.harnesses).map((h) => agentKey(h && h.harness)))
  const from = WINDOW_MS[s.w] ? now - WINDOW_MS[s.w] : -Infinity // the live list is all time; the stats count the window's sessions
  const seen = new Set()
  for (const m of list(S.sessions)) { const k = agentKey(m && m.harness); if (k != null && !inStats.has(k) && (parseTs(m.last_ts) ?? -Infinity) >= from) seen.add(k) }
  return seen.size ? W.COVERAGE([...seen].map(harnessName).join(', ')) : null
}

// the first-use page: the sessions document has no session, whatever the capture state (1.7 §首次使用)
export function firstUse(s) {
  const rows = recentRows(s.sessions && s.sessions.data)
  return rows != null && rows.length === 0
}

// ── card models ──────────────────────────────────────────────────────────────────────────────────────────────────────
// a failed read (1.5 K-29): `answer` is the failed answer {status, error} (status 0 = no full answer) or a bare reason.
// `line` says what + the cause class in the board's words, never the reason; `pairs` (the technical details) carry status and reason.
export function readFail(what, answer) {
  const obj = answer != null && typeof answer === 'object'
  const status = obj && typeof answer.status === 'number' ? answer.status : null
  const why = obj ? answer.error : answer
  return { line: READ_FAIL(what, status), pairs: [...(status != null ? [['status', String(status)]] : []), ['error', why == null || why === '' ? '—' : String(why)]] }
}

// the page head's window links (the window is a route param, 1.2 §路由)
export const windowTabs = (w) => W.WINDOWS.map((x) => ({ value: x, label: WINDOW_LABEL[x], href: `#/overview?window=${x}`, on: x === w }))

// the capture card: the verdict's own sentence (core/capture-verdict.mjs — the 采集 page says the same thing), never empty
export function capCard(caph, now) {
  const c = caph || {}
  const v = captureVerdict(c.data, { okAt: c.okAt, err: c.err, now })
  const hs = c.data && c.data.harnesses && typeof c.data.harnesses === 'object' ? Object.values(c.data.harnesses) : null
  const subs = []
  if (v.readErrors > 0) subs.push(W.READ_FILES_FAIL(v.readErrors))
  if (hs && hs.length) subs.push(W.AGENTS_ON(hs.filter((x) => x && x.desired === 'on').length, hs.length))
  return { cls: v.cls, text: v.text, subs, tech: v.state === 'unreadable' ? [['reason', v.reason]] : null }
}

const MORE_HREF = { O3: '#/capture/log', O4: '#/capture/log', O6: '#/settings/storage', O9: '#/traffic' } // the rest: #/capture
export function itemsCard(s, now) {
  const items = overviewItems(s, now)
  const caph = s.caph || {}
  const v = captureVerdict(caph.data, { okAt: caph.okAt, err: caph.err, now })
  const allRead = caph.data != null && ['sessions', 'traffic', 'segments'].every((k) => s[k] && s[k].data != null)
  const seen = new Map() // two items of one class and key (two agent-list problems) still get distinct ids
  const rows = items.rows.map((it) => {
    const base = `${it.cls}:${it.key}`, n = seen.get(base) || 0
    seen.set(base, n + 1)
    return { id: n ? `${base}#${n}` : base, cls: it.cls, chip: it.chip ?? null, subject: it.subject ?? null, text: it.text || '', href: it.href, tip: it.tip || null }
  })
  const since = caph.data && caph.data.failures ? caph.data.failures.since : null
  return {
    rows,
    more: Object.entries(items.more).map(([cls, n]) => ({ id: `more:${cls}`, text: W.MORE_OF(n), href: MORE_HREF[cls] || '#/capture' })),
    partial: items.partial.length ? W.PARTIAL_NOTE(items.partial) : null,
    stale: v.state === 'stale' && caph.okAt != null ? W.CAP_STALE_AS_OF(fmtWhen(caph.okAt, now)) : null,
    empty: rows.length || items.partial.length ? null : allRead ? 'none' : 'reading',
    failWindow: W.FAIL_WINDOW(since ? fmtWhen(parseTs(since), now) : null),
  }
}

// the hit never carries a floor: a ratio over part of the window is not a lower bound (1.7 估价规则)
const hitOf = (h) => ({ text: h.main === 0 || h.hit == null ? '—' : `${Math.round(h.hit * 100)}%${h.uncertain ? '?' : ''}`, tip: h.uncertain ? W.HIT_UNKNOWN_TIP : null })
const costOfModel = (c, priceFail) => {
  const floor = !priceFail && c.cost != null && c.floor
  return {
    text: priceFail || c.cost == null ? '≈ —' : `${floor ? `${W.AT_LEAST} ` : ''}≈ ${usd(c.cost)}`,
    tip: [W.EST_TIP, floor ? W.FLOOR_TIP([c.why.noUsage > 0 && W.FLOOR_WHY.noUsage(c.why.noUsage), c.why.unpriced && W.FLOOR_WHY.unpriced, c.why.partial && W.FLOOR_WHY.partial].filter(Boolean)) : null].filter(Boolean).join(' · '),
  }
}

export function statsCard(s, now) {
  const st = s.stats
  if (st == null || st.data == null) return st && st.ok === false ? { kind: 'failed', fail: readFail('Stats', st.err) } : { kind: 'reading' }
  const D = st.data
  // the price table's read failed: the stats stay, the line says so (K-29: the reason only in the technical details)
  const priceFail = s.pricing && s.pricing.ok === false ? readFail(W.PRICE_TABLE, s.pricing.err) : null
  const m = overviewStats(D, s.pricing && s.pricing.data)
  const c = m.coverage
  const disk = diskBytes(s.classes)
  const card = {
    kind: 'shown', other: !!st.other,
    asOf: W.AS_OF(D.as_of ? fmtWhen(parseTs(D.as_of), now) : '—', INTERVAL.other / 1000), scope: W.SCOPE_LINE,
    missing: coverageOf(s, now),
    coverage: m.partial ? (c.callsLeft != null ? W.USAGE_CALLS_LEFT(c.callsLeft) : W.USAGE_SESSIONS(c.read, c.total)) : null,
    priceFail, empty: !m.sessions && !list(D.usage && D.usage.rows).length,
    sessions: null, calls: null, cost: null, unpriced: null, hit: null, agents: [],
    disk: disk != null ? { text: W.DISK_USE(bytes(disk)), href: '#/settings/storage' } : null,
  }
  if (card.empty) return card // 「这段时间里没有会话」, never a row of 0s
  // the per-agent rows: the whole row is one link (1.7 §统计 · 行链接), the unidentified row none. An agent with no session and no
  // model call in the window only made network requests: one dim row to its traffic, not a row of 0s
  const agents = m.byAgent.map((g) => {
    const trafficOnly = num(g.sessions) === 0 && num(g.calls) === 0
    const q = g.harness == null ? null : `?h=${encodeURIComponent(g.harness)}&window=${s.w}`
    return {
      id: g.harness ?? '*unidentified', chip: g.harness, trafficOnly, href: q && (trafficOnly ? `#/traffic${q}` : `#/sessions${q}`),
      sessions: g.sessions ?? '—', calls: g.calls ?? '—', cost: costOfModel(g, priceFail), hit: hitOf(g), last: when(g.last, now),
    }
  })
  return {
    ...card,
    sessions: { text: W.SESSIONS_N(m.sessions ?? 0), href: `#/sessions?window=${s.w}` }, calls: W.CALLS_N(m.calls ?? 0),
    cost: costOfModel(m, priceFail), unpriced: !priceFail && m.unpriced > 0 ? { text: W.UNPRICED(m.unpriced), href: '#/settings/prices' } : null,
    hit: hitOf({ hit: m.hit, uncertain: m.hitUncertain, main: m.main }), agents,
  }
}

export function recentCard(s, now) {
  const P = s.sessions
  if (P == null || P.data == null) return P && P.ok === false ? { kind: 'failed', fail: readFail('Session list', P.err) } : { kind: 'reading' }
  const rows = recentRows(P.data)
  if (rows == null || !rows.length) return { kind: 'none' } // no session at all is the first-use page (firstUse)
  return {
    kind: 'shown',
    rows: rows.map((r) => {
      const probe = r.calls === 0 && r.probes > 0, unread = r.title == null && r.titleSource === 'unread'
      return {
        id: r.key, harness: r.harness, inferred: r.inferred, title: r.title ?? (unread ? PROMPT_UNREAD : UNTITLED),
        titleTip: [r.title != null ? TITLE_FROM_WIRE : unread ? PROMPT_UNREAD_TIP : null, r.id].filter(Boolean).join(' · '),
        calls: { text: probe ? W.PROBE_ONLY : W.CALLS_N(r.calls), tip: probe ? W.PROBE_ONLY_TIP : null }, when: when(r.last, now), href: r.href,
      }
    }),
  }
}

// 开始使用: what trocar records, where, what it never does, what happens next; the install command (technical details) only
// while trocar is not installed — the board installs nothing (D55① · D61①)
export function startCard(s) {
  const h = s && s.caph && s.caph.data && s.caph.data.health
  return { rows: W.START_ROWS, install: h && h.state === 'not-installed' ? COMMANDS.install : null }
}

// 各 agent 一行 (1.7 §首次使用 · 1.9 §开关): the capture page's rows (agentVerdicts) and, for the same documents, its one control.
// A row the board cannot act on carries the command that does it (1.9 §开关) — install while trocar is not installed or left
// residue, else on / off spelt the way the status document keys this harness (none when it is unkeyed)
export function agentRows(s) {
  const H = s.caph && s.caph.data ? s.caph.data : null
  return (H ? agentVerdicts(H, null) : []).map((r) => {
    const control = controlFor({ control: s.control, status: H }, r.harness)
    const cmd = (c) => c.replace('<id>', r.cliId)
    const commands = control.kind ? null
      : control.why === 'not-installed' || control.why === 'residue' ? [['install', cmd(COMMANDS.install)]]
        : r.cliId ? [['start capturing', cmd(COMMANDS.on)], ['stop capturing', cmd(COMMANDS.off)]] : null
    return { id: r.harness, harness: r.harness, desired: r.desired, control, commands }
  })
}
