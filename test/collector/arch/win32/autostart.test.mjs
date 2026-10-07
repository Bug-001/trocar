// autostart.test.mjs — the Windows collector's way in and the way it is kept up: the control pipe's name and token, the refusal of an elevated token, the Node preflight, the Task Scheduler task and its Run-key
// fallback, the supervisor parent (RFC 4.8 §7; acceptance W24 W25 W26). Nothing here needs Windows: every tool (`schtasks`, `reg`, `whoami`) goes through an injected runner, the helper is a fake, the child
// process of the supervisor is a scripted fake and the clock is a counter; the control server listens on a unix socket in a temp directory where the real one would listen on a named pipe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { controlEndpoint, readControlEndpoint, CONTROL_FILE, PIPE_PREFIX } from '../../../../src/collector/arch/win32/control-path.mjs'
import { startControlServer, CONTROL_TOKEN_HEADER } from '../../../../src/collector/core/control.mjs'


// ---- W26: the control plane ----------------------------------------------------------------------------------------------------------------------

test('W26 the pipe name is asight- and 16 random hex digits, the token is 64; two installs get different ones; control.json is made once and read back', () => {
  const a = tmpDir('asight-ctl-'); const b = tmpDir('asight-ctl-')
  const ea = controlEndpoint({ dir: a }); const eb = controlEndpoint({ dir: b })
  assert.match(ea.path, /^\\\\\.\\pipe\\asight-[0-9a-f]{16}$/)
  assert.ok(ea.path.startsWith(PIPE_PREFIX))
  assert.match(ea.token, /^[0-9a-f]{64}$/)
  assert.notEqual(ea.path, eb.path, 'two installs, two names')
  assert.notEqual(ea.token, eb.token)
  assert.deepEqual(controlEndpoint({ dir: a }), ea, 'created once: the second call reads what the first wrote')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, CONTROL_FILE), 'utf8')), ea, 'control.json holds exactly the name and the token')
  assert.deepEqual(readControlEndpoint({ dir: a }), ea, 'the reader (the CLI) gets the same')
  assert.deepEqual(fs.readdirSync(a), [CONTROL_FILE], 'no temp file is left beside it')
})

test('W26 a reader that finds no control.json says so and writes nothing; a control.json that is not an endpoint is replaced by the writer and is an error to the reader', () => {
  const d = tmpDir('asight-ctl-')
  assert.equal(readControlEndpoint({ dir: d }), null, 'absent is null, not an error')
  assert.deepEqual(fs.readdirSync(d), [], 'a reader never creates it')
  for (const bad of ['', '{', '[]', JSON.stringify({ path: '\\\\.\\pipe\\other', token: 'x'.repeat(64) }), JSON.stringify({ path: `${PIPE_PREFIX}0123456789abcdef`, token: 'short' })]) {
    fs.writeFileSync(path.join(d, CONTROL_FILE), bad)
    const r = readControlEndpoint({ dir: d })
    assert.ok(r && typeof r.error === 'string' && r.error.length > 0, `the reader names the problem for ${JSON.stringify(bad)}`)
    const e = controlEndpoint({ dir: d })
    assert.match(e.path, /^\\\\\.\\pipe\\asight-[0-9a-f]{16}$/, 'the writer makes a good one')
    assert.deepEqual(readControlEndpoint({ dir: d }), e)
  }
})

test('W26 the names come from the injected random source, 8 bytes for the pipe and 32 for the token', () => {
  const asked = []
  const e = controlEndpoint({ dir: tmpDir('asight-ctl-'), randomBytes: (n) => { asked.push(n); return Buffer.alloc(n, asked.length) } })
  assert.deepEqual(asked, [8, 32])
  assert.equal(e.path, `${PIPE_PREFIX}0101010101010101`)
  assert.equal(e.token, '02'.repeat(32))
})

/** One request to a control server on a unix socket, with the headers given; → { status, body }. (The client of `asight off` is the CLI's; this is the least a test needs.) */
const call = (socketPath, headers = {}, p = '/status') => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method: 'GET', path: p, headers }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
  })
  req.on('error', reject)
  req.end()
})

test('W26 a request without the token is refused and never reaches a route; a wrong one too; the right one is answered', async () => {
  const dir = tmpDir('as-'); const socketPath = path.join(dir, 'c.sock')
  const { token } = controlEndpoint({ dir })
  const reached = []
  const srv = await startControlServer({ socketPath, token, pipe: true, routes: { 'GET /status': async () => { reached.push('status'); return { ok: 1 } }, 'POST /off': async () => { reached.push('off'); return {} } } })
  try {
    const none = await call(socketPath)
    assert.equal(none.status, 401)
    assert.match(none.body.error, /token/)
    assert.equal((await call(socketPath, { [CONTROL_TOKEN_HEADER]: 'f'.repeat(64) })).status, 401, 'a token of the right shape that is not ours')
    assert.equal((await call(socketPath, { [CONTROL_TOKEN_HEADER]: token.slice(0, -1) })).status, 401, 'a prefix of ours')
    assert.equal((await call(socketPath, { [CONTROL_TOKEN_HEADER]: `${token}0` })).status, 401, 'ours and more')
    assert.equal((await call(socketPath, {}, '/nope')).status, 401, 'an unknown route is refused for the token first: nothing is said about which routes exist')
    assert.deepEqual(reached, [], 'no route ran for any of them')
    assert.deepEqual(await call(socketPath, { [CONTROL_TOKEN_HEADER]: token }), { status: 200, body: { ok: 1 } })
    assert.deepEqual(reached, ['status'])
    assert.equal(CONTROL_TOKEN_HEADER, 'x-asight-token')
  } finally { await srv.close() }
})

test('W26 the pipe form touches no file mode and no directory: it listens where it is told, and a server without a token still answers (the unix socket of Linux)', async () => {
  const dir = tmpDir('as-'); const socketPath = path.join(dir, 'sub', 'c.sock') // `sub` does not exist: a unix socket's server makes it (0700), a pipe's has no directory to make
  await assert.rejects(startControlServer({ socketPath, pipe: true, routes: {} }), (e) => ['ENOENT', 'EACCES'].includes(e.code), 'the pipe form does not mkdir: listening where there is no directory fails (the errno is the OS\'s)')
  assert.ok(!fs.existsSync(path.join(dir, 'sub')))
  const srv = await startControlServer({ socketPath, routes: { 'GET /status': async () => ({ unix: true }) } })
  try {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, 'unchanged on a unix socket (Linux, 4.6)')
    assert.deepEqual(await call(socketPath), { status: 200, body: { unix: true } }, 'no token configured: nothing is asked for')
  } finally { await srv.close() }
  await assert.rejects(startControlServer({ socketPath, token: 'short', routes: {} }), /token/i, 'a token too short to be a secret is a bug of the caller, not a server that checks nothing')
})

test('W26 a second server on a live endpoint is refused, and the first one is not harmed', async () => {
  const dir = tmpDir('as-'); const socketPath = path.join(dir, 'c.sock')
  const { token } = controlEndpoint({ dir })
  const a = await startControlServer({ socketPath, token, pipe: true, routes: { 'GET /status': async () => ({ who: 'a' }) } })
  try {
    await assert.rejects(startControlServer({ socketPath, token, pipe: true, routes: {} }), /another collector daemon/)
    assert.deepEqual(await call(socketPath, { [CONTROL_TOKEN_HEADER]: token }), { status: 200, body: { who: 'a' } })
    assert.ok(fs.existsSync(socketPath), 'the refused one did not remove the first one\'s endpoint')
  } finally { await a.close() }
})
