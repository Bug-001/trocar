// test/source-health.test.mjs — nothing on the read path is skipped without a word (4.4:83 ·
// invariant 4 · the user's 2026-10-06 requirement that becomes D38). `/api/projects` carries
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
  const pj = await projects(t, root);
  assert.deepEqual(pj.projects.flatMap((p) => p.sessions).map((s) => s.session_id), ['S1']);
  assert.deepEqual(byName(pj.source.skipped), {
    'claude-capture.ndjson': ['flat-file-in-shard-mode', true], S2: ['no-meta', true],
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
    'ETL: 2 other entries ignored (not capture files): collector, config.json',
  ]);
});
