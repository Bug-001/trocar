// replay/kinds.mjs — the Readable view's renderers (spec 2.3 §两种模式, D70 ③).
// A closed set drawn from a render spec r = {as, tone?, title?, guess?, f?, kids?} that the server chose: the client never
// picks a kind, it only parses inside the kind r named. Anything unknown draws as text; a kind that cannot draw its input
// falls back to text under the fail line (a truncated source is never "completed").
//
// renderKind(r, body, {from, budget}) draws view.body and returns {html, more, cls, as, shown, total}: `html` is the inner markup,
// `cls` the classes of the wrapper the CALLER puts around it (`<div class="cellread ${cls}">`, kind class plus tone class), `more`
// the next `from` when only a slice was drawn (text, code, markdown and a tool's description), else null; `shown` the characters
// drawn when a nested part was cut (else null); `total` the cell's readable characters. A continuation slice is appended inside
// the same wrapper. Nested children (kv, parts) carry their own `<div class="kd-… tone-…">`. One draw spends at most `budget`
// characters of string (B.c): a string past what is left is cut, and the rest of it opens from a `j-more` disclosure, a slice at a
// time (jsonNodeHtml); a nested diff string past it is drawn as text.
// Paths: r.f paths are from the value r describes, the body at the top and the child value in kids; every data-path and
// data-media written is absolute from view.body, and a path may run through a string that holds JSON.
// Security: every byte of input goes through esc() or the markdown renderer; only the allowed cell elements and attributes
// (RFC 2.3 §两种模式) are emitted.
import { esc, has, bytes } from '../core/fmt.mjs'
import { FAIL_LINE, OPAQUE_LINE, NO_ARGS, REQUIRED, IMAGE_URL, paramsLine, mediaAlt, moreChars, BEFORE, AFTER, SAVE } from '../labels/cells.mjs'

const CLASS = { markdown: 'kd-md' } // every other kind's class is kd-<as>
const TONE = { error: 'tone-error', quiet: 'tone-quiet' }
const GROUP = 100, FIRST = 200 // json: entries per disclosure group; nodes on a first paint
const GUT = /^\s*\d+(?:→|\t)/
const SHORT = 80 // kv: a value this long or shorter, on one line, stays on the key's line
const WALK = 100000 // total: the most values one count visits
const DMAX = 256, NMAX = 2000 // diff: an edit pair gets a line diff up to D edits and this many lines per side, else two panes

export const valueOf = (text) => { try { return JSON.parse(text) } catch { return text } }

export const get = (v, path) => {
  if (path == null) return v
  if (!Array.isArray(path)) return undefined
  for (const k of path) {
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return undefined } } // a block whose JSON is stored in a string
    if (v == null || typeof v !== 'object' || !has(v, k)) return undefined
    v = v[k]
  }
  return v
}
const fail = () => { throw new Error('cannot draw') }
// an ANSI escape's ESC byte in code (2.3 §两种模式): the span holds the byte itself, so a copy carries it; cells.css draws it as a boxed ESC
const ESC = '<span class="kd-esc" title="ESC byte (0x1B)">\u001b</span>'
const shown = (s) => esc(s).replace(/\r/g, '&#13;') // a raw CR would be read back as LF
const titled = (r) => (r.title != null ? `<div class="kd-title">${esc(r.title)}</div>` : '')
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
  let html = o.from === 0 ? titled(r) : ''
  html += s.split('\n').map((line, i) => {
    const m = r.f?.gutter && (i > 0 || atStart) ? GUT.exec(line) : null
    const rest = shown(m ? line.slice(m[0].length) : line).replace(/\u001b/g, ESC) // a drawn word, not ␛: that glyph falls back to a third font (1.5 #5)
    return m ? `<span class="gut" aria-hidden="true">${esc(m[0])}</span>${rest}` : rest
  }).join('\n')
  return { html, more }
}
// for display only: an argv array as one line a shell would read back
const quote = (a) => (/^[\w./=:,@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
function shell(r, b, v, o) {
  const f = r.f || {}, cmd = get(v, f.cmd)
  const line = typeof cmd === 'string' ? cmd : Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string') ? cmd.map(quote).join(' ') : fail()
  let html = `<div><span class="sh-ps">$</span> ${shown(line)}</div>`
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const own = (p) => Array.isArray(p) && p.length === (f.body?.length ?? 0) + 1 && (f.body ?? []).every((k, i) => k === p[i]) ? p.at(-1) : undefined
    const skip = new Set([own(f.cmd), own(f.note)])
    const rest = Object.keys(b).filter((k) => !skip.has(k))
    if (rest.length) html += `<div class="kd-kv">${rows(rest, b, r, o)}</div>`
  }
  return { html }
}
const short = (x) => typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && x.length <= SHORT && !x.includes('\n'))
const rows = (keys, b, r, o) => keys.map((k) =>
  `<div class="kv-row${short(b[k]) ? '' : ' kv-long'}"><span class="kv-k">${shown(k)}</span>${child(r.kids?.[k], b[k], o, [...o.path, k])}</div>`).join('')
