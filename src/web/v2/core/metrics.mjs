// core/metrics.mjs — the board's numbers, in ONE place: cache hit, the cache predicate (what state a step is in and whether it is a
// break), the cost of a break, cost per lane bucket, and the totals a session shows. The step bar, the session popover, the trace's
// 问题道 and the 总览 page all read these functions and no other, so two surfaces cannot disagree about whether a step broke the
// cache or what the session cost (2.2 · plan P2.4–P2.5). Pure: no DOM, no window, no wire names. A step is one entry of
// /api/session `analyzed.steps` — {usage, cacheBreak, gt, error, status, rec, wire, probe}; a lane is {kind, calls}.
//
// Unknown stays unknown (invariant 4): a missing usage is null, never a zero hit; an unpriceable cost is null with its reason, never
// $0. The words for the states (「缓存断开」, 「复用了前面的缓存」 …) live in labels/replay.mjs, not here: this file returns codes.

import { laneKind } from '../labels/replay.mjs'

// ── usage ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// A step's usage as the neutral {read, create, fresh, out}, or null when the wire returned none. `create` is null when the vendor
// reports no cache-write counter (S2); it is never turned into a zero here. Before S2 the server sends zeros for a call without
// usage, so an empty raw `norm.usage` is read as "none" too.
export function usageOf(c) {
  if (!c || c.usage === null) return null
  const raw = c.norm && c.norm.usage
  if (c.norm && 'usage' in c.norm && (raw == null || (typeof raw === 'object' && Object.keys(raw).length === 0))) return null
  return c.usage && typeof c.usage === 'object' ? c.usage : null
}

// read / (read + create + fresh); null when there is no usage or nothing was measured. create:null counts as 0 in the denominator.
export function hitRatio(u) {
  if (!u) return null
  const tot = (u.read || 0) + (u.create || 0) + (u.fresh || 0)
  return tot > 0 ? (u.read || 0) / tot : null
}
export function hitPct(u) { const r = hitRatio(u); return r == null ? null : Math.round(r * 100) }
export const hitTier = (r) => (r >= 0.7 ? 'hi' : r >= 0.3 ? 'mid' : 'lo')
const LOW_HIT = 0.3

// ── the cache predicate ─────────────────────────────────────────────────────────────────────────────────────────────
// The causes that say nothing changed in the cache prefix. ONE list: the predicate below and the 变化线 in the context window both
// read it, so "the trace flags this step" and "the window says the prefix changed" can never disagree.
export const QUIET_CAUSES = new Set(['append', 'first-call', 'volatile-nonce-only'])

export const CACHE_STATES = Object.freeze(['failed', 'no-usage', 'first', 'ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit', 'reused', 'unjudged'])
const BREAK_STATES = new Set(['ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit'])

// the call failed: the row's `error` is the call-row failed verdict (3.5 §访问模式 ②, failedOf)
export const isFailed = (c) => !!c && !!c.error
const gtOf = (c) => (c.gt !== undefined ? c.gt : (c.cacheBreak && c.cacheBreak.gt) || null)

// The 缓存对比步 of calls[i]: the nearest earlier call of the same list that did not fail (a failed call never established a cache
// prefix, so the server compares the next call with the one before it). null when there is none. Until the server names it
// (cacheBreak.refGi, S12) the front end applies this same rule.
export function refOf(calls, i) {
  for (let k = i - 1; k >= 0; k--) if (!isFailed(calls[k])) return calls[k]
  return null
}

// What state a step is in. Evaluated in this order; the first match wins (plan P2.4):
//   failed · no-usage · first · ttl-rebuild · provider-contradiction · changed · low-hit · reused
// `unjudged` is the one addition: the step's request was never captured, so there is no comparison to read a cause from — the step
// is neither a break nor "reused". `ref` is the 缓存对比步 (see refOf); the verdict itself is the server's (cacheBreak, gt), computed
// against it, so `ref` only names the step the answer is about — breakCost is where it is read.
//   → { state, isBreak, cause, hit, warm, quiet }
//      hit    the step's hit ratio, null for failed / no-usage
//      warm   first only: the first call already read from a warm prefix (read > 0)
//      quiet  reused only: 'append' | 'volatile-nonce-only'
export function cacheState(step, ref = null) {
  void ref
  const mk = (state, extra = {}) => ({ state, isBreak: BREAK_STATES.has(state), cause: (step && step.cacheBreak && step.cacheBreak.cause) || null, hit: null, warm: false, quiet: null, ...extra })
  if (isFailed(step)) return mk('failed')
  const u = usageOf(step)
  const hit = u ? hitRatio(u) : null
  // a usage whose input counters are all zero (read + create + fresh = 0, so hitRatio() is null) is the same state: nothing
  // was measured, and the sentence says so in its own words (2.2 table row 2's second half) — never a 0% hit
  if (!u || hit == null) return mk('no-usage', { zeroInput: !!u })
  const b = step.cacheBreak
  if (!b) return mk('unjudged', { hit })
  if (b.firstCall || b.cause === 'first-call') return mk('first', { hit, warm: (u.read || 0) > 0 })
  const gt = gtOf(step)
  if (gt === 'ttl-rebuild') return mk('ttl-rebuild', { hit })
  if (gt === 'provider-contradiction') return mk('provider-contradiction', { hit })
  if (b.cause && !QUIET_CAUSES.has(b.cause)) return mk('changed', { hit })
  if (hit != null && hit < LOW_HIT) return mk('low-hit', { hit })
  return mk('reused', { hit, quiet: b.cause === 'volatile-nonce-only' ? 'volatile-nonce-only' : 'append' })
}
export const isBreak = (step, ref = null) => cacheState(step, ref).isBreak

