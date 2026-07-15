import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintRawRef, composeTextRef, parseTextRef } from '../../src/etl/orchestrator.mjs';

test('raw_ref format = <session>/<stream>#<record.id>', () => {
  assert.equal(mintRawRef('sess-A', 'capture.ndjson', 'req-42'), 'sess-A/capture.ndjson#req-42');
});

test('control-plane (session_id null) raw_ref uses the _control bucket', () => {
  assert.equal(mintRawRef(null, 'capture.ndjson', 'ctl-9'), '_control/capture.ndjson#ctl-9');
});

test('text_ref composes raw_ref + byte span and round-trips through parseTextRef', () => {
  const raw = mintRawRef('sess-A', 'capture.ndjson', 'req-42');
  const tr = composeTextRef(raw, [12, 87]);
  assert.equal(tr, 'sess-A/capture.ndjson#req-42::12-87');
  const p = parseTextRef(tr);
  assert.equal(p.rawRef, raw);
  assert.equal(p.start, 12);
  assert.equal(p.end, 87);
  assert.equal(p.recordId, 'req-42'); // recordId survives even with '-' in the id
});
