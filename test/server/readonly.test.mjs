// test/server/readonly.test.mjs — V84 (RFC 1.6 §1057, 4.4 验收 3 · 7): `asight serve` is read-only
// and reachable from this machine only.
//
// The loopback bind is checked against a real external address of this host (not a flag), the
// read-only claim against what HOME gained after a round of requests, and the port-in-use line
// against the CLI itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import * as face from './face.mjs';
import { withToken } from './face.mjs';
import { run as serveRun, DEFAULT_PORT } from '../../src/cli/serve.mjs';
import { EXIT } from '../../src/cli/schema.mjs';
import { QUERIES } from '../../src/query/named/index.mjs';
import { rawHome, writeSegment } from '../query/raw-home.mjs';

const SEGMENT = '20261018T100000Z';

const request = (port, p, { method = 'GET', host } = {}) => face.request(port, p, { method, headers: withToken(host ? { host } : {}) });

async function serve(home) {
  const f = await face.serveFace({ home });
  return { server: f.server, port: f.port, close: f.close };
}

test('V84: the board listens on 127.0.0.1 only — an external address of this host cannot reach it', async (t) => {
  const home = rawHome('asight-ro-');
  const { server, port, close } = await serve(home);
  const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
  try {
    assert.equal(server.address().address, '127.0.0.1');
    if (!ext) return t.skip('this machine has no external IPv4 address to try');
    const err = await new Promise((resolve) => {
      const s = net.connect({ host: ext.address, port, timeout: 2000 });
      s.on('connect', () => { s.destroy(); resolve(null); });
      s.on('timeout', () => { s.destroy(); resolve('ETIMEDOUT'); });
      s.on('error', (e) => resolve(e.code));
    });
    assert.ok(err, `the board accepted a connection on ${ext.address} — it must bind the loopback only`);
  } finally { close(); }
});

test('V84: there is no non-GET data route, and the gate holds on every surface', async () => {
  const home = rawHome('asight-ro-');
  const { server, port, close } = await serve(home);
  try {
    for (const name of Object.keys(QUERIES)) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await request(port, `/api/${name}`, { method });
        assert.equal(r.status, 405, `${method} /api/${name} → ${r.status}: the board has no write interface (D26 · D59③)`);
      }
    }
    // The control plane's write endpoints are not mounted yet: every non-GET there is 405 too (4.4 门 ④).
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await request(port, '/control/classes', { method })).status, 405, method);
    assert.equal((await request(port, '/api/sessions', { host: 'localhost' })).status, 200);
  } finally { close(); }
});

test('V84: a round of requests leaves HOME with nothing new but index/', async () => {
  const home = rawHome('asight-ro-');
  writeSegment(home, SEGMENT, [{ sessionKey: 'sess-1' }]);
  const before = fs.readdirSync(home).sort();
  const raw = fs.readdirSync(path.join(home, 'raw')).map((f) => {
    const st = fs.statSync(path.join(home, 'raw', f));
    return [f, st.size, st.ino, st.mtimeMs];
  });
  const { server, port, close } = await serve(home);
  try {
    for (const name of Object.keys(QUERIES)) await request(port, `/api/${name}?id=sess-1`);
  } finally { close(); }
  const added = fs.readdirSync(home).sort().filter((e) => !before.includes(e));
  assert.deepEqual(added.filter((e) => e !== 'index'), [], `serve wrote more than ~/.asight/index/: ${added.join(', ')}`);
  assert.deepEqual(fs.readdirSync(path.join(home, 'raw')).map((f) => {
    const st = fs.statSync(path.join(home, 'raw', f));
    return [f, st.size, st.ino, st.mtimeMs];
  }), raw, 'a segment file changed — the service never writes records (invariant 2)');
});

test('V84: a port already in use prints §4.3\'s line and exits 1', async () => {
  const taken = http.createServer(() => {});
  taken.listen(0, '127.0.0.1'); await once(taken, 'listening');
  const port = taken.address().port;
  const err = [];
  try {
    const code = await serveRun([], { io: { out() {}, err: (s) => err.push(s) }, args: { flags: { port: String(port) } } });
    assert.equal(code, EXIT.incomplete);
    assert.deepEqual(err, [`asight serve: port ${port} is in use. Try: asight serve --port ${port + 1}`]);
  } finally { taken.close(); }
  assert.equal(DEFAULT_PORT, 9800, 'the default port is §4.3\'s');
});
