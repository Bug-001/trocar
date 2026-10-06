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
