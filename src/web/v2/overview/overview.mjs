// overview/overview.mjs — 总览 (1.7): the first screen, answering three questions at one glance — is capture healthy,
// is there anything to handle, what did the agents cost. Five cards (采集 · 要处理的事 · 统计 · 最近的会话 · 磁盘; first
// run swaps the last three for 开始使用). Every number names its source: stats come ONLY from S5 /api/overview (D24), the
// recent list is live from /api/sessions, and the two are allowed to disagree by
// a few sessions — the stats card says 截至, it never back-fills from the live list.
// Polls (1.5 §轮询): capture-health every 1.5 s and projects every 3 s while visible; retention · pricing ·
// overview(window) · overview(all) · traffic(24h) on open, on window change and every 30 s. Hidden stops everything;
// coming back reads at once. All reads are GET; the page holds no button but the window links, the 技术细节 disclosures
// and the read-failure 重试 (invariant 1).
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router, toast}.
import { COMMANDS, ERR_WHERE } from '../labels/capture.mjs'
import { esc, fmtWhen, relTime, bytes, usd } from '../core/fmt.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { harnessKey, harnessName, harnessIcon, UNIDENTIFIED } from '../core/chips.mjs'
import { captureVerdict, capHealthPatch, agentVerdicts, failureSentence, AGENT_TIER, CAPH_MS } from '../core/capture-verdict.mjs'
import { priceMatch, costOf } from '../core/metrics.mjs'
import { infoButton, techDetailsHtml } from '../core/ui.mjs'
import { L } from '../labels/common.mjs'
import * as W from '../labels/overview.mjs'

const DAY = 24 * 3600e3
export const POLL = Object.freeze({ health: CAPH_MS, projects: 3000, slow: 30000 })

// the route's window param, or 24h when it is not one of the three (1.7 §页头)
export const parseWindow = (p) => (p === '7d' || p === 'all') ? p : '24h'

// ── the poll engine ──────────────────────────────────────────────────────────────────────────────────────────────────
// One poll's decision at a heartbeat — pure, so the schedule is testable with a fake clock (caphealth-poll.test.mjs).
// `due` is the one-shot nudge (page became visible, window changed, retry); lastAt null means never read.
export function pollAction({ now, lastAt = null, inFlight = false, visible = true, period, due = false }) {
  if (!visible) return 'idle'
  if (inFlight) return 'wait'
  return (due || lastAt == null || now - lastAt >= period) ? 'read' : 'wait'
}

// ── shared small helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const list = (x) => Array.isArray(x) ? x : []
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null
const parseTs = (t) => { const x = t == null ? NaN : Date.parse(t); return Number.isNaN(x) ? null : x }
const agentKey = (a) => (a == null || a === '') ? null : harnessKey(a)
const when = (t, now) => { const x = parseTs(t); return x == null ? '—' : relTime(x, now) }
// one harness chip for the rows that carry one (icon + name; an unknown id keeps its dashed box and 未识别的 agent)
const chipHtml = (id) => `${harnessIcon(id)}<span class="ovnm">${esc(harnessName(id))}</span>`

