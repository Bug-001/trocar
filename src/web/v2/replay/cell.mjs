// replay/cell.mjs — one block body, drawn the same everywhere (spec 2.3 §两种模式, D70):
// the request's blocks, the reply's parts, the raw panel's non-block keys and the drawer. A cell is
// {bid, ref?, inline?, r, ff, chars, preview}. Two modes: Raw (the bytes, laid out by jsonlay; the default) and Readable (drawn
// from the render spec r by kinds.mjs). The bytes are fetched, cached and copied by `ref` only (a content key is not an
// exact-byte id); `bid` keys only view state. DOM-free above wireCells, so the strings can be tested in Node.
import { esc, kf } from '../core/fmt.mjs'
import * as W from '../labels/replay.mjs'
import * as C from '../labels/cells.mjs'
import { layout } from './jsonlay.mjs'
import { renderKind, valueOf, jsonNodeHtml } from './kinds.mjs'
import { cellKey } from './keymap.mjs'
import { isTyping } from '../core/keys.mjs'

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
// one item of a `block` answer ({ref, bytes, encoding, fidelity, truncated}, 3.5 §会话读) as the body the cell shows
export function blockGot(doc) {
  const d = doc || {}
  if (typeof d.bytes !== 'string') return { status: 'absent', error: ((d.errors || [])[0] || {}).reason || 'the capture has no such block' }
  const f = d.fidelity, verbatim = f === 'verbatim' || !!(f && f.verbatim)
  return { status: 'ok', text: d.bytes, verbatim, fidelity: verbatim ? 'verbatim' : 'reserialized', note: (f && f.note) || null, truncated: d.truncated ?? null }
}
const asking = new Map() // ref -> its answer on the way: needs that meet while it is out share it
// The bodies of `refs` → Promise<got[]> in the order asked. One `block` read carries every ref neither in bodyCache nor already
// on its way; each answer item fills bodyCache by its `ref`, and an item with `bytes:null` takes its `errors` entry (where = ref)
// as that ref's failure. A failed read is not remembered (the next ask reads again), except a 404.
export function loadBodies(api, refs, { signal } = {}) {
  const want = [...new Set(refs)].filter((ref) => !bodyCache.has(ref) && !asking.has(ref))
  if (want.length) {
    const read = api.get('block', { ref: want }, { signal }).then((r) => {
      const out = new Map()
      if (!r.ok) {
        for (const ref of want) { const got = { status: r.status === 404 ? 'absent' : 'error', error: r.error }; if (r.status === 404) bodyCache.set(ref, got); out.set(ref, got) }
        return out
      }
      const d = r.data || {}, errs = d.errors || []
      // a `block` answer without a `blocks` array (one ref asked) is the item itself
      const items = Array.isArray(d.blocks) ? d.blocks : want.length === 1 ? [{ ...d, ref: want[0] }] : []
      const byRef = new Map(items.map((x) => [x.ref, x]))
      for (const ref of want) {
        const it = byRef.get(ref)
        if (!it) { out.set(ref, { status: 'error', error: 'the answer did not carry this block' }); continue }
        const got = typeof it.bytes === 'string' ? blockGot(it) : blockGot({ errors: errs.filter((e) => e.where === ref) })
        bodyCache.set(ref, got); out.set(ref, got)
      }
      return out
    })
    for (const ref of want) asking.set(ref, read.then((m) => m.get(ref)).finally(() => asking.delete(ref)))
  }
  return Promise.all(refs.map((ref) => asking.get(ref) ?? bodyCache.get(ref)))
}
export const loadBody = (api, ref) => loadBodies(api, [ref]).then(([got]) => got)
// a failed fetch that was not remembered: the next open asks again
export const isRetryable = (got) => !!got && got.status === 'error'

