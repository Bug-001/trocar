// test/view/seven-harness-board.test.mjs — the board lists and renders the session of every v1 harness from
// the envelopes the collector writes for it (R2 read half for the listing; D37 three axes). Each exchange
// goes through the collector's REAL createExchangeTee + createRecordStore, with the flow the engine stamps
// (host = the upstream, proc.agent = the descriptor name in src/collector/harness/*.mjs); it is then read
// back only through `asight serve` (createServer → /api/projects, /api/session, /api/block).
// Request headers and body keys follow RFC 3.4's table; bodies are synthetic (no real provider traffic).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createExchangeTee } from '../../src/collector/core/engine/exchange.mjs';
import { createRecordStore } from '../../src/collector/core/record/store.mjs';
import { createServer } from '../../src/server.mjs';
import { parseTextRef } from '../../src/etl/orchestrator.mjs';

const ANTH = (extra = {}) => ({ model: 'm', max_tokens: 8, system: [{ type: 'text', text: 'sys' }],
  tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }], ...extra });
const CHAT = (extra = {}) => ({ model: 'm', stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], ...extra });
const RESP = (extra = {}) => ({ model: 'm', instructions: 'sys', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }],
  tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], ...extra });
const sse = (events) => events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');
const REPLY = {
  anthropic: sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg', model: 'm', usage: { input_tokens: 5, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }]),
  chat: sse([{ data: { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } } }, { data: '[DONE]' }]),
  responses: sse([{ event: 'response.completed', data: { type: 'response.completed', response: { id: 'r', model: 'm', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 5, output_tokens: 1 } } } }]),
};

// harness → [agent (descriptor name), host, request target, request headers, body, reply, expected]
const HARNESSES = [
  ['cc', 'claude-code', 'api.anthropic.com', '/v1/messages?beta=true', { 'User-Agent': 'claude-cli/2.1.289', 'X-Claude-Code-Session-Id': 'S-cc', 'anthropic-version': '2023-06-01' }, ANTH(), 'anthropic',
    { session: 'S-cc', wire: 'anthropic', vendor: 'anthropic', effect: ['cc-gzip-off'] }],
  ['codex', 'codex', 'chatgpt.com', '/backend-api/codex/responses', { 'User-Agent': 'codex_cli_rs/0.50.0', originator: 'codex_cli_rs', 'session-id': 'S-codex', 'thread-id': 'S-codex' }, RESP({ prompt_cache_key: 'S-codex' }), 'responses',
    { session: 'S-codex', wire: 'openai-responses', vendor: 'openai', effect: ['codex-rustls-h2'] }],
  ['opencode', 'opencode', 'api.anthropic.com', '/v1/messages', { 'User-Agent': 'opencode/1.18.34', 'x-opencode-session-id': 'S-oc', 'anthropic-version': '2023-06-01' }, ANTH(), 'anthropic',
    { session: 'S-oc', wire: 'anthropic', vendor: 'anthropic', effect: ['opencode-plugin'] }],
  ['kimi', 'kimi-code', 'api.kimi.com', '/coding/v1/chat/completions', { 'User-Agent': 'KimiCLI/2.1.1' }, CHAT({ prompt_cache_key: 'S-kimi' }), 'chat',
    { session: 'S-kimi', wire: 'openai-chat', vendor: 'moonshot', effect: null }],
  ['dsh', 'deepseek-dsh', 'api.deepseek.com', '/anthropic/v1/messages', { 'User-Agent': 'node', 'x-deepseek-harness-session-id': 'S-dsh', 'x-deepseek-harness-user-id': 'u' },
    ANTH({ dsh_session_log: { session: { id: 'S-dsh', origin: 'main' } }, dsh_plugin_packages: [{ name: 'asight-trust', version: '1' }] }), 'anthropic',
    { session: 'S-dsh', wire: 'anthropic', vendor: 'deepseek', effect: ['dsh-plugin'] }],
  ['hermes', 'hermes', 'openrouter.ai', '/api/v1/chat/completions', { 'User-Agent': 'OpenAI/Python 1.109.1' }, CHAT({ session_id: 'S-hermes' }), 'chat',
    { session: 'S-hermes', wire: 'openai-chat', vendor: 'openrouter', effect: null }],
  ['zcode', 'z-code', 'api.z.ai', '/api/paas/v4/chat/completions', { 'User-Agent': 'node', 'x-session-id': 'S-zc', 'x-zcode-session-type': 'main' }, CHAT(), 'chat',
    { session: 'S-zc', wire: 'openai-chat', vendor: 'zai', effect: ['zcode-node-https'] }],
];

