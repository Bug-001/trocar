// screens/replay/models.mjs — the replay desk's session head (1.2 §会话头), step head (2.2 §步头) and scope (1.3) as data.
// Framework-free (D75②): no DOM, no timers, no HTML. Each function reads the controller's state object `s` (replay.mjs openDesk:
// desk, meta, lanes, anchor, playhead, playRid, span, sawView, problems, pricing, diffRef, follow, staleErr, gap, reviewRange) and
// returns plain data; DeskHead / StepHead / Scope only render it. Every word comes from labels/replay.mjs; every number from
// core/metrics.mjs; a step number only through lanes.mjs : stepRef(). One answer's work is bounded by the window plus at most 240
// overview points (2.3 §归约前沿): nothing here walks the whole lane, except info() and the popover rows, which run when opened.
import { fmtWhen, fmtStamp, fmtUp, fmtTime, usd, kf, bytes } from '../../../legacy/core/fmt.mjs'
import { harnessKey, harnessName, harnessRaw, harnessIconUrl } from '../../../legacy/core/chips.mjs'
import { cacheState, isFailed, breakCost, usageOf, priceMatch, costOf, hitTier } from '../../../legacy/core/metrics.mjs'
import { CT_ORDER, segTax, TAX_ORDER, hasChangeLine, callFacts, refRowOf } from '../../../legacy/replay/analysis.mjs'
import { stepRef, stepsOf } from '../../../legacy/replay/lanes.mjs'
import { stepOf, askOrdinal, ridAt } from '../../../legacy/replay/model.mjs'
import { chapterAt, chapterJump, problemSteps, landing, OVW_BARCAP, BAR_KEYS } from '../../../legacy/replay/timeline.mjs'
import { cacheLabel, costLabel, contentRefOf, contentRefKOf, priceStateNote } from '../../../legacy/replay/stepbar.mjs'
import { totalsOf } from '../../../legacy/replay/header.mjs'
import { FLAG, cellsOf } from '../../../../src/view/head-cols.mjs'
import { ENTRY, ENTRY_TIP } from '../../../legacy/labels/library.mjs'
import { stepCount, partsOf, stepAt, placeSpan } from './strip.mjs'
import * as W from '../../../legacy/labels/replay.mjs'

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k)
const modelOf = (c) => (c && c.rec && c.rec.request && c.rec.request.model) || null
const errMsgOf = (c) => { const e = c && c.error; return !e ? '' : typeof e === 'string' ? e : (e.message || e.msg || c.errMsg || '') }
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const CT_WORD = Object.fromEntries(BAR_KEYS) // a content type's word in the legend; image and other are their own words
const OVW_POINTS = 240 // the overview's most points (1.3 §overview)
const PROBES = 4 // values read per overview point when a point covers many steps: the strip is a sampled map there
const FAIL_H = 20 / 72, MIN_H = 3 / 72, FLAG_NONE_H = 0.55 // a failed step's fixed low bar; the least bar; a flag whose extra cost is unknown

// the row under the playhead; null on the rough page (2.3 §大致页面: the playhead stands on no row yet)
const rowAt = (s) => (s.anchor && s.playRid != null ? s.anchor.calls[s.playhead] || null : null)
// the rough page's step (0-based): the named step, else the last one (replay.mjs renderRough)
const roughAt = (s) => { const h = s.desk && s.desk.head; return h && h.steps ? Math.max(0, Math.min(h.steps, s.initialStep ?? h.steps) - 1) : null }
const flatOf = (s, c) => (s.desk && c ? stepOf(s.desk, c.rid).flat : null)
const localNo = (s, c) => { const r = c && stepRef(s.lanes, c.rid); return r ? (r.step ? r.n : r.k) : null }
// a head's `cols` decoded once per head (3 bytes a cell: height, bucket << 4 | share, flags)
const COLS = new WeakMap()
function colsOf(head) {
  let c = COLS.get(head)
  if (!c) COLS.set(head, c = cellsOf(head.cols))
  return c
}
// the head when its cells and peak are the anchor lane's, the lane its `axis` names
const axisHead = (s) => { const h = s.desk && s.desk.head; return h && (!s.anchor || s.anchor.id === h.axis) ? h : null }
const peakOf = (s, axis) => Math.max(1, (s.anchor && s.anchor.peakCtx) || 0, (axis && axis.peak) || 0)
// a tier-0 head and no row under the playhead: there are calls by time and no steps (1.5 K-31)
const timeOnly = (s) => { const h = s.desk && s.desk.head; return !rowAt(s) && !!h && !!h.steps && !h.tier }
// step g → its row, null where it is not here yet
function stepRows(s) {
  const desk = s.desk, key = s.anchor ? s.anchor.id : desk.head.axis
  return (g) => { const rid = ridAt(desk, key, g); return rid != null ? desk.rows.get(rid) ?? null : null }
}
// head → (step g → the bytes of the cell that holds it, null where the head covers no such step)
function cellOf(head) {
  const cells = head ? colsOf(head) : [], per = (head && head.bucket) || 1
  return (g) => { const j = 3 * Math.floor(g / per); return j + 2 < cells.length ? [cells[j], cells[j + 1], cells[j + 2]] : null }
}
// the global step of calls[i]
const stepOfRow = (a, i) => (a.no ? a.no(i) : i)
// a skeleton row's `comp` as [[type, share]] in CT_ORDER, zero types left out; null without one
function compShares(comp) {
  if (!comp) return null
  const tot = CT_ORDER.reduce((a, k) => a + (comp[k] || 0), 0)
  return tot > 0 ? CT_ORDER.filter((k) => comp[k] > 0).map((k) => [k, comp[k] / tot]) : null
}

