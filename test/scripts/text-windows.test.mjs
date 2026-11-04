// test/scripts/text-windows.test.mjs — spec 1.12 §6.2 (AN14): one normalization for outbound text and capture,
// and the window table that compares the two. Expected values are hand-written normal forms, never the output
// of the code under test; the axes below generate the spellings, so a new spelling is one line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WINDOW, normalize, WindowTable } from '../../scripts/lib/text-windows.mjs'

const utf8 = (s) => Buffer.from(s, 'utf8')
const norm = (input) => Buffer.from(normalize(typeof input === 'string' ? utf8(input) : input)).toString('utf8')

const SAMPLES = [
  ['english', 'The quick brown fox, jumps over 13 lazy dogs!', 'thequickbrownfoxjumpsover13lazydogs'],
  ['chinese', '透明示波器：把每一比特按步回放，逐层拆解。', '透明示波器把每一比特按步回放逐层拆解'],
  ['mixed', 'Café 上下文 v2 / 缓存 ENGINEERING', 'cafe上下文v2缓存engineering'],
  ['emoji', 'ship it 😀 𠮷野家 🚀 done', 'shipit𠮷野家done'],
  ['accents', 'Résumé naïve Ångström déjà vu', 'resumenaiveangstromdejavu'],
]

const fullEscape = (s) => [...Array(s.length).keys()]
  .map((i) => `\\u${s.charCodeAt(i).toString(16).padStart(4, '0')}`).join('')
const json = (s) => JSON.stringify(s)
const between = (s, sep, every = 1) => [...s].map((c, i) => (i % every === every - 1 ? c + sep : c)).join('')

const SURFACE = {
  plain: (s) => s,
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  newlines: (s) => between(s, '\n', 7),
  crlf: (s) => between(s, '\r\n', 5),
  tabs: (s) => between(s, '\t', 3),
  punctuation: (s) => between(s, '.,;:!?"\'/()[]{}-_ '),
  fullwidth: (s) => s.replace(/[!-~]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0)),
  nfc: (s) => s.normalize('NFC'),
  nfd: (s) => s.normalize('NFD'),
}
const codePoints = (s, each) => [...s].map((c) => each(c.codePointAt(0))).join('')
const ENCODING = {
  raw: (s) => s,
  percent: (s) => encodeURIComponent(s),
  'percent, every byte': (s) => [...utf8(s)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''),
  'percent, then json': (s) => json(encodeURIComponent(s)),
  'decimal references': (s) => codePoints(s, (cp) => `&#${cp};`),
  'hex references': (s) => codePoints(s, (cp) => `&#x${cp.toString(16)};`),
  'bare references': (s) => codePoints(s, (cp) => `&#${cp} `),
  '\\u{}': (s) => codePoints(s, (cp) => `\\u{${cp.toString(16)}}`),
  '\\x where it fits': (s) => codePoints(s, (cp) => (cp < 0x100 ? `\\x${cp.toString(16).padStart(2, '0')}` : String.fromCodePoint(cp))),
  'json once': json,
  'json twice': (s) => json(json(s)),
  'full \\u': fullEscape,
  'json then \\u': (s) => fullEscape(json(s)),
  '\\u then json': (s) => json(fullEscape(s)),
  '\\u then json twice': (s) => json(json(fullEscape(s))),
}

test('AN14: every spelling of a text normalizes to the same bytes', () => {
  for (const [name, text, expected] of SAMPLES) {
    for (const [surface, edit] of Object.entries(SURFACE)) {
      for (const [encoding, encode] of Object.entries(ENCODING)) {
        const got = normalize(utf8(encode(edit(text))))
        assert.ok(utf8(expected).equals(Buffer.from(got)), `${name} / ${surface} / ${encoding}: ${Buffer.from(got)}`)
      }
    }
  }
})