// ── 要处理的事 · the items model (pure) ──────────────────────────────────────────────────────────────────────────────
// s = the read state: {caph:{data,okAt,err,ok}, sessions, classes, pricing, stats, usageAll, traffic — each {data,ok,err}}.
// → {rows:[{cls,key,chip,subject,text,extra,href,tip}], more:{cls→n}, partial:[names]}. A source that failed its last
// read keeps its last good data (items still computed from it) and names itself in `partial`; the RENDERER draws
// 「没有要处理的事」 only when partial is empty, every source answered and nothing triggered — never as a stand-in for
// unknown (invariant 4).
export function overviewItems(s, now) {
  const rows = [], more = {}
  const H = s.caph && s.caph.data && !s.caph.data.unreadable ? s.caph.data : null
  const push = (cls, key, o) => rows.push({ cls, key, ...o })
  const capped = (cls, items) => { for (const it of items.slice(0, 5)) push(cls, it.key, it); if (items.length > 5) more[cls] = items.length - 5 }

  // ── O1 · an agent with a problem, worded as its 采集 page row (agentVerdicts); the net-blocked ones lead the table ──
  if (H) {
    const o1 = agentVerdicts(H).filter((r) => r.tier <= AGENT_TIER.problem).sort((a, b) => a.tier - b.tier)
      .map((r) => ({ key: r.harness, chip: r.harness, href: `#/capture?h=${encodeURIComponent(r.harness)}`, text: W.AGENT_ITEM(harnessName(r.harness), r.text) }))
    capped('O1', o1)
    // ── O1′ · problems that hang on no harness: critical[] without one, the agent name list, the certificate ──────
    for (const c of list(H.critical)) if (c && c.harness == null) push('O1p', `c:${c.kind}`, { subject: W.SVC_ITEM(c.reason || W.KIND_WORD[c.kind] || c.kind || ''), href: '#/capture' })
    for (const p of list(H.agent_list && H.agent_list.problems)) push('O1p', 'agent-list', { subject: W.SVC_ITEM(String((p && (p.reason || p.code)) ?? p)), href: '#/capture' })
    const ca = Object.values(H.cert || {}).find((x) => x && x.code === 'ca-invalid')
    if (ca) push('O1p', 'cert', { subject: W.SVC_ITEM(ca.reason || W.KIND_WORD['ca-invalid']), href: '#/capture' })
  }

  // ── O2 · the capture service is down, not answering, not known, or `status` could not be read ──────────────────
  const cv = captureVerdict(s.caph && s.caph.data, { now })
  if (['unreadable', 'not-running', 'not-responding', 'unknown', 'unrecognized'].includes(cv.state)) push('O2', 'collector', { text: cv.text, href: '#/capture' })

  // ── O3 · problem-level failure groups of the last 24 h, newest first; the sentence is the capture log's own ──────
  if (H) capped('O3', list(H.failures && H.failures.groups).filter((g) => g && g.level === 'problem').map((g) => {
    const a = agentKey(g.harness), f = failureSentence(g)
    return {
      key: `${g.where}/${g.code}/${g.harness ?? ''}`, chip: a ?? undefined, subject: a != null ? null : W.SVC_SUBJECT,
      text: `${W.FAILURES} · ${f.unknown ? `${g.where ?? '—'}/${g.code ?? '—'} ${g.reason ?? ''}`.trim() : f.text} · ${W.FAIL_TIMES(g.count)} · ${when(g.last_ts, now)}`,
      href: a != null ? `#/capture?h=${encodeURIComponent(a)}` : '#/capture/log', tip: [g.level, g.where, g.code].filter(Boolean).join(' · '),
    }
  }))

  // ── O4 / O5 · the last install did not finish, left items, or its record cannot be read ─────────────────────────
  if (H) {
    if (list(H.errors).some((e) => e && e.where === ERR_WHERE.manifest)) push('O4', 'manifest', { text: W.MANIFEST_ERROR, href: '#/capture/log' })
    const inst = H.install || {}, n = list(inst.pending).length, unfinished = inst.state != null && inst.state !== 'complete'
    if (unfinished && n === 0) push('O4', 'unfinished', { text: W.INSTALL_UNFINISHED, href: '#/capture/log' })
    if (n > 0) push('O5', 'pending', { text: (H.health && H.health.state === 'residue' ? W.RESIDUE_LEFT : unfinished ? W.RESIDUE_UNFINISHED : W.INSTALL_PENDING)(n), href: '#/capture' })
  }

  // ── O6 · capture files the library could not read whole: the sessions document's errors[] (1.8's same count) ──────
  const nErr = list(s.sessions && s.sessions.data && s.sessions.data.errors).length
  if (nErr > 0) push('O6', 'files', { text: W.FILES_NOT_READ(nErr), href: '#/settings/storage' })

  // ── O8 · models in use that no price row matches (window=all, independent of the stats window) ──────────────────
  const U = s.usageAll && s.usageAll.data && s.usageAll.data.usage
  const price = priceTable(s.pricing && s.pricing.data)
  if (U && price) {
    const miss = unpricedModels(U.rows, price)
    if (miss.n > 0) push('O8', 'unpriced', { text: W.UNPRICED(miss.n), extra: miss.names, href: '#/settings/prices' })
  }

  // ── O9 · a host an agent connected to for the first time (traffic ?since=24h; first_seen and harness_since are the whole
  // index's): a harness first seen less than 24 h ago says nothing — a new install is not news ─────────────────────────
  const T = s.traffic && s.traffic.data
  if (T) {
    const since = T.harness_since || {}
    capped('O9', list(T.hosts).filter((r) => {
      const fs = parseTs(r && r.first_seen), hs = parseTs(since[r && r.harness])
      return r && r.host != null && fs != null && hs != null && now - fs < DAY && now - hs >= DAY
    }).sort((a, b) => parseTs(b.first_seen) - parseTs(a.first_seen)).map((r) => ({
      key: `${r.harness} ${r.host}`, chip: agentKey(r.harness) ?? undefined,
      text: `${W.NEW_HOST(harnessName(harnessKey(r.harness)), r.host)} (${W.BY_STATS})`,
      href: `#/traffic/host/${encodeURIComponent(harnessKey(r.harness))}/${encodeURIComponent(r.host)}`,
    })))
  }

  const partial = []
  if (s.caph && s.caph.ok === false) partial.push(W.SRC_NAME.health)
  for (const k of ['sessions', 'pricing', 'usageAll', 'traffic']) if (s[k] && s[k].ok === false) partial.push(W.SRC_NAME[k])
  return { rows, more, partial }
}

// the /api/pricing document's models[] as the table core/metrics.mjs prices with ({model: [input, output, cache_write, cache_read]})
export function priceTable(doc) {
  if (!doc || !Array.isArray(doc.models)) return null
  return Object.fromEntries(doc.models.filter((m) => m && m.model).map((m) => [m.model, [m.input, m.output, m.cache_write, m.cache_read]]))
}
const usageOfRow = (r) => ({ fresh: r.input, out: r.output, create: r.cache_write, read: r.cache_read })
const metered = (r) => (r.calls || 0) - (r.failed || 0) - (r.no_usage || 0)

// the models whose calls had usage but whose model no price row matches — one per model name ('' is 没有模型名)
export function unpricedModels(rows, table) {
  const miss = new Set()
  for (const r of list(rows)) if (metered(r) > 0 && !priceMatch(table, r.model)) miss.add(r.model == null || r.model === '' ? '' : String(r.model))
  const names = [...miss].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1))
  return { n: names.length, names: names.slice(0, 3) }
}

