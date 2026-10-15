// test/off/json-text.test.mjs — minimal, verified text edits of one JSON key (4.6 「标记与安装」: JSON 按 JSONC 读写). The shape cases come from
// test/helpers/file-shapes.mjs (spec 0.1 G2's JSON axis: style, indentation, mark, line endings, empty and blank); what a document means is read
// by that generator's own JSONC reader, never by src/.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setKey, removeKey, addItem, removeItem, reverseOps, applyOps, scanJson, parseJsonText, getPath } from '../../src/off/json-text.mjs'
import { shapeCases, readJsonc } from '../helpers/file-shapes.mjs'

const K = ['env', 'CA_FILE']
const SETTINGS = '{\n    "model": "x",\n    "env": {\n        "A": "1"\n    },\n    "hooks": [1, {"b": null}]\n}\n'

test('json-text: a new key goes first in the existing object with its indentation; nothing else moves', () => {
  const r = setKey(SETTINGS, K, '/h/.asight/collector/ca/asight-ca.pem')
  assert.equal(r.text, '{\n    "model": "x",\n    "env": {\n        "CA_FILE": "/h/.asight/collector/ca/asight-ca.pem",\n        "A": "1"\n    },\n    "hooks": [1, {"b": null}]\n}\n')
  assert.deepEqual([r.ops.length, r.ops[0].removed, r.prior, r.existingDepth], [1, '', null, 1])
  assert.equal(reverseOps(r.text, r.ops), SETTINGS)
})

test('json-text: an existing value is replaced in place and returned as prior', () => {
  const t = '{"env":{"CA_FILE":"/etc/corp.pem","B":"2"}}'
  const r = setKey(t, K, '/h/x.pem')
  assert.equal(r.text, '{"env":{"CA_FILE":"/h/x.pem","B":"2"}}')
  assert.deepEqual([r.prior, r.ops[0].removed, r.ops[0].inserted], ['/etc/corp.pem', '"/etc/corp.pem"', '"/h/x.pem"'])
})

test('json-text: a missing parent object is created inline; an empty object and an absent file work', () => {
  assert.equal(setKey('{\n  "model": "x"\n}', K, '/v').text, '{\n  "env": { "CA_FILE": "/v" },\n  "model": "x"\n}')
  assert.equal(setKey('{}', K, '/v').text, '{"env": { "CA_FILE": "/v" }}')
  const fresh = setKey(null, K, '/v')
  assert.equal(fresh.text, '{\n  "env": {\n    "CA_FILE": "/v"\n  }\n}\n')
  assert.deepEqual([fresh.ops[0].offset, fresh.existingDepth, reverseOps(fresh.text, fresh.ops)], [0, 0, ''])
})

test('json-text: duplicate keys follow JSON.parse (last wins); escapes in strings are handled', () => {
  const r = setKey('{"env":{"CA_FILE":"/a"},"env":{"CA_FILE":"/b\\"q"}}', K, '/c')
  assert.equal(r.prior, '/b"q')
  assert.equal(JSON.parse(r.text).env.CA_FILE, '/c')
})

test('json-text: refuses non-JSON, a non-object document, a non-object parent and a non-writable value; a scalar the key already held is replaced (4.8 s2.4 spells booleans without quotes)', () => {
  assert.throws(() => setKey('{ nope', K, '/v'), (e) => /not valid JSON/.test(e.message) && e.why === 'not-json' && e.offset === 2)
  assert.throws(() => setKey('{"a":1} x', K, '/v'), (e) => /not valid JSON/.test(e.message) && e.why === 'not-json' && e.offset === 8)
  assert.throws(() => setKey('[1]', K, '/v'), (e) => /not a JSON object/.test(e.message) && e.why === 'not-object')
  assert.throws(() => setKey('{"env":"x"}', K, '/v'), (e) => /env is not an object \(it is a string\): delete that member or make it \{\}/.test(e.message) && e.why === 'not-object')
  assert.throws(() => setKey('{"env":null}', K, '/v'), (e) => /env is not an object \(it is null\)/.test(e.message) && e.why === 'not-object')
  assert.throws(() => setKey('{"env":{"CA_FILE":{"deep":1}}}', K, '/v'), (e) => /not a value asight can replace/.test(e.message) && e.why === 'value')
  assert.throws(() => setKey('{"env":{}}', K, 3), /must be a string, a boolean or null/)
  const num = setKey('{"env":{"CA_FILE":3}}', K, '/v')
  assert.deepEqual([num.prior, JSON.parse(num.text).env.CA_FILE], [3, '/v'], 'a number the key held is replaced, and the prior comes back as the number it was')
  const bool = setKey('{"http": {"systemCertificates": true}}', ['http', 'systemCertificates'], false)
  assert.equal(bool.text, '{"http": {"systemCertificates": false}}', 'a boolean is spelled without quotes, a minimal splice')
  assert.equal(bool.prior, true)
})

