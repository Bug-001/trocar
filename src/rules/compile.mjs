// compile.mjs (src/rules) — a checked rule file → closures, the host index and the tier 1 verdict (RFC 5.1 §规则, §分派). The daemon loads this file: it
// builds no regex, parses no body and runs no action. A verdict is `hit` or `miss` only when the bytes settle it; the rest is `tier2`.
import { Buffer, isUtf8 } from 'node:buffer'
import { ESCAPE_REACH, exactValues, parseCondition, tierOf } from './conditions.mjs'
import { normalizeRule, readsBody } from './validate.mjs'
import { CONDITION_COST } from './budget.mjs'

const has = Object.hasOwn
const BACKSLASH = 0x5C
const LF = 0x0A, CR = 0x0D
const DATA_FIELD = Buffer.from('data:')
// `\uXXXX` is the longest escape: a hit starting up to five bytes after a backslash may be the tail of one.

/** Header pairs → Map of lowercase name → value, repeats joined with `, `. */
export function headersMap(pairs) {
  const map = new Map()
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    map.set(key, map.has(key) ? `${map.get(key)}, ${value}` : value)
  }
  return map
}

// Once per unit, not once per rule; a unit's pairs do not change while it is judged, and the unit itself is not written.
const seen = new WeakMap()
function headersOf(pairs) {
  if (!pairs) return new Map()
  if (!seen.has(pairs)) seen.set(pairs, headersMap(pairs))
  return seen.get(pairs)
}

// Three answers: true, false, null when tier 1 cannot say. A spent budget says null from here on, so it needs no path of its own.
function truth(node, value, budget, leaf) {
  if (node.t === 'not') {
    const inner = truth(node.of[0], value, budget, leaf)
    return inner === null ? null : !inner
  }
  if (node.t !== 'any') return budget.spend(CONDITION_COST) ? leaf(node, value, budget) : null
  let out = false
  for (const of of node.of) {
    const inner = truth(of, value, budget, leaf)
    if (inner) return true
    if (inner === null) out = null
  }
  return out
}

// `undefined` is a header that is not there: no pattern matches it, so `not` holds.
function textLeaf(node, text, budget) {
  if (text === undefined) return false
  if (node.t === 'all') return true
  if (node.t === 'eq') return text === node.v
  if (node.t === 'prefix') return text.startsWith(node.v)
  if (node.t === 'suffix') return text.endsWith(node.v)
  return budget.spend(text.length) ? text.includes(node.v) : null
}

// Two `data:` lines. Two events of a whole stream count too: that costs a trip to tier 2 and no wrong answer.
function manyDataLines(bytes) {
  let lines = 0
  for (let at = bytes.indexOf(DATA_FIELD); at !== -1; at = bytes.indexOf(DATA_FIELD, at + 1)) {
    if ((at === 0 || bytes[at - 1] === LF || bytes[at - 1] === CR) && ++lines === 2) return true
  }
  return false
}

/** Would tier 2 read these bytes at all? It refuses what is not UTF-8 and an event of many data lines, so tier 1 may not answer for them, either way. False also when the passes
 *  cannot be paid for. */
export function readable(bytes, sse, budget) {
  return budget.spend(bytes.length) && isUtf8(bytes) && !(sse && (!budget.spend(bytes.length) || manyDataLines(bytes)))
}

// Paid once per unit, however many rules read its body. A spent budget says nothing about the bytes, so it is not kept.
const read = new WeakMap()
function readableUnit(unit, budget) {
  if (read.has(unit)) return read.get(unit)
  const answer = readable(unit.body, unit.sse, budget)
  if (!budget.over) read.set(unit, answer)
  return answer
}

// The literal has only FAST_LITERAL's characters, so a clean hit is the text. A hit behind a backslash may be an escape's tail (`ABC` holds
// `41BC`, `\nALPHA` holds `nALPHA`), and `\u` can spell any character, so neither lets the search say no.
function bodyLeaf(node, unit, budget) {
  const { body } = unit
  if (body === null || unit.encoding || !readableUnit(unit, budget) || !budget.spend(body.length)) return null
  let doubt = false
  for (let at = body.indexOf(node.v); at !== -1; at = body.indexOf(node.v, at + 1)) {
    if (!body.subarray(Math.max(0, at - ESCAPE_REACH), at).includes(BACKSLASH)) return true
    doubt = true
    if (!budget.spend(CONDITION_COST)) return null
  }
  if (doubt || !budget.spend(body.length)) return null
  return body.includes('\\u') ? null : false
}

