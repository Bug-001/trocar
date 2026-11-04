// actions.mjs (src/rules) — the built-in edits and the full (tier 2) judge (RFC 5.1 §动作, §怎么算改动, §条件的写法). Pure functions over a unit's
// bytes. Only the rule process loads this file: it compiles regexes, so it stays out of the daemon's import graph.
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import { scanJson, nodeAt } from '../dissect/json-scan.mjs'
import { ruleBlocksFor } from '../dissect/registry.mjs'
import { sseEvents } from '../dissect/sse-spans.mjs'
import { LIMITS } from './closed.mjs'
import { headersMap, isText, truth } from './compile.mjs'
import { FAST_LITERAL, parseCondition } from './conditions.mjs'
import { setHeaders } from './headers.mjs'
import { spansToSteps, applySteps } from './edits.mjs'
import { actionKind, conditionsOf } from './validate.mjs'

const MAX_BODY = LIMITS.bodyBytes
const STRING_WIDTHS = ['a', '中']
const INFLATE = new Map([['gzip', 'gunzipSync'], ['x-gzip', 'gunzipSync'], ['deflate', 'inflateSync'], ['br', 'brotliDecompressSync'], ['zstd', 'zstdDecompressSync']])

/** Why a unit could not be judged or edited; `why` is a `skipped.why` (closed.mjs). */
export class RuleFault extends Error {
  constructor(why) {
    super(why)
    this.why = why
  }
}
const fault = (why) => new RuleFault(why)

function decode(unit) {
  let bytes = unit.body ?? Buffer.alloc(0)
  if (bytes.length > MAX_BODY) throw fault('too-big')
  const codings = String(unit.encoding ?? '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'identity')
  for (const coding of codings.reverse()) {
    const inflate = zlib[INFLATE.get(coding)]
    if (!inflate) throw fault('encoding')
    try { bytes = inflate(bytes, { maxOutputLength: MAX_BODY }) } catch (e) { throw fault(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'too-big' : 'encoding') }
  }
  return { bytes, text: isText(bytes) ? bytes.toString('utf8') : null }
}

const compiled = new Map()
function regex(source, flags) {
  const key = `${flags}/${source}`
  if (!compiled.has(key)) {
    try { compiled.set(key, new RegExp(source, flags)) } catch { throw fault('rule-error') }
  }
  return compiled.get(key)
}
const escaped = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')

const needText = (text) => { if (text === null) throw fault('not-utf8'); return text }

// Where the JSON of a body may stand, as [from, to]: the whole body, or the one data line of each event.
function windowsOf(text, sse) {
  if (!sse) return [[0, text.length]]
  return sseEvents(text).flatMap((e) => {
    if (e.data === null) return []
    if (e.dataAt === null) throw fault('multi-line-event')
    return [[e.dataAt, e.dataAt + e.data.length]]
  })
}

const JSON_LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/

function collectStrings(node, text, out) {
  if (node.kind === 'literal') {
    if (!JSON_LITERAL.test(text.slice(node.start, node.end))) throw new SyntaxError('not a JSON literal')
  } else if (node.kind === 'string') {
    const raw = text.slice(node.start + 1, node.end - 1)
    out.push({ start: node.start, end: node.end, value: raw.includes('\\') ? JSON.parse(text.slice(node.start, node.end)) : raw })
  } else if (node.kind === 'array' || node.kind === 'object') {
    for (const child of node.items ?? [...node.props.values(), ...(node.shadowed ?? [])]) collectStrings(child, text, out)
  }
}

// A window read as JSON, or null. scanJson takes any bare word for a literal, so [DONE] is text only once the literals are checked here. Too deep to walk is not plain text: read
// as text, its strings would go unread and a `with` could break the JSON.
function scan(text) {
  try {
    const root = scanJson(text)
    const strings = []
    collectStrings(root, text, strings)
    return { root, text, strings }
  } catch (e) {
    if (e instanceof RangeError) throw fault('rule-error')
    return null
  }
}

// What the bytes settle with no JSON read, as tier 1 reads them (5.1 §条件的写法): not there, and no `\u` to spell it. Past this a body too deep to read could not fault a rule tier 1 finished.
const plainlyAbsent = (literal, text) => FAST_LITERAL.test(literal) && !text.includes(literal) && !text.includes('\\u')

function commit(state, spans) {
  if (!spans.length) return
  const steps = spansToSteps(state.text, spans.toSorted((a, b) => a.start - b.start))
  state.bytes = applySteps(state.bytes, steps)
  state.text = state.bytes.toString('utf8')
  for (const step of steps) state.steps.push(step)
}

const shifted = (spans, by) => spans.map((s) => ({ ...s, start: s.start + by, end: s.end + by }))

function splice(text, spans) {
  let out = '', pos = 0
  for (const { start, end, ins } of spans) {
    out += text.slice(pos, start) + ins
    pos = end
  }
  return out + text.slice(pos)
}

function mustParse(text, spans) {
  try { JSON.parse(splice(text, spans.toSorted((a, b) => a.start - b.start))) } catch { throw fault('rule-error') }
}

// The with of a replace, for one match: $1 $& $$ $<name>, the way String.prototype.replace reads them.
function expand(template, m) {
  return template.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, k) => {
    if (k === '$') return '$'
    if (k === '&') return m[0]
    if (k[0] === '<') return m.groups ? m.groups[k.slice(1, -1)] ?? '' : all
    if (+k >= 1 && +k < m.length) return m[+k] ?? ''
    return k.length === 2 && +k[0] >= 1 && +k[0] < m.length ? (m[+k[0]] ?? '') + k[1] : all
  })
}