// ── 统计 · the stats model (pure; every number from the S5 rows alone, D24) ──────────────────────────────────────────
// rows: S5 rows; pricingData: the /api/pricing answer ({pricing}); → the figures the card draws. Money is an estimate
// (D14): a row that cannot be priced is excluded and marks the sum 「起」; nothing unknown is ever a 0.
export function overviewStats(rows, pricingData) {
  const price = pricingData && pricingData.pricing ? pricingData.pricing : null
  const rs = list(rows)
  const main = rs.filter((r) => r.lane === 'main')
  const meteredOf = (r) => (r.calls || 0) - (r.failed || 0) - (r.no_usage || 0)

  let cost = 0, floor = false, anyPriced = false
  const approxKeys = new Set()
  const rowCost = new Map() // a row's priced cost (null when it cannot be priced) — reused by the per-session / per-agent sums
  for (const r of rs) {
    if ((r.no_usage || 0) > 0) floor = true
    if (meteredOf(r) <= 0) { rowCost.set(r, null); continue }
    const pm = priceMatch(price, r.model)
    if (!pm) { floor = true; rowCost.set(r, null); continue }
    anyPriced = true
    if (!pm.exact) approxKeys.add(pm.key)
    const c = costOf(pm.row, { fresh: r.fresh, out: r.out, create: r.create, read: r.read })
    rowCost.set(r, c)
    cost += c || 0
  }

  // 主对话缓存命中: main rows only; a provider whose cache numbers mean something else marks the figure with 「?」
  let rd = 0, cr = 0, fr = 0, unknown = false
  for (const r of main) { rd += r.read || 0; cr += r.create || 0; fr += r.fresh || 0; if (r.cache_known === false) unknown = true }
  const hit = (rd + cr + fr) > 0 ? rd / (rd + cr + fr) : null
  const breaks = main.reduce((a, r) => a + (r.breaks || 0), 0)

  // ≈ 多花 (2.2 §多花怎么算, per row): every metered call reported its cache-write count → the write−read price gap;
  // none did → the uncached-input−read gap; in between, no missed count, or no price → this row cannot be said
  let extra = 0, cant = 0
  for (const r of main) {
    if (!(r.breaks > 0)) continue
    const pm = priceMatch(price, r.model)
    if (r.break_missed == null || !pm) { cant++; continue }
    const metered = meteredOf(r)
    let unit
    if ((r.create_null || 0) === 0) unit = pm.row[2] - pm.row[3]
    else if (metered > 0 && (r.create_null || 0) === metered) unit = pm.row[0] - pm.row[3]
    else { cant++; continue }
    extra += ((r.break_missed || 0) * unit) / 1e6
  }

  // the per-agent table: the same columns, grouped by the read-side harness id. Sessions are counted per group, so the
  // groups' session sums may exceed the card's own count when one session ran several agents (1.7 §Edge cases).
  const by = new Map()
  for (const r of rs) {
    const k = (r.harness == null || r.harness === '' || r.harness === 'unknown') ? null : harnessKey(r.harness)
    if (!by.has(k)) by.set(k, { harness: k, sessions: new Set(), calls: 0, cost: 0, floor: false, rd: 0, cr: 0, fr: 0, unknown: false, breaks: 0, last: null })
    const g = by.get(k)
    g.sessions.add(r.session_id); g.calls += r.calls || 0
    if (meteredOf(r) > 0 && rowCost.get(r) == null) g.floor = true
    g.cost += rowCost.get(r) || 0
    if (parseTs(r.last_ts) != null && (parseTs(g.last) == null || parseTs(r.last_ts) > parseTs(g.last))) g.last = r.last_ts
    if (r.lane === 'main') { g.rd += r.read || 0; g.cr += r.create || 0; g.fr += r.fresh || 0; g.breaks += r.breaks || 0; if (r.cache_known === false) g.unknown = true }
  }
  const byAgent = [...by.values()].map((g) => ({
    harness: g.harness, sessions: g.sessions.size, calls: g.calls, cost: g.cost, floor: g.floor,
    hit: (g.rd + g.cr + g.fr) > 0 ? g.rd / (g.rd + g.cr + g.fr) : null, unknown: g.unknown, breaks: g.breaks, last: g.last,
  })).sort((a, b) => (a.harness == null) - (b.harness == null) || (a.calls < b.calls ? 1 : a.calls > b.calls ? -1 : 0))

  // the most expensive session: priced whole (every metered row of it priced), the largest such sum. The hover wants
  // 标题 · ≈ $ · 主对话缓存命中 · 缓存断开 (1.7 §统计), so the per-session rollup keeps the main-lane hit parts too.
  const perSess = new Map()
  for (const r of rs) {
    const e = perSess.get(r.session_id) || { usd: 0, all: true, last: null, rd: 0, cr: 0, fr: 0, breaks: 0 }
    if (meteredOf(r) > 0) {
      const c = rowCost.get(r)
      if (c == null) e.all = false; else e.usd += c
    }
    if (parseTs(r.last_ts) != null && (parseTs(e.last) == null || parseTs(r.last_ts) > parseTs(e.last))) e.last = r.last_ts
    if (r.lane === 'main') { e.rd += r.read || 0; e.cr += r.create || 0; e.fr += r.fresh || 0; e.breaks += r.breaks || 0 }
    perSess.set(r.session_id, e)
  }
  let most = null
  for (const [sid, e] of perSess)
    if (e.all && e.usd > 0 && (!most || e.usd > most.usd || (e.usd === most.usd && (parseTs(e.last) ?? 0) > (parseTs(most.last) ?? 0))))
      most = { sessionId: sid, usd: e.usd, hit: (e.rd + e.cr + e.fr) > 0 ? e.rd / (e.rd + e.cr + e.fr) : null, breaks: e.breaks }

  return {
    sessions: new Set(rs.map((r) => r.session_id)).size,
    calls: rs.reduce((a, r) => a + (r.calls || 0), 0),
    cost: anyPriced ? cost : null, floor, approxKeys: [...approxKeys], unpriced: unpricedModels(rs, price),
    hit, hitUnknown: unknown, breaks, main: main.length, extra, extraCant: cant, byAgent, most,
  }
}