test('json-text: removeKey drops the member and one comma; first, middle, last and only member', () => {
  assert.equal(removeKey('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}', ['a']).text, '{\n  "b": 2,\n  "c": 3\n}')
  assert.equal(removeKey('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}', ['b']).text, '{\n  "a": 1,\n  "c": 3\n}')
  assert.equal(removeKey('{\n  "a": 1,\n  "b": 2\n}', ['b']).text, '{\n  "a": 1\n}')
  assert.equal(removeKey('{"env":{"CA_FILE":"/v"}}', K).text, '{"env":{}}')
  assert.equal(removeKey('{"env":{}}', K), null)
})

test('json-text: reverseOps refuses text that no longer holds what was inserted', () => {
  const r = setKey(SETTINGS, K, '/v')
  assert.equal(reverseOps(r.text.replace('"/v"', '"/w"'), r.ops), null)
  assert.equal(applyOps(SETTINGS, r.ops), r.text)
  assert.equal(scanJson(' {"a": [1, 2.5e3, true, null, "s"]} ').type, 'object')
})

// ---- JSONC: a mark, comments, trailing commas, no document ----------------------------------------------------------------------------------
// The comments of a text in order (outside strings): asight writes none and drops none.
const commentsOf = (t) => {
  const out = []
  for (let i = 0; i < t.length;) {
    if (t[i] === '"') { i++; while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1; i++ } else if (t.startsWith('//', i)) { let e = i; while (e < t.length && t[e] !== '\n' && t[e] !== '\r') e++; out.push(t.slice(i, e)); i = e } else if (t.startsWith('/*', i)) { const e = t.indexOf('*/', i + 2) + 2; out.push(t.slice(i, e)); i = e } else i++
  }
  return out
}
const meaning = (t) => readJsonc(t) ?? {} // the generator's reader; no document reads as {}
const withKey = (v, keys, value) => { const o = structuredClone(v); let cur = o; for (const k of keys.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k] } cur[keys.at(-1)] = value; return o }
const tag = (c) => `${c.id} seed=${c.seed} ${c.describe}${c.bom ? ' +mark' : ''}`
const EDITS = [[K, '/h/.asight/collector/ca/asight-ca.pem'], [['env', 'HTTPS_PROXY'], 'http://127.0.0.1:9'], [['asightTop'], true]]

test('json-text: along the JSON axis (strict, comments, trailing commas, indentation, mark, CRLF, empty, blank) setKey changes only the key, keeps every comment and the mark, and reverseOps gives every byte back; removeKey takes it out again', () => {
  const cases = shapeCases({ format: 'json', budget: 150 }).filter((c) => c.determinable)
  const seen = new Set()
  for (const c of cases) {
    const t = (c.bom ? '﻿' : '') + c.text // the text as text-codec.mjs hands it over: a mark stays as U+FEFF at offset 0
    seen.add(`style=${c.style}`).add(`eol=${c.eol}`).add(`mark=${!!c.bom}`).add(`content=${c.content}`).add(`indent=${c.indent}`)
    if (c.content === 'env-null' || c.content === 'env-string') {
      assert.throws(() => setKey(t, K, '/v'), (e) => e.why === 'not-object' && /env is not an object/.test(e.message), tag(c))
      continue
    }
    assert.deepEqual(parseJsonText(t), readJsonc(t), `parseJsonText reads what the generator wrote: ${tag(c)}`)
    for (const [keys, value] of EDITS) {
      const r = setKey(t, keys, value)
      assert.equal(r.ops.length, 1, tag(c))
      assert.equal(reverseOps(r.text, r.ops), t, `byte for byte back: ${tag(c)}`)
      assert.deepEqual(meaning(r.text), withKey(meaning(t), keys, value), `only ${keys.join('.')} changed: ${tag(c)}`)
      assert.deepEqual(commentsOf(r.text), commentsOf(t), `every comment kept, none written: ${tag(c)}`)
      assert.equal(r.text.startsWith('﻿'), t.startsWith('﻿'), `the mark stays first: ${tag(c)}`)
      if (r.prior != null) continue
      let out = removeKey(r.text, keys).text
      for (let d = keys.length - 1; d > r.existingDepth; d--) { const v = getPath(parseJsonText(out), keys.slice(0, d)); if (v && !Object.keys(v).length) out = removeKey(out, keys.slice(0, d)).text }
      assert.deepEqual(meaning(out), meaning(t), `removeKey takes back only what setKey added: ${tag(c)}`)
      assert.deepEqual(commentsOf(out), commentsOf(t), `removeKey keeps every comment: ${tag(c)}`)
    }
  }
  for (const want of ['style=strict', 'style=line-comments', 'style=block-comments', 'style=trailing-commas', 'style=all', 'eol=lf', 'eol=crlf', 'eol=mixed', 'mark=true', 'mark=false', 'content=empty', 'content=blank', 'content=env-object', 'content=no-env', 'indent=0', 'indent=\t']) assert.ok(seen.has(want), `the cases cover ${want}`)
})