// ── the session head (1.2 §会话头 · §会话保真行 · §信息弹出层) ─────────────────────────────────────────────────────────
/**
 * @typedef {{kind: 'truncated'|'unknown'|'logged'|'files'|'gap', text: string, href?: string}} Fact
 * @typedef {{key: string, text: string, approx?: boolean}} InfoRow
 * @typedef {{back: {href: string, text: string}, title: {text: string|null, fallback: string|null, sourceTip: string, id: string},
 *   chip: object, entry: {text: string, tip: string}|null, project: {name: string, path: string, word: string}|null,
 *   start: {ts: string, text: string, tip: string}|null, follow: {on: boolean, paused: boolean, text: string, tip: string|null},
 *   read: object|null, stale: {since: any, r: any}|null, facts: {items: Fact[], tech: string[][]}, info: () => InfoRow[]}} SessionHead
 */
/** @returns {SessionHead|null} null while no session answer is here (the head stays empty rather than guessing) */
export function sessionHeadModel(s, { libraryHash = '', now = Date.now() } = {}) {
  const meta = s.meta
  if (!meta) return null
  const head = s.desk && s.desk.head, ch0 = head && head.chapters && head.chapters[0]
  const slugOk = meta.project_slug && meta.project_slug !== '_unresolved'
  const hs = Array.isArray(meta.harnesses) ? meta.harnesses : null // the `sessions` multi-harness field; provider:'mixed' is never this signal (D37 ①)
  const hk = meta.harness != null ? harnessKey(meta.harness) : null
  return {
    back: { href: libraryHash || '#/sessions', text: W.BACK },
    // the title never borrows the id or the start time (the start is its own part)
    title: { text: meta.title ?? null, fallback: meta.title == null ? W.UNTITLED : null, id: meta.session_id || '',
      sourceTip: meta.title == null ? W.TITLE_UNTITLED_NEXT_TIP : W.TITLE_FROM_WIRE }, // a title always comes from the wire (4.4)
    chip: { key: hk, name: harnessName(meta.harness), raw: harnessRaw(meta.harness), icon: harnessIconUrl(meta.harness),
      href: hk ? `#/capture?h=${encodeURIComponent(hk)}` : '#/capture', inferred: !!meta.harness_inferred, synthesized: !!meta.session_synthesized,
      multi: hs && hs.length > 1 ? { text: W.MULTIPLE_AGENTS, tip: W.MULTIPLE_AGENTS_TIP, inferred: hs.some((x) => x && (x.inferred || x.harness_inferred)) } : null },
    entry: has(ENTRY, meta.entrypoint) ? { text: ENTRY[meta.entrypoint], tip: ENTRY_TIP[meta.entrypoint] } : null,
    project: slugOk ? { name: meta.project_path ? String(meta.project_path).split('/').filter(Boolean).pop() : meta.project_slug, path: meta.project_path || '', word: W.PROJECT } : null,
    start: ch0 && ch0.ts0 ? { ts: ch0.ts0, text: fmtWhen(ch0.ts0, now), tip: W.startTip(fmtStamp(ch0.ts0)) } : null,
    follow: { on: !!s.follow, paused: !!s.staleErr, text: W.FOLLOW, tip: s.staleErr ? W.FOLLOW_PAUSED : null },
    read: readOf(s.desk),
    stale: s.staleErr ? { since: s.staleErr.since, r: s.staleErr.r } : null,
    facts: factsOf(s.desk, s.gap, meta.harness),
    info: () => infoRows(s),
  }
}

// 1.2 §会话头 读取状态 · 1.5 K-31 / K-32: words only, never a control
function readOf(desk) {
  const p = desk && desk.pending, b = desk && desk.behind
  if (!p) return b ? { state: 'behind', n: b.n, more: !!b.more, text: W.behindBy(b.n, b.more) } : null
  if (p.stopped) return { state: 'stopped', code: p.stopped.code ?? null, reason: p.stopped.reason ?? null, text: W.FOLD_STOPPED[p.stopped.code] || W.FOLD_STOPPED['fold-failed'] }
  const done = Number(p.done) || 0, total = Number(p.total) || 0
  if (desk.firstPending) { const pct = total > 0 ? Math.floor((done / total) * 100) : 0; return { state: 'reading', pct, text: W.readingFirst(pct) } }
  const n = Math.max(0, total - done)
  return { state: 'catching-up', n, text: W.catchingUp(n) }
}

