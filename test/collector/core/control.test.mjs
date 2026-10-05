// test/collector/core/control.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { controlSocketPath, startControlServer, controlRequest } from '../../../src/collector/core/control.mjs'

// Unix socket paths are limited to ~104 bytes: keep the temp dir short.
const runDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'as-'))

test('control: the socket path lives under XDG_RUNTIME_DIR; unset is a clear error (G13)', () => {
  assert.equal(controlSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } }), '/run/user/1000/asight/collector.sock')
  assert.throws(() => controlSocketPath({ env: {} }), /XDG_RUNTIME_DIR is not set/)
})

test('control: routes answer JSON; socket is 0600 in a 0700 dir; errors are JSON too', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'asight', 'collector.sock')
  const seen = []
  const srv = await startControlServer({ socketPath, routes: {
    'GET /status': async () => ({ desired: 'off' }),
    'POST /on': async ({ body }) => { seen.push(body); return { desired: 'on' } },
    'GET /flows': async ({ query }) => ({ limit: query.get('limit') }),
    'GET /boom': async () => { throw new Error('kaput') },
  } })
  try {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700)
    assert.deepEqual(await controlRequest({ socketPath, method: 'GET', path: '/status' }), { desired: 'off' })
    assert.deepEqual(await controlRequest({ socketPath, method: 'POST', path: '/on', body: { policy: 'all' } }), { desired: 'on' })
    assert.deepEqual(seen, [{ policy: 'all' }])
    assert.deepEqual(await controlRequest({ socketPath, method: 'GET', path: '/flows?limit=5' }), { limit: '5' })
    await assert.rejects(controlRequest({ socketPath, method: 'GET', path: '/nope' }), /404/)
    await assert.rejects(controlRequest({ socketPath, method: 'GET', path: '/boom' }), /kaput/)
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('control: a second server on a live socket refuses; a stale socket file is replaced', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'asight', 'collector.sock')
  const a = await startControlServer({ socketPath, routes: { 'GET /status': async () => ({ who: 'a' }) } })
  await assert.rejects(startControlServer({ socketPath, routes: {} }), /another collector daemon/)
  await a.close()
  // leave a stale socket file behind (a crashed daemon): bind a raw server and close it without unlinking
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  const raw = net.createServer(); await new Promise((r) => raw.listen(socketPath, r))
  await new Promise((r) => { raw.close(r) })
  if (!fs.existsSync(socketPath)) fs.writeFileSync(socketPath, '') // platforms that unlink on close: plant a plain file
  const b = await startControlServer({ socketPath, routes: { 'GET /status': async () => ({ who: 'b' }) } })
  try { assert.deepEqual(await controlRequest({ socketPath, method: 'GET', path: '/status' }), { who: 'b' }) } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('control: no daemon → ENOENT/ECONNREFUSED, oversized body → 413', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'asight', 'collector.sock')
  await assert.rejects(controlRequest({ socketPath, method: 'GET', path: '/status' }), (e) => e.code === 'ENOENT')
  const srv = await startControlServer({ socketPath, maxBody: 16, routes: { 'POST /on': async () => ({}) } })
  try { await assert.rejects(controlRequest({ socketPath, method: 'POST', path: '/on', body: { pad: 'x'.repeat(64) } }), /413/) }
  finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
