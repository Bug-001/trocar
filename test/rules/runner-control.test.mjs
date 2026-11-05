// 12i: a script does not reach the control routes (spec 5.1 §隔离). A real control server with its token, and a real rule process: the token's file is outside what the process may
// read, and a request without the token gets the server's 401. Linux's token comes with the engine step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { startControlServer } from '../../src/collector/core/control.mjs';
import { openOneShot } from '../../src/rules/launch.mjs';

const unit = { on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm', status: null, event_index: null, sse: false,
  headers: [], req_headers: [], encoding: null, body: Buffer.from('{}') };

test('12i: the token cannot be read, and a request without it is refused', async () => {
  const collector = tmpDir('trocar-collector-'), token = 't'.repeat(32), socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(collector)}` : path.join(collector, 'c.sock'), control = path.join(collector, 'control.json');
  fs.writeFileSync(control, JSON.stringify({ path: socketPath, token }), { mode: 0o600 });
  let reached = 0;
  const server = await startControlServer({ socketPath, token, routes: { 'POST /off': () => { reached++; return {}; } } });
  const dir = tmpDir('trocar-script-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'
import http from 'node:http'
export default async () => {
  let file
  try { file = fs.readFileSync(${JSON.stringify(control)}, 'utf8') } catch (e) { file = e.code }
  const status = await new Promise((done) => {
    const req = http.request({ socketPath: ${JSON.stringify(socketPath)}, method: 'POST', path: '/off' }, (res) => { res.resume(); done(res.statusCode) })
    req.on('error', (e) => done(e.code))
    req.end()
  })
  console.log(JSON.stringify({ file, status }))
}`);
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], maxTaskMs: 3000 });
  try {
    const { file, status } = JSON.parse((await runner.run(unit)).console);
    assert.equal(file, 'ERR_ACCESS_DENIED');
    assert.equal(status, 401);
    assert.equal(reached, 0);
  } finally {
    await runner.close();
    await server.close();
  }
});
