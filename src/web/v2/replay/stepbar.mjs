// replay/stepbar.mjs — the step head (2.2 §步头): the middle column's first row. 「‹ 第 N / M 步 › · 第 K 次提问 · 时间 · 模型 ·
// ◐ · 对比 ▾ · 缓存 · 组成 · ≈ $」 and nothing else — the numbers and the verdicts live behind the three buttons' popovers
// , computed by core/metrics.mjs alone. The cost cell trio (costCellHtml / usageLineHtml / priceStateNote)
// moved here from rawpanel.mjs: usage is shown in ONE place (the 缓存 button), the cost in ONE place (the ≈ $ button).
//   stepBarHtml(s)  the row (popovers inline, hidden)      wireStepBar(el, s)  the actions
import { esc, kf, usd, bytes, fmtTime } from '../core/fmt.mjs'
import { popover, menuButton, mark } from '../core/ui.mjs'
import { cacheState, usageOf, hitRatio, isBreak, breakCost, refOf, priceMatch, costOf } from '../core/metrics.mjs'
import { segTax, blocksOf, TAX_ORDER, hasChangeLine } from './analysis.mjs'
import * as W from '../labels/replay.mjs'

const modelOf = (c) => (c && c.rec && c.rec.request && c.rec.request.model) || null
// a failed call's reason, whatever shape the server sent it in (a string, or an object with a message)
const errMsgOf = (c) => { const e = c && c.error; if (!e) return ''; return typeof e === 'string' ? e : (e.message || e.msg || '') }

// ── the cost cell trio (from rawpanel.mjs; D14 — a LOCAL estimate, never a wire fact) ───────────────────────────────
// the state of the price table itself, when there is no table to look a price up in: a failed read names its reason, an
// unanswered one says so. Empty when the table is there.
export const priceStateNote = (table, err) => (table ? '' : err ? `价表读不出:${err}` : '价表载入中')
// the price a model's cost is read through: exact key, or the LONGEST table key occurring in the model id (then every place
// that shows it labels it 「按 <键> 的单价」). No key at all → null: unknown, never a guess.
export const priceMatchOf = (table, model) => priceMatch(table, model)
// one cost: usage missing → 「—」 · no table (unreadable / not yet loaded) → 「—」 + why · no price row → 「没有这个模型的单价」 ·
// else dollars, ≈-marked by the caller (unknown is never $0)
export function costCellHtml(model, u, table, tableErr) {
  if (!u) return `— <span class="estnote">${esc(W.COST_WHY['no-usage'])}</span>`
  if (!table) return `— <span class="estnote">${esc(priceStateNote(table, tableErr))}</span>`
  const m = priceMatch(table, model)
  if (!m) return `— <span class="estnote">${esc(W.COST_WHY['no-price'])}</span>`
  return `<b>${usd(costOf(m.row, u))}</b>` + (m.exact ? '' : ` <span class="estnote">${esc(W.PRICE_BY_KEY(m.key))}</span>`)
}
// the four usage numbers in the board's words (2.2): NULL is 「—」 with its hover, a real 0 stays 0
const usageNum = (n) => (n == null ? `<span class="un-null" title="${esc(W.USAGE_NULL_TIP)}">—</span>` : esc(kf(n)))
export function usageLineHtml(u) {
  if (!u) return ''
  return `命中缓存 ${usageNum(u.read)} · 写入缓存 ${usageNum(u.create)} · 未缓存 ${usageNum(u.fresh)} · 输出 ${usageNum(u.out)} token`
}

