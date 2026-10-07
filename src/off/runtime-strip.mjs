// runtime-strip.mjs — the runtime config as TEXT: the reader both halves of the text splice share, and the half that takes asight's entries out again (RFC 4.8 §4.1 `payload`, 4.7 §3.2, D28; W9, W58).
//
// Clash Verge's runtime file (clash-verge.yaml) is what the payload strategy reads, splices the block into and pushes back to the core. It is YAML, this project has no YAML library
// (and takes none), and the file holds the user's nodes and credentials, so the work is line based and touches only what it has to: the entries of asight's own kind (names starting with
// asight-), the rules of our two shapes, and the exclude-filter line of an include-all group. Every other line stays, in order, byte for byte. The proxy software writes block style
// (serde_yaml: lists at their key's own indent); a shape this file does not read (a non-empty inline section, a flow-style group with include-all, a filter written as a block scalar or over
// several lines) is not guessed at: it throws RuntimeShapeError and the caller falls back to the next strategy.
//
// Why this is in src/off and not next to the splice (src/netenv/mihomo/runtime-text.mjs, which imports it and re-exports stripRuntimeText): taking asight out of the runtime is an undo, and the
// undo (`asight off`, the standalone `asight-off`, RFC 1.6 R3) imports only `node:*` and files of this directory. One reader, one strip, run by `on` (re-strip before a new splice) and by `off`:
// a second one would have to agree with this one on every line. The adding half needs the block's validation (rules.mjs) and stays in src/netenv. The rt* names are for that sibling only.
// The constants below are the ones rules.mjs re-exports (the script carries copies of the two rule shapes in its own source; a test holds them to these).
// Imports nothing. Written the way the single-file builder (src/off/standalone.mjs) reads a module: one top-level declaration per line, no destructuring, no default export, and top-level
// names no other file of src/off declares (a bundle has one scope: test/off/bundle-safe.test.mjs holds these files to that), hence the rt prefix on every helper.

/** Every name of asight's own in a runtime (outbound, group, provider) starts with this; it is how the strip knows what is ours. */
export const NAME_PREFIX = 'asight-'
/** The token appended to an include-all group's exclude-filter, so that asight's outbounds never become members of the user's groups. */
export const FILTER_TOKEN = '^asight-'
// the two rule shapes of ours the splice recognises (the second only when it is right in front of the first); asightApply() carries its own copies of these literals
// because its source is embedded in the global script, and a test holds the two to the same text
export const OUR_RULE = /^RULE-SET,asight-r-[^,]+,asight-sw-[^,]+$/
export const LOOP_RULE = /^AND,\(\(DST-PORT,[0-9]+\),\(IP-CIDR,127\.0\.0\.1\/32,no-resolve\)\),DIRECT$/

export class RuntimeShapeError extends Error {
  constructor(message) {
    super(`the runtime has a shape the text splice does not read: ${message}`)
    this.code = 'runtime-shape'
  }
}

const RT_INCLUDE_ALL = ['include-all', 'include-all-proxies', 'include-all-providers']
const RT_KEYS = ['proxies', 'proxy-groups', 'rule-providers', 'rules']
const RT_TOP_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"\n]+"|'[^'\n]+'):(?:[ \t]|$)/
export const rtIndentOf = (l) => l.length - l.trimStart().length
const rtIsEmptyInline = (v) => v === '[]' || v === '{}' || v === '~' || v === 'null'
export const rtBlank = (l) => l.trim() === '' || l.trim().startsWith('#')

// the value as written: a quoted scalar without its quotes (escapes read), a plain one without a trailing comment
function rtUnq(raw) {
  const s = raw.trim()
  if (s[0] === '"') { const m = /^"((?:[^"\\]|\\.)*)"/.exec(s); if (m) { try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] } } }
  if (s[0] === "'") { const m = /^'((?:[^']|'')*)'/.exec(s); if (m) return m[1].replace(/''/g, "'") }
  return s.replace(/\s+#.*$/, '')
}