// the body a definition carries itself: a block the capture cannot point into brings it as `def.inline` (3.5 §会话读 · 2.3 §没有
// def.ref, e.g. each part of a plain-JSON reply); a block built in the browser holds the same keys on itself
const ownBody = (b) => (b.inline && typeof b.inline === 'object' ? b.inline : b)
export const hasInline = (b) => { const x = ownBody(b); return x.text !== undefined || x.block !== undefined || x.desc !== undefined || x.schema !== undefined }
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
  const x = ownBody(b)
  if (b.sec === 'tools') { // by what the definition carries: the wire sends no `verbatim`; an older capture kept neither text
    return b.verbatim !== false && (x.desc !== undefined || x.schema !== undefined)
      ? `${b.name}${b.ttype ? ' · ' + b.ttype : ''}\n\ndescription:\n${x.desc || '—'}${x.schema !== undefined ? `\n\nschema:\n${JSON.stringify(x.schema, null, 2)}` : ''}`
      : `${b.name}${b.ttype ? ' · ' + b.ttype : ''}\nparams (names only): ${(b.props || []).join(', ') || '—'}\ndescription: ${kf(b.descChars)} chars captured — ${W.SCHEMA_NOT_KEPT}\n\n${W.METADATA_BODY}`
  }
  if (b.sec === 'system') return x.text
  if (b.faithfulness === 'opaque') return String(rawContentText(x.block) || '') || '[Encrypted / redacted reasoning: the wire carries only a signature or ciphertext, no plaintext. There is nothing to restore verbatim.]'
  return rawContentText(x.block ?? x.text)
}

