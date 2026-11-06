// replay/stepbar.mjs — the step head's model functions (2.2 §步头) the React desk and the drawer use: the cost cell (costCellHtml,
// the drawer's) and the price table's state note, the 缓存 and ≈ $ buttons' words, and the 内容对比步. The step head itself is
// web/src/screens/replay/StepHead.tsx over models.mjs stepHeadModel().
import { esc, usd } from '../core/fmt.mjs'
import { cacheState, usageOf, priceMatch, costOf } from '../core/metrics.mjs'
import { refRowOf } from './analysis.mjs'
import { stepRef } from './lanes.mjs'
import * as W from '../labels/replay.mjs'

const modelOf = (c) => (c && c.rec && c.rec.request && c.rec.request.model) || null

// ── the cost cell (D14 — a LOCAL estimate, never a wire fact) ───────────────────────────────────────────────
// the state of the price table itself, when there is no table to look a price up in: a failed read names its reason; an
// unanswered one says nothing (no "loading" word anywhere, 2.3:173). Empty when the table is there.
export const priceStateNote = (table, err) => (table || !err ? '' : `The price table could not be read: ${err}`)
// one cost: usage missing → 「—」 · no table (unreadable / not yet loaded) → 「—」 + why · no price row → 「没有这个模型的单价」 ·
// else dollars, ≈-marked by the caller (unknown is never $0)
export function costCellHtml(model, u, table, tableErr) {
  if (!u) return `— <span class="estnote">${esc(W.COST_WHY['no-usage'])}</span>`
  if (!table) return tableErr ? `— <span class="estnote">${esc(priceStateNote(table, tableErr))}</span>` : '—'
  const m = priceMatch(table, model)
  if (!m) return `— <span class="estnote">${esc(W.COST_WHY['no-price'])}</span>`
  return `<b>${usd(costOf(m.row, u))}</b>` + (m.exact ? '' : ` <span class="estnote">${esc(W.PRICE_BY_KEY(m.key))}</span>`)
}
// ── the 缓存 button ──────────────────────────────────────────────────────────────────────────────────────────────────
// the button's word follows the predicate (2.2 §缓存判定): 失败 → — → N% (a vendor of uncertain cache numbers adds ?)
export function cacheLabel(call) {
  const st = cacheState(call)
  if (st.state === 'failed') return 'cache failed'
  if (st.state === 'no-usage') return 'cache —'
  const pct = st.hit != null ? Math.round(st.hit * 100) : null
  const q = call && call.wire && call.wire.cacheSemanticsKnown === false
  return pct == null ? 'cache —' : `cache ${pct}%${q ? '?' : ''}`
}
// ── the ≈ $ button ──────────────────────────────────────────────────────────────────────────────────────────────────
export function costLabel(call, table) {
  const u = usageOf(call)
  const m = u && table ? priceMatch(table, modelOf(call)) : null
  return u && m ? `≈ ${usd(costOf(m.row, u))}` : '≈ —'
}
// ── the 内容对比步 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// a call's number in its lane: 「第 N / M 步」 on the main lane, 「<lane 词> · 第 k / M 次调用」 elsewhere (stepRef, 1.2 §编号)
const localNo = (s, call) => { const r = call && stepRef(s.lanes, call.rid); return r ? (r.step ? r.n : r.k) : null }

// the 内容对比步 (2.3): the chosen step when one is pinned, else the 缓存对比步; null = this line's first call
export function contentRefOf(s) {
  if (!s.anchor) return null
  if (s.diffRef != null && s.diffRef >= 0 && s.diffRef < s.anchor.calls.length && s.diffRef !== s.playhead) return s.anchor.calls[s.diffRef]
  return refRowOf(s.anchor, s.playhead)
}
export const contentRefKOf = (s) => { const r = contentRefOf(s); return r && s.anchor.kind === 'main' ? localNo(s, r) : null }