export function rtSplit(yaml) {
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n'
  const trail = yaml.endsWith('\n')
  const body = trail ? yaml.slice(0, yaml.endsWith('\r\n') ? -2 : -1) : yaml
  return { lines: yaml === '' ? [] : body.split(/\r?\n/), nl, trail }
}
export const rtJoin = ({ nl, trail }, lines) => lines.join(nl) + (trail && lines.length ? nl : '')

/** The top-level keys with the line each starts at and where it ends (exclusive). */
function rtSections(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = RT_TOP_KEY.exec(lines[i])
    if (m) { if (out.length) out.at(-1).end = i; out.push({ key: rtUnq(m[1]), start: i, end: lines.length }) }
  }
  return out
}
export const rtFind = (lines, key) => rtSections(lines).find((s) => s.key === key)
const rtInlineOf = (line) => line.slice(line.indexOf(':') + 1).trim().replace(/\s+#.*$/, '')
export const rtLastContent = (lines, sec) => { let i = sec.end - 1; while (i > sec.start && rtBlank(lines[i])) i--; return i }

/** The inline value of a section we have to read: nothing (a block follows) or an empty one; anything else is a shape we do not read. */
export function rtBlockOnly(lines, sec) {
  const inline = rtInlineOf(lines[sec.start])
  if (inline === '' || rtIsEmptyInline(inline)) return inline
  throw new RuntimeShapeError(`${sec.key}: is written inline`)
}

export function rtListItems(lines, sec) {
  const items = []
  let indent = null
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = /^(\s*)-(?:\s|$)/.exec(lines[i])
    if (!m) continue
    if (indent === null) indent = m[1].length
    if (m[1].length === indent) items.push({ from: i, to: sec.end })
  }
  for (let k = 0; k < items.length - 1; k++) items[k].to = items[k + 1].from
  for (const it of items) while (it.to - 1 > it.from && rtBlank(lines[it.to - 1])) it.to-- // blank and comment lines after an item's last line are not the item's: taking it out leaves them
  return { indent: indent ?? 0, items }
}

// the top-level `name` of a flow map `{a: 1, name: x, b: {name: y}}` (depth 1 only)
function rtFlowName(s) {
  let depth = 0, buf = '', inStr = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { buf += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue }
    if (c === '{' || c === '[') { depth++; buf = ''; continue }
    if (c === '}' || c === ']') { depth--; buf = ''; continue }
    if (depth === 1 && c === ':') {
      const key = rtUnq(buf)
      buf = ''
      if (key !== 'name') continue
      let j = i + 1, v = '', q = null
      for (; j < s.length; j++) {
        const d = s[j]
        if (q) { v += d; if (d === q) q = null } else if (d === '"' || d === "'") { q = d; v += d } else if (d === ',' || d === '}') break; else v += d
      }
      return rtUnq(v)
    }
    if (depth === 1 && c === ',') { buf = ''; continue }
    buf += c
  }
  return null
}