// ── the 缓存 button ──────────────────────────────────────────────────────────────────────────────────────────────────
// the button's word follows the predicate (2.2 §缓存判定): 失败 → — → N% (a vendor of uncertain cache numbers adds ?)
export function cacheLabel(call) {
  const st = cacheState(call)
  if (st.state === 'failed') return '缓存 失败'
  if (st.state === 'no-usage') return '缓存 —'
  const pct = st.hit != null ? Math.round(st.hit * 100) : null
  const q = call && call.wire && call.wire.cacheSemanticsKnown === false
  return pct == null ? '缓存 —' : `缓存 ${pct}%${q ? '?' : ''}`
}
// the popover: the state sentence first, then only the rows that apply — a structural verdict carries its mark, the four
// numbers are the real usage, a break says what it cost, and the jump is offered only when the window drew the 变化线.
export function cachePopoverHtml(call, ref, { laneW = '主对话', priceRow = null, hasChange = false } = {}) {
  const st = cacheState(call, ref)
  const u = usageOf(call)
  const b = (call && call.cacheBreak) || {}
  const rows = []
  rows.push(`<div class="pp-sentence">${esc(W.cacheSentence(st, {
    laneW, causeW: W.causeWord(b.cause), attrW: W.ATTR_WORD[b.attribution],
    hitPct: st.hit != null ? Math.round(st.hit * 100) : null, warm: st.warm,
    inferred: !!(call && call.compactionInferred), errMsg: errMsgOf(call),
    zeroInput: st.zeroInput,
  }))}${W.isStructState(st) ? ` ${mark('struct', W.STRUCT_TIP)}` : ''}</div>`)
  if (u && st.state !== 'failed' && st.state !== 'no-usage') rows.push(`<div class="pp-nums">${usageLineHtml(u)}</div>`)
  if (st.isBreak) {
    const bc = breakCost(call, ref, priceRow)
    rows.push(`<div class="pp-cost">${bc.usd != null ? `${esc(W.BREAK_COST_LINE)} ${usd(bc.usd)}` : esc(W.BREAK_COST_WHY[bc.why] || W.BREAK_COST_WHY['no-ref'])}</div>`)
  }
  if (hasChange) rows.push(`<div class="pp-link"><button type="button" class="jumpbtn" data-jump="change">${W.JUMP_TO_CHANGE}</button></div>`)
  if (call && call.wire && call.wire.cacheSemanticsKnown === false) rows.push(`<div class="pp-note">${esc(W.CACHE_SEMANTICS_UNKNOWN)}</div>`)
  return rows.join('')
}

// ── the 组成 button ──────────────────────────────────────────────────────────────────────────────────────────────────
// the 内容对比步's segTax against this one's; a step whose body is not on the page (or unparsed, or never captured) says so
// instead of a number. The calibre sentence is DOM text, not a hover (2.2 MUST).
const SEG_BYTE = (k, tax) => `${bytes(tax.seg[k])} · ≈ ${kf(tax.est(k))} token`
export function compPopoverHtml(call, ref, { refK = null, refIsCache = true } = {}) {
  if (!call || !call.rec) return `<div class="pp-sentence">${esc(W.COMP_SELF.none)}</div>`
  if (call.unparsed) return `<div class="pp-sentence">${esc(W.COMP_SELF.unparsed)}</div>`
  if (call.paged_out) return `<div class="pp-sentence">${esc(W.COMP_SELF.paged)}</div>`
  const flat = call.flat || []
  const tax = segTax(flat)
  const rows = [`<div class="pp-nums">${esc(W.compSize(bytes(tax.total)))}</div>`, `<div class="pp-calibre">${esc(W.COMP_CALIBRE)}</div>`]
  rows.push(`<div class="pp-segs">${TAX_ORDER.map((k) => `<span class="ppseg" title="${esc(SEG_BYTE(k, tax))}">${esc(W.SEG_NAME[k])} <b>${tax.pct(k)}%</b></span>`).join(' · ')}</div>`)
  rows.push(`<div class="pp-culprit">${esc(W.compCulprit(tax.culprit, tax.pct(tax.culprit)))}</div>`)
  if (!tax.allVerbatim) rows.push(`<div class="pp-note">${esc(W.TOOLS_ESTIMATED)}</div>`)
  // growth: only against a real 内容对比步; a compaction step whose content ref IS the cache ref is a rewrite, not a Δ
  const cause = call.cacheBreak && call.cacheBreak.cause
  if (cause === 'compaction' && refIsCache) rows.push(`<div class="pp-note">${esc(W.COMPACTION_REWRITE)}</div>`)
  else if (ref) {
    if (ref.paged_out || !blocksOf(ref)) rows.push(`<div class="pp-note">${esc(W.compOffPage(refK))} <button type="button" class="jumpbtn" data-load-step="${esc(String(refK))}">${esc(W.LOAD_STEP(refK))}</button></div>`)
    else {
      const prev = segTax(ref.flat)
      const d = tax.total - prev.total
      const dom = TAX_ORDER.map((k) => ({ k, d: tax.seg[k] - prev.seg[k] })).reduce((a, x) => (Math.abs(x.d) > Math.abs(a.d) ? x : a), { k: 'tools', d: 0 })
      const segW = dom.d ? W.SEG_NAME[dom.k] : ''
      const less = d < 0
      rows.push(`<div class="pp-nums">${esc(refK != null ? W.growthVs(refK, bytes(Math.abs(d)), segW, less) : W.growthLine(bytes(Math.abs(d)), segW, less))}</div>`)
      rows.push(`<div class="pp-calibre">${esc(W.DIAGNOSE_ONLY)}</div>`)
    }
  }
  return rows.join('')
}

