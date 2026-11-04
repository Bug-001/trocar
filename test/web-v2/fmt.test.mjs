import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { kf, bytes, enc, esc, usd, clip, preview, fmtDur, base, fmtTime, fmtWhen, fmtStamp, fmtDate, fmtDay, has } from '../../web/legacy/core/fmt.mjs'

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
  assert.equal(preview('  a \n\t b  '), 'a b')
  assert.equal(fmtDur(850), '850ms'); assert.equal(fmtDur(1200), '1.2s'); assert.equal(fmtDur(null), '?')
  assert.equal(base('/a/b/c.txt'), 'c.txt'); assert.equal(base('/a/b/'), 'b')
})

test('preview collapses whitespace and cuts at 90 characters', () => {
  assert.equal(preview('a\n\n  b\t\tc'), 'a b c'); assert.equal(preview(null), ''); assert.equal(preview(undefined), '')
  const cut = preview('word '.repeat(40)); assert.equal(cut, ('word '.repeat(40)).trim().slice(0, 90))
  assert.equal(preview('x'.repeat(90)), 'x'.repeat(90))
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
  assert.equal(fmtWhen(now - 3 * 86400e3, now), fmtStamp(now - 3 * 86400e3, now))
})
// 1.2 §页头 「HH:MM:SS」: a 24 h clock whatever the browser's locale, never AM / PM, midnight 00 and never 24
test('the time format is HH:MM:SS on a 24 h clock, with no AM/PM', () => {
  for (let h = 0; h < 24; h++) {
    const d = new Date(2026, 9, 7, h, 5, 9)
    for (const t of [fmtTime(d), fmtStamp(d)]) {
      assert.ok(t.endsWith(`${String(h).padStart(2, '0')}:05:09`), t)
      assert.ok(!/[ap]\.?m\.?/i.test(t), t)
    }
  }
})

// 1.5 §审美维度 第 8 条: one form per kind — a full time is the date then the clock; the year only when it is not now's
test('a full time is the date and the clock; the date carries the year only in another year', () => {
  for (const [ts, now] of [[new Date(2026, 9, 18, 8, 0, 52), new Date(2026, 10, 3)], [new Date(2025, 9, 18, 8, 0, 52), new Date(2026, 0, 2)], [new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 11, 31)]]) {
    assert.equal(fmtStamp(ts, now), `${fmtDate(ts, now)}, ${fmtTime(ts)}`)
    assert.equal(fmtDate(ts, now).includes(String(ts.getFullYear())), ts.getFullYear() !== now.getFullYear(), fmtDate(ts, now))
    assert.ok(!/\d+\/\d+|\d{4}-\d{2}/.test(fmtDate(ts, now)), 'a date is the month word and the day, never 10/18 or 2026-10-18')
  }
  assert.equal(fmtDate('', 0), '—'); assert.equal(fmtDate('junk', 0), '—'); assert.equal(fmtStamp('junk', 0), 'junk')
})
test('fmtDay: today and yesterday as words, the days of this week as a distance, older ones as the date', () => {
  const now = new Date(2026, 10, 3, 12)
  const day = (k) => new Date(2026, 10, 3 - k, 9)
  assert.notEqual(fmtDay(day(0), now), fmtDay(day(1), now))
  for (let k = 2; k < 7; k++) assert.ok(fmtDay(day(k), now).includes(String(k)), fmtDay(day(k), now))
  for (const k of [7, 30, 400]) assert.equal(fmtDay(day(k), now), fmtDate(day(k), now))
  assert.equal(fmtDay(null, now), '—')
})
test('no file of the front end but core/fmt.mjs formats a date itself', () => {
  const web = path.join(import.meta.dirname, '../../web')
  const own = path.join(web, 'legacy/core/fmt.mjs')
  const re = /Intl\.DateTimeFormat|toLocale(?:Date|Time)String|toTimeString\(|toLocaleString\([^)]*\{[^}]*(?:month|hour|weekday)/
  const files = fs.readdirSync(web, { recursive: true }).map((f) => path.join(web, f)).filter((f) => /(?<!\.test)\.(mjs|ts|tsx)$/.test(f) && !f.includes('node_modules'))
  const bad = files.filter((f) => f !== own && re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(web, f))
  assert.deepEqual(bad, [])
  assert.ok(re.test(fs.readFileSync(own, 'utf8')), 'the scan sees the one formatter (not vacuous)')
})

test('has: own keys only (a code like "constructor" is not in a lookup table)', () => {
  assert.equal(has({ a: 1 }, 'a'), true); assert.equal(has({ a: 1 }, 'b'), false); assert.equal(has({}, 'constructor'), false); assert.equal(has({}, 'toString'), false)
})
