// test/adapters/openai-responses.test.mjs — the second ETL adapter (closes 3.1 #2): OpenAI Responses over
// HTTP, generated from the board's dissector (D25), on REAL collector envelopes (tee-proxy → mock upstream).
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
import { dissectorAdapter } from '../../src/adapters/dissected.mjs';
import { RESPONSES, normResp } from '../../src/dissect/openai.mjs';
import { freshConn, countOf } from '../etl/helpers.mjs';
import { contentHash } from '../../src/adapters/content-hash.mjs';

const T = { timeout: 15000 };
const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
// odd spacing inside tools[0] on purpose: a re-serialization would lose it
const BODY = '{"model":"gpt-test-1","stream":true,"instructions":"You are Codex.","tools":[{"type":"function","name":"shell", "parameters":{"type":"object"}}],' +
  '"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"reasoning","summary":[],"encrypted_content":"gAAA"}],' +
  '"prompt_cache_key":"CX1","reasoning":{"effort":"high"}}';
const CODEX = { host: 'chatgpt.com', proc: { pid: 41, exe: '/x/codex', agent: 'codex' } };

async function captured(t, { body = BODY, headers = { 'session-id': 'CX1', 'thread-id': 'TH1' }, flow = CODEX } = {}) {
  const up = await startMockUpstream(); t.after(() => up.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-oa-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const px = await startTeeProxy({ upstreamPort: up.port, dir, flow }); t.after(() => px.close());
  await request(`http://127.0.0.1:${px.port}`, '/backend-api/codex/responses', body, { headers }).catch(() => null); // a fault scenario resets the socket
  await waitFor(() => px.envelopes.length === 1, 5000);
  return { records: (await Promise.all(px.files().map((f) => readRecords(f)))).flat(), dir, log: await readMockLog(up) };
}

test('Responses HTTP envelope from the mock: AC-1 diff=0, AC-2 usage, wire_format openai-responses', T, async (t) => {
  const { records, dir, log } = await captured(t);
  const conn = await freshConn();
  const stats = await runEtl(records, conn);
  assert.equal(stats.quarantined, 0, 'claimed, not quarantined');
  const id = String(records[0].id);
  const c = (await rows(conn, `SELECT session_id, wire_format, vendor, context_state, class, lane, error FROM calls WHERE call_id='${id}'`))[0];
  assert.deepEqual([c.session_id, c.wire_format, c.vendor, c.context_state, c.class, c.lane, c.error], ['CX1', 'openai-responses', 'openai', 'complete', 'llm', 'main', null]);
  // AC-1: rebuilt through the PRODUCTION resolver; each block JSON-equals a unit of what the mock received, in order
  const rebuilt = await rebuildContext(conn, id, await buildResolver([dir]));
  assert.ok(rebuilt.length >= 4 && rebuilt.every((b) => b.source_status === 'ok' && b.source_fidelity === 'verbatim'));
  const mockBody = JSON.parse(findHttpExchange(log, records[0].req_body).request.body.toString('utf8'));
  const problems = [];
  assert.equal(walkUnits(unitsOf('openai-responses', mockBody), rebuilt.map((b) => JSON.parse(b.text)), problems), 4);
  assert.deepEqual(problems, []);
  assert.equal(rebuilt[0].text, '{"type":"function","name":"shell", "parameters":{"type":"object"}}', 'odd spacing kept: not a re-serialization');
  // AC-2: the usage row equals mapUsage over the mock's response.completed usage
  const want = mapUsage('openai-responses', normResp(records[0]).usage);
  assert.ok(want.total_input > 0, 'precondition: the mock reported usage');
  const u = (await rows(conn, `SELECT input_uncached, cache_read, cache_write, output, total_input FROM usage WHERE call_id='${id}'`))[0];
  assert.deepEqual([u.input_uncached, u.cache_read, u.cache_write, u.output, u.total_input].map((x) => (x == null ? x : Number(x))),
    [want.input_uncached, want.cache_read, want.cache_write, want.output, want.total_input]);
  assert.equal(await countOf(conn, `SELECT count(*) n FROM cache_events WHERE call_id='${id}'`), 1);
});

test('collectExtra invariant on a Responses envelope (envelope and req_body layers)', T, async (t) => {
  const { records } = await captured(t);
  const call = dissectorAdapter(RESPONSES, { name: 'openai-responses' }).parseCall(records[0]);
  const body = JSON.parse(records[0].req_body);
  const unmappedBody = Object.keys(call.extra).filter((k) => k.startsWith('req_body.')).map((k) => k.slice(9)).sort();
  assert.deepEqual(unmappedBody, ['prompt_cache_key', 'reasoning'], 'canonical ∪ extra == body keys');
  assert.deepEqual([...RESPONSES.consumedBody, ...unmappedBody].sort(), Object.keys(body).sort());
  assert.equal(call.unmapped_count, Object.keys(call.extra).length);
  assert.deepEqual(Object.keys(call.extra).filter((k) => !k.startsWith('req_body.')), [], 'every envelope key of a collector record is understood');
});

test('a novel req_body field lands in extra.req_body and bumps unmapped_count by 1', () => {
  const rec = (b) => ({ id: 'x', endpoint: '/v1/responses', is_llm_call: true, req_headers: {}, req_body: JSON.stringify(b), resp: { kind: 'sse', raw_sse: [] } });
  const a = dissectorAdapter(RESPONSES, { name: 'r' });
  const base = a.parseCall(rec({ model: 'm', input: [] }));
  const novel = a.parseCall(rec({ model: 'm', input: [], novel_probe: 42 }));
  assert.equal(novel.unmapped_count, base.unmapped_count + 1);
  assert.equal(novel.extra['req_body.novel_probe'], 42);
});

test('a mid-stream reset from the mock is an error row, not success', T, async (t) => {
  const { records } = await captured(t, { headers: { 'session-id': 'CX1', 'x-mock-scenario': 'mid-stream-reset' } });
  const conn = await freshConn();
  await runEtl(records, conn);
  assert.equal((await rows(conn, `SELECT error FROM calls WHERE call_id='${records[0].id}'`))[0].error, 'true');
  assert.equal(await countOf(conn, 'SELECT count(*) n FROM usage'), 0, 'no usage on the wire → no usage row, never fabricated zeros');
  assert.equal(await countOf(conn, 'SELECT count(*) n FROM cache_events'), 0);
});

test('a stream whose terminal says failed is an error row (the dissector\'s failed hook)', () => {
  const rec = { id: 'f', endpoint: '/v1/responses', is_llm_call: true, req_headers: {}, req_body: '{"model":"m","input":[]}',
    resp: { kind: 'sse', status: 200, raw_sse: [{ type: 'response.failed', response: { id: 'r', status: 'failed', output: [] } }] } };
  const call = dissectorAdapter(RESPONSES, { name: 'r' }).parseCall(rec);
  assert.deepEqual([call.error, call.stop_reason, call.usage], [true, 'failed', null]);
});

test('content_hash is over the verbatim span, never a re-serialization (D19)', () => {
  const rec = { id: 'h', endpoint: '/v1/responses', is_llm_call: true, req_headers: {}, req_body: BODY, resp: {} };
  const [tool] = dissectorAdapter(RESPONSES, { name: 'r' }).parseBlocks(rec);
  const verbatim = '{"type":"function","name":"shell", "parameters":{"type":"object"}}';
  assert.equal(tool.content_hash, contentHash(verbatim));
  assert.notEqual(tool.content_hash, contentHash(JSON.stringify(JSON.parse(verbatim))));
});

test('an error envelope (resp.kind error) is an error row even without a top-level error field', () => {
  const rec = { id: 'e', endpoint: '/v1/responses', is_llm_call: true, req_headers: {}, req_body: '{"model":"m","input":[]}', resp: { kind: 'error', status: 200 } };
  assert.equal(dissectorAdapter(RESPONSES, { name: 'r' }).parseCall(rec).error, true);
});

test('encrypted reasoning items are faithfulness=opaque', T, async (t) => {
  const { records } = await captured(t);
  const blocks = dissectorAdapter(RESPONSES, { name: 'r' }).parseBlocks(records[0]);
  assert.deepEqual(blocks.filter((b) => b.kind === 'thinking').map((b) => b.faithfulness), ['opaque']);
  assert.deepEqual(blocks.filter((b) => b.kind !== 'thinking').map((b) => b.faithfulness), ['verbatim', 'verbatim', 'verbatim']);
});

test('a block with no verbatim span keeps no text_ref and says why', () => {
  const rec = { id: 'u', endpoint: '/v1/responses', is_llm_call: true, req_headers: {}, req_body: '{"model":"m","input":[{"role":"user","content":"hi"}', resp: {} };
  const a = dissectorAdapter(RESPONSES, { name: 'r' });
  assert.deepEqual(a.parseBlocks(rec), [], 'an unparseable body yields no blocks, not guessed ones');
  const ok = { ...rec, req_body: '{"model":"m","input":[{"role":"user","content":"hi"}]}' };
  const at = ok.req_body.indexOf('"hi"');
  assert.deepEqual(a.parseBlocks(ok).map((b) => [b.text, b.text_ref, b.extra]), [['"hi"', [at, at + 4], {}]]);
});

test('observer_effect on a transparent Codex call (R5)', T, async (t) => {
  const { records } = await captured(t);
  const conn = await freshConn();
  await runEtl(records, conn);
  assert.deepEqual(JSON.parse((await rows(conn, 'SELECT observer_effect FROM calls'))[0].observer_effect).map((e) => e.id), ['codex-rustls-h2']);
});

const codexRec = (id, sec, headers, pid = 9, extra = {}) => ({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, endpoint: '/v1/responses', method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'api.openai.com', proc: { pid, exe: '/x/codex', agent: 'codex' }, req_headers: headers,
  req_body: JSON.stringify({ model: 'gpt-x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: id }] }] }),
  resp: { kind: 'sse', status: 200, raw_sse: [{ type: 'response.completed', response: { id: 'r' + id, status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } } }] },
  ...extra });

test('Codex x-codex-parent-thread-id sets sessions.parent_session_id (alias-resolved through thread-id)', async () => {
  const conn = await freshConn();
  await runEtl([codexRec('p', 1, { 'session-id': 'PARENT', 'thread-id': 'T-PARENT' }),
    codexRec('c', 2, { 'session-id': 'CHILD', 'thread-id': 'T-CHILD', 'x-codex-parent-thread-id': 'T-PARENT', 'x-openai-subagent': 'review' })], conn);
  assert.equal((await rows(conn, "SELECT parent_session_id FROM sessions WHERE session_id='CHILD'"))[0].parent_session_id, 'PARENT');
  assert.equal((await rows(conn, "SELECT lane FROM calls WHERE call_id='c'"))[0].lane, 'subagent');
});

test('one Codex pid serving two sessions writes two sessions', async () => {
  const conn = await freshConn();
  await runEtl([codexRec('a', 1, { 'session-id': 'A' }), codexRec('b', 2, { 'session-id': 'B' }), codexRec('d', 3, { 'session-id': 'A' }, 10)], conn);
  assert.deepEqual((await rows(conn, 'SELECT session_id FROM sessions ORDER BY 1')).map((r) => r.session_id), ['A', 'B']);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM calls WHERE session_id='A'"), 2);
});

test('a Codex compaction request (request_kind=compaction) is a compaction; a prewarm is lane probe', async () => {
  const conn = await freshConn();
  const meta = (k) => ({ 'session-id': 'S', 'x-codex-turn-metadata': JSON.stringify({ request_kind: k }) });
  await runEtl([codexRec('w', 1, meta('prewarm')), codexRec('m', 2, { 'session-id': 'S' }), codexRec('k', 3, meta('compaction'))], conn);
  const r = await rows(conn, 'SELECT call_id, lane, compaction FROM calls ORDER BY call_id');
  assert.deepEqual(r.map((x) => [x.call_id, x.lane, x.compaction]), [['k', 'main', true], ['m', 'main', false], ['w', 'probe', false]]);
});
