// test/server/gate.test.mjs — the board face's gate (RFC 4.4 门 · 验收 2 · 5 · 8; 必拒 if it stops covering the data plane).
//
// SECURITY (anti DNS-rebind) — the DATA plane must be gated exactly like the static plane. Loopback binding alone does NOT
// protect it: a page on any site can resolve its own hostname to 127.0.0.1, at which point the browser treats
// http://evil.example:<port>/api/* as SAME-ORIGIN, CORS never engages, and the entire verbatim LLM corpus is readable by that
// page. Only a loopback Host allowlist (+ Origin check) stops it; the per-user token (D26③) then keeps other local pages and
// other accounts out of the data and control planes.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED } from '../../src/server.mjs';
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs';
import { rawHome, writeSegment } from '../query/raw-home.mjs';
import { serveFace, request as req, withToken } from './face.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

async function serve(opts = {}) {
  const home = rawHome('asight-gate-');
  writeSegment(home, '20261018T100000Z', [{ sessionKey: 'sess-secret' }]);
  return serveFace({ home, ...opts });
}

/** An `fs` that counts every call made through it, and a query service that counts every call made to it. */
function counting() {
  const seen = { fs: 0, relay: 0, warm: 0 };
  const fs = new Proxy(nodeFs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => (seen.fs++, t[k](...a)) : t[k]) });
  const query = { relay: ({ res }) => { seen.relay++; res.writeHead(200, {}); res.end('{}'); }, warm: () => { seen.warm++; } };
  return { seen, fs, query };
}

test('the gate REJECTS a spoofed (non-loopback) Host on every surface', async () => {
  const f = await serve();
  try {
    for (const p of ['/api/sessions', '/api/session?id=sess-secret', '/api/calls', '/', '/control/status']) {
      const r = await req(f.port, p, { headers: withToken({ host: 'evil.example.com' }) });
      assert.equal(r.status, 403, `${p} must 403 on a rebound Host`);
      assert.doesNotMatch(r.body, /sess-secret/, `${p} must leak NOTHING in the refusal`);
    }
    assert.deepEqual(f.relays, []);
  } finally { f.close(); }
});

test('the gate REJECTS a cross-origin request', async () => {
  const f = await serve();
  try {
    const r = await req(f.port, '/api/sessions', { headers: withToken({ origin: 'https://evil.example.com' }) });
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /sess-secret/);
  } finally { f.close(); }
});

test('legitimate loopback access with the token still works (the gate must not break the board)', async () => {
  const f = await serve();
  try {
    for (const host of ['127.0.0.1', 'localhost']) {
      const r = await req(f.port, '/api/sessions', { headers: withToken({ host: `${host}:${f.port}` }) });
      assert.equal(r.status, 200, `${host} must be allowed`);
      assert.equal(JSON.parse(r.body).command, 'sessions', 'a legitimate read still answers the document');
    }
    // the board's own same-origin fetch carries a loopback Origin
    assert.equal((await req(f.port, '/api/sessions', { headers: withToken({ origin: `http://127.0.0.1:${f.port}` }) })).status, 200);
  } finally { f.close(); }
});

test('no token or a wrong token: 403 on the data and control planes, with no file read and nothing relayed (4.4 验收 8)', async () => {
  const c = counting();
  const f = await serve({ fs: c.fs, query: c.query });
  try {
    for (const p of ['/api/sessions', '/api/status', '/control/status']) {
      for (const headers of [{}, { [CONTROL_TOKEN_HEADER]: 'wrong' }, { [CONTROL_TOKEN_HEADER]: '' }]) {
        assert.equal((await req(f.port, p, { headers })).status, 403, `${p} ${JSON.stringify(headers)}`);
      }
    }
    assert.deepEqual([c.seen.fs, c.seen.relay], [0, 0], 'a refused request touched nothing');
    assert.equal((await req(f.port, '/')).status, 200, 'the static plane loads without the token');
  } finally { f.close(); }
});

test('the static plane: src/web/v2 and the shared modules from memory, nothing else (4.4 验收 5)', async () => {
  const f = await serve(counting());
  try {
    // one board (1.2 §托管与打开): `/`, the address `asight board` opens, is the board's own page, and no second page is served beside it
    const root = await req(f.port, '/');
    assert.equal(root.status, 200);
    assert.equal(root.body, nodeFs.readFileSync(path.join(SRC, 'web', 'v2', 'index.html'), 'utf8'), '`/` is src/web/v2/index.html');
    const pages = [];
    const walk = (d) => { for (const e of nodeFs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.html') && pages.push(e.name) };
    walk(path.join(SRC, 'web'));
    assert.deepEqual(pages, ['index.html'], 'src/web holds one page');
    for (const s of SHARED) {
      const r = await req(f.port, `/${s}`);
      assert.equal(r.status, 200, s);
      assert.match(r.headers['content-type'], /^text\/javascript/, s);
      assert.equal(r.body, nodeFs.readFileSync(path.join(SRC, s), 'utf8'), `${s}: the module's own bytes`);
    }
    for (const p of ['/../package.json', '/..%2fpackage.json', '/cli/commands.mjs', '/server.mjs', '/web/index.html', '/v2/index.html']) {
      assert.equal((await req(f.port, p)).status, 404, `${p} must not reach a file outside the static plane`);
    }
    assert.equal((await req(f.port, '/api/nope', { headers: withToken() })).status, 404);
    assert.deepEqual(JSON.parse((await req(f.port, '/api/a/b', { headers: withToken() })).body), { error: 'unknown endpoint' });
  } finally { f.close(); }
});

test('the shared modules are pure and import-closed: no node:*, every relative import is another shared entry (4.4 静态面)', () => {
  for (const s of SHARED) {
    const src = nodeFs.readFileSync(path.join(SRC, s), 'utf8');
    const specs = [...src.matchAll(/^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] || m[2] || m[3]);
    for (const spec of specs) {
      assert.ok(spec.startsWith('.'), `${s} imports ${spec}: only relative imports of other shared modules are allowed`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(s), spec));
      assert.ok(SHARED.includes(target), `${s} imports ${spec} (${target}), which the allowlist does not serve`);
    }
  }
});