async function exchange(store, { agent, host, target, headers, body, reply }) {
  const flow = { id: 'f-' + agent, host, scheme: 'https', dst: { address: '127.0.0.1', port: 443 }, proc: { pid: 4242, exe: '/x/' + agent, agent } };
  const b = JSON.stringify(body);
  const head = `POST ${target} HTTP/1.1\r\nHost: ${host}\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
    + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\n\r\n`;
  const r = REPLY[reply];
  const up = `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(r)}\r\n\r\n${r}`;
  const tee = createExchangeTee({ flow, recordStore: { envelope: (e) => store.envelope(e) } });
  tee.fromClient(Buffer.from(head + b));
  tee.fromUpstream(Buffer.from(up));
  await sleep(3);
}

// All real I/O first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-seven-'));
const store = createRecordStore({ root, onError: (e) => { throw e; } });
for (const [, agent, host, target, headers, body, reply] of HARNESSES) await exchange(store, { agent, host, target, headers, body, reply });
// Hermes on a custom endpoint carries no session key at all (3.4: synthesized later, gate G11)
await exchange(store, { agent: 'hermes', host: 'relay.example.com', target: '/v1/chat/completions', headers: { 'User-Agent': 'OpenAI/Python 1.109.1' }, body: CHAT(), reply: 'chat' });
store.close();
const { server } = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: root });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const { port } = server.address();
const get = (p) => new Promise((resolve, reject) => http.request({ host: '127.0.0.1', port, path: p }, (res) => {
  let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve(JSON.parse(s)));
}).on('error', reject).end());
const PROJECTS = await get('/api/projects');
const LISTED = new Map(PROJECTS.projects.flatMap((p) => p.sessions).map((s) => [s.session_id, s]));
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const [id, agent, , , , body, , want] of HARNESSES) {
  test(`${id}: listed under its harness name, rendered by its wire, labelled with its vendor and observer effect`, async () => {
    const s = LISTED.get(want.session);
    assert.ok(s, `${id}'s session ${want.session} is listed (got ${[...LISTED.keys()].join(', ')})`);
    assert.deepEqual([s.harness, s.harness_inferred, s.calls], [id, false, 1], `proc.agent '${agent}' names the harness`);
    const v = await get(`/api/session?id=${encodeURIComponent(want.session)}`);
    assert.equal(v.analyzed.unknown, undefined, 'nothing in it is unrecognized');
    const c = v.analyzed.steps[0];
    assert.deepEqual([c.wire.format, c.wire.vendor, c.wire.transport, c.wire.contextState], [want.wire, want.vendor, 'http', 'complete']);
    assert.deepEqual(c.wire.observerEffect && c.wire.observerEffect.map((e) => e.id), want.effect);
    assert.ok(c.flat.length >= 3, 'its blocks are drawn');
    const wireBody = JSON.stringify(body);
    for (const b of c.flat) {
      assert.ok(b.text_ref, `${b.sec}/${b.kind} has a locator`);
      const { start, end } = parseTextRef(b.text_ref);
      const got = await get(`/api/block?ref=${encodeURIComponent(b.text_ref)}`);
      assert.equal(got.text, wireBody.slice(start, end), 'every block resolves to the bytes the agent sent (diff = 0)');
    }
  });
}

test('hermes on a custom endpoint is listed as its own session, grouped by a synthesized key (3.4 合成键, gate G11)', async () => {
  assert.equal(LISTED.size, HARNESSES.length + 1);
  const synth = [...LISTED.values()].filter((s) => /^synth-hermes-/.test(s.session_id));
  assert.equal(synth.length, 1, 'the key-less call has a synthesized session');
  assert.deepEqual([synth[0].harness, synth[0].session_synthesized, synth[0].calls], ['hermes', true, 1]);
  assert.ok([...LISTED.values()].filter((s) => s !== synth[0]).every((s) => s.session_synthesized === false), 'a real key is never called a guess');
  const v = await get(`/api/session?id=${encodeURIComponent(synth[0].session_id)}`);
  assert.equal(v.analyzed.steps.length, 1);
  assert.ok(v.analyzed.steps[0].flat.length >= 2, 'it renders like any Chat call');
  const ctl = await get('/api/control');
  assert.equal(ctl.classes.reduce((a, c) => a + c.count, 0), 0, 'so it is no longer control traffic');
});
