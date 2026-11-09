// replay/blocks.mjs — one context block's body and marks as the call drawer (detail.mjs) draws them, and the tag words the window
// shares. DOM-free (strings in, strings out), so the byte-fidelity of what is shown can be tested in Node.
//
// A block ships as metadata plus a `text_ref` locator; its body is NOT on the wire. Opening a row is a read: /api/block slices the
// bytes out of the source capture. A block that cannot be addressed ships its body inline and says so (`unaddressable`).
// Invariant 4: a body that has not arrived is never a blank <pre> (a blank reads as "the model saw nothing here").
//
// Fidelity follows the PROOF RULE (2.3 §保真标): a block is 逐字 only when the evidence says so — a `text_ref` plus a default /
// `verbatim` faithfulness (`ff.faithfulness` on the wire, model.mjs boardDef), tools blocks too. Nothing is assumed verbatim without evidence.
import { esc } from '../core/fmt.mjs'
import * as W from '../labels/replay.mjs'
import { HALF } from '../core/icons.mjs'
import { cellOf, cellBodyHtml, modeOf, bodyCache, hasInline, isAddressed, loadBody, isRetryable } from './cell.mjs'
export { DISPLAY_CLIP, blockGot, loadBody, isRetryable, bodyCache } from './cell.mjs'

// ── the proof rule (2.3 §保真标) lives in the window model ────
export { faithOf } from '../../src/screens/replay/window-model.mjs'
// the visible word of a mark (one per block; 2.3 逐值)
const ffWord = (f) => W.FF_WORD[f] || W.FF_WORD.unknown
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
const pendingBodyHtml = (b) => cellBodyHtml(cellOf(b), modeOf(cellOf(b).bid))

// the body as HTML. `got` is a resolved /api/block answer ({status, text, fidelity, error}); null means "inline" (the block itself
// carries the body). A proven body carries NO fidelity line of its own; a body that came back unproven is said here.
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
function showBody(bc, b, got) {
  bc.innerHTML = blockBodyHtml(got, b)
  if (isRetryable(got)) delete bc.dataset.filled
}

// ── the tag word ──────────────────────────────────────────────────────────────────────────────────────────────────────────
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
