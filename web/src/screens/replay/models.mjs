// screens/replay/models.mjs — the replay desk's session head (1.2 §会话头), step head (2.2 §步头) and scope (1.3) as data.
// Framework-free (D75②): no DOM, no timers, no HTML. Each function reads the controller's state object `s` (replay.mjs openDesk:
// desk, meta, lanes, anchor, playhead, playRid, view, sawView, problems, pricing, diffRef, follow, staleErr, gap, reviewRange) and
// returns plain data; DeskHead / StepHead / Scope only render it. Every word comes from labels/replay.mjs; every number from
// core/metrics.mjs; a step number only through lanes.mjs : stepRef(). One answer's work is bounded by the window plus at most 240
// overview points (2.3 §归约前沿): nothing here walks the whole lane, except info() and the popover rows, which run when opened.
import { fmtWhen, fmtStamp, fmtUp, fmtTime, usd, kf, bytes } from '../../../legacy/core/fmt.mjs'
import { harnessKey, harnessName, harnessRaw, harnessIconUrl } from '../../../legacy/core/chips.mjs'
import { cacheState, isFailed, breakCost, usageOf, priceMatch, costOf, hitTier } from '../../../legacy/core/metrics.mjs'
import { CT_ORDER, segTax, TAX_ORDER, hasChangeLine, callFacts, refRowOf } from '../../../legacy/replay/analysis.mjs'
import { stepRef, stepsOf } from '../../../legacy/replay/lanes.mjs'
import { stepOf, askOrdinal, ridAt } from '../../../legacy/replay/model.mjs'
import { windowOf, roughWindow, chapterHere, chapterAt, chapterJump, problemSteps, OVW_BARCAP } from '../../../legacy/replay/timeline.mjs'
import { cacheLabel, costLabel, contentRefOf, contentRefKOf, priceStateNote } from '../../../legacy/replay/stepbar.mjs'
import { totalsOf } from '../../../legacy/replay/header.mjs'
import { FLAG, cellsOf } from '../../../../src/view/head-cols.mjs'
import { ENTRY, ENTRY_TIP } from '../../../legacy/labels/library.mjs'
import * as W from '../../../legacy/labels/replay.mjs'

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k)
const modelOf = (c) => (c && c.rec && c.rec.request && c.rec.request.model) || null
const errMsgOf = (c) => { const e = c && c.error; return !e ? '' : typeof e === 'string' ? e : (e.message || e.msg || c.errMsg || '') }
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const OVW_POINTS = 240 // the overview's most points (1.3 §overview)
const PROBES = 4 // values read per overview point when a point covers many steps: the strip is a sampled map there
const FAIL_H = 20 / 72, MIN_H = 3 / 72, FLAG_NONE_H = 0.55 // a failed step's fixed low bar; the least bar; a flag whose extra cost is unknown

// the row under the playhead; null on the rough page (2.3 §大致页面: the playhead stands on no row yet)
const rowAt = (s) => (s.anchor && s.playRid != null ? s.anchor.calls[s.playhead] || null : null)
// the rough page's step (0-based): the named step, else the last one (replay.mjs renderRough)
const roughAt = (s) => { const h = s.desk && s.desk.head; return h && h.steps ? Math.max(0, Math.min(h.steps, s.initialStep ?? h.steps) - 1) : null }
const flatOf = (s, c) => (s.desk && c ? stepOf(s.desk, c.rid).flat : null)
const localNo = (s, c) => { const r = c && stepRef(s.lanes, c.rid); return r ? (r.step ? r.n : r.k) : null }
// cell c of a head's `cols` (3 bytes = 4 base64 characters, so one cell decodes alone): [height, bucket << 4 | share, flags]
const cellAt = (cols, c) => cellsOf(String(cols || '').slice(4 * c, 4 * c + 4))
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
      sourceTip: meta.title == null ? W.TITLE_UNTITLED_TIP : meta.title_source === 'wire' ? W.TITLE_FROM_WIRE : W.TITLE_FROM_META },
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

