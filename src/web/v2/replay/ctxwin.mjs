// replay/ctxwin.mjs — the context window (1.4 中央看板 · 2.3 忠实上下文回放): exactly what the model received this
// call, in assembly order tools → system → messages. The middle column holds the step bar (2.2, above this element) and
// #ctxwin; #ctxwin's children come ONLY from 1.4's whitelist ①–⑨, in order:
//   ① 调用保真行  ② 窗口行  ③ the three sections (with the 变化线 ④ drawn before the first changed block)  ⑥ 解析不出态
//   ⑦ 没有请求态  ⑧ an empty aria-busy frame — ⑥–⑧ stand in for ③④⑨  ⑨ this step's reply (2.3 §这一步的回复), set apart
//   from the request: not a section, not in any count; its parts are block rows drawn by the request's row component.
// The window is a list of keyed units (2.3 §读与画 · 窗口按 bid 打补丁): a request row's key is `bid#occurrence`, a reply row's
// `rp:` + bid, a turn's its anchor; a unit's `html` carries no position (positions ride `set`, written on placement), so a
// step change patches the window and an open row whose bid survives keeps its DOM.
//   ctxWindowUnits(s) → units   swapGroup(units, s, key[, draw]) → [units, ops]   ctxWindowHtml(s) = serialize(units)   (units, their patch and the DOM applier: core/units.mjs)
//   renderContextWindow(el, s[, {busy}]) patch + land   wireCtxWin(el, s) listeners
import { esc, bytes } from '../core/fmt.mjs'
import { KIDS, serialize, patchInto } from '../core/units.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/replay.mjs'
import { messageTurns, keyDiff, refRowOf, hasChangeLine, callFacts } from './analysis.mjs'
import { contentRefOf, contentRefKOf } from './stepbar.mjs'
import { stepRef } from './lanes.mjs'
import { stepOf } from './model.mjs'
import { setFold, turnAnchorKey, turnIsOpen } from './fold.mjs'
import { ctxBlockHtml, blockRowHtml, fillBody, showBody, faithOf, faithNow, ffBadgeHtml, tagWord, bodyFor, openedFf, bodyCache } from './blocks.mjs'
import { replyOf, partMark } from './rawpanel.mjs' // one reply rule, two drawings (2.3 §这一步的回复 · 2.6 §A)

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
// ⑧: no text, no control — an empty frame the skeleton replaces (1.4 ⑧); `n` > 0 sizes it for that many rows (2.3 §大致页面: head.last.n)
export const emptyFrameHtml = (n = 0) => `<div class="cwbusy" aria-busy="true"${n > 0 ? ` style="--n:${n}"` : ''}></div>`
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

// the request rows' keys: bid + '#' + its occurrence in the list (the same bid may stand twice)
export function rowKeys(flat) {
  const seen = new Map()
  return flat.map((b) => { const n = seen.get(b.bid) || 0; seen.set(b.bid, n + 1); return `${b.bid}#${n}` })
}
// the turns of a list, each run of consecutive message blocks grouped on its own (indices into the whole list), with `at[i]` =
// the turn holding list position i (-1 outside messages). Memoised per list: stepOf hands out one list per step per desk change.
const TURNS = new WeakMap()
function turnsOf(flat) {
  let T = TURNS.get(flat)
  if (T) return T
  const list = [], at = new Int32Array(flat.length).fill(-1)
  for (let i = 0; i < flat.length;) {
    if (flat[i].sec !== 'messages') { i++; continue }
    let j = i
    while (j < flat.length && flat[j].sec === 'messages') j++
    for (const t of messageTurns(flat.slice(i, j))) { const items = t.items.map((k) => k + i); for (const k of items) at[k] = list.length; list.push({ ...t, items }) }
    i = j
  }
  TURNS.set(flat, T = { list, at })
  return T
}
const turnOpen = (s, flat, T, ti) => turnIsOpen(s.turnFold, flat, T.list[ti], ti, T.list.length - 1, s.turnLanded)
const refNo = (s, row) => { const r = row && stepRef(s.lanes, row.rid); return r ? (r.step ? r.n : r.k) : null }