// 1.2 §会话保真行: each fact in plain words (the row exists iff one does); raw values only as technical-detail pairs
function factsOf(desk, gap, harness) {
  const items = [], tech = []
  if (!desk) return { items, tech }
  const h = harness != null ? `?h=${encodeURIComponent(harnessKey(harness))}` : ''
  const t = desk.truncated, u = desk.unknown, logged = Number(desk.logged) || 0, errs = (desk.errors || []).filter(Boolean)
  if (t) items.push({ kind: 'truncated', text: W.truncFact(t.shown, t.total, t.file_mb) })
  if (u && Number(u.records) > 0) {
    items.push({ kind: 'unknown', text: W.unknownFact(u.records) })
    if (u.reason) tech.push(['reason', u.reason])
    if (u.endpoints && u.endpoints.length) tech.push(['endpoints', u.endpoints.join(', ')])
  }
  if (logged > 0) items.push({ kind: 'logged', text: W.loggedFact(logged), href: `#/settings/storage${h}` })
  const lost = errs.filter((e) => e.level !== 'note').length // a note (a slow index-cold read) is no loss
  if (lost) items.push({ kind: 'files', text: W.filesFact(lost), href: '#/settings/storage' })
  for (const e of errs) tech.push([String(e.where ?? '') + (e.code ? ' · ' + e.code : ''), String(e.reason ?? '')])
  if (gap) items.push({ kind: 'gap', text: W.GAP_FACT, href: `#/capture/log${h}` })
  return { items, tech }
}

// 1.2 §信息弹出层: only statistics, in the table's order; a 0 or absent row is not there. Every number is sessionTotals()'s.
function infoRows(s) {
  const lanes = s.lanes || [], meta = s.meta || {}, desk = s.desk || {}
  const t = totalsOf(s), rows = []
  const c = t.cost.total
  if (c.priced || c.unpriced || c.failed) {
    const some = c.priced > 0
    rows.push({ key: 'cost', approx: true, usd: some ? c.usd : null, text: `${W.COST_LINE} ${some ? usd(c.usd) : '—'}${c.unpriced ? ` ${W.COST_FROM}` : ''}`,
      buckets: ['main', 'sub', 'bg'].map((k) => ({ key: k, word: W.BUCKETS[k], usd: t.cost[k] && t.cost[k].priced ? t.cost[k].usd : null })),
      notes: [c.unpriced ? W.noPriceCalls(c.unpriced) : null, some ? null : W.NO_ANY_PRICE].filter(Boolean), prices: { text: W.SEE_PRICES, href: '#/settings/prices' } })
  }
  const main = lanes.find((l) => l.kind === 'main')
  if (t.hitSteps) {
    const pct = Math.round(t.hit * 100)
    rows.push({ key: 'hit', pct, text: `${W.HIT_LINE} ${pct}%${t.cacheUnknown ? '?' : ''}`, notes: [W.HIT_MAIN_ONLY, t.cacheUnknown ? W.CACHE_SEMANTICS_UNKNOWN : null].filter(Boolean) })
  } else if (main) rows.push({ key: 'hit', pct: null, text: `${W.HIT_LINE} —`, notes: [W.HIT_UNMEASURED] })
  if (t.breaks.length) {
    const bc = t.breakCost, w = bc.worst
    rows.push({ key: 'breaks', n: t.breaks.length, approx: true, usd: bc.counted ? bc.usd : null, text: W.BREAKS_LINE(t.breaks.length),
      notes: [bc.counted ? `${W.BREAK_COST_LINE} ${usd(bc.usd)}` : W.BREAK_COST_NONE, bc.uncomputable ? W.BREAK_COST_SOME(bc.uncomputable) : null].filter(Boolean),
      jump: w ? { i: w.i, text: W.WORST_AT(localNo(s, main.calls[w.i]) ?? w.i + 1) } : null })
  }
  if (t.failed) rows.push({ key: 'failed', n: t.failed, text: W.FAILED_LINE(t.failed), jump: t.firstFailed ? { lane: t.firstFailed.lane.id, i: t.firstFailed.i } : null })
  const steps = stepsOf(lanes), compN = steps.filter((x) => x && x.compaction).length
  if (compN) rows.push({ key: 'compactions', n: compN, text: W.COMPACTION_LINE(compN), notes: steps.some((x) => x && x.compaction && x.compactionInferred) ? [W.GUESS] : [] })
  // full counts; the token-count lane the front end builds (buildLanes) is no background call
  const subN = lanes.filter((l) => l.kind === 'subagent').length
  const bgN = lanes.filter((l) => l.kind !== 'main' && l.kind !== 'subagent' && l.kind !== 'token-count').reduce((n, l) => n + (l.count ?? l.calls.length), 0)
  const probeN = (typeof desk.probes === 'number' ? desk.probes : desk.probes && desk.probes.count) || 0
  if (subN || bgN || probeN) rows.push({ key: 'counts', sub: subN, bg: bgN, probe: probeN, text: [subN && W.COUNTS_LINE.sub(subN), bgN && W.COUNTS_LINE.bg(bgN), probeN && W.COUNTS_LINE.probe(probeN)].filter(Boolean).join(' · ') })
  const stats = rows.length
  // 7: the duration only (the start is on the head), from the main lane header's first … last rows
  const a = main || lanes[0], row = (rid) => (a && rid != null && a.ridLocal && a.ridLocal.has(rid) ? a.calls[a.ridLocal.get(rid)] : null)
  const t0 = a && (row(a.first) || a.calls[0]), t1 = a && (row(a.last) || a.calls.at(-1))
  const ms = t0 && t1 ? Date.parse(t1.ts) - Date.parse(t0.ts) : NaN
  if (Number.isFinite(ms)) rows.push({ key: 'duration', ms, text: `${W.DURATION_WORD} ${fmtUp(ms)}` })
  if (meta.session_id) rows.push({ key: 'id', id: meta.session_id, text: W.SESSION_ID, copy: W.COPY })
  if (meta.project_slug && meta.project_slug !== '_unresolved') rows.push({ key: 'project', narrow: true, text: `${W.PROJECT} ${meta.project_path ? String(meta.project_path).split('/').filter(Boolean).pop() : meta.project_slug}` })
  if (!stats) rows.push({ key: 'calls', n: meta.calls || 0, text: W.MODEL_CALLS(meta.calls || 0) }) // nothing to count: never blank
  if (desk.truncated) rows.unshift({ key: 'truncated', text: W.TRUNCATED_NOTE(desk.truncated.shown) })
  return rows
}

