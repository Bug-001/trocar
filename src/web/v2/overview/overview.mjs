// overview/overview.mjs — 总览 (1.7): the first screen, answering three questions at one glance — is capture healthy,
// is there anything to handle, what did the agents cost. Four cards (采集 · 要处理的事 · 统计 · 最近的会话; first run swaps
// the last two for 开始使用). Every number names its source: stats come ONLY from the C.5 `overview` document (D24), the
// recent list is live from `sessions`, and the two are allowed to disagree by a few sessions — the stats card says 截至,
// it never back-fills from the live list. The disk footer is `classes.disk.trocar_bytes`.
// Polls (1.5 §轮询, core/poll.mjs): one poller per query name at 4.4 §live-poll's period — `status`, `sessions`, and classes ·
// pricing · overview(window) · segments · traffic(24h) at the 「其余」 period, the stats also on a window change; each backs off
// on its own after a failure (K-29). Hidden stops everything; coming back reads at once. All reads are GET; the page holds no button but the window links, the 技术细节 disclosures and 重试 (invariant 1) —
// except on first use, where each agent row carries the capture page's one control (core/harness-switch.mjs: switch or Set up,
// written only on a click through planConfirm); GET /control/status is read when first use is first seen and after a 405.
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router, toast}.
import { COMMANDS, ERR_WHERE, SWITCH_WORD } from '../labels/capture.mjs'
import { TITLE_FROM_WIRE } from '../labels/replay.mjs'
import { esc, fmtWhen, relTime, bytes, usd } from '../core/fmt.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { harnessKey, harnessName, harnessIcon, UNIDENTIFIED } from '../core/chips.mjs'
import { captureVerdict, capHealthPatch, agentVerdicts, failureSentence, AGENT_TIER } from '../core/capture-verdict.mjs'
import { priceMatch, costOf, hitRatio, priceTableOf } from '../core/metrics.mjs'
import { freshSessions } from '../library/logic.mjs'
import { startPoll, INTERVAL } from '../core/poll.mjs'
import { unpricedModels } from '../settings/prices.mjs'
import { failureBrief, failureWord } from '../../../cli/words.mjs'
import { infoButton, techDetailsHtml, confirmDialog, readFailure, repaint } from '../core/ui.mjs'
import { controlFor, controlHtml, wireHarnessControls } from '../core/harness-switch.mjs'
import * as W from '../labels/overview.mjs'
import { WINDOW_LABEL, UNTITLED, READING } from '../labels/common.mjs'

const DAY = 24 * 3600e3
const NO_ANSWER = Object.freeze({ status: null, error: null }) // a read that handed back nothing: no cause class known

