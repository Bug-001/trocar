// replay/cell.mjs — one block body, drawn the same everywhere (spec 2.3 §两种模式, D70):
// the request's blocks, the reply's parts, the raw panel's non-block keys and the drawer. A cell is
// {bid, ref?, inline?, r, ff, chars, preview}. Two modes: Raw (the bytes, laid out by jsonlay; the default) and Readable (drawn
// from the render spec r by kinds.mjs). The bytes are fetched, cached and copied by `ref` only (P1: a content key is not an
// exact-byte id); `bid` keys only view state. DOM-free above wireCells, so the strings can be tested in Node.
import { esc, kf } from '../core/fmt.mjs'
import * as W from '../labels/replay.mjs'
import * as C from '../labels/cells.mjs'
import { layout } from './jsonlay.mjs'
import { renderKind, valueOf } from './kinds.mjs'

export const DISPLAY_CLIP = 20000
const CELL_CAP = 2000000 // characters a cell shows at most; Copy bytes still copies all
const BODY_CHARS = 16000000, HTML_CHARS = 8000000, OVERRIDES = 500, CELLS = 2000

// escape for <pre>. A leading newline right after <pre> is dropped by the parser and a raw CR is read as LF: guard both
export function preEsc(t) {
  const e = esc(t).replace(/\r/g, '&#13;')
  return e.startsWith('\n') ? '\n' + e : e
}

// ── bodies ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// text_ref -> {status, text, fidelity, error}, bounded by the characters it holds, oldest out first. `onEvict(ref, got)` hears
// each eviction (media blob URLs made from those bytes are revoked there).
class BodyCache extends Map {
  constructor(cap) { super(); this.cap = cap; this.total = 0; this.onEvict = null }
  static weight(got) { return 1 + String((got && got.text) ?? '').length }
  set(k, v) {
    if (super.has(k)) this.total -= BodyCache.weight(super.get(k))
    super.delete(k); super.set(k, v); this.total += BodyCache.weight(v)
    for (const [old, got] of super.entries()) {
      if (this.total <= this.cap || old === k) break
      super.delete(old); this.total -= BodyCache.weight(got)
      if (this.onEvict) try { this.onEvict(old, got) } catch { /* a hook never breaks the cache */ }
    }
    return this
  }
  delete(k) { if (super.has(k)) this.total -= BodyCache.weight(super.get(k)); return super.delete(k) }
  clear() { this.total = 0; super.clear() }
}
export const bodyCache = new BodyCache(BODY_CHARS)
// What is cached: the bytes (200), and a 404 — the server looked the locator up in every capture root and found no such record,
// kept as `absent`. A network failure, a 400 / 409 / 5xx is shown (status 'error') but never remembered: the next ask may work.
// a C.5 `block` document ({ref, bytes, encoding, fidelity:{verbatim, note?}, truncated, errors}) as the body the cell shows
export function blockGot(doc) {
  const d = doc || {}
  if (typeof d.bytes !== 'string') return { status: 'absent', error: ((d.errors || [])[0] || {}).reason || 'the capture has no such block' }
  const verbatim = !!(d.fidelity && d.fidelity.verbatim)
  return { status: 'ok', text: d.bytes, verbatim, fidelity: verbatim ? 'verbatim' : 'reserialized', note: (d.fidelity && d.fidelity.note) || null, truncated: d.truncated ?? null }
}
export async function loadBody(api, ref) {
  if (bodyCache.has(ref)) return bodyCache.get(ref)
  const r = await api.get('block', { ref })
  const got = r.ok ? blockGot(r.data) : { status: r.status === 404 ? 'absent' : 'error', error: r.error }
  if (r.ok || r.status === 404) bodyCache.set(ref, got)
  return got
}
// a failed fetch that was not remembered: the next open asks again
export const isRetryable = (got) => !!got && got.status === 'error'

export const hasInline = (b) => b.text !== undefined || b.block !== undefined || b.desc !== undefined || b.schema !== undefined
export const isAddressed = (b) => !!b.text_ref && !hasInline(b)