// ── the step head (2.2 §步头) ─────────────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {{rough: true, n: number, m: number, label: string}} RoughStepHead
 * @typedef {{rough: false, n: number|null, k: number|null, m: number, laneWord: string|null, label: string, model: string|null,
 *   ts: string|null, time: string, half: {tip: string|null}|null, compare: {sel: number|null, cacheRefK: number|null, M: number}|null,
 *   ctx: {word: string, value: number|null, comp: Array<[string, number]>|null}, cache: {word: string, label: string},
 *   cost: {word: string, label: string}, cacheRows: () => object[], compRows: () => object[]|'busy', costRows: () => object[]}} StepHead
 */
/** @returns {StepHead|RoughStepHead|null} */
export function stepHeadModel(s) {
  const call = rowAt(s)
  if (!call) {
    const at = roughAt(s), h = s.desk && s.desk.head
    return at != null && h.tier ? { rough: true, n: at + 1, m: h.steps, label: W.stepNo(at + 1, h.steps) } : null
  }
  const main = s.anchor.kind === 'main', r = stepRef(s.lanes, call.rid)
  const no = r ? (r.step ? r.n : r.k) : s.playhead + 1, m = r ? r.m : s.anchor.calls.length
  const ref = refRowOf(s.anchor, s.playhead), fid = callFacts(call), model = modelOf(call)
  return {
    rough: false, n: main ? no : null, k: main ? null : no, m, laneWord: main ? null : W.laneWord(s.anchor.kind),
    label: main ? W.stepNo(no, m) : W.callNo(W.laneWord(s.anchor.kind), no, m),
    model, ts: call.ts || null, time: fmtTime(call.ts) || '—',
    half: fid.facts.length ? { tip: fid.tech.map((p) => p[1]).filter(Boolean).join('\n') || null } : null,
    compare: main ? { sel: s.diffRef != null && s.anchor.calls[s.diffRef] ? localNo(s, s.anchor.calls[s.diffRef]) : null, cacheRefK: ref ? localNo(s, ref) : null, M: m } : null,
    ctx: { word: W.CTX_BTN, value: call.unparsed || !call.rec ? null : (call.ctx ?? null), comp: compShares(call.comp) },
    cache: { word: W.CACHE_TITLE, label: cacheLabel(call) },
    cost: { word: W.COST_BTN, label: costLabel(call, s.pricing) },
    cacheRows: () => cacheRows(s, call, ref, model),
    compRows: () => compRows(s, call),
    costRows: () => costRows(s, call, model),
  }
}

// the 缓存 popover (2.2 §「缓存」按钮): the state sentence, then only the rows that apply
function cacheRows(s, call, ref, model) {
  const st = cacheState(call, ref), u = usageOf(call), b = call.cacheBreak || {}
  const rows = [{ key: 'sentence', struct: W.isStructState(st), structTip: W.STRUCT_TIP, text: W.cacheSentence(st, {
    laneW: W.laneWord(s.anchor.kind), causeW: W.causeWord(b.cause), attrW: W.ATTR_WORD[b.attribution], hitPct: st.hit != null ? Math.round(st.hit * 100) : null,
    warm: st.warm, inferred: !!call.compactionInferred, errMsg: errMsgOf(call), zeroInput: st.zeroInput }) }]
  if (u && st.state !== 'failed' && st.state !== 'no-usage') {
    rows.push({ key: 'usage', unit: W.TOKENS_WORD, items: ['read', 'create', 'fresh', 'out'].map((k) => ({ key: k, word: W.USAGE_WORD[k], n: u[k] ?? null, text: u[k] == null ? '—' : kf(u[k]), tip: u[k] == null ? W.USAGE_NULL_TIP : null })) })
  }
  if (st.isBreak) {
    const bc = breakCost(call, ref, s.pricing ? priceMatch(s.pricing, model) : null)
    rows.push({ key: 'extra', approx: true, usd: bc.usd, text: bc.usd != null ? `${W.BREAK_COST_LINE} ${usd(bc.usd)}` : (W.BREAK_COST_WHY[bc.why] || W.BREAK_COST_WHY['no-ref']) })
  }
  if (hasChangeLine(call, flatOf(s, call))) rows.push({ key: 'jump', text: W.JUMP_TO_CHANGE })
  if (call.wire && call.wire.cacheSemanticsKnown === false) rows.push({ key: 'unknown', text: W.CACHE_SEMANTICS_UNKNOWN })
  return rows
}

