// test/view/cache-labels.test.mjs — RFC 3.3 §Edge cases: a reported zero cache read earns the label its vendor's cache row gives —
// best-effort on DeepSeek's Chat Completions, below the minimum cacheable length on OpenAI's Responses — and nothing on a vendor of
// unknown cache semantics, on a non-zero read, or on a failed call. Read off the `session` document's `wire.labels` ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';

const BEST = 'cache-best-effort', MIN = 'cache-below-minimum';
const ok = (body) => ({ status: 200, kind: 'json', body });
const FAIL = { status: 500, kind: 'json', body: { error: { message: 'Internal Server Error', type: 'internal_error' } } };
const rec = (r) => ({ id: 'req_1', ts_request: '2026-07-16T00:00:01Z', ...r });

const WIRES = {
  // OpenAI Responses (Codex): input_tokens counts the cached part
  responses: (input, read, failed) => rec({ endpoint: '/v1/responses', host: 'api.openai.com', proc: { pid: 1, exe: '/x/codex', agent: 'codex' },
    req_headers: { 'session-id': 's' }, req_body: JSON.stringify({ model: 'gpt-5', instructions: 'sys', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
    resp: failed ? FAIL : shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed',
      response: { id: 'r', output: [], usage: { input_tokens: input, input_tokens_details: { cached_tokens: read }, output_tokens: 1 } } })}\n\n`) }) }),
  // DeepSeek Chat Completions: hit + miss = the prompt
  chat: (input, read, failed) => rec({ endpoint: '/chat/completions', host: 'api.deepseek.com', proc: { pid: 1, exe: '/x/dsh', agent: 'dsh' },
    req_headers: { 'x-deepseek-harness-session-id': 's' }, req_body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }),
    resp: failed ? FAIL : ok({ id: 'c', model: 'deepseek-chat', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: input, completion_tokens: 1, prompt_cache_hit_tokens: read, prompt_cache_miss_tokens: input - read } }) }),
  // DeepSeek on the Anthropic wire: its cache semantics there are unknown
  'anthropic-to-deepseek': (input, read, failed) => rec({ endpoint: '/v1/messages', host: 'api.deepseek.com', proc: { pid: 1, exe: '/x/dsh', agent: 'dsh' },
    req_headers: { 'x-deepseek-harness-session-id': 's' }, req_body: JSON.stringify({ model: 'deepseek-chat', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'hi' }] }),
    resp: failed ? FAIL : ok({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input - read, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 1 } }) }),
};

// wire × input × read × failed → the labels the vendor's cache row gives a reported zero read (OpenAI caches from 1024 tokens on)
const expected = (wire, input, read, failed) => failed || read !== 0 ? [] : wire === 'chat' ? [BEST] : wire === 'responses' && input < 1024 ? [MIN] : [];
for (const wire of Object.keys(WIRES))
  for (const [input, read, failed] of [[500, 0, false], [2000, 0, false], [500, 100, false], [500, 0, true]]) {
    const want = expected(wire, input, read, failed);
    test(`${wire}: input ${input}, read ${read}${failed ? ', failed' : ''} → [${want}]`, async () => {
      const d = await sessionDoc([WIRES[wire](input, read, failed)], 's');
      assert.equal(d.calls.length, 1, JSON.stringify(d.errors));
      const ids = (d.calls[0].wire.labels || []).map((l) => l.id);
      for (const id of [BEST, MIN]) assert.equal(ids.includes(id), want.includes(id), `${id} in [${ids}]`);
    });
  }