// an item's own name: on the dash line or at its key column, never a `name:` nested deeper (a node's plugin options)
function rtItemName(lines, it) {
  const head = lines[it.from]
  const rest = /^\s*-\s*(.*)$/.exec(head)[1]
  if (rest.startsWith('{')) {
    let t = rest
    for (let j = it.from; !/\}\s*(#.*)?$/.test(t) && j + 1 < it.to; ) { j++; t += ` ${lines[j].trim()}` }
    try { const o = JSON.parse(t); return typeof o?.name === 'string' ? o.name : null } catch { return rtFlowName(t) }
  }
  const named = /^(?:name|"name"|'name'):\s*(.*)$/.exec(rest)
  if (named) return rtUnq(named[1])
  const col = rest ? head.length - rest.length : (lines.slice(it.from + 1, it.to).find((l) => !rtBlank(l)) || '').search(/\S/)
  for (let i = it.from + 1; i < it.to; i++) {
    if (rtIndentOf(lines[i]) !== col) continue
    const k = /^\s*(?:name|"name"|'name'):\s*(.*)$/.exec(lines[i])
    if (k) return rtUnq(k[1])
  }
  return null
}
const rtItemText = (lines, it) => rtUnq(/^\s*-\s*(.*)$/.exec(lines[it.from])[1])
const rtDropRanges = (lines, ranges) => { const kill = new Set(); for (const r of ranges) for (let i = r.from; i < r.to; i++) kill.add(i); return lines.filter((_, i) => !kill.has(i)) }

// ---- taking asight's entries out ------------------------------------------------------------------------------------------------------------------

export function rtRemoveOurs(input) {
  let lines = input
  const removed = { proxies: 0, groups: 0, providers: 0, rules: 0 }
  const label = { proxies: 'proxies', 'proxy-groups': 'groups', 'rule-providers': 'providers', rules: 'rules' }
  for (const key of RT_KEYS) {
    const sec = rtFind(lines, key)
    if (!sec) continue
    if (rtBlockOnly(lines, sec) !== '') continue
    const kill = []
    if (key === 'rule-providers') {
      let entryIndent = null
      for (let i = sec.start + 1; i < sec.end; i++) {
        if (rtBlank(lines[i])) continue
        const ind = rtIndentOf(lines[i])
        if (entryIndent === null) entryIndent = ind
        if (ind !== entryIndent) continue
        const m = /^\s*("[^"]+"|'[^']+'|[^\s:#][^:]*?):(?:\s|$)/.exec(lines[i])
        if (!m || !rtUnq(m[1]).startsWith(NAME_PREFIX)) continue
        let j = i + 1
        while (j < sec.end && (rtBlank(lines[j]) || rtIndentOf(lines[j]) > entryIndent)) j++
        let to = j
        while (to - 1 > i && rtBlank(lines[to - 1])) to-- // the gap after the entry stays
        kill.push({ from: i, to })
        i = j - 1
      }
    } else {
      const { items } = rtListItems(lines, sec)
      items.forEach((it, k) => {
        if (key === 'rules') {
          const text = rtItemText(lines, it)
          const next = items[k + 1] ? rtItemText(lines, items[k + 1]) : null
          if (OUR_RULE.test(text) || (LOOP_RULE.test(text) && next !== null && OUR_RULE.test(next))) kill.push({ from: it.from, to: it.to })
        } else if ((rtItemName(lines, it) ?? '').startsWith(NAME_PREFIX)) kill.push({ from: it.from, to: it.to })
      })
    }
    if (!kill.length) continue
    removed[label[key]] = kill.length
    lines = rtDropRanges(lines, kill)
    const after = rtFind(lines, key)
    const left = key === 'rule-providers' ? lines.slice(after.start + 1, after.end).some((l) => !rtBlank(l)) : rtListItems(lines, after).items.length > 0
    if (!left) lines = [...lines.slice(0, after.start), `${key}: ${key === 'rule-providers' ? '{}' : '[]'}`, ...lines.slice(after.start + 1)] // an emptied section is an explicit empty one
  }
  return { lines, removed }
}

// ---- the include-all groups' exclude-filter ---------------------------------------------------------------------------------------------------------

// what follows `key:` on its line, as a value: quoted or plain, one line only (a block scalar or a quote left open means the value goes on, which we do not read)
function rtReadScalar(raw) {
  const t = raw.trim()
  if (t === '') return ''
  if (t[0] === '|' || t[0] === '>') throw new RuntimeShapeError('a filter is written as a block scalar')
  if (t[0] === '"' && !/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(t)) throw new RuntimeShapeError('a filter is written over several lines')
  if (t[0] === "'" && !/^'(?:[^']|'')*'\s*(?:#.*)?$/.test(t)) throw new RuntimeShapeError('a filter is written over several lines')
  return rtUnq(t)
}

function rtGroupKeys(lines, it) {
  const head = lines[it.from]
  const rest = /^\s*-\s*(.*)$/.exec(head)[1]
  if (rest.startsWith('{')) return { flow: true, text: lines.slice(it.from, it.to).join(' ') }
  const keyCol = rest ? head.length - rest.length : (lines.slice(it.from + 1, it.to).find((l) => !rtBlank(l)) || '').search(/\S/)
  const keys = {}
  for (let i = it.from; i < it.to; i++) {
    if (i > it.from && rtIndentOf(lines[i]) !== keyCol) continue
    const m = /^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(i === it.from ? rest : lines[i].trimStart())
    if (m) keys[rtUnq(m[1])] = { line: i, raw: m[2] ?? '' }
  }
  return { flow: false, keyCol, keys }
}
const rtJsonValueAt = (line, key, value) => `${line.slice(0, line.indexOf(':', line.indexOf(key)) + 1)} ${JSON.stringify(value)}`

