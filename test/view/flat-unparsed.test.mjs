// test/view/flat-unparsed.test.mjs — invariant 4 / D38 on the flat-lane wires: a request body that does not parse
// is an unrenderable call that says why (`unparsed` + `errMsg`, the page's guard), as on the Anthropic wire. Before,
// a corrupt Chat / Responses body shipped as 0 blocks of a "complete" context with no reason anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const rec = (id, sec, endpoint, req_body, extra = {}) => stream({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, endpoint, is_llm_call: true,
  req_headers: { 'session-id': 'S', 'x-claude-code-session-id': 'S' }, req_body, resp: { kind: 'sse', status: 200, raw_sse: [] }, ...extra });
const CUT = {
  '/v1/chat/completions': '{"model":"k","messages":[{"role":"user","content":"hel',
  '/v1/responses': '{"model":"g","input":[{"type":"mess',
  '/v1/messages': '{"model":"c","messages":[{"role":"us',
};

test('a corrupt request body on every wire is an unparsed call with the same reason', () => {
  const out = {};
  for (const [ep, body] of Object.entries(CUT)) {
    const A = assembleSession([rec('x', 1, ep, body)]);
    assert.equal(A.unknown, undefined, `${ep}: still a call of its wire, not unrecognized traffic`);
    const s = A.steps[0];
    assert.equal(s.unparsed, true, `${ep}: the page's "nothing to render" guard fires`);
    assert.equal(s.error, true, `${ep}: an unrenderable call is not shown as a normal one`);
    assert.deepEqual(s.flat, []);
    out[ep] = s.errMsg;
  }
  assert.match(out['/v1/chat/completions'], /could not be parsed \(truncated \/ corrupt capture\)/);
  assert.equal(out['/v1/chat/completions'], out['/v1/messages'], 'one wording on both assembly paths');
  assert.equal(out['/v1/responses'], out['/v1/messages']);
});

test("a body the collector labelled cut says the collector's reason", () => {
  const s = assembleSession([rec('x', 1, '/v1/chat/completions', CUT['/v1/chat/completions'], { req_truncated: true, req_body_bytes: 48 })]).steps[0];
  assert.equal(s.unparsed, true);
  assert.equal(s.wire.contextState, 'partial');
  assert.match(s.errMsg, /only the first 48 bytes are stored/);
});

test('an unparsed call is no cache baseline: the next call is diffed against the last parsed one', () => {
  const ok = (id, sec, text) => rec(id, sec, '/v1/chat/completions', JSON.stringify({ model: 'k', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: text }] }));
  const A = assembleSession([ok('a', 1, 'q1'), rec('b', 2, '/v1/chat/completions', CUT['/v1/chat/completions']), ok('c', 3, 'q2')]);
  const [a, b, c] = A.steps;
  assert.equal(a.unparsed, undefined);
  assert.equal(b.unparsed, true);
  assert.equal(c.cacheBreak.idx, 1, 'c shares the system block with a; against the empty b it would share nothing');
  assert.ok(c.prefixSha256, 'and so carries a prefix hash');
});

test('a parseable body is not marked', () => {
  const s = assembleSession([rec('x', 1, '/v1/chat/completions', '{"model":"k","messages":[{"role":"user","content":"hi"}]}')]).steps[0];
  assert.equal(s.unparsed, undefined);
  assert.equal(s.errMsg, undefined);
  assert.equal(s.error, false);
});
