// runtime-text.mjs — the same splice as rules.mjs's spliceRuntime() / stripRuntime(), on the runtime config as TEXT (RFC 4.8 §4.1 `payload`, 4.7 §3.2).
//
// Clash Verge's runtime file (clash-verge.yaml) is what the payload strategy reads, splices the block into and pushes back to the core. It is YAML, this project has no YAML
// library (and takes none), and the file holds the user's nodes and credentials, so the splice is line based and touches only what it has to: the entries of asight's own kind
// (names starting with asight-), the rules of our two shapes, and the exclude-filter line of an include-all group. Every other line stays, in order, byte for byte. The proxy
// software writes block style (serde_yaml: lists at their key's own indent); a shape this file does not read (a non-empty inline section, a flow-style group with include-all,
// a filter written as a block scalar or over several lines) is not guessed at: it throws RuntimeShapeError and the caller falls back to the next strategy.
//
// What goes in is the same as for the object path: entries are written as one-line JSON (JSON is YAML flow style), the groups and nodes after the user's, the rules before the
// user's, the include-all groups' filters ending in ^asight-, an asight entry already there replaced. rules.mjs is the oracle: the text path's result, read back, equals the object
// path's (W58); the tests read it with a reader that only they have.

import { blockData, FILTER_TOKEN, NAME_PREFIX, OUR_RULE, LOOP_RULE } from './rules.mjs'

export class RuntimeShapeError extends Error {
  constructor(message) {
    super(`the runtime has a shape the text splice does not read: ${message}`)
    this.code = 'runtime-shape'
  }
}

const INCLUDE_ALL = ['include-all', 'include-all-proxies', 'include-all-providers']
const KEYS = ['proxies', 'proxy-groups', 'rule-providers', 'rules']
const TOP_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"\n]+"|'[^'\n]+'):(?:[ \t]|$)/
const indentOf = (l) => l.length - l.trimStart().length
const isEmptyInline = (v) => v === '[]' || v === '{}' || v === '~' || v === 'null'
const blank = (l) => l.trim() === '' || l.trim().startsWith('#')

// the value as written: a quoted scalar without its quotes (escapes read), a plain one without a trailing comment
function unq(raw) {
  const s = raw.trim()
  if (s[0] === '"') { const m = /^"((?:[^"\\]|\\.)*)"/.exec(s); if (m) { try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] } } }
  if (s[0] === "'") { const m = /^'((?:[^']|'')*)'/.exec(s); if (m) return m[1].replace(/''/g, "'") }
  return s.replace(/\s+#.*$/, '')
}

function split(yaml) {
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n'
  const trail = yaml.endsWith('\n')
  const body = trail ? yaml.slice(0, yaml.endsWith('\r\n') ? -2 : -1) : yaml
  return { lines: yaml === '' ? [] : body.split(/\r?\n/), nl, trail }
}
const join = ({ nl, trail }, lines) => lines.join(nl) + (trail && lines.length ? nl : '')

/** The top-level keys with the line each starts at and where it ends (exclusive). */
function sections(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_KEY.exec(lines[i])
    if (m) { if (out.length) out.at(-1).end = i; out.push({ key: unq(m[1]), start: i, end: lines.length }) }
  }
  return out
}
const find = (lines, key) => sections(lines).find((s) => s.key === key)
const inlineOf = (line) => line.slice(line.indexOf(':') + 1).trim().replace(/\s+#.*$/, '')
const lastContent = (lines, sec) => { let i = sec.end - 1; while (i > sec.start && blank(lines[i])) i--; return i }

/** The inline value of a section we have to read: nothing (a block follows) or an empty one; anything else is a shape we do not read. */
function blockOnly(lines, sec) {
  const inline = inlineOf(lines[sec.start])
  if (inline === '' || isEmptyInline(inline)) return inline
  throw new RuntimeShapeError(`${sec.key}: is written inline`)
}

function listItems(lines, sec) {
  const items = []
  let indent = null
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = /^(\s*)-(?:\s|$)/.exec(lines[i])
    if (!m) continue
    if (indent === null) indent = m[1].length
    if (m[1].length === indent) items.push({ from: i, to: sec.end })
  }
  for (let k = 0; k < items.length - 1; k++) items[k].to = items[k + 1].from
  for (const it of items) while (it.to - 1 > it.from && blank(lines[it.to - 1])) it.to-- // blank and comment lines after an item's last line are not the item's: taking it out leaves them
  return { indent: indent ?? 0, items }
}

