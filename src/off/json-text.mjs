// json-text.mjs — set or remove one key of a JSON document AS TEXT (RFC 4.6 §身份与信任「标记与安装」: JSON 按 JSONC 读写, 按文本插入键,
// rename 前按同一读法解析校验; the value is a string, or a boolean / null where an app's own setting is one — VS Code's
// `http.systemCertificates: false` of 4.8 §2.4 spells it without quotes). The document is read as JSONC: a byte-order mark (U+FEFF at offset 0,
// where text-codec.mjs leaves it), `//` and `/* */` comments, trailing commas in objects and arrays. A document of nothing but those (empty, blank,
// a mark, comments) is no document. The edit is a minimal splice: no reordering, no reformatting, every byte outside it unchanged, and asight never
// writes a comment. Each edit is returned as {offset, removed, inserted} for the install journal (§安装清单与卸载「日志」); reverseOps undoes it
// and refuses when the text no longer matches. A refusal carries `why` from 4.6「逐 harness 跳过」's set — `not-json` (with the `offset` it
// stopped at), `not-object`, `value` — for the caller to name its file.
import { isDeepStrictEqual } from 'node:util'

const refusal = (why, message, extra = {}) => Object.assign(new Error(message), { why, ...extra })
const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
/** A byte-order mark is U+FEFF at offset 0 of the text (text-codec.mjs leaves it there): before the first line, not part of it. The one place that says so. */
export const markLen = (text) => (typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? 1 : 0)
const breakLen = (text, j) => (text[j] === '\r' && text[j + 1] === '\n' ? 2 : 1)

// What lies between two tokens from offset i: pieces [{kind: 'ws' | 'line' | 'block', start, end}], `end` where they stop; `open` = a `/*` with no `*/`.
// A line comment stops before its line break, so the break is white space after it.
function gap(text, i) {
  const pieces = []
  for (;;) {
    const s = i
    if (isWs(text[i])) { while (isWs(text[i])) i++; pieces.push({ kind: 'ws', start: s, end: i }) }
    else if (text[i] === '/' && text[i + 1] === '/') { i += 2; while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++; pieces.push({ kind: 'line', start: s, end: i }) }
    else if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return { pieces, end: i, open: true }; i = e + 2; pieces.push({ kind: 'block', start: s, end: i }) }
    else return { pieces, end: i }
  }
}

// A tiny scanner that keeps offsets: objects → members [{key, keyStart, value, comma}] (`comma`: the offset of the comma after the member, or null),
// arrays → items, every node → {type, start, end}, strings and scalars with their value. null = no document.
export function scanJson(text) {
  let i = markLen(text)
  const fail = (what) => { throw refusal('not-json', `not valid JSON at offset ${i}: expected ${what}`, { offset: i }) }
  const ws = () => { const g = gap(text, i); i = g.end; if (g.open) fail("the end of a '/*' comment") }
  function str() {
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (text[i] !== '"') fail('the end of a string')
    i++
    let value
    try { value = JSON.parse(text.slice(start, i)) } catch { i = start; fail('a string with valid escapes and no control characters') }
    return { type: 'string', start, end: i, value }
  }
  function value() {
    ws()
    const c = text[i]
    if (c === '{' || c === '[') return container(c === '{')
    if (c === '"') return str()
    SCALAR.lastIndex = i
    const m = SCALAR.exec(text)
    if (!m) fail('a value')
    const start = i
    i += m[0].length
    return { type: 'scalar', start, end: i, value: JSON.parse(m[0]) }
  }
  function container(isObject) {
    const start = i++
    const close = isObject ? '}' : ']'
    const kids = []
    ws()
    while (text[i] !== close) { // a comma before the close is allowed (JSONC), a comma with nothing before it is not
      let kid
      if (isObject) {
        if (text[i] !== '"') fail("a key or '}'")
        const k = str()
        ws()
        if (text[i] !== ':') fail("':'")
        i++
        kid = { key: k.value, keyStart: k.start, value: value(), comma: null }
      } else kid = { value: value(), comma: null }
      kids.push(kid)
      ws()
      if (text[i] === ',') { kid.comma = i++; ws() } else if (text[i] !== close) fail(`',' or '${close}'`)
    }
    i++
    return isObject ? { type: 'object', start, end: i, members: kids } : { type: 'array', start, end: i, items: kids.map((k) => k.value), elements: kids }
  }
  ws()
  if (i >= text.length) return null
  const root = value()
  ws()
  if (i !== text.length) fail('the end of the document')
  return root
}

