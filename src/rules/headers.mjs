// headers.mjs (src/rules) — the one check on what a rule may do to a header (RFC 5.1 §怎么算改动「头的写法」): `rules add`, the daemon loading rules and
// a script's result all go through it, because the daemon does not trust the CLI. Every check returns a list of problems and never throws.
import { CONDITION_COST } from './budget.mjs'
import { LIMITS } from './closed.mjs'

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const CONTROL = /[\x00-\x1f\x7f]/
// trocar owns these: its framing of the message depends on them.
const UNTOUCHABLE = new Set(['content-length', 'transfer-encoding', 'connection', 'upgrade'])

/** A header name: an RFC 9110 token. */
export const checkHeaderName = (n) => (typeof n === 'string' && TOKEN.test(n) ? [] : [{ reason: 'a header name is an RFC 9110 token' }])

/** A header value: a string with no control character, so CR and LF never reach a header. */
export const checkHeaderValue = (v) => (typeof v === 'string' && !CONTROL.test(v) ? [] : [{ reason: 'a header value has no control characters' }])

/** What `after` did to `before`, in the shape checkHeaderSet reads: the pairs that are new, and a null for a name that went. What the agent sent is no rule's doing. A null in
 *  `after` is no removal: it stays a bad value. */
export function headerChanges(before, after) {
  const key = (pair) => JSON.stringify(pair)
  const had = new Set(before.map(key)), kept = new Set(after.map(([name]) => String(name).toLowerCase()))
  const fresh = after.filter((pair) => !had.has(key(pair))).map(([name, value]) => [name, value ?? undefined])
  return [...fresh, ...before.filter(([name]) => !kept.has(name.toLowerCase())).map(([name]) => [name, null])]
}

const lineBytes = (name, value) => Buffer.byteLength(`${name}: ${value}\r\n`)

/** Headers a rule or a script sets: `pairs` is `[[name, value]…]` in order, a null value removes; `before` the same shape, the headers they land
 *  on. → `[{at, reason}]`: `at` the index of the bad pair, null when the set as a whole grows the headers by more than the limit. A later pair
 *  with the same name replaces the earlier one, as it does on the wire. */
export function checkHeaderSet(pairs, { before = [] } = {}) {
  const out = [], after = new Map()
  pairs.forEach(([name, value], at) => {
    const problems = [...checkHeaderName(name), ...(value === null ? [] : checkHeaderValue(value))]
    if (typeof name === 'string' && UNTOUCHABLE.has(name.toLowerCase())) problems.push({ reason: `${name} is not a header a rule may touch` })
    out.push(...problems.map((p) => ({ at, ...p })))
    if (!problems.length) after.set(name.toLowerCase(), value === null ? 0 : lineBytes(name, value))
  })
  let growth = [...after.values()].reduce((n, b) => n + b, 0)
  for (const [name, value] of before) if (after.has(String(name).toLowerCase())) growth -= lineBytes(name, value)
  if (growth > LIMITS.headerGrowthBytes) out.push({ at: null, reason: `these headers grow by more than ${LIMITS.headerGrowthBytes} bytes` })
  return out
}

/** `pairs` onto `state.headers`, as checkHeaderSet reads them. The limit is the unit's and not the rule's: `state.grown` is what the head has grown by since it arrived, net of what
 *  went, and a rule that fails takes its part back with the rest of the state. False, and nothing changed, when a pair may not be written or the whole grows past the limit. */
export function setHeaders(state, pairs) {
  if (checkHeaderSet(pairs).some(({ at }) => at !== null)) return false
  let next = state.headers, { grown } = state
  for (const [name, value] of pairs) {
    const key = name.toLowerCase(), same = ([n]) => n.toLowerCase() === key
    const at = next.findIndex(same)
    if (value === null) {
      for (const pair of next) if (same(pair)) grown -= lineBytes(...pair)
      next = next.filter((h) => !same(h))
    } else if (at < 0) {
      grown += lineBytes(name, value)
      next = [...next, [name, value]]
    } else {
      grown += lineBytes(next[at][0], value) - lineBytes(...next[at])
      next = next.with(at, [next[at][0], value])
    }
  }
  if (grown > LIMITS.headerGrowthBytes) return false
  Object.assign(state, { headers: next, grown })
  return true
}

/** Pays for one pass over a head (5.1 §主线程的字节预算), before it. Its pairs are counted first: that takes no pass, and the walk that counts the bytes is one. */
export const spendHead = (pairs, budget) => budget.spend(pairs.length * CONDITION_COST)
  && budget.spend(pairs.reduce((n, [name, value]) => n + name.length + value.length, 0))