test('AN14: backslash rules on hand-computed samples', () => {
  const cases = [
    ['a\\nb\\tc\\rd\\"e\\/f', 'abcdef'],
    ['a\\\\nb', 'ab'],
    ['a\\\\\\"b', 'ab'],
    ['\\\\u4e2d文', '中文'],
    ['\\\\\\\\u4E2D', '中'],
    ['a\\u005c\\u006eb', 'ab'],
    ['a\\u005cnb', 'ab'],
    ['\\q\\,x', 'qx'],
    ['\\u12', 'u12'],
    ['\\uZZZZ', 'uzzzz'],
    ['tail\\', 'tail'],
    ['C:\\temp\\new', 'cempew'],
  ]
  for (const [input, expected] of cases) assert.equal(norm(input), expected, input)
})

test('AN14: what looks like an escape and is not stays as it is', () => {
  const cases = [
    ['100%ab', '100ab'],
    ['%E4%B8%AD文', '中文'],
    ['%e4%b8', 'e4b8'],
    ['%E4%B8x', 'e4b8x'],
    ['50%zz', '50zz'],
    ['tail%', 'tail'],
    ['tail%4', 'tail4'],
    ['a%5Cnb', 'ab'],
    ['a&nbsp;b&amp;c&#32;d&#x20;e', 'abcde'],
    ['a&b;c', 'abc'],
    ['AT&T and R&D', 'attandrd'],
    ['&#xZZ;', 'xzz'],
    ['&#;', ''],
    ['&#1114112;', '1114112'],
    ['\\x4', 'x4'],
    ['\\xZZ', 'xzz'],
    ['\\u{}', 'u'],
    ['\\u{110000}', 'u110000'],
    ['\\x5cnb', 'b'],
  ]
  for (const [input, expected] of cases) assert.equal(norm(input), expected, input)
})

test('AN14: surrogate pairs join into one code point, lone halves vanish', () => {
  const cases = [
    ['\\ud842\\udfb7', '𠮷'],
    ['\\\\ud842\\\\udfb7', '𠮷'],
    ['\\ud83d\\ude00', ''],
    ['a\\ud83db', 'ab'],
    ['a\\ude00b', 'ab'],
    ['\\ud842\\n\\udfb7', ''],
    ['a\\ud842', 'a'],
  ]
  for (const [input, expected] of cases) assert.equal(norm(input), expected, input)
})

test('AN14: lowercase keeps the first code point, other scripts stay letters', () => {
  assert.equal(norm('\u0130'), 'i')
  assert.equal(norm('ÀÉ ΑΣ Я Ⱥ'), 'aeασяⱥ')
  assert.equal(norm('Ｆｕｌｌ１２'), 'full12')
  assert.equal(norm('Å K'), 'ak', 'the Angstrom and Kelvin signs')
  assert.equal(norm('한글'.normalize('NFD')), norm('한글'.normalize('NFC')))
  assert.equal(norm('٣४'), '٣४')
})

test('AN14: bad UTF-8 is dropped byte by byte, never thrown', () => {
  const bytes = Uint8Array.from([
    0x61, 0xff, 0x62, // stray byte
    0xc0, 0x80, // overlong NUL
    0xed, 0xa0, 0x80, // encoded surrogate
    0xf4, 0x90, 0x80, 0x80, // past U+10FFFF
    0x63, 0x80, 0x64, // stray continuation
    0xe4, 0xb8, // truncated at the end
  ])
  assert.equal(norm(bytes), 'abcd')
  assert.equal(normalize(new Uint8Array(0)).length, 0)
})

// `count` distinct letters from a seeded generator: runs of it share no window with anything else by chance.
function letters(seed, count, alphabet = 'abcdefghijklmnoprsuvwxyz') {
  let x = seed >>> 0
  let out = ''
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out += alphabet[(x >>> 8) % alphabet.length]
  }
  return out
}
const hits = (table, bytes) => {
  const slots = []
  table.scan(typeof bytes === 'string' ? utf8(bytes) : bytes, (slot) => slots.push(slot))
  return slots
}
const tableOf = (...texts) => new WindowTable(texts.map((t, i) => ({ where: `s${i}`, bytes: utf8(t) })))

