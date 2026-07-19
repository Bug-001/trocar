import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextRef, mintRawRef, composeTextRef } from '../../src/etl/orchestrator.mjs';

// A text_ref normally carries a byte span (`…#id::start-end`). When it does NOT,
// `lastIndexOf('::')` returns -1 and `slice(0, -1)` silently chopped the LAST CHARACTER off the
// ref — so `req_plain` became `req_plai` and the lookup reported the record "absent" instead of
// reporting a malformed ref. A silently wrong answer from the source-truth resolver is the exact
// failure class this audit exists to eliminate.
test('a ref WITHOUT a byte span keeps its record id intact', () => {
  const raw = mintRawRef('S', 'cap.ndjson', 'req_plain');
  const p = parseTextRef(raw);
  assert.equal(p.recordId, 'req_plain', 'the id must not lose its last character');
  assert.equal(p.rawRef, raw);
});

test('a ref WITH a byte span still parses exactly as before', () => {
  const raw = mintRawRef('S', 'cap.ndjson', 'req_plain');
  const p = parseTextRef(composeTextRef(raw, [10, 20]));
  assert.equal(p.recordId, 'req_plain');
  assert.equal(p.rawRef, raw);
  assert.equal(p.start, 10);
  assert.equal(p.end, 20);
});
