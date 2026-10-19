// replay/ctxwin.mjs — the context window (1.4 中央看板 · 2.3 忠实上下文回放): exactly what the model received this
// call, in assembly order tools → system → messages. The middle column holds the step bar (2.2, above this element) and
// #ctxwin; #ctxwin's children come ONLY from 1.4's whitelist ①–⑧, in order:
//   ① 调用保真行  ② 窗口行  ③ the three sections (with the 变化线 ④ drawn before the first changed block)  ⑤ 未下发态
//   ⑥ 解析不出态  ⑦ 没有请求态  ⑧ 载入中 — ⑤–⑧ stand in for ③④.
// No window head (step no / model / time / size live in the step bar), no cache states (the 缓存 button owns them), no
// raw-JSON twin (the window IS the truth, AC-1).   renderContextWindow(el, s)  repaint + land   wireCtxWin(el, s)
// listeners.   ctxWindowHtml(s)  the pure string the whitelist tests assert on.
import { esc, bytes } from '../core/fmt.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/replay.mjs'
import { messageTurns, blocksOf, keyDiff, cacheRefOf, hasChangeLine } from './analysis.mjs'
import { contentRefOf, contentRefKOf } from './stepbar.mjs'
import { setFold, saveFold, turnAnchorKey, turnIsOpen } from './fold.mjs'
import { ctxBlockHtml, fillBody, faithOf, faithNow, ffBadgeHtml, tagWord } from './blocks.mjs'

export { blockBodyHtml } from './blocks.mjs'

// ── ① the 调用保真行: one call's fidelity facts, said once, visibly (2.3 §调用保真行; 必拒隐瞒) ─────────────────────
// the flags of one *Incomplete object → its closed-set words, joined; an unknown flag set falls back to 「<请求/消息/回复>没采全」
const flagWords = (obj, TABLE) => Object.entries(TABLE).filter(([k]) => obj && obj[k]).map(([, v]) => v).join(' · ')
export function callFidelityHtml(call) {
  const w = (call && call.wire) || {}
  const facts = []
  const tech = []
  const add = (s) => s && facts.push(s)
  // contextState: the facts are {partial, reconstructed, server_edited}; 'complete' (the server's "nothing wrong")
  // and a missing value say nothing. A partial WITH contextMissing names the record and swallows wsIncomplete.partial
  // (one thing said once); a value outside the set falls back and goes to 技术细节
  if (w.contextState === 'partial') {
    if (w.contextMissing) add(`${W.CTX_FACT.partial}(${w.contextMissing})`)
    else if (!call.reqIncomplete && !(call.wsIncomplete && call.wsIncomplete.partial)) add(`${W.CTX_FACT.partialBare} · ${W.CTX_FACT.unknownWhy}`)
  } else if (w.contextState === 'reconstructed') add(W.CTX_FACT.reconstructed)
  else if (w.contextState === 'server_edited') add(W.CTX_FACT.server_edited)
  else if (w.contextState && w.contextState !== 'complete') { add(W.CTX_FACT.fallback); tech.push(['contextState', w.contextState]) }
  if (call.reqIncomplete) {
    const f = flagWords(call.reqIncomplete, W.REQ_FACT)
    add(`${W.INCOMPLETE_WORD.req}: ${f || 'incomplete'}`)
    if (call.reqIncomplete.text) tech.push(['reqIncomplete', call.reqIncomplete.text])
    if (!f) tech.push(['reqIncomplete', 'unknown flag'])
  }
  if (call.wsIncomplete) {
    const skipPartial = w.contextState === 'partial' && w.contextMissing
    const f = flagWords({ ...call.wsIncomplete, partial: skipPartial ? false : call.wsIncomplete.partial }, W.WS_FACT)
    if (f) add(`${W.INCOMPLETE_WORD.ws}:${f}`)
    else if (!skipPartial) add(`${W.INCOMPLETE_WORD.ws}: incomplete`)
    if (call.wsIncomplete.text) tech.push(['wsIncomplete', call.wsIncomplete.text])
    if (!f && !skipPartial) tech.push(['wsIncomplete', 'unknown flag'])
  }
  if (call.respIncomplete) {
    const f = flagWords(call.respIncomplete, W.RESP_FACT)
    add(`${W.INCOMPLETE_WORD.resp}: ${f || 'incomplete'}`)
    if (call.respIncomplete.text) tech.push(['respIncomplete', call.respIncomplete.text])
    if (!f) tech.push(['respIncomplete', 'unknown flag'])
  }
  // wire.labels: the server's own words, said unless the exact flag above already said the same thing
  const said = new Set([call.respIncomplete && call.respIncomplete.truncated && 'resp-truncated', call.respIncomplete && call.respIncomplete.undecoded && 'resp-undecoded', call.wsIncomplete && call.wsIncomplete.truncated && 'ws-truncated'].filter(Boolean))
  for (const l of (w.labels || [])) { if (!said.has(l.id)) { add(String(l.label || l.id)); if (l.text) tech.push([l.id, l.text]) } }
  if (w.reqEncoding) add(W.reqEncodingFact(w.reqEncoding))
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
    return `<div class="cblk removed collapsed" data-rm="${j}" data-sec="${esc(b.sec)}"><div class="cbh"><span class="cbrole">${esc(h.role)}</span><span class="cbtag">${esc(tagWord(h.tag) || h.tag)}</span>${label ? `<span class="cblabel">${esc(label)}</span>` : ''}${ffBadgeHtml(faithOf(b), { tech: b.unaddressable })}<span class="remnote" title="The full text is read back from its location in step ${esc(String(refK ?? '?'))}">removed</span></div><div class="cbc"></div></div>`
  }).join('')
  return `<div class="cwremoved ${open ? 'open' : ''}"><div class="cwremhd" data-navtoggle-rem="1" role="button" tabindex="0">${esc(W.removedList(removed.length, refK ?? '?'))} ▸</div>${open ? `<div class="cwrembody">${rows}</div>` : ''}</div>`
}