// a closed request row's html is a function of its definition (content-addressed by bid) and three marks: kept per definition
const ROWS = new WeakMap()
function rowHtml(s, b, prevKeys, open, windowLine) {
  const d = !open && s.desk && s.desk.defs && s.desk.defs.get(b.bid)
  if (!d) return ctxBlockHtml(b, { prevKeys, open, windowLine })
  const k = (b.volatile ? 1 : 0) | (prevKeys && !b.volatile && !prevKeys.has(b.key) ? 2 : 0) | (windowLine ? 4 : 0)
  let m = ROWS.get(d)
  if (!m) ROWS.set(d, m = new Map())
  let h = m.get(k)
  if (h == null) m.set(k, h = ctxBlockHtml(b, { prevKeys, open, windowLine }))
  return h
}

// the rows of an open turn go in groups (2.3 §读与画「长对话的窗口」 rule 4): a boundary before a row whose key hashes to 0 mod
// GROUP_MOD, at most GROUP_CAP rows, so an insert or a delete moves one group. A group not drawn is a placeholder sized by its
// row count (it only ever holds closed rows), aria-busy, no text, no control.
const GROUP_MOD = 50, GROUP_CAP = 200, ROW_BUDGET = 200
const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0 }
const GROUP_HTML = `<div class="cwgroup" data-kids>${KIDS}</div>`
const holderHtml = (n) => `<div class="cwgroup" aria-busy="true" style="--n:${n}"></div>`

/** The window as keyed units (pure but for the desk's scratch: s.curFlat / s.curKeys / s.curReply / s.curRemoved / s.drawn,
 * and s.later: each placeholder's rows, built, by group key — what swapGroup draws in its place).
 * `all`: every group drawn (the full draw). Otherwise the groups drawn are s.drawn's, those holding an open row or the change
 * line, and — given `focus` (a list position) — the focus's group and its nearest neighbours up to ROW_BUDGET rows. */