// ── the cell object ───────────────────────────────────────────────────────────────────────────────────────────────────
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
const synth = (text) => `i:${text.length}:${fnv(text)}` // an identity derived from the inline bytes themselves
// a flat definition ({sec, …}), a non-block key ({key, ref, chars}) or a body the caller holds ({inline, r}) as a cell. `x.inline`
// is that body: the text the cell shows and copies, never an envelope made up around it (a parsed reply part is its own text).
export function cellOf(x) {
  const held = typeof x.inline === 'string' ? x.inline : undefined
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
const overrides = new Map() // scope + bid -> mode; Map order = least recently set first
// the overrides are the shown desk's: each cached desk (session-cache.mjs) keeps its own under its session key (2.3 §逐格覆盖)
let scope = ''
export const overrideScope = (key) => { scope = String(key) + '\n' }

export function deskMode({ storage = local() } = {}) {
  try { const v = storage && storage.getItem(DESK_KEY); if (MODES.has(v)) return v } catch { /* storage denied: memory, then Raw */ }
  return desk ?? 'raw'
}
export function setDeskMode(m, { storage = local() } = {}) {
  desk = MODES.has(m) ? m : 'raw'
  overrides.clear()
  try { storage && storage.setItem(DESK_KEY, desk) } catch { /* full or denied: the choice holds for this page only */ }
}
// a desk that leaves the cache drops its overrides
export const clearOverrides = (key) => { for (const k of [...overrides.keys()]) if (k.startsWith(String(key) + '\n')) overrides.delete(k) }
export const modeOf = (bid, opt) => overrides.get(scope + bid) ?? deskMode(opt)
// set one cell's mode; back to the desk default drops its override
export function setMode(bid, m, opt) {
  overrides.delete(scope + bid)
  if (MODES.has(m) && m !== deskMode(opt)) overrides.set(scope + bid, m)
  let n = 0 // the cap is per desk: another cached desk's overrides are not this desk's to evict (2.3 §逐格覆盖)
  for (const k of overrides.keys()) if (k.startsWith(scope)) n++
  if (n > OVERRIDES) for (const k of overrides.keys()) if (k.startsWith(scope)) { overrides.delete(k); break }
}

// ── drawing ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// A drawn cell is an entry {body, next, state, shown}: the body markup so far, where the next slice starts (null when all is
// shown) and jsonlay's carried state. Entries live in an LRU keyed by bid and mode, bounded by markup characters,
// and are replaced as a cell grows.
const drawn = new Map()
let drawnChars = 0
function keep(k, e) {
  const old = drawn.get(k)
  if (old) { drawnChars -= old.body.length; drawn.delete(k) }
  drawn.set(k, e); drawnChars += e.body.length
  for (const [o, oe] of drawn) { if (drawnChars <= HTML_CHARS || o === k) break; drawn.delete(o); drawnChars -= oe.body.length }
}
const cells = new Map() // bid -> the last cell drawn with it, for the DOM wiring
function remember(k, cell) { cells.delete(k); cells.set(k, cell); if (cells.size > CELLS) { const [[, o]] = cells; cells.delete(o.bid); cellGone(byteKey(o)) } }
let cellGone = () => {}

function first(cell, mode, text) {
  if (mode === 'raw') {
    const o = layout(text, 0, DISPLAY_CLIP)
    return { body: (o.html.startsWith('\n') ? '\n' : '') + o.html, next: o.next, state: o.state, shown: o.next ?? text.length, cls: '' }
  }
  const o = renderKind(cell.r, valueOf(text), { budget: DISPLAY_CLIP, bid: cell.bid })
  return { body: o.html, next: o.more, state: null, shown: o.more ?? o.shown ?? text.length, cls: o.cls, as: o.as }
}
// the next slice of a drawn entry → {html, entry} (a new entry; the old one is left as it was)
function grow(cell, mode, entry, text) {
  if (entry.next == null || entry.shown >= CELL_CAP) return { html: '', entry }
  const o = mode === 'raw' ? layout(text, entry.next, DISPLAY_CLIP, entry.state) : renderKind(cell.r, valueOf(text), { from: entry.next, budget: DISPLAY_CLIP, bid: cell.bid })
  const next = mode === 'raw' ? o.next : o.more
  const e = { ...entry, body: entry.body + o.html, next, state: mode === 'raw' ? o.state : null, shown: next ?? text.length }
  keep(cell.bid + '|' + mode, e)
  return { html: o.html, entry: e }
}
// the drawn entry of a cell in a mode, rebuilt up to `upto` shown characters when the LRU let it go
function entryOf(cell, mode, text, upto = 0) {
  const k = cell.bid + '|' + mode, src = byteKey(cell)
  let e = drawn.get(k)
  if (!e || e.src !== src) { e = { ...first(cell, mode, text), src }; keep(k, e) } // a bid drawn from other bytes is drawn again
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
  const m = mode === 'read' ? 'read' : 'raw', text = String(got.text ?? ''), k = cell.bid
  remember(k, cell)
  const e = entryOf(cell, m, text)
  const btn = (v, word) => `<button type="button" data-cellmode="${v}" aria-pressed="${m === v}">${esc(word)}</button>`
  const clip = clipLine(e.shown, text.length)
  const bar = `<div class="cellbar"><span class="cellview" role="group" aria-label="${esc(C.VIEW_GROUP)}">${btn('raw', C.RAW)}${btn('read', C.READABLE)}</span>` +
    `<button type="button" class="cellcopy" data-cellcopy>${esc(C.COPY)}</button>` +
    (m === 'read' ? `<span class="cellkind">${esc(C.KIND_WORD[e.as] || C.KIND_WORD.text)}</span><span class="cellstate">${esc(C.READ_STATE)}</span>` : `<span class="cellstate" title="${esc(C.RAW_TIP)}">${esc(C.RAW_STATE)}</span>`) +
    (clip ? `<span class="cellclip">${esc(clip)}</span>` : '') + '</div>'
  const body = m === 'raw' ? `<pre class="cellraw">${e.body}</pre>` : `<div class="cellread ${esc(e.cls)}">${e.body}</div>`
  const more = e.next != null && e.shown < CELL_CAP ? `<span class="cellmore" data-at="${e.next}"></span>` : ''
  return `<div class="cell" data-bid="${esc(cell.bid)}" data-ck="${esc(k)}" data-mode="${m}" data-chars="${text.length}" data-shown="${e.shown}"${cell.ref != null ? ` data-ref="${esc(cell.ref)}"` : ''}>${bar}${body}${more}</div>`
}

// ── DOM wiring ────────────────────────────────────────────────────────────────────────────────────────────────────────
const at = (v, p) => { for (const k of p) { if (v == null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined; v = v[k] } return v }
const blobs = new Map() // byte key -> the blob: URL made from a media cell's bytes; revoked when those bytes leave the caches
function revoke(k) { const u = blobs.get(k); if (u) { blobs.delete(k); try { URL.revokeObjectURL(u) } catch { /* already gone */ } } }
bodyCache.onEvict = (ref) => revoke('r:' + ref)
cellGone = revoke

// the cell behind a .cell element and the bytes it shows, or null
function held(el) {
  const cell = el && cells.get(el.dataset.ck), got = cell && gotOf(cell)
  return got && got.status === 'ok' ? { cell, text: String(got.text ?? '') } : null
}
// the same, asking for the bytes again when they left bodyCache while the cell stayed open (the cache is bounded; a cell is a ref)
let api = null
async function hold(el) {
  const x = held(el), cell = !x && el && cells.get(el.dataset.ck)
  if (x || !cell || cell.ref == null || cell.inline !== undefined || !api) return x
  await loadBody(api, cell.ref)
  return held(el)
}
function blobOf(el) {
  const x = held(el), f = (x && x.cell.r && x.cell.r.f) || {}
  if (!x || !Array.isArray(f.data)) return null
  const k = byteKey(x.cell)
  if (blobs.has(k)) return blobs.get(k)
  const v = valueOf(x.text), data = at(v, f.data), mime = Array.isArray(f.mime) ? String(at(v, f.mime) ?? '') : ''
  if (typeof data !== 'string') return null
  try {
    const bin = atob(data), url = URL.createObjectURL(new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: mime }))
    blobs.set(k, url)
    return url
  } catch { return null }
}
let live = null // the one polite live region every cell speaks through
function say(msg) {
  if (!live || !live.isConnected) {
    live = document.createElement('div')
    live.className = 'sr-only'; live.setAttribute('aria-live', 'polite'); live.setAttribute('role', 'status')
    document.body.appendChild(live)
  }
  live.textContent = msg
}
// draw a .cell again in its current mode; focus inside it moves to the same control of the new one
function redraw(el, opt) {
  const x = held(el)
  if (!x) { hold(el).then((y) => { if (y) redraw(el, opt) }); return }
  if (!el.isConnected) return
  const a = document.activeElement, inside = a && el.contains(a), which = inside && a.dataset ? (a.dataset.cellmode ?? (a.dataset.cellcopy != null ? 'copy' : null)) : null
  el.insertAdjacentHTML('beforebegin', cellBodyHtml(x.cell, modeOf(x.cell.bid, opt)))
  const neu = el.previousElementSibling
  el.remove()
  if (inside && neu) (neu.querySelector(which === 'copy' ? '[data-cellcopy]' : `[data-cellmode="${which}"]`) || neu).focus?.()
}
async function copyBytes(el) {
  const x = held(el) ?? await hold(el)
  if (!x) { say(C.COPY_FAILED); return }
  const n = new TextEncoder().encode(x.text).length
  try { await navigator.clipboard.writeText(x.text); say(C.copied(n)); return } catch { /* no clipboard API here: the textarea way */ }
  const back = document.activeElement, ta = document.createElement('textarea')
  ta.value = x.text; ta.setAttribute('readonly', ''); ta.className = 'sr-only'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* refused */ }
  ta.remove(); back && back.focus && back.focus()
  say(ok ? C.copied(n) : C.COPY_FAILED)
}
// the offset in the cell's bytes of a DOM point inside its .cellraw: the verbatim text nodes before it, the .lay ones skipped
function offsetIn(pre, c, o) {
  const pt = document.createRange(); pt.setStart(c, o)
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
  let acc = 0
  for (let t; (t = w.nextNode());) {
    const lay = !!t.parentElement.closest('.lay')
    if (t === c) return acc + (lay ? 0 : o)
    if (pt.comparePoint(t, t.length) > 0) return acc
    if (!lay) acc += t.length
  }
  return acc
}
// IntersectionObservers rooted at each target's nearest scrolling ancestor (the viewport when none), one per scroller: a margin
// of one scroller height ahead then reaches inside the scroller, where a viewport-rooted one sees nothing past its clip
function watcher(cb) {
  const by = new Map()
  const scroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (/^(auto|scroll|overlay)$/.test(getComputedStyle(p).overflowY)) return p; return null }
  const of = (el) => { const root = scroller(el); if (!by.has(root)) by.set(root, new IntersectionObserver(cb, { root, rootMargin: '100% 0px' })); return by.get(root) }
  return { observe: (el) => of(el).observe(el), unobserve: (el) => { for (const o of by.values()) o.unobserve(el) }, disconnect: () => { for (const o of by.values()) o.disconnect(); by.clear() } }
}
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 0))

