import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { ccLlmRecord } from './fixtures/cc-record.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// D20 — a source may be a DIRECTORY of per-physical-source NDJSON files (codex-capture.ndjson,
// claude-capture.ndjson, …). The loader reads EVERY *.ndjson, streams each independently (512MB
// safe), and the board groups records into sessions downstream by 3.4 signals — so one 9810 shows
// every harness side by side. Non-.ndjson files are ignored; an append busts the memo sig.
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
});
async function serveDir(dir) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}
const sess = (id) => ccLlmRecord({ env: { id: `rec-${id}`, req_headers: { 'x-claude-code-session-id': id, 'user-agent': 'claude-cli/1.0' } } });

test('dir source: /api/projects surfaces sessions from EVERY *.ndjson, ignores other files', async () => {
  const dir = tmpDir('asight-dir-');
  fs.writeFileSync(path.join(dir, 'claude-capture.ndjson'), JSON.stringify(sess('sess-A')) + '\n');
  fs.writeFileSync(path.join(dir, 'codex-capture.ndjson'), JSON.stringify(sess('sess-B')) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a capture — must be ignored');
  const { server, port } = await serveDir(dir);
  try {
    const r = await get(port, '/api/projects');
    assert.equal(r.status, 200);
    assert.match(r.body, /sess-A/, 'session from file 1 is present');
    assert.match(r.body, /sess-B/, 'session from file 2 is present');
  } finally { server.close(); }
});

test('dir source: appending to one file busts the mtime-memo sig (live poll sees new records)', async () => {
  const dir = tmpDir('asight-dir-');
  const f = path.join(dir, 'claude-capture.ndjson');
  fs.writeFileSync(f, JSON.stringify(sess('sess-A')) + '\n');
  const { server, port } = await serveDir(dir);
  try {
    assert.doesNotMatch((await get(port, '/api/projects')).body, /sess-C/);
    fs.appendFileSync(f, JSON.stringify(sess('sess-C')) + '\n');
    assert.match((await get(port, '/api/projects')).body, /sess-C/, 'append is picked up on the next poll');
  } finally { server.close(); }
});

test('dir source: a symlinked capture file is read like any other (its sessions list and its blocks open)', async () => {
  const dir = tmpDir('asight-dir-');
  const elsewhere = tmpDir('asight-real-');
  fs.writeFileSync(path.join(dir, 'claude-capture.ndjson'), JSON.stringify(sess('sess-A')) + '\n');
  fs.writeFileSync(path.join(elsewhere, 'codex-capture.ndjson'), JSON.stringify(sess('sess-L')) + '\n');
  fs.symlinkSync(path.join(elsewhere, 'codex-capture.ndjson'), path.join(dir, 'codex-capture.ndjson'));
  fs.symlinkSync(path.join(elsewhere, 'gone.ndjson'), path.join(dir, 'dangling.ndjson')); // points nowhere: not a capture
  const { server, port } = await serveDir(dir);
  try {
    const ids = JSON.parse((await get(port, '/api/projects')).body).projects.flatMap((p) => p.sessions.map((s) => s.session_id)).sort();
    assert.deepEqual(ids, ['sess-A', 'sess-L']);
    const view = JSON.parse((await get(port, '/api/session?id=sess-L')).body);
    const ref = view.analyzed.steps[0].flat.find((b) => b.text_ref).text_ref;
    assert.equal(JSON.parse((await get(port, '/api/block?ref=' + encodeURIComponent(ref))).body).status, 'ok');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

