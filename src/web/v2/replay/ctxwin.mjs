// replay/ctxwin.mjs — the context window (1.4 中央看板 · 2.3 忠实上下文回放): exactly what the model received this
// call, in assembly order tools → system → messages. The middle column holds the step bar (2.2, above this element) and
// #ctxwin; #ctxwin's children come ONLY from 1.4's whitelist ①–⑨, in order:
//   ① 调用保真行  ② 窗口行  ③ the three sections (with the 变化线 ④ drawn before the first changed block)  ⑤ 未下发态
//   ⑥ 解析不出态  ⑦ 没有请求态  ⑧ 载入中 — ⑤–⑧ stand in for ③④⑨  ⑨ this step's reply (2.3 §这一步的回复), set apart from the
//   request: not a section, not in any count — the model's answer, not what it received; its parts are block rows drawn
//   by the request's row component (blockRowHtml), without what only a request block carries.
// No window head (step no / model / time / size live in the step bar), no cache states (the 缓存 button owns them), no
// raw-JSON twin (the window IS the truth, AC-1).   renderContextWindow(el, s)  repaint + land   wireCtxWin(el, s)
// listeners.   ctxWindowHtml(s)  the pure string the whitelist tests assert on.
import { esc, bytes } from '../core/fmt.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/replay.mjs'
import { messageTurns, blocksOf, keyDiff, cacheRefOf, hasChangeLine, callFacts } from './analysis.mjs'
import { contentRefOf, contentRefKOf } from './stepbar.mjs'
import { setFold, saveFold, turnAnchorKey, turnIsOpen } from './fold.mjs'
import { ctxBlockHtml, blockRowHtml, blockBodyHtml, rawContentText, fillBody, faithOf, faithNow, ffBadgeHtml, tagWord } from './blocks.mjs'
import { replyOf, replyMarkHtml, loadStepHtml } from './rawpanel.mjs' // one reply rule, two drawings (2.3 §这一步的回复 · 2.6 §A)

export { blockBodyHtml } from './blocks.mjs'

// ── ① the 调用保真行: one call's fidelity facts, said once, visibly (2.3 §调用保真行; 必拒隐瞒) ─────────────────────
export function callFidelityHtml(call) {
  const { facts, tech } = callFacts(call)
  if (!facts.length) return ''
  return `<div class="cwfline"><span class="cwhalf" aria-hidden="true">${W.HALF_MARK}</span> <span class="cwffacts">${facts.map((f) => esc(f)).join(' · ')}</span>${tech.length ? techDetailsHtml(tech, { id: 'cwf-tech' }) : ''}</div>`
}

// ── ② the 窗口行: no block of this step can return to the raw bytes ──────────────────────────────────────────────────
export function windowLineHtml(flat) {
  if (!flat || !flat.length || flat.some((b) => b.text_ref)) return ''
  const reasons = [...new Set(flat.map((b) => b.unaddressable).filter(Boolean))]
  return `<div class="cwwin"><span class="cwhalf" aria-hidden="true">${W.HALF_MARK}</span> ${esc(W.WINDOW_LINE)}${reasons.length ? techDetailsHtml(reasons.map((r, i) => ['reason ' + (i + 1), r]), { id: 'cwwin-tech' }) : ''}</div>`
}

// ── ③ the section header: name · block count · size · 以下逐字 (or just ◐ when the window line is up) ────────────────
export function sectionHeaderHtml(sec, blocks, { windowLine = false } = {}) {
  const name = W.SECTION_NAME[sec] || sec // an unknown section's name is data: escaped where it is printed
  const n = (blocks || []).length
  const size = (blocks || []).reduce((a, b) => a + (typeof b.bytes === 'number' ? b.bytes : 0), 0)
  const est = sec === 'tools' && (blocks || []).some((b) => faithNow(b) !== 'verbatim')
  const ff = windowLine ? `<span class="cwsecff" title="${esc(W.WINDOW_LINE)}">${W.HALF_MARK}</span>`
    : (blocks || []).length && (blocks || []).every((b) => faithNow(b) === 'verbatim') ? `<span class="cwsecff v">${esc(W.SECTION_VERBATIM)}</span>` : ''
  return `<div class="cwsec" id="sec-${esc(sec)}"><b>${esc(name)}</b><span class="cwsecn">${esc(String(n))} blocks</span>` +
    `<span class="cwsecsz"${est ? ` title="${esc(W.SECTION_SIZE_EST_TIP)}"` : ` title="${esc(W.SECTION_SIZE_TIP)}"`}>${est ? W.SECTION_SIZE_EST : ''} ${esc(bytes(size))}</span>${ff}</div>`
}