// ── 最近的会话 · the live list (pure; from /api/projects, never a statistic) ────────────────────────────────────────
export function recentRows(projectsData) {
  const P = projectsData && Array.isArray(projectsData.projects) ? projectsData : null
  if (!P) return null
  const flat = []
  for (const p of P.projects) for (const m of list(p && p.sessions)) if (m) flat.push(m)
  flat.sort((a, b) => (parseTs(b.last_ts) ?? -1) - (parseTs(a.last_ts) ?? -1))
  return flat.slice(0, 5).map((m) => ({
    key: `${m.project_slug}::${m.session_id}`,
    harness: m.harness, inferred: !!m.harness_inferred,
    title: m.title || m.first_prompt || null,
    titleBasis: m.title ? 'agent' : (m.first_prompt ? (m.first_prompt_basis || 'prompt') : null),
    calls: m.calls ?? 0, probes: m.probes ?? 0, last: m.last_ts || null,
    href: `#/replay/${encodeURIComponent(m.project_slug || '')}/${encodeURIComponent(m.session_id || '')}`,
  }))
}

// ── 磁盘 · the two figures (the value rules are 1.11's; this card reads the same /api/retention fields) ──────────────
export function diskModel(retentionData) {
  const R = retentionData
  if (!R || typeof R !== 'object' || !R.disk) return null
  const d = R.disk
  const total = num(d.total_bytes)
  const atLeast = Array.isArray(d.unreadable) && d.unreadable.length > 0
  let daily = null, dailyFloor = false, asOf = null, stale = false, reason = null
  if (!R.sizes) reason = R.sizes_reason || null
  else {
    const all = R.totals && R.totals.all && R.totals.all['24h'] ? R.totals.all['24h'] : null
    const leg = R.totals && R.totals.legacy_meta && R.totals.legacy_meta['24h'] ? R.totals.legacy_meta['24h'] : null
    const stored = ((all && all.stored_bytes) || 0) + ((leg && leg.stored_bytes) || 0)
    dailyFloor = ((all && all.stored_unrecorded) || 0) + ((leg && leg.stored_unrecorded) || 0) > 0
    const end = parseTs(R.sizes.windows_end), a = parseTs(R.sizes.as_of)
    asOf = a
    stale = a != null && end != null && a < end - DAY // the store's newest call predates the 24 h window
    if (!stale) daily = stored
  }
  return { total, atLeast, daily, dailyFloor, asOf, stale, reason }
}

// ── renderers (string level; the tests assert on these) ─────────────────────────────────────────────────────────────
export function headHtml(s) {
  return pageHeadHtml({
    name: SCREEN_NAME.overview,
    scope: { label: 'Stats window', options: W.WINDOWS.map((x) => ({ value: x, label: W.WINDOW_LABEL[x], href: `#/overview?window=${x}` })), value: s.w },
    readAt: s.readAt,
  })
}

// the capture card: the verdict's own sentence (core/capture-verdict.mjs — the 采集 page says the same thing), never empty
export function capCardHtml(s, now) {
  const v = captureVerdict(s.caph.data, { okAt: s.caph.okAt, err: s.caph.err, now })
  const h = s.caph.data && !s.caph.data.unreadable ? s.caph.data : null
  const errs = v.readErrors || (h && h.summary && h.summary.read_errors) || 0
  const sw = h && h.collector && h.collector.switch && h.collector.switch.harnesses ? h.collector.switch.harnesses : null
  const on = sw ? Object.values(sw).filter((x) => x && x.desired === 'on').length : null
  const tot = sw ? Object.values(sw).filter((x) => x && (x.desired === 'on' || x.desired === 'off')).length : null
  return `<section class="ovcard cap" aria-label="${esc(W.CARD.capture)}">` +
    `<h2 class="ovh"><span class="lamp ${esc(v.cls)}" aria-hidden="true"></span>${esc(W.CARD.capture)}</h2>` +
    `<p class="ovsay ${esc(v.cls)}">${esc(v.text)}</p>` +
    (errs > 0 ? `<p class="ovsub">${esc(W.READ_FILES_FAIL(errs))}</p>` : '') +
    (on != null && tot > 0 ? `<p class="ovsub">${esc(W.AGENTS_ON(on, tot))}</p>` : '') +
    `<p class="ovgo"><a href="#/capture">${esc(W.GO_CAPTURE)}</a></p>` +
    `</section>`
}

