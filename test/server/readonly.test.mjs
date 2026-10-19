// test/server/readonly.test.mjs — V84 (RFC 1.6 §1057, 4.4 验收 3 · 7): the board is read-only
// and reachable from this machine only.
//
// The loopback bind is checked against a real external address of this host (not a flag), the
// read-only claim against what HOME gained after a round of requests.
// The port-in-use line is test/cli/board.test.mjs's.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as face from './face.mjs';
import { withToken } from './face.mjs';
import { QUERIES } from '../../src/query/named/index.mjs';
import { rawHome, writeSegment, snapshot } from '../query/raw-home.mjs';

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
    // 4.4 #7: the writes with no endpoint (install, uninstall, autostart; another method on classes) are 405, and HOME is as it was.
    const before = snapshot(home);
    for (const [method, p] of [['POST', '/control/install'], ['POST', '/control/uninstall'], ['POST', '/control/autostart'], ['PUT', '/control/classes'], ['DELETE', '/control/classes'], ['PATCH', '/control/classes']]) {
      assert.equal((await request(port, p, { method })).status, 405, `${method} ${p}`);
    }
    assert.deepEqual(snapshot(home), before);
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