// ── ④ the 变化线: drawn only when the prefix actually changed (cause ∉ QUIET_CAUSES), before flat[cacheBreak.idx] ────
// Replaces the old cacheMarkerHtml/cacheWhyHtml: no cache states, no byte offsets (D17①), no English causeLabel/fixHint,
// no attribution. The K is the 缓存对比步 — S12's refGi when the server names it, else the front-end rule (cacheRefOf).
export const changeHeadWord = (b) => {
  const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
  const t = tagWord(h.tag)
  return [h.role, t || h.tag, h.label || b.preview || ''].filter(Boolean).join(' · ')
}
export function changeLineHtml(call, k, flat) {
  const brk = call.cacheBreak
  const causeW = brk.cause === 'compaction'
    ? W.CHANGE_COMPACT + (call.compactionInferred ? `(${W.CHANGE_COMPACT_INFERRED})` : '')
    : (W.causeWord(brk.cause))
  const auto = !flat.some((b) => b.cc) // no declared cache position: a structural reference only, not a real boundary
  const tip = W.changeFirstTip(changeHeadWord(flat[brk.idx] || {}))
  return `<div class="chline" id="cachebrk" title="${esc(tip)}"><span class="chbar" aria-hidden="true"></span>` +
    `<span class="cht">${esc(W.changeLine(k, causeW))} · <i class="chest" title="${esc(W.STRUCT_TIP)}">${esc(W.STRUCT_EST_WORD)}</i>` +
    `${auto ? ` · <i class="chest" title="${esc(W.STRUCT_TIP)}">${esc(W.CHANGE_REF_HINT)}</i>` : ''}</span></div>`
}

// ── the removed list of the 内容对比步 (2.3; the control itself is the step bar's 对比 menu) ──────────────────────────
export function removedSectionHtml(removed, refK, open) {
  if (!removed || !removed.length) return ''
  const rows = removed.map((b, j) => {
    const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
    const label = h.label || b.preview || ''
    return `<div class="cblk removed collapsed" data-rm="${j}" data-sec="${esc(b.sec)}"><div class="cbh"><span class="cbrole">${esc(h.role)}</span><span class="cbtag">${esc(tagWord(h.tag) || h.tag)}</span>${label ? `<span class="cblabel" title="${esc(label)}">${esc(label)}</span>` : ''}${ffBadgeHtml(faithOf(b), { tech: b.unaddressable })}<span class="remnote" title="The full text is read back from its location in step ${esc(String(refK ?? '?'))}">removed</span></div><div class="cbc"></div></div>`
  }).join('')
  return `<div class="cwremoved ${open ? 'open' : ''}"><div class="cwremhd" data-navtoggle-rem="1" role="button" tabindex="0">${esc(W.removedList(removed.length, refK ?? '?'))} ▸</div>${open ? `<div class="cwrembody">${rows}</div>` : ''}</div>`
}

// ── ⑤–⑧ the stand-in states ──────────────────────────────────────────────────────────────────────────────────────────
export function pagedOutHtml(s, call) {
  const full = !(call && call.reqIncomplete)
  return `<div class="pagedout"><div class="pohd">${esc(W.PAGED_TITLE)}</div><div class="pobody">${esc(full ? W.PAGED_FULL : W.PAGED_PARTIAL)}</div>` +
    `<div class="poact">${loadStepHtml(s, call, 'id="loadpage"')}</div></div>`
}
const unparsedHtml = (call) => `<div class="cwunparsed"><div class="cwuhd">${esc(W.UNPARSED_TITLE)}</div><div class="cwub">${esc(W.UNPARSED_KEEP)}</div>` +
  (call.errMsg ? techDetailsHtml([['errMsg', call.errMsg]], { id: 'cwu-tech' }) : '') + `</div>`