const itemHtml = (it) =>
  `<a class="ovitem" href="${esc(it.href)}"${it.tip ? ` title="${esc(it.tip)}"` : ''}>` +
  (it.chip != null ? chipHtml(it.chip) : (it.subject ? `<span class="ovsubj">${esc(it.subject)}</span>` : '')) +
  `<span class="ovtx">${esc(it.text)}${it.extra ? ` <span class="ovmono">${esc(it.extra.map((m) => m === '' ? W.NO_MODEL_NAME : m).join(' · '))}</span>` : ''}</span>` +
  `<span class="go" aria-hidden="true">›</span></a>`

const MORE_HREF = { O3: '#/capture/log', O9: '#/traffic' }
export function itemsCardHtml(s, now) {
  const items = overviewItems(s, now)
  const v = captureVerdict(s.caph.data, { okAt: s.caph.okAt, err: s.caph.err, now })
  const staleLine = v.state === 'stale' && s.caph.okAt != null ? `<p class="ovsub">${esc(W.CAP_STALE_AS_OF(fmtWhen(s.caph.okAt, now)))}</p>` : ''
  const allRead = s.caph.data != null && ['sessions', 'pricing', 'usageAll', 'traffic'].every((k) => s[k] && s[k].data != null)
  const body = items.rows.length
    ? items.rows.map(itemHtml).join('') +
      Object.entries(items.more).map(([cls, n]) => `<a class="ovitem more" href="${MORE_HREF[cls] || '#/capture'}">${esc(W.MORE_OF(n))}</a>`).join('')
    : (allRead && items.partial.length === 0 ? `<p class="ovempty">${esc(W.NO_ITEMS)}</p>` : '')
  const since = s.caph.data && s.caph.data.failures ? s.caph.data.failures.since : null
  return `<section class="ovcard items" aria-label="${esc(W.CARD.items)}">` +
    `<h2 class="ovh">${esc(W.CARD.items)}${infoButton({ label: 'Failure list window', title: W.FAIL_LIST, body: W.FAIL_WINDOW(since ? fmtWhen(parseTs(since), now) : null) })}</h2>` +
    (items.partial.length ? `<p class="ovsub warn">${esc(W.PARTIAL_NOTE(items.partial))}</p>` : '') + staleLine +
    `<div class="ovlist">${body}</div></section>`
}

export function statsCardHtml(s, now, titles) {
  const st = s.stats
  if (st == null) return '' // no such slot: no card
  if (st.ok === false) return readFailHtml('Stats', st.err, 'slow') // a failed read says so even before any data arrived
  if (st.data == null) return '' // never read yet: nothing is drawn that has no source (the polls land one by one)
  if (st.absent) return '' // the endpoint is not there: the card does not exist (1.7 §统计)
  const D = st.data
  if (D.rows == null) return '' // no rows: nothing has a source to draw
  const priceFail = s.pricing && s.pricing.ok === false ? s.pricing.err : null
  const priceData = s.pricing && s.pricing.data ? s.pricing.data : null
  const cover = coverageOf(s)
  if (!D.rows.length) { // the window holds not one session: that sentence, no zero figures (1.7 §统计)
    return `<section class="ovcard stats" aria-label="${esc(W.CARD.stats)}"><h2 class="ovh">${esc(W.CARD.stats)}</h2>` +
      `<p class="ovsub">${esc(W.AS_OF(D.as_of ? fmtWhen(parseTs(D.as_of), now) : '—'))} · ${esc(W.SCOPE_LINE)}</p>` +
      (cover ? `<p class="ovsub warn">${esc(cover)}</p>` : '') +
      (priceFail ? `<p class="ovsub warn">${esc(W.PRICE_FAIL(priceFail))}</p>` : '') +
      `<p class="ovsay">${esc(W.EMPTY_WINDOW)}</p></section>`
  }
  const m = overviewStats(D.rows || [], priceData)
  const hitPct = m.hit == null ? null : Math.round(m.hit * 100)
  const hitSeg = m.main === 0 ? `${esc(W.HIT_LABEL)} —` : `<span${m.hitUnknown ? ` title="${esc(W.HIT_UNKNOWN_TIP)}"` : ''}>${esc(`${W.HIT_PCT(hitPct)}${m.hitUnknown ? '?' : ''}`)}</span>`
  const breaksSeg = m.main === 0 ? `${esc(W.TBL.breaks)} —` : `${esc(W.BREAKS_N(m.breaks))}<span class="ovmark" title="${esc(L.STRUCT_EST)}">(${esc(L.STRUCT_EST)})</span>`
  return `<section class="ovcard stats" aria-label="${esc(W.CARD.stats)}">` +
    `<h2 class="ovh">${esc(W.CARD.stats)}</h2>` +
    `<p class="ovsub">${esc(W.AS_OF(D.as_of ? fmtWhen(parseTs(D.as_of), now) : '—'))} · ${esc(W.SCOPE_LINE)}</p>` +
    (cover ? `<p class="ovsub warn">${esc(cover)}</p>` : '') +
    (priceFail ? `<p class="ovsub warn">${esc(W.PRICE_FAIL(priceFail))}</p>` : '') +
    `<p class="ovsay">` +
    `<a href="#/sessions?window=${esc(s.w)}">${esc(W.SESSIONS_N(m.sessions))} ›</a> · ${esc(W.CALLS_N(m.calls))} · ` +
    `≈ ${priceFail ? '—' : (m.cost == null ? '—' : usd(m.cost))}${!priceFail && m.floor ? esc(W.FROM) : ''}` +
    (!priceFail && m.unpriced.n > 0 ? ` · <a href="#/settings/prices">${esc(W.UNPRICED(m.unpriced.n))} ›</a>` : '') +
    ` · ${hitSeg} · ${breaksSeg}` +
    `</p>` +
    extraLine(m, priceFail) +
    (m.most ? `<p class="ovsub"><a href="#/session/${encodeURIComponent(m.most.sessionId)}" title="${esc(mostHover(m.most, titles, now))}">${esc(W.MOST_EXPENSIVE)}</a></p>` : '') +
    agentTableHtml(m, s.w, now) +
    `</section>`
}

