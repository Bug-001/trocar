// test/query/source-field.test.mjs — the resolver slices the field a text_ref names (RFC 4.2:40 字段段, gate G1).
// Each expectation is read straight off the record that was written, never through the resolver itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';
import { composeTextRef, mintRawRef } from '../../src/raw/refs.mjs';

const FILE = 'capture-2026-10-06.ndjson';
const raw = (id) => mintRawRef('S', FILE, id);
const SSE = 'event: message_start\ndata: {"type":"message_start","é":1}\n\n: comment kept\n\n';
const MSGS = ['{"type":"response.created"}', '{"type":"response.completed","response":{"id":"r1","output":[{"type":"message"}]}}', { b64: 'AAEC' }, { omitted_bytes: 9 }];
const RECORDS = [
  { id: 'h1', req_body: '{"x": 1}', resp: { kind: 'sse', status: 200, headers: {}, raw: SSE } },
  { id: 'w1', req_body: '{"type":"response.create"}', transport: 'ws', ws_ext: 'permessage-deflate',
    req_extra_messages: ['{"type":"response.interrupt"}', { b64: 'AA==' }], resp: { kind: 'ws', messages: MSGS } },
  // a call cut before its terminal message: its server messages sit under resp.partial (4.6 §传输与帧级记录)
  { id: 'e1', req_body: '{"type":"response.create"}', transport: 'ws', error: true,
    resp: { status: null, kind: 'error', error: { type: 'ws_closed' }, partial: { kind: 'ws', messages: ['{"type":"response.created","n":1}'] } } },
  // an interrupted HTTP SSE response: what arrived is under resp.partial
  { id: 'e2', req_body: '{}', error: true, resp: { status: null, kind: 'error', partial: { kind: 'sse', raw: 'data: {"cut":true}\n\n' } } },
  { id: 'j1', req_body: '{}', resp: { kind: 'json', status: 200, body: { a: 1 } } },
];

async function resolver(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-field-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, FILE), RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const resolve = await buildResolver([dir]);
  t.after(() => resolve.dispose());
  return resolve;
}
const at = (id, field, s, e) => composeTextRef(raw(id), [s, e], field);

test('resp.raw and resp.messages.<j> slice the stored text verbatim; the decoded text is the verbatim record', async (t) => {
  const resolve = await resolver(t);
  const a = resolve.detail(at('h1', 'resp.raw', 0, SSE.length));
  assert.deepEqual([a.status, a.text, a.fidelity], ['ok', SSE, 'verbatim']);
  assert.equal(resolve.detail(at('h1', 'resp.raw', 6, 19)).text, SSE.slice(6, 19));
  const b = resolve.detail(at('w1', 'resp.messages.1', 0, MSGS[1].length));
  assert.deepEqual([b.status, b.text, b.fidelity], ['ok', MSGS[1], 'verbatim'], 'inflated text is what 4.6 stores verbatim');
  assert.equal(resolve.detail(at('w1', 'resp.messages.1', 9, 27)).text, MSGS[1].slice(9, 27));
  const x = resolve.detail(at('w1', 'req_extra_messages.0', 0, 28));
  assert.deepEqual([x.status, x.text], ['ok', '{"type":"response.interrupt"}'.slice(0, 28)]);
});

test('an error envelope is read through resp.partial, with the same numbering', async (t) => {
  const resolve = await resolver(t);
  assert.equal(resolve.detail(at('e1', 'resp.messages.0', 0, 32)).text, '{"type":"response.created","n":1}'.slice(0, 32));
  assert.equal(resolve.detail(at('e2', 'resp.raw', 0, 19)).text, 'data: {"cut":true}\n\n'.slice(0, 19));
});

test('unknown fields, absent fields and non-text values are reported, never guessed', async (t) => {
  const resolve = await resolver(t);
  for (const field of ['resp.body', 'req_body', 'resp.headers', 'ws_raw.0']) {
    assert.equal(resolve.detail(`${raw('h1')}::${field}::0-1`).status, 'bad-field', field);
  }
  const none = resolve.detail(at('h1', 'resp.messages.0', 0, 1));
  assert.equal(none.status, 'no-body');
  assert.match(none.reason, /resp\.messages\.0/);
  assert.equal(resolve.detail(at('w1', 'resp.messages.9', 0, 1)).status, 'no-body', 'past the last message');
  assert.equal(resolve.detail(at('j1', 'resp.raw', 0, 1)).status, 'no-body', 'a parsed JSON reply has no verbatim text (gate G16)');
  for (const [field, why] of [['resp.messages.2', /b64/], ['resp.messages.3', /omitted/], ['req_extra_messages.1', /b64/]]) {
    const d = resolve.detail(at('w1', field, 0, 1));
    assert.equal(d.status, 'no-body', field);
    assert.match(d.reason, why, `${field}: says what is stored instead`);
  }
});

test('a ref without a field still slices req_body exactly as before', async (t) => {
  const resolve = await resolver(t);
  const d = resolve.detail(composeTextRef(raw('h1'), [1, 4]));
  assert.deepEqual([d.status, d.text, d.fidelity], ['ok', '"x"', 'verbatim']);
  assert.equal(resolve.detail(composeTextRef(raw('w1'), [9, 26])).text, '{"type":"response.create"}'.slice(9, 26));
  // the same record asked for two fields in a row: neither answer leaks into the other's cache slot
  assert.equal(resolve.detail(at('w1', 'resp.messages.0', 0, 27)).text, MSGS[0]);
  assert.equal(resolve.detail(composeTextRef(raw('w1'), [0, 26])).text, '{"type":"response.create"}');
});