const noRequestHtml = () => `<div class="cwnoreq">${esc(W.NO_REQUEST)}</div>`
export const loadingHtml = () => `<div class="cwload">${esc(W.LOADING)}</div>`

// ── the window, whole (the pure string; 1.4's whitelist is asserted on this) ─────────────────────────────────────────
export function ctxWindowHtml(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) return loadingHtml() // ⑧ the session has not been read yet
  const fid = callFidelityHtml(call) // ① — its fields exist on every step, paged-out ones included
  if (!call.rec) return fid + noRequestHtml() // ⑦
  if (call.unparsed) return fid + unparsedHtml(call) // ⑥
  if (call.paged_out) return fid + pagedOutHtml(s, call) // ⑤
  const flat = call.flat || []
  s.curFlat = flat
  const winLine = windowLineHtml(flat) // ②
  const refCall = contentRefOf(s) // the 内容对比步: the pinned step, else the 缓存对比步
  const refK = contentRefKOf(s)
  const refFlat = refCall ? blocksOf(refCall) : null
  const diff = refFlat ? keyDiff(refFlat, flat) : null
  const refKeys = diff ? diff.refKeys : null
  const brk = call.cacheBreak
  const line = hasChangeLine(call) ? changeLineHtml(call, changeRefK(s), flat) : ''
  s.curRemoved = (line && diff && diff.removedBlocks.length) ? diff.removedBlocks : []
  const removed = s.curRemoved.length ? removedSectionHtml(s.curRemoved, refK, s.navOpen.has('cwremoved')) : ''
  const mark = (i) => (line && i === brk.idx ? line + removed : '')
  const row = (b, i) => ctxBlockHtml(b, i, { prevKeys: refKeys, open: s.openBlocks.has(i), windowLine: !!winLine, decoded: !!s.decodedView })
  // ③ the sections, in assembly order; the change line stands before the first changed block, inside its turn if folded
  let html = fid + winLine
  let lastSec = null
  const msgStart = flat.findIndex((b) => b.sec === 'messages')
  flat.forEach((b, i) => {
    if (msgStart >= 0 && i >= msgStart) return
    if (b.sec !== lastSec) { html += sectionHeaderHtml(b.sec, flat.filter((x) => x.sec === b.sec), { windowLine: !!winLine }); lastSec = b.sec }
    html += mark(i) + row(b, i)
  })
  if (msgStart >= 0) {
    const turns = messageTurns(flat), lastTi = turns.length - 1
    html += sectionHeaderHtml('messages', flat.filter((x) => x.sec === 'messages'), { windowLine: !!winLine }) +
      `<div class="cwfoldall"><button type="button" class="foldallbtn" data-foldall="open" title="${esc(W.FOLD_ALL_OPEN_TIP)}">${esc(W.FOLD_ALL_OPEN)}</button><button type="button" class="foldallbtn" data-foldall="close" title="${esc(W.FOLD_ALL_CLOSE_TIP)}">${esc(W.FOLD_ALL_CLOSE)}</button></div>`
    turns.forEach((t, ti) => {
      const open = turnIsOpen(s.turnFold, flat, t, ti, lastTi, s.turnLanded)
      html += `<div class="cwturn ${open ? '' : 'collapsed'}" data-turn="${ti}" data-anchor="${esc(turnAnchorKey(flat, t))}">` +
        `<div class="cwturnhd"><span class="cwturnq" title="${esc(t.label)}">${t.query ? '<span class="qlabel">prompt</span>' : ''}${esc(t.label)}${t.acts ? `<span class="qk">${esc(t.acts)}</span>` : ''}</span><span class="cwturnn">${t.items.length} blocks</span></div>` +
        `<div class="cwturnbody">${t.items.map((i) => mark(i) + row(flat[i], i)).join('')}</div></div>`
    })
  }
  return html + replySegmentHtml(s, call) // ⑨
}

