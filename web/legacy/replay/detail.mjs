// replay/detail.mjs — the call drawer (2.6 §B): the bottom sheet that deep-reads ONE call outside the main conversation —
// a subagent, a background call (安全审查 / 通知摘要 / 生成标题 / 保活检查 / 预热请求 / …) or one token-count measurement.
// The title row words the lane through the lane kind table (2.1) and says 「约在第 N 步」 (by time, the nearest main step);
// the server's `note` and every raw value ride in 技术细节. The input is listed block by block and opens to verbatim bytes
// (AC-1); the reply is the PARSED one and is marked as such — 逐字 is only ever written for a proven block.
// `el` is #detail (shared with the other screens); the desk wires and clears it while mounted.
import { esc, kf } from '../core/fmt.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import { nearestByTs } from './lanes.mjs'
import { when } from './analysis.mjs'
import { faithOf, FF, ffBadgeHtml, fillBody, tagWord, bodyFor } from './blocks.mjs'
import { wireCells } from './cell.mjs'
import { stepOf } from './model.mjs'
import { replyOf, replyMarkHtml } from './rawpanel.mjs' // the reply's ONE fidelity mark: the same resolve rule as the raw panel (2.3)
import { costCellHtml } from './stepbar.mjs' // the cost cell's one home (2.2); the drawer's own words stay here
import { clearRange } from './rails.mjs'
import * as W from '../labels/replay.mjs'

const FOLD_AT = 600 // a block longer than this starts folded: ⟨逐字 · N 字符 · 点开⟩
const AUTO_AT = 40  // …and a call with more blocks than this opens none of them on its own

// the cost row: the same cell the step bar's ≈ $ button uses (core/metrics.mjs is the only home of the number). Unknown
// is 「—」 with its reason, never $0. A quota ping's reply is discarded, but the call itself is billed (2.2 §调用详情卡).
export function costRowHtml(c, table, tableErr) {
  const model = String((c.rec && c.rec.request && c.rec.request.model) || '')
  if (!c.usage) return `<div class="din" style="color:var(--dim)">${esc(model)} · ${esc(W.COST_WHY['no-usage'])} — ≈ —</div>`
  return `<div class="din" style="color:var(--dim)">${esc(model)} · output ${kf(c.usage.out)} tokens · ≈ ${costCellHtml(model, c.usage, table, tableErr)}</div>`
}

// the reply: the step's reply definitions, each a cell like every other body, marked by the SAME rule as the raw panel
// (replyOf: every part on its span of the streamed reply → no mark; partially stored → 「◐ 回复没采全」; else 「◐ 解析后的回复」).
// A monitor's verdict text is shown as-is, with no mark of its own beyond that.
function outputHtml(c, st) {
  if (!st || !st.held) return `<div class="din rpbusy" aria-busy="true"></div>`
  const r = replyOf({ row: c, reply: st.reply, detail: st.detail })
  if (r.failed) return `<div class="din">${esc(W.FAILED_NO_REPLY)}${r.failed.reason ? techDetailsHtml([['reason', String(r.failed.reason)]], { id: 'dfail' }) : ''}</div>`
  if (!r.parts.length) return `<div class="din">${esc(W.REPLY_WORD)}: <b>(none)</b></div>`
  return `<div class="din">${esc(W.REPLY_WORD)} ${replyMarkHtml(r)}</div>` + r.parts.map((d) => `<div class="dout" data-dout="${esc(d.bid)}">${bodyFor({ ...d, text_ref: d.ref })}</div>`).join('')
}

// a block's size with its unit: chars when the server baked them, else bytes (a byte count labelled 字符 would be a wrong
// number); neither → unknown, never a measured-looking 0. An opaque block has no plaintext to measure at all.
const sizeOf = (b) => (b.chars != null ? { n: b.chars, unit: W.CHARS_WORD } : b.bytes != null ? { n: b.bytes, unit: 'bytes' } : null)
const OPAQUE_SIZE = W.OPAQUE_ROW

// the call's input: one row per block of `flat`, each opening to its verbatim bytes. The fold label states what is folded:
// 「逐字 · N 字符 · 点开」 only for a PROVEN block, its own fidelity word otherwise (D18c).
function inputHtml(c, flat) {
  if (c.kindHint === 'tc') return `<div class="din">${esc(W.TC_INPUT[c.tcRetention === 'log' ? 'log' : c.tcRetention === 'legacy-meta' ? 'old' : 'full'])}</div>`
  if (!flat) return `<div class="din rpbusy" aria-busy="true"></div>` // the lane is not held yet: a frame, filled when it lands
  if (!flat.length) return `<div class="din" style="color:var(--dim)">${esc(W.NO_INPUT)}</div>`
  const auto = flat.length <= AUTO_AT
  return `<div class="din" style="color:var(--dim)">${esc(W.inputBlocks(flat.length))}:</div>` + flat.map((b, i) => {
    const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
    const sz = sizeOf(b), n = sz && sz.n
    const noText = faithOf(b) === 'opaque' && !n
    const open = auto && (noText || (n != null && n <= FOLD_AT))
    const f = FF[faithOf(b)]
    const foldWord = f ? f.text : faithOf(b)
    // a FOLDED row always says what is folded — its own fidelity word plus 点开 — whether it folded for length or
    // because the call has >40 blocks and none auto-opened (2.6 §B); only an auto-opened row shows the plain size
    const size = noText ? OPAQUE_SIZE : !sz ? 'size not known' : !open ? `‹${esc(W.foldAt(foldWord, n, sz.unit))}›` : `${n} ${sz.unit}`
    return `<div class="dblk ${open ? 'open' : ''}" data-di="${i}"><div class="dbh"><span class="dbrole">${esc(h.role)}</span><span class="cbtag">${esc(tagWord(h.tag))}</span>${h.label || b.preview ? `<span class="dblab">${esc(h.label || b.preview)}</span>` : '<span class="dblab"></span>'}${ffBadgeHtml(faithOf(b), { tech: b.unaddressable || String(b.faithfulness ?? '') })}<span class="dbn">${size}</span></div><div class="dbbody"></div></div>`
  }).join('')
}

