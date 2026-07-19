import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { etlFile } from '../../src/etl/cli.mjs';
import { openDb } from '../../src/db.mjs';
import { createServer } from '../../src/server.mjs';
import {
  filesEverInContext, cacheHitDistribution, breakKindComparison, unmappedFields,
  forkTree, resourceLifecycle, listSessions,
} from '../../src/query/queries.mjs';
import { runNamed, NAMED_QUERIES } from '../../src/query/index.mjs';
import { fixtureGate } from '../helpers/fixture.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.end();
});

let dbPath, db, srv, port;
test.before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-analysis-')), 'a.duckdb');
  await etlFile(FIXTURE, { dbPath, rebuild: true });
  db = await openDb(dbPath, { readOnly: true });
  const made = await createServer({ dbPath, sourcePath: FIXTURE });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
});
test.after(() => { srv?.close(); db?.close(); });

test('filesEverInContext: cross-session file rows with opened/seen split', fixtureGate(), async () => {
  const rows = await filesEverInContext(db.connection);
  assert.ok(rows.length >= 1, 'some files entered context');
  assert.ok('label' in rows[0] && 'sessions' in rows[0] && 'opened' in rows[0] && 'seen' in rows[0]);
  assert.ok(rows.every((r) => Number(r.events) >= 1));
});

test('cacheHitDistribution + breakKindComparison: canonical, no provider-native leak', fixtureGate(), async () => {
  const dist = await cacheHitDistribution(db.connection);
  assert.ok(dist.length >= 1 && 'provider' in dist[0] && 'avg_hit_ratio' in dist[0]);
  const bk = await breakKindComparison(db.connection);
  assert.ok(bk.length >= 1 && 'break_kind' in bk[0]);
  assert.ok(!JSON.stringify({ dist, bk }).includes('cache_read_input_tokens'), 'invariant 3');
});

test('unmappedFields: named read path through the contract (empty is valid)', fixtureGate(), async () => {
  const rows = await unmappedFields(db.connection);
  assert.ok(Array.isArray(rows));
});

test('forkTree: recursive lineage rooted at a real session', fixtureGate(), async () => {
  const sessions = await listSessions(db.connection);
  const root = sessions[0].session_id;
  const tree = await forkTree(db.connection, root);
  assert.equal(tree.session_id, root);
  assert.ok(Array.isArray(tree.children));
});

test('resourceLifecycle: folds flat events into segments + loads', fixtureGate(), async () => {
  const sessions = (await listSessions(db.connection)).sort((a, b) => b.call_count - a.call_count);
  const life = await resourceLifecycle(db.connection, sessions[0].session_id);
  assert.ok(Array.isArray(life));
  if (life.length) { assert.ok('segments' in life[0] && 'loads' in life[0] && 'label' in life[0]); }
});

test('runNamed: dispatches by name, throws on unknown / missing arg', fixtureGate(), async () => {
  assert.ok(Object.keys(NAMED_QUERIES).length >= 10);
  const rows = await runNamed(db.connection, 'filesEverInContext');
  assert.ok(Array.isArray(rows));
  assert.throws(() => runNamed(db.connection, 'nope'), /unknown named query/);
  assert.throws(() => runNamed(db.connection, 'sessionCalls', {}), /missing arg/);
});

test('HTTP: /api/analysis + /api/unmapped serve canonical JSON, no-leak', fixtureGate(), async () => {
  const a = await get(port, '/api/analysis');
  assert.equal(a.status, 200);
  const aj = JSON.parse(a.body);
  assert.ok('files' in aj && 'cacheHits' in aj && 'breakKinds' in aj);
  assert.ok(!a.body.includes('cache_read_input_tokens'), 'invariant 3');
  const u = await get(port, '/api/unmapped');
  assert.equal(u.status, 200);
  assert.ok('unmapped' in JSON.parse(u.body));
});