// ── ⑨ this step's reply (2.3 §这一步的回复): one header (the word · the ONE fidelity mark · the stop reason), then one block
// row per part (thinking → text → each tool call) through the request's row component. A reply row is not a request block:
// no data-bi / data-rk / data-sec / data-ff, no 新 / cache / volatile / per-row fidelity marks. Default open = the rows of
// the first present kind among text → tool call → thinking; 'reply:<j>' in s.openBlocks = the reader flipped row j.
const REPLY_OPEN_ORDER = ['text', 'tool_use', 'thinking']
const replyTag = (p) => (p.kind === 'tool_use' ? 'action · ' + (p.block.name || '') : p.kind === 'thinking' ? 'thinking' : 'say')
// a tool call's preview is the first string among its arguments, else their JSON — never a branch on a parameter's name
function replyPreview(p) {
  const b = p.block
  let t = p.kind === 'thinking' ? b.thinking : p.kind === 'text' ? b.text : null
  if (t == null) { const v = Object.values(b.input && typeof b.input === 'object' ? b.input : {}).find((x) => typeof x === 'string'); t = v != null ? v : JSON.stringify(b.input ?? {}) }
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 90)
}
function replyRowsOpen(parts) {
  const first = REPLY_OPEN_ORDER.find((k) => parts.some((p) => p.kind === k))
  return parts.map((p) => p.kind === first)
}
export function replySegmentHtml(s, call) {
  const r = replyOf(call)
  if (r.failed) return `<div class="cwreply"><div class="cwrhd"><b>${esc(W.REPLY_WORD)}</b> · ${esc(W.FAILED_NO_REPLY)}${r.failed.reason ? techDetailsHtml([['reason', r.failed.reason]], { id: 'cwfail' }) : ''}</div></div>`
  const head = `<div class="cwrhd"><b>${esc(W.REPLY_WORD)}</b>${replyMarkHtml(call)}${r.stop ? `<span>${W.stopReasonRow(`<span class="mono">${esc(r.stop)}</span>`)}</span>` : ''}</div>`
  const dflt = replyRowsOpen(r.parts)
  const rows = r.parts.map((p, j) => {
    const open = dflt[j] !== s.openBlocks.has('reply:' + j)
    const b = { sec: 'reply', block: p.block }
    return blockRowHtml({ role: 'assistant', tag: replyTag(p), label: replyPreview(p) }, {
      cls: `r-assistant k-${p.kind}`, attrs: ` data-rp="${j}"`, chars: rawContentText(p.block).length, open, body: open ? blockBodyHtml(null, b) : '',
    })
  }).join('')
  return `<div class="cwreply">${head}${rows}</div>`
}

// the 缓存对比步 as a 1-based step number: S12's cacheBreak.refGi when the server names it, else the front-end rule
function changeRefK(s) {
  const lane = s.anchor
  const brk = s.anchor.calls[s.playhead].cacheBreak || {}
  if (brk.refGi != null && lane.giLocal) { const l = lane.giLocal.get(brk.refGi); if (l != null) return l + 1 }
  const ref = cacheRefOf(lane.calls, s.playhead)
  const i = ref ? lane.calls.indexOf(ref) : -1
  return i >= 0 ? i + 1 : null
}

// ── the landing rule (1.4 §打开一步时落在哪): a step 跟随最新 brought in → the reply ⑨; else the 变化线, else the first 「新」 block, else the top ───────────────────
// Pure: it names the target only. It never reorders blocks, and the turn it opens for the landing is NOT written to the
// D12 fold memory (only the reader's own folds are).
export function landingTarget(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed || call.paged_out) return null
  if (s.followLanding) return { reply: true } // 跟随最新 brought this step in: the reader watches the model's newest answer (⑨, drawn with ③)
  const flat = call.flat || []
  const brk = call.cacheBreak
  if (hasChangeLine(call) && brk.idx < flat.length) return { anchor: 'cachebrk', idx: brk.idx }
  const refCall = contentRefOf(s)
  const refFlat = refCall ? blocksOf(refCall) : null
  if (refFlat) {
    const refKeys = new Set(refFlat.map((b) => b.key))
    const i = flat.findIndex((b) => !b.volatile && !refKeys.has(b.key))
    if (i >= 0) return { bi: i }
  }
  return null
}