// the 组成 popover (2.2 §「组成」按钮): 'busy' while this step's lane is not held (a sized empty row, no words, no control)
function compRows(s, call) {
  if (!call.rec) return [{ key: 'none', text: W.COMP_SELF.none }]
  if (call.unparsed) return [{ key: 'unparsed', text: W.COMP_SELF.unparsed }]
  const flat = flatOf(s, call)
  if (!flat) return 'busy'
  const tax = segTax(flat)
  const rows = [{ key: 'size', bytes: tax.total, text: W.compSize(bytes(tax.total)) }, { key: 'calibre', text: W.COMP_CALIBRE },
    { key: 'segs', items: TAX_ORDER.map((k) => ({ key: k, word: W.SEG_NAME[k], pct: tax.pct(k), text: `${W.SEG_NAME[k]} ${tax.pct(k)}%`, tip: `${bytes(tax.seg[k])} · ≈ ${kf(tax.est(k))} ${W.TOKENS_WORD}` })) },
    { key: 'culprit', seg: tax.culprit, text: W.compCulprit(tax.culprit, tax.pct(tax.culprit)) }]
  if (!tax.allVerbatim) rows.push({ key: 'tools-estimated', text: W.TOOLS_ESTIMATED })
  // growth only against a real 内容对比步; a compaction step whose content ref IS the cache ref is a rewrite, not a Δ
  if (call.cacheBreak && call.cacheBreak.cause === 'compaction' && s.diffRef == null) return [...rows, { key: 'compaction', text: W.COMPACTION_REWRITE }]
  const cref = contentRefOf(s)
  if (!cref) return rows
  const refFlat = flatOf(s, cref)
  if (!refFlat) return [...rows, { key: 'growth', busy: true }]
  const prev = segTax(refFlat), d = tax.total - prev.total, refK = contentRefKOf(s)
  const dom = TAX_ORDER.map((k) => ({ k, d: tax.seg[k] - prev.seg[k] })).reduce((a, x) => (Math.abs(x.d) > Math.abs(a.d) ? x : a), { k: 'tools', d: 0 })
  const segW = dom.d ? W.SEG_NAME[dom.k] : '', less = d < 0
  return [...rows, { key: 'growth', delta: d, seg: dom.d ? dom.k : null, refK, text: refK != null ? W.growthVs(refK, bytes(Math.abs(d)), segW, less) : W.growthLine(bytes(Math.abs(d)), segW, less) },
    { key: 'diagnose', text: W.DIAGNOSE_ONLY }]
}

// the ≈ $ popover (2.2 §「≈ $」按钮): the calibre sentence always; one reason when the button says ≈ —
function costRows(s, call, model) {
  const u = usageOf(call), table = s.pricing, m = u && table ? priceMatch(table, model) : null
  const rows = [{ key: 'calibre', text: W.COST_CALIBRE }]
  if (m && m.exact === false) rows.push({ key: 'by-key', text: W.PRICE_BY_KEY(m.key) })
  if (!m) {
    const why = isFailed(call) ? W.COST_WHY.failed : !u ? W.COST_WHY['no-usage'] : !table ? (s.pricingErr ? priceStateNote(table, s.pricingErr) : W.PRICES_LOADING) : W.COST_WHY['no-price']
    rows.push({ key: 'why', text: why })
  }
  rows.push({ key: 'prices', text: W.SEE_PRICES, href: '#/settings/prices' })
  return rows
}

// ── the scope (1.3): the window's steps, the chapter row, the overview and its brush ─────────────────────────────────
/**
 * @typedef {{rid?: string, i?: number, g: number, col: number, h: number, segs: Array<[string, number]>|null, hatched: boolean, fail: boolean,
 *   compact: boolean, cur: boolean, reviewed: boolean, tip: string}} Bar
 * @typedef {{rid?: string, col: number, state: 'high'|'mid'|'low'|'none'|'unk'|'fail'|'gap', pct?: number|null, tip: string}} TraceCell
 * @typedef {{view: {lo: number, hi: number, N: number}, at: number|null, rough: boolean, legend: object, chapters: object|null, problems: object|null,
 *   bars: Bar[], peak: {text: string, tip: string|null}, trace: TraceCell[], asks: object|null, review: {width: number, tip: string}|null,
 *   part?: number, box?: {lo: number, hi: number}|null, axis: {start: string, end: string}|null, gutter: Array<{ct: string, pct: number, share: string}>,
 *   gutterTip?: string|null, cursor: {col: number|null}}} Scope
 */
