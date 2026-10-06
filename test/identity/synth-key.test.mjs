// test/identity/synth-key.test.mjs — 3.4 合成键 (gate G11 default): system-prompt hash + time window,
// never pid or connection; the board and the ETL give one capture the same keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynthKeys, stampSynthKeys, SYNTH_GAP_MS, systemTextOf } from '../../src/dissect/synth-key.mjs';
import { groupSessions, projectsView, controlView } from '../../src/view/board.mjs';
import { runEtl, rebuild } from '../../src/etl/orchestrator.mjs';
import { freshConn, dumpAll } from '../etl/helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';

const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const at = (min) => new Date(Date.UTC(2026, 9, 6, 0, min)).toISOString();
// Hermes on a custom endpoint, Anthropic wire: no session key anywhere.
const hermes = (id, min, sys, { pid = 7, flow = 'F1', agent = 'hermes', body = {} } = {}) => ({
  id, ts_request: at(min), endpoint: '/v1/messages', method: 'POST', is_llm_call: true, capture: 'transparent', host: 'llm.internal.test',
  flow_id: flow, proc: { pid, exe: '/x/hermes', agent }, req_headers: {},
  req_body: JSON.stringify({ model: 'm', ...(sys == null ? {} : { system: sys }), messages: [{ role: 'user', content: id }], ...body }),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 5, output_tokens: 1 } } });

test('consecutive requests of one Hermes task form one session; a new system prompt or a 30-minute gap starts another', () => {
  const k = createSynthKeys();
  const keys = [hermes('a', 0, 'TASK-1'), hermes('b', 5, 'TASK-1'), hermes('c', 6, 'TASK-2'), hermes('d', 40, 'TASK-1'), hermes('e', 41, 'TASK-2')].map((r) => k.keyOf(r));
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[2], keys[0], 'another system prompt is another task');
  assert.notEqual(keys[3], keys[0], `a gap over ${SYNTH_GAP_MS / 60000} minutes starts a new session`);
  assert.notEqual(keys[4], keys[2], 'TASK-2 resumed 35 minutes after its last call is a new session');
  assert.match(keys[0], /^synth-hermes-[0-9a-f]{12}-20261006T000000Z$/);
  assert.match(keys[3], /-20261006T004000Z$/, 'the key carries the first call of ITS session');
});

test('the window runs from the group\'s latest call: a long task with no 30-minute pause stays one session', () => {
  const k = createSynthKeys();
  const keys = [0, 25, 50, 75].map((m) => k.keyOf(hermes('t' + m, m, 'LONG')));
  assert.equal(new Set(keys).size, 1);
});

test('never by pid or connection: interleaved tasks on one pid stay apart; one task across two pids stays one', () => {
  const k = createSynthKeys();
  const a1 = k.keyOf(hermes('a1', 0, 'TASK-A', { pid: 1, flow: 'F1' }));
  const b1 = k.keyOf(hermes('b1', 1, 'TASK-B', { pid: 1, flow: 'F1' }));
  const a2 = k.keyOf(hermes('a2', 2, 'TASK-A', { pid: 2, flow: 'F9' }));
  assert.notEqual(a1, b1);
  assert.equal(a1, a2);
});

test('a real key always wins: Kimi with a body key, or any harness without synth, is never synthesized', () => {
  const k = createSynthKeys();
  assert.equal(k.keyOf(hermes('k1', 0, 'S', { agent: 'kimi-code', body: { metadata: { user_id: 'K1' } } })), null);
  assert.match(k.keyOf(hermes('k2', 0, 'S', { agent: 'kimi-code' })), /^synth-kimi-/);
  assert.equal(k.keyOf(hermes('h1', 0, 'S', { body: { session_id: 'HS' } })), null, 'Hermes via OpenRouter has its body key');
  assert.equal(k.keyOf(hermes('o1', 0, 'S', { agent: 'opencode' })), null, 'OpenCode has header keys; a keyless OpenCode call stays unkeyed');
  assert.equal(k.keyOf({ ...hermes('n1', 0, 'S'), is_llm_call: false }), null, 'non-inference traffic is never given a session (3.4 D9)');
  assert.equal(k.keyOf({ ...hermes('x1', 0, 'S'), proc: undefined }), null, 'a record without proc is not a known synth harness');
});

test('the anchor is the first system text of whichever wire the call used', () => {
  assert.equal(systemTextOf({ system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }), 'AB');
  assert.equal(systemTextOf({ system: 'S' }), 'S');
  assert.equal(systemTextOf({ instructions: 'I', input: [] }), 'I');
  assert.equal(systemTextOf({ messages: [{ role: 'developer', content: [{ type: 'text', text: 'D' }] }, { role: 'user', content: 'u' }] }), 'D');
  assert.equal(systemTextOf({ messages: [{ role: 'user', content: 'u' }] }), '');
  assert.equal(systemTextOf(null), '');
});