// ── repaint: write the string, fill open bodies, land once per step ───────────────────────────────────────────────────
export function renderContextWindow(el, s) {
  el.innerHTML = ctxWindowHtml(s)
  hydrate(el, s)
  land(el, s)
}
// an open row whose bytes are not cached yet shows the pending state: fetch them now (a re-render must not strand it)
function hydrate(el, s) {
  for (const pre of el.querySelectorAll('.cblk:not(.collapsed) pre[data-ref]')) {
    const blk = pre.closest('.cblk'), b = s.curFlat[+blk.dataset.bi]
    if (b) fillBody(s.ctx.api, blk.querySelector('.cbc'), b, { decoded: !!s.decodedView })
  }
}
// the landing runs ONCE per step — the first time its blocks are drawable (a paged-out step waits for its page); later
// repaints of the same step (live growth, a fold, opening a block) never scroll again.
function land(el, s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed || call.paged_out) return
  if (s.landedFor !== s.playhead) {
    const t = landingTarget(s)
    if (t && !t.reply) {
      // a target inside a folded turn: open that turn for this display only — the D12 memory records the reader's own folds
      const flat = call.flat || []
      const fi = t.anchor ? (call.cacheBreak ? call.cacheBreak.idx : -1) : t.bi
      const turns = messageTurns(flat)
      const tu = turns.find((x) => x.items.includes(fi))
      if (tu && !turnIsOpen(s.turnFold, flat, tu, turns.indexOf(tu), turns.length - 1, s.turnLanded)) {
        s.turnLanded.add(turnAnchorKey(flat, tu))
        el.innerHTML = ctxWindowHtml(s) // repaint with the turn open, then land
      }
    }
    const node = !t ? null : t.reply ? el.querySelector('.cwreply') : t.anchor ? el.querySelector('#cachebrk') : el.querySelector(`.cblk[data-bi="${t.bi}"]`)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
    s.landedFor = s.playhead
  }
}

