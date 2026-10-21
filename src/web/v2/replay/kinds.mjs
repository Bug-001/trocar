// replay/kinds.mjs — the Readable view's renderers (spec 2.3 §两种模式, D70 ③).
// A closed set drawn from a render spec r = {as, tone?, title?, f?, kids?} that the server chose: the client never
// picks a kind, it only parses inside the kind r named. Anything unknown draws as text; a kind that cannot draw its input
// falls back to text under the fail line (a truncated source is never "completed").
//
// renderKind returns {html, more, cls}: `html` is the inner markup, `cls` the classes of the wrapper the CALLER puts around it
// (`<div class="cellread ${cls}">`, kind class plus tone class), `more` the next `from` when only a slice of a long string was
// drawn (text and code only), else null. A continuation slice is appended inside the same wrapper. Nested children (kv,
// sections, parts) carry their own `<div class="kd-… tone-…">` and are drawn whole.
// Security: every byte of input goes through esc(); only the elements and attributes of plan §2.2 are emitted.
import { esc, has, enc } from '../core/fmt.mjs'
import { failAs, opaqueLine } from '../labels/cells.mjs'

const CLASS = { sections: 'kd-sec', markdown: 'kd-md' } // every other kind's class is kd-<as>
const TONE = { error: 'tone-error', quiet: 'tone-quiet' }
const GROUP = 100, FIRST = 200 // json: entries per disclosure group; nodes on a first paint
const GUT = /^\s*\d+(?:→|\t)/

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
  let end = Math.min(s.length, from + Math.max(1, budget))
  if (end < s.length) {
    const nl = s.lastIndexOf('\n', end - 1)
    if (nl >= from) end = nl + 1
    else if (/[\ud800-\udbff]/.test(s[end - 1])) end++
  }
  return [s.slice(from, end), end < s.length ? end : null]
}

// ── the renderers: (r, body, value, o) → {html, more?, as?}; `as` re-dispatches (text over a non-string is json) ─────────
function text(r, b, v, o) {
  if (typeof b !== 'string') return { as: 'json' }
  const [s, more] = slice(b, o.from, o.budget)
  return { html: shown(s), more }
}
function code(r, b, v, o) {
  if (typeof b !== 'string') return { as: 'json' }
  const [s, more] = slice(b, o.from, o.budget)
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
function shell(r, b, v) {
  const f = r.f || {}, cmd = get(v, f.cmd), note = f.note && get(v, f.note)
  const line = typeof cmd === 'string' ? cmd : Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string') ? cmd.map(quote).join(' ') : fail()
  let html = `<div><span class="sh-ps">$</span> ${shown(line)}</div>`
  if (typeof note === 'string' && note) html += `<div class="kd-note">${shown(note)}</div>`
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const own = (p) => Array.isArray(p) && p.length === (f.body?.length ?? 0) + 1 && (f.body ?? []).every((k, i) => k === p[i]) ? p.at(-1) : undefined
    const skip = new Set([own(f.cmd), own(f.note)])
    const rest = Object.keys(b).filter((k) => !skip.has(k))
    if (rest.length) html += `<dl class="kd-kv">${rest.map((k) => `<dt>${esc(k)}</dt><dd>${child(r.kids?.[k], b[k])}</dd>`).join('')}</dl>`
  }
  return { html }
}
function kv(r, b) {
  if (!b || typeof b !== 'object') fail()
  return { html: `<dl class="kd-kv">${Object.keys(b).map((k) => `<dt>${esc(k)}</dt><dd>${child(r.kids?.[k], b[k])}</dd>`).join('')}</dl>` }
}
function sections(r, b) {
  if (typeof b !== 'string') fail()
  const open = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>/g
  let html = '', at = 0, i = 0, m
  while ((m = open.exec(b))) {
    const close = `</${m[1]}>`, end = b.indexOf(close, open.lastIndex)
    if (end < 0) continue
    if (m.index > at) html += child(undefined, b.slice(at, m.index))
    html += `<div><span class="sec-tag">${esc(m[1])}</span>${child(r.kids?.[i], b.slice(open.lastIndex, end))}</div>`
    i++
    at = open.lastIndex = end + close.length
  }
  if (!i) fail()
  if (at < b.length) html += child(undefined, b.slice(at))
  return { html }
}
function opaque(r, b, v) {
  const sig = r.f?.sig ? get(v, r.f.sig) : b
  if (sig === undefined) fail()
  return { html: esc(opaqueLine(enc(typeof sig === 'string' ? sig : JSON.stringify(sig)))) }
}
function parts(r, b) {
  if (!Array.isArray(b)) fail()
  return { html: b.map((x, i) => child(r.kids?.[i], x)).join('') }
}
function json(r, b) {
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { fail() } }
  return { html: node('', b, [], 0, { n: FIRST - 1 }) }
}
const R = { text, code, shell, json, kv, sections, opaque, parts } // markdown, diff and media draw as text until they land

