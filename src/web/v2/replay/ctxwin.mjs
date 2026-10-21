// replay/ctxwin.mjs — the context window (1.4 中央看板 · 2.3 忠实上下文回放): exactly what the model received this
// call, in assembly order tools → system → messages. The middle column holds the step bar (2.2, above this element) and
// #ctxwin; #ctxwin's children come ONLY from 1.4's whitelist ①–⑨, in order:
//   ① 调用保真行  ② 窗口行  ③ the three sections (with the 变化线 ④ drawn before the first changed block)  ⑥ 解析不出态
//   ⑦ 没有请求态  ⑧ an empty aria-busy frame — ⑥–⑧ stand in for ③④⑨  ⑨ this step's reply (2.3 §这一步的回复), set apart
//   from the request: not a section, not in any count; its parts are block rows drawn by the request's row component.
// The window is a list of keyed units (2.3 §读与画 · 窗口按 bid 打补丁): a request row's key is `bid#occurrence`, a reply row's
// `rp:` + bid, a turn's its anchor; a unit's `html` carries no position (positions ride `set`, written on placement), so a
// step change patches the window and an open row whose bid survives keeps its DOM.
//   ctxWindowUnits(s) → units   ctxWindowHtml(s) = serialize(units)   patchUnits(prev, next) → ops   applyOps(units, ops)
//   renderContextWindow(el, s[, {busy}]) patch + land   wireCtxWin(el, s) listeners
import { esc, bytes } from '../core/fmt.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/replay.mjs'
import { messageTurns, keyDiff, refRowOf, hasChangeLine, callFacts } from './analysis.mjs'
import { contentRefOf, contentRefKOf } from './stepbar.mjs'
import { stepRef } from './lanes.mjs'
import { stepOf } from './model.mjs'
import { setFold, turnAnchorKey, turnIsOpen } from './fold.mjs'
import { ctxBlockHtml, blockRowHtml, fillBody, faithOf, faithNow, ffBadgeHtml, tagWord, bodyFor } from './blocks.mjs'
import { replyOf, replyMarkHtml } from './rawpanel.mjs' // one reply rule, two drawings (2.3 §这一步的回复 · 2.6 §A)

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
// No cache states, no byte offsets (D17①), no attribution. K is the 缓存对比步 (cacheBreak.refRid, else the walk: refRowOf).
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

// ── ⑥ ⑦ ⑧ the stand-in states, and the frames of a step whose lane is not held ─────────────────────────────────────
const unparsedHtml = (call) => `<div class="cwunparsed"><div class="cwuhd">${esc(W.UNPARSED_TITLE)}</div><div class="cwub">${esc(W.UNPARSED_KEEP)}</div>` +
  (call.errMsg ? techDetailsHtml([['errMsg', call.errMsg]], { id: 'cwu-tech' }) : '') + `</div>`
const noRequestHtml = () => `<div class="cwnoreq">${esc(W.NO_REQUEST)}</div>`
// ⑧: no text, no control — an empty frame the skeleton replaces (1.4 ⑧)
export const emptyFrameHtml = () => '<div class="cwbusy" aria-busy="true"></div>'
// the section frames of a step whose lane is not held (2.3 §车道未到手): one per section the row's composition names, sized
// from its bytes (a row ≈ 28 px), no text, aria-busy; the lane's arrival replaces them
const FRAME_SECS = [['tools', ['tools']], ['system', ['system']], ['messages', null]]
export function busyFramesHtml(s, row) {
  const comp = (row && row.comp) || {}, named = new Set(FRAME_SECS.flatMap(([, ks]) => ks || []))
  const size = (ks) => Object.entries(comp).filter(([k]) => (ks ? ks.includes(k) : !named.has(k))).reduce((a, [, v]) => a + (Number(v) || 0), 0)
  const frames = FRAME_SECS.map(([sec, ks]) => [sec, size(ks)]).filter(([, n]) => n > 0)
    .map(([sec, n]) => `<div class="cwframe" data-sec="${sec}" style="--fr:${Math.max(1, Math.min(12, Math.ceil(n / 2000)))}"></div>`).join('')
  return `<div class="cwbusy" aria-busy="true">${frames}</div>`
}