// The value of a node as JSON.parse builds it: a duplicate key keeps its first place and its last value; `__proto__` is an own key.
const own = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
const valueOf = (n) => (n.type === 'object' ? n.members.reduce((o, m) => own(o, m.key, valueOf(m.value)), {}) : n.type === 'array' ? n.items.map(valueOf) : n.value)

/** The value of a JSONC text (the reading every JSON file of the user's goes through, 4.6「标记与安装」); undefined for no document. Throws a
 *  refusal with why `not-json` and the `offset` it stopped at. */
export function parseJsonText(text) {
  const root = scanJson(text)
  return root == null ? undefined : valueOf(root)
}

// Why a JSON file of the user's is left as it is (`left-unparsable`): asight cannot read it as JSONC at a place the user can find (line and column,
// counted as the user's editor counts them), and what of asight's may still be in it. `what`: asight's key and value, or its value under a key.
export function unreadableJson(file, text, err, what) {
  const at = Number.isInteger(err && err.offset) ? err.offset : null
  const where = at == null ? '' : (() => { const lines = text.slice(markLen(text), at).split(/\r\n|\r|\n/); return ` (line ${lines.length}, column ${lines.at(-1).length + 1})` })()
  return `${file}: asight cannot read it${where}; ${what} may still be in it`
}

// JSON.parse keeps the LAST duplicate key; so do we.
const memberOf = (o, key) => { for (let k = o.members.length - 1; k >= 0; k--) if (o.members[k].key === key) return o.members[k]; return null }

export function getPath(value, keys) {
  let cur = value
  for (const k of keys) { if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return undefined; cur = cur[k] }
  return cur
}

export function applyOps(text, ops) {
  let t = text
  for (const op of ops) t = t.slice(0, op.offset) + op.inserted + t.slice(op.offset + op.removed.length)
  return t
}

// Undo ops in reverse order; null when the text does not hold what the ops inserted (it was edited since).
export function reverseOps(text, ops) {
  let t = text
  for (const op of [...ops].reverse()) {
    if (t.slice(op.offset, op.offset + op.inserted.length) !== op.inserted) return null
    t = t.slice(0, op.offset) + op.removed + t.slice(op.offset + op.inserted.length)
  }
  return t
}

// The JSON spelling of a value asight writes: a string in quotes, a boolean or null as itself (4.8 §2.4's VS Code item).
const literal = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))

const nest = (keys, value) => keys.reduceRight((inner, k) => `{ ${JSON.stringify(k)}: ${inner} }`, literal(value))
const member = (keys, value) => `${JSON.stringify(keys[0])}: ${keys.length > 1 ? nest(keys.slice(1), value) : literal(value)}`
/** The line ending asight writes into a file (4.6「文件的编码」: the line ending follows the file): CRLF when the file has more CRLF than bare LF,
 *  else LF — and LF for an empty or new file. The one place that decides it for every insert (a new JSON document, a dotenv block, a joined line, an rc line, a YAML row). */
export const eolOf = (text) => { const t = text == null ? '' : text; const crlf = (t.match(/\r\n/g) || []).length; return crlf > (t.match(/\n/g) || []).length - crlf ? '\r\n' : '\n' }

// The white space a new first member is led by: only white space, never a comment in front of the first member (a comment stays where it is, after
// the new member). It is the last line break before the first key with the indentation after it, or, on one line, the white space right before the key.
function leadOf(text, o) {
  const { pieces } = gap(text, o.start + 1)
  for (const p of pieces.filter((x) => x.kind === 'ws').reverse()) {
    const s = text.slice(p.start, p.end)
    const b = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('\r'))
    if (b >= 0) return (s[b] === '\n' && s[b - 1] === '\r' ? '\r\n' : s[b]) + s.slice(b + 1)
  }
  const last = pieces.at(-1)
  return last && last.kind === 'ws' ? text.slice(last.start, last.end) : ''
}

// Insert a member as the FIRST member of object o. Its comma goes after it, so a trailing comma of the object is never doubled.
function insertFirst(text, o, keys, value) {
  if (o.members.length === 0) return { offset: o.start + 1, removed: '', inserted: member(keys, value) }
  return { offset: o.start + 1, removed: '', inserted: `${leadOf(text, o)}${member(keys, value)},` }
}