export function detailHtml(s, lane, i) {
  const c = lane.calls[i]
  const word = W.laneWord(lane.kind)
  const k = i + 1
  // 「约在第 N 步」: by time — where the conversation stood when this call went out (the review bracket's own number)
  const near = s.anchor && s.anchor.calls.length ? nearestByTs(s.anchor, c.ts, 0) : 0
  const nearW = s.anchor && s.anchor.kind === 'main' ? `near step ${near + 1} (inferred)` : ''
  const isTc = lane.kind === 'token-count'
  const title = `${esc(word)} · call ${k} · ${esc(when(c.ts))}${nearW ? ` · ${esc(nearW)}` : ''}`
  let body
  if (isTc) {
    body = `<div class="din">${esc(W.laneKind('token-count').hint)}</div>` +
      `<div class="din">${esc(W.TC_MEASURED(kf(c.ctx)))}</div>` +
      inputHtml({ kindHint: 'tc', tcRetention: c.retention }, [])
  } else {
    const st = s.desk && c.rid != null ? stepOf(s.desk, c.rid) : null
    const unknown = !W.LANE_KIND[lane.kind]
    const tech = [[lane.note ? 'note' : '', lane.note || ''], unknown ? ['kind', lane.kind] : '', c.flagged != null ? ['flagged', String(c.flagged)] : '', c.rec && c.rec.id ? ['id', String(c.rec.id)] : ''].filter((x) => x && x[0])
    body = `<div class="din">${esc(W.laneKind(lane.kind).hint)}</div>` +
      outputHtml(c, st) + costRowHtml(c, s.pricing, s.pricingErr) + inputHtml(c, st && st.held ? st.flat : null) +
      (tech.length ? techDetailsHtml(tech, { id: 'dtech' }) : '')
  }
  return { title, body, near, flat: isTc ? [] : (s.desk && c.rid != null && stepOf(s.desk, c.rid).flat) || null }
}

export function openDetail(el, s, lane, i) {
  const { title, body, near, flat } = detailHtml(s, lane, i)
  el.className = 'open k-' + lane.kind
  el.innerHTML = `<div class="dclose" id="dclose" role="button" tabindex="0">${esc(W.DRAWER_CLOSE)}</div>` +
    `<h3>${title}</h3>` +
    `<div class="dnav"><button type="button" class="dback" data-back="${near}">${esc(W.backToStep(near + 1))}</button></div>` +
    body
  s.drawerFlat = flat || []
  // the lane of this call is read when the drawer opens (2.3 §读与画); the desk re-opens the drawer when it lands
  if (!flat && lane.kind !== 'token-count' && typeof s.wantLane === 'function') s.wantLane(lane.calls[i].lane ?? lane.id)
  for (const row of el.querySelectorAll('.dblk.open')) fillBody(s.ctx.api, row.querySelector('.dbbody'), s.drawerFlat[+row.dataset.di])
  const st = flat && stepOf(s.desk, lane.calls[i].rid), reply = new Map(((st && st.reply) || []).map((d) => [d.bid, d]))
  for (const slot of el.querySelectorAll('.dout')) { const d = reply.get(slot.dataset.dout); if (d && slot.querySelector('pre[data-ref]')) fillBody(s.ctx.api, slot, { ...d, text_ref: d.ref }) }
}
export function closeDetail(el, s) {
  s.selTick = null; s.drawerFlat = []
  clearRange(s)
  el.className = ''
  for (const e of s.root.querySelectorAll('#rails .sel')) e.classList.remove('sel')
}

export function wireDetail(el, s) {
  const onClick = (e) => {
    if (e.target.closest('#dclose')) { closeDetail(el, s); return }
    const bk = e.target.closest('[data-back]')
    if (bk) { s.jumpTo(+bk.dataset.back, null); return } // the playhead moves; the drawer stays open (2.6 §B)
    const h = e.target.closest('.dbh')
    if (!h) return
    const row = h.closest('.dblk'), b = s.drawerFlat[+row.dataset.di]
    row.classList.toggle('open')
    const body = row.querySelector('.dbbody') // fillBody owns the `filled` flag on it: a failed fetch leaves it clear, so a reopen asks again
    if (row.classList.contains('open') && b && body && !body.dataset.filled) fillBody(s.ctx.api, body, b)
  }
  el.addEventListener('click', onClick)
  const cells = wireCells([s.root, el].filter(Boolean), s) // every body in the desk and the drawer is a cell
  return () => { el.removeEventListener('click', onClick); cells() }
}
