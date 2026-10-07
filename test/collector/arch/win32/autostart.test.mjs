// autostart.test.mjs — the Windows collector's way in and the way it is kept up: the control pipe's name and token, the refusal of an elevated token, the Node preflight, the Task Scheduler task and its Run-key
// fallback, the supervisor parent (RFC 4.8 §7; acceptance W24 W25 W26). Nothing here needs Windows: every tool (`schtasks`, `reg`, `whoami`) goes through an injected runner, the helper is a fake, the child
// process of the supervisor is a scripted fake and the clock is a counter; the control server listens on a unix socket in a temp directory where the real one would listen on a named pipe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { startHelper } from '../../../../src/collector/arch/win32/helper.mjs'
import { refuseElevated, nodePreflight, NODE_MIN_MAJOR } from '../../../../src/collector/arch/win32/autostart.mjs'
import { elevationByWhoami, refuseElevatedByWhoami } from '../../../../src/off/win32.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
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

// ---- W25: refuse an elevated or SYSTEM token ---------------------------------------------------------------------------------------------------

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url))
/** The real helper client over the fake helper process, so `token` goes through the line protocol as it does on Windows. */
function helperWith(t, verbs) {
  const h = startHelper({ spawn: (exe, args, opts) => spawn(process.execPath, [FAKE, JSON.stringify({ verbs })], { ...opts, env: { ...process.env, ASIGHT_FAKE_HELPER: '1' } }) })
  t.after(() => h.close())
  return h
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const tree = (dir) => { // every file under dir with its bytes' digest: "the sandbox HOME is unchanged byte for byte"
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(fs.readFileSync(p)) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const TOKEN = (over = {}) => ({ pid: 4242, elevated: false, elevationType: 'limited', integrity: 'medium', system: false, sessionId: 2, ...over })

test('W25 an elevated token and a SYSTEM token are refused by the daemon\'s check, each with the closed-set code, and a plain Medium token is not', async (t) => {
  const home = tmpDir('asight-home-')
  fs.mkdirSync(path.join(home, '.asight', 'collector'), { recursive: true })
  fs.writeFileSync(path.join(home, '.asight', 'collector', 'state.json'), '{"v":2}\n')
  const before = tree(home)
  const cases = [
    ['elevated (the Administrator token, UAC accepted)', TOKEN({ elevated: true, elevationType: 'full', integrity: 'high' }), true],
    ['SYSTEM', TOKEN({ elevated: true, integrity: 'system', system: true, elevationType: 'default' }), true],
    ['SYSTEM whose elevated flag is not set: the SYSTEM flag alone refuses', TOKEN({ system: true, integrity: 'system' }), true],
    ['the filtered token of an administrator account at Medium (what a test machine runs as)', TOKEN(), false],
    ['a standard user', TOKEN({ elevationType: 'default' }), false],
  ]
  for (const [what, data, refused] of cases) {
    const unknown = []
    const r = await refuseElevated({ helper: helperWith(t, { token: { data } }), onUnknown: (why) => unknown.push(why) })
    if (!refused) { assert.equal(r, null, what); continue }
    assert.equal(r.code, 'elevated-token', what)
    assert.match(r.reason, /R7/, 'the reason names the rule')
    assert.deepEqual(r.token, { elevated: data.elevated, system: data.system, integrity: data.integrity }, 'what it saw, without the pid and the session')
    assert.deepEqual(checkRecord({ event: 'failure', where: 'start', code: r.code, reason: r.reason }), [], 'a failure record the closed set takes')
    assert.deepEqual(unknown, [])
  }
  assert.deepEqual(tree(home), before, 'the sandbox HOME is byte for byte as it was: the check writes nothing')
})

test('W25 a token that cannot be read is not a refusal and not a silence: the caller is told why it is unknown (R11)', async (t) => {
  const unknown = []
  const note = (why) => unknown.push(why)
  assert.equal(await refuseElevated({ helper: helperWith(t, { token: { error: 'native-unavailable' } }), onUnknown: note }), null)
  assert.equal(await refuseElevated({ helper: helperWith(t, { token: { data: 'garbage' } }), onUnknown: note }), null)
  assert.equal(await refuseElevated({ helper: helperWith(t, { token: { data: { elevated: 'yes', system: null } } }), onUnknown: note }), null, 'fields that are not booleans are not an answer')
  assert.equal(await refuseElevated({ helper: { call: async () => { throw Object.assign(new Error('helper is down: gone'), { code: 'helper-down' }) } }, onUnknown: note }), null)
  assert.equal(unknown.length, 4)
  assert.match(unknown[0], /native-unavailable/)
  assert.match(unknown[3], /helper-down/)
  assert.equal(await refuseElevated({ helper: { call: async () => { throw new Error('x') } } }), null, 'onUnknown is optional')
})

// whoami /groups lists the token's groups with their SIDs; the integrity level is the one `S-1-16-<rid>` (Mandatory Label), and SYSTEM is S-1-5-18. The SIDs are the same in every language, so the check reads SIDs, not names.
const WHOAMI = (label, extra = '') => `"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\n"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"\n${extra}"${label}","Label","S-1-16-${{ medium: 8192, high: 12288, system: 16384, low: 4096 }[label.split('\\')[1].split(' ')[0].toLowerCase()] ?? 8192}",""\n`
const runner = (out, code = 0, calls = []) => (file, args) => { calls.push([file, ...args]); return { status: code, stdout: out, stderr: '' } }

test('W25 off and uninstall (no helper, no source): the check is `whoami /groups` through execTool, High mandatory level or SYSTEM refuses, Medium and Low do not', () => {
  const calls = []
  assert.deepEqual(elevationByWhoami({ run: runner(WHOAMI('Mandatory Label\\Medium Mandatory Level'), 0, calls) }), { elevated: false })
  assert.deepEqual(calls, [['whoami', '/groups', '/fo', 'csv', '/nh']], 'one fixed command, nothing else asked')
  assert.deepEqual(elevationByWhoami({ run: runner(WHOAMI('Mandatory Label\\Low Mandatory Level')) }), { elevated: false })
  assert.deepEqual(elevationByWhoami({ run: runner(WHOAMI('Mandatory Label\\High Mandatory Level')) }), { elevated: true, why: 'high-integrity' })
  assert.deepEqual(elevationByWhoami({ run: runner(WHOAMI('Mandatory Label\\System Mandatory Level')) }), { elevated: true, why: 'high-integrity' }, 'System integrity is above High')
  assert.deepEqual(elevationByWhoami({ run: runner(WHOAMI('Mandatory Label\\Medium Mandatory Level', '"NT AUTHORITY\\SYSTEM","User","S-1-5-18","Mandatory group, Enabled by default, Enabled group"\n')) }), { elevated: true, why: 'system' }, 'SYSTEM by its own SID')
  assert.deepEqual(elevationByWhoami({ run: runner(WHOAMI('强制性标签\\High Mandatory Level')) }), { elevated: true, why: 'high-integrity' }, 'a localised label name does not matter: the SID decides')
  const r = refuseElevatedByWhoami({ run: runner(WHOAMI('Mandatory Label\\High Mandatory Level')) })
  assert.equal(r.code, 'elevated-token')
  assert.match(r.reason, /R7/)
  assert.equal(refuseElevatedByWhoami({ run: runner(WHOAMI('Mandatory Label\\Medium Mandatory Level')) }), null)
})

test('W25 off and uninstall never block on a token they cannot read: whoami failing, silent or odd is `unknown` with the reason, and the undo goes on (it must work when asight is broken)', () => {
  for (const [what, run, why] of [
    ['whoami could not start', () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn whoami ENOENT') }), /ENOENT/],
    ['whoami failed', runner('', 1), /exit 1/],
    ['no integrity label in the answer', runner('"Everyone","Well-known group","S-1-1-0","x"\n'), /no mandatory label/],
    ['an answer that is not a list of groups', runner('<html>'), /no mandatory label/],
  ]) {
    const e = elevationByWhoami({ run })
    assert.equal(e.elevated, null, what)
    assert.match(e.reason, why, what)
    assert.equal(refuseElevatedByWhoami({ run }), null, `${what}: not refused`)
  }
})

// ---- the Node preflight (4.8 §7) -------------------------------------------------------------------------------------------------------------------

test('W24 `on` refuses a Node below the minimum with a doctor line that says what was found and what is needed; the minimum is the one package.json promises', () => {
  const engines = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).engines.node
  assert.equal(`>=${NODE_MIN_MAJOR}`, engines, 'the preflight and the engines field are one number')
  for (const v of ['20.0.0', '20.19.5', '22.23.1', '24.1.0']) assert.deepEqual(nodePreflight({ versions: { node: v } }), { ok: true, have: v, min: NODE_MIN_MAJOR }, v)
  for (const v of ['18.20.4', '19.9.0', '16.0.0']) {
    const r = nodePreflight({ versions: { node: v } })
    assert.equal(r.ok, false, v)
    assert.equal(r.have, v)
    assert.match(r.doctor, new RegExp(v.replaceAll('.', '\\.')), 'the doctor line names the version found')
    assert.match(r.doctor, new RegExp(`${NODE_MIN_MAJOR}`), '... and the one needed')
  }
  assert.equal(nodePreflight().ok, true, 'the default is this process\'s own Node')
  for (const v of [undefined, '', 'twenty', null]) {
    const r = nodePreflight({ versions: { node: v } })
    assert.equal(r.ok, false, `an unreadable version (${JSON.stringify(v)}) is not a pass`)
    assert.match(r.doctor, /Node/)
  }
})