// No document (no file, or one of only white space, a mark, comments): the new object goes after what is there, in one op, so undoing it gives back
// every byte. A line comment at the end would swallow it: a line break goes first then.
function newDocument(text, keys, value) {
  const eol = eolOf(text)
  const open = keys.map((k, d) => `${'  '.repeat(d + 1)}${JSON.stringify(k)}: ${d === keys.length - 1 ? literal(value) : '{'}`).join(eol)
  const close = keys.slice(0, -1).map((_, d) => `${'  '.repeat(keys.length - 1 - d)}}`).join(eol)
  const after = gap(text, markLen(text)).pieces.at(-1)
  return { offset: text.length, removed: '', inserted: `${after && after.kind === 'line' ? eol : ''}{${eol}${open}${eol}${close}${keys.length > 1 ? eol : ''}}${eol}` }
}

const shown = (text, n) => (n.type === 'array' ? 'an array' : n.type === 'string' ? 'a string' : text.slice(n.start, n.end))

// setKey(text|null, keys, value) → { text, ops, prior, existingDepth }. `text` null = the file does not exist; `value` a string, a boolean
// or null (VS Code's `http.systemCertificates: false` is a boolean, 4.8 §2.4). prior = the value the key held before (null when absent);
// existingDepth = how many leading keys already existed as objects (the rest were created by this edit). Throws a refusal on non-JSON (`not-json`),
// a non-object document or parent on the path (`not-object`) and a key holding an object or array (`value`).
export function setKey(text, keys, value) {
  if (typeof value !== 'string' && typeof value !== 'boolean' && value !== null) throw new Error('setKey: value must be a string, a boolean or null')
  if (!keys.length) throw new Error('setKey: empty key path')
  const before = text ?? ''
  let node = scanJson(before)
  if (node == null) {
    const op = newDocument(before, keys, value)
    return check(before, { text: applyOps(before, [op]), ops: [op], prior: null, existingDepth: 0 }, keys, value)
  }
  if (node.type !== 'object') throw refusal('not-object', 'setKey: the document is not a JSON object')
  for (let d = 0; d < keys.length; d++) {
    const m = memberOf(node, keys[d])
    if (!m) {
      const op = insertFirst(before, node, keys.slice(d), value)
      return check(before, { text: applyOps(before, [op]), ops: [op], prior: null, existingDepth: d }, keys, value)
    }
    if (d === keys.length - 1) {
      if (m.value.type !== 'string' && m.value.type !== 'scalar') throw refusal('value', `setKey: ${keys.join('.')} is not a value asight can replace`)
      const op = { offset: m.value.start, removed: before.slice(m.value.start, m.value.end), inserted: literal(value) }
      return check(before, { text: applyOps(before, [op]), ops: [op], prior: m.value.value, existingDepth: d }, keys, value)
    }
    if (m.value.type !== 'object') throw refusal('not-object', `setKey: ${keys.slice(0, d + 1).join('.')} is not an object (it is ${shown(before, m.value)}): delete that member or make it {}`)
    node = m.value
  }
}

// The cut that takes one member out, with one comma (its own, or for a last member without one the comma before it) and one of the two runs of white
// space around it. Comments are never cut; a line comment in front of the member keeps the line break that ends it. → [[from, to), …]
function memberCuts(text, o, k) {
  const m = o.members[k], prev = k > 0 ? o.members[k - 1] : null
  const lead = gap(text, prev ? prev.comma + 1 : o.start + 1).pieces
  const wb = lead.at(-1)?.kind === 'ws' ? { ...lead.at(-1) } : { start: m.keyStart, end: m.keyStart }
  const forced = wb.end > wb.start && lead.at(-2)?.kind === 'line'
  if (forced) wb.start += breakLen(text, wb.start)
  const cuts = [[m.keyStart, m.value.end]]
  let after
  if (m.comma != null) {
    cuts.push(gap(text, m.value.end).pieces.every((p) => p.kind === 'ws') ? [m.value.end, m.comma + 1] : [m.comma, m.comma + 1])
    after = gap(text, m.comma + 1).pieces
  } else {
    if (prev) cuts.push([prev.comma, prev.comma + 1])
    after = gap(text, m.value.end).pieces
  }
  const wa = after[0]?.kind === 'ws' ? after[0] : null
  const firstBreakEnd = (r) => { for (let j = r.start; j < r.end; j++) if (text[j] === '\n' || text[j] === '\r') return j + breakLen(text, j); return null }
  if (forced) { // the comment's line break stays; the member's indentation goes, and the line break after the member, so no blank line is left
    cuts.push([wb.start, wb.end])
    const e = wa && firstBreakEnd(wa)
    if (e != null) cuts.push([wa.start, e])
  } else if (!wa || firstBreakEnd(wb) != null) cuts.push([wb.start, wb.end]) // the member had a line of its own (or nothing follows): its line goes
  else cuts.push([wa.start, wa.end]) // on one line: the space after it goes
  return cuts
}

