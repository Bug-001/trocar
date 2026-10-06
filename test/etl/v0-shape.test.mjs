// test/etl/v0-shape.test.mjs — the demo v0 envelope (a parsed `request` object, no `req_body`) in the ETL. The board has
// always read it from `request`; the ETL counted 0 messages for every v0 call, so DuckDB never found a compaction where the
// board did (3.4, 1.3:5: the board shows calls.compaction). One fallback now serves both (adapters/envelope.mjs::v0RequestOf).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { freshConn } from './helpers.mjs';
import { fixtureGate, CC_SESSION_REAL } from '../helpers/fixture.mjs';

const stepOrder = (a, b) => String(a.ts_request).localeCompare(String(b.ts_request)) || String(a.id).localeCompare(String(b.id));
const rowsOf = async (conn) => (await conn.runAndReadAll('SELECT call_id, lane, compaction, compaction_from, compaction_to FROM calls ORDER BY seq')).getRowObjects();
const compactions = (rows) => rows.filter((r) => r.compaction).map((r) => [r.call_id, Number(r.compaction_from), Number(r.compaction_to)]);
const boardCompactions = (A) => A.steps.filter((s) => s.compaction).map((s) => [s.id, s.evictedFrom, s.evictedTo]);

const v0 = (id, n, sec) => ({ id, ts_request: `2026-07-12T00:00:${String(sec).padStart(2, '0')}.000Z`, endpoint: '/v1/messages', method: 'POST', is_llm_call: true,
  request_headers: { 'x-claude-code-session-id': 'v0-session', 'user-agent': 'claude-cli/2.0.0' },
  request: { model: 'claude-opus-4-8', system: [{ type: 'text', text: 's' }], tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }],
    messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'm' + i }] })) },
  response: { status: 200, body: { usage: { input_tokens: 10, output_tokens: 1 } } } });

test('a v0 call (request object, no req_body) is counted by its messages: the big drop is a compaction in DuckDB, the same one the board shows', async () => {
  const make = () => [v0('a', 6, 1), v0('b', 12, 2), v0('c', 3, 3)]; // 12 -> 3: below 70% and 9 fewer: a compaction by both drop rules
  const conn = await freshConn();
  await runEtl(make(), conn);
  const db = compactions(await rowsOf(conn));
  assert.deepEqual(db, [['c', 12, 3]], 'DuckDB: counted from the request object');
  assert.deepEqual(boardCompactions(assembleSession(make())), db, 'and the board agrees, from → to');
});

test('a v0 call with a req_body is read from req_body, as before (the fallback is only for no req_body at all)', async () => {
  const withBody = (r, n) => ({ ...r, req_body: JSON.stringify({ ...r.request, messages: r.request.messages.slice(0, n) }) });
  const conn = await freshConn();
  await runEtl([withBody(v0('a', 8, 1), 8), withBody(v0('b', 8, 2), 2)], conn); // req_body says 8, then 2; `request` says 8 and 8
  assert.deepEqual(compactions(await rowsOf(conn)), [['b', 8, 2]]);
});

// The real captured CC session is v0-shaped (39 records, every call has `request`, none has req_body). It is not in the
// repo (.gitignore keeps real captures out), so the gate skips it on a clone; the maintainer has it.
test('real CC fixture: every compaction the board shows, DuckDB finds with the same from → to; the only extra is the documented drop-threshold divergence (58 → 55)', fixtureGate(), async () => {
  const records = () => readFileSync(CC_SESSION_REAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const conn = await freshConn();
  await runEtl(records().sort(stepOrder), conn); // the order the board uses (ts_request, id); a capture is written in time order
  const db = compactions(await rowsOf(conn));
  const board = boardCompactions(assembleSession(records()));
  assert.deepEqual(board, [['req_00039', 55, 4]], 'precondition: the board shows the one real compaction');
  for (const b of board) assert.ok(db.some((d) => d.join() === b.join()), `DuckDB finds ${b}`);
  // ETL's markCompaction counts ANY shrink; the board needs a big one (known, left as is)
  assert.deepEqual(db.filter((d) => !board.some((b) => b.join() === d.join())), [['req_00036', 58, 55]]);
});