// the top-level `name` of a flow map `{a: 1, name: x, b: {name: y}}` (depth 1 only)
function flowName(s) {
  let depth = 0, buf = '', inStr = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { buf += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue }
    if (c === '{' || c === '[') { depth++; buf = ''; continue }
    if (c === '}' || c === ']') { depth--; buf = ''; continue }
    if (depth === 1 && c === ':') {
      const key = unq(buf)
      buf = ''
      if (key !== 'name') continue
      let j = i + 1, v = '', q = null
      for (; j < s.length; j++) {
        const d = s[j]
        if (q) { v += d; if (d === q) q = null } else if (d === '"' || d === "'") { q = d; v += d } else if (d === ',' || d === '}') break; else v += d
      }
      return unq(v)
    }
    if (depth === 1 && c === ',') { buf = ''; continue }
    buf += c
  }
  return null
}

// an item's own name: on the dash line or at its key column, never a `name:` nested deeper (a node's plugin options)
function itemName(lines, it) {
  const head = lines[it.from]
  const rest = /^\s*-\s*(.*)$/.exec(head)[1]
  if (rest.startsWith('{')) {
    let t = rest
    for (let j = it.from; !/\}\s*(#.*)?$/.test(t) && j + 1 < it.to; ) { j++; t += ` ${lines[j].trim()}` }
    try { const o = JSON.parse(t); return typeof o?.name === 'string' ? o.name : null } catch { return flowName(t) }
  }
  const named = /^(?:name|"name"|'name'):\s*(.*)$/.exec(rest)
  if (named) return unq(named[1])
  const col = rest ? head.length - rest.length : (lines.slice(it.from + 1, it.to).find((l) => !blank(l)) || '').search(/\S/)
  for (let i = it.from + 1; i < it.to; i++) {
    if (indentOf(lines[i]) !== col) continue
    const k = /^\s*(?:name|"name"|'name'):\s*(.*)$/.exec(lines[i])
    if (k) return unq(k[1])
  }
  return null
}
const itemText = (lines, it) => unq(/^\s*-\s*(.*)$/.exec(lines[it.from])[1])
const dropRanges = (lines, ranges) => { const kill = new Set(); for (const r of ranges) for (let i = r.from; i < r.to; i++) kill.add(i); return lines.filter((_, i) => !kill.has(i)) }

// ---- taking asight's entries out ------------------------------------------------------------------------------------------------------------------

function removeOurs(input) {
  let lines = input
  const removed = { proxies: 0, groups: 0, providers: 0, rules: 0 }
  const label = { proxies: 'proxies', 'proxy-groups': 'groups', 'rule-providers': 'providers', rules: 'rules' }
  for (const key of KEYS) {
    const sec = find(lines, key)
    if (!sec) continue
    if (blockOnly(lines, sec) !== '') continue
    const kill = []
    if (key === 'rule-providers') {
      let entryIndent = null
      for (let i = sec.start + 1; i < sec.end; i++) {
        if (blank(lines[i])) continue
        const ind = indentOf(lines[i])
        if (entryIndent === null) entryIndent = ind
        if (ind !== entryIndent) continue
        const m = /^\s*("[^"]+"|'[^']+'|[^\s:#][^:]*?):(?:\s|$)/.exec(lines[i])
        if (!m || !unq(m[1]).startsWith(NAME_PREFIX)) continue
        let j = i + 1
        while (j < sec.end && (blank(lines[j]) || indentOf(lines[j]) > entryIndent)) j++
        let to = j
        while (to - 1 > i && blank(lines[to - 1])) to-- // the gap after the entry stays
        kill.push({ from: i, to })
        i = j - 1
      }
    } else {
      const { items } = listItems(lines, sec)
      items.forEach((it, k) => {
        if (key === 'rules') {
          const text = itemText(lines, it)
          const next = items[k + 1] ? itemText(lines, items[k + 1]) : null
          if (OUR_RULE.test(text) || (LOOP_RULE.test(text) && next !== null && OUR_RULE.test(next))) kill.push({ from: it.from, to: it.to })
        } else if ((itemName(lines, it) ?? '').startsWith(NAME_PREFIX)) kill.push({ from: it.from, to: it.to })
      })
    }
    if (!kill.length) continue
    removed[label[key]] = kill.length
    lines = dropRanges(lines, kill)
    const after = find(lines, key)
    const left = key === 'rule-providers' ? lines.slice(after.start + 1, after.end).some((l) => !blank(l)) : listItems(lines, after).items.length > 0
    if (!left) lines = [...lines.slice(0, after.start), `${key}: ${key === 'rule-providers' ? '{}' : '[]'}`, ...lines.slice(after.start + 1)] // an emptied section is an explicit empty one
  }
  return { lines, removed }
}

// ---- the include-all groups' exclude-filter ---------------------------------------------------------------------------------------------------------

// what follows `key:` on its line, as a value: quoted or plain, one line only (a block scalar or a quote left open means the value goes on, which we do not read)
function readScalar(raw) {
  const t = raw.trim()
  if (t === '') return ''
  if (t[0] === '|' || t[0] === '>') throw new RuntimeShapeError('a filter is written as a block scalar')
  if (t[0] === '"' && !/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(t)) throw new RuntimeShapeError('a filter is written over several lines')
  if (t[0] === "'" && !/^'(?:[^']|'')*'\s*(?:#.*)?$/.test(t)) throw new RuntimeShapeError('a filter is written over several lines')
  return unq(t)
}

