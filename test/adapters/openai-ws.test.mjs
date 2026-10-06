// test/adapters/openai-ws.test.mjs — Codex over WebSocket in DuckDB (RFC 4.6 W3 / W5 / W7, 3.2:52 / 3.2:124,
// 3.2 #4 dedup, 4.2 #2 incremental == full), on REAL collector WebSocket envelopes: a WebSocket client → the
// collector's exchange tee + WebSocket recorder + record store (test/helpers/tee-proxy.mjs) → the lab mock.
// Every expected context comes from the mock's byte log, never from asight's parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from '../lab/mock-upstream/server.mjs';
import { waitFor } from '../lab/helpers.mjs';
import { wsConnect } from '../lab/ws-client.mjs';
import { startTeeProxy } from '../helpers/tee-proxy.mjs';
import { readMockLog, wsConnIds, wsMessagesOf, expectedWsContexts, unitsOf, walkUnits } from '../lab/verbatim-check.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { runEtl, rebuild, rebuildContext, parseTextRef } from '../../src/etl/orchestrator.mjs';
import { quarantineReason } from '../../src/adapters/envelope.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { freshConn, dumpAll, countOf } from '../etl/helpers.mjs';

const T = { timeout: 20000 };
const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const CODEX_TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }];
const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
const create = (f) => JSON.stringify({ type: 'response.create', model: 'gpt-test-1', store: false, stream: true, instructions: 'You are Codex. '.repeat(20),
  tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], ...f });

// warmup → C1 (input:[]) → C2 (two new items) → C3 (one new item). Per-record input lengths in the main lane are
// 0, 2, 1: a per-record count would see a 2 → 1 drop at C3 and flag a false compaction.
async function session(t) {
  const up = await startMockUpstream(); t.after(() => up.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-wse-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const px = await startTeeProxy({ upstreamPort: up.port, dir, wsTerminal: CODEX_TERMINAL, flow: { host: 'chatgpt.com', proc: { pid: 61, exe: '/x/codex', agent: 'codex' } } });
  t.after(() => px.close());
  const c = await wsConnect(px.port, { path: '/backend-api/codex/responses', extensions: 'permessage-deflate', headers: { 'session-id': 'WS1' } });
  await c.sendText(create({ input: [user('ctx'), user('q1')], generate: false }));
  const w = (await c.events()).at(-1).response;
  await c.sendText(create({ input: [], previous_response_id: w.id }));
  const r1 = (await c.events()).at(-1).response;
  await c.sendText(create({ input: [user('q2'), user('q2b')], previous_response_id: r1.id }));
  const r2 = (await c.events()).at(-1).response;
  await c.sendText(create({ input: [user('q3')], previous_response_id: r2.id }));
  await c.events();
  await waitFor(() => px.envelopes.filter((e) => e.transport === 'ws').length === 4, 5000);
  assert.deepEqual(px.failures, [], 'the recorder reported no capture failure');
  const records = (await Promise.all(px.files().map((f) => readRecords(f)))).flat().filter((r) => r.transport === 'ws');
  return { records, dir, log: await readMockLog(up) };
}

test('W7 multi-turn WS: rebuildContext equals the mock\'s stitched input, through refs into earlier records', T, async (t) => {
  const { records, dir, log } = await session(t);
  const conn = await freshConn();
  const stats = await runEtl(records, conn);
  assert.equal(stats.quarantined, 0);
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose());
  const { contexts } = expectedWsContexts(wsMessagesOf(log, wsConnIds(log)[0], records[0].ws_ext));
  assert.equal(contexts.length, records.length);
  let elsewhere = 0;
  for (const [i, r] of records.entries()) {
    const rebuilt = await rebuildContext(conn, String(r.id), resolve);
    assert.ok(rebuilt.length > 0 && rebuilt.every((b) => b.source_status === 'ok'), `call ${i}: every block resolves (cross-record refs)`);
    const problems = [];
    const body = JSON.parse(contexts[i].text);
    walkUnits(unitsOf('openai-responses', { ...body, input: contexts[i].input }), rebuilt.map((b) => JSON.parse(b.text)), problems);
    assert.deepEqual(problems, [], `call ${i}`);
    const refs = (await rows(conn, `SELECT bc.text_ref FROM call_blocks cb JOIN block_contents bc USING (content_hash) WHERE cb.call_id='${r.id}'`)).map((x) => x.text_ref);
    elsewhere += refs.filter((ref) => parseTextRef(ref).recordId !== String(r.id) || parseTextRef(ref).field).length;
  }
  assert.ok(elsewhere > 0, 'some blocks are addressed in earlier records / server messages');
  const cs = await rows(conn, 'SELECT context_state, transport, wire_format FROM calls ORDER BY ts, call_id');
  assert.deepEqual(cs.map((c) => [c.context_state, c.transport, c.wire_format]),
    [['complete', 'ws', 'openai-responses-ws'], ['reconstructed', 'ws', 'openai-responses-ws'], ['reconstructed', 'ws', 'openai-responses-ws'], ['reconstructed', 'ws', 'openai-responses-ws']]);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM sessions WHERE session_id = 'WS1' AND harness = 'codex'"), 1);
});

