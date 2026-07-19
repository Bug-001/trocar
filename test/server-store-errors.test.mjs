import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { ccLlmRecord } from './fixtures/cc-record.mjs';

// BROKEN MUST NOT LOOK LIKE EMPTY (audit 2026-07-19).
// asight's whole value is that what it shows IS what went over the wire. The worst outcome is a
// board that renders a calm empty state while the store or the source is actually unreadable: the
// user concludes "nothing was captured" when the truth is "asight is broken". A genuinely-absent
// store ("not built yet") and a corrupt / permission-denied one MUST be distinguishable over HTTP.

const SAMPLE = path.resolve('samples/demo-session.ndjson'); // REAL capture shape, not synthetic
const get = (port, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', reject); r.end();
});
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-storeerr-'));
async function serve(opts) {
  const { server } = await createServer(opts);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}
// chmod-based denial is meaningless as root; skip rather than assert a falsehood.
function denied(p) {
  fs.chmodSync(p, 0o000);
  try { fs.readFileSync(p); return false; } catch { return true; }
}

const SQL_ROUTES = ['/api/sessions', '/api/session/abc', '/api/call/abc/context', '/api/analysis',
  '/api/unmapped', '/api/forktree?root=abc'];

test('BUG1: a CORRUPT analytics store is an ERROR on every SQL route, not "no analytics db"', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'asight.duckdb');
  fs.writeFileSync(dbPath, Buffer.from('NOT-A-DUCKDB-FILE'.repeat(600)));
  const { server, port } = await serve({ dbPath, sourcePath: SAMPLE });
  try {
    for (const route of SQL_ROUTES) {
      const r = await get(port, route);
      const d = JSON.parse(r.body);
      assert.ok(r.status >= 500, `${route}: corrupt store must be a 5xx, got ${r.status} ${r.body.slice(0, 120)}`);
      assert.ok(d.error, `${route}: must carry an {error} the board can render`);
      assert.notEqual(d.error, 'no analytics db', `${route}: corrupt store must NOT masquerade as "not built yet"`);
      assert.match(d.error, /valid DuckDB|unreadable/i, `${route}: error must name the real cause, got ${d.error}`);
    }
  } finally { server.close(); }
});

test('BUG1: a PERMISSION-DENIED analytics store is an ERROR, not "no analytics db"', async (t) => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'asight.duckdb');
  fs.writeFileSync(dbPath, Buffer.from('NOT-A-DUCKDB-FILE'.repeat(600)));
  if (!denied(dbPath)) return t.skip('cannot deny read access (running privileged)');
  const { server, port } = await serve({ dbPath, sourcePath: SAMPLE });
  try {
    const r = await get(port, '/api/sessions');
    const d = JSON.parse(r.body);
    assert.ok(r.status >= 500, `permission-denied store must be a 5xx, got ${r.status}`);
    assert.notEqual(d.error, 'no analytics db');
    assert.match(d.error, /permission|unreadable/i, `error must name the real cause, got ${d.error}`);
  } finally { server.close(); fs.chmodSync(dbPath, 0o600); }
});

test('REGRESSION GUARD: a genuinely ABSENT store keeps its benign 404 "no analytics db"', async () => {
  // Three shipped test files (server-dir-source, server-rebind, view/board-http) run the board with
  // dbPath:'/nonexistent-db' — "not built yet" is a REAL state and MUST stay a calm 404.
  const { server, port } = await serve({ dbPath: '/nonexistent-db-xyz', sourcePath: SAMPLE });
  try {
    for (const route of SQL_ROUTES) {
      const r = await get(port, route);
      assert.equal(r.status, 404, `${route}: absent store stays 404`);
      assert.match(JSON.parse(r.body).error, /no analytics db|needs \?root/, `${route}: benign message`);
    }
  } finally { server.close(); }
});

test('REGRESSION GUARD: a broken store does NOT take down the BOARD plane (real sample renders)', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'asight.duckdb');
  fs.writeFileSync(dbPath, Buffer.from('NOT-A-DUCKDB-FILE'.repeat(600)));
  const { server, port } = await serve({ dbPath, sourcePath: SAMPLE });
  try {
    const r = await get(port, '/api/projects');
    assert.equal(r.status, 200, 'the board reads the raw NDJSON — it does not need the db at all');
    const d = JSON.parse(r.body);
    const sessions = (d.projects || []).flatMap((p) => p.sessions || []);
    assert.ok(sessions.length >= 1, 'real sample capture still yields sessions with the db broken');
    assert.ok(sessions.some((s) => s.calls > 0), 'and those sessions carry real calls');
  } finally { server.close(); }
});

// createServer() REFUSES to start when sourcePath is missing/unreadable (buildResolver stats it),
// so "no source" is not a state a RUNNING server can legitimately be in. But the source can vanish
// UNDER a long-lived board (deleted, rotated, its directory made unreadable) — and there the loader
// swallowed the stat error and served an empty record set, i.e. a live board that quietly stops
// showing a capture that is still being written. Broken must stay visibly broken.
test('BUG1(source): a source that DISAPPEARS under a live board is an ERROR, not an empty list', async () => {
  const dir = tmpdir();
  const src = path.join(dir, 'claude-capture.ndjson');
  fs.writeFileSync(src, JSON.stringify(ccLlmRecord({ env: { req_headers: { 'x-claude-code-session-id': 'sess-A' } } })) + '\n');
  const { server, port } = await serve({ dbPath: '/nonexistent-db-xyz', sourcePath: src });
  try {
    assert.match((await get(port, '/api/projects')).body, /sess-A/, 'baseline: the board sees the capture');
    fs.unlinkSync(src); // capture removed/rotated while the board keeps polling
    for (const route of ['/api/projects', '/api/session?id=sess-A', '/api/control']) {
      const r = await get(port, route);
      assert.ok(r.status >= 500, `${route}: vanished source must be a 5xx, got ${r.status} ${r.body.slice(0, 160)}`);
      assert.ok(JSON.parse(r.body).error, `${route}: must carry an {error} the board can render`);
    }
  } finally { server.close(); }
});

test('BUG1(source): an UNREADABLE source DIRECTORY is an ERROR, not an empty project list', async (t) => {
  const dir = tmpdir();
  const sub = path.join(dir, 'capdir'); fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'claude-capture.ndjson'),
    JSON.stringify(ccLlmRecord({ env: { req_headers: { 'x-claude-code-session-id': 'sess-A' } } })) + '\n');
  const { server, port } = await serve({ dbPath: '/nonexistent-db-xyz', sourcePath: sub });
  try {
    assert.match((await get(port, '/api/projects')).body, /sess-A/, 'baseline: the board sees the capture');
    fs.chmodSync(sub, 0o000);
    let readable = true; try { fs.readdirSync(sub); } catch { readable = false; }
    if (readable) return t.skip('cannot deny directory access (running privileged)');
    const r = await get(port, '/api/projects');
    assert.ok(r.status >= 500, `unreadable source dir must be a 5xx, got ${r.status} ${r.body.slice(0, 160)}`);
    assert.ok(JSON.parse(r.body).error, 'must carry an {error}');
  } finally { server.close(); try { fs.chmodSync(sub, 0o700); } catch {} }
});