/**
 * One path, rows held or not (1.3 acceptance 23): the bars are the steps of s.span, global, in any part. A held row draws as itself; any
 * other step draws its head cell (the cell that holds it when `bucket` > 1), and the rows' tracks stay empty there until it is here.
 * @returns {Scope|null} `K` = the bars the row can draw (timeline.mjs barsThatFit); it shapes the window until s.span is placed
 */
export function scopeModel(s, K) {
  const desk = s.desk, head = desk && desk.head, a = s.anchor, rows = !!a && a.calls.length > 0, pc = rowAt(s), rough = !pc
  if (!rows && !(head && head.steps)) return null
  if (timeOnly(s)) return timeScope(head)
  const N = stepCount(s), parts = partsOf(s), at = stepAt(s), { lo, hi } = s.span ?? placeSpan(null, at, parts, K), part = chapterAt(parts, lo)
  const main = !a || a.kind === 'main', cost = s.sawView === 'cost' && !rough
  const axis = axisHead(s), pk = peakOf(s, axis)
  const rk = a && s.reviewRange && s.reviewRange.k != null ? s.reviewRange.k : null, gk = rk == null ? null : rk > 0 ? stepOfRow(a, rk - 1) + 1 : 0
  const cell = cellOf(axis)
  const rowOf = stepRows(s)
  const priceOf = (c) => (s.pricing ? priceMatch(s.pricing, modelOf(c)) : null)
  const steps = []
  for (let g = lo; g < hi; g++) { const row = rowOf(g); steps.push({ g, row, i: row && a ? a.ridLocal.get(row.rid) : undefined }) }
  // the main track: context bars (h ∝ ctx / the session's peak) or cost bars (h ∝ ≈ estimate / the window's largest)
  const costs = cost ? steps.map(({ row: c }) => { if (!c) return null; const u = usageOf(c), m = u && !isFailed(c) ? priceOf(c) : null; return { u, m, v: m ? costOf(m.row, u) : null } }) : null
  const maxCost = cost ? Math.max(0, ...costs.map((x) => x?.v ?? 0)) : 0
  const bars = steps.map(({ g, row: c, i }, col) => {
    const b = { rid: c ? c.rid : undefined, i, g, col, h: 0, segs: null, hatched: false, fail: false, compact: false, cur: g === at, reviewed: gk != null && g < gk, tip: W.barTip(main, g + 1, '') }
    if (!c) {
      const x = cost ? null : cell(g)
      if (!x) return b // no cost is known without the row, and it is not unknowable either: an empty column
      const fail = !!(x[2] & FLAG.failed)
      return Object.assign(b, { fail, compact: !!(x[2] & FLAG.compaction), h: fail ? FAIL_H : Math.max(MIN_H, x[0] / 255), segs: fail ? null : [[CT_ORDER[x[1] >> 4] || 'other', 1]] })
    }
    b.fail = isFailed(c); b.compact = !!c.compaction
    if (b.fail) Object.assign(b, { h: FAIL_H, tip: W.barTip(main, g + 1, W.failTip(g + 1, errMsgOf(c))) })
    else if (cost) {
      const x = costs[col]
      if (x.v == null) Object.assign(b, { hatched: true, tip: W.barTip(main, g + 1, !x.u ? W.CACHE_CELL_NONE_TIP : W.COST_WHY['no-price']) })
      else Object.assign(b, { h: Math.max(MIN_H, x.v / Math.max(1e-9, maxCost)), tip: W.barTip(main, g + 1, W.approxUsd(usd(x.v)) + (x.m.exact ? '' : ` · ${W.PRICE_BY_KEY(x.m.key)}`)) })
    } else {
      b.h = Math.max(MIN_H, Math.min(1, (c.ctx || 0) / pk)); b.segs = compShares(c.comp); b.hatched = !b.segs
      b.tip = W.barTip(main, g + 1, b.hatched ? W.COMP_NOT_COMPUTED : W.peakCtx(kf(c.ctx)))
    }
    return b
  })
  const peak = cost ? { text: costs.some((x) => x?.v != null) ? W.approxUsd(usd(maxCost)) : W.COST_NONE, tip: null } : { text: W.peakCtx(kf(pk)), tip: W.PEAK_CTX_TIP }
  const shares = !cost && pc ? compShares(pc.comp) : null
  return {
    view: { lo, hi, N }, at, rough,
    legend: { estimate: cost ? W.COST_LEGEND : W.COMP_LEGEND, cache: [W.CACHE_LEGEND, W.CACHE_LEGEND_UNK], range: [lo + 1, hi], rangeText: W.showSteps(lo + 1, hi), sampled: N > OVW_POINTS },
    chapters: chaptersOf(parts, lo), part, box: hi - lo < parts[part].s1 - parts[part].s0 ? { lo, hi } : null,
    problems: rows ? problemsOf(s, bars) : null,
    bars, peak,
    trace: bars.map((b) => (b.i != null ? traceOf(a.calls[b.i], refRowOf(a, b.i), b.col) : { col: b.col, state: 'gap', tip: '' })),
    asks: rows && main ? asksOf(s, bars) : null,
    review: rk != null ? { width: clamp01((gk - lo) / Math.max(1, hi - lo)), tip: W.REVIEW_TIP(rk) } : null,
    axis: { start: W.axisNo(main, lo + 1), end: W.axisNo(main, hi) },
    gutter: shares ? shares.map(([ct, f]) => ({ ct, pct: Math.round(f * 100), share: W.approxShare(Math.round(f * 100)) })) : [],
    // every share with its type's word: the gutter shows the lines its row holds, its hover all of them (1.3 §排布)
    gutterTip: shares ? shares.map(([ct, f]) => `${CT_WORD[ct] || ct} ${W.approxShare(Math.round(f * 100))}`).join(' · ') : null,
    cursor: { col: at >= lo && at < hi ? at - lo : null },
    noMain: main ? null : W.noMainLane(W.laneWord(a.kind)),
  }
}

