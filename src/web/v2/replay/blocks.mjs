// replay/blocks.mjs — one context block: its row head and its body. DOM-free (strings in, strings out), so the byte-fidelity of
// what is shown can be tested in Node. Shared by the context window, the bottom drawer and the raw panel.
//
// A block ships as metadata plus a `text_ref` locator; its body is NOT on the wire. Opening a row is a read: /api/block slices the
// bytes out of the source capture. A block that cannot be addressed ships its body inline and says so (`unaddressable`).
// Invariant 4: a body that has not arrived is never a blank <pre> (a blank reads as "the model saw nothing here").
//
// Fidelity follows the PROOF RULE (2.3 §保真标): a block is 逐字 only when the evidence says so — a `text_ref` plus a default /
// `verbatim` faithfulness (tools blocks additionally need `verbatim:true`). Nothing is ever assumed verbatim without evidence.
import { esc, kf } from '../core/fmt.mjs'
import * as W from '../labels/replay.mjs'

export const DISPLAY_CLIP = 20000

// escape for <pre>. Two parser behaviours would silently alter the bytes: a leading newline right after <pre> is dropped, and a
// raw carriage return is normalised to a newline. Guard both, so what is displayed (and copied) is what was captured.
export function preEsc(t) {
  const e = esc(t).replace(/\r/g, '&#13;')
  return e.startsWith('\n') ? '\n' + e : e
}
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

// ── the proof rule (2.3): what a block's fidelity IS, and what it may claim ──────────────────────────────────────────
const KNOWN_FF = new Set(['metadata', 'opaque', 'summarized', 'omitted', 'truncated'])
// → one of: verbatim (proven — no visible word) · a known 3.2 value · unknown · unaddressable
export function faithOf(b) {
  if (b.sec === 'tools') {
    if (b.verbatim === true && b.text_ref && (b.faithfulness == null || b.faithfulness === 'verbatim')) return 'verbatim'
    if (b.verbatim === false) return 'metadata' // D15 前的旧 trace: name + params + descChars, no schema text
    if (b.faithfulness != null && KNOWN_FF.has(b.faithfulness)) return b.faithfulness
    if (b.faithfulness != null && b.faithfulness !== 'verbatim') return 'unknown'
    return 'unaddressable' // the schema rides inline and cannot be sliced out of the capture
  }
  if (b.text_ref && (b.faithfulness == null || b.faithfulness === 'verbatim')) return 'verbatim'
  if (b.faithfulness === 'verbatim') return 'unaddressable' // claims verbatim but has nothing to resolve it from
  if (b.faithfulness != null && KNOWN_FF.has(b.faithfulness)) return b.faithfulness
  if (b.faithfulness != null && b.faithfulness !== '') return 'unknown'
  return 'unaddressable'
}
// what an OPENED body proved: `decoded` is exact decompressed text the 调用保真行 already named once — nothing to add;
// verbatim proves the row again; anything else upgrades the row's mark on the spot
export function openedFf(got) {
  if (!got) return null
  if (got.status !== 'ok') return 'notfetched'
  if (got.fidelity == null || got.fidelity === '') return 'unknown'
  if (got.fidelity === 'verbatim' || got.fidelity === 'decoded') return null
  if (got.fidelity === 'reserialized') return 'reserialized'
  return 'unknown'
}
// the visible word of a mark (one per block; 2.3 逐值)
export const ffWord = (f) => W.FF_WORD[f] || W.FF_WORD.unknown
// one visible badge for an unproven block. A PROVEN block gets no visible word anywhere — its row carries data-ff and the
// screen-reader word only (the section header says 以下逐字 once for a fully proven section).
export function ffBadgeHtml(f, { tech = '' } = {}) {
  if (f == null || f === 'verbatim') return ''
  return `<span class="ffbadge ff-${esc(f)}" data-ff="${esc(f)}"${tech ? ` title="${esc(tech)}"` : ''}>${esc(W.HALF_MARK + ' ' + ffWord(f))}</span>`
}
// kept for the drawer's folded-row label (detail.mjs); the emoji forms are gone (2.3 砍掉的)
export const FF = Object.freeze(Object.fromEntries(Object.entries(W.FF_WORD).map(([k, text]) => [k, { text }])))