function hits(text, action) {
  const re = regex(action.literal ? escaped(action.replace) : action.replace, 'gu')
  const out = []
  for (const m of text.matchAll(re)) {
    const ins = action.literal ? action.with : expand(action.with, m)
    if (ins !== m[0]) out.push({ start: m.index, end: m.index + m[0].length, ins })
  }
  return out
}

// String nodes through f: a string f leaves alone keeps its bytes, a changed one is escaped again.
const rewrite = (nodes, f) => nodes.flatMap(({ start, end, value }) => {
  const next = f(value)
  return next === value ? [] : [{ start, end, ins: JSON.stringify(next) }]
})

// `unit.headers` are the request's: blocks only stand where a request does. The readers take them as an object of lowercase names.
const blocksOf = (on, unit, text) => ruleBlocksFor({ endpoint: unit.path, transport: on === 'ws-client' ? 'ws' : undefined, req_headers: Object.fromEntries(headersMap(unit.headers ?? [])), req_body: text })

// An action that wants blocks where no wire can be told: it did not run, and that is not the same as no block being chosen.
function actionBlocks(env, text, selector) {
  const blocks = blocksOf(env.on, env.unit, text)
  if (!blocks) throw fault('no-blocks')
  return select(blocks, selector)
}

const NAMED = ['section', 'kind', 'role', 'name']
const byteSize = (b) => (b.text === null ? 0 : Buffer.byteLength(b.text))

// Blocks run oldest first. skip_newest goes first, so newest counts what it left.
function select(blocks, selector) {
  const text = selector.text === undefined ? null : parseCondition(selector.text, { key: 'body' })
  let out = blocks.filter((b) => NAMED.every((k) => selector[k] === undefined || selector[k] === b[k])
    && byteSize(b) >= (selector.min_bytes ?? 0) && byteSize(b) <= (selector.max_bytes ?? Infinity)
    && (!text || (b.text !== null && holds(text, (n) => compares(n, b.text)))))
  if (selector.skip_newest) out = out.slice(0, Math.max(0, out.length - selector.skip_newest))
  if (selector.newest !== undefined) out = out.slice(Math.max(0, out.length - selector.newest))
  return out
}

function chosenTextNodes(state, env, selector) {
  const chosen = actionBlocks(env, state.text, selector)
  if (chosen.some((b) => !b.text_path)) throw fault('no-blocks')
  const { root } = scan(state.text)
  return chosen.map((b) => {
    const { start, end } = nodeAt(root, b.text_path)
    return { start, end, value: b.text }
  })
}

