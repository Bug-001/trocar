// test/web-v2/jsonlay.test.mjs — the Raw view's layout pass (spec 2.3 §两种模式, D70 ②):
// the inserted layout lives only in .lay spans, so removing them and un-escaping gives back exactly the stored bytes.
// Generated axes; the strip / tracker helpers below are the test's own reading of the contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { layout } from '../../web/legacy/replay/jsonlay.mjs'

const LAY = /<span class="lay" aria-hidden="true">([^<]*)<\/span>/g
const ENT = { lt: '<', gt: '>', quot: '"', '#39': "'", '#13': '\r', amp: '&' }
const unesc = (s) => s.replace(/&(lt|gt|quot|#39|#13|amp);/g, (_, n) => ENT[n])
const strip = (h) => { const t = h.replace(LAY, ''); assert.ok(!t.includes('<'), 'only .lay elements'); return unesc(t) }
// lay spans as \0…\1 markers (inputs never hold raw \0 / \1: JSON escapes them and the prose has none)
const mark = (h) => unesc(h.replace(LAY, (_, s) => '\u0000' + s + '\u0001'))
const lays = (h) => [...h.matchAll(LAY)].length

let seed = 0x5eed
const r = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(r() * a.length)]
const NUMS = ['-0', '1e+10', '1.5E-3', '0', '-12.5', '3e7', '42']
const BITS = ['\n', '\\n', '\\', '"', '\\"', '\u{1F600}', '\r', '\u0001', '\t', '{', '}', '[', ']', ',', ':', 'a', ' ', 'n', 'A', '<b>&']
const KEYS = ['a', 'k:v', '{,[', 'a"b', '\\n', 'x y']
const str = (nl = true) => {
  let s = ''; for (let n = Math.floor(r() * 8); n--;) s += pick(BITS)
  if (!nl) s = s.replaceAll('\n', '')
  return JSON.stringify(s).replace(/\u{1F600}/gu, () => (r() < 0.5 ? '\\ud83d\\ude00' : '\u{1F600}')).replace(/A/g, () => (r() < 0.5 ? '\\u0041' : 'A'))
}
const ws = () => (r() < 0.8 ? '' : pick([' ', '\n  ', '\r\n', '\t']))
// compact-ish JSON text with exactly `d` levels of nesting below the top
function gen(d) {
  if (d === 0) return r() < 0.15 ? pick(['{}', '[]']) : pick([() => pick(NUMS), () => str(), () => pick(['true', 'null'])])()
  const items = Array.from({ length: Math.floor(r() * 3) }, () => gen(0)); items.splice(Math.floor(r() * (items.length + 1)), 0, gen(d - 1))
  if (r() < 0.5) return '[' + ws() + items.join(ws() + ',' + ws()) + ws() + ']'
  return '{' + ws() + items.map((v) => JSON.stringify(pick(KEYS)) + ws() + ':' + ws() + v).join(',' + ws()) + ws() + '}'
}
const sse = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => `event: e${Math.floor(r() * 9)}${pick(['\n', '\r\n'])}data: ${JSON.stringify(JSON.parse(gen(1 + Math.floor(r() * 3))))}${pick(['\n', '\r\n'])}`).join('\n')
const PROSE = ['', '{', '}', 'hello {world, [x\nfoo {"a":1} bar\n{"a":[1,"\\n"]}\n', 'if (x) { y[0] = "a\\nb" }\n\r\n  [1, 2]\n<tag> & "q"', 'a\nb\n']

const values = Array.from({ length: 160 }, () => gen(Math.floor(r() * 21)))
const pretty = values.map((t) => JSON.stringify(JSON.parse(t), (k, v) => (typeof v === 'string' ? v.replaceAll('\n', '') : v), 2))
const streams = Array.from({ length: 30 }, sse)
const big = ['[' + Array.from({ length: 40000 }, (_, i) => `{"i":${i},"s":"a\\nb"}`).join(',') + ']', '{' + 'x,'.repeat(140000) + '}', 'pre ' + '[1,'.repeat(100000) + '\n{"a":[1]}\n',
  // one line or one string literal far past the budget (a string literal over 256 KB is one JSON value, not prose)
  JSON.stringify('ab\n\u{1F600}'.repeat(70000)), 'x'.repeat(300001), 'k ' + JSON.stringify({ s: 'q\n'.repeat(20000) }) + '\n' + '\u{1F600}'.repeat(30000)]
const CASES = [...values, ...pretty, ...streams, ...PROSE, '{}', '[]', '[[],{}]', ' {"a" : [ ] } ', ...big]

function slices(text, budget) {
  let h = '', at = 0, st = null
  for (;;) {
    const o = layout(text, at, budget, st); h += o.html
    assert.ok((o.next ?? text.length) - at <= budget + 1, 'a slice spans at most the budget (+1: a surrogate pair is never split)')
    if (o.next == null) return h
    assert.ok(o.next > at, 'progress'); at = o.next; st = o.state
  }
}

test('removing the .lay spans and un-escaping gives back the bytes, for every slicing', () => {
  for (const t of CASES) {
    const whole = layout(t, 0, Infinity).html
    assert.equal(strip(whole), t)
    for (const b of t.length > 100000 ? [20000] : [1 + Math.floor(r() * 64), 1 + Math.floor(r() * 64), 20000]) {
      const h = slices(t, b)
      assert.equal(strip(h), t)
      assert.equal(h, whole, 'slices concatenated equal one call over the whole body')
    }
  }
})

test('already-pretty JSON without newline escapes gets no layout', () => {
  for (const t of pretty) assert.equal(lays(layout(t).html), 0, t)
})

test('every \\n escape in a string is followed by a line break; nothing else inside a string is', () => {
  for (const t of [...values, ...streams, ...big.slice(0, 1)]) {
    const m = mark(slices(t, 1 + Math.floor(r() * 64)))
    let s = false, e = false, nl = false, seen = 0
    for (let i = 0; i < m.length; i++) {
      const c = m[i]
      if (c === '\u0000') { const j = m.indexOf('\u0001', i); if (s) assert.ok(nl && m.slice(i + 1, j).includes('\n'), `lay at ${i} in a string`); i = j; nl = false; continue }
      if (nl) assert.fail(`\\n escape at ${i - 1} not followed by a line break`)
      if (!s) { s = c === '"'; continue }
      if (e) { e = false; nl = c === 'n'; seen += nl } else if (c === '\\') e = true; else if (c === '"') s = false
    }
    assert.ok(!nl)
    if (/\\n/.test(t) && !/\\\\n/.test(t)) assert.ok(seen > 0)
  }
})

test('no layout is inserted after a colon', () => {
  for (const t of CASES) assert.ok(!/:<span class="lay"/.test(layout(t, 0, Infinity).html))
})