test('json-text: a mark at offset 0 is read past and stays first; a mark anywhere else is not JSON', () => {
  assert.deepEqual(parseJsonText('﻿{"a":1}'), { a: 1 })
  assert.equal(setKey('﻿{"a":1}', ['b'], 'x').text, '﻿{"b": "x","a":1}')
  assert.equal(removeKey('﻿{"b": "x","a":1}', ['b']).text, '﻿{"a":1}')
  for (const t of ['{"a":1}﻿', ' ﻿{}', '﻿﻿{}']) assert.throws(() => parseJsonText(t), (e) => e.why === 'not-json' && Number.isInteger(e.offset), JSON.stringify(t))
})

test('json-text: a new first member is led by white space only: a comment in front of the old first member is not copied, it stays with it', () => {
  assert.equal(setKey('{\n  // about a\n  "a": 1\n}', ['b'], 'x').text, '{\n  "b": "x",\n  // about a\n  "a": 1\n}')
  assert.equal(setKey('{ // top\n  "a": 1\n}', ['b'], 'x').text, '{\n  "b": "x", // top\n  "a": 1\n}')
  assert.equal(setKey('{\r\n  /* c */ "a": 1\r\n}', ['b'], 'x').text, '{\r\n  "b": "x",\r\n  /* c */ "a": 1\r\n}')
  assert.equal(setKey('{ /* c */ "a": 1 }', ['b'], 'x').text, '{ "b": "x", /* c */ "a": 1 }')
  assert.equal(setKey('{ /* only */ }', ['b'], 'x').text, '{"b": "x" /* only */ }')
})

test('json-text: trailing commas — an insert or a removal never makes ",," and a trailing comma stays the user\'s', () => {
  assert.equal(setKey('{\n  "a": 1,\n}', ['b'], 'x').text, '{\n  "b": "x",\n  "a": 1,\n}')
  assert.equal(setKey('{"env":{"A":"1",},}', K, '/v').text, '{"env":{"CA_FILE": "/v","A":"1",},}')
  assert.deepEqual(parseJsonText('{"a":[1,2,],"b":{},}'), { a: [1, 2], b: {} })
  assert.equal(removeKey('{\n  "a": 1,\n  "b": 2,\n}', ['b']).text, '{\n  "a": 1,\n}')
  assert.equal(removeKey('{\n  "a": 1,\n  "b": 2,\n}', ['a']).text, '{\n  "b": 2,\n}')
  assert.equal(removeKey('{"a": 1,}', ['a']).text, '{}')
  assert.equal(removeKey('{\n  "a": 1\n}', ['a']).text, '{}')
  for (const t of ['{"a":1,,}', '{,}', '[,]', '[1,,2]', '{"a":1 "b":2}']) assert.throws(() => parseJsonText(t), (e) => e.why === 'not-json', t)
})

