// test/adapters/openai-chat.test.mjs — Chat Completions rows (3.1 #2, 3.2 AC-2b DeepSeek / Kimi case) from a REAL
// collector envelope (tee-proxy → mock upstream), and `reasoning_content` as a verbatim thinking block.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from '../lab/mock-upstream/server.mjs';
import { request, waitFor } from '../lab/helpers.mjs';
import { startTeeProxy } from '../helpers/tee-proxy.mjs';
import { readMockLog, findHttpExchange, unitsOf, walkUnits } from '../lab/verbatim-check.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { runEtl, rebuildContext } from '../../src/etl/orchestrator.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { mapUsage } from '../../src/model/schema.mjs';
import { boardFlatChat, normRespChat, canonUsageChat, CHAT } from '../../src/dissect/openai.mjs';
import { dissectorAdapter } from '../../src/adapters/dissected.mjs';
import { freshConn } from '../etl/helpers.mjs';

const T = { timeout: 15000 };
const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const BODY = '{"model":"kimi-k2","stream":true,"stream_options":{"include_usage":true},"prompt_cache_key":"KM1",' +
  '"messages":[{"role":"system","content":"You are Kimi."},{"role":"user","content":"q1"},' +
  '{"role":"assistant","content":"a1","reasoning_content":"thought about q1"},{"role":"user","content":[{"type":"text","text":"q2"}]}],' +
  '"tools":[{"type":"function","function":{"name":"bash","parameters":{"type":"object"}}}]}';

test('Chat envelope from the mock: AC-1 diff=0, AC-2 usage (DeepSeek-style split), Kimi body key, vendor from host', T, async (t) => {
  const up = await startMockUpstream(); t.after(() => up.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-chat-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const px = await startTeeProxy({ upstreamPort: up.port, dir, flow: { host: 'api.moonshot.cn', proc: { pid: 51, exe: '/x/kimi', agent: 'kimi-code' } } });
  t.after(() => px.close());
  await request(`http://127.0.0.1:${px.port}`, '/v1/chat/completions', BODY);
  await waitFor(() => px.envelopes.length === 1, 5000);
  const records = (await Promise.all(px.files().map((f) => readRecords(f)))).flat();
  const conn = await freshConn();
  const stats = await runEtl(records, conn);
  assert.equal(stats.quarantined, 0);
  const id = String(records[0].id);
  const c = (await rows(conn, `SELECT session_id, wire_format, vendor, context_state, observer_effect FROM calls WHERE call_id='${id}'`))[0];
  assert.deepEqual([c.session_id, c.wire_format, c.vendor, c.context_state, c.observer_effect], ['KM1', 'openai-chat', 'moonshot', 'complete', null]);
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose());
  const rebuilt = await rebuildContext(conn, id, resolve);
  assert.ok(rebuilt.every((b) => b.source_status === 'ok' && b.source_fidelity === 'verbatim'));
  const mockBody = JSON.parse(findHttpExchange(await readMockLog(up), records[0].req_body).request.body.toString('utf8'));
  const problems = [];
  const values = rebuilt.map((b) => JSON.parse(b.text));
  assert.equal(walkUnits(unitsOf('openai-chat', mockBody), values, problems), 5); // tools[0], sys, q1, a1, q2 part
  assert.deepEqual(problems, []);
  const think = rebuilt.find((b) => b.kind === 'thinking');
  assert.deepEqual([think && think.text, think && think.faithfulness], ['"thought about q1"', 'verbatim'], 'reasoning_content is a verbatim thinking block');
  const usage = normRespChat(records[0]).usage;
  assert.ok(usage.prompt_cache_miss_tokens != null, 'precondition: the mock reported the DeepSeek-style split');
  const want = mapUsage('openai-chat', usage);
  const u = (await rows(conn, `SELECT cache_read, input_uncached, cache_write, total_input FROM usage WHERE call_id='${id}'`))[0];
  assert.deepEqual([Number(u.cache_read), Number(u.input_uncached), u.cache_write, Number(u.total_input)], [want.cache_read, want.input_uncached, null, want.total_input]);
});

test('collectExtra invariant on a Chat envelope (envelope and req_body layers)', () => {
  const rec = { id: 'c1', endpoint: '/v1/chat/completions', is_llm_call: true, req_headers: {}, req_body: BODY, resp: { kind: 'sse', raw_sse: [] } };
  const call = dissectorAdapter(CHAT, { name: 'openai-chat' }).parseCall(rec);
  const unmapped = Object.keys(call.extra).filter((k) => k.startsWith('req_body.')).map((k) => k.slice(9)).sort();
  assert.deepEqual(unmapped, ['prompt_cache_key', 'stream_options']);
  assert.deepEqual([...CHAT.consumedBody, ...unmapped].sort(), Object.keys(JSON.parse(BODY)).sort(), 'canonical ∪ extra == body keys');
  assert.equal(call.unmapped_count, Object.keys(call.extra).length);
});

test('reasoning_content renders as a thinking block on the board, before that turn\'s reply text', () => {
  const flat = boardFlatChat(JSON.parse(BODY));
  assert.deepEqual(flat.filter((b) => b.sec === 'messages').map((b) => [b.role, b.kind]),
    [['user', 'text'], ['assistant', 'thinking'], ['assistant', 'text'], ['user', 'text']]);
  assert.deepEqual(flat.find((b) => b.kind === 'thinking').path, ['messages', 2, 'reasoning_content']);
});

test('normRespChat accumulates streamed reasoning_content and reads Kimi usage inside choices', () => {
  const rec = { resp: { kind: 'sse', raw_sse: [
    { choices: [{ index: 0, delta: { reasoning_content: 'th' } }] }, { choices: [{ index: 0, delta: { reasoning_content: 'ink' } }] },
    { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop', usage: { prompt_tokens: 9, completion_tokens: 1, cached_tokens: 4 } }] },
  ] } };
  const n = normRespChat(rec);
  assert.deepEqual([n.thinking, n.text, n.usage.prompt_tokens], ['think', 'ok', 9]);
  assert.equal(normRespChat({ resp: { kind: 'sse', raw_sse: [{ choices: [{ index: 0, delta: { content: 'x' } }] }] } }).thinking, undefined, 'no reasoning → no thinking');
});

test('the board\'s canonical Chat usage prefers DeepSeek hit/miss over cached_tokens', () => {
  const ds = canonUsageChat({ prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 260 });
  assert.deepEqual([ds.read, ds.fresh, ds.out], [640, 260, 30]);
  assert.deepEqual(canonUsageChat({ prompt_tokens: 9, cached_tokens: 4 }).read, 4, 'Kimi names it at the top level');
});

test('a Chat record with no usage on the wire writes no usage row', async () => {
  const conn = await freshConn();
  await runEtl([{ id: 'n1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/v1/chat/completions', is_llm_call: true, capture: 'transparent', host: 'api.deepseek.com',
    proc: { pid: 1, exe: '/x/hermes', agent: 'hermes' }, req_headers: {}, req_body: JSON.stringify({ model: 'm', session_id: 'H', messages: [{ role: 'user', content: 'q' }] }),
    resp: { kind: 'sse', status: 200, raw_sse: [{ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }] }] } }], conn);
  assert.deepEqual((await rows(conn, 'SELECT session_id, vendor FROM calls')).map((x) => [x.session_id, x.vendor]), [['H', 'deepseek']]);
  assert.equal((await rows(conn, 'SELECT count(*) AS n FROM usage'))[0].n, 0n);
});
