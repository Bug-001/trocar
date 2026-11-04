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
import { HALF, discChev } from '../core/icons.mjs'
import * as W from '../labels/replay.mjs'
import { READABLE_VIEW } from '../labels/cells.mjs'
import { setFold, turnAnchorKey } from './fold.mjs'
import { ctxBlockHtml, blockRowHtml, fillBody, showBody, faithOf, ffBadgeHtml, tagWord, bodyFor } from './blocks.mjs'
import { stepOf } from './model.mjs'
import { windowItems, landingFor, rowKeys, turnsOf, turnOpen } from '../../src/screens/replay/window-model.mjs' // the window's rules (both desks)

export { blockBodyHtml } from './blocks.mjs'
export { landingTarget, rowKeys } from '../../src/screens/replay/window-model.mjs'

// ── each item's html (the item is the window model's: web/src/screens/replay/window-model.mjs) ──────────────────────────
// ① the 调用保真行: one call's fidelity facts, said once, visibly (2.3 §调用保真行; 必拒隐瞒)
const fidHtml = ({ facts, tech }) => `<div class="cwfline"><span class="cwhalf" aria-hidden="true">${HALF}</span> <span class="cwffacts">${facts.map((f) => esc(f)).join(' · ')}</span>${tech.length ? techDetailsHtml(tech, { id: 'cwf-tech' }) : ''}</div>`
// ② the 窗口行: no block of this step can return to the raw bytes
const winHtml = ({ reasons }) => `<div class="cwwin"><span class="cwhalf" aria-hidden="true">${HALF}</span> ${esc(W.WINDOW_LINE)}${reasons.length ? techDetailsHtml(reasons.map((r, i) => ['reason ' + (i + 1), r]), { id: 'cwwin-tech' }) : ''}</div>`
// ③ the section header: name · block count · size · its claim (以下逐字 · Readable view · just ◐ when the window line is up)
const CLAIM = { half: `<span class="cwsecff" title="${esc(W.WINDOW_LINE)}">${HALF}</span>`, verbatim: `<span class="cwsecff v">${esc(W.SECTION_VERBATIM)}</span>`, readable: `<span class="cwsecff">${esc(READABLE_VIEW)}</span>` }
function secHtml({ sec, n, size, est, claim }) {
  const name = W.SECTION_NAME[sec] || sec // an unknown section's name is data: escaped where it is printed
  return `<div class="cwsec" id="sec-${esc(sec)}"><b>${esc(name)}</b><span class="cwsecn">${esc(String(n))} blocks</span>` +
    `<span class="cwsecsz"${est ? ` title="${esc(W.SECTION_SIZE_EST_TIP)}"` : ` title="${esc(W.SECTION_SIZE_TIP)}"`}>${est ? W.SECTION_SIZE_EST : ''} ${esc(bytes(size))}</span>${(claim && CLAIM[claim]) || ''}</div>`
}
// ④ the 变化线: no cache states, no byte offsets (D17①), no attribution. K is the 缓存对比步 (cacheBreak.refRid, else the walk)
const changeHeadWord = (b) => {
  const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
  const t = tagWord(h.tag)
  return [h.role, t || h.tag, h.label || b.preview || ''].filter(Boolean).join(' · ')
}
function chlineHtml({ k, cause, compaction, inferred, auto, first }) {
  const causeW = compaction ? W.CHANGE_COMPACT + (inferred ? `(${W.CHANGE_COMPACT_INFERRED})` : '') : (W.causeWord(cause))
  const tip = W.changeFirstTip(changeHeadWord(first))
  return `<div class="chline" id="cachebrk" title="${esc(tip)}"><span class="chbar" aria-hidden="true"></span>` +
    `<span class="cht">${esc(W.changeLine(k, causeW))} · <i class="chest" title="${esc(W.STRUCT_TIP)}">${esc(W.STRUCT_EST_WORD)}</i>` +
    `${auto ? ` · <i class="chest" title="${esc(W.STRUCT_TIP)}">${esc(W.CHANGE_REF_HINT)}</i>` : ''}</span></div>`
}
// the removed list of the 内容对比步 (2.3; the control itself is the step bar's 对比 menu)
function removedHtml({ blocks: removed, refK, open }) {
  const rows = removed.map((b, j) => {
    const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
    const label = h.label || b.preview || ''
    return `<div class="cblk removed collapsed" data-rm="${j}" data-sec="${esc(b.sec)}"><div class="cbh"><span class="cbrole">${esc(h.role)}</span><span class="cbtag" title="${esc(tagWord(h.tag) || h.tag)}">${esc(tagWord(h.tag) || h.tag)}</span>${label ? `<span class="cblabel" title="${esc(label)}">${esc(label)}</span>` : ''}${ffBadgeHtml(faithOf(b), { tech: b.unaddressable })}<span class="remnote" title="The full text is read back from its location in step ${esc(String(refK ?? '?'))}">removed</span></div><div class="cbc"></div></div>`
  }).join('')
  return `<div class="cwremoved ${open ? 'open' : ''}"><div class="cwremhd" data-navtoggle-rem="1" role="button" tabindex="0">${discChev(open)} ${esc(W.removedList(removed.length, refK ?? '?'))}</div>${open ? `<div class="cwrembody">${rows}</div>` : ''}</div>`
}
const FOLDALL_HTML = `<div class="cwfoldall"><button type="button" class="foldallbtn" data-foldall="open" title="${esc(W.FOLD_ALL_OPEN_TIP)}">${esc(W.FOLD_ALL_OPEN)}</button><button type="button" class="foldallbtn" data-foldall="close" title="${esc(W.FOLD_ALL_CLOSE_TIP)}">${esc(W.FOLD_ALL_CLOSE)}</button></div>`
const turnHtml = ({ anchor, label, query, acts, n, open }) => `<div class="cwturn ${open ? '' : 'collapsed'}" data-anchor="${esc(anchor)}">` +
  `<div class="cwturnhd"><span class="cwturnq" title="${esc(label)}">${query ? '<span class="qlabel">prompt</span>' : ''}${esc(label)}${acts ? `<span class="qk">${esc(acts)}</span>` : ''}</span><span class="cwturnn">${n} blocks</span></div>` +
  `<div class="cwturnbody" data-kids>${KIDS}</div></div>`