const extraCantWhy = 'extra cost = cache not read at a break × the unit price difference; it cannot be computed when this row has no missed count, no unit price, or cache writes reported for only some calls'
const extraLine = (m, priceFail) => {
  if (priceFail) return ''
  if (m.extraCant > 0 && !(m.extra > 0)) return `<p class="ovsay">${esc(W.EXTRA_LABEL)} ${esc(W.CANT)} <span class="ovmark" title="${esc(extraCantWhy)}">${esc(W.WASTED_CANT_K(m.extraCant))}</span></p>`
  return `<p class="ovsay">${esc(W.EXTRA_LABEL)} ${usd(m.extra)}${m.extraCant > 0 ? ` ${esc(W.FROM)} <span class="ovmark" title="${esc(extraCantWhy)}">${esc(W.WASTED_CANT_K(m.extraCant))}</span>` : ''}</p>`
}

const coverageOf = (s) => {
  const D = s.stats && s.stats.data
  const P = s.projects && s.projects.data
  if (!D || !D.store || !Array.isArray(D.store.harnesses) || !P) return null
  const inStore = new Set(D.store.harnesses.map(harnessKey))
  const seen = new Set()
  for (const p of list(P.projects)) for (const m of list(p && p.sessions)) {
    const k = agentKey(m && m.harness)
    if (k != null && !inStore.has(k)) seen.add(k)
  }
  return seen.size ? W.COVERAGE([...seen].map(harnessName).join(', ')) : null
}

// every session's title rule (the same fallback order as the recent list), keyed by session_id — the most-expensive
// hover looks its session up here, in the whole /api/projects answer, not just the five newest (1.7 §统计)
export function sessionTitleMap(projectsData) {
  const map = new Map()
  const P = projectsData && Array.isArray(projectsData.projects) ? projectsData : null
  if (!P) return map
  for (const p of P.projects) for (const m of list(p && p.sessions)) if (m && m.session_id != null)
    map.set(m.session_id, { title: m.title || m.first_prompt || null, basis: m.title ? 'agent' : (m.first_prompt ? (m.first_prompt_basis || 'prompt') : null), last: m.last_ts || null })
  return map
}

const mostHover = (most, titles, now) => {
  const meta = (titles && titles.get(most.sessionId)) || null
  const title = meta && meta.title ? (meta.basis === 'agent' ? meta.title : `${meta.title} (taken from the first prompt)`) : W.UNNAMED(meta ? fmtWhen(parseTs(meta.last), now) : '—')
  return `${title} · ≈ ${usd(most.usd)} · ${W.HIT_LABEL} ${most.hit == null ? '—' : `${Math.round(most.hit * 100)}%`} · ${W.BREAKS_N(most.breaks)}`
}

// the per-agent table as a grid of link rows — the whole row is one <a> (1.7 §统计 · 行链接); the unidentified row is
// plain text (the session library has no filter word for it yet)
const agentTableHtml = (m, w, now) => {
  if (!m.byAgent.length) return ''
  const t = W.TBL
  const head = `<div class="ovtrh" role="row"><span>${esc(t.agent)}</span><span>${esc(t.sessions)}</span><span>${esc(t.calls)}</span><span>${esc(t.cost)}</span><span>${esc(t.hit)}</span><span>${esc(t.breaks)}</span><span>${esc(t.last)}</span></div>`
  const rows = m.byAgent.map((g) => {
    const hit = g.hit == null ? '—' : `<span${g.unknown ? ` title="${esc(W.HIT_UNKNOWN_TIP)}"` : ''}>${Math.round(g.hit * 100)}%${g.unknown ? '?' : ''}</span>`
    const body = `<span class="ovag">${g.harness == null ? `<span class="ovsubj">${esc(UNIDENTIFIED)}</span>` : chipHtml(g.harness)}</span>` +
      `<span>${g.sessions}</span><span>${g.calls}</span>` +
      `<span>≈ ${g.cost == null ? '—' : usd(g.cost)}${g.floor ? esc(W.FROM) : ''}</span>` +
      `<span>${hit}</span><span>${g.breaks}</span><span>${esc(when(g.last, now))}</span>`
    return g.harness == null
      ? `<div class="ovtr" role="row">${body}</div>`
      : `<a class="ovtr" role="row" href="${esc(`#/sessions?h=${encodeURIComponent(g.harness)}&window=${w}`)}">${body}</a>`
  }).join('')
  return `<div class="hscroll"><div class="ovtbl" role="table">${head}${rows}</div></div>`
}

