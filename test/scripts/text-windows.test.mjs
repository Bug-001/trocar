// test/scripts/text-windows.test.mjs — spec 1.12 §6.2 (AN14): one normalization for outbound text and capture,
// and the window table that compares the two. Expected values are hand-written normal forms, never the output
// of the code under test; the axes below generate the spellings, so a new spelling is one line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../../scripts/lib/text-windows.mjs'

const utf8 = (s) => Buffer.from(s, 'utf8')
const norm = (input) => Buffer.from(normalize(typeof input === 'string' ? utf8(input) : input)).toString('utf8')

const SAMPLES = [
  ['english', 'The quick brown fox, jumps over 13 lazy dogs!', 'thequickbrownfoxjumpsover13lazydogs'],
  ['chinese', '透明示波器：把每一比特按步回放，逐层拆解。', '透明示波器把每一比特按步回放逐层拆解'],
  ['mixed', 'Café 上下文 v2 / 缓存 ENGINEERING', 'café上下文v2缓存engineering'],
  ['emoji', 'ship it 😀 𠮷野家 🚀 done', 'shipit𠮷野家done'],
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
}
const ENCODING = {
  raw: (s) => s,
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
  assert.equal(norm('ÀÉ ΑΣ Я Ⱥ'), 'àéασяⱥ')
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