export function ctxWindowUnits(s, { all = false, focus = null } = {}) {
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
  const prevKeys = diff ? diff.refKeys : null
  const row = (b, i) => ({ key: keys[i], set: { 'data-bi': i }, html: rowHtml(s, b, prevKeys, s.openBlocks.has(keys[i]), !!winLine) })
  // ③ the sections, in list order: a header where the section changes, message blocks grouped into turns (a run of messages
  // is grouped on its own, so a block of another section between messages is drawn in its place, never dropped)
  const T = turnsOf(flat), tk = new Map(), hk = new Map(), bySec = new Map(), groups = []
  for (const b of flat) { if (!bySec.has(b.sec)) bySec.set(b.sec, []); bySec.get(b.sec).push(b) }
  const head = (sec) => { const n = hk.get(sec) || 0; hk.set(sec, n + 1); out.push({ key: `sec:${sec}#${n}`, html: sectionHeaderHtml(sec, bySec.get(sec), { windowLine: !!winLine }) }) }
  let lastSec = null
  flat.forEach((b, i) => {
    if (b.sec !== lastSec) {
      head(b.sec)
      if (b.sec === 'messages' && hk.get('messages') === 1) out.push({ key: 'foldall', html: `<div class="cwfoldall"><button type="button" class="foldallbtn" data-foldall="open" title="${esc(W.FOLD_ALL_OPEN_TIP)}">${esc(W.FOLD_ALL_OPEN)}</button><button type="button" class="foldallbtn" data-foldall="close" title="${esc(W.FOLD_ALL_CLOSE_TIP)}">${esc(W.FOLD_ALL_CLOSE)}</button></div>` })
      lastSec = b.sec
    }
    if (b.sec !== 'messages') { out.push(...mark(i), row(b, i)); return }
    const ti = T.at[i], t = T.list[ti]
    if (t.items[0] !== i) return // a later item of a turn already drawn
    const open = turnOpen(s, flat, T, ti), anchor = turnAnchorKey(flat, t)
    const n = tk.get(anchor) || 0; tk.set(anchor, n + 1)
    const kids = []
    if (open) { // a folded turn draws its head only (rule 2); an open one its rows, in groups
      let g = null
      for (const j of t.items) {
        if (!g || g.rows.length >= GROUP_CAP || hash(keys[j]) % GROUP_MOD === 0) { g = { key: 'g:' + keys[j], at: j, rows: [], must: false }; groups.push(g); kids.push(g) }
        const m = mark(j)
        g.rows.push(...m, row(flat[j], j)); g.n = (g.n || 0) + 1
        if (m.length || s.openBlocks.has(keys[j]) || (s.drawn && s.drawn.has(g.key))) g.must = true
      }
    }
    out.push({ key: `q:${anchor}#${n}`, set: { 'data-turn': ti },
      html: `<div class="cwturn ${open ? '' : 'collapsed'}" data-anchor="${esc(anchor)}">` +
        `<div class="cwturnhd"><span class="cwturnq" title="${esc(t.label)}">${t.query ? '<span class="qlabel">prompt</span>' : ''}${esc(t.label)}${t.acts ? `<span class="qk">${esc(t.acts)}</span>` : ''}</span><span class="cwturnn">${t.items.length} blocks</span></div>` +
        `<div class="cwturnbody" data-kids>${KIDS}</div></div>`,
      kids })
  })
  drawPlan(groups, all, focus)
  s.drawn = new Set(groups.filter((g) => g.drawn).map((g) => g.key))
  s.later = new Map(groups.filter((g) => !g.drawn).map((g) => [g.key, g.rows]))
  for (const g of groups) { g.html = g.drawn ? GROUP_HTML : holderHtml(g.n); if (g.drawn) g.kids = g.rows; delete g.rows; delete g.at; delete g.n; delete g.must; delete g.drawn }
  const reply = replyUnit(s, st, call) // ⑨
  return reply ? [...out, reply] : out
}
// which groups are drawn: every one under `all`; else the ones that must be, the focus's group, then its nearest neighbours
// (alternating after / before) until ROW_BUDGET rows are drawn
function drawPlan(groups, all, focus) {
  for (const g of groups) g.drawn = all || g.must
  if (all || focus == null || !groups.length) return
  let f = groups.findIndex((g, i) => i === groups.length - 1 || groups[i + 1].at > focus)
  let rows = 0, lo = f, hi = f + 1
  groups[f].drawn = true; rows += groups[f].n
  while (rows < ROW_BUDGET && (lo > 0 || hi < groups.length)) {
    if (hi < groups.length) { groups[hi].drawn = true; rows += groups[hi++].n }
    if (rows < ROW_BUDGET && lo > 0) { groups[--lo].drawn = true; rows += groups[lo].n }
  }
}
/** The full draw: every open turn's rows (what the window holds once a fill has run to the end). */
export const ctxWindowHtml = (s) => serialize(ctxWindowUnits(s, { all: true }))