export function recentCardHtml(s, now) {
  const P = s.projects
  if (P == null) return ''
  if (P.ok === false) return readFailHtml('Session list', P.err, 'projects')
  const rows = recentRows(P.data)
  if (rows == null) return ''
  if (!rows.length) { // empty is a capture question, not a data question: the verdict's own sentence says why
    const v = captureVerdict(s.caph.data, { okAt: s.caph.okAt, err: s.caph.err, now })
    return `<section class="ovcard recent" aria-label="${esc(W.CARD.recent)}"><h2 class="ovh">${esc(W.CARD.recent)}</h2>` +
      `<p class="ovempty">${esc(v.text)}</p><p class="ovgo"><a href="#/capture">${esc(W.GO_CAPTURE)}</a></p></section>`
  }
  const body = rows.map((r) => {
    const title = r.title
      ? `${esc(r.title)}${r.titleBasis === 'guess' ? ` <span class="ovmark" title="${esc(W.FROM_FIRST_PROMPT)}">(inferred)</span>` : ''}`
      : esc(W.UNNAMED(fmtWhen(parseTs(r.last), now)))
    const titleTip = r.title ? (r.titleBasis === 'agent' ? W.TITLE_FROM_AGENT : W.FROM_FIRST_PROMPT) : null
    const calls = r.calls === 0 && r.probes > 0
      ? `<span title="${esc(W.PROBE_ONLY_TIP)}">${esc(W.PROBE_ONLY)}</span>` : W.CALLS_N(r.calls)
    return `<a class="ovitem" href="${esc(r.href)}">` +
      `${harnessIcon(r.harness)}<span class="ovnm">${esc(harnessName(r.harness))}${r.inferred ? ` <span class="ovmark" title="agent inferred from the request headers">(inferred)</span>` : ''}</span>` +
      `<span class="ovtx"${titleTip ? ` title="${esc(titleTip)}"` : ''}>${title}</span>` +
      `<span class="ovnum">${calls}</span>` +
      `<span class="ovwhen">${esc(when(r.last, now))}</span></a>`
  }).join('')
  return `<section class="ovcard recent" aria-label="${esc(W.CARD.recent)}"><h2 class="ovh">${esc(W.CARD.recent)}</h2>` +
    `<div class="ovlist">${body}</div>` +
    `<p class="ovgo"><a href="#/sessions">${esc(W.ALL_SESSIONS)}</a></p></section>`
}

export function diskCardHtml(s, now) {
  const R = s.retention
  if (R == null) return ''
  if (R.ok === false) return readFailHtml('Retention', R.err, 'slow')
  const m = diskModel(R.data)
  if (!m) return ''
  const total = m.total == null ? W.DISK_USE('—') : (m.atLeast ? W.DISK_AT_LEAST(bytes(m.total)) : W.DISK_USE(bytes(m.total)))
  const daily = m.daily == null
    ? `—${m.reason ? ` <span class="ovmark" title="${esc(m.reason)}">?</span>` : ''}`
    : `${bytes(m.daily)}${m.dailyFloor ? esc(W.FROM) : ''}`
  return `<section class="ovcard disk" aria-label="${esc(W.CARD.disk)}"><h2 class="ovh">${esc(W.CARD.disk)}</h2>` +
    `<p class="ovsay">${esc(total)}</p>` +
    `<p class="ovsub">${esc(W.DISK_PER_DAY(daily))}${m.asOf != null && !m.stale ? ` · ${esc(W.AS_OF(fmtWhen(m.asOf, now)))}` : ''}</p>` +
    (m.stale ? `<p class="ovsub">${esc(W.DISK_STALE)}</p>` : '') +
    `<p class="ovgo"><a href="#/settings/storage">${esc(W.SEE_STORAGE)}</a></p></section>`
}

export function firstUseHtml() {
  return `<section class="ovcard start" aria-label="${esc(W.CARD.start)}"><h2 class="ovh">${esc(W.CARD.start)}</h2>` +
    W.START_ROWS.map(([k, v]) => `<p class="ovsay"><b>${esc(k)}</b>${esc(v)}</p>`).join('') +
    techDetailsHtml({ 'install command': `<code>${esc(COMMANDS.install)}</code>` }, { id: 'ov-install', html: true }) +
    `</section>`
}

const readFailHtml = (what, why, group) =>
  `<section class="ovcard"><h2 class="ovh">${esc(what)}</h2>` +
  `<p class="ovsay warn">${esc(W.READ_FAIL(what, why || 'reason unknown'))} · ` +
  `<button type="button" class="ghostbtn" data-act="retry" data-g="${esc(group)}">${esc(W.RETRY)}</button></p></section>`

// the first-run page: not installed and not one session yet → the capture card and 开始使用 only (1.7 §首次使用)
export function firstUse(s) {
  const st = s.caph && s.caph.data && s.caph.data.summary ? s.caph.data.summary.state : null
  if (st !== 'not-installed') return false
  const rows = recentRows(s.projects && s.projects.data)
  return rows != null && rows.length === 0
}

