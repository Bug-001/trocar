// test/view/ground-truth.test.mjs — 3.3 #9 / D17④: a call whose reusable prefix is byte-identical to its baseline's reads its ground
// truth off its own usage: read 0 & write 0 → provider-contradiction; read 0 & write > 0 → ttl-rebuild; read > 0 → none; the first
// call has no reusable prefix and so no ground truth. Read off the `session` document's rows (test/helpers/session-doc.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';

const TOOLS = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }];
const SYS = [{ type: 'text', text: 'You are a coding assistant.' }];
const mk = (i, messages, usage) => ({
  id: `req_${i}`, ts_request: `2026-07-16T00:00:0${i}Z`, endpoint: '/v1/messages', host: 'api.anthropic.com',
  req_headers: { 'x-claude-code-session-id': 's-gt', 'user-agent': 'claude-cli/1.2' },
  req_body: JSON.stringify({ model: 'claude-opus-4', system: SYS, tools: TOOLS, messages }),
  resp: { status: 200, kind: 'json', body: { content: [{ type: 'text', text: 'ok' }], usage } },
});
// call #2 = call #1's context, verbatim, + an assistant turn and a new user turn
const rows = async (usage2) => (await sessionDoc([
  mk(1, [{ role: 'user', content: 'first question' }], { input_tokens: 100, output_tokens: 10 }),
  mk(2, [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'second question' }], usage2),
], 's-gt')).calls;

for (const [read, write, gt] of [[0, 0, 'provider-contradiction'], [0, 90, 'ttl-rebuild'], [90, 0, null]]) {
  test(`D17④: byte-identical prefix + read=${read} & write=${write} → ${gt}`, async () => {
    const [, c2] = await rows({ input_tokens: 120, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 });
    assert.ok(c2.cacheBreak.idx > 0, 'call #2 reuses a prefix of call #1');
    assert.equal(c2.gt ?? null, gt);
    assert.equal(c2.cacheBreak.gt ?? null, gt);
  });
}

test('D17④: first call has no reusable prefix → no ground truth', async () => {
  const [c1] = await rows({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 });
  assert.equal(c1.gt ?? null, null);
});

// 1.3 服务端补充 (invariant 4): zeros from no usage measured nothing, so nothing can be said against the provider.
const secondWith = async (over2, usage2) => {
  const a = mk(1, [{ role: 'user', content: 'first question' }], { input_tokens: 100, output_tokens: 10 })
  const b = mk(2, [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'second question' }], usage2)
  return (await sessionDoc([a, { ...b, resp: { ...b.resp, ...over2 } }], 's-gt')).calls[1]
}
for (const [what, over, usage] of [
  ['a failed call with no usage', { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } }, undefined],
  ['a call that failed though it reports zeros', { status: 529 }, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }],
  ['a successful call with no usage', {}, undefined],
]) {
  test(`${what} has no ground truth: the provider is not blamed`, async () => {
    const c = await secondWith(over, usage)
    assert.equal(c.gt ?? null, null)
    assert.equal(c.cacheBreak?.gt ?? null, null)
  })
}
test('a flat wire: a failed call with no usage has no ground truth, a successful one with zeros still does', async () => {
  const flat = (i, input, resp) => ({ id: `req_${i}`, ts_request: `2026-07-16T00:00:0${i}Z`, endpoint: '/v1/responses', host: 'api.openai.com', proc: { pid: 1, exe: '/x/codex', agent: 'codex' },
    req_headers: { 'session-id': 's-flat', 'user-agent': 'codex_cli_rs/1.0' }, req_body: JSON.stringify({ model: 'gpt-5', instructions: 'You are a coding agent.', input }), resp })
  const u = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
  const ok = (usage) => shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [], usage } })}\n\n`) })
  // the write reported as 0, not left out: a write not reported proves nothing (3.3 `provider-contradiction`)
  const zeros = { input_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0 }
  const two = [u('first question'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] }, u('second question')]
  const asked = async (resp) => (await sessionDoc([flat(1, [u('first question')], ok(zeros)), flat(2, two, resp)], 's-flat')).calls
  const [, failed] = await asked({ status: 500, kind: 'json', body: { error: { message: 'boom' } } })
  assert.equal(failed.gt ?? null, null)
  const [, zero] = await asked(ok(zeros))
  assert.ok(zero.cacheBreak.idx > 0, 'reuses a prefix')
  assert.equal(zero.gt ?? null, 'provider-contradiction')
})

