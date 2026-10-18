// test/server-live-append.test.mjs — 4.4 #10, the live board: a call the collector writes AFTER
// `asight serve` started is listed, and its blocks open with the exact captured bytes. The server is
// built the way `asight serve` builds it (serveSource → createServer) and the new call is appended by
// the collector's REAL record store, which stays open across the server's start like a running daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { serveSource, collectorHome } from '../src/paths.mjs';
import { createRecordStore } from '../src/collector/core/record/store.mjs';
import { etlFile } from '../src/etl/cli.mjs';

const env = (id, ts, text) => ({
  ts, endpoint: '/v1/messages?beta=true', method: 'POST',
  req_headers: { 'x-claude-code-session-id': 'LIVE', 'user-agent': 'claude-cli/2.1.0 (external, cli)' },
  req_body: JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 1, output_tokens: 1 } },
  id, ts_request: ts, is_llm_call: true, capture: 'transparent', proc: { pid: 7, exe: '/x/claude', agent: 'claude-code' },
});
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p },
  (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));

test('a call captured after `asight serve` started opens with its exact bytes (4.4 #10)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createRecordStore({ root: collectorHome(home), raw: collectorHome(home), onError: (e) => { throw e; } });
  t.after(() => store.close());
  store.envelope(env('req_x-00001', '2026-10-06T10:00:00.000Z', 'before the board started'));
  const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: serveSource({ home, legacyExists: false }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;

  const late = env('req_x-00002', '2026-10-06T10:00:05.000Z', 'captured while the board is up — ünïcode');
  store.envelope(late);
  const view = JSON.parse((await get(port, '/api/session?id=LIVE')).body);
  const step = view.analyzed.steps.find((s) => s.id === late.id);
  assert.ok(step, 'the late call is listed');
  assert.ok(step.flat.length >= 2);
  for (const b of step.flat) {
    const r = await get(port, '/api/block?ref=' + encodeURIComponent(b.text_ref));
    assert.equal(r.status, 200, r.body);
    const got = JSON.parse(r.body);
    const [s, e] = b.text_ref.split('::').at(-1).split('-').map(Number);
    assert.deepEqual([got.status, got.fidelity, got.text], ['ok', 'verbatim', late.req_body.slice(s, e)]);
  }
});

test('the SQL replay (/api/call/:id/context) also refreshes: a call ETL\'d from bytes the board indexed late resolves', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const early = env('req_y-00001', '2026-10-06T11:00:00.000Z', 'early'), late = env('req_y-00002', '2026-10-06T11:00:05.000Z', 'late');
  const line = (e) => JSON.stringify(e) + '\n';
  // the store is built from the whole capture; the board starts while its copy holds only `early`
  const full = path.join(home, 'etl-src'); fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'capture-2026-10-06.ndjson'), line(early) + line(late));
  const dbPath = path.join(home, 'x.duckdb');
  await etlFile(full, { dbPath });
  const col = collectorHome(home); fs.mkdirSync(col);
  fs.writeFileSync(path.join(col, 'capture-2026-10-06.ndjson'), line(early));
  const { server } = await createServer({ dbPath, sourcePath: serveSource({ home, legacyExists: false }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  fs.appendFileSync(path.join(col, 'capture-2026-10-06.ndjson'), line(late));
  const r = JSON.parse((await get(server.address().port, `/api/call/${late.id}/context`)).body);
  assert.ok(r.blocks.length >= 2);
  for (const b of r.blocks) {
    assert.deepEqual([b.source_status, b.source_fidelity], ['ok', 'verbatim']);
    assert.ok(late.req_body.includes(b.text));
  }
});

test('a record the board catches half-written is listed once the writer finishes it — never lost, never counted corrupt', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const col = collectorHome(home); fs.mkdirSync(col);
  const f = path.join(col, 'capture-2026-10-06.ndjson');
  const line = (e) => JSON.stringify(e) + '\n';
  const a = line(env('req_z-00001', '2026-10-06T12:00:00.000Z', 'whole')), b = line(env('req_z-00002', '2026-10-06T12:00:05.000Z', 'written in two pieces'));
  fs.writeFileSync(f, a + b.slice(0, 40)); // the board polls while the writer is mid-line
  const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: serveSource({ home, legacyExists: false }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const calls = async () => JSON.parse((await get(port, '/api/projects')).body);
  let pj = await calls();
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.calls), [1]);
  assert.deepEqual([pj.source.corrupt_lines, pj.source.tail_pending], [{}, { [f]: 40 }], 'the unfinished line is reported as pending, not as corrupt');
  fs.appendFileSync(f, b.slice(40));
  pj = await calls();
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.calls), [2], 'the finished record is listed');
  assert.deepEqual([pj.source.corrupt_lines, pj.source.tail_pending], [{}, {}]);
  const view = JSON.parse((await get(port, '/api/session?id=LIVE')).body);
  assert.deepEqual(view.analyzed.steps.map((s) => s.id), ['req_z-00001', 'req_z-00002']);
});