// local indices of the steps that broke the cache, each judged against its own 缓存对比步 (what the old breakSteps() answered)
export function breakSteps(calls) {
  const out = []
  ;(calls || []).forEach((c, i) => { if (isBreak(c, refOf(calls, i))) out.push(i) })
  return out
}

// ── what a break cost ───────────────────────────────────────────────────────────────────────────────────────────────
const num = (v) => typeof v === 'number' && Number.isFinite(v)
const rowOf = (p) => { const r = Array.isArray(p) ? p : p && p.row; return Array.isArray(r) && r.length === 4 && r.every(num) ? r : null }
// ≈ 多花: the tokens the 缓存对比步 had cached (its read + create) that this step did not read, priced as the difference between
// what it paid and what a cache read would have cost. Price row = [input, output, cache-write, cache-read] $ per Mtok.
//   missed = max(0, (ref.read + ref.create) − step.read)
//   unit   = (step.create is a number ? cache-write price : uncached-input price) − cache-read price
//   usd    = missed × unit / 1e6
// → { usd, missed, unit, why }. Any needed value NULL, or no price row → usd null with the reason (`why`), never 0:
//   'no-ref' · 'no-usage' · 'no-write-counter' (the reference reports no cache-write counter) · 'no-price'.
export function breakCost(step, ref, priceRow) {
  const none = (why, extra = {}) => ({ usd: null, missed: null, unit: null, why, ...extra })
  if (!ref) return none('no-ref')
  const u = usageOf(step), r = usageOf(ref)
  if (!u || !r || !num(u.read)) return none('no-usage')
  if (!num(r.read) || !num(r.create)) return none('no-write-counter')
  const missed = Math.max(0, r.read + r.create - u.read)
  const p = rowOf(priceRow)
  if (!p) return none('no-price', { missed })
  const unit = (num(u.create) ? p[2] : p[0]) - p[3]
  return { usd: (missed * unit) / 1e6, missed, unit, why: null }
}

// ── price and cost ──────────────────────────────────────────────────────────────────────────────────────────────────
// price row = [input, output, cache-write, cache-read] per million tokens. The table is keyed by whatever the user's price config
// names (the real server's default keys are families, a call's model is the full id), so a lookup is generic: no model name here.
const isRow = (v) => Array.isArray(v) && v.length === 4
// the exact key only (own property, a four-number row)
export function priceRow(table, model) {
  if (!table || !model || !Object.prototype.hasOwnProperty.call(table, model)) return null
  return isRow(table[model]) ? table[model] : null
}
// → { row, key, exact } | null. The exact key first; otherwise the LONGEST table key that occurs in the model id (equal lengths: lexical order,
// whatever the table's own order), flagged exact:false so every place that shows the price labels it an approximation (invariant 4).
// An empty key occurs in every id and is no key. No key in the id → null: the price stays unknown, never a guess.
export function priceMatch(table, model) {
  if (!table || !model) return null
  const row = priceRow(table, model)
  if (row) return { row, key: model, exact: true }
  const id = String(model)
  const key = Object.keys(table).filter((k) => k && isRow(table[k]) && id.includes(k)).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0]
  return key == null ? null : { row: table[key], key, exact: false }
}
// The server's `pricing` document { models: [{ model, input, output, cache_read, cache_write }], source } → { [model]: price row }.
// The one converter the board uses (desk and overview). Not a models[] document → null (the caller names that as a read failure, not an empty table).
export function priceTableOf(doc) {
  if (!doc || !Array.isArray(doc.models)) return null
  const t = {}
  for (const m of doc.models) if (m && m.model) t[m.model] = [m.input, m.output, m.cache_write, m.cache_read]
  return t
}
// NULL counters count as 0 only inside a priced row. A call with no usage at all has no cost (null), not $0.
export function costOf(row, u) {
  if (!row || !u) return null
  return ((u.fresh || 0) * row[0] + (u.out || 0) * row[1] + (u.create || 0) * row[2] + (u.read || 0) * row[3]) / 1e6
}
const modelOf = (c) => (c && c.rec && c.rec.request && c.rec.request.model) || null
// priceOf(model) → a price row, a priceMatch result, or null. A call priced through a non-exact match counts in `approx`, and `approxKeys` says which keys.
// A failed call is not billed: it counts in `failed`, in neither `priced` nor `unpriced` (the latter means "no price or no usage").
export function sessionCost(calls, priceOf) {
  let usd = 0, priced = 0, unpriced = 0, approx = 0, failed = 0
  const keys = new Set()
  for (const c of calls || []) {
    if (isFailed(c)) { failed++; continue }
    const p = priceOf(modelOf(c)), row = Array.isArray(p) ? p : p && p.row
    const c$ = costOf(row, usageOf(c))
    if (c$ == null) { unpriced++; continue }
    usd += c$
    priced++
    if (p && !Array.isArray(p) && p.exact === false) { approx++; keys.add(p.key) }
  }
  return { usd, priced, unpriced, failed, approx, approxKeys: [...keys].sort() }
}

