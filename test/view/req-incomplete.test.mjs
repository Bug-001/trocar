// test/view/req-incomplete.test.mjs — #21's request labels reach the board, worded exactly (RFC 4.6
// §记录 「不完整的标注,各说一件事」, invariant 4). Board cases are real collector envelopes (cut-requests.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { reqIncompleteOf } from '../../src/dissect/capture-labels.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { cutRequestEnvelopes } from '../helpers/cut-requests.mjs';

const E = await cutRequestEnvelopes();
const stepOf = (A, rec) => A.steps.find((s) => s.id === rec.id);

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

test('an unparseable cut request says why, instead of "truncated / corrupt capture"', () => {
  const A = assembleSession([E.complete, E.capped, E.early413]);
  const capped = stepOf(A, E.capped), early = stepOf(A, E.early413);
  for (const s of [capped, early]) {
    assert.equal(s.unparsed, true);
    assert.match(s.errMsg, /could not be parsed/);
    assert.doesNotMatch(s.errMsg, /corrupt/);
  }
  assert.match(capped.errMsg, /cut at the capture cap: only the first 40 bytes are stored/);
  assert.deepEqual([capped.reqIncomplete.truncated, capped.reqIncomplete.storedBytes], [true, 40]);
  assert.match(early.errMsg, /answered \(e\.g\. 413 \/ 401\) before it was fully sent/);
  assert.equal(stepOf(A, E.complete).reqIncomplete, null);
});

test('an unlabelled unparseable body keeps the old wording (a v0 capture has no labels)', () => {
  const A = assembleSession([{ ...E.complete, req_body: '{"model":' }]);
  assert.equal(A.steps[0].unparsed, true);
  assert.equal(A.steps[0].errMsg, 'unrenderable: req_body could not be parsed (truncated / corrupt capture)');
  assert.equal(A.steps[0].reqIncomplete, null);
});

test('a parseable request that never finished still carries the label (the shown context may be short)', () => {
  const A = assembleSession([E.complete, E.early401]);
  const s = stepOf(A, E.early401);
  assert.equal(s.unparsed, false);
  assert.ok(s.flat.length > 0, 'its blocks still render');
  assert.equal(s.reqIncomplete.partial, 'early-response');
  assert.equal(s.errMsg, 'HTTP 401', 'the HTTP status stays the error; the label rides beside it');
});

test('the flat-lane (OpenAI) call carries the label too', () => {
  const oa = (id, extra) => ({ id, ts_request: `2026-10-06T00:00:0${id}Z`, endpoint: '/v1/responses', is_llm_call: true,
    req_headers: { 'session-id': 'C' }, req_body: '{"model":"gpt-5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}]}',
    resp: { status: 200, kind: 'sse' }, ...extra });
  const A = assembleSession([oa('1'), oa('2', { req_truncated: true, req_body_bytes: 64 })]);
  assert.equal(A.provider, 'openai');
  assert.equal(A.steps[0].reqIncomplete, null);
  assert.match(A.steps[1].reqIncomplete.text, /only the first 64 bytes are stored/);
});
