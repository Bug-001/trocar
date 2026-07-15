import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEtl, rebuild, rebuildContext, mintRawRef, parseTextRef } from '../../src/etl/orchestrator.mjs';
import { parseBlocks } from '../../src/adapters/cc.mjs';
import { mapUsage } from '../../src/model/schema.mjs';
import { freshConn, dumpAll, countOf, batchA, batchB, controlRec, alienRec, sourceMap } from './helpers.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────
// ★ AC-1 — THE demonstration: rebuild a call's context PURELY from the DuckDB tables
//   (which store NO fulltext, only a text_ref pointer) + the source, byte-diff = 0.
//   NON-CIRCULAR: expected values are hand-authored WIRE literals with deliberate
//   non-canonical spacing; a re-serialization would differ. block_contents holds only a
//   pointer, so reconstruction must come from 回源, never from a stored copy or a preview.
// ─────────────────────────────────────────────────────────────────────────────────────
const AC1_SID = 'sess-AC1';
const LONG = 'x'.repeat(230); // > 200 so the block's bytes exceed the (≤200) preview column
// tool block: spaces around "name" survive on the wire; JSON.parse→stringify would drop them.
const TOOL_WIRE = `{ "name": "Read" , "description":"${LONG}","input_schema":{"type":"object"}}`;
const SYS_WIRE = '{"type":"text","text":"You are Claude Code"}';
const PREFIX = `{"model":"claude-opus-4-6","stream":true,"tools":[${TOOL_WIRE}],"system":[${SYS_WIRE}],`;
const RAW1 = PREFIX + '"messages":[{"role":"user","content":[{"type":"text","text":"first call"}]}]}';
const RAW2 = PREFIX + '"messages":[{"role":"user","content":[{"type":"text","text":"second unique call"}]}]}';
const ac1Rec = (id, raw) => ({
  id, ts_request: '2026-07-15T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  is_llm_call: true, duration_ms: 900, error: false,
  req_headers: { 'x-claude-code-session-id': AC1_SID, 'user-agent': 'claude-cli/1.0' },
  req_body: raw, resp: { kind: 'sse', status: 200, stop_reason: 'end_turn', usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4, output_tokens: 2 } },
});

