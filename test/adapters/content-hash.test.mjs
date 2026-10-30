import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, hashSpan, spanOf } from '../../src/adapters/content-hash.mjs';
import { scanJson } from '../../src/dissect/json-scan.mjs';

test('contentHash is a stable sha-256 hex of the UTF-8 bytes', () => {
  const h = contentHash('{"k":"v"}');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, contentHash('{"k":"v"}')); // deterministic
});

test('scanJson spans slice the VERBATIM value serialization', () => {
  const doc = '{"tools":[{"name":"a"},{"name":"b"}],"system":"hi","n":42}';
  const root = scanJson(doc);
  assert.equal(root.kind, 'object');
  const tools = root.props.get('tools');
  assert.equal(doc.slice(...spanOf(tools.items[0])), '{"name":"a"}');
  assert.equal(doc.slice(...spanOf(tools.items[1])), '{"name":"b"}');
  assert.equal(doc.slice(...spanOf(root.props.get('system'))), '"hi"');
  assert.equal(doc.slice(...spanOf(root.props.get('n'))), '42');
});

test('D19 moat: key-reorder yields a DIFFERENT content_hash (parse-equal but wire-different)', () => {
  // Two blocks that JSON.parse to deep-equal objects, but differ on the wire.
  const docA = '{"messages":[{"a":1,"b":2}]}';
  const docB = '{"messages":[{"b":2,"a":1}]}';
  const nA = scanJson(docA).props.get('messages').items[0];
  const nB = scanJson(docB).props.get('messages').items[0];
  // A re-serialization (JSON.stringify(JSON.parse(x))) would collapse these to
  // the same hash — masking a json-key-reorder cache-break. Byte-exact must not.
  assert.notEqual(hashSpan(docA, nA), hashSpan(docB, nB));
});

test('D19 moat: whitespace/formatting drift yields a DIFFERENT content_hash', () => {
  const compact = '{"x":[{"k":"v"}]}';
  const spaced = '{"x":[{"k": "v"}]}'; // one extra space after the colon
  const c = scanJson(compact).props.get('x').items[0];
  const s = scanJson(spaced).props.get('x').items[0];
  assert.notEqual(hashSpan(compact, c), hashSpan(spaced, s));
});

test('identical wire bytes yield the SAME content_hash (dedup works)', () => {
  const doc1 = '{"messages":[{"role":"user","content":"hi"}],"model":"x"}';
  const doc2 = '{"model":"y","messages":[{"role":"user","content":"hi"}]}';
  const m1 = scanJson(doc1).props.get('messages').items[0];
  const m2 = scanJson(doc2).props.get('messages').items[0];
  assert.equal(hashSpan(doc1, m1), hashSpan(doc2, m2)); // same block bytes -> same hash across calls
});

test('scanJson handles nested content arrays, escapes, unicode, and negative/float numbers', () => {
  const doc = '{"messages":[{"content":[{"type":"text","text":"a\\"b\\n\\u00e9"},{"type":"tool_use","input":{"n":-1.5e3}}]}]}';
  const root = scanJson(doc);
  const content = root.props.get('messages').items[0].props.get('content');
  assert.equal(content.items.length, 2);
  // the escaped string block slices back to its exact wire form
  const textBlock = content.items[0];
  assert.equal(doc.slice(...spanOf(textBlock)), '{"type":"text","text":"a\\"b\\n\\u00e9"}');
  // the number survives verbatim
  const n = content.items[1].props.get('input').props.get('n');
  assert.equal(doc.slice(...spanOf(n)), '-1.5e3');
});

test('scanJson rejects trailing garbage (never silently mis-parses)', () => {
  assert.throws(() => scanJson('{"a":1} oops'), /trailing content/);
});