// ── units ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A unit is {key, html, kids?, set?}. A unit with kids carries `KIDS` inside its one [data-kids] element, where the kids go.
const KIDS = '<!--kids-->'
const withSet = (h, set) => (set ? h.replace('>', Object.entries(set).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('') + '>') : h)
const serialOne = (u) => { const h = withSet(u.html, u.set); return u.kids ? h.replace(KIDS, serialize(u.kids)) : h }
export const serialize = (units) => units.map(serialOne).join('')
// the request rows' keys: bid + '#' + its occurrence in the list (the same bid may stand twice)
export function rowKeys(flat) {
  const seen = new Map()
  return flat.map((b) => { const n = seen.get(b.bid) || 0; seen.set(b.bid, n + 1); return `${b.bid}#${n}` })
}
// the turns of a list, each run of consecutive message blocks grouped on its own (indices into the whole list)
function turnsOf(flat) {
  const out = []
  for (let i = 0; i < flat.length;) {
    if (flat[i].sec !== 'messages') { i++; continue }
    let j = i
    while (j < flat.length && flat[j].sec === 'messages') j++
    for (const t of messageTurns(flat.slice(i, j))) out.push({ ...t, items: t.items.map((k) => k + i) })
    i = j
  }
  return out
}
const refNo = (s, row) => { const r = row && stepRef(s.lanes, row.rid); return r ? (r.step ? r.n : r.k) : null }

/** The window as keyed units (pure but for the desk's scratch: s.curFlat / s.curKeys / s.curReply / s.curRemoved). */
export function ctxWindowUnits(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) return [{ key: 'busy', html: emptyFrameHtml() }] // ⑧ the session has not been drawn yet
  const fid = callFidelityHtml(call) // ① — its fields are on the skeleton row, so it shows whether the lane is held or not
  const out = fid ? [{ key: 'fid', html: fid }] : []
  if (!call.rec) return [...out, { key: 'noreq', html: noRequestHtml() }] // ⑦
  if (call.unparsed) return [...out, { key: 'unparsed', html: unparsedHtml(call) }] // ⑥
  const st = s.desk ? stepOf(s.desk, call.rid) : null
  if (!st || !st.held) return [...out, { key: 'frames', html: busyFramesHtml(s, call) }]
  const flat = st.flat, keys = rowKeys(flat)
  s.curFlat = flat; s.curKeys = keys
  const winLine = windowLineHtml(flat) // ②
  if (winLine) out.push({ key: 'win', html: winLine })
  const ref = contentRefOf(s) // the 内容对比步: the pinned step, else the 缓存对比步
  const refFlat = ref && s.desk ? stepOf(s.desk, ref.rid).flat : null // its lane not held: no 「新」, no removed list
  const diff = refFlat ? keyDiff(refFlat, flat) : null
  const brk = call.cacheBreak
  const line = hasChangeLine(call, flat) ? changeLineHtml(call, refNo(s, refRowOf(s.anchor, s.playhead)), flat) : ''
  s.curRemoved = (line && diff && diff.removedBlocks.length) ? diff.removedBlocks : []
  const removed = s.curRemoved.length ? removedSectionHtml(s.curRemoved, contentRefKOf(s), s.navOpen.has('cwremoved')) : ''
  const mark = (i) => (line && i === brk.idx ? [{ key: 'chline', html: line }, ...(removed ? [{ key: 'removed', html: removed }] : [])] : [])
  const row = (b, i) => ({ key: keys[i], set: { 'data-bi': i }, html: ctxBlockHtml(b, { prevKeys: diff ? diff.refKeys : null, open: s.openBlocks.has(keys[i]), windowLine: !!winLine }) })
  // ③ the sections, in list order: a header where the section changes, message blocks grouped into turns (a run of messages
  // is grouped on its own, so a block of another section between messages is drawn in its place, never dropped)
  const turns = turnsOf(flat), lastTi = turns.length - 1, tk = new Map(), hk = new Map()
  const head = (sec) => { const n = hk.get(sec) || 0; hk.set(sec, n + 1); out.push({ key: `sec:${sec}#${n}`, html: sectionHeaderHtml(sec, flat.filter((x) => x.sec === sec), { windowLine: !!winLine }) }) }
  let lastSec = null
  flat.forEach((b, i) => {
    if (b.sec !== lastSec) {
      head(b.sec)
      if (b.sec === 'messages' && hk.get('messages') === 1) out.push({ key: 'foldall', html: `<div class="cwfoldall"><button type="button" class="foldallbtn" data-foldall="open" title="${esc(W.FOLD_ALL_OPEN_TIP)}">${esc(W.FOLD_ALL_OPEN)}</button><button type="button" class="foldallbtn" data-foldall="close" title="${esc(W.FOLD_ALL_CLOSE_TIP)}">${esc(W.FOLD_ALL_CLOSE)}</button></div>` })
      lastSec = b.sec
    }
    if (b.sec !== 'messages') { out.push(...mark(i), row(b, i)); return }
    const ti = turns.findIndex((t) => t.items[0] === i)
    if (ti < 0) return // a later item of a turn already drawn
    const t = turns[ti], open = turnIsOpen(s.turnFold, flat, t, ti, lastTi, s.turnLanded), anchor = turnAnchorKey(flat, t)
    const n = tk.get(anchor) || 0; tk.set(anchor, n + 1)
    out.push({ key: `q:${anchor}#${n}`, set: { 'data-turn': ti },
      html: `<div class="cwturn ${open ? '' : 'collapsed'}" data-anchor="${esc(anchor)}">` +
        `<div class="cwturnhd"><span class="cwturnq" title="${esc(t.label)}">${t.query ? '<span class="qlabel">prompt</span>' : ''}${esc(t.label)}${t.acts ? `<span class="qk">${esc(t.acts)}</span>` : ''}</span><span class="cwturnn">${t.items.length} blocks</span></div>` +
        `<div class="cwturnbody" data-kids>${KIDS}</div></div>`,
      kids: t.items.flatMap((j) => [...mark(j), row(flat[j], j)]) })
  })
  const reply = replyUnit(s, st, call) // ⑨
  return reply ? [...out, reply] : out
}
export const ctxWindowHtml = (s) => serialize(ctxWindowUnits(s))