// ── ⑤–⑧ the stand-in states ──────────────────────────────────────────────────────────────────────────────────────────
export function pagedOutHtml(s, call) {
  const full = !(call && call.reqIncomplete)
  return `<div class="pagedout"><div class="pohd">${esc(W.PAGED_TITLE)}</div><div class="pobody">${esc(full ? W.PAGED_FULL : W.PAGED_PARTIAL)} (not sent to this page ≠ lost)</div>` +
    `<div class="poact"><button type="button" class="pobtn" id="loadpage">${esc(W.LOAD_THIS_STEP)}</button></div></div>`
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
  const row = (b, i) => ctxBlockHtml(b, i, { prevKeys: refKeys, open: s.openBlocks.has(i), windowLine: !!winLine })
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
        `<div class="cwturnhd"><span class="cwturnq">${t.query ? '<span class="qlabel">prompt</span>' : ''}${esc(t.label)}${t.acts ? `<span class="qk">${esc(t.acts)}</span>` : ''}</span><span class="cwturnn">${t.items.length} blocks</span></div>` +
        `<div class="cwturnbody">${t.items.map((i) => mark(i) + row(flat[i], i)).join('')}</div></div>`
    })
  }
  return html
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

// ── the landing rule (1.4 §打开一步时落在哪): the 变化线, else the first 「新」 block, else the top ───────────────────
// Pure: it names the target only. It never reorders blocks, and the turn it opens for the landing is NOT written to the
// D12 fold memory (only the reader's own folds are).
export function landingTarget(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed || call.paged_out) return null
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
    if (b) fillBody(s.ctx.api, blk.querySelector('.cbc'), b)
  }
}
// the landing runs ONCE per step — the first time its blocks are drawable (a paged-out step waits for its page); later
// repaints of the same step (live growth, a fold, opening a block) never scroll again.
function land(el, s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed || call.paged_out) return
  if (s.landedFor !== s.playhead) {
    const t = landingTarget(s)
    if (t) {
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
    const node = t ? (t.anchor ? el.querySelector('#cachebrk') : el.querySelector(`.cblk[data-bi="${t.bi}"]`)) : null
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
    s.landedFor = s.playhead
  }
}

// ── interaction ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function toggleCtxBlock(s, blk) {
  if (!blk) return
  const i = +blk.dataset.bi, wasShut = blk.classList.contains('collapsed')
  blk.classList.toggle('collapsed')
  if (!wasShut) { s.openBlocks.delete(i); return }
  s.openBlocks.add(i)
  const bc = blk.querySelector('.cbc'), b = s.curFlat[i]
  if (bc && b && !bc.dataset.filled) fillBody(s.ctx.api, bc, b) // fillBody owns the flag: a failed fetch leaves it clear, so a reopen asks again
}
// a removed row: same lazy read, but its block belongs to the 内容对比步 (s.curRemoved), not this step's flat
function toggleRemovedBlock(s, blk) {
  if (!blk) return
  const j = +blk.dataset.rm, wasShut = blk.classList.contains('collapsed')
  blk.classList.toggle('collapsed')
  if (!wasShut) return
  const bc = blk.querySelector('.cbc'), b = s.curRemoved && s.curRemoved[j]
  if (bc && b && !bc.dataset.filled) fillBody(s.ctx.api, bc, b)
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
    const fa = t.closest('.foldallbtn')
    if (fa) { foldAll(el, s, fa.dataset.foldall === 'open'); return }
    const th = t.closest('.cwturnhd')
    if (th) { const turn = th.closest('.cwturn'); setFold(s.turnFold, turn.dataset.anchor, turn.classList.contains('collapsed')); s.persistFold(); renderContextWindow(el, s); return }
    const rh = t.closest('.cblk.removed > .cbh')
    if (rh) { toggleRemovedBlock(s, rh.closest('.cblk')); return }
    const bh = t.closest('.cbh')
    if (bh) toggleCtxBlock(s, bh.closest('.cblk'))
  }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}
