// test/collector/core/control.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { controlSocketPath, startControlServer, controlRequest, DAEMON_ALREADY_UP, DAEMON_ENDPOINT_BUSY } from '../../../src/collector/core/control.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

// Unix socket paths are limited to ~104 bytes: keep the temp dir short.
const runDir = () => tmpDir('as-')

test('control: the socket path lives under XDG_RUNTIME_DIR; unset is a clear error (G13)', () => {
  assert.equal(controlSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } }), '/run/user/1000/trocar/collector.sock')
  assert.throws(() => controlSocketPath({ env: {} }), /XDG_RUNTIME_DIR is not set/)
})

test('control: routes answer JSON; socket is 0600 in a 0700 dir; errors are JSON too', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'trocar', 'collector.sock')
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

test('control: a handler may refuse with a 4xx `status` (its answer is that status); any other throw — a 5xx, a non-integer, a 3xx — stays a 500', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'trocar', 'collector.sock')
  const refuse = (status, message) => async () => { throw Object.assign(new Error(message), { status }) }
  const srv = await startControlServer({ socketPath, routes: { 'POST /bad': refuse(400, 'unknown harness: x'), 'POST /gone': refuse(410, 'gone'), 'POST /five': refuse(503, 'busy'), 'POST /odd': refuse('400', 'text status'), 'POST /redirect': refuse(302, 'moved') } })
  try {
    const status = (route) => controlRequest({ socketPath, method: 'POST', path: route, body: {} }).then(() => 200, (e) => [e.status, e.message])
    assert.deepEqual(await status('/bad'), [400, '400: unknown harness: x'])
    assert.deepEqual(await status('/gone'), [410, '410: gone'])
    for (const route of ['/five', '/odd', '/redirect']) assert.equal((await status(route))[0], 500, route)
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('control: a second server on a live socket refuses; a stale socket file is replaced', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'trocar', 'collector.sock')
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
  const dir = runDir(); const socketPath = path.join(dir, 'trocar', 'collector.sock')
  await assert.rejects(controlRequest({ socketPath, method: 'GET', path: '/status' }), (e) => e.code === 'ENOENT')
  const srv = await startControlServer({ socketPath, maxBody: 16, routes: { 'POST /on': async () => ({}) } })
  try { await assert.rejects(controlRequest({ socketPath, method: 'POST', path: '/on', body: { pad: 'x'.repeat(64) } }), /413/) }
  finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// D62 ⑥ + D38 (a review of D found this): the "another daemon answers" check used to be a bare connect, which a daemon with a wedged event loop — or
// any other program holding the pipe name on Windows — completes all the same. The new daemon then exited 0, the platform never retried, and the
// machine was left with no collector and no record until the next login. Only an answer to `GET /status` means another daemon serves.
test('control: a connect alone does not prove a daemon serves — an endpoint that accepts and answers nothing is refused as held, told apart from "another daemon is up"', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'trocar', 'collector.sock')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  const wedged = net.createServer((s) => s.resume()) // it accepts and reads, and never writes a byte back
  await new Promise((r) => wedged.listen(socketPath, r))
  try {
    await assert.rejects(startControlServer({ socketPath, routes: {} }), (e) => {
      assert.equal(e[DAEMON_ENDPOINT_BUSY], true, 'the endpoint is held by something that does not answer: a failure the CLI records')
      assert.equal(e[DAEMON_ALREADY_UP], undefined, 'and NOT "already as asked": exiting 0 on this would leave the machine with no collector')
      return true
    })
  } finally { await new Promise((r) => wedged.close(r)); fs.rmSync(dir, { recursive: true, force: true }) }
})

// the other branch of the same probe: a server that answers — even with a refusal (401: a daemon of this user's whose control.json carries another
// secret) — is a daemon that serves, so the second one steps aside (DAEMON_ALREADY_UP, exit 0) instead of recording a failure.
test('control: an endpoint that answers a 401 is another daemon serving, not an endpoint held', async () => {
  const dir = runDir(); const socketPath = path.join(dir, 'trocar', 'collector.sock')
  const a = await startControlServer({ socketPath, token: 'x'.repeat(16), pipe: false, routes: { 'GET /status': async () => ({ who: 'a' }) } })
  try {
    await assert.rejects(startControlServer({ socketPath, token: 'y'.repeat(16), pipe: false, routes: {} }), (e) => e[DAEMON_ALREADY_UP] === true && e[DAEMON_ENDPOINT_BUSY] === undefined)
  } finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