// the text of an inline message block (the block vocabulary: text · thinking · tool_use · tool_result · image · document)
export function rawContentText(bl) {
  if (bl == null) return ''
  if (typeof bl === 'string') return bl
  if (bl.type === 'text') return bl.text || ''
  if (bl.type === 'tool_use' || bl.type === 'server_tool_use') return `${bl.name}(\n${JSON.stringify(bl.input, null, 2)}\n)`
  if (bl.type === 'tool_result') { const c = bl.content; return (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c)) + (bl.is_error ? '  ⟨is_error⟩' : '') }
  if (bl.type === 'image') return `[image ${(bl.source && (bl.source.media_type || bl.source.type)) || ''}]`
  if (bl.type === 'document') return `[document ${(bl.source && (bl.source.media_type || bl.source.type)) || bl.title || ''}]`
  if (bl.type === 'thinking') return bl.thinking || ''
  if (bl.type === 'redacted_thinking') return '[redacted_thinking]'
  return JSON.stringify(bl, null, 2)
}
// the text of a block that carries its body inline
export function inlineText(b) {
  if (b.sec === 'tools') {
    return b.verbatim
      ? `${b.name}${b.ttype ? ' · ' + b.ttype : ''}\n\ndescription:\n${b.desc || '—'}${b.schema !== undefined ? `\n\nschema:\n${JSON.stringify(b.schema, null, 2)}` : ''}`
      : `${b.name}${b.ttype ? ' · ' + b.ttype : ''}\nparams (names only): ${(b.props || []).join(', ') || '—'}\ndescription: ${kf(b.descChars)} chars captured — schema text not retained (length only)\n\nMetadata only: the full JSON schema (parameter types / required / enums / nesting) and the description text were not captured. The model received the full schema; this is a capture boundary, not a display clip.`
  }
  if (b.sec === 'system') return b.text
  if (b.faithfulness === 'opaque') return String(rawContentText(b.block) || '') || '[Encrypted / redacted reasoning: the wire carries only a signature or ciphertext, no plaintext. There is nothing to restore verbatim.]'
  return rawContentText(b.block)
}

// ── the cell object ───────────────────────────────────────────────────────────────────────────────────────────────────
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
const synth = (text) => `i:${text.length}:${fnv(text)}` // an identity derived from the inline bytes themselves
// the render spec of a reply part until reply parts become definitions (replyOf()'s own vocabulary)
const PART_R = { text: { as: 'text', f: { body: ['text'] } }, thinking: { as: 'text', tone: 'quiet', f: { body: ['thinking'] } }, tool_use: { as: 'kv', f: { body: ['input'] } } }

// a flat definition ({sec, …}), a reply part ({kind, block}) or a non-block key ({key, ref, chars}) as a cell. `x.inline` is a
// body the caller already holds.
export function cellOf(x) {
  const held = typeof x.inline === 'string' ? x.inline : undefined
  if (x.sec == null && x.block !== undefined) {
    const inline = held ?? JSON.stringify(x.block) ?? ''
    return { bid: x.bid || synth(inline), inline, r: x.r || PART_R[x.kind] || { as: 'text' }, ff: x.ff ?? null, chars: inline.length, preview: x.preview ?? '' }
  }
  if (x.sec == null && x.ref) return { bid: 'nbk:' + x.ref, ref: x.ref, inline: held, r: x.r || { as: 'text' }, ff: x.ff ?? null, chars: x.chars ?? held?.length ?? 0, preview: x.preview ?? '' }
  const ref = isAddressed(x) ? x.text_ref : undefined
  const inline = held ?? (ref ? undefined : String(inlineText(x) ?? ''))
  return { bid: x.bid || x.key || x.text_ref || synth(inline ?? ''), ref, inline, r: x.r || { as: 'text' }, ff: x.ff ?? null, chars: x.chars ?? inline?.length ?? 0, preview: x.preview ?? '' }
}
// the byte identity of a cell's body: its ref, or the inline text's own digest
const byteKey = (cell) => cell.ref != null && cell.inline === undefined ? 'r:' + cell.ref : synth(cell.inline ?? '')
// the body a cell holds right now: {status:'ok', text} | a failed answer | null (not here yet)
const gotOf = (cell) => cell.inline !== undefined ? { status: 'ok', text: cell.inline } : cell.ref != null ? bodyCache.get(cell.ref) ?? null : null

// ── mode state ────────────────────────────────────────────────────────────────────────────────────────────────────────
const DESK_KEY = 'trocar.v2.cellView'
const MODES = new Set(['raw', 'read'])
const local = () => { try { return globalThis.localStorage ?? null } catch { return null } }
let desk = null // the last desk mode set here, for when storage cannot hold it
const overrides = new Map() // bid -> mode; Map order = least recently set first

export function deskMode({ storage = local() } = {}) {
  try { const v = storage && storage.getItem(DESK_KEY); if (MODES.has(v)) return v } catch { /* storage denied: memory, then Raw */ }
  return desk ?? 'raw'
}
export function setDeskMode(m, { storage = local() } = {}) {
  desk = MODES.has(m) ? m : 'raw'
  overrides.clear()
  try { storage && storage.setItem(DESK_KEY, desk) } catch { /* full or denied: the choice holds for this page only */ }
}
export const clearOverrides = () => overrides.clear()
export const modeOf = (bid, opt) => overrides.get(bid) ?? deskMode(opt)
// set one cell's mode; back to the desk default drops its override
export function setMode(bid, m, opt) {
  overrides.delete(bid)
  if (MODES.has(m) && m !== deskMode(opt)) overrides.set(bid, m)
  if (overrides.size > OVERRIDES) overrides.delete(overrides.keys().next().value)
}