// ── interaction ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function toggleCtxBlock(s, blk) {
  if (!blk) return
  const i = +blk.dataset.bi, wasShut = blk.classList.contains('collapsed')
  blk.classList.toggle('collapsed')
  setExpanded(blk, wasShut)
  if (!wasShut) { s.openBlocks.delete(i); return }
  s.openBlocks.add(i)
  const bc = blk.querySelector('.cbc'), b = s.curFlat[i]
  if (bc && b && !bc.dataset.filled) fillBody(s.ctx.api, bc, b, { decoded: !!s.decodedView }) // fillBody owns the flag: a failed fetch leaves it clear, so a reopen asks again
}
const setExpanded = (blk, open) => { const h = blk.querySelector(':scope > .cbh'); if (h) h.setAttribute('aria-expanded', String(open)) }
// a reply row (⑨): its body was drawn with the row (inline), so a toggle only flips it and records the flip against the
// default in s.openBlocks — it never reaches toggleCtxBlock (a reply row has no data-bi)
function toggleReplyRow(s, blk) {
  const key = 'reply:' + blk.dataset.rp, wasShut = blk.classList.contains('collapsed')
  if (s.openBlocks.has(key)) s.openBlocks.delete(key); else s.openBlocks.add(key)
  const call = s.anchor && s.anchor.calls[s.playhead]
  const p = call && replyOf(call).parts[+blk.dataset.rp]
  const bc = blk.querySelector(':scope > .cbc')
  if (wasShut && bc && p && !bc.dataset.filled) { bc.innerHTML = blockBodyHtml(null, { sec: 'reply', block: p.block }); bc.dataset.filled = '1' }
  blk.classList.toggle('collapsed')
  setExpanded(blk, wasShut)
}
// a removed row: same lazy read, but its block belongs to the 内容对比步 (s.curRemoved), not this step's flat
function toggleRemovedBlock(s, blk) {
  if (!blk) return
  const j = +blk.dataset.rm, wasShut = blk.classList.contains('collapsed')
  blk.classList.toggle('collapsed')
  if (!wasShut) return
  const bc = blk.querySelector('.cbc'), b = s.curRemoved && s.curRemoved[j]
  if (bc && b && !bc.dataset.filled) fillBody(s.ctx.api, bc, b, { decoded: !!s.decodedView })
}
// a block inside a collapsed turn: open the turn first (returns whether the window had to be repainted). A jump is the
// reader's own click (an outline row, a resource card — 2.5 §跳转联动), so the open goes into the D12 fold memory and
// persists: an explicitly folded card must not swallow the click (a hidden element cannot be scrolled to). Only the
// AUTOMATIC landing (land() above) opens through the ephemeral set — there an explicit fold still wins (1.4).
export function openTurnFor(el, s, fi) {
  const turns = messageTurns(s.curFlat), lastTi = turns.length - 1
  const ti = turns.findIndex((t) => t.items.includes(fi))
  if (ti >= 0 && !turnIsOpen(s.turnFold, s.curFlat, turns[ti], ti, lastTi, s.turnLanded)) {
    setFold(s.turnFold, turnAnchorKey(s.curFlat, turns[ti]), true); s.persistFold(); renderContextWindow(el, s); return true
  }
  return false
}
// a node inside a folded turn is display:none, and scrolling to it does nothing: open its turn first (returns whether the
// window was repainted). The 变化线 lives in the turn of the first changed block, which is usually not the open (latest) one.
// Same rule as openTurnFor: this runs for the reader's own clicks (「跳到变化处」, the problem pager, a drawer link), so the
// open is written to the D12 fold memory and persists.
export function openTurnOfNode(el, s, node) {
  const turn = node && node.closest ? node.closest('.cwturn.collapsed') : null
  if (!turn) return false
  setFold(s.turnFold, turn.dataset.anchor, true); s.persistFold(); renderContextWindow(el, s); return true
}
function foldAll(el, s, open) {
  for (const t of messageTurns(s.curFlat)) setFold(s.turnFold, turnAnchorKey(s.curFlat, t), !!open)
  s.persistFold(); renderContextWindow(el, s)
}

export function wireCtxWin(el, s) {
  const onClick = (e) => {
    const t = e.target
    const loadpage = t.closest('#loadpage')
    if (loadpage) { s.ensurePage(s.anchor.calls[s.playhead], true); return }
    if (t.closest('[data-navtoggle-rem]')) { if (s.navOpen.has('cwremoved')) s.navOpen.delete('cwremoved'); else s.navOpen.add('cwremoved'); renderContextWindow(el, s); return }
    // the decoded view of JSON bodies is one desk-wide choice: it holds across steps and sessions until toggled back
    if (t.closest('[data-decode]')) { s.decodedView = !s.decodedView; renderContextWindow(el, s); return }
    const fa = t.closest('.foldallbtn')
    if (fa) { foldAll(el, s, fa.dataset.foldall === 'open'); return }
    const th = t.closest('.cwturnhd')
    if (th) { const turn = th.closest('.cwturn'); setFold(s.turnFold, turn.dataset.anchor, turn.classList.contains('collapsed')); s.persistFold(); renderContextWindow(el, s); return }
    const rh = t.closest('.cblk.removed > .cbh')
    if (rh) { toggleRemovedBlock(s, rh.closest('.cblk')); return }
    const rp = t.closest('.cblk[data-rp] > .cbh')
    if (rp) { toggleReplyRow(s, rp.closest('.cblk')); return }
    const bh = t.closest('.cbh')
    if (bh) toggleCtxBlock(s, bh.closest('.cblk'))
  }
  // a row head is a button (2.3 §block 卡): Enter / Space on the head itself opens and closes it like a click
  const onKey = (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.classList || !e.target.classList.contains('cbh')) return
    e.preventDefault(); onClick(e)
  }
  el.addEventListener('click', onClick)
  el.addEventListener('keydown', onKey)
  return () => { el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey) }
}