const foldCase = (node) => {
  if (node.of) return { ...node, of: node.of.map(foldCase) }
  return node.v === undefined || node.t === 're' ? node : { ...node, v: node.v.toLowerCase() }
}

// A missing pid, status or event_index is no match, whatever the condition says.
const scalar = (key, node, read = (unit) => unit[key]) => (unit, budget) => {
  const value = read(unit)
  return value === null || value === undefined ? false : truth(node, String(value), budget, textLeaf)
}
const header = (side, name, node) => (unit, budget) => truth(node, headersOf(unit[side]).get(name), budget, textLeaf)
const body = (node) => (unit, budget) => truth(node, unit, budget, bodyLeaf)

const hostOf = (match) => (has(match, 'host') ? foldCase(parseCondition(match.host, { key: 'host' })) : null)

// A rule's conditions in the order they run: what tier 1 can test, the body last so a head miss costs no pass, and whether any part must wait for tier 2.
function conditionsOf(match) {
  const tests = [], last = []
  let waits = has(match, 'blocks')
  const add = (key, node, make, to = tests) => {
    if (tierOf(node, { key }) === 2) waits = true
    else to.push(make(node))
  }
  for (const key of ['method', 'path', 'class', 'pid', 'status', 'event_index']) {
    if (has(match, key)) add(key, parseCondition(match[key], { key }), (node) => scalar(key, node))
  }
  if (has(match, 'host')) add('host', hostOf(match), (node) => scalar('host', node, (unit) => unit.host?.toLowerCase()))
  for (const [key, side] of [['header', 'headers'], ['req_header', 'req_headers']]) {
    for (const name of Object.keys(match[key] ?? {})) add(key, parseCondition(match[key][name], { key }), (node) => header(side, name.toLowerCase(), node))
  }
  if (has(match, 'body')) add('body', parseCondition(match.body, { key: 'body' }), body, last)
  return { tests: [...tests, ...last], waits }
}

function compileRule(written, index) {
  const rule = normalizeRule(written)
  const { tests, waits } = conditionsOf(rule.match)
  return {
    rule, index, name: rule.name, tier: waits ? 2 : 1, readsBody: readsBody(rule),
    /** A rule `lookup` returned, on one unit → `hit`, `miss` or `tier2`: `on` and harness are the index's and not looked at again. */
    judge(unit, budget) {
      let unsure = waits
      for (const test of tests) {
        const answer = test(unit, budget)
        if (answer === false) return 'miss'
        if (answer === null) {
          if (budget.over) return 'tier2'
          unsure = true
        }
      }
      return unsure ? 'tier2' : 'hit'
    },
  }
}

const slotOf = (table, key, make) => {
  if (!table.has(key)) table.set(key, make())
  return table.get(key)
}

/** A checked rule file → `{rules, lookup(on, harness, host)}`. Exact hosts sit in on → harness → host, everything else in on → harness's one table:
 *  merging them would be the cartesian product 5.1 §分派 forbids. `any` is an ordinary harness key. */
export function compileRules(doc) {
  const rules = doc.rules.map(compileRule)
  const index = new Map()
  for (const compiled of rules) {
    const { on, match } = compiled.rule
    const host = hostOf(match), exact = host && exactValues(host)
    for (const harness of new Set([].concat(match.harness))) {
      const slot = slotOf(slotOf(index, on, () => new Map()), harness, () => ({ hosts: new Map(), wild: [] }))
      if (!exact) slot.wild.push(compiled)
      else for (const value of new Set(exact)) slotOf(slot.hosts, value, () => []).push(compiled)
    }
  }
  return {
    rules,
    lookup(on, harness, host) {
      const slots = index.get(on)
      if (!slots) return []
      const found = new Set(), key = host?.toLowerCase()
      for (const name of new Set([harness, 'any'])) {
        const slot = slots.get(name)
        if (!slot) continue
        for (const compiled of slot.hosts.get(key) ?? []) found.add(compiled)
        for (const compiled of slot.wild) found.add(compiled)
      }
      return [...found].sort((a, b) => a.index - b.index)
    },
  }
}
