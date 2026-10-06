// test/etl/projection-version.test.mjs — 4.2:51: incremental results MUST equal a full rebuild, bit for bit. A store
// written by an older projection (pre-D37: no wire_format / vendor / transport / context_state; or before the
// closeout fixes) would keep its old rows as they were while new rows followed the new rules — silently. runEtl
// now stores its projection version and refuses to extend a store of another version, asking for --rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEtl, rebuild, PROJECTION_VERSION } from '../../src/etl/orchestrator.mjs';
import { freshConn, dumpAll } from './helpers.mjs';

const body = (n) => JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }],
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'm' + i }] })) });
const cc = (id, n) => ({ id, ts_request: `2026-10-06T00:00:0${n}.000Z`, endpoint: '/v1/messages', method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'api.anthropic.com', proc: { pid: 3, exe: '/x/claude', agent: 'claude-code' },
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1' }, req_body: body(n),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const version = async (conn) => (await rows(conn, "SELECT value FROM etl_meta WHERE key = 'projection_version'"))[0]?.value;

// what a pre-D37 run left: the rows without the D37 columns, and no stored version
async function preD37Store(recs) {
  const conn = await freshConn();
  await runEtl(recs, conn);
  await conn.run('UPDATE calls SET wire_format = NULL, vendor = NULL, transport = NULL, context_state = NULL');
  await conn.run('DELETE FROM etl_meta');
  return conn;
}

test('a fresh store takes the current projection version, and a store of that version extends incrementally', async () => {
  const conn = await freshConn();
  await runEtl([cc('c1', 1)], conn);
  assert.equal(await version(conn), String(PROJECTION_VERSION));
  await runEtl([cc('c1', 1), cc('c2', 2)], conn);
  const full = await freshConn();
  await rebuild([cc('c1', 1), cc('c2', 2)], full);
  assert.deepEqual(await dumpAll(conn), await dumpAll(full));
});

test('a pre-D37 store is not extended: the incremental run refuses, writes nothing, and asks for --rebuild', async () => {
  const conn = await preD37Store([cc('c1', 1)]);
  const before = await dumpAll(conn);
  await assert.rejects(runEtl([cc('c1', 1), cc('c2', 2)], conn), /incremental ETL refused: this store was written by an older projection \(before D37.*--rebuild/);
  assert.deepEqual(await dumpAll(conn), before, 'the refused run wrote nothing');
});

test('a store of another stored version is refused too', async () => {
  const conn = await freshConn();
  await runEtl([cc('c1', 1)], conn);
  await conn.run("UPDATE etl_meta SET value = '1' WHERE key = 'projection_version'");
  await assert.rejects(runEtl([cc('c1', 1), cc('c2', 2)], conn), /projection version 1, and this code writes version/);
});

test('after --rebuild the upgraded store equals a full build, and extends incrementally again', async () => {
  const conn = await preD37Store([cc('c1', 1)]);
  await rebuild([cc('c1', 1), cc('c2', 2)], conn);
  assert.equal(await version(conn), String(PROJECTION_VERSION));
  const full = await freshConn();
  await runEtl([cc('c1', 1), cc('c2', 2)], full);
  assert.deepEqual(await dumpAll(conn), await dumpAll(full));
  assert.deepEqual((await rows(conn, 'SELECT wire_format, vendor, transport, context_state FROM calls ORDER BY call_id')).map(Object.values),
    [['anthropic', 'anthropic', 'http', 'complete'], ['anthropic', 'anthropic', 'http', 'complete']], 'the D37 columns are filled for the old row too');
  await runEtl([cc('c1', 1), cc('c2', 2), cc('c3', 3)], conn);
  await runEtl([cc('c1', 1), cc('c2', 2), cc('c3', 3)], full);
  assert.deepEqual(await dumpAll(conn), await dumpAll(full));
});

// The compaction verdict changed more than once on this branch (a v0 envelope counted by its request object,
// a call of unknown context judged no compaction, only a sharp drop, the preamble on its rising edge): each change makes
// `calls.compaction` differ for the same source, and a store written by version 2 has the rows of the older rules. A lane
// 3 → 58 → 55 is what the rule before the closeout flagged at 58 → 55; extending that store with the lane's real 55 → 4
// would give two compactions where a rebuild gives one (4.2:51).
test('a store of version 2 (the compaction rules before the closeout) is refused: extending it keeps a verdict a rebuild does not make', async () => {
  const at = (id, n, sec) => ({ ...cc(id, 1), ts_request: `2026-10-06T00:00:${String(sec).padStart(2, '0')}.000Z`, req_body: body(n) });
  const lane = (counts) => counts.map((n, i) => at('c' + (i + 1), n, i + 1));
  const conn = await freshConn();
  await runEtl(lane([3, 58, 55]), conn);
  // what the old rule (any drop) wrote for 58 → 55, under the version it stamped
  await conn.run("UPDATE calls SET compaction = true, compaction_from = 58, compaction_to = 55 WHERE call_id = 'c3'");
  await conn.run("UPDATE etl_meta SET value = '2' WHERE key = 'projection_version'");
  const before = await dumpAll(conn);
  const compactionsOf = async (c) => (await rows(c, 'SELECT call_id, compaction_from, compaction_to FROM calls WHERE compaction ORDER BY seq')).map((r) => [r.call_id, Number(r.compaction_from), Number(r.compaction_to)]);

  await assert.rejects(runEtl(lane([3, 58, 55, 4]), conn), new RegExp(`projection version 2, and this code writes version ${PROJECTION_VERSION}.*--rebuild`));
  assert.deepEqual(await dumpAll(conn), before, 'the refused run wrote nothing');

  // what the refusal prevents: with the version waved through, the old verdict stays beside the new one
  const waved = await freshConn();
  await runEtl(lane([3, 58, 55]), waved);
  await waved.run("UPDATE calls SET compaction = true, compaction_from = 58, compaction_to = 55 WHERE call_id = 'c3'");
  await runEtl(lane([3, 58, 55, 4]), waved);
  assert.deepEqual(await compactionsOf(waved), [['c3', 58, 55], ['c4', 55, 4]], 'incremental over the old rows: two compactions');

  // --rebuild is exact: the one real compaction, and the store extends incrementally again
  await rebuild(lane([3, 58, 55, 4]), conn);
  assert.deepEqual(await compactionsOf(conn), [['c4', 55, 4]]);
  assert.equal(await version(conn), String(PROJECTION_VERSION));
  const full = await freshConn();
  await rebuild(lane([3, 58, 55, 4, 6]), full);
  await runEtl(lane([3, 58, 55, 4, 6]), conn);
  assert.deepEqual(await dumpAll(conn), await dumpAll(full));
});
