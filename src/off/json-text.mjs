// json-text.mjs — set or remove one string key of a JSON document AS TEXT (RFC 4.6 §身份与信任「标记与安装」:
// JSON 按文本插入键,rename 前先解析校验). The edit is a minimal splice: no reordering, no reformatting,
// every byte outside it unchanged. Each edit is returned as {offset, removed, inserted} for the install
// journal (§安装清单与卸载「日志」); reverseOps undoes it and refuses when the text no longer matches.
import { isDeepStrictEqual } from 'node:util'

const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

// A tiny scanner that keeps offsets: objects → members [{key, keyStart, value}], values → {start, end}.
export function scanJson(text) {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++ }
  const fail = (what) => { throw new Error(`not valid JSON at offset ${i}: expected ${what}`) }
  function str() {
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (text[i] !== '"') fail('end of string')
    i++
    return { type: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) }
  }
  function value() {
    ws()
    const c = text[i]
    if (c === '{') return obj()
    if (c === '[') {
      const start = i++
      ws()
      if (text[i] === ']') { i++; return { type: 'array', start, end: i } }
      for (;;) { value(); ws(); if (text[i] === ',') { i++; continue } if (text[i] === ']') { i++; return { type: 'array', start, end: i } } fail("',' or ']'") }
    }
    if (c === '"') return str()
    SCALAR.lastIndex = i
    const m = SCALAR.exec(text)
    if (!m) fail('a value')
    const start = i
    i += m[0].length
    return { type: 'scalar', start, end: i }
  }
  function obj() {
    const start = i++
    const members = []
    ws()
    if (text[i] === '}') { i++; return { type: 'object', start, end: i, members } }
    for (;;) {
      ws()
      if (text[i] !== '"') fail('a key')
      const k = str()
      ws()
      if (text[i] !== ':') fail("':'")
      i++
      members.push({ key: k.value, keyStart: k.start, value: value() })
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members } }
      fail("',' or '}'")
    }
  }
  const root = value()
  ws()
  if (i !== text.length) fail('end of document')
  return root
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

const nest = (keys, value) => keys.reduceRight((inner, k) => `{ ${JSON.stringify(k)}: ${inner} }`, JSON.stringify(value))
const member = (keys, value) => `${JSON.stringify(keys[0])}: ${keys.length > 1 ? nest(keys.slice(1), value) : JSON.stringify(value)}`

// Insert a member as the FIRST member of object o, copying the whitespace in front of its current first member.
function insertFirst(text, o, keys, value) {
  if (o.members.length === 0) return { offset: o.start + 1, removed: '', inserted: member(keys, value) }
  const lead = text.slice(o.start + 1, o.members[0].keyStart)
  return { offset: o.start + 1, removed: '', inserted: `${lead}${member(keys, value)},` }
}

// setKey(text|null, keys, value) → { text, ops, prior, existingDepth }. `text` null = the file does not exist.
// prior = the string the key held before (null when absent); existingDepth = how many leading keys already
// existed as objects (the rest were created by this edit). Throws on non-JSON or a non-object on the path.
export function setKey(text, keys, value) {
  if (typeof value !== 'string') throw new Error('setKey: value must be a string')
  if (text == null) {
    const inserted = `{\n${keys.map((k, d) => `${'  '.repeat(d + 1)}${JSON.stringify(k)}: ${d === keys.length - 1 ? JSON.stringify(value) : '{'}`).join('\n')}\n${keys.slice(0, -1).map((_, d) => `${'  '.repeat(keys.length - 1 - d)}}`).join('\n')}${keys.length > 1 ? '\n' : ''}}\n`
    return check(null, { text: inserted, ops: [{ offset: 0, removed: '', inserted }], prior: null, existingDepth: 0 }, keys, value)
  }
  let node = scanJson(text)
  if (node.type !== 'object') throw new Error('setKey: the document is not a JSON object')
  for (let d = 0; d < keys.length; d++) {
    const m = memberOf(node, keys[d])
    if (!m) {
      const op = insertFirst(text, node, keys.slice(d), value)
      return check(text, { text: applyOps(text, [op]), ops: [op], prior: null, existingDepth: d }, keys, value)
    }
    if (d === keys.length - 1) {
      if (m.value.type !== 'string') throw new Error(`setKey: ${keys.join('.')} is not a string`)
      const op = { offset: m.value.start, removed: text.slice(m.value.start, m.value.end), inserted: JSON.stringify(value) }
      return check(text, { text: applyOps(text, [op]), ops: [op], prior: m.value.value, existingDepth: d }, keys, value)
    }
    if (m.value.type !== 'object') throw new Error(`setKey: ${keys.slice(0, d + 1).join('.')} is not an object`)
    node = m.value
  }
  throw new Error('setKey: empty key path')
}

// removeKey(text, keys) → { text, ops } removing the member and one adjacent comma; null when absent.
export function removeKey(text, keys) {
  let node = scanJson(text)
  for (let d = 0; d < keys.length - 1; d++) {
    const m = node.type === 'object' && memberOf(node, keys[d])
    if (!m || m.value.type !== 'object') return null
    node = m.value
  }
  const k = node.members.lastIndexOf(memberOf(node, keys[keys.length - 1]))
  if (k < 0) return null
  const m = node.members[k]
  let from, to
  if (node.members.length === 1) { from = node.start + 1; to = node.end - 1 }
  else if (k < node.members.length - 1) { from = m.keyStart; to = node.members[k + 1].keyStart }
  else { from = node.members[k - 1].value.end; to = m.value.end }
  const op = { offset: from, removed: text.slice(from, to), inserted: '' }
  const out = applyOps(text, [op])
  const want = JSON.parse(text)
  const parent = getPath(want, keys.slice(0, -1))
  delete parent[keys[keys.length - 1]]
  if (!isDeepStrictEqual(JSON.parse(out), want)) throw new Error('removeKey: the edit changed more than the key')
  return { text: out, ops: [op] }
}

// Parse-check before anything is written: the result is valid JSON and differs from the input ONLY at keys.
function check(before, res, keys, value) {
  const want = before == null ? {} : JSON.parse(before)
  let cur = want
  for (const k of keys.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k] }
  cur[keys[keys.length - 1]] = value
  if (!isDeepStrictEqual(JSON.parse(res.text), want)) throw new Error('setKey: the edit changed more than the key')
  return res
}
