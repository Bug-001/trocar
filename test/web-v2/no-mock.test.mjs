// no-mock.test.mjs — the guard that keeps the mock out (UI-1a, 1.2 §不进产品的东西): no in-browser data source, no
// scenario / prototype control, no placeholder wording. The mock transport and its tests were deleted whole; this file is
// what makes their return a red test instead of a habit.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  if (d.isDirectory()) return sources(p)
  return /\.(mjs|html)$/.test(d.name) ? [p] : []
})

test('the in-browser mock is gone: no src/web/v2/mock/, and nothing imports it', () => {
  assert.equal(fs.existsSync(path.join(V2, 'mock')), false, 'src/web/v2/mock/ exists again')
  const offenders = []
  for (const f of sources(V2)) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(V2, f)
    // a static import / re-export, or a dynamic import(), whose target walks into mock/
    for (const m of src.matchAll(/^\s*(?:import\b(?:[^'"`;]*?\bfrom\s*|\s*)|export\b[^'"`;]*?\bfrom\s*)['"]([^'"]+)['"]/gm)) if (/(^|\/)mock(\/|$)/.test(m[1])) offenders.push(`${rel}: import ${m[1]}`)
    for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) if (/(^|\/)mock(\/|$)/.test(m[1])) offenders.push(`${rel}: import() ${m[1]}`)
  }
  assert.deepEqual(offenders, [])
})

// string literals only (single, double, template): a comment that says "the ?api= controls are gone" is history, a string
// that offers one is a control
const STRINGS = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
const BANNED = [
  'scenario', '?api=', '?control=', '?retention=', // the mock's query-string controls (UI-1a item 1)
  '暂时', '待接口', '[待', '建设中', '真服务端', // placeholder wording a real screen never ships (1.5 §数据规则)
]

test(`no shipped string literal carries a mock control or placeholder wording (${BANNED.join(' ')})`, () => {
  const offenders = []
  for (const f of sources(V2)) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(V2, f)
    for (const m of src.matchAll(STRINGS)) for (const bad of BANNED) if (m[2].includes(bad)) offenders.push(`${rel}: "${bad}" in ${m[0].slice(0, 60)}`)
  }
  assert.deepEqual(offenders, [])
})
