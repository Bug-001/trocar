// test/rules/headers.test.mjs — what a rule may do to a header (RFC 5.1 §怎么算改动「头的写法」). Asserts whether problems come back, never their words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkHeaderName, checkHeaderValue, checkHeaderSet } from '../../src/rules/headers.mjs'

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