// ⑥ ⑦ ⑧ the stand-in states, and the frames of a step whose lane is not held (2.3 §车道未到手): no text, aria-busy; the
// lane's arrival replaces them
const unparsedHtml = ({ errMsg }) => `<div class="cwunparsed"><div class="cwuhd">${esc(W.UNPARSED_TITLE)}</div><div class="cwub">${esc(W.UNPARSED_KEEP)}</div>` +
  (errMsg ? techDetailsHtml([['errMsg', errMsg]], { id: 'cwu-tech' }) : '') + `</div>`
const noRequestHtml = () => `<div class="cwnoreq">${esc(W.NO_REQUEST)}</div>`
// ⑧: no text, no control — an empty frame the skeleton replaces (1.4 ⑧); `n` > 0 sizes it for that many rows (2.3 §大致页面: head.last.n)
export const emptyFrameHtml = (n = 0) => `<div class="cwbusy" aria-busy="true"${n > 0 ? ` style="--n:${n}"` : ''}></div>`
const framesHtml = ({ frames }) => `<div class="cwbusy" aria-busy="true">${frames.map(({ sec, fr }) => `<div class="cwframe" data-sec="${sec}" style="--fr:${fr}"></div>`).join('')}</div>`
const ONE = { fid: fidHtml, win: winHtml, sec: secHtml, foldall: () => FOLDALL_HTML, chline: chlineHtml, removed: removedHtml, noreq: noRequestHtml, unparsed: unparsedHtml, frames: framesHtml }

// a closed request row's html is a function of its definition (content-addressed by bid) and three marks: kept per definition
const ROWS = new WeakMap()
function rowHtml(s, { b, open, marks }, windowLine) {
  const d = !open && s.desk && s.desk.defs && s.desk.defs.get(b.bid)
  if (!d) return ctxBlockHtml(b, { open, marks })
  const k = (marks.volatile ? 1 : 0) | (marks.isNew ? 2 : 0) | (windowLine ? 4 : 0)
  let m = ROWS.get(d)
  if (!m) ROWS.set(d, m = new Map())
  let h = m.get(k)
  if (h == null) m.set(k, h = ctxBlockHtml(b, { open, marks }))
  return h
}

// the rows of an open turn go in groups (2.3 §读与画「长对话的窗口」 rule 4): a boundary before a row whose key hashes to 0 mod
// GROUP_MOD, at most GROUP_CAP rows, so an insert or a delete moves one group. A group not drawn is a placeholder sized by its
// row count (it only ever holds closed rows), aria-busy, no text, no control.
const GROUP_MOD = 50, GROUP_CAP = 200, ROW_BUDGET = 200
const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0 }
const GROUP_HTML = `<div class="cwgroup" data-kids>${KIDS}</div>`
const holderHtml = (n) => `<div class="cwgroup" aria-busy="true" style="--n:${n}"></div>`

/** The window as keyed units: the model's items (windowItems), an open turn's rows (with the change line among them) as its
 * kids in groups. Pure but for the desk's scratch: the model's, s.drawn, and s.later: each placeholder's rows, built, by group
 * key — what swapGroup draws in its place. `all`: every group drawn (the full draw). Otherwise the groups drawn are s.drawn's,
 * those holding an open row or the change line, and — given `focus` (a list position) — the focus's group and its nearest
 * neighbours up to ROW_BUDGET rows. */
