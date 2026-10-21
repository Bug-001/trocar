// replay/kinds.mjs — the Readable view's renderers (spec 2.3 §两种模式, D70 ③).
// A closed set drawn from a render spec r = {as, tone?, title?, f?, kids?} that the server chose: the client never
// picks a kind, it only parses inside the kind r named. Anything unknown draws as text; a kind that cannot draw its input
// falls back to text under the fail line (a truncated source is never "completed").
//
// renderKind returns {html, more, cls}: `html` is the inner markup, `cls` the classes of the wrapper the CALLER puts around it
// (`<div class="cellread ${cls}">`, kind class plus tone class), `more` the next `from` when only a slice of a long string was
// drawn (text, code and markdown; `bid` names a media cell's img), else null; `shown` the characters drawn when a nested part
// was cut (else null). A continuation slice is appended inside the same wrapper. Nested children (kv, sections, parts) carry
// their own `<div class="kd-… tone-…">`. One draw spends at most `budget` characters of string (B.c): a string past what is left
// is cut, and the rest of it opens from a `j-more` disclosure, a slice at a time (jsonNodeHtml); a nested diff or sections
// string past it is drawn as text.
// Security: every byte of input goes through esc(); only the elements and attributes of plan §2.2 are emitted.
import { esc, has, enc, bytes } from '../core/fmt.mjs'
import { failAs, opaqueLine, mediaAlt, moreChars, BEFORE, AFTER, SAVE } from '../labels/cells.mjs'

const CLASS = { sections: 'kd-sec', markdown: 'kd-md' } // every other kind's class is kd-<as>
const TONE = { error: 'tone-error', quiet: 'tone-quiet' }
const GROUP = 100, FIRST = 200 // json: entries per disclosure group; nodes on a first paint
const GUT = /^\s*\d+(?:→|\t)/
const DMAX = 256, NMAX = 2000 // diff: an edit pair gets a line diff up to D edits and this many lines per side, else two panes

export const valueOf = (text) => { try { return JSON.parse(text) } catch { return text } }

const get = (v, path) => {
  if (path == null) return v
  if (!Array.isArray(path)) return undefined
  for (const k of path) { if (v == null || typeof v !== 'object' || !has(v, k)) return undefined; v = v[k] }
  return v
}
const fail = () => { throw new Error('cannot draw') }
const shown = (s) => esc(s).replace(/\r/g, '&#13;') // a raw CR would be read back as LF
const asText = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 2) ?? String(v) } catch { return String(v) } }

// a slice of s from `from`, ending at a line end inside the budget when there is one, never inside a surrogate pair
function slice(s, from, budget) {
  let end = Math.min(s.length, from + Math.max(0, budget))
  if (end < s.length) {
    const nl = s.lastIndexOf('\n', end - 1)
    if (nl >= from) end = nl + 1
    else if (/[\ud800-\udbff]/.test(s[end - 1])) end++
  }
  return [s.slice(from, end), end < s.length ? end : null]
}
const take = (o, s) => { if (o.B) o.B.c -= s.length; return s } // spend the draw's character budget
// s[a, …) drawn within the budget left; the rest behind a disclosure that jsonNodeHtml opens (q: inside a JSON string literal)
function cutStr(s, a, B, path, q) {
  const [part, end] = slice(s, a, B.c)
  B.c -= part.length
  const body = q ? JSON.stringify(part).slice(1, -1) + (end == null ? '"' : '') : part // the opening quote is prim's
  if (end == null) return shown(body)
  B.cut = true
  return shown(body) + (path ? `<details class="j-more" ${dpath(path)} data-span="${end},${s.length}"${q ? ' data-q=""' : ''}><summary>${esc(moreChars(s.length - end))}</summary></details>` : '')
}