// ── the ≈ $ button ──────────────────────────────────────────────────────────────────────────────────────────────────
export function costLabel(call, table) {
  const u = usageOf(call)
  const m = u && table ? priceMatch(table, modelOf(call)) : null
  return u && m ? `≈ ${usd(costOf(m.row, u))}` : '≈ —'
}
export function costPopoverHtml(call, { table = null, tableErr = null } = {}) {
  const st = cacheState(call)
  const u = usageOf(call)
  const rows = [`<div class="pp-calibre">${esc(W.COST_CALIBRE)}</div>`]
  const m = u && table ? priceMatch(table, modelOf(call)) : null
  if (m && m.exact === false) rows.push(`<div class="pp-note">${esc(W.PRICE_BY_KEY(m.key))}</div>`)
  if (!m || !u) {
    const why = st.state === 'failed' ? W.COST_WHY.failed : !u ? W.COST_WHY['no-usage'] : !table ? W.priceTableNote(table, tableErr) : W.COST_WHY['no-price']
    rows.push(`<div class="pp-note">${esc(why)}</div>`)
  }
  rows.push(`<div class="pp-link"><a href="#/settings/prices">${W.SEE_PRICES}</a></div>`)
  return rows.join('')
}

// ── the 对比 menu (2.3 §两个对比步; a MENU button — click / Enter / Space / ↓, never hover) ───────────────────────────
// sel: the chosen 内容对比步 as a 1-based step number, null = the default (the 缓存对比步). cacheRefK: the 缓存对比步's
// number — when it is not the immediately previous step the default item names it.
export function compareMenuHtml({ sel = null, cacheRefK = null, cur = null, M = 0 }) {
  const id = `cmp-${Math.random().toString(36).slice(2, 8)}`
  const def = cacheRefK != null && cur != null && cacheRefK !== cur - 1 ? W.compareDefaultAt(cacheRefK) : W.COMPARE_DEFAULT
  const label = sel ? `${esc(W.compareAt(sel).replace(' ×', ''))} <span class="cmpx" data-cmp-x="1" role="button" tabindex="0" aria-label="${esc(W.CMP_RESET)}" title="${esc(W.CMP_RESET)}" aria-hidden="true">×</span>` : esc(W.COMPARE)
  return `<span class="sb-cmp"><button type="button" class="popbtn" data-menu="${id}" aria-label="${esc(W.COMPARE)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}">${label} <span class="chev" aria-hidden="true">▾</span></button>` +
    `<div class="pop menu" id="${id}" role="menu" hidden>` +
    `<button type="button" role="menuitem" data-cmp="default">${esc(def)}</button>` +
    `<button type="button" role="menuitem" data-cmp="pick">${esc(W.COMPARE_PICK)}</button>` +
    `<div class="cmpick" hidden><label>${esc(W.COMPARE_WITH)} <input type="number" min="1" max="${M}" step="1" data-cmp-in> ${esc(W.COMPARE_WITH2)}</label> <button type="button" data-cmp="ok">${esc(W.COMPARE_OK)}</button></div>` +
    `</div></span>`
}

