// test/view/flat-unparsed.test.mjs — invariant 4 / D38 on every wire: a request body that does not parse is an unrenderable call that
// says why (`unparsed` + `errMsg`), one reason on every wire; it is no complete context (G17) and no cache baseline (3.5 #6).
// Read through the `session` document (test/helpers/session-doc.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';

const rec = (id, sec, endpoint, req_body, extra = {}) => ({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, endpoint, host: 'api.example.com',
  req_headers: { 'x-claude-code-session-id': 'S' }, req_body, resp: { kind: 'sse', status: 200, raw_sse: [] }, ...extra });
const CUT = {
  '/v1/chat/completions': '{"model":"k","messages":[{"role":"user","content":"hel',
  '/v1/responses': '{"model":"g","input":[{"type":"mess',
  '/v1/messages': '{"model":"c","messages":[{"role":"us',
};

test('a corrupt request body on every wire is an unparsed call with the same reason', async () => {
  const out = {};
  for (const [ep, body] of Object.entries(CUT)) {
    const doc = await sessionDoc([rec('x', 1, ep, body)], 'S');
    assert.equal(doc.unknown, undefined, `${ep}: still a call of its wire, not unrecognized traffic`);
    const [s] = doc.calls;
    assert.equal(s.unparsed, true, `${ep}: the page's "nothing to render" guard fires`);
    assert.equal(s.error, true, `${ep}: an unrenderable call is not shown as a normal one`);
    assert.equal(s.wire.contextState, 'partial', `${ep}: a body that does not parse is no complete context (G17)`);
    assert.equal(typeof s.errMsg, 'string');
    out[ep] = s.errMsg;
  }
  assert.equal(out['/v1/chat/completions'], out['/v1/messages'], 'one reason on every wire');
  assert.equal(out['/v1/responses'], out['/v1/messages']);
});

test('an unparsed call is no cache baseline: the next call is diffed against the last parsed one', async () => {
  const ok = (id, sec, text) => rec(id, sec, '/v1/chat/completions', JSON.stringify({ model: 'k', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: text }] }));
  const { calls: [a, b, c] } = await sessionDoc([ok('a', 1, 'q1'), rec('b', 2, '/v1/chat/completions', CUT['/v1/chat/completions']), ok('c', 3, 'q2')], 'S');
  assert.equal(a.unparsed, undefined);
  assert.equal(b.unparsed, true);
  assert.equal(c.cacheBreak.refRid, a.rid, 'c is diffed against a, not the empty b');
  assert.equal(c.cacheBreak.idx, 1, 'c shares the system block with a; against the empty b it would share nothing');
});

test('a parseable body is not marked', async () => {
  const { calls: [s] } = await sessionDoc([rec('x', 1, '/v1/chat/completions', '{"model":"k","messages":[{"role":"user","content":"hi"}]}')], 'S');
  assert.equal(s.unparsed, undefined);
  assert.equal(s.errMsg, undefined);
  assert.equal(s.error, false);
});
