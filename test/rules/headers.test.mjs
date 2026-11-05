// test/rules/headers.test.mjs — what a rule may do to a header (RFC 5.1 §怎么算改动「头的写法」). Asserts whether problems come back, never their words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkHeaderName, checkHeaderValue, checkHeaderSet, setHeaders } from '../../src/rules/headers.mjs'
import { LIMITS } from '../../src/rules/closed.mjs'

const bad = (list) => assert.notEqual(list.length, 0)
const ok = (list) => assert.deepEqual(list, [])

test('a name is an RFC 9110 token: every separator, control and space is out, every tchar is in', () => {
  for (const n of ['x-a', 'X_A', "!#$%&'*+-.^_`|~09azAZ", 'content-length']) ok(checkHeaderName(n))
  for (const c of [...'()<>@,;:\\"/[]?={} \t\r\n\0\x7f', 'é', '中']) bad(checkHeaderName(`x${c}y`))
  for (const n of ['', 'Content-Length ', 'x\r\ncontent-length', 7, null, undefined]) bad(checkHeaderName(n))
})

test('a value has no control character, whatever it sits next to', () => {
  for (const v of ['', 'a b', 'Bearer x=y', 'é']) ok(checkHeaderValue(v))
  for (let c = 0; c < 0x20; c++) for (const v of [`${String.fromCharCode(c)}a`, `a${String.fromCharCode(c)}`]) bad(checkHeaderValue(v))
  for (const v of ['a\x7fb', 7, null]) bad(checkHeaderValue(v))
})

test('the four framing headers cannot be set or removed in any case', () => {
  for (const n of ['content-length', 'transfer-encoding', 'connection', 'upgrade']) {
    for (const name of [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1)]) for (const value of ['1', null]) bad(checkHeaderSet([[name, value]]))
  }
  ok(checkHeaderSet([['content-type', 'a'], ['x-a', null]]))
})

test('a bad pair is reported at its index', () => {
  const [p] = checkHeaderSet([['x-a', 'ok'], ['x-b', 'a\r\nb']])
  assert.equal(p.at, 1)
})

test('growth is the whole set, net of what it replaces: over the limit only when the headers really grow that much', () => {
  const v = (n) => 'v'.repeat(n)
  ok(checkHeaderSet([['x-a', v(4000)], ['x-b', v(4000)]]))
  assert.equal(checkHeaderSet([['x-a', v(5000)], ['x-b', v(5000)]]).at(-1).at, null)
  bad(checkHeaderSet([['x-a', v(20 * 1024)]]))
  ok(checkHeaderSet([['X-A', v(20 * 1024)]], { before: [['x-a', v(19 * 1024)]] }))
  ok(checkHeaderSet([['x-a', v(5000)], ['x-a', v(5000)]]))
  ok(checkHeaderSet([['x-a', v(9000)], ['x-b', null]], { before: [['x-b', v(5000)]] }))
  bad(checkHeaderSet([['x-a', v(9000)]], { before: [['x-b', v(5000)]] }))
})

const lines = (pairs) => pairs.reduce((n, [name, value]) => n + Buffer.byteLength(`${name}: ${value}\r\n`), 0)
const seeded = (seed) => (n) => { // mulberry32
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) % n
}

// The wire's reading of a set and a removal, on a list that is not the code's: the first of a name takes the value, a removal takes them all.
function landed(headers, [name, value]) {
  const same = ([n]) => n.toLowerCase() === name.toLowerCase(), at = headers.findIndex(same)
  if (value === null) return headers.filter((h) => !same(h))
  return at < 0 ? [...headers, [name, value]] : headers.with(at, [headers[at][0], value])
}

test('setHeaders: what counts is how much the head really grew, along any run of sets and removals', () => {
  const r = seeded(5), names = ['x-a', 'X-A', 'x-b', 'x-c', 'x-d'], sizes = [0, 10, 2000, 5000, 9000]
  const pick = (list) => list[r(list.length)]
  let refused = 0, kept = 0
  for (let round = 0; round < 300; round++) {
    const start = [['x-a', 'v'.repeat(pick(sizes))], ['X-A', 'second'], ['x-e', 'v'.repeat(pick(sizes))]]
    const state = { headers: start, start, grown: 0 }
    for (let step = 0; step < 12; step++) {
      const pair = [pick(names), r(4) === 0 ? null : 'v'.repeat(pick(sizes))], before = state.headers
      const want = landed(before, pair), fits = lines(want) - lines(start) <= LIMITS.headerGrowthBytes
      assert.equal(setHeaders(state, [pair]), fits, JSON.stringify([pair[0], pair[1]?.length]))
      assert.deepEqual(state.headers, fits ? want : before)
      if (fits) kept++; else refused++
    }
  }
  assert.ok(refused > 0 && kept > 0)
})

test('setHeaders: a pair that may not be written changes nothing, the pairs before it included', () => {
  const start = [['x-a', '1']], state = { headers: start, start, grown: 0 }
  for (const bad of [['content-length', '1'], ['x-b', 'a\r\nb'], ['x y', '1']]) {
    assert.equal(setHeaders(state, [['x-ok', '2'], bad]), false)
    assert.equal(state.headers, start)
    assert.equal(state.grown, 0)
  }
})