// ── drawing ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// A drawn cell is an entry {body, next, state, shown}: the body markup so far, where the next slice starts (null when all is
// shown) and jsonlay's carried state. Entries live in an LRU keyed by byte identity and mode, bounded by markup characters,
// and are replaced as a cell grows.
const drawn = new Map()
let drawnChars = 0
function keep(k, e) {
  const old = drawn.get(k)
  if (old) { drawnChars -= old.body.length; drawn.delete(k) }
  drawn.set(k, e); drawnChars += e.body.length
  for (const [o, oe] of drawn) { if (drawnChars <= HTML_CHARS || o === k) break; drawn.delete(o); drawnChars -= oe.body.length }
}
const cells = new Map() // byte key -> the last cell drawn with it, for the DOM wiring
function remember(k, cell) { cells.delete(k); cells.set(k, cell); if (cells.size > CELLS) { const [o] = cells.keys(); cells.delete(o); cellGone(o) } }
let cellGone = () => {}

function first(cell, mode, text) {
  if (mode === 'raw') {
    const o = layout(text, 0, DISPLAY_CLIP)
    return { body: (o.html.startsWith('\n') ? '\n' : '') + o.html, next: o.next, state: o.state, shown: o.next ?? text.length, cls: '' }
  }
  const o = renderKind(cell.r, valueOf(text), { budget: DISPLAY_CLIP, bid: cell.bid })
  return { body: o.html, next: o.more, state: null, shown: o.more ?? text.length, cls: o.cls }
}
// the next slice of a drawn entry → {html, entry} (a new entry; the old one is left as it was)
function grow(cell, mode, entry, text) {
  if (entry.next == null || entry.shown >= CELL_CAP) return { html: '', entry }
  const o = mode === 'raw' ? layout(text, entry.next, DISPLAY_CLIP, entry.state) : renderKind(cell.r, valueOf(text), { from: entry.next, budget: DISPLAY_CLIP, bid: cell.bid })
  const next = mode === 'raw' ? o.next : o.more
  const e = { ...entry, body: entry.body + o.html, next, state: mode === 'raw' ? o.state : null, shown: next ?? text.length }
  keep(byteKey(cell) + '|' + mode, e)
  return { html: o.html, entry: e }
}
// the drawn entry of a cell in a mode, rebuilt up to `upto` shown characters when the LRU let it go
function entryOf(cell, mode, text, upto = 0) {
  const k = byteKey(cell) + '|' + mode
  let e = drawn.get(k)
  if (!e) { e = first(cell, mode, text); keep(k, e) }
  while (e.shown < upto && e.next != null && e.shown < CELL_CAP) e = grow(cell, mode, e, text).entry
  return e
}
const clipLine = (shown, total) => shown >= total ? '' : shown >= CELL_CAP ? C.atCap(shown, total) : C.showing(shown, total)
const lines = (chars) => Math.max(1, Math.min(20, Math.ceil((Number(chars) || 0) / 100)))

// the whole body of a cell: toolbar + Raw or Readable + the sentinel; the sized pending box; or the reason the bytes are missing
export function cellBodyHtml(cell, mode) {
  const got = gotOf(cell)
  if (!got) return `<pre class="cellpend" data-ref="${esc(cell.ref ?? '')}" style="--cl:${lines(cell.chars)}">${preEsc(String(cell.preview ?? ''))}</pre>`
  if (got.status !== 'ok') return `<div class="cbsrc warn" title="locator: ${esc(cell.ref ?? '—')}">${esc(W.HALF_MARK + ' ' + W.FF_WORD.notfetched + ' — ' + (got.error || got.reason || 'the capture could not be read'))}</div>`
  const m = mode === 'read' ? 'read' : 'raw', text = String(got.text ?? ''), k = byteKey(cell)
  remember(k, cell)
  const e = entryOf(cell, m, text)
  const btn = (v, word) => `<button type="button" data-cellmode="${v}" aria-pressed="${m === v}">${esc(word)}</button>`
  const as = Object.hasOwn(C.KIND_WORD, cell.r?.as) ? cell.r.as : 'text'
  const clip = clipLine(e.shown, text.length)
  const bar = `<div class="cellbar"><span class="cellview" role="group" aria-label="${esc(C.VIEW_GROUP)}">${btn('raw', C.RAW)}${btn('read', C.READABLE)}</span>` +
    `<button type="button" class="cellcopy" data-cellcopy>${esc(C.COPY)}</button>` +
    (m === 'read' ? `<span class="cellkind">${esc(C.KIND_WORD[as])}</span><span class="cellstate">${esc(C.READ_STATE)}</span>` : `<span class="cellstate" title="${esc(C.RAW_TIP)}">${esc(C.RAW_STATE)}</span>`) +
    (clip ? `<span class="cellclip">${esc(clip)}</span>` : '') + '</div>'
  const body = m === 'raw' ? `<pre class="cellraw">${e.body}</pre>` : `<div class="cellread ${esc(e.cls)}">${e.body}</div>`
  const more = e.next != null && e.shown < CELL_CAP ? `<span class="cellmore" data-at="${e.next}"></span>` : ''
  return `<div class="cell" data-bid="${esc(cell.bid)}" data-ck="${esc(k)}" data-mode="${m}" data-chars="${text.length}" data-shown="${e.shown}"${cell.ref != null ? ` data-ref="${esc(cell.ref)}"` : ''}>${bar}${body}${more}</div>`
}
