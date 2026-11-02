// test/view/req-incomplete.test.mjs — #21's request labels, worded per state (RFC 4.6
// §记录 「不完整的标注,各说一件事」, invariant 4), over real collector envelopes (cut-requests.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { reqIncompleteOf } from '../../src/dissect/capture-labels.mjs';
import { cutRequestEnvelopes } from '../helpers/cut-requests.mjs';

const E = await cutRequestEnvelopes();

test('reqIncompleteOf: null for a complete request; each label worded, both together joined', () => {
  assert.equal(reqIncompleteOf(E.complete), null);
  const cut = reqIncompleteOf({ req_truncated: true, req_body_bytes: 67108864 });
  assert.deepEqual([cut.truncated, cut.storedBytes, cut.partial], [true, 67108864, null]);
  assert.match(cut.text, /cut at the capture cap.*first 67108864 bytes are stored/);
  assert.doesNotMatch(cut.text, /never finished/, 'a capped body did finish: it says only that it was cut');
  for (const [k, re] of [['early-response', /answered .*before it was fully sent/], ['aborted', /aborted/], ['framer-error', /lost the request's HTTP framing.*whether the rest reached the upstream is unknown/]]) {
    const q = reqIncompleteOf({ req_partial: k });
    assert.match(q.text, re, k);
    assert.deepEqual([q.truncated, q.storedBytes, q.partial], [false, null, k], k);
    assert.doesNotMatch(q.text, /capture cap/, `${k} says only that the body never finished`);
  }
  assert.doesNotMatch(reqIncompleteOf({ req_partial: 'framer-error' }).text, /never finished/, 'a lost framing is not an unfinished upload: the relay may have forwarded it all');
  assert.match(reqIncompleteOf({ req_partial: 'something-new' }).text, /something-new/, 'an unknown value is shown verbatim, never dropped');
  assert.equal(reqIncompleteOf({ partial: true, partial_reasons: ['off-window'] }), null, "top-level `partial` is missing context, not this body's bytes (4.6 各说一件事)");
  assert.match(reqIncompleteOf({ req_truncated: true }).text, /size was not recorded/, 'a missing byte count is said, not shown as 0');
  const both = reqIncompleteOf({ req_truncated: true, req_body_bytes: 4, req_partial: 'aborted' });
  assert.match(both.text, /cap.*; .*aborted/);
});
