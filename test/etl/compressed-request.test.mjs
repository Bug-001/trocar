// test/etl/compressed-request.test.mjs — a request body the collector stored compressed (4.6 §记录): the board
// loader, the ETL and the resolver agree on the decoded text and say it was decoded (3.1, 3.2:132, invariant 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readRecords } from '../../src/etl/ingest.mjs';
import { runEtl, rebuildContext } from '../../src/etl/orchestrator.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { freshConn } from './helpers.mjs';

const BODY = '{"model":"m","max_tokens":8,"system":[{"type":"text","text":"sys"}],"messages":[{"role":"user","content":[{"type":"text","text":"q"}]}]}';
const env = { id: 'c1', ts: '2026-10-06T00:00:00.000Z', ts_request: '2026-10-06T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  req_headers: { 'x-claude-code-session-id': 'S', 'content-encoding': 'br' }, req_body: null, is_llm_call: true, capture: 'transparent',
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 3, output_tokens: 1 } },
  req_body_b64: zlib.brotliCompressSync(BODY).toString('base64'), req_content_encoding: 'br', req_encoding_error: 'not decoded at capture' };

function capture(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-zreq-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'capture-2026-10-06.ndjson');
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, f };
}

test('a compressed request rebuilds through the ETL and the resolver as decoded text, labelled decoded; the source is untouched', async (t) => {
  const { dir, f } = capture(t, [env]);
  const before = fs.readFileSync(f);
  const records = await readRecords(f);
  assert.equal(records[0].req_body, BODY);
  const conn = await freshConn();
  const stats = await runEtl(records, conn);
  assert.equal(stats.quarantined, 0);
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose && resolve.dispose());
  const rebuilt = await rebuildContext(conn, 'c1', resolve);
  assert.ok(rebuilt.length >= 2);
  for (const b of rebuilt) assert.deepEqual([b.source_status, b.source_fidelity], ['ok', 'decoded']);
  assert.ok(rebuilt.every((b) => BODY.includes(b.text)));
  const c = (await conn.runAndReadAll("SELECT context_state, extra, request_bytes FROM calls WHERE call_id='c1'")).getRowObjects()[0];
  assert.equal(c.context_state, 'complete', '3.1: compression never changes context_state');
  assert.equal(c.request_bytes, Buffer.from(env.req_body_b64, 'base64').length, '3.2:47 request_bytes = the body\'s bytes on the wire, not its decoded size');
  const extra = JSON.parse(c.extra);
  assert.equal(extra.req_encoding_error, 'not decoded at capture', 'the collector-side fact stays with the row');
  assert.equal('req_content_encoding' in extra, false, 'the encoding is structure the reader consumed');
  assert.ok(fs.readFileSync(f).equals(before), 'invariant 2');
});

test('a body the collector decoded itself is decoded text too, not "verbatim"', async (t) => {
  const { dir, f } = capture(t, [{ ...env, req_body: BODY, req_body_b64: zlib.gzipSync(BODY).toString('base64'), req_content_encoding: 'gzip', req_encoding_error: undefined }]);
  const conn = await freshConn();
  await runEtl(await readRecords(f), conn);
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose && resolve.dispose());
  const rebuilt = await rebuildContext(conn, 'c1', resolve);
  assert.ok(rebuilt.length >= 2 && rebuilt.every((b) => b.source_fidelity === 'decoded'));
});

test('the board renders a reader-decoded request like any other, and says it was decompressed', async (t) => {
  const { f } = capture(t, [env]);
  const A = assembleSession(await readRecords(f, { normalize: false }));
  assert.equal(A.steps.length, 1);
  assert.equal(A.steps[0].unparsed, false);
  assert.ok(A.steps[0].flat.length >= 2);
  assert.deepEqual(A.steps[0].wire.labels, [], 'decoded → not labelled undecoded');
  assert.equal(A.steps[0].wire.reqEncoding, 'br');
});

test('an undecodable compressed request is labelled on the board and in the ETL row, never parsed', async (t) => {
  const bad = { ...env, req_body_b64: Buffer.from('not brotli').toString('base64') };
  const { f } = capture(t, [bad]);
  const A = assembleSession(await readRecords(f, { normalize: false }));
  assert.deepEqual(A.steps[0].wire.labels.map((l) => l.id), ['req-undecoded']);
  assert.equal(A.steps[0].wire.contextState, 'complete');
  const conn = await freshConn();
  await runEtl(await readRecords(f), conn);
  const c = (await conn.runAndReadAll("SELECT context_state, extra FROM calls WHERE call_id='c1'")).getRowObjects()[0];
  assert.deepEqual([c.context_state, JSON.parse(c.extra).req_encoding_error], ['complete', 'not decoded at capture']);
  assert.equal((await conn.runAndReadAll("SELECT count(*) n FROM call_blocks WHERE call_id='c1'")).getRowObjects()[0].n, 0n, 'no blocks invented');
});