test('AN14: a shared run hits from exactly one window up, in bytes', () => {
  assert.equal(WINDOW, 60)
  const common = {
    ascii: (n) => letters(7, n),
    // 19 hanzi are 57 bytes: the ASCII tail decides, so the count is in bytes, not characters.
    cjk: (n) => `上下文缓存工程透明示波器按步回放逐层拆${letters(9, n - 57)}`,
  }
  for (const [kind, make] of Object.entries(common)) {
    for (const [length, hit] of [[WINDOW - 1, false], [WINDOW, true], [WINDOW + 1, true]]) {
      const run = make(length)
      assert.equal(utf8(run).length, length, kind)
      assert.equal(hits(tableOf(`q${run}q`), `t${run}t`).length > 0, hit, `${kind} ${length}`)
    }
  }
})

test('AN14: windows do not cross sources', () => {
  const run = letters(11, 80)
  const [a, b] = [run.slice(0, 40), run.slice(40)]
  assert.equal(hits(tableOf(a, b), run).length, 0)
  assert.ok(hits(tableOf(a + b), run).length > 0)
})

test('AN14: both sides go through the same function', () => {
  const text = `${letters(13, 40)} 上下文缓存工程透明示波器 ${letters(17, 40)}`
  const table = new WindowTable([{ where: 'x', bytes: utf8(JSON.stringify(JSON.stringify(text))) }])
  assert.ok(hits(table, fullEscape(text.toUpperCase())).length > 0)
})

test('AN14: a dropped window never hits again and leaves the rest', () => {
  const run = letters(19, WINDOW + 1)
  const table = tableOf(run)
  assert.equal(table.size, 2)
  const first = hits(table, run)
  assert.equal(new Set(first).size, 2)
  table.drop(first[0])
  assert.equal(table.size, 1)
  assert.deepEqual(hits(table, run), [first[1]])
  // dropping from inside the callback is how the caller walks: each window reports once
  const again = tableOf(run)
  let seen = 0
  for (let pass = 0; pass < 2; pass++) again.scan(utf8(run + run), (slot) => { seen++; again.drop(slot) })
  assert.equal(seen, 2)
  assert.equal(again.size, 0)
})

test('AN14: identical windows share a slot, owned by the first source', () => {
  const run = letters(23, WINDOW)
  const other = letters(29, WINDOW)
  const table = new WindowTable([
    { where: 'short', bytes: utf8('tiny') },
    { where: 'first', bytes: utf8(run) },
    { where: 'second', bytes: utf8(`${other}\n\n${run}`) },
    { where: 'third', bytes: utf8(run) },
  ])
  const [slot] = hits(table, run)
  assert.equal(table.whereOf(slot), 'first')
  assert.equal(table.whereOf(hits(table, other)[0]), 'second')
  table.drop(slot)
  assert.equal(hits(table, run).length, 0)
})

test('AN14: equal 32-bit hashes never count as a hit', () => {
  // 3e5 windows on each side: about twenty cross pairs share a 32-bit hash, so only the byte check keeps this empty.
  const size = 300_000
  const left = letters(31, size + WINDOW - 1)
  const right = letters(37, size + WINDOW - 1)
  const table = tableOf(left)
  assert.equal(table.size, size)
  assert.equal(hits(table, right).length, 0)
  assert.equal(new Set(hits(table, left)).size, size)
})

test('AN14: NUL and bad UTF-8 in scanned bytes do not throw and do not hide a run', () => {
  const run = utf8(letters(41, WINDOW))
  const noisy = Buffer.concat([Buffer.from([0xff, 0]), run.subarray(0, 30), Buffer.from([0, 0xc0]), run.subarray(30), Buffer.from([0xe4])])
  assert.ok(hits(tableOf(run.toString()), noisy).length > 0)
  assert.equal(hits(tableOf(''), noisy).length, 0)
  assert.equal(new WindowTable([]).size, 0)
})