// ── the row ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// ONLY the parts of 2.2's table; a fact that is absent is not drawn. `s` is the desk's state.
export function stepBarHtml(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) return ''
  const isMain = s.anchor.kind === 'main'
  const M = s.anchor.calls.length, n = s.playhead + 1
  const no = isMain ? W.stepNo(n, M) : W.callNo(W.laneWord(s.anchor.kind), n, M)
  const model = modelOf(call)
  // 第 K 次提问: only where the server ships user events (some wire families do); an absent field → not drawn
  const evs = (s.anchor.events || []).filter((e) => e && e.type === 'user' && e.step != null)
  const ask = evs.length && call.gi != null ? evs.filter((e) => e.step <= call.gi).length : 0
  // ◐: the call-level fidelity facts (words owned by 2.3's 调用保真行; here only the mark and the server's own texts)
  const w = call.wire || {}
  const fidTxt = [call.reqIncomplete && call.reqIncomplete.text, call.wsIncomplete && call.wsIncomplete.text, call.respIncomplete && call.respIncomplete.text,
    ...((w.labels || []).map((l) => l.text || l.label))].filter(Boolean).join('\n')
  const hasFid = !!(fidTxt || w.contextState)
  // the 缓存对比步: the nearest earlier call of the anchor lane that did not fail (S12 will name it; same rule until then)
  const ref = refOf(s.anchor.calls, s.playhead)
  const refK = ref && ref.gi != null && isMain ? localNo(s.anchor, ref) : null
  // the jump is offered only when the window draws the 变化线 at the first differing block (one predicate, analysis.mjs)
  const hasChange = hasChangeLine(call)
  const priceRow = s.pricing ? priceMatch(s.pricing, modelOf(call)) : null
  return `<div class="stepbar" id="stepbar">` +
    `<span class="sb-nav"><button type="button" class="sbbtn" data-step="prev" aria-label="${esc(W.STEP_PREV)}" title="${esc(W.STEP_PREV)}">‹</button>` +
    `<b class="sb-no">${esc(no)}</b>` +
    `<button type="button" class="sbbtn" data-step="next" aria-label="${esc(W.STEP_NEXT)}" title="${esc(W.STEP_NEXT)}">›</button></span>` +
    (ask ? `<span class="sb-ask">${esc(W.askNo(ask))}</span>` : '') +
    `<span class="sb-time">${esc(fmtTime(call.ts) || '—')}</span>` +
    `<span class="sb-model">${esc(model || '—')}</span>` +
    (hasFid ? `<span class="sb-fid">${mark('part', fidTxt || undefined)}</span>` : '') +
    `<span class="spacer"></span>` +
    (isMain ? compareMenuHtml({ sel: s.diffRef != null ? s.diffRef + 1 : null, cacheRefK: refK, cur: n, M }) : '') +
    popover({ label: W.CACHE_POPOVER_LABEL, title: W.CACHE_TITLE, glyph: esc(cacheLabel(call)), body: cachePopoverHtml(call, ref, { laneW: W.laneWord(s.anchor.kind), priceRow, hasChange }) }) +
    popover({ label: W.COMP_POPOVER_LABEL, title: W.COMP_TITLE, glyph: esc(call.paged_out || call.unparsed || !call.rec ? W.COMP_BTN_NONE : W.COMP_BTN), body: compPopoverHtml(call, contentRefOf(s), { refK: contentRefKOf(s), refIsCache: s.diffRef == null }) }) +
    popover({ label: W.COST_POPOVER_LABEL, title: W.COST_TITLE, glyph: esc(costLabel(call, s.pricing)), body: costPopoverHtml(call, { table: s.pricing, tableErr: s.pricingErr }) }) +
    `</div>`
}
// the 内容对比步 (2.3): the chosen step when one is pinned, else the 缓存对比步; null = this line's first call
export function contentRefOf(s) {
  if (!s.anchor) return null
  if (s.diffRef != null && s.diffRef >= 0 && s.diffRef < s.anchor.calls.length && s.diffRef !== s.playhead) return s.anchor.calls[s.diffRef]
  return refOf(s.anchor.calls, s.playhead)
}
export const contentRefKOf = (s) => { const r = contentRefOf(s); return r && s.anchor.kind === 'main' ? localNo(s.anchor, r) : null }
const localNo = (lane, call) => { const i = lane.giLocal ? lane.giLocal.get(call.gi) : lane.calls.indexOf(call); return i != null && i >= 0 ? i + 1 : null }

// ── wiring: the step arrows, the jumps, the compare menu ────────────────────────────────────────────────────────────
export function wireStepBar(el, s) {
  const onClick = (e) => {
    const t = e.target
    const x = t.closest('[data-cmp-x]')
    if (x) { e.preventDefault(); e.stopPropagation(); s.setDiff(null); return }
    const st = t.closest('[data-step]')
    if (st) { s.setPlayhead(s.playhead + (st.dataset.step === 'prev' ? -1 : 1), true); return }
    const j = t.closest('[data-jump="change"]')
    if (j) { s.queueJump({ kind: 'anchor', id: 'cachebrk' }); return }
    const ld = t.closest('[data-load-step]')
    if (ld) { const r = contentRefOf(s); if (r) s.ensurePage(r, true); return }
    const cm = t.closest('[data-cmp]')
    if (cm) {
      const a = cm.dataset.cmp
      if (a === 'default') s.setDiff(null)
      else if (a === 'pick') { const pick = cm.closest('.pop').querySelector('.cmpick'); if (pick) pick.hidden = !pick.hidden; const inp = pick && pick.querySelector('[data-cmp-in]'); if (inp && !pick.hidden) inp.focus() }
      else if (a === 'ok') {
        const inp = cm.closest('.pop').querySelector('[data-cmp-in]')
        const v = inp && parseInt(inp.value, 10)
        const M = s.anchor ? s.anchor.calls.length : 0
        if (Number.isFinite(v) && v >= 1 && v <= M && v !== s.playhead + 1) s.setDiff(v - 1)
        else if (inp) inp.title = W.COMPARE_RANGE(M)
      }
      return
    }
  }
  el.addEventListener('click', onClick)
  const onKey = (e) => { if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-cmp-x]')) { e.preventDefault(); s.setDiff(null) } }
  el.addEventListener('keydown', onKey)
  return () => { el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey) }
}