// ── ⑨ this step's reply (2.3 §这一步的回复): one block row per reply definition through the request's row component, in the
// request rows' form — no head; each row its own fidelity mark (partMark, proven rows as a request's: data-ff + screen-reader
// word), the stop reason on the last row's head, the rows a group a screen reader names. A reply row is not a request block:
// no data-bi / data-rk / data-sec, no 新 / cache / volatile marks. Default open = the rows of the first present
// kind among text → tool call → thinking; a reader's flip is `rp:<bid>` in s.openBlocks, kept while the step stays, reset on
// a step change (2.3:195).
const REPLY_OPEN_ORDER = ['text', 'tool_use', 'thinking']
const replyTag = (d) => (d.kind === 'tool_use' ? 'action · ' + (d.name || '') : d.kind === 'thinking' ? 'thinking' : 'say')
export const replyDef = (d) => ({ ...d, text_ref: d.ref })
function replyUnit(s, st, call) {
  if (s.replyFor !== call.rid) { for (const k of [...s.openBlocks]) if (String(k).startsWith('rp:')) s.openBlocks.delete(k); s.replyFor = call.rid }
  const r = replyOf({ row: call, reply: st.reply, detail: st.detail })
  const group = (inner) => ({ key: 'reply', html: `<div class="cwreply" role="group" aria-label="${esc(W.REPLY_WORD)}">${inner}</div>` })
  if (r.failed) return group(`<div class="cwrline">${esc(W.FAILED_NO_REPLY)}${r.failed.reason ? techDetailsHtml([['reason', r.failed.reason]], { id: 'cwfail' }) : ''}</div>`)
  const stop = r.stop ? `<span class="cbstop">${W.stopReasonRow(`<span class="mono">${esc(r.stop)}</span>`)}</span>` : ''
  // no part: empty only when the bytes are whole; otherwise nothing is claimed about the content (the call line says why)
  if (!r.parts.length) return group(`<div class="cwrline">${esc(r.mark === 'partial' ? W.UNREAD_REPLY : W.EMPTY_REPLY)}${stop}</div>`)
  const first = REPLY_OPEN_ORDER.find((k) => r.parts.some((d) => d.kind === k))
  s.curReply = new Map()
  const seen = new Map()
  const kids = r.parts.map((d, i) => {
    const n = seen.get(d.bid) || 0; seen.set(d.bid, n + 1)
    const key = 'rp:' + d.bid + (n ? '#' + n : ''), b = replyDef(d)
    s.curReply.set(key, b)
    // an opened body that came back unproven outranks the span's proof, on every repaint (2.3 §保真标, as faithNow for a request row)
    const open = (d.kind === first) !== s.openBlocks.has(key), f = (open && openedFf(bodyCache.get(b.text_ref))) || partMark(d) || 'verbatim'
    const mark = f === 'verbatim' ? `<span class="sr-only">,${esc(W.FF_WORD.verbatim)}</span>` : ffBadgeHtml(f)
    return { key, html: blockRowHtml({ role: 'assistant', tag: replyTag(d), label: d.preview || '' }, {
      cls: `r-assistant k-${esc(d.kind)}`, attrs: ` data-rp="${esc(key)}" data-ff="${f}"`, badges: mark + (i === r.parts.length - 1 ? stop : ''),
      chars: typeof d.chars === 'number' ? d.chars : null, open, body: open ? bodyFor(b) : '' }) }
  })
  return { ...group(`<div class="cwrrows" data-kids>${KIDS}</div>`), kids }
}
// ── repaint: patch to the units, fill open bodies, land once per step, then fill the placeholders ──────────────────────
// A step whose lane is not held keeps the rows already drawn unless `busy` (the desk's 150 ms decision, 2.3 §车道未到手).
// `focus`: a list position whose group is drawn now (a jump); otherwise the landing target, else the row at the window's top.
export function renderContextWindow(el, s, { busy = false, focus = null } = {}) {
  el.__gen = (el.__gen || 0) + 1
  const t = landingDue(s)
  const units = ctxWindowUnits(s, { focus: focus ?? (t ? t.fi : null) ?? topRow(el, s) ?? 0 })
  if (!busy && el.__units && units.some((u) => u.key === 'frames')) return
  paint(el, units)
  hydrate(el, s)
  if (t) land(el, s, t)
  settle(el, s)
}
const isGroup = (u) => u.html.startsWith('<div class="cwgroup"')
const ridNow = (s) => { const c = s.anchor && s.anchor.calls[s.playhead]; return c ? c.rid : null }
const yieldNow = () => (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function' ? globalThis.scheduler.yield()
  : typeof MessageChannel === 'function' ? new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r() }; c.port2.postMessage(0) })
    : new Promise((r) => setTimeout(r, 0)))