export function ctxWindowUnits(s, { all = false, focus = null } = {}) {
  resetReplyFlips(s)
  const { state, items } = windowItems(s)
  if (state === 'none') return [{ key: 'busy', html: emptyFrameHtml() }] // ⑧ the session has not been drawn yet
  const winLine = items.some((it) => it.type === 'win'), out = [], groups = []
  let turn = null, g = null, pend = [] // the open turn's kids; its current group; the change line waiting for its row
  for (const it of items) {
    if (it.type === 'turn') {
      turn = it.open ? [] : null; g = null
      out.push({ key: it.key, set: { 'data-turn': it.ti }, html: turnHtml(it), kids: turn || [] })
      continue
    }
    const u = it.type === 'row' ? { key: it.key, set: { 'data-bi': it.bi }, html: rowHtml(s, it, winLine) }
      : it.type === 'reply' ? replyUnit(it) : { key: it.key, html: ONE[it.type](it) }
    if (it.type === 'sec' || it.type === 'reply') turn = null
    if (!turn) { out.push(u); continue }
    if (it.type !== 'row') { pend.push(u); continue } // the change line and its removed list go in their row's group
    if (!g || g.rows.length >= GROUP_CAP || hash(it.key) % GROUP_MOD === 0) { g = { key: 'g:' + it.key, at: it.bi, rows: [], n: 0, must: false }; groups.push(g); turn.push(g) }
    g.rows.push(...pend, u); g.n++
    if (pend.length || it.open || (s.drawn && s.drawn.has(g.key))) g.must = true
    pend = []
  }
  drawPlan(groups, all, focus)
  s.drawn = new Set(groups.filter((g) => g.drawn).map((g) => g.key))
  s.later = new Map(groups.filter((g) => !g.drawn).map((g) => [g.key, g.rows]))
  for (const g of groups) { g.html = g.drawn ? GROUP_HTML : holderHtml(g.n); if (g.drawn) g.kids = g.rows; delete g.rows; delete g.at; delete g.n; delete g.must; delete g.drawn }
  return out
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

// ── ⑨ this step's reply (2.3 §这一步的回复): its rows through the request's row component, in the request rows' form — no head;
// each row its own fidelity mark (proven rows as a request's: data-ff + screen-reader word), the stop reason on the last row's
// head, the rows a group a screen reader names. A reply row is not a request block: no data-bi / data-rk / data-sec, no 新 /
// cache / volatile marks. A reader's flip is `rp:<bid>` in s.openBlocks, kept while the step stays, reset on a step change (2.3:195).
function resetReplyFlips(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed || !s.desk || s.replyFor === call.rid || !stepOf(s.desk, call.rid).held) return
  for (const k of [...s.openBlocks]) if (String(k).startsWith('rp:')) s.openBlocks.delete(k)
  s.replyFor = call.rid
}
const replyGroup = (inner) => ({ key: 'reply', html: `<div class="cwreply" role="group" aria-label="${esc(W.REPLY_WORD)}">${inner}</div>` })
function replyUnit({ failed, empty, stop, rows }) {
  if (failed) return replyGroup(`<div class="cwrline">${esc(W.FAILED_NO_REPLY)}${failed.reason ? techDetailsHtml([['reason', failed.reason]], { id: 'cwfail' }) : ''}</div>`)
  const st = stop ? `<span class="cbstop">${W.stopReasonRow(`<span class="mono">${esc(stop)}</span>`)}</span>` : ''
  if (empty) return replyGroup(`<div class="cwrline">${esc(empty === 'unread' ? W.UNREAD_REPLY : W.EMPTY_REPLY)}${st}</div>`)
  const kids = rows.map(({ key, b, tag, mark, sr, open, last }) => ({ key, html: blockRowHtml({ role: 'assistant', tag, label: b.preview || '' }, {
    cls: `r-assistant k-${esc(b.kind)}`, attrs: ` data-rp="${esc(key)}" data-ff="${mark}"`,
    badges: (mark === 'verbatim' ? `<span class="sr-only">,${esc(W.FF_WORD[sr])}</span>` : ffBadgeHtml(mark)) + (last ? st : ''),
    chars: typeof b.chars === 'number' ? b.chars : null, open, body: open ? bodyFor(b) : '' }) }))
  return { ...replyGroup(`<div class="cwrrows" data-kids>${KIDS}</div>`), kids }
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
// rule 4): one group per task, a placeholder near it drawn, then a drawn group beyond two window heights put back to its
// placeholder (the gap: a placeholder's height and its drawn rows' differ a little, one edge for both would loop) — never one
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
    const within = (n) => b.getBoundingClientRect().bottom >= box.top - n * h && a.getBoundingClientRect().top <= box.bottom + n * h
    if (busy && within(1)) return [g.__k, true]
    if (!busy && !drop && !within(2) && !g.querySelector('.cblk:not(.collapsed), #cachebrk') && !g.contains(document.activeElement) && !(sel && sel.anchorNode && g.contains(sel.anchorNode))) drop = [g.__k, false]
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

// ── the landing (1.4 §打开一步时落在哪; the rule is the model's landingTarget): it runs ONCE per rid, the first time its lane is
// held; later repaints of the same step never scroll again. It is decided before the units are built, so the target's group is
// drawn in the same paint. A target inside a folded turn opens that turn for this display only (s.turnLanded) — the D12 memory
// records the reader's own folds.
function landingDue(s) {
  const t = landingFor(s)
  if (t && t.turn != null) s.turnLanded.add(t.turn)
  return t
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