// ── ⑨ this step's reply (2.3 §这一步的回复): one head (the word · the ONE fidelity mark · the stop reason), then one block row
// per reply definition through the request's row component, its body a cell. A reply row is not a request block: no data-bi /
// data-rk / data-sec / data-ff, no 新 / cache / volatile / per-row fidelity marks. Default open = the rows of the first present
// kind among text → tool call → thinking; a reader's flip is `rp:<bid>` in s.openBlocks, kept while the step stays, reset on
// a step change (2.3:195).
const REPLY_OPEN_ORDER = ['text', 'tool_use', 'thinking']
const replyTag = (d) => (d.kind === 'tool_use' ? 'action · ' + (d.name || '') : d.kind === 'thinking' ? 'thinking' : 'say')
export const replyDef = (d) => ({ ...d, text_ref: d.ref })
function replyUnit(s, st, call) {
  if (s.replyFor !== call.rid) { for (const k of [...s.openBlocks]) if (String(k).startsWith('rp:')) s.openBlocks.delete(k); s.replyFor = call.rid }
  const r = replyOf({ row: call, reply: st.reply, detail: st.detail })
  if (r.failed) return { key: 'reply', html: `<div class="cwreply"><div class="cwrhd"><b>${esc(W.REPLY_WORD)}</b> · ${esc(W.FAILED_NO_REPLY)}${r.failed.reason ? techDetailsHtml([['reason', r.failed.reason]], { id: 'cwfail' }) : ''}</div></div>` }
  const head = `<div class="cwrhd"><b>${esc(W.REPLY_WORD)}</b>${replyMarkHtml(r)}${r.stop ? `<span>${W.stopReasonRow(`<span class="mono">${esc(r.stop)}</span>`)}</span>` : ''}</div>`
  const first = REPLY_OPEN_ORDER.find((k) => r.parts.some((d) => d.kind === k))
  s.curReply = new Map()
  const seen = new Map()
  const kids = r.parts.map((d) => {
    const n = seen.get(d.bid) || 0; seen.set(d.bid, n + 1)
    const key = 'rp:' + d.bid + (n ? '#' + n : ''), b = replyDef(d)
    s.curReply.set(key, b)
    const open = (d.kind === first) !== s.openBlocks.has(key)
    return { key, html: blockRowHtml({ role: 'assistant', tag: replyTag(d), label: d.preview || '' }, {
      cls: `r-assistant k-${esc(d.kind)}`, attrs: ` data-rp="${esc(key)}"`, chars: typeof d.chars === 'number' ? d.chars : null, open, body: open ? bodyFor(b) : '' }) }
  })
  return { key: 'reply', html: `<div class="cwreply">${head}<div class="cwrrows" data-kids>${KIDS}</div></div>`, kids }
}