function groupKeys(lines, it) {
  const head = lines[it.from]
  const rest = /^\s*-\s*(.*)$/.exec(head)[1]
  if (rest.startsWith('{')) return { flow: true, text: lines.slice(it.from, it.to).join(' ') }
  const keyCol = rest ? head.length - rest.length : (lines.slice(it.from + 1, it.to).find((l) => !blank(l)) || '').search(/\S/)
  const keys = {}
  for (let i = it.from; i < it.to; i++) {
    if (i > it.from && indentOf(lines[i]) !== keyCol) continue
    const m = /^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(i === it.from ? rest : lines[i].trimStart())
    if (m) keys[unq(m[1])] = { line: i, raw: m[2] ?? '' }
  }
  return { flow: false, keyCol, keys }
}
const jsonValueAt = (line, key, value) => `${line.slice(0, line.indexOf(':', line.indexOf(key)) + 1)} ${JSON.stringify(value)}`

// the filter's value, read from its one line; a value that goes on over the next lines is not read
function filterValue(lines, it, g) {
  const ef = g.keys['exclude-filter']
  const next = lines.slice(ef.line + 1, it.to).find((l) => !blank(l))
  if (next !== undefined && indentOf(next) > g.keyCol) throw new RuntimeShapeError('a filter goes over several lines')
  return readScalar(ef.raw)
}

// one group; returns the new lines and whether the filter moved. Adding touches the groups that have include-all and no others; taking out touches only a filter that holds our token.
function editGroup(lines, it, adding) {
  const g = groupKeys(lines, it)
  if (g.flow) {
    if (adding && /include-all/.test(g.text)) throw new RuntimeShapeError('a group written in flow style has include-all')
    if (!adding && g.text.includes(FILTER_TOKEN)) throw new RuntimeShapeError('a group written in flow style holds our filter')
    return { lines, moved: false }
  }
  const ef = g.keys['exclude-filter']
  if (adding) {
    const on = INCLUDE_ALL.find((k) => g.keys[k] && /^true$/i.test(readScalar(g.keys[k].raw)))
    if (!on) return { lines, moved: false }
    if (!ef) {
      const at = g.keys[on].line + 1
      return { lines: [...lines.slice(0, at), `${' '.repeat(g.keyCol)}exclude-filter: ${JSON.stringify(FILTER_TOKEN)}`, ...lines.slice(at)], moved: true }
    }
    const cur = filterValue(lines, it, g)
    if (cur !== '' && cur.split('|').includes(FILTER_TOKEN)) return { lines, moved: false }
    const out = [...lines]
    out[ef.line] = jsonValueAt(lines[ef.line], 'exclude-filter', cur === '' ? FILTER_TOKEN : `${cur}|${FILTER_TOKEN}`)
    return { lines: out, moved: true }
  }
  if (!ef || !ef.raw.includes(FILTER_TOKEN)) return { lines, moved: false } // not ours: whatever it is, it stays
  const cur = filterValue(lines, it, g)
  if (cur === FILTER_TOKEN) {
    if (ef.line === it.from) throw new RuntimeShapeError('our filter is the first key of its group')
    return { lines: [...lines.slice(0, ef.line), ...lines.slice(ef.line + 1)], moved: true }
  }
  if (cur.endsWith(`|${FILTER_TOKEN}`)) {
    const out = [...lines]
    out[ef.line] = jsonValueAt(lines[ef.line], 'exclude-filter', cur.slice(0, -(FILTER_TOKEN.length + 1)))
    return { lines: out, moved: true }
  }
  return { lines, moved: false }
}

