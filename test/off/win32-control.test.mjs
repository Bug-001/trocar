// test/off/win32-control.test.mjs — the Windows control seam under `off` (plan Task 9(b), W54; RFC 4.8 §7 控制面): the daemon listens on a
// named pipe whose name and secret token live in <collector>\control.json — a pipe has no file mode, so the token is what keeps it to the
// operator. `off` finds the endpoint, and every request carries the token. A node server on a unix socket stands in for the pipe: the token
// travels in the same header either way. The reader is deliberately lighter than the writer's (src/off imports nothing outside itself, 0.1 §2).
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { controlRequest, controlEndpointOf, controlEndpointFor, isPipePath } from '../../src/off/control-client.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { CONTROL_TOKEN_HEADER as CORE_CONTROL_TOKEN_HEADER, startControlServer } from '../../src/collector/core/control.mjs'
import { offWorld } from '../../src/off/orchestrate.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const CREATED = 1_740_000_123_456 // a lock's start_time shape, Unix ms
const BOOTED = 1_740_000_000_000 // a lock's boot_id shape (4.8 §7: the machine's boot time)

// ── control.json, the token, and the request that carries it ────────────────────────────────────────────────
test('the token header is the one the daemon checks (core/control.mjs, which imports the name from src/off), and controlRequest carries it: without it or with a wrong one the daemon refuses (401), with it the JSON reply comes back', async () => {
  assert.equal(CORE_CONTROL_TOKEN_HEADER, CONTROL_TOKEN_HEADER, 'one name, imported not copied')
  const token = 'a'.repeat(64)
  const dir = tmpDir('asight-w32-ctl-')
  const sock = path.join(dir, 'collector.sock')
  const server = await startControlServer({ socketPath: sock, token, routes: { 'GET /status': async () => ({ pid: 4242, confirmed: true }) }, pipe: true }) // the daemon's own check, not a mirror of it
  try {
    assert.deepEqual(await controlRequest({ socketPath: sock, method: 'GET', path: '/status', token }), { pid: 4242, confirmed: true }, 'the token gets the reply through')
    await assert.rejects(controlRequest({ socketPath: sock, method: 'GET', path: '/status' }), (e) => e.status === 401, 'no token: the daemon refuses, the request rejects with the status')
    await assert.rejects(controlRequest({ socketPath: sock, method: 'GET', path: '/status', token: 'b'.repeat(64) }), (e) => e.status === 401, 'a wrong token too')
  } finally { await server.close() }
})

test('controlEndpointOf reads the endpoint out of control.json: the pipe name and the token; absent is null, anything else is an error, never a guess', () => {
  const dir = tmpDir('asight-w32-endpoint-')
  const at = (text) => { const file = path.join(dir, 'control.json'); nodeFs.writeFileSync(file, text); return controlEndpointOf({ dir }) }
  assert.equal(controlEndpointOf({ dir }), null, 'no control.json: no daemon was ever started here')
  assert.deepEqual(at(JSON.stringify({ path: '\\\\.\\pipe\\asight-0011223344556677', token: 'c'.repeat(64) })), { path: '\\\\.\\pipe\\asight-0011223344556677', token: 'c'.repeat(64) })
  for (const bad of ['not json', '[]', '{}', JSON.stringify({ path: '\\\\.\\pipe\\asight-0011223344556677' }), JSON.stringify({ token: 'c'.repeat(64) }), JSON.stringify({ path: 7, token: 'c'.repeat(64) })]) assert.ok(at(bad).error, `${bad.slice(0, 30)} is not an endpoint`)
})

// The real shape on a Mac: POSIX file names may hold backslashes and Node resolves a relative unix-socket path against the cwd, so after a chdir into a
// temp directory the literal `\\.\pipe\asight-<hex>` of a real control.json is a listenable path — the data keeps the shape a Windows daemon writes
// and the request path is the real one (no injected `request` / `socketPath`). Restores the cwd after (each test file is its own process).
const PIPE = '\\\\.\\pipe\\asight-0011223344556677'
async function inPipeDir(fn) {
  const cwd = process.cwd()
  process.chdir(tmpDir('asight-w32-pipe-'))
  try { return await fn() } finally { process.chdir(cwd) }
}
const listenOn = async (name, onReq) => {
  const server = http.createServer((req, res) => { onReq(req); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pid: 4242, confirmed: true })) })
  await new Promise((resolve) => server.listen(name, resolve))
  return server
}