// inside open cards only the groups within one window height above and below the visible box are rows (2.3 §窗口按 bid 打补丁 ·
// rule 4): one group per task, a placeholder near it drawn, then a drawn group far from it put back to its placeholder — never one
// holding an open row, the change line, the focus or the selection. A newer repaint (el.__gen) ends this run; scrolling starts one.
function settle(el, s) {
  if (typeof document === 'undefined' || !el.getBoundingClientRect || el.__settling === el.__gen) return
  const gen = el.__settling = el.__gen, rid = ridNow(s)
  const run = () => yieldNow().then(() => {
    if (el.__gen !== gen || !el.isConnected || ridNow(s) !== rid) return
    const job = nextJob(el, s)
    if (!job) { el.__settling = null; return }
    paint(el, ...swapGroup(el.__units, s, ...job))
    run()
  })
  run()
}
// [key, draw?] of the group to change next: the first placeholder near the visible box, else the first drawn group far from it
function nextJob(el, s) {
  const box = el.getBoundingClientRect(), h = el.clientHeight || box.height, sel = document.getSelection && document.getSelection()
  let drop = null
  for (const g of el.querySelectorAll('.cwgroup')) {
    const busy = g.hasAttribute('aria-busy'), a = busy ? g : g.firstElementChild, b = busy ? g : g.lastElementChild
    if (!a) continue
    const near = b.getBoundingClientRect().bottom >= box.top - h && a.getBoundingClientRect().top <= box.bottom + h
    if (busy && near) return [g.__k, true]
    if (!busy && !near && !drop && !g.querySelector('.cblk:not(.collapsed), #cachebrk') && !g.contains(document.activeElement) && !(sel && sel.anchorNode && g.contains(sel.anchorNode))) drop = [g.__k, false]
  }
  return drop
}
/** Group `key` drawn (`draw`: its rows from s.later) or put back to its sized placeholder (its rows into s.later): the units and the
 * ops that make that change alone — the whole step is not rebuilt (2.3 §读与画「长对话的窗口」 rule 4). */
