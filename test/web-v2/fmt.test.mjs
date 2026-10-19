import test from 'node:test'
import assert from 'node:assert/strict'
import { kf, bytes, enc, esc, usd, clip, preview, fmtDur, base, fmtTime, fmtWhen, fmtStamp, has } from '../../src/web/v2/core/fmt.mjs'

test('kf', () => { assert.equal(kf(null), '?'); assert.equal(kf(950), '950'); assert.equal(kf(1234), '1.2k'); assert.equal(kf(12345), '12k') })
test('bytes keeps null as unknown', () => { assert.equal(bytes(null), '—'); assert.equal(bytes(0), '0 B'); assert.equal(bytes(1536), '1.5 KB'); assert.equal(bytes(5 * 1048576), '5.0 MB') })
test('enc counts UTF-8 bytes', () => { assert.equal(enc('调度'), 6); assert.equal(enc('ab'), 2) })
test('esc', () => { assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;') })
test('bytes never prints 1024 of a smaller unit', () => { assert.equal(bytes(1023), '1023 B'); assert.equal(bytes(1048575), '1.0 MB'); assert.equal(bytes(1024 ** 3 * 1.2), '1.2 GB') })
test('usd keeps NULL unknown instead of showing $0', () => {
  assert.equal(usd(0.0012), '$0.0012'); assert.equal(usd(0.012), '$0.012'); assert.equal(usd(1.2), '$1.20'); assert.equal(usd(0), '$0')
  assert.equal(usd(null), '?'); assert.equal(usd(undefined), '?')
})
test('clip, preview, fmtDur, base', () => {
  assert.equal(clip('abcdef', 3), 'abc …'); assert.equal(clip('ab', 3), 'ab'); assert.equal(clip(null, 3), '')
  assert.equal(preview('  a \n\t b  '), 'a b'); assert.equal(preview('x'.repeat(200)).length, 90)
  assert.equal(fmtDur(850), '850ms'); assert.equal(fmtDur(1200), '1.2s'); assert.equal(fmtDur(null), '?')
  assert.equal(base('/a/b/c.txt'), 'c.txt'); assert.equal(base('/a/b/'), 'b')
})

test('preview collapses whitespace and cuts at 90 characters', () => {
  assert.equal(preview('a\n\n  b\t\tc'), 'a b c'); assert.equal(preview(null), ''); assert.equal(preview(undefined), '')
  const cut = preview('word '.repeat(40)); assert.equal(cut.length, 90); assert.equal(cut, ('word '.repeat(40)).trim().slice(0, 90))
  assert.equal(preview('x'.repeat(90)), 'x'.repeat(90)); assert.equal(preview('x'.repeat(91)).length, 90)
  assert.equal(preview('   ' + 'y'.repeat(100)).length, 90) // leading blanks are trimmed before the cut, not counted in it
})
test('bytes: a value that is not a size is unknown, never a number', () => {
  for (const x of [NaN, Infinity, -Infinity, -1, -0.5]) assert.equal(bytes(x), '—', String(x))
  assert.equal(bytes(0), '0 B'); assert.equal(bytes(1), '1 B')
})
test('usd: a real cost under a hundredth of a cent is "<$0.0001", not "$0.0000"', () => {
  assert.equal(usd(0.00001), '<$0.0001'); assert.equal(usd(Number.MIN_VALUE), '<$0.0001'); assert.equal(usd(0.00009999), '<$0.0001')
  assert.equal(usd(0.0001), '$0.0001'); assert.equal(usd(0), '$0')
})
test('usd: a value that is not an amount is unknown', () => {
  for (const x of [NaN, Infinity, -Infinity, -1]) assert.equal(usd(x), '?', String(x))
})
test('fmtTime: an invalid or empty time is "", never the words "Invalid Date"', () => {
  for (const x of ['not a time', 'x', NaN, {}, undefined, null, '']) assert.equal(fmtTime(x), '', String(x))
  assert.ok(fmtTime('2026-10-07T08:00:00Z').length > 0); assert.ok(!fmtTime('2026-10-07T08:00:00Z').includes('Invalid'))
  assert.ok(fmtTime(Date.parse('2026-10-07T08:00:00Z')).length > 0)
})
test('fmtWhen: empty is a dash, junk is shown as it came, today shows only the time', () => {
  const now = Date.parse('2026-10-07T08:00:00Z')
  assert.equal(fmtWhen('', now), '—'); assert.equal(fmtWhen(null, now), '—'); assert.equal(fmtWhen('junk', now), 'junk')
  assert.equal(fmtWhen(now - 1000, now), fmtTime(now - 1000))
  assert.equal(fmtWhen(now - 3 * 86400e3, now), fmtStamp(now - 3 * 86400e3))
})
// B-M10: the page is zh-CN, so the clock is a 24 h one ("15:59:48"), never the browser default "3:59:48 PM" (nor 上午 / 下午)
test('times are zh-CN and 24 h: 15:59:48, not 3:59:48 PM; midnight is 00:…, not 24:… and not 12:… AM', () => {
  const at = (h, mi, sec) => new Date(2026, 9, 7, h, mi, sec)
  assert.equal(fmtTime(at(15, 59, 48)), '15:59:48'); assert.equal(fmtTime(at(0, 5, 9)), '00:05:09'); assert.equal(fmtTime(at(12, 0, 0)), '12:00:00')
  const now = at(16, 0, 0).getTime()
  assert.equal(fmtWhen(at(15, 59, 48).getTime(), now), '15:59:48', 'today shows the time only')
  const other = fmtWhen(at(15, 59, 48).getTime(), now + 3 * 86400e3)
  assert.match(other, /2026/); assert.match(other, /15:59:48$/)
  assert.equal(fmtStamp(at(0, 5, 9)), '2026/10/7 00:05:09')
  assert.equal(fmtStamp(''), '—'); assert.equal(fmtStamp('junk'), 'junk')
})

test('has: own keys only (a code like "constructor" is not in a lookup table)', () => {
  assert.equal(has({ a: 1 }, 'a'), true); assert.equal(has({ a: 1 }, 'b'), false); assert.equal(has({}, 'constructor'), false); assert.equal(has({}, 'toString'), false)
})