// The one op that takes member (or element) k out of container o: memberCuts, and a container left with nothing but white space inside becomes `{}` / `[]`.
function cutOne(text, o, k) {
  let cuts = memberCuts(text, o, k).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const kept = (from, to) => { let out = '', at = from; for (const [a, b] of cuts) { if (b <= at || a >= to) continue; out += text.slice(at, Math.max(at, a)); at = Math.max(at, b) } return out + text.slice(Math.min(at, to), to) }
  if (o.members.length === 1 && /^[ \t\r\n]*$/.test(kept(o.start + 1, o.end - 1))) cuts = [[o.start + 1, o.end - 1]]
  const from = Math.min(...cuts.map((c) => c[0])), to = Math.max(...cuts.map((c) => c[1]))
  return { offset: from, removed: text.slice(from, to), inserted: kept(from, to) }
}

// removeKey(text, keys) → { text, ops } removing the member, one comma and the white space of its place, in one op; null when absent.
// An object left with nothing but white space inside becomes `{}`.
export function removeKey(text, keys) {
  let node = scanJson(text)
  if (!node || node.type !== 'object') return null
  for (let d = 0; d < keys.length - 1; d++) {
    const m = memberOf(node, keys[d])
    if (!m || m.value.type !== 'object') return null
    node = m.value
  }
  const m = memberOf(node, keys[keys.length - 1])
  if (!m) return null
  const op = cutOne(text, node, node.members.indexOf(m))
  const out = applyOps(text, [op])
  const want = parseJsonText(text)
  delete getPath(want, keys.slice(0, -1))[keys[keys.length - 1]]
  if (!isDeepStrictEqual(readBack(out), want)) throw new Error('removeKey: the edit changed more than the key')
  return { text: out, ops: [op] }
}

// removeItem(text, keys, item) → { text, ops } taking out the LAST element of the array at `keys` that equals `item` (an element asight appended, 4.11 P13
// `json-array-item`), with one comma and the white space of its place — the cut removeKey makes for a member, so comments stay; an array left with
// nothing but white space inside becomes `[]`. null when the path is not an array or holds no such element (the user took it out: nothing to do, D48②).
export function removeItem(text, keys, item) {
  let node = scanJson(text)
  for (const k of keys) { const m = node && node.type === 'object' ? memberOf(node, k) : null; node = m ? m.value : null }
  if (!node || node.type !== 'array') return null
  const els = node.elements.map((e) => ({ keyStart: e.value.start, value: e.value, comma: e.comma }))
  let k = els.length - 1
  while (k >= 0 && !isDeepStrictEqual(valueOf(els[k].value), item)) k--
  if (k < 0) return null
  const op = cutOne(text, { start: node.start, end: node.end, members: els }, k)
  const out = applyOps(text, [op])
  const want = parseJsonText(text), list = keys.length ? getPath(want, keys) : want
  list.splice(k, 1)
  if (!isDeepStrictEqual(readBack(out), want)) throw new Error('removeItem: the edit changed more than the element')
  return { text: out, ops: [op] }
}

// What an edit made, read the same way; a text the edit left unreadable is a failed edit, never the user's file being not JSON.
const readBack = (text) => { try { return parseJsonText(text) } catch { return Symbol('unreadable') } }

// Parse-check before anything is written: the result reads back (as JSONC) and differs from the input ONLY at keys.
function check(before, res, keys, value) {
  const want = parseJsonText(before) ?? {}
  let cur = want
  for (const k of keys.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== 'object') own(cur, k, {}); cur = cur[k] }
  own(cur, keys[keys.length - 1], value)
  if (!isDeepStrictEqual(readBack(res.text), want)) throw new Error('setKey: the edit changed more than the key')
  return res
}