function applyFilters(input, adding) {
  let lines = input
  let count = 0
  const sec = find(lines, 'proxy-groups')
  if (!sec || blockOnly(lines, sec) !== '') return { lines, count }
  const { items } = listItems(lines, sec)
  for (const it of [...items].reverse()) { // from the last: an insert or a removal does not move the items still to come
    const r = editGroup(lines, it, adding)
    lines = r.lines
    if (r.moved) count++
  }
  return { lines, count }
}

// ---- putting the block in ---------------------------------------------------------------------------------------------------------------------------

function addToList(lines, key, entries) {
  const rows = (pad) => entries.map((e) => `${pad}- ${e}`)
  const sec = find(lines, key)
  if (!sec) return [...lines, `${key}:`, ...rows('')]
  const inline = blockOnly(lines, sec)
  if (inline !== '') return [...lines.slice(0, sec.start), `${key}:`, ...rows(''), ...lines.slice(sec.start + 1)]
  const at = lastContent(lines, sec) + 1
  return [...lines.slice(0, at), ...rows(' '.repeat(listItems(lines, sec).indent)), ...lines.slice(at)]
}

function putRulesFirst(lines, rules) {
  const rows = (pad) => rules.map((r) => `${pad}- ${JSON.stringify(r)}`)
  const sec = find(lines, 'rules')
  if (!sec) return [...lines, 'rules:', ...rows('')]
  const inline = blockOnly(lines, sec)
  if (inline !== '') return [...lines.slice(0, sec.start), 'rules:', ...rows(''), ...lines.slice(sec.start + 1)]
  return [...lines.slice(0, sec.start + 1), ...rows(' '.repeat(listItems(lines, sec).indent)), ...lines.slice(sec.start + 1)]
}

function addProviders(lines, providers) {
  const rows = (pad) => Object.entries(providers).map(([k, v]) => `${pad}${k}: ${JSON.stringify(v)}`)
  const sec = find(lines, 'rule-providers')
  if (!sec) return [...lines, 'rule-providers:', ...rows('  ')]
  const inline = blockOnly(lines, sec)
  if (inline !== '') return [...lines.slice(0, sec.start), 'rule-providers:', ...rows('  '), ...lines.slice(sec.start + 1)]
  const first = lines.slice(sec.start + 1, sec.end).find((l) => !blank(l))
  const at = lastContent(lines, sec) + 1
  return [...lines.slice(0, at), ...rows(' '.repeat(first === undefined ? 2 : indentOf(first))), ...lines.slice(at)]
}

/**
 * The runtime text with the block spliced in: any entry of ours already there is taken out first (so splicing twice is splicing once), the include-all groups get ^asight-
 * in their exclude-filter, asight's nodes and groups go at the end of their sections, its provider after the user's, its rules at the top. A section that is missing is
 * created at the end. Returns `{ yaml, inserted: { proxies, groups, providers, rules }, filtered }`. Throws RuntimeShapeError on a shape it does not read.
 */
export function spliceRuntimeText({ yaml, block }) {
  if (typeof yaml !== 'string') throw new TypeError('the runtime is the text of the file')
  const data = blockData(block)
  const doc = split(yaml)
  const cleared = removeOurs(doc.lines)
  const filtered = applyFilters(cleared.lines, true)
  let lines = addToList(filtered.lines, 'proxies', data.proxies.map((p) => JSON.stringify(p)))
  lines = addToList(lines, 'proxy-groups', data.groups.map((g) => JSON.stringify(g)))
  lines = addProviders(lines, data.providers)
  lines = putRulesFirst(lines, data.rules)
  return { yaml: join(doc, lines), inserted: { proxies: data.proxies.length, groups: data.groups.length, providers: Object.keys(data.providers).length, rules: data.rules.length }, filtered: filtered.count }
}

/**
 * The runtime text with everything of asight's taken out, the filters back as they were (the token we appended goes; a filter that was only the token goes with its key). A
 * section left empty stays as an explicit empty one. Returns `{ yaml, removed: { proxies, groups, providers, rules }, unfiltered }`.
 */
export function stripRuntimeText({ yaml }) {
  if (typeof yaml !== 'string') throw new TypeError('the runtime is the text of the file')
  const doc = split(yaml)
  const cleared = removeOurs(doc.lines)
  const filtered = applyFilters(cleared.lines, false)
  return { yaml: join(doc, filtered.lines), removed: cleared.removed, unfiltered: filtered.count }
}