test('json-text: removeKey keeps the user\'s comments around the member, and a line comment keeps the line break that ends it', () => {
  const t = '{\n  "a": 1, // note a\n  // about b\n  "b": 2\n}'
  assert.equal(removeKey(t, ['a']).text, '{ // note a\n  // about b\n  "b": 2\n}')
  assert.equal(removeKey(t, ['b']).text, '{\n  "a": 1 // note a\n  // about b\n}')
  assert.equal(removeKey('{"x":1, // c\n"a":1}', ['a']).text, '{"x":1 // c\n}')
  assert.equal(removeKey('{"a": 1, "b": 2}', ['a']).text, '{"b": 2}')
  assert.equal(removeKey('{"a": 1, "b": 2}', ['b']).text, '{"a": 1}')
  assert.equal(removeKey('{ /* keep */ "a": 1 }', ['a']).text, '{ /* keep */ }')
})

test('json-text: no document (empty, blank, a mark, comments) — the new object goes after what is there in one op, in the text\'s line ending, and undoing it gives every byte back', () => {
  const doc = (eol) => `{${eol}  "env": {${eol}    "CA_FILE": "/v"${eol}  }${eol}}${eol}`
  for (const [t, want] of [['', doc('\n')], ['  \n', `  \n${doc('\n')}`], ['\r\n\t\r\n', `\r\n\t\r\n${doc('\r\n')}`], ['﻿', `﻿${doc('\n')}`], ['// only', `// only\n${doc('\n')}`], ['/* c */', `/* c */${doc('\n')}`]]) {
    assert.equal(parseJsonText(t), undefined, JSON.stringify(t))
    assert.equal(removeKey(t, K), null, JSON.stringify(t))
    const r = setKey(t, K, '/v')
    assert.equal(r.text, want, JSON.stringify(t))
    assert.deepEqual([r.ops.length, r.ops[0].offset, r.prior, r.existingDepth, reverseOps(r.text, r.ops)], [1, t.length, null, 0, t], JSON.stringify(t))
  }
  assert.throws(() => parseJsonText('/* open'), (e) => e.why === 'not-json' && e.offset === 0)
})

test('json-text: parseJsonText reads as JSON.parse does — duplicate keys (first place, last value), __proto__ as an own key, numbers, escapes; refuses what JSON refuses', () => {
  for (const t of ['{"__proto__": {"x": 1}, "a": 1, "b": [true, null, -0.5e3, "\\u00e9\\n"], "a": 2}', '"s"', '[]', '0']) assert.deepEqual(parseJsonText(t), JSON.parse(t), t)
  for (const t of ['{"a":01}', '{"a":.5}', '{"a":"x\ny"}', "{'a':1}", '{a:1}', '{"a":1}}', 'nul']) assert.throws(() => parseJsonText(t), (e) => e.why === 'not-json' && Number.isInteger(e.offset), t)
})

test('json-text addItem (4.11 P5 arrayItems): along the JSON axis an element is appended (the array made when missing), only it changes, every comment and the mark stay, reverseOps gives every byte back and removeItem takes it out; an equal element is not added twice; a non-array is refused', () => {
  const keys = ['settingsSync.ignoredSettings']
  const withItem = (v, item) => { const o = structuredClone(v ?? {}); o[keys[0]] = [...(o[keys[0]] || []), item]; return o }
  for (const c of shapeCases({ format: 'json', budget: 150 }).filter((x) => x.determinable)) {
    const t = (c.bom ? '﻿' : '') + c.text
    let cur = t
    for (const item of ['http.proxy', 'editor.fontSize']) {
      const r = addItem(cur, keys, item)
      assert.equal(r.createdArray, cur === t, tag(c))
      assert.equal(reverseOps(r.text, r.ops), cur, `byte for byte back: ${tag(c)}`)
      assert.deepEqual(meaning(r.text), withItem(meaning(cur), item), `only the element added: ${tag(c)}`)
      assert.deepEqual(commentsOf(r.text), commentsOf(t), `every comment kept: ${tag(c)}`)
      assert.equal(r.text.startsWith('﻿'), t.startsWith('﻿'), tag(c))
      assert.equal(addItem(r.text, keys, item), null, `already there: nothing to add: ${tag(c)}`)
      cur = r.text
    }
    assert.deepEqual(meaning(removeItem(cur, keys, 'editor.fontSize').text), withItem(meaning(t), 'http.proxy'), tag(c))
  }
  assert.throws(() => addItem('{"a": "x"}', ['a'], 'y'), (e) => e.why === 'not-array')
})