// ── the renderers: (r, body, value, o) → {html, more?, as?}; `as` re-dispatches (text over a non-string is json) ─────────
function text(r, b, v, o) {
  if (typeof b !== 'string') return { as: 'json' }
  const [s, more] = slice(b, o.from, o.budget)
  return { html: shown(take(o, s)), more }
}
function code(r, b, v, o) {
  if (typeof b !== 'string') return { as: 'json' }
  const [s, more] = slice(b, o.from, o.budget)
  take(o, s)
  const atStart = o.from === 0 || b[o.from - 1] === '\n'
  let html = o.from === 0 && r.title != null ? `<div class="kd-title">${esc(r.title)}</div>` : ''
  html += s.split('\n').map((line, i) => {
    const m = r.f?.gutter && (i > 0 || atStart) ? GUT.exec(line) : null
    const rest = shown(m ? line.slice(m[0].length) : line).replace(/\u001b/g, '␛')
    return m ? `<span class="gut" aria-hidden="true">${esc(m[0])}</span>${rest}` : rest
  }).join('\n')
  return { html, more }
}
// for display only: an argv array as one line a shell would read back
const quote = (a) => (/^[\w./=:,@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
function shell(r, b, v, o) {
  const f = r.f || {}, cmd = get(v, f.cmd), note = f.note && get(v, f.note)
  const line = typeof cmd === 'string' ? cmd : Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string') ? cmd.map(quote).join(' ') : fail()
  let html = `<div><span class="sh-ps">$</span> ${shown(line)}</div>`
  if (typeof note === 'string' && note) html += `<div class="kd-note">${shown(note)}</div>`
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const own = (p) => Array.isArray(p) && p.length === (f.body?.length ?? 0) + 1 && (f.body ?? []).every((k, i) => k === p[i]) ? p.at(-1) : undefined
    const skip = new Set([own(f.cmd), own(f.note)])
    const rest = Object.keys(b).filter((k) => !skip.has(k))
    if (rest.length) html += `<dl class="kd-kv">${rest.map((k) => `<dt>${esc(k)}</dt><dd>${child(r.kids?.[k], b[k], o, k)}</dd>`).join('')}</dl>`
  }
  return { html }
}
function kv(r, b, v, o) {
  if (!b || typeof b !== 'object') fail()
  return { html: `<dl class="kd-kv">${Object.keys(b).map((k) => `<dt>${esc(k)}</dt><dd>${child(r.kids?.[k], b[k], o, k)}</dd>`).join('')}</dl>` }
}
function sections(r, b, v, o) {
  if (typeof b !== 'string') fail()
  const open = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>/g
  let html = '', at = 0, i = 0, m
  while ((m = open.exec(b))) {
    const close = `</${m[1]}>`, end = b.indexOf(close, open.lastIndex)
    if (end < 0) continue
    if (m.index > at) html += child(undefined, b.slice(at, m.index), o)
    html += `<div><span class="sec-tag">${esc(m[1])}</span>${child(r.kids?.[i], b.slice(open.lastIndex, end), o)}</div>`
    i++
    at = open.lastIndex = end + close.length
  }
  if (!i) fail()
  if (at < b.length) html += child(undefined, b.slice(at), o)
  return { html }
}
function opaque(r, b, v) {
  const sig = r.f?.sig ? get(v, r.f.sig) : b
  if (sig === undefined) fail()
  return { html: esc(opaqueLine(enc(typeof sig === 'string' ? sig : JSON.stringify(sig)))) }
}
function parts(r, b, v, o) {
  if (!Array.isArray(b)) fail()
  return { html: b.map((x, i) => child(r.kids?.[i], x, o, i)).join('') }
}
function json(r, b, v, o) {
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { fail() } }
  const B = { n: FIRST - 1, c: o.B.c, cut: false }, html = node('', b, o.path ?? [], 0, B)
  o.B.c = B.c; o.B.cut ||= B.cut
  return { html }
}
// ── markdown: a subset; every byte is text through esc(), so raw HTML in the source shows as text and a link is its text
// plus its URL, never an anchor ─────────────────────────────────────────────────────────────────────────────────────
const INL = /`([^`]+)`|\*\*([^]+?)\*\*|__([^]+?)__|\*([^*\s][^*]*?)\*|(?<!\w)_([^_\s][^_]*?)_(?!\w)|!?\[([^\]]*)\]\(([^)\s]*)\)/g
function inl(s) {
  if (s.length > 10000) return shown(s) // a long line is plain text: no inline scan to pay for
  let h = '', at = 0
  for (const m of s.matchAll(INL)) {
    h += shown(s.slice(at, m.index))
    at = m.index + m[0].length
    h += m[1] != null ? `<code>${shown(m[1])}</code>` : m[2] != null || m[3] != null ? `<span class="md-b">${inl(m[2] ?? m[3])}</span>`
      : m[4] != null || m[5] != null ? `<span class="md-em">${inl(m[4] ?? m[5])}</span>` : `${inl(m[6])} (${shown(m[7])})`
  }
  return h + shown(s.slice(at))
}
const SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const cellsOf = (l) => l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
const row = (l, t) => `<tr>${cellsOf(l).map((c) => `<${t}>${inl(c)}</${t}>`).join('')}</tr>`
function markdown(r, b, v, o) {
  if (typeof b !== 'string') fail()
  const [src, more] = slice(b, o.from, o.budget), L = take(o, src).split('\n')
  let h = '', para = [], m
  const flush = () => { if (para.length) h += `<div>${para.map(inl).join('\n')}</div>`; para = [] }
  for (let i = 0; i < L.length; i++) {
    const l = L[i], put = (x) => { flush(); h += x }
    if ((m = /^\s*(`{3,}|~{3,})/.exec(l))) { // a fence: drawn by the code renderer; an unclosed one runs to the end
      let e = i + 1
      while (e < L.length && !L[e].trim().startsWith(m[1])) e++
      put(child({ as: 'code' }, L.slice(i + 1, e).join('\n'), o))
      i = e
    } else if (l.includes('|') && SEP.test(L[i + 1] ?? '') && L[i + 1].includes('-')) {
      let rows = row(l, 'th')
      for (i += 2; i < L.length && L[i].includes('|') && L[i].trim(); i++) rows += row(L[i], 'td')
      i--
      put(`<div class="md-table"><table>${rows}</table></div>`)
    } else if ((m = /^ {0,3}(#{1,6})\s+([^]*)$/.exec(l))) put(`<div class="md-h${m[1].length}">${inl(m[2])}</div>`)
    else if ((m = /^\s*>\s?([^]*)$/.exec(l))) put(`<div class="md-q">${inl(m[1])}</div>`)
    else if ((m = /^\s*([-*+]|\d+[.)])\s+([^]*)$/.exec(l))) put(`<div class="md-li">${shown(m[1])} ${inl(m[2])}</div>`)
    else if (l.trim()) para.push(l)
    else flush()
  }
  flush()
  return { html: h, more }
}

