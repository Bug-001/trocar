// test/view/provider-unknown.test.mjs — D25 / 3.1 #4: traffic no dissector reads is counted as unknown, never rendered through a known
// dissector and never given a known provider. The regression this guards: the CC walker found a bogus block in an unread wire's tools[] and
// then accused the provider of contradicting its own cache accounting. Read through `sessions` and `session` (test/helpers/session-doc.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWith, query } from '../helpers/session-doc.mjs';

const OC = { pid: 1, exe: '/x/opencode', agent: 'opencode' }; // a harness that can point at any backend: its provider is the wire's
// traffic of a wire no dissector reads: a made-up endpoint and body shape; nothing Anthropic, nothing OpenAI, nothing Gemini
const unread = (id, ts) => ({
  id, ts_request: ts, host: 'llm.example', proc: OC,
  endpoint: '/v9/foo:infer',
  req_headers: { 'x-session-id': 'sess-unk', 'user-agent': 'some-sdk/1.0' },
  req_body: JSON.stringify({
    preamble: { segments: [{ text: 'You are a helpful assistant.' }] },
    turns: [{ speaker: 'human', segments: [{ text: 'hello world' }] }],
    tools: [{ declarations: [{ name: 'read_file', parameters: { type: 'object' } }] }],
  }),
  resp: { kind: 'json', status: 200, body: { tally: { in: 812, out: 44 } } },
});
const cc = {
  id: 'c1', ts_request: '2026-07-19T00:00:00Z', endpoint: '/v1/messages?beta=true', host: 'api.anthropic.com', proc: OC,
  req_headers: { 'x-session-id': 's1', 'user-agent': 'claude-cli/2.1.209', 'anthropic-version': '2023-06-01' },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 32000, system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }] }),
  resp: { kind: 'json', status: 200, body: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } },
};
const read = async (records, id) => {
  const home = homeWith(records), { sessions } = await query(home, 'sessions');
  return { meta: sessions.find((s) => s.session_id === id), doc: await query(home, 'session', { id }) };
};

test('unknown traffic is counted as unknown with its endpoint, has no provider, and fabricates no call, usage or ground truth', async () => {
  const { meta, doc } = await read([unread('u1', '2026-07-19T00:00:00Z'), unread('u2', '2026-07-19T00:00:01Z')], 'sess-unk');
  assert.equal(meta.provider, null, 'an unrecognized wire gives no provider, never a guess');
  assert.equal(doc.unknown.records, 2, 'unrecognized records are counted, not dropped');
  assert.deepEqual(doc.unknown.endpoints, ['/v9/foo:infer']);
  assert.deepEqual(doc.calls, [], 'no call row (so no blocks, usage or ground truth) for undissected bytes');
});

// 3.1 #4 · invariant 4: a wire this version records and does not read (the endpoint table's `unsupported`) is named where it stands
const bedrock = (id, ts, endpoint = '/model/anthropic.claude-x/invoke-with-response-stream') => ({
  id, ts_request: ts, host: 'bedrock-runtime.us-east-1.amazonaws.com', proc: OC, endpoint,
  req_headers: { 'x-session-id': 'sess-br', 'user-agent': 'aws-sdk-js/3.0.0' },
  req_body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hi' }] }] }),
  resp: { kind: 'json', status: 200, body: {} },
});
test('unknown records that are all of a wire this version does not read say which wire; any other unread record keeps the general reason', async () => {
  const { doc } = await read([bedrock('b1', '2026-07-19T00:00:00Z'), bedrock('b2', '2026-07-19T00:00:01Z')], 'sess-br');
  assert.equal(doc.unknown.records, 2)
  assert.ok(doc.unknown.reason.includes('bedrock'), `the wire is named: ${doc.unknown.reason}`)
  const mixed = (await read([bedrock('b1', '2026-07-19T00:00:00Z'), bedrock('b2', '2026-07-19T00:00:01Z', '/v9/whatever')], 'sess-br')).doc
  assert.equal(mixed.unknown.records, 2)
  assert.ok(!mixed.unknown.reason.includes('bedrock'), 'a record of no known wire among them: no wire is claimed for it')
});

// Vertex AI's Gemini models end in :generateContent too, the Gemini API's suffix: a wire this version does not read gives no provider
const vertex = (id, ts) => ({
  id, ts_request: ts, host: 'us-central1-aiplatform.googleapis.com', proc: OC, endpoint: '/v1/projects/p/locations/us/publishers/google/models/x:streamGenerateContent',
  req_headers: { 'x-session-id': 'sess-vx', 'user-agent': 'some-sdk/1.0' },
  req_body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  resp: { kind: 'json', status: 200, body: {} },
});
test('a Vertex Gemini session has no provider and its calls are unknown, named as vertex', async () => {
  const { meta, doc } = await read([vertex('v1', '2026-07-19T00:00:00Z'), vertex('v2', '2026-07-19T00:00:01Z')], 'sess-vx');
  assert.equal(meta.provider, null);
  assert.equal(doc.unknown.records, 2);
  assert.ok(doc.unknown.reason.includes('vertex'), doc.unknown.reason);
  assert.deepEqual(doc.calls, []);
});

test('a real Claude Code call on the same harness is still read as Anthropic (no regression)', async () => {
  const { meta, doc } = await read([cc], 's1');
  assert.equal(meta.provider, 'anthropic');
  assert.equal(doc.unknown, undefined);
  assert.equal(doc.calls.length, 1);
});
