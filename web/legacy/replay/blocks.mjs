// replay/blocks.mjs — one context block: its row head and its body. DOM-free (strings in, strings out), so the byte-fidelity of
// what is shown can be tested in Node. Shared by the context window, the bottom drawer and the raw panel.
//
// A block ships as metadata plus a `text_ref` locator; its body is NOT on the wire. Opening a row is a read: /api/block slices the
// bytes out of the source capture. A block that cannot be addressed ships its body inline and says so (`unaddressable`).
// Invariant 4: a body that has not arrived is never a blank <pre> (a blank reads as "the model saw nothing here").
//
// Fidelity follows the PROOF RULE (2.3 §保真标): a block is 逐字 only when the evidence says so — a `text_ref` plus a default /
// `verbatim` faithfulness (`ff.faithfulness` on the wire, model.mjs boardDef), tools blocks too. Nothing is assumed verbatim without evidence.
import { esc, kf } from '../core/fmt.mjs'
import * as W from '../labels/replay.mjs'
import { HALF } from '../core/icons.mjs'
import { DISPLAY_CLIP, cellOf, cellBodyHtml, modeOf, bodyCache, hasInline, isAddressed, loadBody, isRetryable } from './cell.mjs'
import { openedFf, rowMarks } from '../../src/screens/replay/window-model.mjs'
export { DISPLAY_CLIP, preEsc, rawContentText, inlineText, hasInline, isAddressed, blockGot, loadBody, isRetryable, bodyCache } from './cell.mjs'

// the DISPLAY clip: what exceeds 20 000 characters is folded with the full count said — the full text stays reachable in the
// source; this is a display control, NOT a faithfulness mark (2.3: 显示剪裁 ≠ 源截断)
export const clipCut = (t) => {
  if (t.length <= DISPLAY_CLIP) return t.length
  let cut = DISPLAY_CLIP
  const c = t.charCodeAt(cut - 1)
  if (c >= 0xD800 && c <= 0xDBFF) cut-- // never split a surrogate pair
  return cut
}
export function clipText(t) {
  if (t.length <= DISPLAY_CLIP) return t
  return t.slice(0, clipCut(t)) + '\n' + W.clipNote(t.length)
}

// ── the proof rule (2.3 §保真标): faithOf · openedFf · faithNow, and a request row's marks, live in the window model ────
export { faithOf, openedFf, faithNow } from '../../src/screens/replay/window-model.mjs'
// the visible word of a mark (one per block; 2.3 逐值)
export const ffWord = (f) => W.FF_WORD[f] || W.FF_WORD.unknown
// one visible badge for an unproven block. A PROVEN block gets no visible word anywhere — its row carries data-ff and the
// screen-reader word only (the section header says 以下逐字 once for a fully proven section).
export function ffBadgeHtml(f, { tech = '' } = {}) {
  if (f == null || f === 'verbatim') return ''
  return `<span class="ffbadge ff-${esc(f)}" data-ff="${esc(f)}" title="${esc(tech || ffWord(f))}">${HALF + ' ' + esc(ffWord(f))}</span>`
}
// kept for the drawer's folded-row label (detail.mjs); the emoji forms are gone (2.3 砍掉的)
export const FF = Object.freeze(Object.fromEntries(Object.entries(W.FF_WORD).map(([k, text]) => [k, { text }])))

// ── bodies ── (the bytes, the cache and the inline text live in cell.mjs; a body is always drawn as a cell)
// the pending state of an addressed row: the cell's sized box, a <pre> carrying data-ref until the bytes arrive
export const pendingBodyHtml = (b) => cellBodyHtml(cellOf(b), modeOf(cellOf(b).bid))