// the route's window param, or 24h when it is not one of the three (1.7 §页头)
export const parseWindow = (p) => (p === '7d' || p === 'all') ? p : '24h'

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
export function rawGroups(doc, now) {
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

// ── 统计 · the stats model (pure; every number from the `overview` document alone, D24) ─────────────────────────────
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

// ── 最近的会话 · the live list (pure; the `sessions` document, never a statistic) ───────────────────────────────────
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

// ── renderers (string level) ─────────────────────────────────────────────────────────────────────────────────────────
export function headHtml(s) {
  return pageHeadHtml({
    name: SCREEN_NAME.overview,
    scope: { label: 'Stats window', options: W.WINDOWS.map((x) => ({ value: x, label: WINDOW_LABEL[x], href: `#/overview?window=${x}` })), value: s.w },
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
    (v.state === 'unreadable' ? techDetailsHtml([['reason', v.reason]], { id: 'ov-cap-tech' }) : '') +
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
    : items.partial.length ? '' : `<p class="ovempty${allRead ? '' : ' reading'}">${esc(allRead ? W.NO_ITEMS : READING)}</p>`
  const since = s.caph.data && s.caph.data.failures ? s.caph.data.failures.since : null
  return `<section class="ovcard items" aria-label="${esc(W.CARD.items)}">` +
    `<h2 class="ovh">${esc(W.CARD.items)}${infoButton({ label: 'Failure list window', title: W.FAIL_LIST, body: W.FAIL_WINDOW(since ? fmtWhen(parseTs(since), now) : null) })}</h2>` +
    (items.partial.length ? `<p class="ovsub warn ovpart">${esc(W.PARTIAL_NOTE(items.partial))}</p>` : '') + staleLine +
    `<div class="ovlist">${body}</div></section>`
}

// the hit never carries a floor: a ratio over part of the window is not a lower bound (1.7 估价规则)
const hitText = (h) => h.main === 0 || h.hit == null ? '—' : `${Math.round(h.hit * 100)}%${h.uncertain ? '?' : ''}`
const floorShown = (c, priceFail) => !priceFail && c.cost != null && c.floor
const costText = (c, priceFail) => priceFail || c.cost == null ? '≈ —' : `${floorShown(c) ? `${W.AT_LEAST} ` : ''}≈ ${usd(c.cost)}`
const costTip = (c, priceFail) => [W.EST_TIP, floorShown(c, priceFail)
  ? W.FLOOR_TIP([c.why.noUsage > 0 && W.FLOOR_WHY.noUsage(c.why.noUsage), c.why.unpriced && W.FLOOR_WHY.unpriced, c.why.partial && W.FLOOR_WHY.partial].filter(Boolean))
  : null].filter(Boolean).join(' · ')

// the price table's read failed: the stats stay, the line says so (K-29: the reason only in the technical details)
const priceFailHtml = (r) => { const f = readFailure(W.PRICE_TABLE, r, { id: 'ov-price-fail' }); return `<p class="ovsub warn">${esc(f.line)}</p>${f.tech}` }

export function statsCardHtml(s, now) {
  const st = s.stats
  if (st == null || (st.ok == null && st.data == null)) return readingHtml('stats', W.CARD.stats)
  if (st.ok === false && st.data == null) return readFailHtml('Stats', st.err, 'slow')
  if (st.data == null) return readingHtml('stats', W.CARD.stats)
  // the numbers on hand were asked for another window: drawn dim and marked reading until this window answers (1.7 §读取与刷新)
  const other = st.w != null && st.w !== s.w
  const D = st.data
  const priceFail = s.pricing && s.pricing.ok === false ? s.pricing.err : null
  const m = overviewStats(D, s.pricing && s.pricing.data)
  const c = m.coverage
  const cov = m.partial ? `<p class="ovsub warn ovcov">${esc(c.callsLeft != null ? W.USAGE_CALLS_LEFT(c.callsLeft) : W.USAGE_SESSIONS(c.read, c.total))}</p>` : ''
  const missing = coverageOf(s, now)
  const disk = diskBytes(s.classes)
  const head = `<section class="ovcard stats${other ? ' reading' : ''}"${other ? ' aria-busy="true"' : ''} aria-label="${esc(W.CARD.stats)}"><h2 class="ovh">${esc(W.CARD.stats)}</h2>` +
    (other ? `<p class="ovsub">${esc(READING)}</p>` : '') +
    `<p class="ovsub">${esc(W.AS_OF(D.as_of ? fmtWhen(parseTs(D.as_of), now) : '—', INTERVAL.other / 1000))} · ${esc(W.SCOPE_LINE)}</p>` +
    (missing ? `<p class="ovsub warn">${esc(missing)}</p>` : '') + cov +
    (priceFail ? priceFailHtml(priceFail) : '')
  const foot = (disk != null ? `<p class="ovsub">${esc(W.DISK_USE(bytes(disk)))} · <a href="#/settings/storage">${esc(W.SEE_STORAGE)}</a></p>` : '') + `</section>`
  if (!m.sessions && !list(D.usage && D.usage.rows).length) return head + `<p class="ovsay">${esc(W.EMPTY_WINDOW)}</p>` + foot
  const hit = { hit: m.hit, uncertain: m.hitUncertain, main: m.main }
  return head +
    `<p class="ovsay">` +
    `<a href="#/sessions?window=${esc(s.w)}">${esc(W.SESSIONS_N(m.sessions ?? 0))} ›</a> · ${esc(W.CALLS_N(m.calls ?? 0))} · ` +
    `<span class="ovcost" title="${esc(costTip(m, priceFail))}">${esc(costText(m, priceFail))}</span>` +
    (!priceFail && m.unpriced > 0 ? ` · <a href="#/settings/prices">${esc(W.UNPRICED(m.unpriced))} ›</a>` : '') +
    ` · ${esc(W.HIT_LABEL)} <span class="ovhit"${m.hitUncertain ? ` title="${esc(W.HIT_UNKNOWN_TIP)}"` : ''}>${esc(hitText(hit))}</span>` +
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

// the per-agent table as a grid of link rows — the whole row is one <a> (1.7 §统计 · 行链接); the unidentified row is plain text.
// An agent with no session and no model call in the window only made network requests: one dim row to its traffic, not a row of 0s
const agentTableHtml = (m, w, now, priceFail) => {
  if (!m.byAgent.length) return ''
  const t = W.TBL
  const head = `<div class="ovtrh" role="row"><span>${esc(t.agent)}</span><span class="n">${esc(t.sessions)}</span><span class="n">${esc(t.calls)}</span><span class="n">${esc(t.cost)}</span><span class="n">${esc(t.hit)}</span><span class="n">${esc(t.last)}</span></div>`
  const rows = m.byAgent.map((g) => {
    const net = num(g.sessions) === 0 && num(g.calls) === 0
    const body = `<span class="ovag">${g.harness == null ? `<span class="ovsubj">${esc(UNIDENTIFIED)}</span>` : chipHtml(g.harness)}</span>` + (net
      ? `<span class="ovnet">${esc(W.NET_ONLY)}</span>`
      : `<span class="n">${g.sessions ?? '—'}</span><span class="n">${g.calls ?? '—'}</span><span class="n" title="${esc(costTip(g, priceFail))}">${esc(costText(g, priceFail))}</span>` +
        `<span class="n"${g.uncertain ? ` title="${esc(W.HIT_UNKNOWN_TIP)}"` : ''}>${esc(hitText(g))}</span><span class="n">${esc(when(g.last, now))}</span>`)
    const cls = `ovtr${net ? ' nocall' : ''}`
    if (g.harness == null) return `<div class="${cls}" role="row">${body}</div>`
    const href = net ? `#/traffic?h=${encodeURIComponent(g.harness)}&window=${w}` : `#/sessions?h=${encodeURIComponent(g.harness)}&window=${w}`
    return `<a class="${cls}" role="row" href="${esc(href)}">${body}</a>`
  }).join('')
  return `<div class="hscroll"><div class="ovtbl" role="table">${head}${rows}</div></div>`
}

const TITLE_TIP = { 'harness-local-store': W.TITLE_FROM_AGENT, wire: TITLE_FROM_WIRE }
export function recentCardHtml(s, now) {
  const P = s.sessions
  if (P == null || (P.ok == null && P.data == null)) return readingHtml('recent', W.CARD.recent)
  if (P.ok === false && P.data == null) return readFailHtml('Session list', P.err, 'sessions')
  const rows = recentRows(P.data)
  if (rows == null || !rows.length) return '' // no session at all is the first-use page (firstUse)
  const body = rows.map((r) => {
    const tip = [r.title != null ? TITLE_TIP[r.titleSource] : null, r.id].filter(Boolean).join(' · ')
    const calls = r.calls === 0 && r.probes > 0 ? `<span title="${esc(W.PROBE_ONLY_TIP)}">${esc(W.PROBE_ONLY)}</span>` : esc(W.CALLS_N(r.calls))
    return `<a class="ovitem" href="${esc(r.href)}">` +
      `${harnessIcon(r.harness)}<span class="ovnm">${esc(harnessName(r.harness))}${r.inferred ? ` <span class="ovmark" title="agent inferred from the request headers">(inferred)</span>` : ''}</span>` +
      `<span class="ovtx" title="${esc(tip)}">${esc(r.title != null ? r.title : UNTITLED)}</span>` +
      `<span class="ovnum">${calls}</span>` +
      `<span class="ovwhen">${esc(when(r.last, now))}</span></a>`
  }).join('')
  return `<section class="ovcard recent" aria-label="${esc(W.CARD.recent)}"><h2 class="ovh">${esc(W.CARD.recent)}</h2>` +
    `<div class="ovlist">${body}</div>` +
    `<p class="ovgo"><a href="#/sessions">${esc(W.ALL_SESSIONS)}</a></p></section>`
}

// 开始使用: what trocar records, where, what it never does, what happens next; the install command (technical details) only
// while trocar is not installed — the board installs nothing (D55① · D61①)
export function firstUseHtml(s) {
  const h = s && s.caph && s.caph.data && s.caph.data.health
  return `<section class="ovcard start" aria-label="${esc(W.CARD.start)}"><h2 class="ovh">${esc(W.CARD.start)}</h2>` +
    W.START_ROWS.map(([k, v]) => `<p class="ovsay"><b>${esc(k)}</b>${esc(v)}</p>`).join('') +
    (h && h.state === 'not-installed' ? techDetailsHtml({ 'install command': `<code>${esc(COMMANDS.install)}</code>` }, { id: 'ov-install', html: true }) : '') +
    `</section>`
}

// a card whose first answer has not come yet: its name and 读取中 (1.5 覆盖), never a blank space
const readingHtml = (cls, title) =>
  `<section class="ovcard ${cls} reading" aria-label="${esc(title)}" aria-busy="true"><h2 class="ovh">${esc(title)}</h2><p class="ovsay">${esc(READING)}</p></section>`

const readFailHtml = (what, r, group) => {
  const f = readFailure(what, r, { id: `ov-fail-${group}` })
  return `<section class="ovcard"><h2 class="ovh">${esc(what)}</h2>` +
    `<p class="ovsay warn">${esc(f.line)} · ` +
    `<button type="button" class="ghostbtn" data-act="retry" data-g="${esc(group)}">${esc(W.RETRY)}</button></p>${f.tech}</section>`
}

// the first-use page: the sessions document has no session, whatever the capture state (1.7 §首次使用)
export function firstUse(s) {
  const rows = recentRows(s.sessions && s.sessions.data)
  return rows != null && rows.length === 0
}

// 各 agent 一行 (1.7 §首次使用 · 1.9 §开关): the capture page's rows (agentVerdicts) and, for the same documents, its one control.
// s.control = GET /control/status's answer (null before it), s.ui = Map read-side id → {busy, receipt} (kept across repaints).
function agentRowsHtml(s) {
  const H = s.caph && s.caph.data ? s.caph.data : null
  const rows = H ? agentVerdicts(H, null) : []
  if (!rows.length) return ''
  const ui = s.ui || new Map()
  return `<section class="ovcard agents" aria-label="${esc(W.CARD.agents)}"><h2 class="ovh">${esc(W.CARD.agents)}</h2>` +
    rows.map((r) => {
      const m = controlFor({ control: s.control, status: H }, r.harness)
      return `<div class="ovitem ovagent" data-h="${esc(r.harness)}">${chipHtml(r.harness)}` +
        `<span class="ovtx">${esc(SWITCH_WORD[r.desired] || '')}</span>${controlHtml(m, ui.get(r.harness))}${m.kind ? '' : rowCommandsHtml(m, r)}</div>`
    }).join('') + `</section>`
}

// a row the board cannot act on: the command that does it, under technical details (1.9 §开关) — install while trocar is
// not installed or left residue, else on / off spelt the way the status document keys this harness (none when it is unkeyed)
function rowCommandsHtml(m, r) {
  const cmd = (c) => `<code>${esc(c.replace('<id>', r.cliId))}</code>`
  const pairs = m.why === 'not-installed' || m.why === 'residue' ? { install: cmd(COMMANDS.install) }
    : r.cliId ? { 'start capturing': cmd(COMMANDS.on), 'stop capturing': cmd(COMMANDS.off) } : null
  return pairs ? techDetailsHtml(pairs, { id: `ov-cmd-${r.harness}`, html: true }) : ''
}

// the whole body: which cards exist and their html. `agents` is the first-use zone of one row per agent, its own zone apart
// from the start card; both go when the first session arrives (1.5 empty → live)
export function renderBody(s, now) {
  if (firstUse(s)) return { first: true, cap: capCardHtml(s, now), items: '', agents: agentRowsHtml(s), stats: '', recent: firstUseHtml(s) }
  return { first: false, cap: capCardHtml(s, now), items: itemsCardHtml(s, now), agents: '', stats: statsCardHtml(s, now), recent: recentCardHtml(s, now) }
}

// ── the screen ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const SKELETON =
  `<div class="page">` +
  `<div id="ovhead"></div>` + // headHtml brings its own <header class="pagehead">
  `<div class="ovgrid" id="ovgrid">` +
  `<div id="ovcap"></div><div id="ovitems"></div><div id="ovagents"></div><div id="ovstats" class="span"></div><div id="ovrecent" class="span"></div>` +
  `</div></div>`

export function mount(el, ctx) {
  const { api, router } = ctx
  let dead = false
  const s = { w: parseWindow(router.current().params.window), readAt: null, caph: { data: null, okAt: null, err: null, ok: null }, control: null, ui: new Map() }
  let ctlAsked = false
  for (const k of SLOTS) s[k] = { data: null, ok: null, err: null }

  el.innerHTML = SKELETON
  const zone = (id) => el.querySelector('#' + id)
  const zones = { head: zone('ovhead'), cap: zone('ovcap'), items: zone('ovitems'), agents: zone('ovagents'), stats: zone('ovstats'), recent: zone('ovrecent') }

  // fold one read into its slot: a failure keeps the last good data and marks the source failed this round. → {ok} for the poller
  const fold = (slot, r) => {
    if (r && r.ok) { s[slot] = { data: r.data, ok: true, err: null }; s.readAt = Date.now() }
    else s[slot] = { data: s[slot].data, ok: false, err: r || NO_ANSWER }
    return { ok: !!(r && r.ok) }
  }

  // a repaint never takes the reader's place (1.2 §点击与选中文字 ③, core/ui.mjs repaint): a zone holding a text selection waits for
  // the next render, focus returns; a render the reader caused (`reader`, the switch's result) draws at once
  const render = (reader = false) => {
    if (dead) return
    const now = api.now()
    const body = renderBody(s, now)
    const next = { head: headHtml(s), ...body }
    if (body.first && !ctlAsked) { ctlAsked = true; readControl() }
    for (const k of Object.keys(zones)) repaint(zones[k], next[k], { hold: !reader })
    el.querySelector('#ovgrid').classList.toggle('first', body.first)
  }

  const readHealth = async () => {
    // capHealthPatch speaks {capH, capHOkAt, capHErr}; a failed read keeps the last good answer and its time (未刷新, not blank)
    const p = capHealthPatch(await api.get('status'), Date.now())
    if (p.capHOkAt != null) { s.caph = { data: p.capH, okAt: p.capHOkAt, err: null, ok: true }; s.readAt = Date.now() }
    else s.caph = { data: s.caph.data, okAt: s.caph.okAt, err: p.capHErr || 'reason unknown', ok: false }
    return { ok: s.caph.ok }
  }
  const readControl = () => api.controlStatus().then((r) => { s.control = r }, (e) => { s.control = { ok: false, error: String(e) } }).finally(render)
  const readSessions = async () => fold('sessions', await freshSessions(api, { alive: () => !dead })) // a stored answer is not shown (4.4 §存下的答案)
  // the five slow reads share two sockets (1.7 §读取与刷新: the browser's six per origin keep room for status and sessions), the
  // window's own stats read included; an aborted read gives its socket back at once, as the browser does
  let free = 2
  const queue = []
  const slowGet = (name, params, opts = {}) => new Promise((resolve, reject) => {
    const go = () => {
      let held = true
      const give = () => { if (!held) return; held = false; const next = queue.shift(); if (next) next(); else free++ }
      if (opts.signal) opts.signal.addEventListener('abort', give, { once: true })
      api.get(name, params, opts).then(resolve, reject).finally(give)
    }
    if (free > 0) { free--; go() } else queue.push(go)
  })
  // the stats read: one at a time, tagged with the window it asked for. A newer one cancels the older; an answer for a window
  // that is no longer s.w, or a cancelled one, is dropped; a failure keeps the last data only when it was this window's
  let statsCtl = null, statsP = null, statsW = null
  const readStats = () => {
    if (statsCtl && statsW === s.w) return statsP // this window's read is already out: wait for it, do not ask twice
    if (statsCtl) statsCtl.abort()
    const ctl = statsCtl = new AbortController(), asked = statsW = s.w
    const p = statsP = slowGet('overview', { since: asked === 'all' ? null : asked }, { signal: ctl.signal }).then((r) => {
      if (ctl.signal.aborted || asked !== s.w) return
      const kept = s.stats.w === asked ? s.stats.data : null
      s.stats = r && r.ok ? { data: r.data, ok: true, err: null, w: asked } : { data: kept, ok: false, err: r || NO_ANSWER, w: kept ? asked : null }
      if (r && r.ok) s.readAt = Date.now()
    }).finally(() => { if (statsCtl === ctl) statsCtl = null })
    return p
  }
  // the slow group's stats step lasts until the latest stats read ends (a window change mid-way replaces it in the same slot)
  const statsSettled = async () => { let p = readStats(); for (;;) { await p.catch(() => {}); if (statsP === p) return { ok: s.stats.ok !== false }; p = statsP } }
  // one poller per query name (core/poll.mjs): its own period, its own back-off; every answer repaints
  const SLOW = {
    classes: () => slowGet('classes').then((r) => fold('classes', r)),
    pricing: () => slowGet('pricing').then((r) => fold('pricing', r)),
    overview: statsSettled,
    segments: () => slowGet('segments').then((r) => fold('segments', r)),
    traffic: () => slowGet('traffic', { since: '24h' }).then((r) => fold('traffic', r)),
  }
  const jobs = { status: [readHealth, INTERVAL.status], sessions: [readSessions, INTERVAL.sessions], ...Object.fromEntries(Object.entries(SLOW).map(([k, f]) => [k, [f, INTERVAL.other]])) }
  const polls = Object.fromEntries(Object.entries(jobs).map(([name, [read, base]]) =>
    [name, startPoll({ base, run: () => Promise.resolve().then(read).finally(render) })]))
  // a 重试 names its group: `health`, `sessions`, or `slow` (every 「其余」 read)
  const GROUP = { health: ['status'], sessions: ['sessions'], slow: Object.keys(SLOW) }
  const onClick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-act="retry"]') : null
    if (!b) return
    for (const name of GROUP[b.dataset.g] || []) polls[name].poll()
  }
  el.addEventListener('click', onClick)
  const offCtl = wireHarnessControls(el, {
    api, state: s.ui, ask: (opts) => confirmDialog(opts, el.ownerDocument),
    onDone: (out) => { if (out && out.status === 405) readControl(); render(true); polls.status.poll() },
  })
  render() // drawn at once: every card says 读取中 until its first answer (1.5 覆盖)

  return {
    update(route) {
      const nw = parseWindow(route && route.params && route.params.window)
      if (nw === s.w) return render()
      s.w = nw; render() // the tab moves before any answer
      readStats().catch(() => {}).finally(render)
    },
    unmount() {
      dead = true
      for (const p of Object.values(polls)) p.stop()
      el.removeEventListener('click', onClick)
      offCtl()
      el.replaceChildren()
    },
  }
}
