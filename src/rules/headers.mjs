// headers.mjs (src/rules) — the one check on what a rule may do to a header (RFC 5.1 §怎么算改动「头的写法」): `rules add`, the daemon loading rules and
// a script's result all go through it, because the daemon does not trust the CLI. Every check returns a list of problems and never throws.
import { LIMITS } from './closed.mjs'

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const CONTROL = /[\x00-\x1f\x7f]/
// trocar owns these: its framing of the message depends on them.
const UNTOUCHABLE = new Set(['content-length', 'transfer-encoding', 'connection', 'upgrade'])

/** A header name: an RFC 9110 token. */
export const checkHeaderName = (n) => (typeof n === 'string' && TOKEN.test(n) ? [] : [{ reason: 'a header name is an RFC 9110 token' }])

/** A header value: a string with no control character, so CR and LF never reach a header. */
export const checkHeaderValue = (v) => (typeof v === 'string' && !CONTROL.test(v) ? [] : [{ reason: 'a header value has no control characters' }])

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