test('every class=llm Hermes custom-endpoint call gets a session_id, even without a system prompt', async () => {
  const conn = await freshConn();
  await runEtl([hermes('a', 0, 'TASK-1'), hermes('b', 1, null), hermes('c', 2, null)], conn);
  const r = await rows(conn, "SELECT call_id, session_id FROM calls WHERE class = 'llm' ORDER BY call_id");
  assert.ok(r.every((x) => x.session_id), 'no llm call without a session (3.2:197)');
  assert.equal(r[1].session_id, r[2].session_id, 'no system prompt is one more anchor, not none');
  assert.notEqual(r[0].session_id, r[1].session_id);
});

test('synthesized sessions have native_id NULL and confidence low, and say how they were grouped', async () => {
  const conn = await freshConn();
  await runEtl([hermes('a', 0, 'TASK-1'), hermes('b', 3, 'TASK-1')], conn);
  const s = await rows(conn, 'SELECT session_id, harness, native_id, native_id_confidence, extra FROM sessions');
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].harness, s[0].native_id, s[0].native_id_confidence], ['hermes', null, 'low']);
  const ex = JSON.parse(s[0].extra);
  assert.equal(ex.session_key, 'synthesized');
  assert.match(ex.synth_rule, /30-minute/);
});

test('board and ETL give the same capture the same synthesized keys; incremental == full', async () => {
  const recs = [hermes('a', 0, 'TASK-A'), hermes('b', 1, 'TASK-B'), hermes('c', 2, 'TASK-A'), hermes('d', 50, 'TASK-A')];
  const byId = (x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
  const board = [...groupSessions(recs.map((r) => ({ ...r })))].map(([id, rs]) => [id, rs.map((r) => r.id).sort()]).sort(byId);
  const conn = await freshConn();
  await runEtl(recs, conn);
  const etl = (await rows(conn, "SELECT session_id, string_agg(call_id, ',' ORDER BY call_id) AS ids FROM calls GROUP BY 1"))
    .map((r) => [r.session_id, r.ids.split(',')]).sort(byId);
  assert.deepEqual(etl, board);
  assert.equal(etl.length, 3, 'TASK-A (a, c), TASK-B (b), and TASK-A again after a 48-minute gap (d)');
  const inc = await freshConn();
  await runEtl(recs.slice(0, 2), inc);
  await runEtl(recs, inc);
  const full = await freshConn();
  await rebuild(recs, full);
  assert.deepEqual(await dumpAll(inc), await dumpAll(full));
});

test('on the board a synthesized session is listed and says so; it is no longer control traffic', () => {
  const recs = [hermes('a', 0, 'TASK-A'), hermes('b', 1, 'TASK-A')];
  const sessions = projectsView(recs).projects.flatMap((p) => p.sessions);
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].harness, sessions[0].session_synthesized, sessions[0].calls], ['hermes', true, 2]);
  assert.deepEqual(controlView(recs).classes, []);
  const keyed = projectsView([hermes('k', 0, 'T', { body: { session_id: 'HS' } })]).projects.flatMap((p) => p.sessions);
  assert.equal(keyed[0].session_synthesized, false);
});

test('stampSynthKeys is non-enumerable: the raw record serializes unchanged (invariant 2)', () => {
  const r = hermes('a', 0, 'T');
  const before = JSON.stringify(r);
  stampSynthKeys([r]);
  assert.match(r._synthKey, /^synth-hermes-/);
  assert.equal(JSON.stringify(r), before);
});

test('`asight serve` opens a synthesized session on the first request, before any listing (flat source)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-synth-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'capture-2026-10-06.ndjson');
  fs.writeFileSync(file, [hermes('a', 0, 'TASK-A'), hermes('b', 1, 'TASK-A')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const key = stampSynthKeys(await readRecords(file))[0]._synthKey;
  const { server } = await createServer({ dbPath: '/nonexistent-db-synth', sourcePath: [dir] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej));
  const v = await get('/api/session?id=' + encodeURIComponent(key)); // the very first request: nothing stamped yet
  assert.equal(v.status, 200);
  assert.equal(v.body.analyzed.steps.length, 2);
  assert.equal(v.body.meta.session_synthesized, true);
  const ctl = await get('/api/control');
  assert.deepEqual(ctl.body.classes, [], 'a synthesized session is not control traffic');
});