function kv(r, b, v, o) {
  if (!b || typeof b !== 'object') fail()
  const keys = Object.keys(b)
  return { html: keys.length ? rows(keys, b, r, o) : esc(NO_ARGS) }
}
function opaque() { return { html: esc(OPAQUE_LINE) } }
function parts(r, b, v, o) {
  if (!Array.isArray(b)) fail()
  return { html: b.map((x, i) => child(r.kids?.[i], x, o, [...o.path, i])).join('') }
}
function json(r, b, v, o) {
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { fail() } }
  const B = { n: FIRST - 1, c: o.B.c, cut: false }, html = node('', b, o.path, 0, B)
  o.B.c = B.c; o.B.cut ||= B.cut
  return { html }
}
// ── markdown: drawn by the renderer each build registers (setMarkdown), so this module carries no npm dependency. fn(src, {from,
// budget, file}) → {html, more}: `from` is the last slice's `more` (a source offset), a slice ends on a top-level token and holds at
// least one, `more` is null when all is drawn. With nothing registered, or nothing left to spend, it is text. ─────────────────
let md = null
export function setMarkdown(fn) { md = fn }
function markdown(r, b, v, o) {
  if (typeof b !== 'string') fail()
  if (!md || o.budget <= 0) return { as: 'text' }
  const src = r.f?.gutter ? b.split('\n').map((l) => l.replace(GUT, '')).join('\n') : b
  const { html, more } = md(src, { from: o.from, budget: o.budget, file: !!r.f?.file })
  o.B.c -= (more ?? src.length) - o.from
  return { html: (o.from === 0 ? titled(r) : '') + html, more }
}

