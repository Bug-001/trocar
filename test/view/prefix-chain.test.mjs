// test/view/prefix-chain.test.mjs — 3.3 #6 / 3.5 #6: a cache break is diffed against the last SUCCESSFUL call of its lane. A call that
// failed (401, 502) never got far enough for the provider to write a KV-cache prefix, so it is never the baseline of the next one;
// the failed call itself stays a row, marked failed. Read through the `session` document (test/helpers/session-doc.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';

// a real agent loop alternates user / assistant: each call re-sends the prior reply and appends the next turn
const turns = (n) => {
  const m = [];
  for (let k = 1; k <= n; k++) {
    m.push({ role: 'user', content: [{ type: 'text', text: `U${k}` }] });
    if (k < n) m.push({ role: 'assistant', content: [{ type: 'text', text: `A${k}` }] });
  }
  return m;
};
const call = (i, { status = 200, sys = 'SYS', messages }) => ({
  id: `req_0000${i}`, ts_request: `2026-07-19T00:00:0${i}.000Z`, endpoint: '/v1/messages', host: 'api.anthropic.com',
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.0.0' },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', system: [{ type: 'text', text: sys }], tools: [], messages }),
  resp: { status, kind: 'json', body: { usage: { input_tokens: 10, output_tokens: 1 } } },
});
const oaCall = (i, { status = 200, instructions = 'SYS', n }) => ({
  id: `oa_0000${i}`, ts_request: `2026-07-19T00:00:0${i}.000Z`, endpoint: '/models-proxy/responses', host: 'api.openai.com',
  req_headers: { 'x-claude-code-session-id': 'OA', 'user-agent': 'opencode/1.17.12' },
  req_body: JSON.stringify({ model: 'gpt-5.5', instructions, tools: [],
    input: Array.from({ length: n }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `T${k}` })) }),
  resp: { status, kind: 'json', body: {} },
});

// #2 fails carrying a mutated system prompt, #3 succeeds back on the original: diffed through #2 it would read as content-changed
const WIRES = {
  anthropic: { id: 'S', recs: [call(1, { messages: turns(3) }), call(2, { status: 502, sys: 'SYS-MUTATED', messages: turns(4) }), call(3, { messages: turns(4) })] },
  responses: { id: 'OA', recs: [oaCall(1, { n: 4 }), oaCall(2, { status: 502, instructions: 'SYS-MUTATED', n: 6 }), oaCall(3, { n: 6 })] },
};

for (const [wire, { id, recs }] of Object.entries(WIRES)) {
  test(`${wire}: a failed call stays a row, marked failed, and is never the cache-prefix baseline of the next call`, async () => {
    const { calls } = await sessionDoc(recs, id);
    assert.equal(calls.length, 3, 'the failed call is not dropped');
    const [first, failed, third] = calls;
    assert.equal(failed.status, 502);
    assert.equal(failed.error, true);
    assert.equal(third.lane, first.lane, 'all three share one lane');
    assert.equal(third.cacheBreak.refRid, first.rid, '#3 is diffed against the last successful call');
    assert.notEqual(third.cacheBreak.cause, 'content-changed');
    assert.equal(third.cacheBreak.attribution, 'harmless');
  });
}

test('consecutive successes still chain normally (no regression)', async () => {
  const { calls } = await sessionDoc([call(1, { messages: turns(3) }), call(2, { messages: turns(4) }), call(3, { messages: turns(5) })], 'S');
  assert.equal(calls[1].cacheBreak.cause, 'append');
  assert.equal(calls[2].cacheBreak.cause, 'append');
});

test('a Responses stream that ends in response.failed, or in an error event, fails its call (status 200 or not) and is no baseline', async () => {
  const rec = (i, input, raw_sse) => ({ id: `h${i}`, ts_request: `2026-10-06T00:00:0${i}Z`, endpoint: '/v1/responses', host: 'api.openai.com',
    req_headers: { 'x-claude-code-session-id': 'R' }, req_body: JSON.stringify({ model: 'm', input }), resp: { status: 200, kind: 'sse', raw_sse } });
  const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
  const a1 = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] };
  const done = { type: 'response.completed', response: { id: 'ra', status: 'completed', output: [a1], usage: { input_tokens: 5, output_tokens: 1 } } };
  for (const end of [{ type: 'response.failed', response: { id: 'rb', status: 'failed', error: { code: 'server_error' } } }, { type: 'error', code: 'server_error', message: 'boom' }]) {
    const { calls } = await sessionDoc([rec(1, [user('q1')], [done]), rec(2, [user('q1'), a1, user('q2')], [{ type: 'response.created', response: { id: 'rb' } }, end]),
      rec(3, [user('q1'), a1, user('q3')], [done])], 'R');
    assert.deepEqual(calls.map((c) => c.error), [false, true, false], end.type);
    assert.equal(calls[2].cacheBreak.refRid, calls[0].rid, `${end.type}: the failed call never became the baseline`);
    assert.equal(calls[2].cacheBreak.cause, 'append', end.type);
  }
});