// ── cost per bucket ─────────────────────────────────────────────────────────────────────────────────────────────────
// Every lane lands in one of three buckets (plan P2.9): 主对话 (kind main), 子 agent (subagent) and 后台调用 (every other kind, also
// one no table knows). count_tokens rulers (calls flagged `probe`) are not billed and are in none of them.
// the bucket word comes from the lane kind table (2.1's LANE_KIND) — one authority; token-count is not billed (bucket
// null → the rows never name it; its calls are also probe-flagged, so billed() drops them from every bucket)
export const bucketOf = (kind) => laneKind(kind).bucket ?? 'bg'
const billed = (lane) => (lane.calls || []).filter((c) => c && !c.probe)
const addCost = (a, b) => ({ usd: a.usd + b.usd, priced: a.priced + b.priced, unpriced: a.unpriced + b.unpriced, failed: a.failed + b.failed, approx: a.approx + b.approx, approxKeys: [...new Set([...a.approxKeys, ...b.approxKeys])].sort() })
export function costBuckets(lanes, priceOf) {
  const by = { main: [], sub: [], bg: [] }
  for (const l of lanes || []) by[bucketOf(l.kind)].push(...billed(l))
  const cost = Object.fromEntries(Object.entries(by).map(([k, calls]) => [k, sessionCost(calls, priceOf)]))
  return { ...cost, total: addCost(addCost(cost.main, cost.sub), cost.bg) }
}

// ── the totals a session shows ──────────────────────────────────────────────────────────────────────────────────────
// cost          costBuckets(…)
// hit           main lane only, token-weighted: Σ read / Σ (read + create + fresh); null with no measured step (hitSteps counts them)
// firstFailed   the FIRST failed model call of any lane ({lane, i} — the lane object and its index), for the popover's jump
// cacheUnknown  a main step's vendor reports cache numbers of uncertain meaning (wire.cacheSemanticsKnown === false)
// breaks        local main-lane indices of the steps that broke the cache
// breakCost     {usd, counted, uncomputable, worst:{i, usd}|null} — usd sums only what could be computed, `uncomputable` counts the rest
// failed        failed model calls of every lane (count_tokens rulers excluded)
// unpricedSteps steps that could not be priced (no usage, or no price row)
export function sessionTotals(lanes, priceOf) {
  const cost = costBuckets(lanes, priceOf)
  const main = (lanes || []).find((l) => l.kind === 'main'), mc = main ? main.calls : []
  let read = 0, tot = 0, measured = 0, cacheUnknown = false
  for (const c of mc) {
    if (c.wire && c.wire.cacheSemanticsKnown === false) cacheUnknown = true
    const u = isFailed(c) ? null : usageOf(c)
    if (!u) continue
    const t = (u.read || 0) + (u.create || 0) + (u.fresh || 0)
    if (t > 0) { read += u.read || 0; tot += t; measured++ }
  }
  const breaks = breakSteps(mc)
  let usd = 0, counted = 0, uncomputable = 0, worst = null
  for (const i of breaks) {
    const p = priceOf(modelOf(mc[i])), bc = breakCost(mc[i], refOf(mc, i), p)
    if (bc.usd == null) { uncomputable++; continue }
    usd += bc.usd; counted++
    if (!worst || bc.usd > worst.usd) worst = { i, usd: bc.usd }
  }
  let failed = 0, firstFailed = null
  for (const l of lanes || []) billed(l).forEach((c, i) => { if (isFailed(c)) { failed++; if (!firstFailed) firstFailed = { lane: l, i } } })
  return { cost, hit: tot > 0 ? read / tot : null, hitSteps: measured, cacheUnknown, breaks, breakCost: { usd, counted, uncomputable, worst }, failed, firstFailed, unpricedSteps: cost.total.unpriced }
}