function actReplace(action, state, env) {
  const text = needText(state.text)
  const edit = (value) => splice(value, hits(value, action))
  if (action.blocks) return commit(state, rewrite(chosenTextNodes(state, env, action.blocks), edit))
  const windows = windowsOf(text, env.unit.sse) // `in: body` reads none, but an event of many data lines is left alone all the same
  if (action.literal && action.with === action.replace) return undefined
  if (action.in === 'body') return commit(state, hits(text, action))
  if (action.literal && plainlyAbsent(action.replace, text)) return undefined
  return commit(state, windows.flatMap(([from, to]) => {
    const window = text.slice(from, to), json = scan(window)
    if (!json && window.includes('\\u')) throw fault('not-json')
    return shifted(json ? rewrite(json.strings, edit) : hits(window, action), from)
  }))
}

function actHeader(action, state) {
  if (!setHeaders(state, [[action.header, action.remove ? null : action.set]])) throw fault('rule-error')
}

// A repeated key hides a value from `props`, so what stands next to what, and what a removal brings back, cannot be told: the rule's error.
const plainObject = (node) => { if (node.shadowed) throw fault('rule-error'); return node }

const siblingsOf = (parent) => (parent.kind === 'array' ? parent.items : [...plainObject(parent).props.values()].sort((a, b) => a.start - b.start))

function skipSeparators(text, i) {
  while (' ,\t\r\n'.includes(text[i])) i++
  return i
}

// Taking nodes out of their parents. Neighbours go as one run, so no two spans fight over a comma: a run with a sibling after it goes up to that
// sibling, a run at the end goes back to the end of the sibling before it. `head` finds a sibling's first byte, its key if it has one.
function removals(text, targets) {
  const byParent = new Map()
  for (const [parent, node] of targets) byParent.set(parent, (byParent.get(parent) ?? new Set()).add(node))
  const spans = []
  for (const [parent, gone] of byParent) {
    const sibs = siblingsOf(parent), last = sibs.length - 1
    if (gone.size === sibs.length) { spans.push({ start: parent.start + 1, end: parent.end - 1, ins: '' }); continue }
    const head = (i) => skipSeparators(text, i ? sibs[i - 1].end : parent.start + 1)
    for (let i = 0; i <= last; i++) {
      if (!gone.has(sibs[i])) continue
      let j = i
      while (j < last && gone.has(sibs[j + 1])) j++
      spans.push(j < last ? { start: head(i), end: head(j + 1), ins: '' } : { start: sibs[i - 1].end, end: sibs[j].end, ins: '' })
      i = j
    }
  }
  return spans
}

const tokensOf = (pointer) => pointer.split('/').slice(1).map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'))
function child(node, token) {
  if (node?.kind === 'object') return plainObject(node).props.get(token)
  return node?.kind === 'array' && /^(0|[1-9]\d*)$/.test(token) ? node.items[+token] : undefined
}

// → the spans of one json action on one JSON text. What is absent needs no removing; what has nowhere to go is the rule's error.
function pointerEdit(action, { root, text }) {
  const path = tokensOf(action.json), last = path.at(-1)
  const parent = path.slice(0, -1).reduce(child, root)
  const target = child(parent, last)
  if (action.remove) {
    if (!target) return []
    const spans = removals(text, [[parent, target]])
    mustParse(text, spans)
    return spans
  }
  const adding = 'add' in action, value = adding ? action.add : action.set, ins = JSON.stringify(value)
  let spans
  if (target && !(adding && parent.kind === 'array')) {
    spans = [{ start: target.start, end: target.end, ins }]
    if (target.kind === 'string' && typeof value === 'string') return spans
  } else if (target) spans = [{ start: target.start, end: target.start, ins: `${ins},` }]
  else {
    const list = parent?.kind === 'array'
    if (!list && parent?.kind !== 'object') throw fault('rule-error')
    if (list && last !== '-' && last !== String(parent.items.length)) throw fault('rule-error')
    const entry = list ? ins : `${JSON.stringify(last)}:${ins}`
    const empty = list ? !parent.items.length : !parent.props.size
    spans = [{ start: parent.end - 1, end: parent.end - 1, ins: empty ? entry : `,${entry}` }]
  }
  mustParse(text, spans)
  return spans
}