test('W3: warmup lane=probe, not counted as a turn; stitched message counts mean no false compaction', T, async (t) => {
  const { records } = await session(t);
  const conn = await freshConn();
  await runEtl(records, conn);
  const r = await rows(conn, 'SELECT lane, compaction FROM calls ORDER BY ts, call_id');
  assert.deepEqual(r.map((x) => x.lane), ['probe', 'main', 'main', 'main']);
  assert.deepEqual(r.map((x) => x.compaction), [false, false, false, false], 'C3 sends fewer new items than C2; its stitched context is longer');
  assert.equal(await countOf(conn, "SELECT count(*) n FROM calls WHERE lane = 'main'"), 3, 'turns = main-lane calls; the warmup is not one');
  assert.equal(await countOf(conn, 'SELECT count(*) n FROM usage'), 4, 'the warmup\'s usage row is written: it is what the wire reported (gate G8)');
});

test('W5: calls whose predecessor is missing are partial, with NULL prefix_sha256 and ground_truth_flag', T, async (t) => {
  const { records } = await session(t);
  const conn = await freshConn();
  await runEtl(records.slice(1), conn); // the warmup envelope is gone: C1 names a response nobody recorded
  const r = await rows(conn, 'SELECT c.context_state, e.prefix_sha256, e.ground_truth_flag FROM calls c JOIN cache_events e USING (call_id) ORDER BY c.ts, c.call_id');
  assert.deepEqual(r.map((x) => [x.context_state, x.prefix_sha256, x.ground_truth_flag]),
    [['partial', null, null], ['partial', null, null], ['partial', null, null]]);
  const ex = await rows(conn, 'SELECT extra FROM calls ORDER BY ts, call_id');
  assert.ok(ex.every((x) => /previous_response_id/.test(JSON.parse(x.extra).missing_predecessor || '')), 'the missing response is named per call');
});

test('reconstructed WS calls keep an authoritative prefix_sha256 (3.2:124)', T, async (t) => {
  const { records } = await session(t);
  const conn = await freshConn();
  await runEtl(records, conn);
  const r = await rows(conn, "SELECT e.prefix_sha256 FROM calls c JOIN cache_events e USING (call_id) WHERE c.lane = 'main' ORDER BY c.ts, c.call_id");
  assert.equal(r[0].prefix_sha256, null, 'C1 is the first call in its lane: no reusable prefix');
  assert.match(r[1].prefix_sha256 || '', /^[0-9a-f]{64}$/);
  assert.match(r[2].prefix_sha256 || '', /^[0-9a-f]{64}$/);
});

test('WS: instructions and tools resent on every message are stored once', T, async (t) => {
  const { records } = await session(t);
  const conn = await freshConn();
  await runEtl(records, conn);
  assert.equal(await countOf(conn, "SELECT count(DISTINCT cb.content_hash) n FROM call_blocks cb JOIN block_contents bc USING (content_hash) WHERE bc.section = 'system'"), 1);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM call_blocks cb JOIN block_contents bc USING (content_hash) WHERE bc.section = 'system'"), 4);
  assert.ok(await countOf(conn, 'SELECT count(*) n FROM block_contents') < await countOf(conn, 'SELECT count(*) n FROM call_blocks'));
});

test('WS: incremental ETL == full rebuild', T, async (t) => {
  const { records } = await session(t);
  const inc = await freshConn();
  await runEtl(records.slice(0, 2), inc);
  await runEtl(records, inc);
  const full = await freshConn();
  await rebuild(records, full);
  assert.deepEqual(await dumpAll(inc), await dumpAll(full));
  assert.deepEqual((await rows(inc, 'SELECT context_state FROM calls ORDER BY ts, call_id')).map((x) => x.context_state),
    ['complete', 'reconstructed', 'reconstructed', 'reconstructed'], 'the second run re-walks the chain from the start');
});

test('a record of the WebSocket wire that is no call is quarantined as not-a-call, never ingested or dropped', async () => {
  const base = { ts_request: '2026-10-06T00:00:00Z', endpoint: '/backend-api/codex/responses', is_llm_call: true, transport: 'ws', flow_id: 'f', seq: 1,
    req_headers: { 'session-id': 'S' }, proc: { pid: 1, exe: '/x/codex', agent: 'codex' }, resp: { kind: 'ws', messages: [] } };
  const push = { ...base, id: 'p1', req_body: null, resp: { kind: 'ws', messages: ['{"type":"codex.rate_limits"}'] } };   // W14
  const other = { ...base, id: 'o1', req_body: '{"type":"response.interrupt"}' };                                         // no response.create
  assert.deepEqual([quarantineReason(push), quarantineReason(other)], ['not-a-call:openai-responses-ws', 'not-a-call:openai-responses-ws']);
  const conn = await freshConn();
  const stats = await runEtl([push, other], conn);
  assert.equal(stats.quarantined, 2);
  assert.deepEqual((await rows(conn, 'SELECT id, reason FROM etl_quarantine ORDER BY id')).map((x) => [x.id, x.reason]),
    [['o1', 'not-a-call:openai-responses-ws'], ['p1', 'not-a-call:openai-responses-ws']]);
});