// the whole body: which cards exist and their html
export function renderBody(s, now) {
  if (firstUse(s)) return { first: true, cap: capCardHtml(s, now), items: '', stats: '', recent: firstUseHtml(), disk: '' }
  return {
    first: false,
    cap: capCardHtml(s, now),
    items: itemsCardHtml(s, now),
    stats: statsCardHtml(s, now, sessionTitleMap(s.projects && s.projects.data)),
    recent: recentCardHtml(s, now),
    disk: diskCardHtml(s, now),
  }
}

// ── the screen ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const SKELETON =
  `<div class="page">` +
  `<header class="pagehead" id="ovhead"></header>` +
  `<div class="ovgrid" id="ovgrid">` +
  `<div id="ovcap"></div><div id="ovitems"></div><div id="ovstats" class="span"></div><div id="ovrecent"></div><div id="ovdisk"></div>` +
  `</div></div>`

export function mount(el, ctx) {
  const { api, router } = ctx
  let dead = false, w = parseWindow(router.current().params.window)
  const s = {
    w, readAt: null,
    caph: { data: null, okAt: null, err: null, ok: null, absent: false },
    projects: { data: null, ok: null, err: null, absent: false },
    retention: { data: null, ok: null, err: null, absent: false },
    pricing: { data: null, ok: null, err: null, absent: false },
    stats: { data: null, ok: null, err: null, absent: false },
    usageAll: { data: null, ok: null, err: null, absent: false },
    traffic: { data: null, ok: null, err: null, absent: false },
  }
  const polls = {
    health: { lastAt: null, inFlight: false, due: true, period: POLL.health },
    projects: { lastAt: null, inFlight: false, due: true, period: POLL.projects },
    slow: { lastAt: null, inFlight: false, due: true, period: POLL.slow },
  }

  el.innerHTML = SKELETON
  const zone = (id) => el.querySelector('#' + id)
  const zones = { head: zone('ovhead'), cap: zone('ovcap'), items: zone('ovitems'), stats: zone('ovstats'), recent: zone('ovrecent'), disk: zone('ovdisk') }
  let sigs = {}

  // fold one read into its slot: a failure keeps the last good data and marks the source failed this round
  const fold = (slot, r) => {
    const prev = s[slot]
    if (r && r.ok) { s[slot] = { data: r.data, ok: true, err: null, absent: !!r.absent }; s.readAt = Date.now() }
    else s[slot] = { data: prev && prev.data, ok: false, err: (r && (r.error || `HTTP ${r.status}`)) || 'reason unknown', absent: !!(r && r.absent) }
  }

  const render = () => {
    if (dead) return
    const now = api.now()
    const body = renderBody(s, now)
    const next = { head: headHtml(s), ...body }
    for (const k of ['head', 'cap', 'items', 'stats', 'recent', 'disk']) if (sigs[k] !== next[k]) { zones[k].innerHTML = next[k]; sigs[k] = next[k] }
    el.querySelector('#ovgrid').classList.toggle('first', body.first)
  }

  const readHealth = async () => {
    // capHealthPatch speaks {capH, capHOkAt, capHErr}; fold it into the slot (a 503 answer IS data — {unreadable};
    // a failed read keeps the last good answer and its time, so the card goes 未刷新 rather than blank)
    const p = capHealthPatch(await api.get('status'), Date.now())
    if (p.capHOkAt != null) s.caph = { data: p.capH, okAt: p.capHOkAt, err: null, ok: true, absent: false }
    else s.caph = { data: s.caph.data, okAt: s.caph.okAt, err: p.capHErr || 'reason unknown', ok: false, absent: false }
    if (s.caph.ok) s.readAt = Date.now()
  }
  const readProjects = async () => { fold('projects', await api.get('sessions')) }
  const readSlow = async () => {
    await Promise.allSettled([
      api.get('classes').then((r) => fold('retention', r)),
      api.get('pricing').then((r) => fold('pricing', r)),
      api.get('overview', { since: w === 'all' ? null : w }).then((r) => { fold('stats', r); if (w === 'all') s.usageAll = { ...s.stats } }),
      w === 'all' ? Promise.resolve() : api.get('overview').then((r) => fold('usageAll', r)),
      api.get('traffic', { since: '24h' }).then((r) => fold('traffic', r)),
    ])
  }
  const readers = { health: readHealth, projects: readProjects, slow: readSlow }

  // one heartbeat: ask each poll what to do; a read that is still out never starts a second one
  const beat = () => {
    if (dead) return
    const now = Date.now(), visible = typeof document === 'undefined' || !document.hidden
    for (const [name, p] of Object.entries(polls)) {
      if (pollAction({ now, ...p, visible }) !== 'read') continue
      p.inFlight = true; p.due = false
      Promise.resolve(readers[name]()).catch(() => {}).finally(() => { p.inFlight = false; p.lastAt = Date.now(); render() })
    }
  }
  const timer = setInterval(beat, 250)
  const onVis = () => { if (!document.hidden) for (const p of Object.values(polls)) p.due = true }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  const onClick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-act="retry"]') : null
    if (!b) return
    const g = b.dataset.g
    if (polls[g]) { polls[g].due = true; beat() }
  }
  el.addEventListener('click', onClick)
  beat()

  return {
    update(route) {
      const nw = parseWindow(route && route.params && route.params.window)
      if (nw !== w) { w = nw; s.w = w; polls.slow.due = true; beat() }
      else render()
    },
    unmount() {
      dead = true
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
      el.removeEventListener('click', onClick)
      el.replaceChildren()
    },
  }
}