// ── bodies ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CACHE_CAP = 300
export const bodyCache = new Map() // text_ref -> {status, text, fidelity, error}; an append-only conversation re-sends the same block every call
// What is cached: the bytes (200), and a 404 — the server looked the locator up in every capture root (re-indexing once on a miss)
// and found no such record, so it is kept as `absent`. What is NOT cached: a network failure, a 400 / 409 / 5xx — the capture may be
// fine and the next ask may work, so a failure is shown (status 'error') but never remembered.
export async function loadBody(api, ref) {
  if (bodyCache.has(ref)) return bodyCache.get(ref)
  const r = await api.get('block', { ref })
  const got = r.ok ? r.data : { status: r.status === 404 ? 'absent' : 'error', error: r.error }
  if (r.ok || r.status === 404) {
    if (bodyCache.size >= CACHE_CAP) bodyCache.delete(bodyCache.keys().next().value)
    bodyCache.set(ref, got)
  }
  return got
}
// a failed fetch that was not remembered: the row that shows it is not "filled", so its next open asks again
export const isRetryable = (got) => !!got && got.status === 'error'

export const hasInline = (b) => b.text !== undefined || b.block !== undefined || b.desc !== undefined || b.schema !== undefined
export const isAddressed = (b) => !!b.text_ref && !hasInline(b)

export const pendingBodyHtml = (b) => `<pre class="cbpre" data-ref="${esc(b.text_ref)}">${esc(W.FETCHING)}</pre>`

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

// the body as HTML. `got` is a resolved /api/block answer ({status, text, fidelity, error}); null means "inline" (the block itself
// carries the body). A proven body carries NO fidelity line of its own (the section header says 以下逐字 once); a body that came
// back unproven is said here AND upgrades the row's mark (noteBodyFidelity, called by fillBody).
export function blockBodyHtml(got, b) {
  if (got == null) {
    // a tools block always has its metadata row (name · params · descChars) to show, HEAVY-dropped or old-trace
    const inline = hasInline(b) || (b.sec === 'tools' && (b.name != null || b.descChars != null || (b.props && b.props.length)))
    if (!inline) return `<div class="cbsrc warn">${esc(W.HALF_MARK + ' ' + W.NO_BODY)}</div>`
    const note = b.unaddressable ? `<div class="cbsrc warn" title="${esc(b.unaddressable)}">${esc(W.INLINE_NOTE)}</div>` : ''
    return note + `<pre class="cbpre">${preEsc(clipText(String(inlineText(b) ?? '')))}</pre>`
  }
  if (got.status !== 'ok') {
    const why = got.error || got.reason || 'the capture could not be read'
    return `<div class="cbsrc warn" title="locator: ${esc(b.text_ref || '—')}">${esc(W.HALF_MARK + ' ' + ffWord('notfetched') + ' — ' + why)}</div>`
  }
  return `<pre class="cbpre">${preEsc(clipText(String(got.text ?? '')))}</pre>`
}
// the body of an opened row right now: inline, from the cache, or the pending state (the caller then loads it)
export function bodyFor(b) {
  if (!isAddressed(b)) return blockBodyHtml(null, b)
  const got = bodyCache.get(b.text_ref)
  return got ? blockBodyHtml(got, b) : pendingBodyHtml(b)
}
// a block's faithfulness as it stands NOW: an opened body that came back unproven beats the metadata's claim
export function faithNow(b) {
  if (isAddressed(b) && b._open) {
    const f = openedFf(bodyCache.get(b.text_ref))
    if (f) return f
  }
  return faithOf(b)
}