// a tier-0 head (1.5 K-31): the calls by time, sampled, no bars
function timeScope(head) {
  return { view: { lo: 0, hi: 0, N: head.steps }, at: null, rough: true, chapters: null, problems: null, bars: [], trace: [], asks: null, review: null, axis: null, gutter: [], cursor: { col: null }, noMain: null,
    peak: { text: '', tip: null }, legend: { estimate: W.COMP_LEGEND, cache: [W.CACHE_LEGEND, W.CACHE_LEGEND_UNK], range: null, rangeText: '', sampled: true }, box: null }
}

// one cache-trace cell, drawn by cacheState()'s own order (1.3 §缓存迹线)
function traceOf(c, ref, col) {
  const st = cacheState(c, ref), pct = st.hit != null ? Math.round(st.hit * 100) : null
  if (st.state === 'failed') return { rid: c.rid, col, state: 'fail', pct: null, tip: W.CACHE_CELL_FAILED } // not a miss
  if (st.state === 'no-usage') return { rid: c.rid, col, state: 'none', pct: null, tip: `${W.CACHE_CELL_NONE} · ${W.CACHE_CELL_NONE_TIP}` }
  if (c.wire && c.wire.cacheSemanticsKnown === false) return { rid: c.rid, col, state: 'unk', pct, tip: `${W.cacheCellUnknown(pct)} · ${W.CACHE_SEMANTICS_UNKNOWN}` }
  return { rid: c.rid, col, state: { hi: 'high', mid: 'mid', lo: 'low' }[hitTier(st.hit)], pct, tip: W.cacheCellPct(pct) }
}

// the 问题道 (1.3 §问题道): a flag per break (h ∝ √ ≈ extra cost), × per failed call, a neutral compaction mark; k / n over the
// whole lane from the controller's problem list (problemSteps, computed when the anchor changes)
function problemsOf(s, bars) {
  const a = s.anchor, probs = s.problems || problemSteps(a), items = [], flags = []
  for (const { i, g, col } of bars) {
    if (i == null) continue
    const c = a.calls[i], n = g + 1, base = { rid: c.rid, i, col }
    if (isFailed(c)) { const tip = W.failTip(n, errMsgOf(c)); items.push({ ...base, kind: 'x', h: null, tip, aria: tip }); continue }
    if (c.compaction) { const tip = `${W.COMPACT_WORD}${c.compactionInferred ? ' · ' + W.GUESS : ''} — ${W.compactTip(n, c.compactionInferred)}`; items.push({ ...base, kind: 'compact', h: null, tip, aria: tip }); continue }
    if (landing(c)) continue
    const ref = refRowOf(a, i), st = cacheState(c, ref)
    if (!st.isBreak) continue
    const it = { ...base, n, kind: 'flag', h: null, tip: '', aria: '', usd: breakCost(c, ref, s.pricing ? priceMatch(s.pricing, modelOf(c)) : null).usd, struct: st.state === 'changed' }
    items.push(it); flags.push(it)
  }
  const max = Math.max(0, ...flags.map((f) => f.usd ?? 0))
  for (const f of flags) {
    f.h = f.usd == null ? FLAG_NONE_H : Math.sqrt(f.usd / Math.max(1e-9, max))
    f.tip = f.aria = W.breakFlagTip(f.n, f.usd == null ? W.BREAK_COST_NONE : `${W.BREAK_COST_LINE} ${usd(f.usd)}`, f.struct)
    delete f.usd; delete f.struct; delete f.n
  }
  let at = -1, l = 0, r = probs.length - 1 // binary search: the lane's problem list is in step order
  while (l <= r) { const m = (l + r) >> 1; if (probs[m] === s.playhead) { at = m; break } if (probs[m] < s.playhead) l = m + 1; else r = m - 1 }
  return { k: at >= 0 ? at + 1 : null, n: probs.length, name: W.problemPager(at >= 0 ? at + 1 : null, probs.length), items }
}