// ── the DOM applier: a node whose unit is unchanged is never touched ─────────────────────────────────────────────────
const slotOf = (n) => (n.matches('[data-kids]') ? n : n.querySelector('[data-kids]'))
function build(u) {
  const t = document.createElement('template')
  t.innerHTML = withSet(u.kids ? u.html.replace(KIDS, '') : u.html, u.set)
  const n = t.content.firstElementChild
  n.__k = u.key
  if (u.kids) slotOf(n).append(...u.kids.map(build))
  return n
}
function domApply(box, ops) {
  const at = new Map([...box.children].map((c) => [c.__k, c]))
  for (const [op, key, a, b] of ops) {
    const n = at.get(key)
    if (op === 'del') { n.remove(); at.delete(key) }
    else if (op === 'put' || op === 'move') { const x = op === 'put' ? build(a) : n, p = at.get(op === 'put' ? b : a); box.insertBefore(x, p ? p.nextSibling : box.firstChild); at.set(key, x) }
    else if (op === 'set') for (const [k, v] of Object.entries(a || {})) n.setAttribute(k, String(v))
    else if (op === 'wrap') { const x = build({ key, html: a, kids: [] }); slotOf(x).append(...slotOf(n).children); for (const k of n.getAttributeNames()) if (k.startsWith('data-') && !x.hasAttribute(k)) x.setAttribute(k, n.getAttribute(k)); n.replaceWith(x); at.set(key, x) }
    else if (op === 'kids') domApply(slotOf(n), a)
  }
}
// tag a freshly written window's nodes with their unit keys (the first paint is one innerHTML)
function tag(box, units) { [...box.children].forEach((c, i) => { const u = units[i]; if (!u) return; c.__k = u.key; if (u.kids) tag(slotOf(c), u.kids) }) }

// ── repaint: patch to the units, fill open bodies, land once per step ────────────────────────────────────────────────
// A step whose lane is not held keeps the rows already drawn unless `busy` (the desk's 150 ms decision, 2.3 §车道未到手).
export function renderContextWindow(el, s, { busy = false } = {}) {
  const units = ctxWindowUnits(s)
  if (!busy && el.__units && units.some((u) => u.key === 'frames')) return
  paint(el, units)
  hydrate(el, s)
  land(el, s)
}
function paint(el, units) {
  // patch only a window this module drew last (anyone who wrote el.innerHTML since gets a fresh paint)
  const live = typeof document !== 'undefined' && el.children && el.__units && el.children.length === el.__units.length && el.__units.every((u, i) => el.children[i].__k === u.key)
  if (live) domApply(el, patchUnits(el.__units, units))
  else { el.innerHTML = serialize(units); if (el.children && typeof document !== 'undefined') tag(el, units) }
  el.__units = units
}
// an open row whose bytes are not cached yet shows the pending cell: fetch them now (a re-render must not strand it)
function hydrate(el, s) {
  if (!el.querySelectorAll || !s.ctx || !s.ctx.api) return
  for (const pre of el.querySelectorAll('.cblk:not(.collapsed) > .cbc pre[data-ref]')) {
    const blk = pre.closest('.cblk'), b = blk.dataset.rp ? s.curReply && s.curReply.get(blk.dataset.rp) : s.curFlat[+blk.dataset.bi]
    if (b) fillBody(s.ctx.api, blk.querySelector(':scope > .cbc'), b)
  }
}