// ── json tree: <details> per object / array; 2 levels open on a first paint, at most FIRST nodes; the rest closed and empty ─
const prim = (v) => typeof v === 'string' ? `<span class="j-str">${shown(JSON.stringify(v))}</span>`
  : typeof v === 'number' ? `<span class="j-num">${esc(String(v))}</span>` : `<span class="j-lit">${esc(String(v))}</span>`
const keyOf = (k) => `<span class="j-key">${esc(typeof k === 'number' ? String(k) : JSON.stringify(k))}</span>: `
const dpath = (path) => `data-path="${esc(JSON.stringify(path))}"`
const size = (n) => { let s = GROUP; while (Math.ceil(n / s) > GROUP) s *= GROUP; return s }
const shown1 = (n) => (n <= GROUP ? n : Math.ceil(n / size(n))) // the disclosures one level shows for n entries
// B.n = nodes left; opening a container pays for all the disclosures it shows at once, so later siblings are already paid for
const opens = (n, d, B) => { const k = shown1(n); if (n > 0 && d < 2 && B.n >= k) { B.n -= k; return true } return false }
function node(label, v, path, d, B) {
  if (v === null || typeof v !== 'object') return `<div>${label}${prim(v)}</div>`
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
// the children of one closed json node (or of one group, span = [a, b) from its data-span), for when it is opened
export function jsonNodeHtml(value, path, span) {
  const v = get(value, path)
  if (v === null || typeof v !== 'object') return ''
  const keys = Array.isArray(v) ? null : Object.keys(v), n = keys ? keys.length : v.length
  const [a, b] = Array.isArray(span) ? span : [0, n]
  const lo = Math.max(0, a), hi = Math.min(n, b), B = { n: FIRST - shown1(hi - lo) }
  return entries(v, keys, path, lo, hi, 2, B)
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────────
const toneOf = (r) => (r && has(TONE, r.tone) ? ' ' + TONE[r.tone] : '')
function draw(r, value, o) {
  let as = r && typeof r.as === 'string' && has(R, r.as) ? r.as : 'text'
  const tone = toneOf(r)
  try {
    const body = get(value, r?.f?.body)
    if (body === undefined && r?.f?.body != null) fail()
    let out = R[as](r || {}, body, value, o)
    if (out.as) { as = out.as; out = R[as](r || {}, body, value, o) }
    return { html: out.html, more: out.more ?? null, cls: (CLASS[as] || 'kd-' + as) + tone }
  } catch {
    const [s, more] = slice(asText(value), o.from, o.budget)
    return { html: (o.from === 0 ? `<div class="kd-fail">${esc(failAs(as))}</div>` : '') + shown(s), more, cls: 'kd-text' + tone }
  }
}
export function renderKind(r, value, { from = 0, budget = 20000 } = {}) {
  return draw(r, value, { from, budget })
}
// a nested child: drawn whole, inside its own kind wrapper; a missing spec is text
function child(r, v) {
  const out = draw(r || { as: 'text' }, v, { from: 0, budget: Infinity })
  return `<div class="${out.cls}">${out.html}</div>`
}
