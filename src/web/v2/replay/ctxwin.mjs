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
import { ctxBlockHtml, blockRowHtml, fillBody, showBody, faithOf, faithNow, ffBadgeHtml, tagWord, bodyFor } from './blocks.mjs'
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
const serialOne = (u) => { const h = withSet(u.html, u.set); return u.kids ? h.replace(KIDS, () => serialize(u.kids)) : h }
export const serialize = (units) => units.map(serialOne).join('')
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

/** The window as keyed units (pure but for the desk's scratch: s.curFlat / s.curKeys / s.curReply / s.curRemoved / s.drawn).
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
  // its lane's read failed: the K-29 sentence, Retry, the reason in the technical details — never empty frames (2.3 §读失败)
  const why = st && !st.held && s.laneErr ? s.laneErr.get(st.lane) : null
  if (why) return [...out, { key: 'lanefail', html: `<div class="empty" data-fail="lane">${esc(W.STEP_READ_FAILED)}<div class="emptywhy"><button type="button" class="linkbtn" data-retry="1">${esc(W.RETRY)}</button>${techDetailsHtml([['reason', why]], { id: 'lanetech' })}</div></div>` }]
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
    else if (op === 'wrap') morph(n, build({ key, html: a, kids: [] }))
    else if (op === 'kids') domApply(slotOf(n), a)
  }
}
// a container takes its new html in place (2.3 §读与画「长对话的窗口」 rule 3): its attributes become x's (the placed `set` data-*
// attributes stay), every child outside the path to its slot is replaced, and the slot's children are never moved
function morph(n, x) {
  for (const k of n.getAttributeNames()) if (!x.hasAttribute(k) && !k.startsWith('data-')) n.removeAttribute(k)
  for (const k of x.getAttributeNames()) if (n.getAttribute(k) !== x.getAttribute(k)) n.setAttribute(k, x.getAttribute(k))
  if (n.hasAttribute('data-kids')) return
  const ns = [...n.children], xs = [...x.children]
  xs.forEach((c, i) => { const m = ns[i]; if (!m) n.append(c); else if (m.matches('[data-kids]') || m.querySelector('[data-kids]')) morph(m, c); else m.replaceWith(c) })
  for (const m of ns.slice(xs.length)) m.remove()
}
// tag a freshly written window's nodes with their unit keys (the first paint is one innerHTML)
function tag(box, units) { [...box.children].forEach((c, i) => { const u = units[i]; if (!u) return; c.__k = u.key; if (u.kids) tag(slotOf(c), u.kids) }) }

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
  fillLater(el, s)
}
const isGroup = (u) => u.html.startsWith('<div class="cwgroup"')
const holders = (units) => units.some((u) => (isGroup(u) ? !u.kids : !!u.kids && holders(u.kids)))
const ridNow = (s) => { const c = s.anchor && s.anchor.calls[s.playhead]; return c ? c.rid : null }
const yieldNow = () => (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function' ? globalThis.scheduler.yield()
  : typeof MessageChannel === 'function' ? new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r() }; c.port2.postMessage(0) })
    : new Promise((r) => setTimeout(r, 0)))
// the groups not drawn yet, one per task, next to the ones drawn first; a newer repaint (el.__gen) ends this run
function fillLater(el, s) {
  if (typeof document === 'undefined' || !holders(el.__units || [])) return
  const gen = el.__gen, rid = ridNow(s)
  yieldNow().then(() => {
    if (el.__gen !== gen || !el.isConnected || ridNow(s) !== rid) return
    const next = nextHolder(el.__units)
    if (!next) return
    s.drawn.add(next)
    paint(el, ctxWindowUnits(s))
    fillLater(el, s)
  })
}
// the placeholder next to a drawn group (after it, else before it), else the first one
function nextHolder(units) {
  const gs = []
  const walk = (us) => { for (const u of us) { if (isGroup(u)) gs.push(u); else if (u.kids) walk(u.kids) } }
  walk(units)
  const i = gs.findIndex((g, j) => !g.kids && ((gs[j - 1] && gs[j - 1].kids) || (gs[j + 1] && gs[j + 1].kids)))
  const g = gs[i >= 0 ? i : gs.findIndex((x) => !x.kids)]
  return g ? g.key : null
}
function paint(el, units) {
  // patch only a window this module drew last (anyone who wrote el.innerHTML since gets a fresh paint)
  const live = typeof document !== 'undefined' && el.children && el.__units && el.children.length === el.__units.length && el.__units.every((u, i) => el.children[i].__k === u.key)
  if (live) domApply(el, patchUnits(el.__units, units))
  else { el.innerHTML = serialize(units); if (el.children && typeof document !== 'undefined') tag(el, units) }
  el.__units = units
}
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
  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
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
