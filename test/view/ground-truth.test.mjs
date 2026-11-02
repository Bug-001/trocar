// test/view/ground-truth.test.mjs — 3.3 #9 / D17④: a call whose reusable prefix is byte-identical to its baseline's reads its ground
// truth off its own usage: read 0 & write 0 → provider-contradiction; read 0 & write > 0 → ttl-rebuild; read > 0 → none; the first
// call has no reusable prefix and so no ground truth. Read off the `session` document's rows (test/helpers/session-doc.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';

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
