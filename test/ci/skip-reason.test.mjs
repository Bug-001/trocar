// test/ci/skip-reason.test.mjs — a skipped test says why: a `skip` that is only a boolean reports `# SKIP` with nothing after it, and a run's skip list
// cannot be read. Over test/: a test's `skip` option, or a `const skip =`, whose value can only be a boolean when it is truthy is red. Judged on the AST.
// An identifier, a call or a lookup is not judged here (its value is another line's).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@typescript-eslint/parser'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(d, e.name).split(path.sep).join('/')] : [])

const TEST_CALLS = new Set(['test', 'it', 'describe'])
const COMPARE = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'])
/** Whether what makes this value skip the test can be a bare `true`: `&&` gives its right side when it skips, `||` `??` `?:` either side. */
const bare = (n) => {
  switch (n.type) {
    case 'Literal': return n.value === true
    case 'UnaryExpression': return n.operator === '!'
    case 'BinaryExpression': return COMPARE.has(n.operator)
    case 'LogicalExpression': return n.operator === '&&' ? bare(n.right) : bare(n.left) || bare(n.right)
    case 'ConditionalExpression': return bare(n.consequent) || bare(n.alternate)
    default: return false
  }
}
const isTestCall = ({ callee: c }) => TEST_CALLS.has(c.type === 'MemberExpression' ? c.property.name : c.name)
/** The `skip` values of a source file that are bare booleans, as their source text. */
export function bareSkips(src) {
  const found = [], seen = (v) => { if (bare(v)) found.push(src.slice(...v.range)) }
  const visit = (n) => {
    if (n.type === 'VariableDeclarator' && n.id.name === 'skip' && n.init) seen(n.init)
    if (n.type === 'CallExpression' && isTestCall(n)) for (const a of n.arguments) if (a.type === 'ObjectExpression') for (const p of a.properties) if (p.type === 'Property' && !p.computed && p.key.name === 'skip') seen(p.value)
    for (const v of Object.values(n)) for (const c of [v].flat()) if (c && typeof c.type === 'string' && c !== n.parent) visit(c)
  }
  visit(parse(src, { ecmaVersion: 'latest', sourceType: 'module', range: true }))
  return found
}

test('every skip in test/ says why: no bare boolean', () => {
  const found = walk('test').flatMap((f) => { const src = fs.readFileSync(path.join(ROOT, f), 'utf8'); return src.includes('skip') ? bareSkips(src).map((v) => `${f}: skip: ${v}`) : [] })
  assert.deepEqual(found, [], 'give it a reason: `cond && \'why\'`')
})

const inTest = (v) => `test('x', { skip: ${v} }, () => {})\n`
test('the scan goes red on each spelling of a bare boolean', () => {
  for (const v of ["process.platform === 'win32'", '!POSIX', 'true', "a === 1 && b !== 'c'", "a && 'b' === c", "x || 'y' === z", "x === 1 || 'why'", "a === 'b' ? true : false", "x ? y : z === 'a'", '!!x', "x\n  === 'y'"]) assert.deepEqual(bareSkips(inTest(v)), [v], v)
  assert.equal(bareSkips("const skip = process.env.X !== '1'\n").length, 1)
  assert.equal(bareSkips("t.test('x', { timeout: 1, skip: !a }, () => {})\n").length, 1)
})

test('the scan passes a reason, a value it cannot see, a comment, a string and data', () => {
  for (const v of ["'why'", "x === 1 && 'why, and more'", 'x === 1 &&\n  \'why\'', '!x && `no ${y}`', "x ? false : 'why'", "x === 1 && (y ? 'a' : 'b')", "(a && 'x') || (b && 'y')", '`n ${a === 1}`', "f('a<b')", "'a ' + b", 'false', 'await unservable(p)', 'cannot[p]', 'gate.reason', 'a && b']) assert.deepEqual(bareSkips(inTest(v)), [], v)
  for (const src of ["test('x', { skip }, () => {})\n", "const skip = a !== 1 && 'why'\n", "// test('x', { skip: x === 1 }, () => {})\n", "const s = 'skip: true is bad'\n", 'const row = [{ skip: true }]\n', 'f({ skip: a === 1 })\n', "test('x', { skip: list.find((x) => x.a === 1) }, () => {})\n"]) assert.deepEqual(bareSkips(src), [], src)
})