// ── the landing rule (1.4 §打开一步时落在哪): a step 跟随最新 brought in → the reply ⑨; else the 变化线, else the first 「新」
// block, else the top. Pure: it names the target only; it never reorders blocks.
export function landingTarget(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed) return null
  const st = s.desk ? stepOf(s.desk, call.rid) : null
  if (!st || !st.held) return null
  if (s.followLanding) return { reply: true } // 跟随最新 brought this step in: the reader watches the model's newest answer
  const flat = st.flat
  const brk = call.cacheBreak
  if (hasChangeLine(call, flat)) return { anchor: 'cachebrk', idx: brk.idx }
  const ref = contentRefOf(s)
  const refFlat = ref ? stepOf(s.desk, ref.rid).flat : null
  if (refFlat) {
    const refKeys = new Set(refFlat.map((b) => b.key))
    const i = flat.findIndex((b) => !b.volatile && !refKeys.has(b.key))
    if (i >= 0) return { bi: i }
  }
  return null
}
// the landing runs ONCE per rid, the first time its lane is held; later repaints of the same step never scroll again. A target
// inside a folded turn opens that turn for this display only (s.turnLanded) — the D12 memory records the reader's own folds.
function land(el, s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || s.landedFor === call.rid || !call.rec || call.unparsed || !s.desk || !stepOf(s.desk, call.rid).held) return
  s.landedFor = call.rid
  const t = landingTarget(s)
  if (t && !t.reply) {
    const flat = s.curFlat, fi = t.anchor ? t.idx : t.bi
    const turns = turnsOf(flat), tu = turns.find((x) => x.items.includes(fi))
    if (tu && !turnIsOpen(s.turnFold, flat, tu, turns.indexOf(tu), turns.length - 1, s.turnLanded)) { s.turnLanded.add(turnAnchorKey(flat, tu)); paint(el, ctxWindowUnits(s)) }
  }
  const node = !t || !el.querySelector ? null : t.reply ? el.querySelector('.cwreply') : t.anchor ? el.querySelector('#cachebrk') : el.querySelector(`.cblk[data-bi="${t.bi}"]`)
  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
}

