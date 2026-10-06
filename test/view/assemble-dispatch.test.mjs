// test/view/assemble-dispatch.test.mjs — D25 / D37 ①: the shared assembler names no wire; the registry's
// dissector objects carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSession } from '../../src/view/assemble.mjs';
import { boardDissectorFor } from '../../src/dissect/registry.mjs';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'view', 'assemble.mjs'), 'utf8');
const rec = (id, endpoint, body) => ({ id, ts_request: `2026-10-06T00:00:0${id.slice(-1)}Z`, is_llm_call: true, endpoint,
  req_headers: { 'session-id': 'S' }, req_body: JSON.stringify(body), resp: { status: 200, kind: 'sse', raw_sse: [] } });

test('Responses and Chat both go through the one flat-lane assembler, tagged with their wire format', () => {
  const r = assembleSession([rec('r1', '/v1/responses', { model: 'm', input: [] })]);
  const c = assembleSession([rec('c1', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'x' }] })]);
  assert.deepEqual([r.steps[0].wireFormat, c.steps[0].wireFormat], ['openai-responses', 'openai-chat']);
  assert.deepEqual([r.provider, c.provider], ['openai', 'openai'], 'the pre-D37 board label is the dissector\'s, not a literal in the assembler');
  assert.equal(boardDissectorFor(rec('a1', '/v1/messages', { messages: [] })), null, 'the Anthropic wire uses the multi-lane analyzer');
  assert.equal(assembleSession([rec('a1', '/v1/messages', { system: 's', messages: [{ role: 'user', content: 'x' }] })]).provider, 'cc');
  assert.equal(assembleSession([rec('u1', '/v1beta/models/x:generateContent', { contents: [] })]).provider, 'unknown');
});

test('assemble.mjs names no wire and imports no wire dissector (D25)', () => {
  assert.doesNotMatch(SRC, /from ['"]\.\.\/dissect\/(openai|cc)\.mjs['"]/);
  assert.doesNotMatch(SRC, /\bopenai\.|chat\/completions|\/responses|looksCC|x-claude-code/);
});

test('an HTTP Responses stream that ends in response.failed, or in an error event, is an error step and never the next cache baseline', () => {
  const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
  const a1 = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] };
  const done = { type: 'response.completed', response: { id: 'ra', status: 'completed', output: [a1], usage: { input_tokens: 5, output_tokens: 1 } } };
  for (const end of [{ type: 'response.failed', response: { id: 'rb', status: 'failed', error: { code: 'server_error' } } }, { type: 'error', code: 'server_error', message: 'boom' }]) {
    const a = rec('h1', '/v1/responses', { model: 'm', input: [user('q1')] });
    a.resp.raw_sse = [done];
    const b = rec('h2', '/v1/responses', { model: 'm', input: [user('q1'), a1, user('q2')] });
    b.resp.raw_sse = [{ type: 'response.created', response: { id: 'rb' } }, end];
    const c = rec('h3', '/v1/responses', { model: 'm', input: [user('q1'), a1, user('q3')] });
    c.resp.raw_sse = [done];
    const steps = assembleSession([a, b, c]).steps;
    assert.deepEqual(steps.map((s) => s.error), [false, true, false], end.type);
    assert.equal(steps[2].cacheBreak.cause, 'append', `${end.type}: c extends a's prefix; the failed b never became the baseline`);
  }
});
