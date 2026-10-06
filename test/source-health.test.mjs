// test/source-health.test.mjs — nothing on the read path is skipped without a word (4.4:83 ·
// invariant 4 · the user's 2026-10-06 requirement, D38). `/api/projects` carries
// `source`: every entry the board did not read with its reason, the lines that would not parse, and
// in shard mode what the meta.json listing leaves out. `asight etl <dir>` returns and prints the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { serveSource, collectorHome } from '../src/paths.mjs';
import { etlFile, reportSkips } from '../src/etl/cli.mjs';

const env = (id, sid) => JSON.stringify({
  ts: '2026-10-06T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  req_headers: { 'x-claude-code-session-id': sid, 'user-agent': 'claude-cli/2.1.0 (external, cli)' },
  req_body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: sid }] }),
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 1, output_tokens: 1 } },
  id, ts_request: '2026-10-06T00:00:00.000Z', is_llm_call: true,
}) + '\n';
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p },
  (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-health-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
async function projects(t, sourcePath) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return get(server.address().port, '/api/projects');
}
// a home with one good capture (plus a torn line), a dangling link, a compressed capture and a config file
function messyHome(t) {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'claude-capture.ndjson'), env('a-1', 'GOOD') + '{"id":"a-2","req_bo\n' + env('a-3', 'GOOD'));
  fs.symlinkSync(path.join(home, 'gone.ndjson'), path.join(home, 'dangling.ndjson'));
  fs.writeFileSync(path.join(home, 'old.ndjson.gz'), 'x');
  fs.writeFileSync(path.join(home, 'config.json'), '{}');
  fs.mkdirSync(collectorHome(home));
  fs.writeFileSync(path.join(collectorHome(home), 'capture-2026-10-06.ndjson'), env('c-1', 'COLLECTED'));
  return home;
}
const byName = (sk) => Object.fromEntries(sk.map((x) => [x.name, [x.reason, x.attention]]));

test('the board lists what it did not read, with a reason, and counts the lines that would not parse', async (t) => {
  const home = messyHome(t);
  const pj = await projects(t, serveSource({ home, legacyExists: false }));
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.session_id).sort(), ['COLLECTED', 'GOOD']);
  assert.deepEqual(byName(pj.source.skipped), {
    'dangling.ndjson': ['broken-symlink', true], 'old.ndjson.gz': ['compressed', true], 'config.json': ['not-ndjson', false],
  }, 'the collector dir is a root of its own, not a skipped directory');
  assert.deepEqual(pj.source.corrupt_lines, { [path.join(home, 'claude-capture.ndjson')]: 1 });
});

test('shard mode says what the meta.json listing leaves out: flat captures beside it, a shard without meta', async (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'S1')); fs.writeFileSync(path.join(root, 'S1', 'calls.ndjson'), env('s-1', 'S1'));
  fs.writeFileSync(path.join(root, 'S1', 'meta.json'), JSON.stringify({ session_id: 'S1', project_slug: '_unresolved', calls: 1 }));
  fs.mkdirSync(path.join(root, 'S2')); fs.writeFileSync(path.join(root, 'S2', 'calls.ndjson'), env('s-2', 'S2'));
  fs.writeFileSync(path.join(root, 'claude-capture.ndjson'), env('f-1', 'FLAT'));
  fs.mkdirSync(path.join(root, '_unassigned')); fs.writeFileSync(path.join(root, '_unassigned', 'calls.ndjson'), env('u-1', 'U'));
  const pj = await projects(t, root);
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.session_id), ['S1']);
  assert.deepEqual(byName(pj.source.skipped), {
    'claude-capture.ndjson': ['flat-file-in-shard-mode', true], S2: ['no-meta', true], _unassigned: ['no-meta', true],
  });
});

test('`asight etl <dir>` returns and prints what it did not read and the lines it could not parse', async (t) => {
  const home = messyHome(t);
  const out = await etlFile(home, { dbPath: path.join(tmp(t), 'h.duckdb') });
  assert.deepEqual(byName(out.skipped), {
    collector: ['directory', false], 'config.json': ['not-ndjson', false],
    'dangling.ndjson': ['broken-symlink', true], 'old.ndjson.gz': ['compressed', true],
  });
  assert.deepEqual(out.corrupt_lines, { [path.join(home, 'claude-capture.ndjson')]: 1 });
  const lines = []; reportSkips(out, (l) => lines.push(l));
  assert.deepEqual(lines, [
    'ETL: not read: dangling.ndjson (broken-symlink)', 'ETL: not read: old.ndjson.gz (compressed)',
    `ETL: 1 unparseable line(s) not ingested: ${path.join(home, 'claude-capture.ndjson')}`,
    'ETL: 1 subdirectory not descended (only top-level *.ndjson is read): collector',
    'ETL: 1 other file not read (not *.ndjson): config.json',
  ]);
});

