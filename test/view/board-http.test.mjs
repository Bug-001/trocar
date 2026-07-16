import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
const MAIN = '3e03c998-f70d-4843-8639-40f2d8b2cdc7';
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  req.on('error', reject); req.end();
});

let srv, port, srcPath;
test.before(async () => {
  // a WRITABLE copy of the source so the concurrent-append test can grow it
  srcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-boardhttp-')), 'src.ndjson');
  fs.copyFileSync(FIXTURE, srcPath);
  const made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: srcPath });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
});
test.after(() => srv?.close());

test('BOARD /api/projects + /api/session: canonical, no provider-native usage leak, no-store', async () => {
  const pj = JSON.parse((await get(port, '/api/projects')).body);
  assert.ok(pj.projects.length >= 1);
  const s = await get(port, `/api/session?id=${MAIN}`);
  assert.equal(s.status, 200);
  assert.equal(s.headers['cache-control'], 'no-store');
  const d = JSON.parse(s.body);
  assert.ok(d.analyzed && d.analyzed.lanes && d.meta && Array.isArray(d.records));
  // baked neutral usage on calls; NO provider-native usage names anywhere in the payload's baked fields
  const main = d.analyzed.lanes.find((l) => l.kind === 'main');
  assert.ok(main.calls.some((c) => c.usage && 'read' in c.usage), 'calls carry baked neutral usage');
});

test('D14 /api/pricing: editable config served (defaults present)', async () => {
  const r = await get(port, '/api/pricing');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.editable === true && d.pricing && Array.isArray(d.pricing.opus) && d.pricing.opus.length === 4);
});

test('D17③ /api/compare: 404 on missing id; 200 canonical for a self-compare', async () => {
  assert.equal((await get(port, '/api/compare?a=' + MAIN)).status, 404, 'missing b → 404');
  assert.equal((await get(port, `/api/compare?a=${MAIN}&b=nope`)).status, 404, 'unknown id → 404 (no empty shell)');
  const r = await get(port, `/api/compare?a=${MAIN}&b=${MAIN}`);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.a && d.b && d.align && d.resources, 'compare canonical shape');
  assert.equal(d.align.firstDiverge, -1, 'self-compare has no divergence');
  assert.ok(!JSON.stringify(d).match(/cache_read_input_tokens|input_tokens|output_tokens/), 'no provider-native usage leak (invariant 3)');
});

test('4.4 §验收#5 — concurrent poll during ETL append reads a self-consistent snapshot', async () => {
  // simulate ETL appending: a COMPLETE record then a HALF-written line (no newline), racing a poll.
  const complete = JSON.stringify({ id: 'req_appended', ts_request: '2026-07-16T00:00:00Z', is_llm_call: false, endpoint: '/x', request_headers: {}, response: { status: 200 } }) + '\n';
  const halfLine = '{"id":"req_partial","request":{"model":"claude-';
  const results = await Promise.all([
    (async () => { fs.appendFileSync(srcPath, complete); fs.appendFileSync(srcPath, halfLine); })(),
    get(port, '/api/projects'),
    get(port, `/api/session?id=${MAIN}`),
  ]);
  const [, projects, session] = results;
  assert.equal(projects.status, 200);
  assert.doesNotThrow(() => JSON.parse(projects.body), 'projects JSON is well-formed mid-append');
  assert.equal(session.status, 200);
  assert.doesNotThrow(() => JSON.parse(session.body), 'session JSON is well-formed mid-append (half-line dropped, no corruption)');
  // finalize the partial line and confirm the reader now stays valid too
  fs.appendFileSync(srcPath, 'opus"}}\n');
  const after = await get(port, '/api/projects');
  assert.doesNotThrow(() => JSON.parse(after.body));
});