test('a complete last record with no trailing newline is listed; a torn last line is reported, not counted corrupt', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const f = path.join(home, 'claude-capture.ndjson'), g = path.join(home, 'codex-capture.ndjson');
  const j = (id, ts, text) => JSON.stringify(env(id, ts, text));
  fs.writeFileSync(f, j('n-1', '2026-10-06T13:00:00.000Z', 'one') + '\n' + j('n-2', '2026-10-06T13:00:01.000Z', 'two, no newline after me'));
  fs.writeFileSync(g, j('t-1', '2026-10-06T13:00:02.000Z', 'three') + '\n' + j('t-2', '2026-10-06T13:00:03.000Z', 'torn').slice(0, 50));
  const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: home });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const pj = JSON.parse((await get(port, '/api/projects')).body);
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.calls), [3]);
  assert.deepEqual([pj.source.corrupt_lines, pj.source.tail_pending], [{}, { [g]: 50 }]);
  fs.appendFileSync(f, '\n' + j('n-3', '2026-10-06T13:00:04.000Z', 'four') + '\n'); // the newline arrives later: no duplicate
  const view = JSON.parse((await get(port, '/api/session?id=LIVE')).body);
  assert.deepEqual(view.analyzed.steps.map((s) => s.id), ['n-1', 'n-2', 't-1', 'n-3']);
});

test('an unreadable capture file is reported and retried, not shown as pending and not remembered as read', { skip: process.getuid?.() === 0 && 'root reads anything' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const locked = path.join(home, 'b.ndjson');
  fs.writeFileSync(path.join(home, 'a.ndjson'), JSON.stringify(env('u-1', '2026-10-06T14:00:00.000Z', 'readable')) + '\n');
  fs.writeFileSync(locked, JSON.stringify({ ...env('u-2', '2026-10-06T14:00:01.000Z', 'locked'), req_headers: { 'x-claude-code-session-id': 'LOCKED' } }) + '\n', { mode: 0o000 });
  const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: [home] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  let pj = JSON.parse((await get(port, '/api/projects')).body);
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.session_id), ['LIVE']);
  assert.deepEqual(pj.source.skipped.filter((x) => x.attention).map((x) => [x.name, x.reason]), [['b.ndjson', 'unreadable']]);
  assert.deepEqual(pj.source.tail_pending, {});
  fs.chmodSync(locked, 0o600); // size and mtime unchanged: only a retry can see it
  pj = JSON.parse((await get(port, '/api/projects')).body);
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.session_id).sort(), ['LIVE', 'LOCKED']);
  assert.deepEqual(pj.source.skipped.filter((x) => x.attention), []);
});

test('a capture file that turns unreadable while the board runs keeps what it showed and is reported', { skip: process.getuid?.() === 0 && 'root reads anything' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  const f = path.join(home, 'a.ndjson');
  t.after(() => { try { fs.chmodSync(f, 0o600); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(f, JSON.stringify(env('v-1', '2026-10-06T15:00:00.000Z', 'read before')) + '\n');
  const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: home });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  await get(port, '/api/projects'); // the board has read v-1
  fs.appendFileSync(f, JSON.stringify(env('v-2', '2026-10-06T15:00:01.000Z', 'after')) + '\n');
  fs.chmodSync(f, 0o000);
  const pj = JSON.parse((await get(port, '/api/projects')).body);
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.calls), [1], 'what was read stays listed');
  assert.deepEqual(pj.source.skipped.filter((x) => x.attention).map((x) => [x.name, x.reason]), [['a.ndjson', 'unreadable']]);
  const page = async () => JSON.parse((await get(port, '/api/session?id=LIVE&cursor=0&limit=60')).body).analyzed.steps.map((s) => s.id);
  assert.deepEqual(await page(), ['v-1']);
  const again = JSON.parse((await get(port, '/api/projects')).body); // served from cache: still reported
  assert.deepEqual(again.source.skipped.filter((x) => x.attention).map((x) => x.name), ['a.ndjson']);
  fs.chmodSync(f, 0o600); // recovers: size and mtime unchanged
  const ok = JSON.parse((await get(port, '/api/projects')).body);
  assert.deepEqual([ok.projects.flatMap((p) => p.sessions).map((s) => s.calls), ok.source.skipped.filter((x) => x.attention)], [[2], []]);
  assert.deepEqual(await page(), ['v-1', 'v-2'], 'the session view is rebuilt, not served from before the recovery');
});
