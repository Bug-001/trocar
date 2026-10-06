// test/etl/text-ref-field.test.mjs — the text_ref field segment (RFC 4.2:40 字段段, gate G1): a ref may name
// resp.raw / resp.messages.<j> / req_extra_messages.<k> instead of req_body; a ref without one is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeTextRef, parseTextRef, mintRawRef, TEXT_REF_FIELD } from '../../src/etl/orchestrator.mjs';

const RAW = mintRawRef('S', 'capture-2026-10-06.ndjson', 'req_ab-00001');

test('composeTextRef without a field is byte-identical to the legacy grammar', () => {
  assert.equal(composeTextRef(RAW, [3, 9]), `${RAW}::3-9`);
  assert.equal(composeTextRef(RAW, [3, 9], null), `${RAW}::3-9`);
  assert.equal(composeTextRef(RAW, [3, 9], 'req_body'), `${RAW}::3-9`, 'req_body is the default, never written out');
});

test('parseTextRef round-trips every field-qualified ref; a legacy ref has field null', () => {
  for (const field of ['resp.raw', 'resp.messages.0', 'resp.messages.12', 'req_extra_messages.3']) {
    const ref = composeTextRef(RAW, [5, 50], field);
    assert.equal(ref, `${RAW}::${field}::5-50`);
    const p = parseTextRef(ref);
    assert.deepEqual([p.rawRef, p.recordId, p.field, p.start, p.end], [RAW, 'req_ab-00001', field, 5, 50]);
  }
  const legacy = parseTextRef(`${RAW}::3-9`);
  assert.deepEqual([legacy.rawRef, legacy.recordId, legacy.field, legacy.start, legacy.end], [RAW, 'req_ab-00001', null, 3, 9]);
  assert.equal(parseTextRef(RAW).field, null, 'a raw ref (no span) has no field either');
});

test('TEXT_REF_FIELD admits exactly the grammar\'s fields', () => {
  for (const f of ['resp.raw', 'resp.messages.0', 'resp.messages.7', 'req_extra_messages.0']) assert.ok(TEXT_REF_FIELD.test(f), f);
  for (const f of ['req_body', 'resp', 'resp.body', 'resp.headers', 'resp.messages', 'resp.messages.x', 'resp.messages.-1',
    'resp.raw_sse', 'req_extra_messages', 'ws_raw.0', 'resp.messages.0.text']) assert.ok(!TEXT_REF_FIELD.test(f), f);
});

test('composeTextRef refuses a field outside the grammar instead of minting an unresolvable ref', () => {
  assert.throws(() => composeTextRef(RAW, [0, 1], 'resp.body'), /field/);
});
