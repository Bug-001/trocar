// test/off/win32-control.test.mjs — the Windows control seam under `off` (plan Task 9(b), W54; RFC 4.8 §7 控制面): the daemon listens on a
// named pipe whose name and secret token live in <collector>\control.json — a pipe has no file mode, so the token is what keeps it to the
// operator. `off` finds the endpoint, and every request carries the token. A node server on a unix socket stands in for the pipe: the token
// travels in the same header either way. The reader is deliberately lighter than the writer's (src/off imports nothing outside itself, 0.1 §2).
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { CONTROL_TOKEN_HEADER, controlRequest, controlEndpointOf } from '../../src/off/control-client.mjs'
import { CONTROL_TOKEN_HEADER as CORE_CONTROL_TOKEN_HEADER } from '../../src/collector/core/control.mjs'
import { offWorld } from '../../src/off/orchestrate.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const CREATED = 1_740_000_123_456 // a lock's start_time shape, Unix ms
const BOOTED = 1_740_000_000_000 // a lock's boot_id shape (4.8 §7: the machine's boot time)

// ── control.json, the token, and the request that carries it ────────────────────────────────────────────────
test('the token header is the one the daemon checks (core/control.mjs), and controlRequest carries it: without it or with a wrong one the daemon refuses (401), with it the JSON reply comes back', async () => {
  assert.equal(CONTROL_TOKEN_HEADER, CORE_CONTROL_TOKEN_HEADER, 'src/off and the server must not drift on the header name')
  const token = 'a'.repeat(64)
  const seen = []
  const dir = tmpDir('asight-w32-ctl-')
  const sock = path.join(dir, 'collector.sock')
  const server = http.createServer((req, res) => { // the daemon's own check (core/control.mjs), mirrored here
    seen.push(req.headers[CONTROL_TOKEN_HEADER])
    if (req.headers[CONTROL_TOKEN_HEADER] !== token) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'the control token is missing or wrong' })); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pid: 4242, confirmed: true }))
  })
  await new Promise((resolve) => server.listen(sock, resolve))
  try {
    assert.deepEqual(await controlRequest({ socketPath: sock, method: 'POST', path: '/off', body: {}, token }), { pid: 4242, confirmed: true }, 'the token gets the reply through')
    await assert.rejects(controlRequest({ socketPath: sock, method: 'GET', path: '/status' }), (e) => e.status === 401, 'no token: the daemon refuses, the request rejects with the status')
    await assert.rejects(controlRequest({ socketPath: sock, method: 'GET', path: '/status', token: 'b'.repeat(64) }), (e) => e.status === 401, 'a wrong token too')
    assert.deepEqual(seen, [token, undefined, 'b'.repeat(64)])
  } finally { server.close() }
})

test('controlEndpointOf reads the endpoint out of control.json: the pipe name and the token; absent is null, anything else is an error, never a guess', () => {
  const dir = tmpDir('asight-w32-endpoint-')
  const at = (text) => { const file = path.join(dir, 'control.json'); nodeFs.writeFileSync(file, text); return controlEndpointOf({ dir }) }
  assert.equal(controlEndpointOf({ dir }), null, 'no control.json: no daemon was ever started here')
  assert.deepEqual(at(JSON.stringify({ path: '\\\\.\\pipe\\asight-0011223344556677', token: 'c'.repeat(64) })), { path: '\\\\.\\pipe\\asight-0011223344556677', token: 'c'.repeat(64) })
  for (const bad of ['not json', '[]', '{}', JSON.stringify({ path: '\\\\.\\pipe\\asight-0011223344556677' }), JSON.stringify({ token: 'c'.repeat(64) }), JSON.stringify({ path: 7, token: 'c'.repeat(64) })]) assert.ok(at(bad).error, `${bad.slice(0, 30)} is not an endpoint`)
})

test('offWorld on win32 finds the daemon through control.json and asks it with the token; with control.json gone the lock\'s own socket is asked all the same', async () => {
  const token = 'd'.repeat(64)
  const asked = []
  const home = tmpDir('asight-w32-world-')
  const dir = path.join(home, '.asight', 'collector')
  nodeFs.mkdirSync(dir, { recursive: true })
  const sock = path.join(dir, 'stand-in-for-the-pipe') // a unix socket stands in for \\.\\pipe\…: same header, same request
  const server = http.createServer((req, res) => { asked.push(req.headers[CONTROL_TOKEN_HEADER]); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pid: 4242, confirmed: true })) })
  await new Promise((resolve) => server.listen(sock, resolve))
  const write = (endpoint) => {
    if (endpoint) nodeFs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(endpoint))
    else nodeFs.rmSync(path.join(dir, 'control.json'), { force: true })
    const lockFile = path.join(dir, 'lock')
    nodeFs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, start_time: String(CREATED), boot_id: String(BOOTED), socket: endpoint ? endpoint.path : sock, engine_port: 47123 }) + '\n')
    const when = new Date(); nodeFs.utimesSync(lockFile, when, when)
    return lockFile
  }
  const world = () => offWorld({ home, deps: { platform: 'win32', request: null, alive: () => true, identity: () => ({ start_time: String(CREATED), boot_id: String(BOOTED) }) } }) // request: null → offWorld's own token wrapper
  try {
    write({ path: sock, token })
    let w = world()
    assert.equal(w.socketPath, sock, 'the socket comes from control.json on win32, never XDG_RUNTIME_DIR')
    assert.equal((await w.daemonState()).state, 'running', 'a fresh lock, a live pid, a socket that answers: running')
    assert.equal(asked.at(-1), token, 'the request carried control.json\'s token')
    write(null) // control.json lost: the lock still names where the daemon listens
    w = world()
    assert.equal(w.socketPath, null, 'no control.json on win32: no socket path of offWorld\'s own')
    assert.equal((await w.daemonState()).state, 'running', 'the lock\'s own socket is asked (the request then carries no token; a POST /off that 401s is the control-error the receipt shows)')
    assert.equal(asked.at(-1), undefined)
  } finally { server.close() }
})