test('offWorld on win32 finds the daemon through control.json and asks it with the token; with control.json gone the lock\'s own pipe is asked all the same', () => inPipeDir(async () => {
  const token = 'd'.repeat(64)
  const asked = []
  const home = tmpDir('asight-w32-world-')
  const dir = path.join(home, '.asight', 'collector')
  nodeFs.mkdirSync(dir, { recursive: true })
  const server = await listenOn(PIPE, (req) => asked.push(req.headers[CONTROL_TOKEN_HEADER]))
  const write = (endpoint) => {
    if (endpoint) nodeFs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(endpoint))
    else nodeFs.rmSync(path.join(dir, 'control.json'), { force: true })
    const lockFile = path.join(dir, 'lock')
    nodeFs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, start_time: String(CREATED), boot_id: String(BOOTED), socket: PIPE, engine_port: 47123 }) + '\n')
    const when = new Date(); nodeFs.utimesSync(lockFile, when, when)
    return lockFile
  }
  const world = () => offWorld({ home, deps: { platform: 'win32', request: null, alive: () => true, identity: () => ({ start_time: String(CREATED), boot_id: String(BOOTED) }) } }) // request: null → offWorld's own token wrapper
  try {
    write({ path: PIPE, token })
    let w = world()
    assert.equal(w.socketPath, PIPE, 'the pipe comes from control.json on win32, never XDG_RUNTIME_DIR')
    assert.equal((await w.daemonState()).state, 'running', 'a fresh lock, a live pid, a pipe that answers: running')
    assert.equal(asked.at(-1), token, 'the request carried control.json\'s token')
    write(null) // control.json lost: the lock still names where the daemon listens
    w = world()
    assert.equal(w.socketPath, null, 'no control.json on win32: no socket path of offWorld\'s own')
    assert.equal((await w.daemonState()).state, 'running', 'the lock\'s own pipe is asked (the request then carries no token; a POST /off that 401s is the control-error the receipt shows)')
    assert.equal(asked.at(-1), undefined)
  } finally { await new Promise((resolve) => server.close(resolve)) }
}))

// ── the shape: off never connects to what is no Windows pipe (the platform-seam rule; 0.1 §3 convention 3) ───────────
test('isPipePath: \\\\.\\pipe\\ and \\\\?\\pipe\\ with any name are pipes (off never refuses what a newer daemon build named differently); a unix path, a drive path and a bare name are not', () => {
  for (const p of [PIPE, '\\\\?\\pipe\\other-name', '\\\\.\\pipe\\x']) assert.equal(isPipePath(p), true, p)
  for (const p of ['/tmp/collector.sock', 'C:\\Users\\x\\sock', 'asight-0011223344556677', '\\\\.\\pipe', '', null, undefined, 7]) assert.equal(isPipePath(p), false, String(p))
})

test('controlEndpointFor on win32: a control.json that names a unix path yields no endpoint and a why naming the shape — nothing is ever connected to; `\\\\?\\pipe\\other-name` is accepted', () => {
  const dir = tmpDir('asight-w32-shape-')
  const put = (p) => nodeFs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ path: p, token: 'c'.repeat(64) }))
  put('/tmp/some/collector.sock')
  const bad = controlEndpointFor({ platform: 'win32', dir })
  assert.equal(bad.socketPath, null)
  assert.match(bad.why, /control\.json names \/tmp\/some\/collector\.sock, which is no Windows named pipe/)
  put('\\\\?\\pipe\\other-name')
  assert.equal(controlEndpointFor({ platform: 'win32', dir }).socketPath, '\\\\?\\pipe\\other-name')
  put('/tmp/some/collector.sock')
  assert.equal(controlEndpointFor({ platform: 'darwin', dir }).socketPath, '/tmp/some/collector.sock', 'darwin\'s control.json names a unix socket: the shape check is win32\'s')
})

test('daemonState on win32 asks no lock.socket that is no pipe (and, on darwin, still asks a unix one)', async () => {
  const home = tmpDir('asight-w32-lock-')
  const dir = path.join(home, '.asight', 'collector')
  nodeFs.mkdirSync(dir, { recursive: true })
  nodeFs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: 4242, start_time: String(CREATED), boot_id: String(BOOTED), socket: '/tmp/x/collector.sock', engine_port: 47123 }) + '\n')
  const asked = []
  const request = async ({ socketPath }) => { asked.push(socketPath); return { pid: 4242 } }
  const deps = { request, alive: () => true, identity: () => ({ start_time: String(CREATED), boot_id: String(BOOTED) }) }
  await offWorld({ home, deps: { ...deps, platform: 'win32' } }).daemonState()
  assert.deepEqual(asked, [], 'no request was made to a unix path on win32')
  await offWorld({ home, deps: { ...deps, platform: 'darwin' } }).daemonState()
  assert.deepEqual(asked, ['/tmp/x/collector.sock'])
})
