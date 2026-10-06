// test/etl/rebuild-fidelity.test.mjs — BUG 1 (invariant 4 保真边界写明).
//
// resolveSource.detail(ref) classifies every resolved body as 'verbatim' (D10: the capture
// stored the real wire string) or 'reserialized' (demo v0: the capture stored PARSED JSON, so
// the body is rebuilt with JSON.stringify — whitespace / key order / number formatting may all
// differ from the wire). rebuildContext is THE read path the "回源 verbatim bytes" panel renders,
// so if it drops that marker the UI labels a reconstruction as the wire truth. Nothing downstream
// can then tell the two apart — the exact failure this tool exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runEtl, rebuildContext } from '../../src/etl/orchestrator.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { freshConn } from './helpers.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

const SID = 'sess-FID';
const HDRS = { 'x-claude-code-session-id': SID, 'user-agent': 'claude-cli/1.0' };
const STREAM = 'cap.ndjson';

// deliberate non-canonical spacing: a JSON.stringify round-trip would NOT reproduce it.
const WIRE = '{"model":"claude-opus-4-6","stream":true,' +
  '"tools":[{ "name": "Read" ,"description":"read a file","input_schema":{"type":"object"}}],' +
  '"system":[{"type":"text","text":"You are Claude Code"}],' +
  '"messages":[{"role":"user","content":[{"type":"text","text":"d10 call"}]}]}';

// D10 record — req_body is the captured wire STRING.
const d10 = {
  id: 'rec-d10', ts_request: '2026-07-15T00:00:01.000Z', endpoint: '/v1/messages', method: 'POST',
  is_llm_call: true, duration_ms: 900, error: false, req_headers: { ...HDRS }, req_body: WIRE,
  resp: { kind: 'sse', status: 200, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } },
};
// demo v0 record — the request was stored PARSED, so ingest re-serializes it.
// EVERY block is deliberately distinct from d10's: block_contents dedups on content_hash, so a
// byte-identical block would resolve through the OTHER record's text_ref and (correctly) report
// that record's fidelity — which would silently defeat what this fixture is here to isolate.
const v0 = {
  id: 'rec-v0', ts_request: '2026-07-15T00:00:02.000Z', endpoint: '/v1/messages',
  is_llm_call: true, duration_ms: 900, error: false, request_headers: { ...HDRS },
  request: {
    model: 'claude-opus-4-6', stream: true,
    tools: [{ name: 'Write', description: 'write a file (v0-only tool)', input_schema: { type: 'object' } }],
    system: [{ type: 'text', text: 'You are Claude Code, reached through the v0 capture' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'v0 call' }] }],
  },
  response: { kind: 'sse', status: 200, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } },
};

function tmpCapture(records) {
  const dir = tmpDir('asight-fid-');
  const file = path.join(dir, STREAM);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

async function loaded(file) {
  const conn = await freshConn();
  await runEtl(await readRecords(file), conn, { streamBasename: STREAM });
  return conn;
}

test('BUG1: rebuildContext carries the source fidelity marker for D10 (verbatim) bytes', async () => {
  const file = tmpCapture([d10, v0]);
  const conn = await loaded(file);
  const resolve = await buildResolver(file);
  try {
    const blocks = await rebuildContext(conn, 'rec-d10', resolve);
    assert.ok(blocks.length > 0, 'expected rebuilt blocks');
    for (const b of blocks) {
      assert.equal(b.source_status, 'ok', `block ${b.seq} status`);
      assert.equal(b.source_fidelity, 'verbatim', `block ${b.seq} fidelity`);
    }
    // and the bytes really are the wire bytes (non-circular: odd spacing survives).
    assert.ok(blocks.some((b) => b.text.includes('{ "name": "Read" ,')), 'wire spacing preserved');
  } finally { resolve.dispose(); }
});

test('BUG1: rebuildContext marks v0-converted bodies RESERIALIZED, not verbatim', async () => {
  const file = tmpCapture([d10, v0]);
  const conn = await loaded(file);
  const resolve = await buildResolver(file);
  try {
    const blocks = await rebuildContext(conn, 'rec-v0', resolve);
    assert.ok(blocks.length > 0, 'expected rebuilt blocks');
    for (const b of blocks) {
      assert.equal(b.source_status, 'ok', `block ${b.seq} status`);
      // THE assertion: a reconstruction MUST NOT come back indistinguishable from wire bytes.
      assert.equal(b.source_fidelity, 'reserialized', `block ${b.seq} fidelity`);
      assert.notEqual(b.source_fidelity, 'verbatim');
    }
  } finally { resolve.dispose(); }
});

test('BUG1: a plain resolver WITHOUT .detail still works — text intact, fidelity unclaimed', async () => {
  const file = tmpCapture([d10]);
  const conn = await loaded(file);
  const full = await buildResolver(file);
  const plain = (ref) => full(ref); // back-compat surface: string-or-null, no .detail
  try {
    const blocks = await rebuildContext(conn, 'rec-d10', plain);
    assert.ok(blocks.length > 0);
    for (const b of blocks) {
      assert.equal(typeof b.text, 'string', 'text must still resolve');
      assert.equal(b.source_fidelity, null, 'no fidelity may be CLAIMED when the resolver cannot report one');
      assert.equal(b.source_status, 'unknown');
    }
    // byte-identity with the detail-capable resolver is unchanged.
    const rich = await rebuildContext(conn, 'rec-d10', full);
    assert.deepEqual(blocks.map((b) => b.text), rich.map((b) => b.text));
  } finally { full.dispose(); }
});

test('BUG1: unresolvable blocks report status/reason instead of a bare null text', async () => {
  // The ETL knows rec-v0's blocks, but the source file on disk holds ONLY rec-d10 — so the
  // 回源 pointer for rec-v0 cannot be resolved. That is a real state (capture rotated/truncated).
  const file = tmpCapture([d10]);
  const conn = await freshConn();
  await runEtl(await readRecords(tmpCapture([d10, v0])), conn, { streamBasename: STREAM });
  const resolve = await buildResolver(file);
  try {
    const blocks = await rebuildContext(conn, 'rec-v0', resolve);
    assert.ok(blocks.length > 0);
    for (const b of blocks) {
      assert.equal(b.text, null);
      assert.equal(b.source_status, 'absent');
      assert.match(b.source_reason, /rec-v0/);
      assert.equal(b.source_fidelity, null);
    }
  } finally { resolve.dispose(); }
});

test('BUG1: holds on the REAL in-repo capture (samples/demo-session.ndjson)', async () => {
  const file = path.resolve('samples/demo-session.ndjson');
  const conn = await freshConn();
  await runEtl(await readRecords(file), conn, { streamBasename: path.basename(file) });
  const callId = (await conn.runAndReadAll('SELECT call_id FROM call_blocks ORDER BY call_id LIMIT 1'))
    .getRowObjects()[0].call_id;
  const resolve = await buildResolver(file);
  try {
    const blocks = await rebuildContext(conn, callId, resolve);
    assert.ok(blocks.length > 0, 'real capture produced blocks');
    for (const b of blocks) {
      assert.equal(b.source_status, 'ok');
      assert.equal(b.source_fidelity, 'verbatim'); // the D10 sample IS wire bytes
      assert.equal(typeof b.text, 'string');
    }
  } finally { resolve.dispose(); }
});
