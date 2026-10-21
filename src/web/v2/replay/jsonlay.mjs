// replay/jsonlay.mjs — the Raw view's layout pass (2.3 · D70). The stored bytes are copied through, escaped for HTML; the line
// breaks and indents that make them readable are INSERTED, each in a <span class="lay" aria-hidden="true">. Contract: drop every
// .lay span and un-escape, and you hold exactly the input. Pure and DOM-free; no element other than the lay span is emitted.
//
// One scan. Outside strings: after { [ , and before } ], a newline + indent — only where the wire has no whitespace there, so
// pretty JSON gets nothing; empty containers stay; nothing after ':'. Inside strings: escapes stay visible, a break follows each
// \n escape. A body that is not one JSON value goes line by line: from a line's first { or [ if the rest parses, else as is.
// Every slice ends at the budget in both modes (a long line is cut inside, never inside a surrogate pair); `state` carries on.
import { esc } from '../core/fmt.mjs'

const JSON_MAX = 256 * 1024, LINE_MAX = 64 * 1024
const WS = new Set([' ', '\t', '\r', '\n'])
const lay = (s) => `<span class="lay" aria-hidden="true">${s}</span>`
const brk = (d) => lay('\n' + '  '.repeat(Math.min(Math.max(d, 0), 12)))
const verb = (t) => esc(t).replace(/\r/g, '&#13;') // a raw CR would be normalised to LF by the parser
const opens = (c) => c === '{' || c === '['

function modeOf(t) {
  if (t.length <= JSON_MAX) { try { JSON.parse(t); return 'json' } catch { return 'line' } }
  const p = t.trim()
  return (p[0] === '{' && p.at(-1) === '}') || (p[0] === '[' && p.at(-1) === ']') || (p.length > 1 && p[0] === '"' && p.at(-1) === '"') ? 'json' : 'line'
}
// the end of the slice [at, at+budget), one further if it would split a surrogate pair
function cut(t, at, budget) {
  let end = Math.min(t.length, at + Math.max(1, budget))
  const c = t.charCodeAt(end - 1)
  if (c >= 0xD800 && c <= 0xDBFF && end < t.length) end++
  return end
}

// lay out t[i, end) as JSON, carrying depth / in-string / escape in `st`
function scan(t, i, end, st) {
  let h = '', run = i
  const put = (k, s) => { h += verb(t.slice(run, k)) + s; run = k }
  for (; i < end; i++) {
    const c = t[i]
    if (st.s) {
      if (st.e) { st.e = false; if (c === 'n') put(i + 1, lay('\n')) } else if (c === '\\') st.e = true; else if (c === '"') st.s = false
    } else if (c === '"') st.s = true
    else if (c === '}' || c === ']') {
      const p = t[i - 1]
      if (p !== undefined && !WS.has(p) && !opens(p)) put(i, brk(st.d - 1))
      st.d--
    } else if (opens(c) || c === ',') {
      if (c !== ',') st.d++
      const n = t[i + 1]
      if (n !== undefined && !WS.has(n) && n !== '}' && n !== ']') put(i + 1, brk(st.d))
    }
  }
  return h + verb(t.slice(run, end))
}

// lay out source characters [at, ~at+budget); `next` is where the following slice starts (null at the end), `state` chains them
export function layout(text, at = 0, budget = 20000, state = null) {
  const st = state ? { ...state } : { mode: modeOf(text), d: 0, s: false, e: false, j: 0, k: 0 }
  const end = cut(text, at, budget)
  if (st.mode === 'json') return { html: scan(text, at, end, st), next: end < text.length ? end : null, state: st }
  let h = '', i = at // line mode: [i, st.j) is the rest of the current line, laid out as JSON from st.k on
  while (i < end) {
    if (i >= st.j) { // a line starts here
      const nl = text.indexOf('\n', i), j = nl < 0 ? text.length : nl + 1
      const k = j - i <= LINE_MAX ? text.slice(i, j).search(/[{[]/) : -1
      let ok = false
      if (k >= 0) try { JSON.parse(text.slice(i + k, j)); ok = true } catch { /* copied through */ }
      Object.assign(st, { j, k: ok ? i + k : j, d: 0, s: false, e: false })
    }
    const e = Math.min(st.j, end), v = Math.max(i, Math.min(st.k, e))
    if (i < v) h += verb(text.slice(i, v))
    if (v < e) h += scan(text, v, e, st)
    i = e
  }
  return { html: h, next: end < text.length ? end : null, state: st }
}
