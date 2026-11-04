// scanJson's spans are what a text_ref points at and what content_hash hashes (src/dissect/json-scan.mjs): every node's
// [start, end) must slice exactly the wire serialization of that value. Texts are generated along the axes that a
// string/key scanner can get wrong — escapes (\" \\ \uXXXX, a quote after an even or odd run of backslashes), escaped
// and plain keys, nesting, whitespace, non-ASCII, long strings — and the invariant is checked at every path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanJson } from '../../src/dissect/json-scan.mjs'

// a small deterministic PRNG: the same texts every run
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }

const PIECES = ['a', '"', '\\', '\\"', '\\\\"', '\\\\\\"', '/', '\n', '\t', 'é', '中文', '😀', '\u0001', ' ', 'x'.repeat(4096), '\\'.repeat(5)]
const WS = ['', ' ', '\n', '\t', ' \r\n  ']

function gen(r, depth) {
  const pick = (a) => a[Math.floor(r() * a.length)]
  const str = () => Array.from({ length: Math.floor(r() * 5) }, () => pick(PIECES)).join('')
  const k = r()
  if (depth <= 0 || k < 0.35) return pick([() => str(), () => Math.floor(r() * 1e6) / 100, () => true, () => false, () => null, () => -3e-7])()
  if (k < 0.65) return Array.from({ length: Math.floor(r() * 4) }, () => gen(r, depth - 1))
  const o = {}
  for (let n = Math.floor(r() * 4); n > 0; n--) o[pick([str, () => pick(['plain', 'key', '0', '12'])])()] = gen(r, depth - 1)
  return o
}

// JSON with arbitrary whitespace and with characters escaped the ways JSON.stringify never does (\uXXXX, \/)
function ser(v, r) {
  const ws = () => WS[Math.floor(r() * WS.length)]
  const s = (x) => '"' + (JSON.stringify(x).slice(1, -1).match(/\\u[0-9a-f]{4}|\\.|[^]/gu) || []).map((c) =>
    c === '/' && r() < 0.5 ? '\\/' : /^[a-zé中]$/.test(c) && r() < 0.2 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('') + '"'
  if (typeof v === 'string') return s(v)
  if (Array.isArray(v)) return '[' + ws() + v.map((x) => ws() + ser(x, r) + ws()).join(',') + ws() + ']'
  if (v && typeof v === 'object') return '{' + ws() + Object.keys(v).map((key) => ws() + s(key) + ws() + ':' + ws() + ser(v[key], r) + ws()).join(',') + ws() + '}'
  return JSON.stringify(v)
}

function check(text, node, value, at) {
  assert.deepEqual(JSON.parse(text.slice(node.start, node.end)), value, `span at ${at}`)
  if (node.kind === 'object') {
    assert.deepEqual([...node.props.keys()].sort(), Object.keys(value).sort(), `keys at ${at}`)
    for (const [key, n] of node.props) check(text, n, value[key], `${at}.${JSON.stringify(key)}`)
  } else if (node.kind === 'array') {
    assert.equal(node.items.length, value.length, `items at ${at}`)
    node.items.forEach((n, i) => check(text, n, value[i], `${at}[${i}]`))
  }
}

test('every node span slices exactly its value, and object nodes carry exactly the parsed keys', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed)
    const text = WS[seed % WS.length] + ser(gen(r, 1 + (seed % 5)), r) + WS[(seed >> 2) % WS.length]
    check(text, scanJson(text), JSON.parse(text), `seed ${seed}`)
  }
})

test('a string with no closing quote still throws', () => {
  for (const bad of ['"abc', '"abc\\"', '"a\\\\\\"', '{"k\\":1}', '["x\\\\\\"]', '{"a":"b', '"'])
    assert.throws(() => scanJson(bad), undefined, bad)
})

test('a repeated key: props keeps what JSON.parse keeps, shadowed the values it hid, and an object with none has no such field', () => {
  const text = '{"a":1,"b":{"c":2},"a":"x","a":[3]}'
  const root = scanJson(text)
  assert.deepEqual(JSON.parse(text.slice(root.props.get('a').start, root.props.get('a').end)), JSON.parse(text).a)
  assert.deepEqual(root.shadowed.map((n) => text.slice(n.start, n.end)), ['1', '"x"'])
  assert.equal('shadowed' in root.props.get('b'), false)
})
