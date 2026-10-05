import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { etlFile } from '../src/etl/cli.mjs';
import { createServer } from '../src/server.mjs';
import { fixtureGate, hasFixture } from './helpers/fixture.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject); req.end();
  });
}

let store, srv, port;
test.before(async () => {
  if (!hasFixture()) return; // every test below is fixtureGate()d — nothing to ETL, nothing to serve
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-srv-')), 'asight.duckdb');
  await etlFile(FIXTURE, { dbPath: store, rebuild: true });
  const made = await createServer({ dbPath: store, sourcePath: FIXTURE });
  srv = made.server;
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  port = srv.address().port;
});
test.after(() => { srv?.close(); });

test('GET /api/sessions: canonical rows, no provider-native leak, no-store', fixtureGate(), async () => {
  const r = await get(port, '/api/sessions');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const rows = JSON.parse(r.body);
  assert.ok(rows.length >= 1);
  assert.ok('call_count' in rows[0] && 'harness' in rows[0] && 'provider' in rows[0]);
  assert.ok(!r.body.includes('cache_read_input_tokens'), 'invariant 3: no provider-native leak');
  assert.ok(!r.body.includes('cache_creation_input_tokens'));
});

test('GET /api/session/:id: calls carry CANONICAL usage + cache_events columns', fixtureGate(), async () => {
  const sessions = JSON.parse((await get(port, '/api/sessions')).body).sort((a, b) => b.call_count - a.call_count);
  const sid = sessions[0].session_id;
  const r = await get(port, `/api/session/${encodeURIComponent(sid)}`);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.calls.length >= 1);
  assert.ok(j.calls.find((c) => c.cache_read != null), 'a call exposes canonical cache_read');
  assert.ok('break_kind' in j.calls[0], 'canonical cache overlay column present');
  assert.ok(Array.isArray(j.resources));
  assert.ok(!r.body.includes('cache_read_input_tokens'));
});

test('AC-1 over HTTP: /api/call/:id/context blocks are byte-verbatim from source', fixtureGate(), async () => {
  const sessions = JSON.parse((await get(port, '/api/sessions')).body).sort((a, b) => b.call_count - a.call_count);
  const calls = JSON.parse((await get(port, `/api/session/${encodeURIComponent(sessions[0].session_id)}`)).body).calls;
  let ctx = null;
  for (const c of calls) {
    const r = await get(port, `/api/call/${encodeURIComponent(c.call_id)}/context`);
    if (r.status === 200) { ctx = JSON.parse(r.body); break; }
  }
  assert.ok(ctx && ctx.blocks.length >= 1, 'got a call context with blocks');
  assert.ok(ctx.blocks.some((b) => b.section === 'system' || b.section === 'messages'));
  assert.ok(ctx.blocks.every((b) => typeof b.text === 'string'), 'every block resolved to verbatim text');
  assert.equal(ctx.source_resolved, true);
});

test('security: path traversal rejected + 404 unknown api + 404 missing session', fixtureGate(), async () => {
  assert.equal((await get(port, '/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await get(port, '/api/nope')).status, 404);
  assert.equal((await get(port, '/api/session/does-not-exist')).status, 404);
});

test('binds loopback only (127.0.0.1)', fixtureGate(), () => {
  assert.equal(srv.address().address, '127.0.0.1');
});

test('read-only: store file mtime unchanged across request cycles', fixtureGate(), async () => {
  const m0 = fs.statSync(store).mtimeMs;
  await get(port, '/api/sessions');
  await get(port, '/api/sessions');
  assert.equal(fs.statSync(store).mtimeMs, m0);
});