test('AC-1: rebuildContext reconstructs each block byte-identical to source (diff=0), non-circular', async () => {
  const conn = await freshConn();
  const records = [ac1Rec('rec-1', RAW1), ac1Rec('rec-2', RAW2)];
  await runEtl(records, conn);

  // resolve text_ref against the ORIGINAL req_body string (NOT a re-serialize)
  const sources = sourceMap(records, 'capture.ndjson', mintRawRef);
  const resolve = (textRef) => {
    const { rawRef, start, end } = parseTextRef(textRef);
    return sources.get(rawRef).slice(start, end);
  };

  const rebuilt = await rebuildContext(conn, 'rec-2', resolve);

  // ── KEY ASSERTION: every rebuilt block == the source's exact byte-slice, in assembly order.
  //    truth = the adapter's verbatim slices of rec-2 (computed independently of the DB).
  const truth = parseBlocks(records[1]).map((b) => b.text);
  assert.deepEqual(rebuilt.map((r) => r.text), truth); // byte-diff = 0, order tools→system→messages
  assert.deepEqual(rebuilt.map((r) => r.section), ['tools', 'system', 'messages']);

  // ── NON-CIRCULAR proof on the tools block: the rebuilt bytes are the exact wire literal
  //    (spaces around "name" preserved) and DIFFER from a JSON.parse→stringify round-trip.
  const toolsText = rebuilt.find((r) => r.section === 'tools').text;
  assert.equal(toolsText, TOOL_WIRE); // byte-exact wire bytes
  assert.notEqual(toolsText, JSON.stringify(JSON.parse(TOOL_WIRE))); // NOT a re-serialization
  assert.ok(toolsText.length > 200); // longer than the preview column → proves 回源, not preview

  // ── block_contents holds a POINTER, never the fulltext (RFC 3.2 invariant).
  const toolHash = parseBlocks(records[0]).find((b) => b.section === 'tools').content_hash;
  const row = (await conn.runAndReadAll(
    'SELECT text_ref, preview FROM block_contents WHERE content_hash = $1', [toolHash],
  )).getRowObjects()[0];
  assert.match(row.text_ref, /^sess-AC1\/capture\.ndjson#rec-1::\d+-\d+$/); // pointer, not bytes
  assert.ok(!row.text_ref.includes(LONG)); // the 230-char body is NOT stored in the pointer
  assert.ok(row.preview.length <= 200 && toolsText.length > row.preview.length); // preview is truncated
});

// ─────────────────────────────────────────────────────────────────────────────────────
// ★ dedup — a block repeated across calls (same bytes) → ONE block_contents row.
// ─────────────────────────────────────────────────────────────────────────────────────
test('dedup: count(block_contents) < sum(call_blocks); shared tools+system stored once', async () => {
  const conn = await freshConn();
  await runEtl(batchA(), conn);
  const bc = await countOf(conn, 'SELECT count(*) n FROM block_contents');
  const cb = await countOf(conn, 'SELECT count(*) n FROM call_blocks');
  assert.equal(cb, 8); // 2 calls × 4 blocks (tools, system, user, assistant)
  assert.equal(bc, 6); // shared tools + shared system stored once + 4 distinct message blocks
  assert.ok(bc < cb, 'dedup: block_contents < Σ per-call blocks');
  const shared = await countOf(conn, "SELECT count(*) n FROM block_contents WHERE section IN ('tools','system')");
  assert.equal(shared, 2); // identical tools/system across the two calls → one row each
});

// ─────────────────────────────────────────────────────────────────────────────────────
// ★ AC-2 — the usage row numeric-equals mapUsage('cc', online usage).
// ─────────────────────────────────────────────────────────────────────────────────────
test('AC-2: usage row numeric-equals mapUsage(cc, online usage)', async () => {
  const conn = await freshConn();
  const recs = batchA();
  await runEtl(recs, conn);
  const want = mapUsage('cc', recs[0].resp.usage); // req-1 online usage
  const got = (await conn.runAndReadAll(
    'SELECT input_uncached,cache_read,cache_write,output,reasoning,total_input FROM usage WHERE call_id=$1',
    ['req-1'],
  )).getRowObjects()[0];
  for (const k of ['input_uncached', 'cache_read', 'cache_write', 'output', 'reasoning', 'total_input']) {
    assert.equal(Number(got[k]), want[k], `usage.${k}`);
  }
  assert.equal(want.total_input, 150); // 100 uncached + 0 read + 50 write
});

// ─────────────────────────────────────────────────────────────────────────────────────
// ★ control call — class=control ⇒ session_id NULL, not in sessions.
// ─────────────────────────────────────────────────────────────────────────────────────
test('control call: session_id NULL, class=control, absent from sessions', async () => {
  const conn = await freshConn();
  await runEtl([...batchA(), controlRec()], conn);
  const ctl = (await conn.runAndReadAll("SELECT session_id, class FROM calls WHERE call_id='ctl-1'")).getRowObjects()[0];
  assert.equal(ctl.class, 'control');
  assert.equal(ctl.session_id, null);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM sessions WHERE session_id='ctl-1'"), 0);
  assert.equal(await countOf(conn, 'SELECT count(*) n FROM sessions'), 1); // only sess-A
  // B-lane: calls.lane is filled from parseCall.lane (per-call), never left NULL.
  const lane = (await conn.runAndReadAll("SELECT lane FROM calls WHERE call_id='req-1'")).getRowObjects()[0].lane;
  assert.equal(lane, 'main');
});

// ─────────────────────────────────────────────────────────────────────────────────────
// ★ watermark incremental — batch A then A+B == running A+B once (row-for-row).
// ─────────────────────────────────────────────────────────────────────────────────────
test('idempotent: re-running ETL on the same records is a no-op', async () => {
  const conn = await freshConn();
  await runEtl(batchA(), conn);
  const once = await dumpAll(conn);
  const stats2 = await runEtl(batchA(), conn);
  assert.equal(stats2.ingested, 0);
  assert.equal(stats2.skipped, 2);
  assert.deepEqual(await dumpAll(conn), once); // resource_events did NOT double
});

test('incremental (A then A+B) == full (A+B once), row-for-row', async () => {
  const c1 = await freshConn();
  await runEtl(batchA(), c1);
  const stats2 = await runEtl([...batchA(), ...batchB()], c1);
  assert.equal(stats2.ingested, 1); // only req-3 is new
  assert.equal(stats2.skipped, 2); // req-1, req-2 already consumed

  const c2 = await freshConn();
  await runEtl([...batchA(), ...batchB()], c2);

  assert.deepEqual(await dumpAll(c1), await dumpAll(c2));
});

// ─────────────────────────────────────────────────────────────────────────────────────
// ★ rebuild-equivalence — DROP + clear watermark + full re-run == incremental state.
//   Proves the projection is disposable AND that resource_events.seq is continuous (B-seq).
// ─────────────────────────────────────────────────────────────────────────────────────
test('rebuild == incremental state (derived layer disposable; resource_events.seq continuous)', async () => {
  const conn = await freshConn();
  await runEtl(batchA(), conn);
  await runEtl([...batchA(), ...batchB()], conn); // incremental
  const incremental = await dumpAll(conn);

  const seqsBefore = (await conn.runAndReadAll(
    "SELECT seq FROM resource_events WHERE session_id='sess-A' ORDER BY seq",
  )).getRowObjects().map((r) => Number(r.seq));
  assert.deepEqual(seqsBefore, [0, 1, 2]); // continuous across the incremental batch (B-seq fix)

  await rebuild([...batchA(), ...batchB()], conn); // drop all + reset watermark + full re-ingest
  assert.deepEqual(await dumpAll(conn), incremental); // same rows + same content_hashes + same seqs
});

// ─────────────────────────────────────────────────────────────────────────────────────
// quarantine — unclaimed records are counted + persisted, never dropped.
// ─────────────────────────────────────────────────────────────────────────────────────
test('unclaimed records are quarantined + counted, never dropped or ingested', async () => {
  const conn = await freshConn();
  const stats = await runEtl([...batchA(), alienRec()], conn);
  assert.equal(stats.quarantined, 1);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM etl_quarantine WHERE id='weird-1'"), 1);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM calls WHERE call_id='weird-1'"), 0); // not ingested
  // re-run: quarantine stays a single row (ON CONFLICT DO NOTHING)
  await runEtl([...batchA(), alienRec()], conn);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM etl_quarantine WHERE id='weird-1'"), 1);
});