test('a root whose block index could not be built is reported, even after it becomes readable to the listing', { skip: process.getuid?.() === 0 && 'root reads anything' }, async (t) => {
  const r1 = tmp(t), r2 = tmp(t);
  fs.writeFileSync(path.join(r1, 'a.ndjson'), env('a-1', 'A'));
  fs.writeFileSync(path.join(r2, 'b.ndjson'), env('b-1', 'B'));
  fs.chmodSync(r2, 0o000); // the whole root cannot be listed at startup: its index is never built
  t.after(() => { try { fs.chmodSync(r2, 0o700); } catch { /* already restored and removed */ } });
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: [r1, r2] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  fs.chmodSync(r2, 0o700);
  const pj = await get(server.address().port, '/api/projects');
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.session_id).sort(), ['A', 'B']);
  const hit = pj.source.skipped.find((x) => x.reason === 'block-index-failed');
  assert.deepEqual(hit && [path.join(hit.root, hit.name), hit.attention], [r2, true], JSON.stringify(pj.source.skipped));
});

test('shard mode: a root that cannot be listed is reported, and the other roots\' reports survive', { skip: process.getuid?.() === 0 && 'root reads anything' }, async (t) => {
  const r1 = tmp(t), r2 = tmp(t);
  fs.mkdirSync(path.join(r1, 'S1')); fs.writeFileSync(path.join(r1, 'S1', 'calls.ndjson'), env('s-1', 'S1'));
  fs.writeFileSync(path.join(r1, 'S1', 'meta.json'), JSON.stringify({ session_id: 'S1', project_slug: '_unresolved', calls: 1 }));
  fs.writeFileSync(path.join(r1, 'x.ndjson.gz'), 'x');
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: [r1, r2] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  fs.rmSync(r2, { recursive: true, force: true }); // gone after startup
  const pj = await get(server.address().port, '/api/projects');
  assert.deepEqual(byName(pj.source.skipped), { 'x.ndjson.gz': ['compressed', true], [path.basename(r2)]: ['root-unreadable', true] });
  assert.equal(pj.source.corrupt_lines, null, 'shard streams are not measured: null, never {} ("none")');
});

test('a single-file source that cannot be read is listed once, under its own directory', { skip: process.getuid?.() === 0 && 'root reads anything' }, async (t) => {
  const dir = tmp(t), f = path.join(dir, 'cap.ndjson');
  fs.writeFileSync(f, env('c-1', 'C'), { mode: 0o000 });
  t.after(() => { try { fs.chmodSync(f, 0o600); } catch {} });
  const pj = await projects(t, f);
  assert.deepEqual(pj.source.skipped.filter((x) => x.attention).map((x) => [x.root, x.name, x.reason]), [[dir, 'cap.ndjson', 'unreadable']]);
});

// Fault injection: `fs/promises.open` (the block index) and `fs.openSync` (the loader's line-end scan)
// throw for one file name while `failing()` says so. Restored after the test.
async function injectFaults(t, name, failing) {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const req = createRequire(import.meta.url), fsp = req('fs/promises'), fsc = req('fs');
  const realOpen = fsp.open, realOpenSync = fsc.openSync, eio = () => Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', syscall: 'read' });
  fsp.open = async (p, ...rest) => { const fh = await realOpen(p, ...rest); if (path.basename(String(p)) === name && failing('index')) fh.read = async () => { throw eio(); }; return fh; };
  fsc.openSync = (p, ...rest) => { if (path.basename(String(p)) === name && failing('loader')) throw eio(); return realOpenSync(p, ...rest); };
  syncBuiltinESMExports();
  t.after(() => { fsp.open = realOpen; fsc.openSync = realOpenSync; syncBuiltinESMExports(); });
}

test('a single-file source whose block index keeps failing stays reported on every poll', async (t) => {
  const dir = tmp(t), f = path.join(dir, 'cap.ndjson');
  fs.writeFileSync(f, env('c-1', 'C'));
  await injectFaults(t, 'cap.ndjson', (who) => who === 'index');
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: f });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  for (let i = 0; i < 3; i++) {
    const pj = await get(server.address().port, '/api/projects');
    assert.deepEqual(pj.source.skipped.filter((x) => x.attention).map((x) => [x.name, x.reason, x.error]), [['cap.ndjson', 'unreadable', 'EIO']], `poll ${i}`);
  }
});

test('a read error that clears with no stat change is retried after the retry window: sessions, views and the bar recover', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.ndjson'), env('a-1', 'A'));
  fs.writeFileSync(path.join(dir, 'b.ndjson'), env('b-1', 'A')); // the same session's next call, in the failing file
  let broken = true;
  await injectFaults(t, 'b.ndjson', () => broken);
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: dir, readRetryMs: 150 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const calls = async () => (await get(port, '/api/projects')).projects.flatMap((p) => p.sessions).map((s) => s.calls);
  const steps = async () => (await get(port, '/api/session?id=A&cursor=0&limit=60')).analyzed.steps;
  assert.deepEqual(await calls(), [1]);
  assert.deepEqual((await steps()).map((x) => x.id), ['a-1'], 'a view is built (and memoized) while b.ndjson fails');
  broken = false; // the disk recovers; nothing about the file changes
  assert.deepEqual(await calls(), [1], 'inside the window the failed pass is served, not retried');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await calls(), [2]);
  assert.deepEqual((await get(port, '/api/projects')).source.skipped.filter((x) => x.attention), []);
  const view = await steps();
  assert.deepEqual(view.map((x) => x.id), ['a-1', 'b-1'], 'the memoized view is rebuilt, not served from the failed pass');
  const b = await get(port, '/api/block?ref=' + encodeURIComponent(view[1].flat[0].text_ref));
  assert.equal(b.status, 'ok', 'the block index retried too');
});
