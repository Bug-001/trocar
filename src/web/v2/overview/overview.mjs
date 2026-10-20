// overview/overview.mjs — 总览 (1.7): the first screen, answering three questions at one glance — is capture healthy,
// is there anything to handle, what did the agents cost. Four cards (采集 · 要处理的事 · 统计 · 最近的会话; first run swaps
// the last two for 开始使用). Every number names its source: stats come ONLY from the C.5 `overview` document (D24), the
// recent list is live from `sessions`, and the two are allowed to disagree by a few sessions — the stats card says 截至,
// it never back-fills from the live list. The disk footer is `classes.disk.asight_bytes`.
// Polls (1.5 §轮询): `status` every CAPH_MS and `sessions` every 3 s while visible; classes · pricing · overview(window) ·
// segments · traffic(24h) on open, on window change and every 30 s. Hidden stops everything; coming back reads at
// once. All reads are GET; the page holds no button but the window links, the 技术细节 disclosures and 重试 (invariant 1).
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router, toast}.
import { COMMANDS, ERR_WHERE } from '../labels/capture.mjs'
import { TITLE_FROM_WIRE } from '../labels/replay.mjs'
import { esc, fmtWhen, relTime, bytes, usd } from '../core/fmt.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { harnessKey, harnessName, harnessIcon, ensureHarnessIcons, UNIDENTIFIED } from '../core/chips.mjs'
import { captureVerdict, capHealthPatch, agentVerdicts, failureSentence, AGENT_TIER, CAPH_MS } from '../core/capture-verdict.mjs'
import { priceMatch, costOf, hitRatio } from '../core/metrics.mjs'
import { loadSessions } from '../library/logic.mjs'
import { unpricedModels } from '../settings/prices.mjs'
import { failureBrief } from '../../../cli/words.mjs'
import { infoButton, techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/overview.mjs'

const DAY = 24 * 3600e3
export const POLL = Object.freeze({ health: CAPH_MS, sessions: 3000, slow: 30000 })

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
// s = the read state: {caph:{data,okAt,err,ok}, sessions, classes, pricing, stats, traffic, segments — each {data,ok,err}}.
// → {rows:[{cls,key,chip,subject,text,href,tip}], more:{cls→n}, partial:[names]}. Rows come in the 1.7 table's order, five per
// class at most (the rest is one 「N more」 link). A source that failed its last read keeps its last good data (items still
// computed from it) and names itself in `partial`; the RENDERER draws 「没有要处理的事」 only when partial is empty, every
// source answered and nothing triggered — never as a stand-in for unknown (invariant 4).
const SLOTS = ['sessions', 'classes', 'pricing', 'stats', 'traffic', 'segments'] // every read besides `status`
const ORDER = ['O1', 'O1p', 'O2', 'O3', 'O4', 'O5', 'O6', 'O9']
const QUIET = ['ok', 'off', 'not-installed'] // the capture states that need no item (1.7 §事项目录 MUST)
export function overviewItems(s, now) {
  const all = []
  const H = s.caph && s.caph.data && !s.caph.data.unreadable ? s.caph.data : null
  const push = (cls, key, o) => all.push({ cls, key, ...o })

  // ── O1 · an agent with a problem, worded as its 采集 page row (agentVerdicts); the net-blocked ones lead the table ──
  if (H) {
    for (const r of agentVerdicts(H).filter((r) => r.tier <= AGENT_TIER.problem).sort((a, b) => a.tier - b.tier))
      push('O1', r.harness, { chip: r.harness, href: `#/capture?h=${encodeURIComponent(r.harness)}`, text: W.AGENT_ITEM(harnessName(r.harness), r.text) })
    // ── O1′ · problems that hang on no harness: critical[] without one, the agent name list, the certificate ──────
    for (const c of list(H.critical)) if (c && c.harness == null) push('O1p', `c:${c.kind}`, { subject: W.SVC_ITEM(c.reason || W.KIND_WORD[c.kind] || c.kind || ''), href: '#/capture' })
    for (const p of list(H.agent_list && H.agent_list.problems)) push('O1p', 'agent-list', { subject: W.SVC_ITEM(String((p && (p.reason || p.code)) ?? p)), href: '#/capture' })
    const ca = Object.values(H.cert || {}).find((x) => x && x.code === 'ca-invalid')
    if (ca) push('O1p', 'cert', { subject: W.SVC_ITEM(ca.reason || W.KIND_WORD['ca-invalid']), href: '#/capture' })
  }

  // ── O2 · the capture service is stopped or not answering (the server's health, never re-folded here, 1.5), its state
  // cannot be said (daemon.error, with its reason), or `status` could not be read (503) ─────────────────────────────
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
  const nErr = list(s.sessions && s.sessions.data && s.sessions.data.errors).length
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
      chip: agentKey(r.harness) ?? undefined,
      text: `${W.NEW_HOST(harnessName(harnessKey(r.harness)), r.host)} (${W.BY_STATS})`,
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
export function rawGroups(doc, now) {
  const by = new Map()
  for (const seg of list(doc && doc.segments)) {
    const to = parseTs(seg && seg.to)
    if (to == null || now - to >= DAY) continue
    for (const p of list(seg.problems)) {
      if (!p || p.code == null) continue
      const g = by.get(p.code) || { code: p.code, reason: null, count: 0, last: null }
      g.count++
      if (g.last == null || to >= parseTs(g.last)) { g.last = seg.to; g.reason = p.reason ?? null }
      by.set(p.code, g)
    }
  }
  return [...by.values()].sort((a, b) => parseTs(b.last) - parseTs(a.last))
}

// the /api/pricing document's models[] as the table core/metrics.mjs prices with ({model: [input, output, cache_write, cache_read]})
export function priceTable(doc) {
  if (!doc || !Array.isArray(doc.models)) return null
  return Object.fromEntries(doc.models.filter((m) => m && m.model).map((m) => [m.model, [m.input, m.output, m.cache_write, m.cache_read]]))
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

// ── 统计 · the stats model (pure; every number from the `overview` document alone, D24) ─────────────────────────────
// doc = the overview document, pricingDoc = /api/pricing. Money is an estimate (D14): a row that cannot be priced is left out and
// marks the sum 「起」, and so does a usage read that did not cover the window; nothing unknown is ever a 0.
export function overviewStats(doc, pricingDoc) {
  const table = priceTable(pricingDoc)
  const usage = (doc && doc.usage) || {}
  const rows = list(usage.rows), cov = usage.coverage || {}
  const partial = num(cov.sessions_read) != null && num(cov.sessions_in_window) != null && cov.sessions_read < cov.sessions_in_window
  const priced = (rs) => {
    let cost = 0, any = false, floor = partial
    for (const r of rs) {
      if ((r.no_usage || 0) > 0) floor = true
      if (metered(r) <= 0) continue
      const pm = priceMatch(table, r.model)
      if (!pm) { floor = true; continue }
      any = true; cost += costOf(pm.row, usageOfRow(r)) || 0
    }
    return { cost: any ? cost : null, floor }
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

// ── 最近的会话 · the live list (pure; the `sessions` document, never a statistic) ───────────────────────────────────
export function recentRows(sessionsData) {
  if (!sessionsData || !Array.isArray(sessionsData.sessions)) return null
  return [...sessionsData.sessions].filter(Boolean).sort((a, b) => (parseTs(b.last_ts) ?? -1) - (parseTs(a.last_ts) ?? -1)).slice(0, 5).map((m) => ({
    key: `${m.project_slug}::${m.session_id}`, id: m.session_id, harness: m.harness, inferred: !!m.harness_inferred,
    title: m.title ?? null, titleSource: m.title_source ?? null, calls: m.calls ?? 0, probes: m.probes ?? 0, last: m.last_ts || null,
    href: `#/replay/${encodeURIComponent(m.project_slug || '')}/${encodeURIComponent(m.session_id || '')}`,
  }))
}

// ── 盘上占用 · the stats card's footer: `classes.disk.asight_bytes`, or nothing when the classes read failed ─────────
export function diskBytes(slot) {
  if (!slot || slot.ok === false || !slot.data || !slot.data.disk) return null
  return num(slot.data.disk.asight_bytes)
}

// ── renderers (string level) ─────────────────────────────────────────────────────────────────────────────────────────
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
  const hs = s.caph.data && s.caph.data.harnesses && typeof s.caph.data.harnesses === 'object' ? Object.values(s.caph.data.harnesses) : null
  const on = hs ? hs.filter((x) => x && x.desired === 'on').length : 0
  return `<section class="ovcard cap" aria-label="${esc(W.CARD.capture)}">` +
    `<h2 class="ovh"><span class="lamp ${esc(v.cls)}" aria-hidden="true"></span>${esc(W.CARD.capture)}</h2>` +
    `<p class="ovsay ${esc(v.cls)}">${esc(v.text)}</p>` +
    (v.readErrors > 0 ? `<p class="ovsub">${esc(W.READ_FILES_FAIL(v.readErrors))}</p>` : '') +
    (hs && hs.length ? `<p class="ovsub">${esc(W.AGENTS_ON(on, hs.length))}</p>` : '') +
    `<p class="ovgo"><a href="#/capture">${esc(W.GO_CAPTURE)}</a></p>` +
    `</section>`
}

const itemHtml = (it) =>
  `<a class="ovitem" href="${esc(it.href)}"${it.tip ? ` title="${esc(it.tip)}"` : ''}>` +
  (it.chip != null ? chipHtml(it.chip) : (it.subject ? `<span class="ovsubj">${esc(it.subject)}</span>` : '')) +
  `<span class="ovtx">${esc(it.text || '')}</span>` +
  `<span class="go" aria-hidden="true">›</span></a>`

const MORE_HREF = { O3: '#/capture/log', O4: '#/capture/log', O6: '#/settings/storage', O9: '#/traffic' } // the rest: #/capture
export function itemsCardHtml(s, now) {
  const items = overviewItems(s, now)
  const v = captureVerdict(s.caph.data, { okAt: s.caph.okAt, err: s.caph.err, now })
  const staleLine = v.state === 'stale' && s.caph.okAt != null ? `<p class="ovsub">${esc(W.CAP_STALE_AS_OF(fmtWhen(s.caph.okAt, now)))}</p>` : ''
  const allRead = s.caph.data != null && ['sessions', 'traffic', 'segments'].every((k) => s[k] && s[k].data != null)
  const body = items.rows.length
    ? items.rows.map(itemHtml).join('') +
      Object.entries(items.more).map(([cls, n]) => `<a class="ovitem more" href="${MORE_HREF[cls] || '#/capture'}">${esc(W.MORE_OF(n))}</a>`).join('')
    : (allRead && items.partial.length === 0 ? `<p class="ovempty">${esc(W.NO_ITEMS)}</p>` : '')
  const since = s.caph.data && s.caph.data.failures ? s.caph.data.failures.since : null
  return `<section class="ovcard items" aria-label="${esc(W.CARD.items)}">` +
    `<h2 class="ovh">${esc(W.CARD.items)}${infoButton({ label: 'Failure list window', title: W.FAIL_LIST, body: W.FAIL_WINDOW(since ? fmtWhen(parseTs(since), now) : null) })}</h2>` +
    (items.partial.length ? `<p class="ovsub warn ovpart">${esc(W.PARTIAL_NOTE(items.partial))}</p>` : '') + staleLine +
    `<div class="ovlist">${body}</div></section>`
}

const hitText = (h, floor) => h.main === 0 || h.hit == null ? '—' : `${Math.round(h.hit * 100)}%${h.uncertain ? '?' : ''}${floor ? ` ${W.FROM}` : ''}`
const costText = (c, priceFail) => `≈ ${priceFail || c.cost == null ? '—' : usd(c.cost)}${!priceFail && c.cost != null && c.floor ? ` ${W.FROM}` : ''}`

export function statsCardHtml(s, now) {
  const st = s.stats
  if (st == null) return ''
  if (st.ok === false && st.data == null) return readFailHtml('Stats', st.err, 'slow')
  if (st.data == null) return '' // never read yet: nothing is drawn that has no source
  const D = st.data
  const priceFail = s.pricing && s.pricing.ok === false ? s.pricing.err : null
  const m = overviewStats(D, s.pricing && s.pricing.data)
  const cov = m.partial || (m.coverage.sessions_read === 0 && m.coverage.sessions_in_window > 0)
    ? `<p class="ovsub warn">${esc(W.USAGE_COVERAGE(m.coverage.sessions_read, m.coverage.sessions_in_window, m.coverage.reason))}</p>` : ''
  const missing = coverageOf(s, now)
  const disk = diskBytes(s.classes)
  const head = `<section class="ovcard stats" aria-label="${esc(W.CARD.stats)}"><h2 class="ovh">${esc(W.CARD.stats)}</h2>` +
    `<p class="ovsub">${esc(W.AS_OF(D.as_of ? fmtWhen(parseTs(D.as_of), now) : '—'))} · ${esc(W.SCOPE_LINE)}</p>` +
    (missing ? `<p class="ovsub warn">${esc(missing)}</p>` : '') + cov +
    (priceFail ? `<p class="ovsub warn">${esc(W.PRICE_FAIL(priceFail))}</p>` : '')
  const foot = (disk != null ? `<p class="ovsub">${esc(W.DISK_USE(bytes(disk)))} · <a href="#/settings/storage">${esc(W.SEE_STORAGE)}</a></p>` : '') + `</section>`
  if (!m.sessions && !list(D.usage && D.usage.rows).length) return head + `<p class="ovsay">${esc(W.EMPTY_WINDOW)}</p>` + foot
  const hit = { hit: m.hit, uncertain: m.hitUncertain, main: m.main }
  return head +
    `<p class="ovsay">` +
    `<a href="#/sessions?window=${esc(s.w)}">${esc(W.SESSIONS_N(m.sessions ?? 0))} ›</a> · ${esc(W.CALLS_N(m.calls ?? 0))} · ` +
    `<span title="${esc(W.EST_TIP)}">${esc(costText(m, priceFail))}</span>` +
    (!priceFail && m.unpriced > 0 ? ` · <a href="#/settings/prices">${esc(W.UNPRICED(m.unpriced))} ›</a>` : '') +
    ` · <span${m.hitUncertain ? ` title="${esc(W.HIT_UNKNOWN_TIP)}"` : ''}>${esc(`${W.HIT_LABEL} ${hitText(hit, m.partial)}`)}</span>` +
    `</p>` + agentTableHtml(m, s.w, now, priceFail) + foot
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

// the per-agent table as a grid of link rows — the whole row is one <a> (1.7 §统计 · 行链接); the unidentified row is plain text
const agentTableHtml = (m, w, now, priceFail) => {
  if (!m.byAgent.length) return ''
  const t = W.TBL
  const head = `<div class="ovtrh" role="row"><span>${esc(t.agent)}</span><span>${esc(t.sessions)}</span><span>${esc(t.calls)}</span><span>${esc(t.cost)}</span><span>${esc(t.hit)}</span><span>${esc(t.last)}</span></div>`
  const rows = m.byAgent.map((g) => {
    const body = `<span class="ovag">${g.harness == null ? `<span class="ovsubj">${esc(UNIDENTIFIED)}</span>` : chipHtml(g.harness)}</span>` +
      `<span>${g.sessions ?? '—'}</span><span>${g.calls ?? '—'}</span><span>${esc(costText(g, priceFail))}</span>` +
      `<span${g.uncertain ? ` title="${esc(W.HIT_UNKNOWN_TIP)}"` : ''}>${esc(hitText(g, m.partial))}</span><span>${esc(when(g.last, now))}</span>`
    return g.harness == null
      ? `<div class="ovtr" role="row">${body}</div>`
      : `<a class="ovtr" role="row" href="${esc(`#/sessions?h=${encodeURIComponent(g.harness)}&window=${w}`)}">${body}</a>`
  }).join('')
  return `<div class="hscroll"><div class="ovtbl" role="table">${head}${rows}</div></div>`
}

const TITLE_TIP = { 'harness-local-store': W.TITLE_FROM_AGENT, wire: TITLE_FROM_WIRE }
export function recentCardHtml(s, now) {
  const P = s.sessions
  if (P == null) return ''
  if (P.ok === false && P.data == null) return readFailHtml('Session list', P.err, 'sessions')
  const rows = recentRows(P.data)
  if (rows == null || !rows.length) return '' // no session at all is the first-use page (firstUse)
  const body = rows.map((r) => {
    const tip = [r.title != null ? TITLE_TIP[r.titleSource] : null, r.id].filter(Boolean).join(' · ')
    const calls = r.calls === 0 && r.probes > 0 ? `<span title="${esc(W.PROBE_ONLY_TIP)}">${esc(W.PROBE_ONLY)}</span>` : esc(W.CALLS_N(r.calls))
    return `<a class="ovitem" href="${esc(r.href)}">` +
      `${harnessIcon(r.harness)}<span class="ovnm">${esc(harnessName(r.harness))}${r.inferred ? ` <span class="ovmark" title="agent inferred from the request headers">(inferred)</span>` : ''}</span>` +
      `<span class="ovtx" title="${esc(tip)}">${esc(r.title != null ? r.title : W.UNNAMED(fmtWhen(parseTs(r.last), now)))}</span>` +
      `<span class="ovnum">${calls}</span>` +
      `<span class="ovwhen">${esc(when(r.last, now))}</span></a>`
  }).join('')
  return `<section class="ovcard recent" aria-label="${esc(W.CARD.recent)}"><h2 class="ovh">${esc(W.CARD.recent)}</h2>` +
    `<div class="ovlist">${body}</div>` +
    `<p class="ovgo"><a href="#/sessions">${esc(W.ALL_SESSIONS)}</a></p></section>`
}

// 开始使用: what asight records, where, what it never does, what happens next; the install command (technical details) only
// while asight is not installed — the board installs nothing (D55① · D61①)
export function firstUseHtml(s) {
  const h = s && s.caph && s.caph.data && s.caph.data.health
  return `<section class="ovcard start" aria-label="${esc(W.CARD.start)}"><h2 class="ovh">${esc(W.CARD.start)}</h2>` +
    W.START_ROWS.map(([k, v]) => `<p class="ovsay"><b>${esc(k)}</b>${esc(v)}</p>`).join('') +
    (h && h.state === 'not-installed' ? techDetailsHtml({ 'install command': `<code>${esc(COMMANDS.install)}</code>` }, { id: 'ov-install', html: true }) : '') +
    `</section>`
}

const readFailHtml = (what, why, group) =>
  `<section class="ovcard"><h2 class="ovh">${esc(what)}</h2>` +
  `<p class="ovsay warn">${esc(W.READ_FAIL(what, why || 'reason unknown'))} · ` +
  `<button type="button" class="ghostbtn" data-act="retry" data-g="${esc(group)}">${esc(W.RETRY)}</button></p></section>`

// the first-use page: the sessions document has no session, whatever the capture state (1.7 §首次使用)
export function firstUse(s) {
  const rows = recentRows(s.sessions && s.sessions.data)
  return rows != null && rows.length === 0
}

// the whole body: which cards exist and their html. `agents` is the first-use zone of one row per agent (filled by the
// capture page's rows, 1.9 §开关); it stays its own zone, apart from the start card
export function renderBody(s, now) {
  if (firstUse(s)) return { first: true, cap: capCardHtml(s, now), items: '', agents: '', stats: '', recent: firstUseHtml(s) }
  return { first: false, cap: capCardHtml(s, now), items: itemsCardHtml(s, now), agents: '', stats: statsCardHtml(s, now), recent: recentCardHtml(s, now) }
}

// ── the screen ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const SKELETON =
  `<div class="page">` +
  `<header class="pagehead" id="ovhead"></header>` +
  `<div class="ovgrid" id="ovgrid">` +
  `<div id="ovcap"></div><div id="ovitems"></div><div id="ovagents"></div><div id="ovstats" class="span"></div><div id="ovrecent" class="span"></div>` +
  `</div></div>`

export function mount(el, ctx) {
  const { api, router } = ctx
  let dead = false, w = parseWindow(router.current().params.window)
  const s = { w, readAt: null, caph: { data: null, okAt: null, err: null, ok: null } }
  for (const k of SLOTS) s[k] = { data: null, ok: null, err: null }
  const polls = {
    health: { lastAt: null, inFlight: false, due: true, period: POLL.health },
    sessions: { lastAt: null, inFlight: false, due: true, period: POLL.sessions },
    slow: { lastAt: null, inFlight: false, due: true, period: POLL.slow },
  }

  el.innerHTML = SKELETON
  const zone = (id) => el.querySelector('#' + id)
  const zones = { head: zone('ovhead'), cap: zone('ovcap'), items: zone('ovitems'), agents: zone('ovagents'), stats: zone('ovstats'), recent: zone('ovrecent') }
  let sigs = {}

  // fold one read into its slot: a failure keeps the last good data and marks the source failed this round
  const fold = (slot, r) => {
    if (r && r.ok) { s[slot] = { data: r.data, ok: true, err: null }; s.readAt = Date.now() }
    else s[slot] = { data: s[slot].data, ok: false, err: (r && (r.error || `HTTP ${r.status}`)) || 'reason unknown' }
  }

  const render = () => {
    if (dead) return
    const now = api.now()
    const body = renderBody(s, now)
    const next = { head: headHtml(s), ...body }
    for (const k of Object.keys(zones)) if (sigs[k] !== next[k]) {
      zones[k].innerHTML = next[k]; sigs[k] = next[k]
      if (zones[k].querySelectorAll) ensureHarnessIcons(zones[k]) // fill the 16px boxes this card just drew
    }
    el.querySelector('#ovgrid').classList.toggle('first', body.first)
  }

  const readHealth = async () => {
    // capHealthPatch speaks {capH, capHOkAt, capHErr}; a failed read keeps the last good answer and its time (未刷新, not blank)
    const p = capHealthPatch(await api.get('status'), Date.now())
    if (p.capHOkAt != null) { s.caph = { data: p.capH, okAt: p.capHOkAt, err: null, ok: true }; s.readAt = Date.now() }
    else s.caph = { data: s.caph.data, okAt: s.caph.okAt, err: p.capHErr || 'reason unknown', ok: false }
  }
  const readSessions = async () => { fold('sessions', await loadSessions(api)) }
  const readSlow = async () => {
    await Promise.allSettled([
      api.get('classes').then((r) => fold('classes', r)),
      api.get('pricing').then((r) => fold('pricing', r)),
      api.get('overview', { since: w === 'all' ? null : w }).then((r) => fold('stats', r)),
      api.get('segments').then((r) => fold('segments', r)),
      api.get('traffic', { since: '24h' }).then((r) => fold('traffic', r)),
    ])
  }
  const readers = { health: readHealth, sessions: readSessions, slow: readSlow }

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