// ── diff: unified only; every changed line starts with its sign character ────────────────────────────────────────────
const SIGN = { ' ': 'd-ctx', '-': 'd-del', '+': 'd-add' }
const dline = (c, s) => `<div class="${c}">${shown(s)}</div>`
const pane = (word, s) => `<div class="d-pane"><div class="d-panel">${esc(word)}</div>${shown(s)}</div>`
// Myers' O(ND) line diff → [[sign, line]], or null past DMAX edits or NMAX lines a side (the work is then at most ~(N+M)·DMAX)
function myers(a, b) {
  const n = a.length, m = b.length, off = DMAX + 1, v = new Int32Array(2 * off + 1), trace = []
  if (n > NMAX || m > NMAX) return null
  for (let d = 0; d <= DMAX; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) return back(trace, a, b, off)
    }
  }
  return null
}
function back(trace, a, b, off) {
  let x = a.length, y = b.length
  const out = []
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y
    const pk = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1, px = v[off + pk], py = px - pk
    while (x > px && y > py) { y--; out.push([' ', a[--x]]) }
    if (d > 0) out.push(x === px ? ['+', b[--y]] : ['-', a[--x]])
    x = px; y = py
  }
  return out.reverse()
}
function diff(r, b, v) {
  const f = r.f || {}, cap = r.title != null ? `<div class="kd-title">${esc(r.title)}</div>` : ''
  if (f.old != null || f.new != null) {
    const a = get(v, f.old), c = get(v, f.new)
    if (typeof a !== 'string' || typeof c !== 'string') fail()
    const ops = myers(a.split('\n'), c.split('\n'))
    return { html: cap + (ops ? ops.map(([s, l]) => dline(SIGN[s], s + l)).join('') : pane(BEFORE, a) + pane(AFTER, c)) }
  }
  const p = f.patch != null ? get(v, f.patch) : b
  if (typeof p !== 'string') fail()
  const L = p.split('\n'), hunk = (l) => l.startsWith('@@') || l.startsWith('***')
  if (L.at(-1) === '') L.pop()
  if (!L.some(hunk)) fail() // not a patch
  let head = true
  return { html: cap + L.map((l) => {
    if (hunk(l)) head = false
    return dline(hunk(l) || (head && /^(?:---|\+\+\+) /.test(l)) ? 'd-hunk' : SIGN[l[0]] || 'd-ctx', l)
  }).join('') }
}