// what a resolved body just proved about its ROW: upgrade the row's mark and withdraw the section's 「以下逐字」 at once —
// not at the next repaint (2.3 MUST). `blk` is the .cblk element; DOM-guarded so string tests can pass a stub.
export function noteBodyFidelity(blk, got) {
  const f = openedFf(got)
  if (!f || !blk || !blk.classList || !blk.isConnected) return
  if (blk.dataset.ff === f || (blk.dataset.ff && blk.dataset.ff !== 'verbatim')) return // an existing visible mark keeps its claim
  blk.dataset.ff = f
  const head = blk.querySelector(':scope > .cbh')
  if (head) head.insertAdjacentHTML('beforeend', ffBadgeHtml(f, { tech: got && got.error }))
  const root = blk.closest && (blk.closest('#ctxwin') || blk.closest('#detail'))
  const sec = blk.dataset.sec
  if (root && sec) { // the section can no longer claim 以下逐字
    const hd = root.querySelector(`#sec-${sec.replace(/"/g, '\\"')} .cwsecff.v`)
    if (hd) { hd.classList.remove('v'); hd.textContent = W.HALF_MARK; hd.title = W.WINDOW_LINE }
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
  return loadBody(api, b.text_ref).then((got) => {
    if (!bc.isConnected || !bc.querySelector('pre[data-ref]')) return
    bc.innerHTML = blockBodyHtml(got, b)
    if (typeof bc.closest === 'function') noteBodyFidelity(bc.closest('.cblk'), got)
    if (isRetryable(got)) delete bc.dataset.filled
  })
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
export function ctxBlockHtml(b, i, { prevKeys, open, windowLine = false } = {}) {
  const h = b.head || { role: b.role || '', tag: b.kind || '', label: '' }
  const label = h.label || b.preview || ''
  const f = open ? faithNow({ ...b, _open: true }) : faithOf(b)
  const tag = tagWord(h.tag)
  const isNew = prevKeys && !b.volatile && !prevKeys.has(b.key)
  const bp = b.cc ? `<span class="bpbadge" title="${esc(W.CACHE_MARK_TIP)} · declared value: ${esc(JSON.stringify(b.cc))}">${esc(W.CACHE_MARK)}</span>` : ''
  const vol = b.volatile ? `<span class="volbadge" title="${esc(W.VOLATILE_MARK_TIP)}">${esc(W.VOLATILE_MARK)}</span>` : ''
  const nw = isNew ? `<span class="newmark" title="${esc(W.NEW_MARK_TIP)}">${esc(W.NEW_MARK)}</span>` : ''
  const tech = f === 'unknown' ? String(b.faithfulness) : f === 'unaddressable' ? (b.unaddressable || '') : ''
  // the window line already said "nothing here resolves": the per-block 不能回源 is not repeated (2.3 §窗口行)
  const badge = f === 'unaddressable' && windowLine ? '' : ffBadgeHtml(f, { tech })
  const sr = f === 'verbatim' ? `<span class="sr-only">,${esc(W.FF_WORD.verbatim)}</span>` : ''
  const chars = typeof b.chars === 'number' ? `<span class="cbchars">${esc(kf(b.chars))} ${esc(W.CHARS_WORD)}</span>` : ''
  const rk = b.resKey ? ` data-rk="${esc(b.resKey)}"` : ''
  return `<div class="cblk ${open ? '' : 'collapsed'} ${isNew ? 'is-new' : ''} s-${esc(b.sec)} r-${esc(b.role)} k-${esc(b.kind)}" data-bi="${i}" data-sec="${esc(b.sec)}" data-ff="${esc(f)}"${rk}>` +
    `<div class="cbh"><span class="cbrole">${esc(h.role)}</span><span class="cbtag"${tag ? '' : ` title="${esc(String(h.tag || ''))}"`}>${esc(tag || W.TAG_UNKNOWN)}</span>${label ? `<span class="cblabel">${esc(label)}</span>` : ''}${bp}${vol}${nw}${badge}${chars}${sr}` +
    `</div><div class="cbc"${open ? ' data-filled="1"' : ''}>${open ? bodyFor(b) : ''}</div></div>`
}