// ── interaction ───────────────────────────────────────────────────────────────────────────────────────────────────────
const setExpanded = (blk, open) => { const h = blk.querySelector(':scope > .cbh'); if (h) h.setAttribute('aria-expanded', String(open)) }
// a request row: open state by key (bid#occurrence), so it survives a step change while the bid stays in the list
export function toggleCtxBlock(s, blk) {
  if (!blk) return
  const i = +blk.dataset.bi, wasShut = blk.classList.contains('collapsed'), key = (s.curKeys || rowKeys(s.curFlat))[i]
  blk.classList.toggle('collapsed')
  setExpanded(blk, wasShut)
  if (!wasShut) { s.openBlocks.delete(key); return }
  s.openBlocks.add(key)
  const bc = blk.querySelector('.cbc'), b = s.curFlat[i]
  if (bc && b && !bc.dataset.filled) fillBody(s.ctx.api, bc, b) // fillBody owns the flag: a failed fetch leaves it clear, so a reopen asks again
}
// a reply row: the flip against the default is recorded as its key in s.openBlocks
function toggleReplyRow(s, blk) {
  const key = blk.dataset.rp, wasShut = blk.classList.contains('collapsed')
  if (s.openBlocks.has(key)) s.openBlocks.delete(key); else s.openBlocks.add(key)
  const bc = blk.querySelector(':scope > .cbc'), b = s.curReply && s.curReply.get(key)
  blk.classList.toggle('collapsed')
  setExpanded(blk, wasShut)
  if (wasShut && bc && b && !bc.dataset.filled) fillBody(s.ctx.api, bc, b)
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
// reader's own click (an outline row, a resource card — 2.5 §跳转联动), so the open goes into the D12 fold memory.
export function openTurnFor(el, s, fi) {
  const turns = turnsOf(s.curFlat), lastTi = turns.length - 1
  const ti = turns.findIndex((t) => t.items.includes(fi))
  if (ti >= 0 && !turnIsOpen(s.turnFold, s.curFlat, turns[ti], ti, lastTi, s.turnLanded)) {
    setFold(s.turnFold, turnAnchorKey(s.curFlat, turns[ti]), true); s.persistFold(); renderContextWindow(el, s); return true
  }
  return false
}
// a node inside a folded turn is display:none: open its turn first (the reader's own click, written to the D12 memory)
export function openTurnOfNode(el, s, node) {
  const turn = node && node.closest ? node.closest('.cwturn.collapsed') : null
  if (!turn) return false
  setFold(s.turnFold, turn.dataset.anchor, true); s.persistFold(); renderContextWindow(el, s); return true
}
function foldAll(el, s, open) {
  for (const t of turnsOf(s.curFlat)) setFold(s.turnFold, turnAnchorKey(s.curFlat, t), !!open)
  s.persistFold(); renderContextWindow(el, s)
}

export function wireCtxWin(el, s) {
  const onClick = (e) => {
    const t = e.target
    if (t.closest('[data-navtoggle-rem]')) { if (s.navOpen.has('cwremoved')) s.navOpen.delete('cwremoved'); else s.navOpen.add('cwremoved'); renderContextWindow(el, s); return }
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

// ── the patch: ops over keyed units (pure) ────────────────────────────────────────────────────────────────────────────
// ['del', key] · ['put', key, unit, after] (a new node after sibling `after`, null = first) · ['move', key, after] ·
// ['wrap', key, html] (a container's own html; its kids stay) · ['set', key, set|null] · ['kids', key, ops]. A unit whose key
// survives with the same html and set, in its order, gets no op at all.
const sameSet = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
function stableKeys(prev, next) { // the survivors that keep their relative order: a longest increasing run of prev positions
  const at = new Map(prev.map((u, i) => [u.key, i])), seq = next.map((u) => at.get(u.key)).filter((i) => i != null)
  const tails = [], link = new Array(seq.length)
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]] < v) lo = m + 1; else hi = m }
    link[i] = lo ? tails[lo - 1] : -1; tails[lo] = i
  })
  const keep = new Set()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = link[i]) keep.add(prev[seq[i]].key)
  return keep
}
export function patchUnits(prev, next) {
  const P = new Map(prev.map((u) => [u.key, u])), N = new Set(next.map((u) => u.key)), keep = stableKeys(prev, next), ops = []
  for (const u of prev) if (!N.has(u.key)) ops.push(['del', u.key])
  let after = null
  for (const u of next) {
    const p = P.get(u.key)
    if (!p || !!p.kids !== !!u.kids || (!u.kids && p.html !== u.html)) { if (p) ops.push(['del', u.key]); ops.push(['put', u.key, u, after]) }
    else {
      if (!keep.has(u.key)) ops.push(['move', u.key, after])
      if (u.kids && p.html !== u.html) ops.push(['wrap', u.key, u.html])
      if (!sameSet(p.set, u.set)) ops.push(['set', u.key, u.set ?? null])
      if (u.kids) { const k = patchUnits(p.kids, u.kids); if (k.length) ops.push(['kids', u.key, k]) }
    }
    after = u.key
  }
  return ops
}
const placeAfter = (arr, x, after) => { const i = after == null ? 0 : arr.findIndex((u) => u.key === after) + 1; arr.splice(i, 0, x) }
export function applyOps(tree, ops) {
  const arr = tree.slice(), find = (k) => arr.findIndex((u) => u.key === k)
  for (const [op, key, a, b] of ops) {
    const i = find(key)
    if (op === 'del') arr.splice(i, 1)
    else if (op === 'put') placeAfter(arr, a, b)
    else if (op === 'move') { const [x] = arr.splice(i, 1); placeAfter(arr, x, a) }
    else if (op === 'wrap') arr[i] = { ...arr[i], html: a }
    else if (op === 'set') { const { set, ...x } = arr[i]; arr[i] = a == null ? x : { ...x, set: a } }
    else if (op === 'kids') arr[i] = { ...arr[i], kids: applyOps(arr[i].kids, a) }
  }
  return arr
}
