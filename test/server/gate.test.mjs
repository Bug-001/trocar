// test/server/gate.test.mjs — the Host / Origin gate (RFC 4.4 门, 验收 2; 必拒 if it stops covering
// the data plane).
//
// SECURITY (anti DNS-rebind) — the DATA plane must be gated exactly like the static plane. Loopback
// binding alone does NOT protect it: a page on any site can resolve its own hostname to 127.0.0.1,
// at which point the browser treats http://evil.example:<port>/api/* as SAME-ORIGIN, CORS never
// engages, and the entire verbatim LLM corpus is readable by that page. Only a loopback Host
// allowlist (+ Origin check) stops it. Read-only does not make exfiltration harmless.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';
import { rawHome, writeSegment } from '../query/raw-home.mjs';

const req = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', reject); r.end();
});

async function serve() {
  const home = rawHome('asight-gate-');
  writeSegment(home, '20261018T100000Z', [{ sessionKey: 'sess-secret' }]);
  const { server } = createServer({ home });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}

test('the gate REJECTS a spoofed (non-loopback) Host on every surface', async () => {
  const { server, port } = await serve();
  try {
    for (const p of ['/api/sessions', '/api/session?id=sess-secret', '/api/calls', '/']) {
      const r = await req(port, p, { host: 'evil.example.com' });
      assert.equal(r.status, 403, `${p} must 403 on a rebound Host`);
      assert.doesNotMatch(r.body, /sess-secret/, `${p} must leak NOTHING in the refusal`);
    }
  } finally { server.close(); }
});

test('the gate REJECTS a cross-origin request', async () => {
  const { server, port } = await serve();
  try {
    const r = await req(port, '/api/sessions', { origin: 'https://evil.example.com' });
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /sess-secret/);
  } finally { server.close(); }
});

test('legitimate loopback access still works (the gate must not break the board)', async () => {
  const { server, port } = await serve();
  try {
    for (const host of ['127.0.0.1', 'localhost']) {
      const r = await req(port, '/api/sessions', { host: `${host}:${port}` });
      assert.equal(r.status, 200, `${host} must be allowed`);
      assert.match(r.body, /"command":"sessions"/, 'a legitimate read still answers the document');
    }
    // the board's own same-origin fetch carries a loopback Origin
    assert.equal((await req(port, '/api/sessions', { origin: `http://127.0.0.1:${port}` })).status, 200);
  } finally { server.close(); }
});

test('the static plane serves only files inside src/web (4.4 验收 5)', async () => {
  const { server, port } = await serve();
  try {
    assert.equal((await req(port, '/')).status, 200);
    for (const p of ['/../package.json', '/..%2fpackage.json', '/api/nope']) {
      assert.equal((await req(port, p)).status, 404, `${p} must not reach a file outside src/web`);
    }
  } finally { server.close(); }
});
