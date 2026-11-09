// test/ci/skip-reason.test.mjs — a skipped test says why: a `skip` that is only a boolean reports `# SKIP` with nothing after it, and a run's skip list
// cannot be read. Static, over test/: a `skip:` option or a `const skip =` whose value is a boolean expression with no reason string in it is red.
// An identifier, a call or a lookup is not judged here (its value is another line's).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { views } from '../netenv/fixtures/write-scan.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(d, e.name).split(path.sep).join('/')] : [])

/** The expression that starts at `from`: up to the first `,` `}` `)` or newline outside brackets and strings. */
function valueAt(s, from) {
  let depth = 0, quote = null
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if ('([{'.includes(c)) depth++
    else if (depth === 0 && ',)}\n'.includes(c)) return s.slice(from, i).trim()
    else if (')]}'.includes(c)) depth--
  }
  return s.slice(from).trim()
}
const BOOLEAN = /^(?:true$|!)|[=!]==?|[<>]/ // `true`, a negation, a comparison; a value holding a callback (`=>`) is data, not one of these
const REASON = /^['"`]|(?:&&|\|\||\?|:)\s*\(*\s*['"`]/ // a string it can evaluate to
/** The bare booleans of a source file; found in its code (a `skip:` inside a string is not one), read with their strings. */
export function bareSkips(src) {
  const { nc, code } = views(src)
  return [...code.matchAll(/\bskip\s*:\s*|\b(?:const|let|var)\s+skip\s*=\s*/g)].map((m) => valueAt(nc, m.index + m[0].length)).filter((v) => BOOLEAN.test(v) && !REASON.test(v) && !v.includes('=>'))
}

test('every skip in test/ says why: no bare boolean', () => {
  const found = walk('test').flatMap((f) => bareSkips(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((v) => `${f}: skip: ${v}`))
  assert.deepEqual(found, [], 'give it a reason: `cond && \'why\'`')
})

test('the scan goes red on each spelling of a bare boolean, and not on a reason, a value it cannot see or a comment', () => {
  for (const bare of ["{ skip: process.platform === 'win32' }", '{ skip: !POSIX }', '{ skip: true, timeout: 1 }', "const skip = process.env.X !== '1'\n", "{ skip: a === 1 && b !== 'c' }"]) assert.equal(bareSkips(bare).length, 1, bare)
  for (const said of ["{ skip: 'why' }", "{ skip: x === 1 && 'why, and more' }", "{ skip: !x && `no ${y}` }", "{ skip: x ? false : 'why' }", "{ skip: x === 1 && (y ? 'a' : 'b') }", "const skip = a !== 1 && 'why'\n", '{ skip }', '{ skip: await unservable(p) }', '{ skip: cannot[p] }', '{ skip: gate.reason }', "// { skip: x === 1 }\n", "const s = 'skip: true is bad'\n", '{ skip: list.find((x) => x.a === 1) }']) assert.deepEqual(bareSkips(said), [], said)
})