// the filter's value, read from its one line; a value that goes on over the next lines is not read
function rtFilterValue(lines, it, g) {
  const ef = g.keys['exclude-filter']
  const next = lines.slice(ef.line + 1, it.to).find((l) => !rtBlank(l))
  if (next !== undefined && rtIndentOf(next) > g.keyCol) throw new RuntimeShapeError('a filter goes over several lines')
  return rtReadScalar(ef.raw)
}

// one group; returns the new lines and whether the filter moved. Adding touches the groups that have include-all and no others; taking out touches only a filter that holds our token.
function rtEditGroup(lines, it, adding) {
  const g = rtGroupKeys(lines, it)
  if (g.flow) {
    if (adding && /include-all/.test(g.text)) throw new RuntimeShapeError('a group written in flow style has include-all')
    if (!adding && g.text.includes(FILTER_TOKEN)) throw new RuntimeShapeError('a group written in flow style holds our filter')
    return { lines, moved: false }
  }
  const ef = g.keys['exclude-filter']
  if (adding) {
    const on = RT_INCLUDE_ALL.find((k) => g.keys[k] && /^true$/i.test(rtReadScalar(g.keys[k].raw)))
    if (!on) return { lines, moved: false }
    if (!ef) {
      const at = g.keys[on].line + 1
      return { lines: [...lines.slice(0, at), `${' '.repeat(g.keyCol)}exclude-filter: ${JSON.stringify(FILTER_TOKEN)}`, ...lines.slice(at)], moved: true }
    }
    const cur = rtFilterValue(lines, it, g)
    if (cur !== '' && cur.split('|').includes(FILTER_TOKEN)) return { lines, moved: false }
    const out = [...lines]
    out[ef.line] = rtJsonValueAt(lines[ef.line], 'exclude-filter', cur === '' ? FILTER_TOKEN : `${cur}|${FILTER_TOKEN}`)
    return { lines: out, moved: true }
  }
  if (!ef || !ef.raw.includes(FILTER_TOKEN)) return { lines, moved: false } // not ours: whatever it is, it stays
  const cur = rtFilterValue(lines, it, g)
  if (cur === FILTER_TOKEN) {
    if (ef.line === it.from) throw new RuntimeShapeError('our filter is the first key of its group')
    return { lines: [...lines.slice(0, ef.line), ...lines.slice(ef.line + 1)], moved: true }
  }
  if (cur.endsWith(`|${FILTER_TOKEN}`)) {
    const out = [...lines]
    out[ef.line] = rtJsonValueAt(lines[ef.line], 'exclude-filter', cur.slice(0, -(FILTER_TOKEN.length + 1)))
    return { lines: out, moved: true }
  }
  return { lines, moved: false }
}

export function rtApplyFilters(input, adding) {
  let lines = input
  let count = 0
  const sec = rtFind(lines, 'proxy-groups')
  if (!sec || rtBlockOnly(lines, sec) !== '') return { lines, count }
  const { items } = rtListItems(lines, sec)
  for (const it of [...items].reverse()) { // from the last: an insert or a removal does not move the items still to come
    const r = rtEditGroup(lines, it, adding)
    lines = r.lines
    if (r.moved) count++
  }
  return { lines, count }
}

/**
 * The runtime text with everything of asight's taken out, the filters back as they were (the token we appended goes; a filter that was only the token goes with its key). A
 * section left empty stays as an explicit empty one. Returns `{ yaml, removed: { proxies, groups, providers, rules }, unfiltered }`.
 */
export function stripRuntimeText({ yaml }) {
  if (typeof yaml !== 'string') throw new TypeError('the runtime is the text of the file')
  const doc = rtSplit(yaml)
  const cleared = rtRemoveOurs(doc.lines)
  const filtered = rtApplyFilters(cleared.lines, false)
  return { yaml: rtJoin(doc, filtered.lines), removed: cleared.removed, unfiltered: filtered.count }
}
