import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { ccLlmRecord } from './fixtures/cc-record.mjs';

// SECURITY (anti DNS-rebind) — the DATA plane must be gated exactly like the control plane.
// Loopback binding alone does NOT protect it: a page on any site can resolve its own hostname to
// 127.0.0.1, at which point the browser treats http://evil.example:<port>/api/* as SAME-ORIGIN, CORS
// never engages, and the entire verbatim LLM corpus is readable by that page. Only a loopback Host
// allowlist (+ Origin check) stops it. Read-only does not make exfiltration harmless.

const req = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', reject); r.end();
});

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-rebind-'));
  fs.writeFileSync(path.join(dir, 'cap.ndjson'),
    JSON.stringify(ccLlmRecord({ env: { req_headers: { 'x-claude-code-session-id': 'sess-secret' } } })) + '\n');
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}

test('data plane REJECTS a spoofed (non-loopback) Host on every surface', async () => {
  const { server, port } = await serve();
  try {
    for (const p of ['/api/projects', '/api/session?id=sess-secret', '/api/control', '/']) {
      const r = await req(port, p, { host: 'evil.example.com' });
      assert.equal(r.status, 403, `${p} must 403 on a rebound Host`);
      assert.doesNotMatch(r.body, /sess-secret|claude-opus/, `${p} must leak NOTHING in the refusal`);
    }
  } finally { server.close(); }
});

test('data plane REJECTS a cross-origin request', async () => {
  const { server, port } = await serve();
  try {
    const r = await req(port, '/api/projects', { origin: 'https://evil.example.com' });
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /sess-secret/);
  } finally { server.close(); }
});

test('legitimate loopback access still works (the gate must not break the board)', async () => {
  const { server, port } = await serve();
  try {
    for (const host of ['127.0.0.1', 'localhost']) {
      const r = await req(port, '/api/projects', { host: `${host}:${port}` });
      assert.equal(r.status, 200, `${host} must be allowed`);
    }
    // the board's own same-origin fetch carries a loopback Origin
    const r2 = await req(port, '/api/projects', { origin: `http://127.0.0.1:${port}` });
    assert.equal(r2.status, 200);
  } finally { server.close(); }
});
