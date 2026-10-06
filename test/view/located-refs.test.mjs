// test/view/located-refs.test.mjs — locators for a context assembled across records (D37 ②, 4.2:40 字段段): every
// block either carries a field-qualified text_ref or is inlined with the SPECIFIC reason it could not be addressed
// (invariant 4) — and a dissector naming a field outside the 4.2:40 grammar labels that block, it does not throw
// (composeTextRef would) and take the whole /api/session down with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withLocatedRefs } from '../../src/view/assemble.mjs';
import { parseTextRef } from '../../src/etl/orchestrator.mjs';

const rec = { id: 'w1', _stream: 'S1.ndjson', req_headers: { 'session-id': 'S' },
  req_body: '{"type":"response.create","input":[{"role":"user","content":"hi"}]}',
  resp: { kind: 'ws', messages: ['{"type":"response.created"}', '{"type":"response.completed","response":{"output":[{"content":[{"text":"yo"}]}]}}', { b64: 'AAE=' }] } };
const block = (n) => ({ sec: 'messages', kind: 'text', role: 'user', text: `t${n}`, path: ['input', n] });

test('each block is addressed in the record and field its bytes live in, or says exactly why it is not', () => {
  const locs = [
    { rec, field: 'req_body', path: ['input', 0, 'content'] },
    { rec, field: 'resp.messages.1', path: ['response', 'output', 0, 'content', 0, 'text'] },
    null,
    { rec: { ...rec, _stream: undefined }, field: 'req_body', path: ['input', 0] },
    { rec, field: 'resp.bogus', path: [] },
    { rec, field: 'resp.messages.2', path: [] },
    { rec, field: 'req_body', path: ['input', 7] },
  ];
  const out = withLocatedRefs(locs.map((_, i) => block(i)), (b) => locs[b.path[1]]);
  const r0 = parseTextRef(out[0].text_ref);
  assert.deepEqual([r0.field, rec.req_body.slice(r0.start, r0.end)], [null, '"hi"'], 'req_body: the legacy (unqualified) ref');
  const r1 = parseTextRef(out[1].text_ref);
  assert.deepEqual([r1.field, rec.resp.messages[1].slice(r1.start, r1.end)], ['resp.messages.1', '"yo"']);
  const why = out.slice(2).map((b) => b.unaddressable);
  for (const w of why) assert.match(w, /inlined as-is, NOT resolved from the raw capture$/);
  assert.match(why[0], /placed this block in no source record/);
  assert.match(why[1], /record w1 carries no id or stream/);
  assert.match(why[2], /field "resp\.bogus" of record w1 is no text_ref field segment/);
  assert.match(why[3], /field resp\.messages\.2 of record w1 holds no JSON text/);
  assert.match(why[4], /path \["input",7\] is not in field req_body of record w1/);
  for (const b of out.slice(2)) assert.equal(b.text_ref, undefined);
  assert.ok(out.slice(2).every((b, i) => b.text === `t${i + 2}`), 'the body stays inline, so the row is still readable');
});