// ── media: png / jpeg / gif / webp as an <img> with no src (the caller sets a blob: URL after insertion); svg as code;
// any other data as a file line with Save; no data (a URL) as text, never loaded ─────────────────────────────────────
function dims(s) { // [type, width, height] from the image header, else null
  const at = (i) => s.charCodeAt(i), be = (i) => at(i) << 8 | at(i + 1), le = (i) => at(i) | at(i + 1) << 8
  const le3 = (i) => le(i) | at(i + 2) << 16, ok = (t, w, h) => (w > 0 && h > 0 ? [t, w, h] : null)
  if (s.startsWith('\x89PNG\r\n\x1a\n') && s.slice(12, 16) === 'IHDR') return ok('png', be(16) * 65536 + be(18), be(20) * 65536 + be(22))
  if (/^GIF8[79]a/.test(s)) return ok('gif', le(6), le(8))
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') {
    const c = s.slice(12, 16), n = (le(21) | at(23) << 16 | at(24) << 24) >>> 0
    return c === 'VP8 ' ? ok('webp', le(26) & 0x3fff, le(28) & 0x3fff) : c === 'VP8L' ? ok('webp', (n & 0x3fff) + 1, (n >>> 14 & 0x3fff) + 1)
      : c === 'VP8X' ? ok('webp', le3(24) + 1, le3(27) + 1) : null
  }
  if (s.startsWith('\xff\xd8')) {
    for (let i = 2; i + 9 <= s.length;) {
      const mk = at(i + 1)
      if (at(i) !== 0xff || mk === 0xd9 || mk === 0xda) return null
      if (mk === 0xff) i++
      else if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd8)) i += 2
      else if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return ok('jpeg', be(i + 7), be(i + 5))
      else i += 2 + be(i + 2)
    }
  }
  return null
}
function media(r, b, v, o) {
  const f = r.f || {}, data = f.data != null ? get(v, f.data) : undefined
  if (data == null) return { html: `<div>${shown(asText(b))}</div>` }
  if (typeof data !== 'string') fail()
  const bin = atob(data), mime = String((f.mime != null && get(v, f.mime)) || '').toLowerCase().split(';')[0].trim()
  const sub = mime.split('/')[1] || ''
  if (sub.startsWith('svg')) return { as: 'code', body: new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))) }
  const d = dims(bin)
  if (d) return { html: `<img data-media="${esc(o.bid ?? '')}" width="${d[1]}" height="${d[2]}" alt="${esc(mediaAlt(d[0], d[1], d[2], bin.length))}" decoding="async">` }
  if (/^(?:png|jpe?g|gif|webp)$/.test(sub)) fail() // an image type whose header does not read
  return { html: `<div class="kd-file">${esc((sub || mime || '?').toUpperCase())} · ${esc(bytes(bin.length))} <button type="button" data-cellsave>${esc(SAVE)}</button></div>` }
}
const R = { text, code, shell, json, kv, sections, opaque, parts, markdown, diff, media }

// ── json tree: <details> per object / array; 2 levels open on a first paint, at most FIRST nodes; the rest closed and empty ─
const prim = (v, path, B) => typeof v === 'string' ? `<span class="j-str">&quot;${cutStr(v, 0, B, path, true)}</span>`
  : typeof v === 'number' ? `<span class="j-num">${esc(String(v))}</span>` : `<span class="j-lit">${esc(String(v))}</span>`