export function swapGroup(units, s, key, draw = true) {
  const swap = (us) => {
    for (let i = 0; i < us.length; i++) {
      const u = us[i]
      if (u.key === key) {
        const g = draw ? { key, html: GROUP_HTML, kids: s.later.get(key) } : { key, html: holderHtml(u.kids.length) }
        if (draw) { s.later.delete(key); s.drawn.add(key) } else { s.later.set(key, u.kids); s.drawn.delete(key) }
        const arr = us.slice(); arr[i] = g; return [arr, [['del', key], ['put', key, g, i ? us[i - 1].key : null]]]
      }
      if (u.kids && !isGroup(u)) { const r = swap(u.kids); if (r) { const arr = us.slice(); arr[i] = { ...u, kids: r[0] }; return [arr, [['kids', u.key, r[1]]]] } }
    }
    return null
  }
  return swap(units)
}
// patch only a window this module drew last (anyone who wrote el.innerHTML since gets a fresh paint)
const paint = patchInto
// an open row whose bytes are not cached shows the sized pending cell; the step's own reads fetch them once the playhead rests
// (2.3 §快速拖动). A body whose read failed shows that failure and its reason here.
function hydrate(el, s) {
  if (!el.querySelectorAll || !s.bodyFail || !s.bodyFail.size) return
  for (const pre of el.querySelectorAll('.cblk:not(.collapsed) > .cbc pre[data-ref]')) {
    const blk = pre.closest('.cblk'), b = blk.dataset.rp ? s.curReply && s.curReply.get(blk.dataset.rp) : s.curFlat[+blk.dataset.bi]
    const got = b && s.bodyFail.get(b.text_ref)
    if (got) showBody(blk.querySelector(':scope > .cbc'), b, got)
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
// the landing runs ONCE per rid, the first time its lane is held; later repaints of the same step never scroll again. It is
// decided before the units are built, so the target's group is drawn in the same paint. A target inside a folded turn opens
// that turn for this display only (s.turnLanded) — the D12 memory records the reader's own folds.
function landingDue(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || s.landedFor === call.rid || !call.rec || call.unparsed || !s.desk) return null
  const st = stepOf(s.desk, call.rid)
  if (!st.held) return null
  const t = landingTarget(s), flat = st.flat
  if (!t) return { t, fi: null }
  if (t.reply) return { t, fi: flat.length - 1 }
  const fi = t.anchor ? t.idx : t.bi, T = turnsOf(flat), ti = T.at[fi] ?? -1
  if (ti >= 0 && !turnOpen(s, flat, T, ti)) s.turnLanded.add(turnAnchorKey(flat, T.list[ti]))
  return { t, fi }
}
function land(el, s, { t }) {
  s.landedFor = s.anchor.calls[s.playhead].rid
  const node = !t || !el.querySelector ? null : t.reply ? el.querySelector('.cwreply') : t.anchor ? el.querySelector('#cachebrk') : el.querySelector(`.cblk[data-bi="${t.bi}"]`)
  if (!node || typeof node.scrollIntoView !== 'function') return
  unreal(s)
  const real = typeof node.getBoundingClientRect === 'function' && el.querySelectorAll ? realBand(el, node) : []
  node.scrollIntoView({ block: 'start' })
  // real through one painted frame, so each remembers its real size (contain-intrinsic-size: auto) once off screen again
  s.landReal = real
  const raf = globalThis.requestAnimationFrame, done = () => { if (s.landReal === real) unreal(s) }
  raf ? raf(() => raf(done)) : done()
}
const unreal = (s) => { for (const x of s.landReal || []) x.classList.remove('cwreal'); s.landReal = null }
// A row or card off screen is laid out at its preset size (content-visibility: auto) until it comes on screen, and an open one is far
// taller: scrolled against the preset sizes, the rows the landing passes grow after it and move the target. Those that can share the
// screen with the target are made real (.cwreal) first: within one window height of its top, which holds as each is never shorter than
// its preset. Card by card from the outside in (a card's rows count once the card is real), reading the rects of one level per layout.
function realBand(el, node) {
  const H = el.clientHeight, kids = new Map(), real = []
  for (const x of el.querySelectorAll('.cblk, .cwturn')) {
    const up = x.parentElement.closest('.cwturn'), k = up && el.contains(up) ? up : null
    kids.has(k) ? kids.get(k).push(x) : kids.set(k, [x])
  }
  let level = kids.get(null) || []
  while (level.length) {
    const y = node.getBoundingClientRect().top, lo = y - H, hi = y + H, box = (i) => level[i].getBoundingClientRect()
    let a = 0, b = level.length // in document order the rects go down: the first one whose bottom reaches the band
    while (a < b) { const m = (a + b) >> 1; if (box(m).bottom < lo) a = m + 1; else b = m }
    const hit = []
    for (let i = a; i < level.length && box(i).top <= hi; i++) hit.push(level[i])
    for (const x of hit) x.classList.add('cwreal')
    real.push(...hit)
    level = hit.flatMap((x) => x.classList.contains('collapsed') ? [] : kids.get(x) || [])
  }
  return real
}
// the list position of the row at the window's top (a drawn row, or the first row of a placeholder), from the window drawn now
function topRow(el, s) {
  if (typeof document === 'undefined' || !el.getBoundingClientRect || !s.curKeys) return null
  const r = el.getBoundingClientRect(), y = Math.max(r.top, 0) + 4
  if (y > r.bottom) return null
  const hit = document.elementFromPoint(r.left + r.width / 2, y)
  const blk = hit && hit.closest('.cblk[data-bi], .cwgroup[aria-busy]')
  if (!blk) return null
  if (blk.dataset.bi != null) return +blk.dataset.bi
  const i = s.curKeys.indexOf(String(blk.__k).slice(2))
  return i >= 0 ? i : null
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
  const T = turnsOf(s.curFlat), ti = T.at[fi] ?? -1
  if (ti < 0 || turnOpen(s, s.curFlat, T, ti)) return false
  setFold(s.turnFold, turnAnchorKey(s.curFlat, T.list[ti]), true); s.persistFold(); renderContextWindow(el, s, { focus: fi }); return true
}
// the row at list position fi drawn and reachable (2.3 §读与画「长对话的窗口」 rule 2): its turn opened (the reader's jump, into
// the D12 memory), its group drawn; → its .cblk, or null when the step has no such row
export function ensureRow(el, s, fi) {
  if (!s.curFlat || !s.curFlat[fi]) return null
  const sel = `.cblk[data-bi="${fi}"]`
  if (!openTurnFor(el, s, fi) && !el.querySelector(sel)) renderContextWindow(el, s, { focus: fi })
  return el.querySelector(sel)
}
function foldAll(el, s, open) {
  for (const t of turnsOf(s.curFlat).list) setFold(s.turnFold, turnAnchorKey(s.curFlat, t), !!open)
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
  const onScroll = () => settle(el, s)
  el.addEventListener('click', onClick)
  el.addEventListener('keydown', onKey)
  el.addEventListener('scroll', onScroll, { passive: true })
  return () => { el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); el.removeEventListener('scroll', onScroll) }
}