// the body as HTML. `got` is a resolved /api/block answer ({status, text, fidelity, error}); null means "inline" (the block itself
// carries the body). A proven body carries NO fidelity line of its own (the section header says 以下逐字 once); a body that came
// back unproven is said here AND upgrades the row's mark (noteBodyFidelity, called by fillBody).
export function blockBodyHtml(got, b) {
  if (got == null) {
    // a tools block always has its metadata row (name · params · descChars) to show, HEAVY-dropped or old-trace
    const inline = hasInline(b) || (b.sec === 'tools' && (b.name != null || b.descChars != null || (b.props && b.props.length)))
    if (!inline) return `<div class="cbsrc warn">${HALF + ' ' + esc(W.NO_BODY)}</div>`
    const cell = cellOf(b)
    return cellBodyHtml(cell, modeOf(cell.bid))
  }
  if (got.status !== 'ok') {
    const why = got.error || got.reason || 'the capture could not be read'
    return `<div class="cbsrc warn" title="locator: ${esc(b.text_ref || '—')}">${HALF + ' ' + esc(ffWord('notfetched') + ' — ' + why)}</div>`
  }
  // the cached answer is read by ref (the cell LRU then holds refs, not bodies, and the blob of a media cell is keyed r:<ref>);
  // only an answer the cache does not hold rides inline
  const cell = cellOf(b)
  return cellBodyHtml(cell.ref != null && bodyCache.get(cell.ref) === got ? cell : { ...cell, inline: String(got.text ?? ''), view: got.view ?? cell.view }, modeOf(cell.bid))
}
// the body of an opened row right now: inline, from the cache, or the pending state (the caller then loads it)
export function bodyFor(b) {
  if (!isAddressed(b)) return blockBodyHtml(null, b)
  const got = bodyCache.get(b.text_ref)
  return got ? blockBodyHtml(got, b) : pendingBodyHtml(b)
}
// what a resolved body just proved about its ROW: upgrade the row's mark and withdraw the section's 「以下逐字」 at once —
// not at the next repaint (2.3 MUST). `blk` is the .cblk element; DOM-guarded so string tests can pass a stub.
export function noteBodyFidelity(blk, got) {
  const f = openedFf(got)
  if (!f || !blk || !blk.classList || !blk.isConnected) return
  if (blk.dataset.ff === f || (blk.dataset.ff && blk.dataset.ff !== 'verbatim')) return // an existing visible mark keeps its claim
  blk.dataset.ff = f
  const head = blk.querySelector(':scope > .cbh')
  if (head) { head.insertAdjacentHTML('beforeend', ffBadgeHtml(f, { tech: got && got.error })); const sr = head.querySelector(':scope > .sr-only'); if (sr) sr.remove() }
  const root = blk.closest && (blk.closest('#ctxwin') || blk.closest('#detail'))
  const sec = blk.dataset.sec
  if (root && sec) { // the section can no longer claim 以下逐字
    const hd = root.querySelector(`#sec-${sec.replace(/"/g, '\\"')} .cwsecff.v`)
    if (hd) { hd.classList.remove('v'); hd.innerHTML = HALF; hd.title = W.WINDOW_LINE }
  }
}
// paint `bc` with the body, and swap in the real bytes once they arrive. `bc.dataset.filled` says "this body needs no fetch on the next
// open": set at once (a collapse + reopen while the bytes are in flight must not start a second request) and taken back when the
// fetch FAILED, so the next open of that row asks again. An absent record stays filled: asking again would only get the same 404.
// Returns the promise of the swap (nothing to wait for when the body is already here).
export function fillBody(api, bc, b) {
  bc.dataset.filled = '1'
  bc.innerHTML = bodyFor(b)
  if (!bc.querySelector('pre[data-ref]')) return Promise.resolve()
  return loadBody(api, b.text_ref).then((got) => { if (bc.isConnected && bc.querySelector('pre[data-ref]')) showBody(bc, b, got) })
}
// paint `bc` with a body that has come back (`got`, as loadBodies resolves it); a failed one leaves `filled` clear
export function showBody(bc, b, got) {
  bc.innerHTML = blockBodyHtml(got, b)
  if (typeof bc.closest === 'function') noteBodyFidelity(bc.closest('.cblk'), got)
  if (isRetryable(got)) delete bc.dataset.filled
}