// ── tool: the description as markdown, its `more` chain first; Parameters come with the slice that has none. A schema is read by
// JSON Schema's standard keys only, drawn whole inside the budget (past it the slice after the description has it all to itself);
// one with no properties, or past a whole slice, is the JSON tree ──────────────────────────────────────────────────────────
const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x)
const under = (s) => [s.items, s.anyOf, s.oneOf].flat().filter(isObj) // what a value of s holds or may be instead
const shapes = (s) => [...(isObj(s.properties) ? [s] : []), ...under(s).flatMap(shapes)]
const enumsOf = (s) => [...[s.enum].flat().filter((x) => x !== undefined), ...under(s).flatMap(enumsOf)]
function typeOf(s) {
  const alts = [s.anyOf, s.oneOf].flat().filter(isObj)
  if (alts.length) return [...new Set(alts.map(typeOf).filter(Boolean))].join(' | ')
  const t = [s.type].flat().filter((x) => typeof x === 'string').join(' | ')
  if (t !== 'array' || !isObj(s.items)) return t
  const item = typeOf(s.items)
  return item.includes(' | ') ? `(${item})[]` : item ? `${item}[]` : t
}
const word = (c, s) => (s ? `<span class="${c}">${shown(s)}</span>` : '')
const paramsOf = (schema) => shapes(schema).map((x) => Object.keys(x.properties).map((k) => {
  const s = isObj(x.properties[k]) ? x.properties[k] : {}, kids = paramsOf(s)
  return `<div class="parm">${word('pn', k)}${word('pt', typeOf(s))}${word('pr', [x.required].flat().includes(k) && REQUIRED)}` +
    `${word('pe', enumsOf(s).map(asText).join(' | '))}${word('pd', typeof s.description === 'string' && s.description)}${kids && `<div class="pk">${kids}</div>`}</div>`
}).join('')).join('')
function tool(r, b, v, o) {
  const f = r.f || {}, desc = f.desc != null ? get(v, f.desc) : undefined, schema = f.schema != null ? get(v, f.schema) : undefined
  if (desc === undefined ? schema === undefined : typeof desc !== 'string') fail()
  const len = desc?.length ?? 0
  let html = ''
  if (o.from < len) {
    const d = draw({ as: 'markdown' }, desc, { ...o, root: [...o.root, ...f.desc] })
    html = `<div class="${d.cls}">${d.html}</div>`
    if (d.more != null) return { html, more: d.more }
  }
  if (schema === undefined) return { html }
  const at = [...o.root, ...f.schema], size = JSON.stringify(schema).length, fits = size <= o.B.c
  if (!fits && o.from < len) return { html, more: len }
  const read = isObj(schema) && fits ? shapes(schema) : []
  if (!read.length) return { html: html + child({ as: 'text' }, schema, o, at) }
  o.B.c -= size
  const names = read.flatMap((s) => Object.keys(s.properties))
  return { html: html + (names.length ? `<details class="tool-params" ${dpath(at)}><summary>${shown(paramsLine(names))}</summary>${paramsOf(schema)}</details>` : `<div class="kd-note">${esc(NO_ARGS)}</div>`) }
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
  const f = r.f || {}, cap = titled(r)
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

// ── media: png / jpeg / gif / webp as an <img> with no src (the caller sets a blob: URL after insertion, from the data at the
// path in data-media); svg as code; any other data as a file line with Save; no data (a URL) as text, never loaded ───────
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
  const f = r.f || {}, data = f.data != null ? get(v, f.data) : undefined, url = f.url != null ? get(v, f.url) : undefined
  if (data == null) return { html: typeof url === 'string' ? `<div class="kd-note">${esc(IMAGE_URL)}</div><div>${shown(url)}</div>` : `<div>${shown(asText(b))}</div>` }
  if (typeof data !== 'string') fail()
  const bin = atob(data), mime = String((f.mime != null && get(v, f.mime)) || '').toLowerCase().split(';')[0].trim()
  const sub = mime.split('/')[1] || '', src = `data-media="${esc(JSON.stringify([...o.root, ...f.data]))}" data-mime="${esc(mime)}"`
  if (sub.startsWith('svg')) return { as: 'code', body: new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))) }
  const d = dims(bin)
  if (d) return { html: `<img ${src} width="${d[1]}" height="${d[2]}" alt="${esc(mediaAlt(d[0], d[1], d[2], bin.length))}" decoding="async">` }
  if (/^(?:png|jpe?g|gif|webp)$/.test(sub)) fail() // an image type whose header does not read
  return { html: `<div class="kd-file">${esc((sub || mime || '?').toUpperCase())} · ${esc(bytes(bin.length))} <button type="button" data-cellsave ${src}>${esc(SAVE)}</button></div>` }
}
const R = { text, code, shell, json, kv, opaque, parts, markdown, diff, media, tool }

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
// `value` is the view's body and `path` absolute from it
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
function draw(r, value, o) {
  let as = r && typeof r.as === 'string' && has(R, r.as) ? r.as : 'text', body
  const tone = toneOf(r), from = r?.f?.body, at = [...o.root, ...(Array.isArray(from) ? from : [])]
  try {
    body = get(value, from)
    if (body === undefined && from != null) fail()
    if (as === 'diff' && typeof body === 'string' && (o.from > 0 || body.length > o.budget)) as = 'text' // drawn whole: past the budget it is text, sliced
    const d = { ...o, path: at }
    let out = R[as](r || {}, body, value, d)
    if (out.as) { as = out.as; out = R[as](r || {}, has(out, 'body') ? out.body : body, value, d) }
    return { html: out.html, more: out.more ?? null, cls: (CLASS[as] || 'kd-' + as) + (as === 'code' && r?.f?.wrap ? ' kd-wrap' : '') + tone, as, src: body, at }
  } catch {
    const all = asText(body ?? value), [s, more] = slice(all, o.from, o.budget)
    return { html: (o.from === 0 ? `<div class="kd-fail">${esc(FAIL_LINE)}</div>` : '') + shown(take(o, s)), more, cls: 'kd-text' + tone, as: 'text', src: typeof body === 'string' ? body : null, at, size: all.length }
  }
}
// the readable characters of a body: a string's length, the strings of an object summed, at most WALK values visited
function weigh(v) {
  const todo = [v]
  let n = 0, left = WALK
  while (todo.length) {
    const x = todo.pop()
    if (typeof x === 'string') n += x.length
    else if (x && typeof x === 'object') for (const y of Object.values(x)) { if (left-- <= 0) break; todo.push(y) }
  }
  return n
}
export function renderKind(r, body, { from = 0, budget = 20000 } = {}) {
  const B = { c: budget, cut: false }, { html, more, cls, as, src, size } = draw(r, body, { from, budget, B, root: [] })
  return { html, more, cls, as, shown: more == null && B.cut ? budget - Math.max(0, B.c) : null, total: size ?? weigh(src) }
}
// a nested child, inside its own kind wrapper, drawn within the budget left; a missing spec is text. `root` is the absolute path
// of v: a cut string's rest opens at the path of what was drawn.
function child(r, v, o, root) {
  const out = draw(r || { as: 'text' }, v, { from: 0, budget: Math.max(0, o.B.c), B: o.B, root })
  if (out.more != null) o.B.cut = true
  const rest = out.more != null && typeof out.src === 'string' ? `<details class="j-more" ${dpath(out.at)} data-span="${out.more},${out.src.length}"><summary>${esc(moreChars(out.src.length - out.more))}</summary></details>` : ''
  return `<div class="${out.cls}">${out.html}${rest}</div>`
}