function actJson(action, state, env) {
  const text = needText(state.text)
  commit(state, windowsOf(text, env.unit.sse).flatMap(([from, to]) => {
    const json = scan(text.slice(from, to))
    if (json) return shifted(pointerEdit(action, json), from)
    if (env.unit.sse) return [] // [DONE] and the like: an event that is not JSON has no node to point at
    throw fault('rule-error')
  }))
}

// Cut to at most n bytes, back to the start of the character the cut fell in.
function truncated(text, n) {
  const bytes = Buffer.from(text)
  if (bytes.length <= n) return text
  let end = n
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.toString('utf8', 0, end)
}

function actBlocks(action, state, env) {
  const text = needText(state.text)
  if (!action.remove) {
    const edit = 'set_text' in action ? () => action.set_text : 'append_text' in action ? (t) => t + action.append_text : (t) => truncated(t, action.truncate)
    return commit(state, rewrite(chosenTextNodes(state, env, action.blocks), edit))
  }
  const chosen = actionBlocks(env, text, action.blocks)
  if (!chosen.length) return
  const { root } = scan(text)
  const spans = removals(text, chosen.map((b) => [nodeAt(root, b.remove_path.slice(0, -1)), nodeAt(root, b.remove_path)]))
  mustParse(text, spans)
  commit(state, spans)
}

const ACTS = { replace: actReplace, header: actHeader, json: actJson, blocks: actBlocks }

function act(action, state, env) {
  const run = ACTS[actionKind(action)]
  if (!run) throw fault('rule-error')
  run(action, state, env)
}

// Tier 1's reading of a condition, with nothing to pay.
const FREE = { spend: () => true }
const holds = (node, leaf) => truth(node, null, FREE, leaf)

function compares(node, value) {
  switch (node.t) {
    case 'all': return true
    case 'eq': return value === node.v
    case 'prefix': return value.startsWith(node.v)
    case 'suffix': return value.endsWith(node.v)
    case 'contains': return value.includes(node.v)
    default: return regex(node.v, 'u').test(value)
  }
}

// These three read a field the way tier 1 does (compile.mjs), or the two tiers would disagree on a unit. A value of undefined is a header that is
// not there: no pattern matches it, so `not` holds.
const fieldHolds = (condition, key, value) => holds(parseCondition(condition, { key }), (n) => value !== undefined && compares(n, value))
const hostHolds = (condition, host) => holds(parseCondition(condition, { key: 'host' }), (n) => compares(n.t === 're' ? n : { ...n, v: n.v?.toLowerCase() }, host.toLowerCase()))
function headerValue(headers, name) {
  const values = (headers ?? []).filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v)
  return values.length ? values.join(', ') : undefined
}

// Where the escapes of a text stand, as a flat list of from, to: a backslash and the character after it, six characters for \uXXXX. Walked from the left, so the second backslash of
// `\\` starts nothing.
function escapesOf(text) {
  const out = []
  for (let at = text.indexOf('\\'), to; at !== -1; at = text.indexOf('\\', to)) {
    to = at + (/^u[0-9a-fA-F]{4}/.test(text.slice(at + 1, at + 6)) ? 6 : 2)
    out.push(at, to)
  }
  return out
}

// What a body condition reads: the text as it stands and where its escapes are. An event of many data lines is refused here, before anything hits.
const readings = new WeakMap()
function readingOf(decoded, unit) {
  if (!readings.has(decoded)) {
    const text = needText(decoded.text)
    readings.set(decoded, { text, windows: windowsOf(text, unit.sse), escapes: escapesOf(text), strings: null, unsure: false })
  }
  return readings.get(decoded)
}

// The decoded strings of each JSON window and the windows that are not JSON as they stand, read the first time the bytes leave a condition open. `unsure`: one of those holds a `\u`.
function stringsOf(reading) {
  if (reading.strings) return reading.strings
  const strings = []
  for (const [from, to] of reading.windows) {
    const window = reading.text.slice(from, to), json = scan(window)
    if (json) for (const s of json.strings) strings.push(s.value)
    else {
      strings.push(window)
      reading.unsure ||= window.includes('\\u')
    }
  }
  reading.strings = strings
  return strings
}

