// conditions.mjs (src/rules) — a match condition as written in a rule → its AST, and which tier it runs in (RFC 5.1 §条件的写法). Only parses: a
// regex is length-checked here and compiled nowhere near this file, because the daemon validates through it too.
import { LIMITS } from './closed.mjs'

/** A literal the byte search may decide (5.1 §条件的写法): anything else could be written another way inside a JSON body. */
export const FAST_LITERAL = /^[A-Za-z0-9 _\-.:]+$/

// `*` is a wildcard only at the two ends; `body` strings are literals, "the text has this".
function literal(s, key) {
  if (key === 'body') return { t: 'contains', v: s }
  const head = s.startsWith('*'), tail = s.length > 1 && s.endsWith('*')
  if (!head && !tail) return { t: 'eq', v: s }
  const v = s.slice(head ? 1 : 0, tail ? -1 : undefined)
  if (!v) return { t: 'all' }
  return { t: head && tail ? 'contains' : head ? 'suffix' : 'prefix', v }
}

function parse(value, key, depth) {
  if (depth > LIMITS.jsonDepth) return null
  if (typeof value === 'string') return literal(value, key)
  if (typeof value === 'number') return literal(String(value), key)
  if (Array.isArray(value)) {
    if (!value.length || value.length > LIMITS.list) return null
    const of = value.map((v) => parse(v, key, depth + 1))
    return of.includes(null) ? null : { t: 'any', of }
  }
  if (value === null || typeof value !== 'object') return null
  const keys = Object.keys(value)
  if (keys.length !== 1) return null
  if (keys[0] === 'not') {
    const of = parse(value.not, key, depth + 1)
    return of && { t: 'not', of: [of] }
  }
  if (keys[0] !== 're') return null
  const re = value.re
  return typeof re === 'string' && re && Buffer.byteLength(re) <= LIMITS.regexBytes ? { t: 're', v: re } : null
}

/** A condition as written → `{t:'eq'|'prefix'|'suffix'|'contains'|'all'|'any'|'not'|'re', v?, of?}`, or null when it is not a condition (a bad
 *  shape, a list or a regex over its limit). `key`: the match key it sits under. */
export const parseCondition = (value, { key } = {}) => parse(value, key, 0)

/** 2 when any part of the condition runs in the rule process, else 1. */
export function tierOf(node, { key } = {}) {
  if (node.t === 're') return 2
  if (node.of) return Math.max(...node.of.map((n) => tierOf(n, { key })))
  if (node.t === 'all') return 1
  if (Buffer.byteLength(node.v) > LIMITS.literalBytes) return 2
  return key === 'body' && !FAST_LITERAL.test(node.v) ? 2 : 1
}

/** How many leaf comparisons the condition is. */
export const leaves = (node) => (node.of ? node.of.reduce((n, c) => n + leaves(c), 0) : 1)

/** The literal strings of the condition's leaves (a regex has none). */
export const literals = (node) => (node.of ? node.of.flatMap(literals) : node.t === 're' || node.t === 'all' ? [] : [node.v])

/** The values of a condition that is nothing but exact matches, or null: what the host index buckets on (5.1 §分派). */
export function exactValues(node) {
  if (node.t === 'eq') return [node.v]
  if (node.t !== 'any') return null
  const values = node.of.map(exactValues)
  return values.includes(null) ? null : values.flat()
}