// ── one row ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// `b.head` and `b.preview` are the server's: nothing is re-derived from a body that was deliberately not sent. The tag word
// comes from the closed-set table (2.3 Edge「块头 tag 的中文」); a data suffix (a tool name · MCP) rides along as data.
export function tagWord(tag) {
  const t = String(tag || '')
  if (W.TAG_WORD[t] != null) return W.TAG_WORD[t]
  const act = t.match(/^action(?: · (.*))?$/)
  if (act) return W.TAG_ACTION + (act[1] ? ' · ' + act[1] : '')
  const obs = t.match(/^(observation|def|thinking|user|say|text|system-reminder|image|document)(?: · (.*))?$/)
  if (obs) return (W.TAG_WORD[obs[1]] || W.TAG_WORD.text) + (obs[2] ? ' · ' + (obs[2] === 'error' ? W.TAG_ERROR : obs[2]) : '')
  return null // not in the closed set: the visible word is 原因未知, the raw value goes to the title
}
// THE block row (2.3 §block 卡): the request's blocks and the reply's parts are both drawn here — one row component. `head`
// is {role, tag, label} with the server's raw tag ('action · Bash', 'thinking', 'say'); `badges` are the caller's marks; the
// head is a keyboard-reachable toggle (role=button · tabindex · aria-expanded).
export function blockRowHtml(head, { cls = '', attrs = '', badges = '', chars = null, open = false, body = '' } = {}) {
  const tag = tagWord(head.tag), label = head.label || ''
  const n = typeof chars === 'number' ? `<span class="cbchars">${esc(kf(chars))} ${esc(W.CHARS_WORD)}</span>` : ''
  return `<div class="cblk ${open ? '' : 'collapsed'} ${cls}"${attrs}>` +
    `<div class="cbh" role="button" tabindex="0" aria-expanded="${open}"><span class="cbrole">${esc(head.role)}</span><span class="cbtag" title="${esc(tag || String(head.tag || ''))}">${esc(tag || W.TAG_UNKNOWN)}</span>${label ? `<span class="cblabel" title="${esc(label)}">${esc(label)}</span>` : ''}${badges}${n}` +
    `</div><div class="cbc"${open ? ' data-filled="1"' : ''}>${open ? body : ''}</div></div>`
}
// a request row as its unit html: no position on it (the window writes data-bi on placement, 2.3 §读与画); its marks are the
// window model's rowMarks (computed here when the caller has none)
export function ctxBlockHtml(b, { prevKeys, open, windowLine = false, marks = rowMarks(b, { prevKeys, open, windowLine }) } = {}) {
  const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
  const f = marks.ff
  const bp = marks.cc ? `<span class="bpbadge" title="${esc(W.CACHE_MARK_TIP)} · declared value: ${esc(JSON.stringify(marks.cc))}">${esc(W.CACHE_MARK)}</span>` : ''
  const vol = marks.volatile ? `<span class="volbadge" title="${esc(W.VOLATILE_MARK_TIP)}">${esc(W.VOLATILE_MARK)}</span>` : ''
  const nw = marks.isNew ? `<span class="newmark" title="${esc(W.NEW_MARK_TIP)}">${esc(W.NEW_MARK)}</span>` : ''
  // the window line already said "nothing here resolves": the per-block 不能回源 is not repeated, its screen-reader word is (2.3 §窗口行)
  const badge = marks.badge ? ffBadgeHtml(f, { tech: marks.tech }) : ''
  const sr = marks.sr ? `<span class="sr-only">,${esc(W.FF_WORD[f])}</span>` : ''
  const rk = b.resKey ? ` data-rk="${esc(b.resKey)}"` : ''
  return blockRowHtml({ role: h.role, tag: h.tag, label: h.label || b.preview || '' }, {
    cls: `${marks.isNew ? 'is-new' : ''} s-${esc(b.sec)} r-${esc(b.role)} k-${esc(b.kind)}`,
    attrs: ` data-sec="${esc(b.sec)}" data-ff="${esc(f)}"${rk}`,
    badges: bp + vol + nw + badge + sr,
    chars: typeof b.chars === 'number' ? b.chars : null, open, body: open ? bodyFor(b) : '',
  })
}