// Hit in the bytes as they stand, clear of any real escape: this is how a key or a number hits. A hit that touches an escape read it as text, so the search goes on one character
// later, and hits may overlap. What the bytes leave open the decoded strings say; null when no one can, because a `\u` in what is not JSON could spell anything.
function bodyHit(node, reading) {
  const { text, escapes } = reading, source = node.t === 're' ? node.v : escaped(node.v)
  const search = regex(source, 'gu')
  for (let m = search.exec(text), e = 0; m; m = search.exec(text)) {
    while (e < escapes.length && escapes[e + 1] <= m.index) e += 2
    if (e === escapes.length || escapes[e] >= m.index + m[0].length) {
      search.lastIndex = 0 // the regex is shared, and it is left the way it came
      return true
    }
    search.lastIndex = m.index + (text.codePointAt(m.index) > 0xffff ? 2 : 1)
  }
  if (node.t !== 're' && plainlyAbsent(node.v, text)) return false
  const re = regex(source, 'u')
  return stringsOf(reading).some((s) => re.test(s)) || (reading.unsure ? null : false)
}

const FIELDS = ['pid', 'path', 'method', 'class', 'status', 'event_index']

function judge(rule, unit, decoded) {
  const m = rule.match
  if (m.harness !== undefined && m.harness !== 'any' && ![].concat(m.harness).includes(unit.harness)) return false
  if (m.host !== undefined && (unit.host == null || !hostHolds(m.host, unit.host))) return false
  for (const key of FIELDS) { // a field the unit does not have is no hit, whatever the condition says
    if (m[key] !== undefined && (unit[key] == null || !fieldHolds(m[key], key, String(unit[key])))) return false
  }
  for (const [key, headers] of [['header', unit.headers], ['req_header', unit.req_headers]]) {
    for (const [name, condition] of Object.entries(m[key] ?? {})) {
      if (!fieldHolds(condition, key, headerValue(headers, name))) return false
    }
  }
  if (m.body !== undefined) {
    const reading = readingOf(decoded, unit)
    const answer = holds(parseCondition(m.body, { key: 'body' }), (n) => bodyHit(n, reading))
    if (answer === null) throw fault('not-json')
    if (!answer) return false
  }
  if (m.blocks === undefined) return true
  const blocks = blocksOf(rule.on ?? 'request', unit, needText(decoded.text))
  return !!blocks && select(blocks, m.blocks).length > 0
}

function* regexesOf(node) {
  if (node.t === 're') yield node.v
  for (const inner of node.of ?? []) yield* regexesOf(inner)
}

// V8 compiles a regex once per string width, on first use. `before` runs ahead of each one, for the load's clock (5.1 §规则进程「载入有时限」).
function warm(rule, before) {
  const run = (source, flags) => {
    before()
    const re = regex(source, flags)
    for (const sample of STRING_WIDTHS) {
      re.lastIndex = 0
      re.test(sample)
    }
  }
  const selectors = [rule.match.blocks, ...rule.do.map((action) => action.blocks)].filter((selector) => selector?.text !== undefined)
  const nodes = [...[...conditionsOf(rule.match)].map(({ key, value }) => parseCondition(value, { key })), ...selectors.map(({ text }) => parseCondition(text, { key: 'body' }))]
  for (const source of nodes.flatMap((node) => [...regexesOf(node)])) {
    run(source, 'u')
    run(source, 'gu')
  }
  for (const action of rule.do) {
    if (actionKind(action) === 'replace') run(action.literal ? escaped(action.replace) : action.replace, 'gu')
  }
}

/** The rule process's half of a rule, injected into applyRules: `decode(unit)` → `{bytes, text|null}`, `judge(rule, unit, decoded)` → boolean,
 *  `act(action, state, {on, unit})` moves `state` = `{bytes, text, headers, steps}` on. All three throw RuleFault. `warm(rule, before)` is the load's, not applyRules's. */
export const full = { decode, judge, act, warm }
