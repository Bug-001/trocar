import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { ccLlmRecord } from './fixtures/cc-record.mjs';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-dir-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-dir-'));
  const f = path.join(dir, 'claude-capture.ndjson');
  fs.writeFileSync(f, JSON.stringify(sess('sess-A')) + '\n');
  const { server, port } = await serveDir(dir);
  try {
    assert.doesNotMatch((await get(port, '/api/projects')).body, /sess-C/);
    fs.appendFileSync(f, JSON.stringify(sess('sess-C')) + '\n');
    assert.match((await get(port, '/api/projects')).body, /sess-C/, 'append is picked up on the next poll');
  } finally { server.close(); }
});
