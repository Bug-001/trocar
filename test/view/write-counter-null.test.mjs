// RFC 3.2 (NULL = not reported), 2.2 / 2.6 fidelity: a wire with no cache-write counter answers `create: null` in every row, never a 0 a
// reader takes as a reported zero; a reported 0 stays 0, and Anthropic itself, which always reports it, reads absent as 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';
import { HARNESSES } from '../../src/dissect/harnesses.mjs';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';

const agentOf = (id) => HARNESSES.find((h) => h.id === id).agents[0];
const anth = (agent, host, usage) => ({ id: 'req_1', ts_request: '2026-07-16T00:00:01Z', endpoint: '/v1/messages', host, proc: { pid: 1, exe: '/x/a', agent },
  req_headers: { 'x-claude-code-session-id': 's', 'x-deepseek-harness-session-id': 's' },
  req_body: JSON.stringify({ model: 'm', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, kind: 'json', body: { content: [{ type: 'text', text: 'ok' }], usage } } });
const sse = (usage) => shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [], usage } })}\n\n`) });
const codex = (usage) => ({ id: 'req_1', ts_request: '2026-07-16T00:00:01Z', endpoint: '/v1/responses', host: 'api.openai.com', proc: { pid: 1, exe: '/x/c', agent: agentOf('codex') },
  req_headers: { 'session-id': 's' }, req_body: JSON.stringify({ model: 'm', instructions: 'sys', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }), resp: sse(usage) });
const one = async (rec) => { const d = await sessionDoc([rec], 's'); assert.equal(d.calls.length, 1, JSON.stringify(d.errors)); return d.calls[0].usage };

test('Anthropic: absent reads as 0, a reported write stays', async () => {
  assert.equal((await one(anth(agentOf('cc'), 'api.anthropic.com', { input_tokens: 5, output_tokens: 1 }))).create, 0);
  assert.equal((await one(anth(agentOf('cc'), 'api.anthropic.com', { input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 1 }))).create, 7);
});

test('another vendor on the same wire that omits it: NULL; one that reports 0: 0', async () => {
  const dsh = (u) => anth(agentOf('dsh'), 'api.deepseek.com', u);
  assert.equal((await one(dsh({ input_tokens: 5, output_tokens: 1 }))).create, null);
  assert.equal((await one(dsh({ input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 1 }))).create, 0);
});

test('a flat wire with no write counter: NULL; a relay that adds one: its number', async () => {
  assert.equal((await one(codex({ input_tokens: 5, input_tokens_details: { cached_tokens: 1 }, output_tokens: 1 }))).create, null);
  assert.equal((await one(codex({ input_tokens: 5, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 }, output_tokens: 1 }))).create, 2);
});