// click / keys / copy / growth / media / json disclosure on the given roots → a disposer. `s.storage` overrides localStorage.
export function wireCells(roots, s = {}) {
  // element roots only, and none inside another (one listener per cell)
  const els = [].concat(roots).filter((r) => r && r.nodeType === 1), rs = els.filter((r) => !els.some((o) => o !== r && o.contains(r)))
  if (!rs.length) return () => {}
  const opt = { storage: s.storage }
  api = s.ctx?.api ?? api
  const each = (sel, fn) => { for (const r of rs) for (const el of r.querySelectorAll(sel)) fn(el) }
  const sameBid = (bid, fn) => each('.cell', (el) => { if (el.dataset.bid === bid) fn(el) })
  function flip(el, m) {
    const bid = el.dataset.bid
    setMode(bid, m ?? (modeOf(bid, opt) === 'raw' ? 'read' : 'raw'), opt)
    const now = modeOf(bid, opt)
    sameBid(bid, (c) => redraw(c, opt))
    say(now === 'read' ? C.READABLE_VIEW : C.RAW_VIEW)
  }
  // Shift+V: every open cell is stale; one is drawn again when it comes within a viewport of the view, a few per frame, so
  // the cells in view go first and the rest only as the reader reaches them (style and layout land with each redraw)
  const q = []
  let pumping = false
  const pump = () => {
    if (pumping) return
    pumping = true
    requestAnimationFrame(function step() {
      const t0 = performance.now()
      for (let n = 0; q.length && n < 4 && performance.now() - t0 < 4; n++) redraw(q.shift(), opt)
      if (q.length) requestAnimationFrame(step); else pumping = false
    })
  }
  const stale = watcher((ents) => {
    for (const en of ents) if (en.isIntersecting || !en.target.isConnected) { stale.unobserve(en.target); if (en.isIntersecting) q.push(en.target) }
    pump()
  })
  function flipDesk() {
    setDeskMode(deskMode(opt) === 'raw' ? 'read' : 'raw', opt)
    say(deskMode(opt) === 'read' ? C.READABLE_VIEW : C.RAW_VIEW)
    stale.disconnect(); q.length = 0 // a cell from an earlier flip is stale again (or gone)
    each('.cell', (el) => stale.observe(el))
  }
  async function more(sent) { // append the next slice where the reader is heading
    const el = sent.isConnected && sent.closest('.cell'), x = held(el) ?? await hold(el)
    if (!x) return
    const mode = el.dataset.mode, shown = Number(el.dataset.shown) || 0
    const e = entryOf(x.cell, mode, x.text, shown)
    if (e.shown !== shown) { redraw(el, opt); return } // another copy of this cell grew further: draw it whole
    const { html, entry } = grow(x.cell, mode, e, x.text)
    el.querySelector(mode === 'raw' ? ':scope > .cellraw' : ':scope > .cellread')?.insertAdjacentHTML('beforeend', html)
    el.dataset.shown = String(entry.shown)
    const line = clipLine(entry.shown, x.text.length), clip = el.querySelector('.cellclip')
    if (line && clip) clip.textContent = line; else if (!line && clip) clip.remove()
    if (entry.next != null && entry.shown < CELL_CAP) { sent.dataset.at = String(entry.next); io.observe(sent) } else sent.remove()
  }
  const io = watcher((ents) => {
    for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); idle(() => more(en.target)) }
  })
  const hook = (n) => {
    if (n.nodeType !== 1) return
    for (const el of [n, ...n.querySelectorAll('.cellmore, img[data-media]:not([src])')]) {
      if (el.matches('.cellmore')) io.observe(el)
      else if (el.matches('img[data-media]:not([src])') && el.dataset.media) { const u = blobOf(el.closest('.cell')); if (u) el.src = u }
    }
  }
  const onClick = (e) => {
    const b = e.target.closest && e.target.closest('[data-cellmode],[data-cellcopy],[data-cellsave]')
    const el = b && b.closest('.cell')
    if (!el) return
    if (b.dataset.cellmode != null) flip(el, b.dataset.cellmode)
    else if (b.dataset.cellcopy != null) copyBytes(el)
    else { const u = blobOf(el); if (u) { const a = document.createElement('a'); a.href = u; a.download = ''; a.click() } }
  }
  const onKey = (e) => {
    const a = isTyping(e) ? null : cellKey(e), row = a && e.target.closest && e.target.closest('.cblk, .dblk')
    if (!row) return
    if (a.flipDesk) { e.preventDefault(); flipDesk(); return }
    const el = row.querySelector('.cell')
    if (!el) return
    e.preventDefault()
    if (a.flip) flip(el); else copyBytes(el)
  }
  const onCopy = (e) => { // exact bytes from a selection inside one Raw cell; a selection that leaves it is the browser's
    const sel = getSelection(), r = sel && sel.rangeCount === 1 ? sel.getRangeAt(0) : null
    const sc = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)
    const pre = sc && sc.closest('.cellraw'), x = pre && pre.contains(r.endContainer) && held(pre.closest('.cell'))
    if (!x || !e.clipboardData) return
    e.clipboardData.setData('text/plain', x.text.slice(offsetIn(pre, r.startContainer, r.startOffset), offsetIn(pre, r.endContainer, r.endOffset)))
    e.preventDefault()
  }
  const onToggle = async (e) => { // a json node opened for the first time: draw its children now
    const d = e.target
    if (!d || d.tagName !== 'DETAILS' || !d.open || d.dataset.path == null || d.children.length > 1) return
    const el = d.closest('.cell'), x = held(el) ?? await hold(el)
    if (!x) return
    let path
    try { path = JSON.parse(d.dataset.path) } catch { return }
    const v = valueOf(x.text), body = Array.isArray(x.cell.r?.f?.body) ? at(v, x.cell.r.f.body) : v
    d.insertAdjacentHTML('beforeend', jsonNodeHtml(body, path, d.dataset.span ? d.dataset.span.split(',').map(Number) : undefined, { q: d.dataset.q != null, budget: DISPLAY_CLIP }))
  }
  const mos = rs.map((r) => {
    const mo = new MutationObserver((recs) => { for (const rec of recs) for (const n of rec.addedNodes) hook(n) })
    mo.observe(r, { childList: true, subtree: true })
    hook(r)
    r.addEventListener('click', onClick); r.addEventListener('keydown', onKey); r.addEventListener('copy', onCopy); r.addEventListener('toggle', onToggle, true)
    return mo
  })
  return () => {
    for (const mo of mos) mo.disconnect()
    io.disconnect(); stale.disconnect(); q.length = 0
    for (const r of rs) { r.removeEventListener('click', onClick); r.removeEventListener('keydown', onKey); r.removeEventListener('copy', onCopy); r.removeEventListener('toggle', onToggle, true) }
  }
}