const keyOf = (k) => `<span class="j-key">${esc(typeof k === 'number' ? String(k) : JSON.stringify(k))}</span>: `
const dpath = (path) => `data-path="${esc(JSON.stringify(path))}"`
const size = (n) => { let s = GROUP; while (Math.ceil(n / s) > GROUP) s *= GROUP; return s }
const shown1 = (n) => (n <= GROUP ? n : Math.ceil(n / size(n))) // the disclosures one level shows for n entries
// B.n = nodes left; opening a container pays for all the disclosures it shows at once, so later siblings are already paid for
const opens = (n, d, B) => { const k = shown1(n); if (n > 0 && d < 2 && B.n >= k) { B.n -= k; return true } return false }
function node(label, v, path, d, B) {
  if (v === null || typeof v !== 'object') return `<div>${label}${prim(v, path, B)}</div>`
  const keys = Array.isArray(v) ? null : Object.keys(v), n = keys ? keys.length : v.length
  const open = opens(n, d, B)
  return `<details${open ? ' open' : ''} ${dpath(path)}><summary>${label}<span class="j-lit">${keys ? `{${n}}` : `[${n}]`}</span></summary>${open ? entries(v, keys, path, 0, n, d + 1, B) : ''}</details>`
}
function entries(v, keys, path, a, b, d, B) {
  let h = ''
  if (b - a <= GROUP) {
    for (let i = a; i < b; i++) { const k = keys ? keys[i] : i; h += node(keyOf(k), v[k], [...path, k], d, B) }
    return h
  }
  const s = size(b - a)
  for (let g = a; g < b; g += s) {
    const e = Math.min(b, g + s), open = opens(e - g, d - 1, B) // a group is not a level of its own
    h += `<details${open ? ' open' : ''} ${dpath(path)} data-span="${g},${e}"><summary><span class="j-lit">${g}–${e - 1}</span></summary>${open ? entries(v, keys, path, g, e, d, B) : ''}</details>`
  }
  return h
}
// the children of one closed json node (or of one group, span = [a, b) from its data-span), for when it is opened; for a
// string (a j-more disclosure, q: inside a JSON literal) the next `budget` characters of it from span[0]
export function jsonNodeHtml(value, path, span, { q = false, budget = 20000 } = {}) {
  const v = get(value, path)
  if (typeof v === 'string') { const a = Array.isArray(span) ? span[0] : 0; return a >= 0 && a < v.length ? `<span class="j-str">${cutStr(v, a, { c: budget }, path, q)}</span>` : '' }
  if (v === null || typeof v !== 'object') return ''
  const keys = Array.isArray(v) ? null : Object.keys(v), n = keys ? keys.length : v.length
  const [a, b] = Array.isArray(span) ? span : [0, n]
  const lo = Math.max(0, a), hi = Math.min(n, b), B = { n: FIRST - shown1(hi - lo), c: budget }
  return entries(v, keys, path, lo, hi, 2, B)
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────────
const toneOf = (r) => (r && has(TONE, r.tone) ? ' ' + TONE[r.tone] : '')
const WHOLE = new Set(['diff', 'sections']) // kinds that draw a string whole: past the budget it is text, sliced
function draw(r, value, o) {
  let as = r && typeof r.as === 'string' && has(R, r.as) ? r.as : 'text'
  const tone = toneOf(r)
  try {
    const body = get(value, r?.f?.body)
    if (body === undefined && r?.f?.body != null) fail()
    if (WHOLE.has(as) && typeof body === 'string' && (o.from > 0 || body.length > o.budget)) as = 'text'
    let out = R[as](r || {}, body, value, o)
    if (out.as) { as = out.as; out = R[as](r || {}, has(out, 'body') ? out.body : body, value, o) }
    return { html: out.html, more: out.more ?? null, cls: (CLASS[as] || 'kd-' + as) + tone }
  } catch {
    const [s, more] = slice(asText(value), o.from, o.budget)
    return { html: (o.from === 0 ? `<div class="kd-fail">${esc(failAs(as))}</div>` : '') + shown(take(o, s)), more, cls: 'kd-text' + tone }
  }
}
export function renderKind(r, value, { from = 0, budget = 20000, bid } = {}) {
  const B = { c: budget, cut: false }, out = draw(r, value, { from, budget, bid, B, path: [] })
  return { ...out, shown: out.more == null && B.cut ? budget - Math.max(0, B.c) : null }
}
// a nested child, inside its own kind wrapper, drawn within the budget left; a missing spec is text. `key` extends the path
// from the body (null when the child is not a value at a path, as a sections substring is): a cut string's rest opens there.
function child(r, v, o, key) {
  const path = o.path && key !== undefined ? [...o.path, key] : null
  const out = draw(r || { as: 'text' }, v, { from: 0, budget: Math.max(0, o.B.c), bid: o.bid, B: o.B, path })
  if (out.more != null) o.B.cut = true
  const rest = out.more != null && typeof v === 'string' && path ? `<details class="j-more" ${dpath(path)} data-span="${out.more},${v.length}"><summary>${esc(moreChars(v.length - out.more))}</summary></details>` : ''
  return `<div class="${out.cls}">${out.html}${rest}</div>`
}
