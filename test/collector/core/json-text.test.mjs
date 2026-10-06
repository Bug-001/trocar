// test/collector/core/json-text.test.mjs — minimal, verified text edits of one JSON key (4.6 「标记与安装」).
import test from 'node:test'
import assert from 'node:assert/strict'
import { setKey, removeKey, reverseOps, applyOps, scanJson } from '../../../src/collector/core/trust/json-text.mjs'

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

test('json-text: refuses non-JSON, a non-object document, a non-object parent and a non-string value', () => {
  assert.throws(() => setKey('{ nope', K, '/v'), /not valid JSON/)
  assert.throws(() => setKey('{"a":1} x', K, '/v'), /not valid JSON/)
  assert.throws(() => setKey('[1]', K, '/v'), /not a JSON object/)
  assert.throws(() => setKey('{"env":"x"}', K, '/v'), /env is not an object/)
  assert.throws(() => setKey('{"env":{"CA_FILE":3}}', K, '/v'), /not a string/)
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