// the chapter row (1.3 §章): the part step `g` is in (the window's: the label says what the bars show): k / n, the steps a–b, inferred,
// where ‹ / › land (null at the ends: disabled, not hidden)
function chaptersOf(chs, g) {
  const k = chapterAt(chs, g), c = chs[k], b = c.s1
  return { k: k + 1, n: chs.length, a: c.s0 + 1, b, inferred: !!c.inferred, prev: chapterJump(chs, g, -1), next: chapterJump(chs, g, 1),
    label: W.chapterLabel(k + 1, chs.length, c.s0 + 1, b, !!c.inferred), prevTip: W.CHAPTER_PREV, nextTip: W.CHAPTER_NEXT }
}

// the 提问刻度 (1.3 §提问刻度): ticks from the skeleton's user events on the window's rows; K and P are the server's `k`, never a count
function asksOf(s, bars) {
  const a = s.anchor, desk = s.desk
  if (!desk || !(a.events || []).some((e) => e && e.type === 'user')) return null // no prompt events: no row, no name
  const held = desk.held.get(a.id), ticks = []
  for (const { i, col } of bars) {
    if (i == null) continue
    const rid = a.calls[i].rid
    if (!(desk.events.get(rid) || []).some((e) => e.type === 'user')) continue
    const evs = held && held.events.get(rid) ? held.events.get(rid).filter((e) => e.type === 'user' && e.k != null) : []
    ticks.push({ rid, i, col, tip: evs.length ? evs.map((e) => W.askScaleTip(e.k, e.preview || '')).join('\n') : W.askScaleStepTip(stepRef(s.lanes, rid)) })
  }
  const k0 = askOrdinal(desk, a.id, a.calls[s.playhead].rid), k = k0 >= 1 ? k0 : null, p = askTotal(desk)
  return { k, p, name: W.askRowName(k, p), ticks }
}
// P: the largest user `k` on the steps of the head's last cell flagged 提问, when every one of them is held; else null
function askTotal(desk) {
  const head = desk.head
  if (!head || !head.cols || head.axis == null) return null
  const h = desk.held.get(head.axis), per = head.bucket || 1, cells = colsOf(head)
  if (!h) return null
  for (let c = Math.floor(cells.length / 3) - 1; c >= 0; c--) {
    if (!(cells[3 * c + 2] & FLAG.user)) continue
    let p = null
    for (let g = c * per; g < Math.min(head.steps, (c + 1) * per); g++) {
      const rid = ridAt(desk, head.axis, g)
      if (rid == null || !h.steps.has(rid)) return null
      for (const e of h.events.get(rid) || []) if (e.type === 'user' && e.k != null && (p == null || e.k > p)) p = e.k
    }
    return p
  }
  return null
}

/**
 * The strip's data (1.3 §概览条): the terrain and the parts, read when the overview paints, not per paint of the bars. A step's value is
 * its head cell where the head covers it, else its row, so rows arriving change nothing. ≤ 60 steps one bar each, ≤ 240 one point each,
 * more ≤ 240 points each over a bucket of steps (sampled, and only then said). A mark's `g` is the step at its middle. A tier-0 head has
 * calls by time and no steps: `g` is the time bucket.
 * @returns {{mode: 'bars'|'line'|'buckets'|'time', sampled: boolean, marks: Array<{g: number, v: number, failed: boolean}>, parts: Array<{s0: number, s1: number}>}|null}
 */
export function overviewModel(s) {
  const head = s.desk && s.desk.head
  if (!(s.anchor && s.anchor.calls.length) && !(head && head.steps)) return null
  if (timeOnly(s)) {
    const bs = head.buckets || [], mx = Math.max(1, ...bs.map((b) => b.calls))
    return { mode: 'time', sampled: true, marks: bs.map((b, g) => ({ g, v: b.calls / mx, failed: false })), parts: [] }
  }
  const N = stepCount(s), axis = axisHead(s), pk = peakOf(s, axis), cell = cellOf(axis), rowOf = stepRows(s)
  const val = (g) => { const x = cell(g); if (x) return x[0] / 255; const r = rowOf(g); return r ? (r.ctx || 0) / pk : 0 }
  const failed = (g) => { const x = cell(g); if (x) return !!(x[2] & FLAG.failed); const r = rowOf(g); return !!r && isFailed(r) }
  const B = Math.min(N, OVW_POINTS), marks = []
  for (let p = 0; p < B; p++) {
    const lo = Math.floor((p * N) / B), hi = Math.max(lo + 1, Math.floor(((p + 1) * N) / B)), step = Math.max(1, Math.ceil((hi - lo) / PROBES))
    let v = 0, f = false
    for (let j = lo; j < hi && j < N; j += step) { v = Math.max(v, val(j)); f ||= failed(j) }
    marks.push({ g: (lo + hi - 1) / 2, v: clamp01(v), failed: f })
  }
  return { mode: N <= OVW_BARCAP ? 'bars' : N > B ? 'buckets' : 'line', sampled: N > B, marks, parts: partsOf(s) }
}
