// autostart.test.mjs — the Windows collector's way in and the way it is kept up: the control pipe's name and token, the refusal of an elevated token, the Node preflight, the Task Scheduler task and its Run-key
// fallback, the supervisor parent (RFC 4.8 §7; acceptance W24 W25 W26). Nothing here needs Windows: every tool (`schtasks`, `reg`, `whoami`) goes through an injected runner, the helper is a fake, the child
// process of the supervisor is a scripted fake and the clock is a counter; the control server listens on a unix socket in a temp directory where the real one would listen on a named pipe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { refuseElevated, nodePreflight, NODE_MIN_MAJOR, taskXml, taskUser, userUnit, directStartEnv, register, daemonCommandLine, readRunValue, runKeyFallback, removeRunValue, TASK_NAME, TASK_FILE, RUN_KEY, superviseChild, runSupervisor, lockHolderAlive, supervisorBackoff, SUPERVISOR_LOCK, SUPERVISE_CAP_MS, SUPERVISE_STABLE_MS } from '../../../../src/collector/arch/win32/autostart.mjs'
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

test('W26 a control.json that is not JSON is reported without any of its text: the parser\'s message quotes the characters around the error, and a damaged file may have the token in them', () => {
  const d = tmpDir('asight-ctl-')
  const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
  for (const damaged of [`{"path":"${PIPE_PREFIX}0123456789abcdef","token":${secret}}`, `{"token":"${secret}" "x"}`, `${secret}`, `{"token":"${secret.slice(0, 30)}`]) {
    fs.writeFileSync(path.join(d, CONTROL_FILE), damaged)
    const r = readControlEndpoint({ dir: d })
    assert.deepEqual(r, { error: 'control.json is not JSON' }, 'one fixed sentence')
    assert.ok(!JSON.stringify(r).includes('a1b2c3'), 'no digit of the file in what a CLI prints')
  }
})

test('W26 two starts at the same moment end up with one endpoint: the one that linked first wins and the other reads it; a file system that cannot link still gets its file', () => {
  const d = tmpDir('asight-ctl-')
  const winner = { path: `${PIPE_PREFIX}aaaaaaaaaaaaaaaa`, token: 'b'.repeat(64) }
  const racing = { ...fs, linkSync: (from, to) => { fs.writeFileSync(to, `${JSON.stringify(winner)}\n`); throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }) } }
  assert.deepEqual(controlEndpoint({ dir: d, fs: racing }), winner, 'the loser returns what the winner wrote')
  assert.deepEqual(readControlEndpoint({ dir: d }), winner)
  assert.deepEqual(fs.readdirSync(d), [CONTROL_FILE], 'and leaves no temp file')
  const e = tmpDir('asight-ctl-')
  const noLinks = { ...fs, linkSync: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) } }
  const made = controlEndpoint({ dir: e, fs: noLinks })
  assert.deepEqual(readControlEndpoint({ dir: e }), made)
  assert.deepEqual(fs.readdirSync(e), [CONTROL_FILE])
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

// W25's command halves are all LANDED now (the todo pins that lived here — each ending in assert.fail so it could not go green by accident — became
// pointers as the commands got their wiring): on is on-elevated.test.mjs's (2026-10-10, Task 8(c) 收尾), the daemon's is daemon.test.mjs's (Task 8(c)),
// off / uninstall's is win32-kernel.test.mjs's (Task 9(b), lane B).
// W25's on half is LANDED (Task 8(c) 收尾, 2026-10-10): `on` asks parts.arch.refuseElevated at its entry — before turnOn (its only writer), before the
// netenv probe and the adoption read — and refuses an elevated or SYSTEM token with the §12 record (where 'start') where a collector directory exists,
// the receipt carrying it either way; a token that cannot be read is not a refusal (R11) — 已由 test/collector/arch/win32/on-elevated.test.mjs 覆盖
// (the receipt, the one record, exit 1, the HOME otherwise byte for byte, turnOn never asked, and the unreadable case proceeding).
// W25's daemon half is LANDED (Task 8(c)): runDaemon calls arch.refuseElevated before it claims its endpoint, and the win32 endpoint itself
// (controlEndpoint's pipe + token) is wired beside it — 已由 test/collector/daemon.test.mjs::`W25 the win32 daemon refuses an elevated or SYSTEM token
// before it claims its endpoint …` 覆盖 (the record, no socket, no control.json, the unreadable-not-a-refusal half, and the endpoint with its token).
// W25's off/uninstall half is LANDED (Task 9(b), lane B): src/off/orchestrate.mjs and src/cli/uninstall.mjs call refuseElevatedByWhoami at their entry
// on win32 — 已由 test/off/win32-kernel.test.mjs::`W25: off and uninstall on win32 refuse an elevated token at the entry …` 覆盖 (both commands, the byte-identical
// HOME, and the unreadable-whoami-not-a-refusal half).
// W24's command half is LANDED (Task 8(c) / CLI rebase): `runDaemonCli(['--supervise'])` hands the lone flag to arch.runSupervisor through
// daemon.mjs's loadArch (the CLI never imports arch/ itself, layering rule 5) with its own script and the collector dir; any other argument is
// still exit 2, root and a platform without the new collector are refused first, and an arch with no runSupervisor (linux's) is a usage error —
// 已由 test/collector/cli.test.mjs::`cli: daemon --supervise (4.8 §7, W24) …` 覆盖。The supervisor itself is the tests above (the backoff, the
// lock, the singleton, the signals — W24's own list).
// W24's undoWin32-equality half is LANDED (Task 9(b), lane B): src/off/win32.mjs carries its own taskState/undoScheduledTask/undoRunValue beside this
// module's — 已由 test/off/win32-undo.test.mjs::`the names the undo touches are the arch module's own (the inlined pieces cannot drift)` 覆盖: TASK_NAME and
// RUN_KEY equal this module's exports, the shape Linux's unit.mjs ↔ src/off/autostart.mjs test has; each side's call sequence is its own file's tests.

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

test('W25 on and the daemon ask the same `whoami /groups` as off and uninstall (one question, no helper: its C# compile cost on 1.2 s, Windows test machine 2026-10-17): High or SYSTEM refuses with the closed-set record, Medium and Low do not, an unreadable token is said and not refused', async () => {
  for (const [what, out, refused, token] of [
    ['elevated (the Administrator token, UAC accepted)', WHOAMI('Mandatory Label\\High Mandatory Level'), true, { elevated: true, system: false, integrity: 'high' }],
    ['SYSTEM', WHOAMI('Mandatory Label\\System Mandatory Level', '"NT AUTHORITY\\SYSTEM","User","S-1-5-18","Mandatory group, Enabled by default, Enabled group"\n'), true, { elevated: true, system: true, integrity: 'system' }],
    ['the filtered token of an administrator account at Medium (what a test machine runs as)', WHOAMI('Mandatory Label\\Medium Mandatory Level'), false],
    ['a standard user at Low', WHOAMI('Mandatory Label\\Low Mandatory Level'), false],
  ]) {
    const calls = [], unknown = []
    const r = await refuseElevated({ run: runner(out, 0, calls), onUnknown: (why) => unknown.push(why) })
    assert.deepEqual(calls[0], ['whoami', '/groups', '/fo', 'csv', '/nh'], `${what}: whoami first`)
    assert.ok(calls.every(([f]) => f === 'whoami' || f === 'reg'), `${what}: whoami and the UAC settings only, nothing started: ${JSON.stringify(calls)}`)
    assert.deepEqual(unknown, [])
    if (!refused) { assert.equal(r, null, what); continue }
    assert.equal(r.code, 'elevated-token', what)
    assert.equal(r.reason, refuseElevatedByWhoami({ run: runner(out) }).reason, 'the same words as off and uninstall')
    assert.deepEqual(r.token, token, what)
    assert.deepEqual(checkRecord({ event: 'failure', where: 'start', code: r.code, reason: r.reason }), [], 'a failure record the closed set takes')
  }
  const unknown = []
  assert.equal(await refuseElevated({ run: runner('', 1), onUnknown: (why) => unknown.push(why) }), null, 'whoami failing is not a refusal')
  assert.match(unknown.join('\n'), /whoami \/groups failed \(exit 1\)/)
  assert.equal(await refuseElevated({ run: runner('<html>') }), null, 'onUnknown is optional')
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

// ---- W24: the task ------------------------------------------------------------------------------------------------------------------------------

const ME = 'DESKTOP-7Q\\ada'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SCRIPT = 'C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\asight\\bin\\asight.mjs'
const xml = () => taskXml({ user: ME, node: NODE, asight: SCRIPT, conhost: 'conhost.exe' })
const inner = (x, tag) => { const m = new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)</${tag}>`).exec(x); return m ? m[1] : null }
/** Is it well formed in the one sense that matters here: every element opened is closed, in order? (There is no XML parser in Node; a typo in a tag name is what this catches.) */
function balanced(x) {
  const stack = []
  for (const m of x.replace(/<\?[\s\S]*?\?>/g, '').matchAll(/<(\/?)([A-Za-z][\w.]*)([^>]*?)(\/?)>/g)) {
    if (m[4] === '/') continue
    if (m[1] === '/') { if (stack.pop() !== m[2]) return false } else stack.push(m[2])
  }
  return stack.length === 0
}

test('W24 the task XML has the fields of 4.8 §7: a login trigger of this user, InteractiveToken at LeastPrivilege, restart on failure 1 minute × 999, no time limit, a conhost --headless action that runs the supervised daemon, and no --use-system-ca', () => {
  const x = xml()
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-16"?>'), 'the form T0 registered: the file is UTF-16 and says so')
  assert.ok(balanced(x), 'every element is closed')
  assert.match(x, /<Task version="1\.4" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/)
  assert.equal(inner(inner(x, 'LogonTrigger'), 'UserId'), ME, 'the trigger is this user\'s login, not anybody\'s')
  assert.equal(inner(inner(x, 'LogonTrigger'), 'Enabled'), 'true')
  const principal = inner(x, 'Principal')
  assert.equal(inner(principal, 'UserId'), ME)
  assert.equal(inner(principal, 'LogonType'), 'InteractiveToken')
  assert.equal(inner(principal, 'RunLevel'), 'LeastPrivilege')
  assert.doesNotMatch(x, /S4U|HighestAvailable|Password/, 'not S4U (High integrity), not elevated, no password')
  assert.equal(inner(x, 'RestartOnFailure'), '<Interval>PT1M</Interval><Count>999</Count>')
  assert.equal(inner(x, 'ExecutionTimeLimit'), 'PT0S')
  assert.equal(inner(x, 'DisallowStartIfOnBatteries'), 'false')
  assert.equal(inner(x, 'StopIfGoingOnBatteries'), 'false')
  assert.equal(inner(x, 'MultipleInstancesPolicy'), 'IgnoreNew')
  assert.equal((x.match(/<Exec>/g) || []).length, 1, 'one action')
  assert.equal(inner(x, 'Command'), 'conhost.exe')
  assert.equal(inner(x, 'Arguments'), `--headless "${NODE}" "${SCRIPT}" daemon --supervise`, 'conhost --headless (no window) runs node on asight with the supervisor flag')
  assert.doesNotMatch(x, /--use-system-ca/, 'that option needs Node 22.15 and would make an older daemon exit at every login')
  assert.equal(taskXml({ user: ME, node: NODE, asight: SCRIPT }), x, 'conhost.exe is the default command')
})

test('W24 what goes into the XML is escaped or refused: & < > are escaped, a quote or a control character in a path is a bug of the caller (it would end the quoted argument, or the element)', () => {
  const x = taskXml({ user: 'A&B\\ada<x>', node: 'C:\\R&D\\node.exe', asight: 'C:\\a>b\\asight.mjs' })
  assert.ok(balanced(x))
  assert.equal(inner(inner(x, 'LogonTrigger'), 'UserId'), 'A&amp;B\\ada&lt;x&gt;')
  assert.equal(inner(x, 'Arguments'), '--headless "C:\\R&amp;D\\node.exe" "C:\\a&gt;b\\asight.mjs" daemon --supervise')
  assert.match(taskXml({ user: '张三\\ada', node: NODE, asight: 'C:\\用户\\asight.mjs' }), /用户/, 'a profile path in Chinese is carried as it is: UTF-16 holds it')
  for (const bad of [{ node: 'C:\\no"de.exe' }, { asight: 'C:\\a"b.mjs' }, { node: 'C:\\node\u0007.exe' }, { user: 'ada\u0000' }, { asight: '' }, { node: undefined }, { conhost: 'con"host.exe' }]) {
    assert.throws(() => taskXml({ user: ME, node: NODE, asight: SCRIPT, ...bad }), TypeError, JSON.stringify(bad))
  }
})

test('W24 the task\'s user is DOMAIN\\name from the environment (the form the Task Scheduler wants), or the name alone, or the OS\'s answer when the environment has none', () => {
  assert.equal(taskUser({ USERDOMAIN: 'DESKTOP-7Q', USERNAME: 'ada' }), 'DESKTOP-7Q\\ada')
  assert.equal(taskUser({ USERNAME: 'ada' }), 'ada')
  assert.equal(typeof taskUser({}), 'string')
  assert.ok(taskUser({}).length > 0)
})

/** The runner `execTool` is handed: records every call, answers from `answers` (keyed by the first argument or by file + first argument) and lets a hook look at the world while the tool "runs". */
function fakeTools(answers = {}, hook = () => {}) {
  const calls = []
  const run = (file, args) => {
    calls.push([file, ...args])
    hook(file, args)
    const a = answers[`${file} ${args[0]}`] ?? answers[file] ?? { status: 0 }
    const r = typeof a === 'function' ? a(file, args) : a
    return { status: 0, stdout: '', stderr: '', ...r }
  }
  return Object.assign(run, { calls })
}
/** What a real `reg query` says when the Run value is not there: exit 1. (A fake that answers exit 0 with nothing would be a `reg` that says something no `reg` says.) */
const NO_RUN_VALUE = { 'reg query': { status: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' } }
const withHome = (over = {}) => { const home = tmpDir('asight-unit-'); return { home, node: NODE, script: SCRIPT, env: { USERDOMAIN: 'DESKTOP-7Q', USERNAME: 'ada' }, ...over } }
/** What `asight on` does before it enables: writes the unit's text where the unit says it lives. */
const installed = (u) => { fs.mkdirSync(path.dirname(u.path), { recursive: true }); fs.writeFileSync(u.path, u.text({})); return u }

test('W24 userUnit gives the shape turnOn and install consume: a path under the collector directory, no links, the text, and the verbs enable / start / reload / disable / remove', () => {
  const o = withHome()
  const u = userUnit({ ...o, run: fakeTools() })
  assert.equal(u.path, path.join(o.home, '.asight', 'collector', TASK_FILE))
  assert.equal(TASK_FILE, 'asight-collector.task.xml')
  assert.deepEqual(u.links, [], 'a task has no wants/ link')
  assert.equal(u.name, 'asight-collector')
  assert.equal(u.text({ NODE_EXTRA_CA_CERTS: 'C:\\corp\\ca.pem' }), xml(), 'the text is the XML; a Windows task has no environment of its own, so the daemon environment install offers is not carried (4.8 §7)')
  for (const verb of ['enable', 'start', 'reload', 'disable', 'remove']) assert.equal(typeof u[verb], 'function', verb)
  assert.deepEqual(u.reload(), { code: 0, out: '', err: '' }, 'a rewritten task is registered again by the next enable (/F), so there is nothing to reload')
})

test('W24 enable registers the task from the file install wrote and runs it: /Create /XML <a UTF-16 copy> /TN \\asight\\collector /F, then /Run; the copy is gone afterwards; enable({ now: false }) does not run it', () => {
  const o = withHome()
  const seen = {}
  const run = fakeTools(NO_RUN_VALUE, (file, args) => {
    if (args[0] !== '/Create') return
    const xmlFile = args[args.indexOf('/XML') + 1]
    seen.bytes = fs.readFileSync(xmlFile)
    seen.name = path.basename(xmlFile)
  })
  const u = installed(userUnit({ ...o, run }))
  const r = u.enable({ now: true })
  assert.deepEqual(r, { code: 0, out: '', err: '', via: 'task' })
  assert.deepEqual(run.calls.map((c) => c.slice(0, 2).join(' ')), ['schtasks /Create', 'reg query', 'schtasks /Run', 'schtasks /Query'], 'create, look whether an earlier on left a Run value (one mechanism at login), run, read the task\'s LastTaskResult back (a /Run that says SUCCESS is not trusted on its word)')
  assert.deepEqual(run.calls[0].slice(0, 3), ['schtasks', '/Create', '/XML'])
  assert.deepEqual(run.calls[0].slice(4), ['/TN', TASK_NAME, '/F'])
  assert.deepEqual(run.calls[2], ['schtasks', '/Run', '/TN', TASK_NAME])
  assert.deepEqual(run.calls[3], ['schtasks', '/Query', '/TN', TASK_NAME, '/V', '/FO', 'CSV'], 'the one question whose answer says whether the /Run started anything')
  assert.equal(TASK_NAME, '\\asight\\collector')
  assert.deepEqual([...seen.bytes.subarray(0, 2)], [0xff, 0xfe], 'the file schtasks reads is UTF-16LE with a byte order mark, which is the form that registered in the T0 measurement')
  assert.equal(seen.bytes.subarray(2).toString('utf16le'), u.text({}), 'and it holds the text install wrote')
  assert.deepEqual(fs.readdirSync(path.dirname(u.path)), [TASK_FILE], 'the UTF-16 copy is removed once schtasks has read it')
  const later = fakeTools(NO_RUN_VALUE)
  const u2 = installed(userUnit({ ...o, run: later }))
  assert.equal(u2.enable({ now: false }).code, 0)
  assert.deepEqual(later.calls.map((c) => c[1]).filter((a) => a !== 'query'), ['/Create'], 'enable without now registers and does not start (a daemon is already up: 拉起不是重启)')
  assert.equal(u2.enable().code, 0)
  assert.deepEqual(later.calls.map((c) => c[1]).filter((a) => a !== 'query').slice(1), ['/Create', '/Run', '/Query'], 'now is the default (and the /Run\'s word is checked)')
})

test('W24 enable says why it failed: a /Run that did not start, a task file that is not there, and (below) a /Create that was refused', () => {
  const o = withHome()
  const notRun = fakeTools({ ...NO_RUN_VALUE, 'schtasks /Run': { status: 1, stderr: 'ERROR: The system cannot find the file specified.' } })
  const b = installed(userUnit({ ...o, run: notRun })).enable()
  assert.deepEqual([b.code, b.via], [1, 'task'])
  assert.match(b.err, /cannot find/)
  const none = fakeTools(NO_RUN_VALUE)
  const c = userUnit({ ...withHome(), run: none }).enable()
  assert.equal(c.code, null)
  assert.match(c.err, /task file/)
  assert.deepEqual(none.calls, [], 'no schtasks without a file to register')
  assert.equal(register({ file: path.join(o.home, 'nope.xml'), run: none }).code, null)
  const refusedHome = withHome()
  const refused = fakeTools({ 'schtasks /Create': { status: 1, stderr: 'ERROR: Access is denied.' }, 'reg add': { status: 1, stderr: 'ERROR: Access is denied.' }, 'reg query': { status: 1 } })
  const a = installed(userUnit({ ...refusedHome, run: refused })).enable()
  assert.equal(a.code, 1)
  assert.deepEqual(fs.readdirSync(path.join(refusedHome.home, '.asight', 'collector')), [TASK_FILE], 'the UTF-16 copy is removed on the failure path too')
})

test('W24 start (the --no-autostart run: this session, nothing at login) starts the supervised daemon itself without registering anything: conhost --headless, detached, no window, and a spawn that did not start is a failure, not a success', () => {
  const o = withHome()
  const run = fakeTools()
  const spawned = []
  const fakeSpawn = (cmd, args, opts) => { const child = { pid: 321, unrefd: false, unref() { this.unrefd = true }, on() {} }; spawned.push({ cmd, args, opts, child }); return child }
  const u = userUnit({ ...o, run, spawn: fakeSpawn })
  assert.deepEqual(u.start(), { code: 0, out: '', err: '', via: 'direct', pid: 321 })
  assert.deepEqual(run.calls, [], 'no schtasks: a task with a login trigger would be an autostart')
  assert.equal(spawned.length, 1)
  assert.deepEqual([spawned[0].cmd, spawned[0].args], ['conhost.exe', ['--headless', NODE, SCRIPT, 'daemon', '--supervise']])
  assert.deepEqual([spawned[0].opts.detached, spawned[0].opts.stdio, spawned[0].opts.windowsHide], [true, 'ignore', true])
  assert.equal(spawned[0].child.unrefd, true, 'the daemon is not tied to the process that started it: this one can exit')
  const dead = userUnit({ ...o, run, spawn: () => ({ pid: undefined, unref() {}, on() {} }) }).start()
  assert.equal(dead.code, null)
  assert.match(dead.err, /did not start/)
  const thrown = userUnit({ ...o, run, spawn: () => { throw Object.assign(new Error('spawn conhost.exe ENOENT'), { code: 'ENOENT' }) } }).start()
  assert.equal(thrown.code, null)
  assert.match(thrown.err, /ENOENT/)
})

test('W24 a daemon started directly (start(), the fallback with now) gets the environment a login task would give, not the installer shell\'s trust and proxy variables: the same daemon however it was started', () => {
  const shell = { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ada', USERDOMAIN: 'DESKTOP-7Q', USERNAME: 'ada', CODEX_HOME: 'D:\\codex', NODE_EXTRA_CA_CERTS: 'C:\\corp\\ca.pem', NODE_OPTIONS: '--use-system-ca', NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0', SSL_CERT_FILE: 'C:\\x.pem', SSL_CERT_DIR: 'C:\\certs', HTTPS_PROXY: 'http://u:p@10.0.0.1:3128', http_proxy: 'http://10.0.0.1:3128', ALL_PROXY: 'socks5://10.0.0.1:1080', no_proxy: 'localhost', Https_Proxy: 'x', WS_PROXY: 'y', wss_proxy: 'z', FTP_PROXY: 'f' }
  const kept = { PATH: shell.PATH, SystemRoot: shell.SystemRoot, USERPROFILE: shell.USERPROFILE, USERDOMAIN: shell.USERDOMAIN, USERNAME: shell.USERNAME, CODEX_HOME: shell.CODEX_HOME }
  assert.deepEqual(directStartEnv(shell), kept, 'everything else is kept (user-level variables such as CODEX_HOME are among what a login task carries too); the trust and proxy ones are not, whatever the case of their names')
  assert.ok(Object.keys(shell).includes('NODE_EXTRA_CA_CERTS'), 'the caller\'s environment is not changed')
  assert.deepEqual(directStartEnv({}), {})
  const spawned = []
  const fakeSpawn = (cmd, args, opts) => { spawned.push(opts); return { pid: 5, unref() {}, on() {} } }
  assert.equal(userUnit({ ...withHome({ env: shell }), run: fakeTools(), spawn: fakeSpawn }).start().code, 0)
  assert.deepEqual(spawned[0].env, kept, 'start()')
  const refused = fakeRegistry()
  assert.equal(installed(userUnit({ ...withHome({ env: shell }), run: refused, spawn: fakeSpawn })).enable({ now: true }).via, 'run-key')
  assert.deepEqual(spawned[1].env, kept, 'the fallback with now')
  assert.deepEqual([spawned[1].detached, spawned[1].windowsHide], [true, true], 'the rest of the spawn is as before')
})

test('W24 disable (a no-argument off) switches the task off and leaves it registered; remove (uninstall) deletes it; a task that is not there is already as asked, not an error', () => {
  const o = withHome()
  const noRunKey = { 'reg query': { status: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' } }
  const present = fakeTools({ 'schtasks /Query': { status: 0 }, ...noRunKey })
  assert.deepEqual(userUnit({ ...o, run: present }).disable(), { code: 0, out: '', err: '', task: 'disabled', runKey: 'absent' })
  assert.deepEqual(present.calls.filter((c) => c[0] === 'schtasks'), [['schtasks', '/Query', '/TN', TASK_NAME], ['schtasks', '/Change', '/TN', TASK_NAME, '/DISABLE']])
  const gone = fakeTools({ 'schtasks /Query': { status: 1, stderr: 'ERROR: The system cannot find the file specified.' }, ...noRunKey })
  assert.deepEqual(userUnit({ ...o, run: gone }).disable(), { code: 0, out: '', err: '', task: 'absent', runKey: 'absent' })
  assert.deepEqual(gone.calls.filter((c) => c[0] === 'schtasks').map((c) => c[1]), ['/Query'], 'nothing is changed or deleted')
  const rm = fakeTools({ 'schtasks /Query': { status: 0 }, ...noRunKey })
  assert.deepEqual(userUnit({ ...o, run: rm }).remove(), { code: 0, out: '', err: '', task: 'removed', runKey: 'absent' })
  assert.deepEqual(rm.calls.filter((c) => c[0] === 'schtasks'), [['schtasks', '/Query', '/TN', TASK_NAME], ['schtasks', '/Delete', '/TN', TASK_NAME, '/F']])
  const stuck = fakeTools({ 'schtasks /Query': { status: 0 }, 'schtasks /Change': { status: 1, stderr: 'ERROR: Access is denied.' }, ...noRunKey })
  const f = userUnit({ ...o, run: stuck }).disable()
  assert.deepEqual([f.code, f.err, f.task], [1, 'ERROR: Access is denied.', 'failed'], 'a task that could not be switched off says so')
})

test('W24 a /Query that did not run (timeout, blocked, no schtasks) is a failure for disable and remove, never "absent": nothing was asked of the task, so it is not known to be gone; the Run value is still taken out', () => {
  const didNot = [
    ['timed out', { status: null, error: Object.assign(new Error('spawnSync schtasks ETIMEDOUT'), { code: 'ETIMEDOUT' }) }],
    ['could not start', { status: null, error: Object.assign(new Error('spawn schtasks ENOENT'), { code: 'ENOENT' }) }],
    ['killed without a reason', { status: null }],
  ]
  for (const [what, query] of didNot) {
    for (const verb of ['disable', 'remove']) {
      const run = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
      const asked = (file, args) => (file === 'schtasks' && args[0] === '/Query' ? { stdout: '', stderr: '', ...query } : null)
      const calls = []
      const r = userUnit({ ...withHome(), run: (file, args, opts) => { calls.push([file, ...args]); return asked(file, args) || run(file, args, opts) } })[verb]()
      assert.equal(r.task, 'failed', `${verb}, ${what}: the task is not reported absent`)
      assert.equal(typeof r.code, 'number', `${verb}, ${what}: a code a caller's \`if (r.code)\` sees`)
      assert.notEqual(r.code, 0, `${verb}, ${what}`)
      assert.match(r.err, /\/Query/, `${verb}, ${what}: it says which call did not run`)
      assert.deepEqual(calls.filter((c) => c[0] === 'schtasks').map((c) => c[1]), ['/Query'], `${verb}, ${what}: nothing is changed or deleted on a guess`)
      assert.equal(r.runKey, 'removed', `${verb}, ${what}: the Run value is a separate part of the undo and still goes`)
    }
  }
  // a /Change or /Delete that did not run is a failure with a code too
  const lost = fakeTools({ 'schtasks /Query': { status: 0 }, 'schtasks /Delete': { status: null, error: new Error('spawnSync schtasks ETIMEDOUT') }, 'reg query': { status: 1 } })
  const d = userUnit({ ...withHome(), run: lost }).remove()
  assert.deepEqual([d.task, typeof d.code, d.code !== 0], ['failed', 'number', true])
})

// ---- W24: the Run-key fallback -------------------------------------------------------------------------------------------------------------------

const RUN_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** What `reg query HKCU\…\Run /v asight-collector` prints when the value is there: CRLF line ends, as reg.exe writes them (the fixture once used \n; the parse is pinned to the real shape). */
const REG_OUT = (kind, data) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    asight-collector    ${kind}    ${data}\r\n`
const COMMAND = `conhost.exe --headless "${NODE}" "${SCRIPT}" daemon --supervise`
/** What `reg query` text looks like to code that decodes it as UTF-8 when reg.exe wrote it in the console's code page (cp936 on a zh-CN Windows): a character outside ASCII is two bytes that are no UTF-8, each one a U+FFFD. */
const asDecodedByUtf8 = (v) => v.replace(/[^\x00-\x7f]/gu, '\uFFFD\uFFFD')
/** A registry that a fake `reg` reads and writes: the one Run value of ours (null = absent). `add` and `delete` are recorded as they come. */
function fakeRegistry(initial = null, { addFails = false, deleteFails = false, dropWrites = false, storeAs = null, codePage = false } = {}) {
  const reg = { value: initial }
  const run = fakeTools({
    'schtasks /Create': { status: 1, stderr: 'ERROR: Access is denied.' },
    'schtasks /Query': { status: 1 },
    reg: (file, args) => {
      if (args[0] === 'query') return reg.value ? { status: 0, stdout: REG_OUT(reg.value.kind, codePage ? asDecodedByUtf8(reg.value.value) : reg.value.value) } : { status: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
      if (args[0] === 'add') { if (addFails) return { status: 1, stderr: 'ERROR: Access is denied.' }; if (!dropWrites) reg.value = { kind: args[args.indexOf('/t') + 1], value: storeAs ? storeAs(args[args.indexOf('/d') + 1]) : args[args.indexOf('/d') + 1] }; return { status: 0, stdout: 'The operation completed successfully.' } }
      if (args[0] === 'delete') { if (deleteFails) return { status: 1, stderr: 'ERROR: Access is denied.' }; reg.value = null; return { status: 0 } }
      return { status: 1 }
    },
  })
  return Object.assign(run, { reg })
}

test('W24 the Run value is read from `reg query` as the registry prints it: the kind and the data, absent as absent, and a failure that is not "absent" as an error', () => {
  assert.deepEqual(RUN_KEY, { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'asight-collector' })
  assert.deepEqual(readRunValue({ run: fakeTools({ reg: { status: 0, stdout: REG_OUT('REG_SZ', COMMAND) } }) }), { present: true, kind: 'REG_SZ', value: COMMAND })
  assert.deepEqual(readRunValue({ run: fakeTools({ reg: { status: 0, stdout: REG_OUT('REG_EXPAND_SZ', '%ProgramFiles%\\x.exe') } }) }), { present: true, kind: 'REG_EXPAND_SZ', value: '%ProgramFiles%\\x.exe' })
  assert.deepEqual(readRunValue({ run: fakeTools({ reg: { status: 0, stdout: REG_OUT('REG_SZ', '') } }) }), { present: true, kind: 'REG_SZ', value: '' }, 'an empty string is a value')
  assert.deepEqual(readRunValue({ run: fakeTools({ reg: { status: 0, stdout: REG_OUT('REG_SZ', COMMAND).replace('asight-collector', 'ASIGHT-Collector') } }) }), { present: true, kind: 'REG_SZ', value: COMMAND }, 'a value name does not care about case')
  assert.deepEqual(readRunValue({ run: fakeTools({ reg: { status: 1, stderr: 'ERROR: not found' } }) }), { present: false })
  assert.match(readRunValue({ run: fakeTools({ reg: { status: 0, stdout: 'something else entirely' } }) }).error, /not .*value/i, 'an answer that is no value is an error, not "absent"')
  assert.match(readRunValue({ run: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn reg ENOENT') }) }).error, /ENOENT/)
  assert.deepEqual(fakeTools({}).calls, [])
  const q = fakeTools({ reg: { status: 1 } }); readRunValue({ run: q })
  assert.deepEqual(q.calls, [['reg', 'query', RUN_PATH, '/v', 'asight-collector']], 'one fixed query of one value')
})

test('W24 a /Create that schtasks refused: the Run value is written with the same supervised command, ledgered, read back, task-register-failed is the event, the daemon is started, and on still succeeds (code 0)', () => {
  const o = withHome()
  const run = fakeRegistry()
  const spawned = []
  const fakeSpawn = (cmd, args) => { spawned.push([cmd, ...args]); return { pid: 77, unref() {}, on() {} } }
  const u = installed(userUnit({ ...o, run, spawn: fakeSpawn }))
  const r = u.enable({ now: true })
  assert.equal(r.code, 0, 'on does not fail because the Task Scheduler refused')
  assert.equal(r.via, 'run-key', 'the receipt says which path was used')
  assert.match(r.reason, /Access is denied/, '... and why the task was not registered')
  assert.deepEqual(r.ledger, { kind: 'run-key', hive: 'HKCU', key: RUN_KEY.key, name: 'asight-collector', value: COMMAND, prior: null })
  assert.equal(r.ours, false)
  assert.deepEqual(r.event, { event: 'failure', where: 'install', code: 'task-register-failed', reason: r.event.reason })
  assert.match(r.event.reason, /Access is denied/)
  assert.match(r.event.reason, /Run/, 'the event names the entry that is used instead')
  assert.deepEqual(checkRecord(r.event), [], 'a record of the closed set')
  assert.deepEqual(run.calls.map((c) => c.slice(0, 2).join(' ')), ['schtasks /Create', 'reg query', 'reg add', 'reg query', 'schtasks /Query'], 'create, look at the old value, write, read it back, look whether an earlier task is there to switch off; no /Run (there is no task)')
  assert.deepEqual(run.calls[2], ['reg', 'add', RUN_PATH, '/v', 'asight-collector', '/t', 'REG_SZ', '/d', COMMAND, '/f'])
  assert.equal(run.reg.value.value, COMMAND)
  assert.equal(COMMAND, `conhost.exe ${inner(x2(u.text({})), 'Arguments')}`, 'the command is the task\'s action: the same supervised one')
  assert.deepEqual(spawned, [['conhost.exe', '--headless', NODE, SCRIPT, 'daemon', '--supervise']], 'the login entry runs at the next login, so with now the daemon is started directly')
  assert.equal(r.pid, 77)
  assert.deepEqual(fs.readdirSync(path.dirname(u.path)), [TASK_FILE])
  // not now: registered for login only, nothing started
  const none = []
  const r2 = installed(userUnit({ ...withHome(), run: fakeRegistry(), spawn: (...a) => { none.push(a); return { pid: 1, unref() {}, on() {} } } })).enable({ now: false })
  assert.deepEqual([r2.code, r2.via, none.length], [0, 'run-key', 0])
})
const x2 = (t) => t // the unit's text, unchanged (the XML escapes nothing in these paths)

test('W24 the prior value is recorded and not lost: a different string already there is kept in the ledger, one of ours is not taken for a prior, and a value that is not a string is never overwritten', () => {
  const other = fakeRegistry({ kind: 'REG_SZ', value: '"C:\\Tools\\mine.exe" --quiet' })
  const r = installed(userUnit({ ...withHome(), run: other, spawn: () => ({ pid: 1, unref() {}, on() {} }) })).enable({ now: false })
  assert.deepEqual([r.code, r.via, r.ours], [0, 'run-key', false])
  assert.deepEqual(r.ledger.prior, { kind: 'REG_SZ', value: '"C:\\Tools\\mine.exe" --quiet' })
  assert.equal(other.reg.value.value, COMMAND, 'and the value is ours now')
  const again = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  const r2 = installed(userUnit({ ...withHome(), run: again })).enable({ now: false })
  assert.deepEqual([r2.code, r2.ledger.prior, r2.ours], [0, null, true], 'what an earlier on wrote is ours: no prior, and the caller keeps the prior its ledger already has')
  const odd = fakeRegistry({ kind: 'REG_DWORD', value: '0x1' })
  const r3 = installed(userUnit({ ...withHome(), run: odd })).enable({ now: false })
  assert.notEqual(r3.code, 0, 'a value that is not a string cannot be put back, so it is not touched')
  assert.match(r3.err, /REG_DWORD/)
  assert.deepEqual(odd.calls.filter((c) => c[0] === 'reg').map((c) => c[1]), ['query'], 'not one write')
  assert.equal(r3.event.code, 'task-register-failed')
})

test('W24 a fallback that did not take is a failure with both reasons: reg add refused, a write that reads back as something else, a daemon that would not start; the event is there each time', () => {
  const a = installed(userUnit({ ...withHome(), run: fakeRegistry(null, { addFails: true }) })).enable({ now: false })
  assert.equal(a.code, 1)
  assert.match(a.err, /Access is denied/)
  assert.match(a.err, /Run/)
  assert.equal(a.event.code, 'task-register-failed')
  const b = installed(userUnit({ ...withHome(), run: fakeRegistry(null, { dropWrites: true }) })).enable({ now: false })
  assert.notEqual(b.code, 0)
  assert.match(b.err, /read back|did not take/)
  assert.ok(b.ledger, 'a write that read back as absent is still ledgered: the undo is idempotent, and the entry says what was tried')
  assert.equal(b.ledger.value, COMMAND)
  // a value that is there but not the one written is a failure too (a read-back that only asks "is something there" would pass it)
  const skewReg = fakeRegistry(null, { storeAs: (v) => `${v} --other` })
  const skew = installed(userUnit({ ...withHome(), run: skewReg })).enable({ now: false })
  assert.notEqual(skew.code, 0)
  assert.match(skew.err, /did not take/)
  assert.match(skew.err, /--other/, 'it says what the registry holds instead')
  assert.deepEqual(skew.ledger, { kind: 'run-key', hive: 'HKCU', key: RUN_KEY.key, name: 'asight-collector', value: COMMAND, prior: null }, 'ledgered all the same')
  assert.equal(skew.event.code, 'task-register-failed')
  const direct = runKeyFallback({ command: COMMAND, run: fakeRegistry(null, { storeAs: (v) => `${v} --other` }) })
  assert.deepEqual([direct.ok, typeof direct.entry, direct.reason.includes('did not take')], [false, 'object', true], 'runKeyFallback itself: not ok, entry for the ledger, the reason')
  // what is ledgered undoes, by the same rule as any undo: a value that is not asight's by its tail is left (`--other` is somebody's); one that is (here only differently spelled) is taken out
  assert.deepEqual([userUnit({ ...withHome(), run: skewReg }).disable({ prior: skew.ledger.prior }).runKey, skewReg.reg.value.value], ['left', `${COMMAND} --other`])
  const spelledReg = fakeRegistry(null, { storeAs: (v) => v.replace('conhost.exe', 'CONHOST.EXE') })
  const spelled = installed(userUnit({ ...withHome(), run: spelledReg })).enable({ now: false })
  assert.notEqual(spelled.code, 0, 'a read-back that is not byte for byte what was written is a failure')
  assert.equal(spelled.ledger.prior, null)
  assert.deepEqual([userUnit({ ...withHome(), run: spelledReg }).disable({ prior: spelled.ledger.prior }).runKey, spelledReg.reg.value], ['removed', null], 'and the entry it handed back undoes it')
  const c = installed(userUnit({ ...withHome(), run: fakeRegistry(), spawn: () => ({ pid: undefined, unref() {}, on() {} }) })).enable({ now: true })
  assert.notEqual(c.code, 0, 'the entry is written but nothing runs now: that is not a success')
  assert.match(c.err, /did not start/)
  assert.equal(c.via, 'run-key')
  assert.ok(c.ledger, 'the entry that was written is still reported, so the ledger has it')
  const missing = fakeRegistry()
  const d = userUnit({ ...withHome(), run: missing }).enable() // no task file: a precondition, not a refusal
  assert.equal(d.code, null)
  assert.deepEqual(missing.calls, [], 'no schtasks and no reg for a file that is not there')
})

test('W24 reg.exe prints in the console code page, which the runner decodes as UTF-8: a value with characters outside ASCII is read back through that and is not "did not take" (the ASCII of it must match), and a prior that cannot be read faithfully is never overwritten', () => {
  const zh = `conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\张三\\AppData\\Roaming\\npm\\node_modules\\asight\\bin\\asight.mjs" daemon --supervise`
  // 1. a correct write of a command with a Chinese profile path, read through a console code page: the fallback took
  const reg = fakeRegistry(null, { codePage: true })
  const r = runKeyFallback({ command: zh, run: reg })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.entry.value, zh, 'the ledger has what was written, not what came back')
  assert.equal(reg.reg.value.value, zh, 'and the registry holds it exactly (the fake stores the argument as it was passed)')
  // 2. the ASCII of the value is still compared: a different ASCII part is a failure, and so is a missing or a wrongly placed non-ASCII run
  for (const [what, stored] of [['another path', zh.replace('nodejs', 'node-js')], ['one letter of the ASCII', zh.replace('Roaming', 'Roamimg')], ['the tail cut', zh.replace(' daemon --supervise', '')], ['no Chinese at all', zh.replace('张三', 'user')], ['a run where there is none', zh.replace('npm', '用户')]]) {
    const bad = runKeyFallback({ command: zh, run: fakeRegistry(null, { codePage: true, storeAs: () => stored }) })
    assert.equal(bad.ok, false, what)
    assert.match(bad.reason, /did not take/, what)
    assert.ok(bad.entry, `${what}: still ledgered`)
  }
  // 3. without non-ASCII characters in what was written the comparison stays byte for byte, code page or not
  assert.equal(runKeyFallback({ command: COMMAND, run: fakeRegistry(null, { codePage: true, storeAs: (v) => v.replace('node.exe', 'Node.exe') }) }).ok, false)
  assert.equal(runKeyFallback({ command: COMMAND, run: fakeRegistry(null, { codePage: true }) }).ok, true)
  // 4. readRunValue says when the text is no UTF-8 any more (U+FFFD); a clean value carries no such key
  const lossy = readRunValue({ run: fakeRegistry({ kind: 'REG_SZ', value: '"C:\\用户\\mine.exe"' }, { codePage: true }) })
  assert.deepEqual([lossy.present, lossy.lossy], [true, true])
  assert.deepEqual(readRunValue({ run: fakeRegistry({ kind: 'REG_SZ', value: '"C:\\Tools\\mine.exe"' }, { codePage: true }) }), { present: true, kind: 'REG_SZ', value: '"C:\\Tools\\mine.exe"' })
  // 5. the user's own Run value that cannot be read faithfully cannot be put back, so it is not overwritten: not one write, and `on` says why
  const theirs = fakeRegistry({ kind: 'REG_SZ', value: '"C:\\用户\\mine.exe" --quiet' }, { codePage: true })
  const f = runKeyFallback({ command: COMMAND, run: theirs })
  assert.equal(f.ok, false)
  assert.match(f.reason, /code page|UTF-8|U\+FFFD/i)
  assert.equal(f.entry, undefined, 'nothing was written, nothing to ledger')
  assert.deepEqual(theirs.calls.filter((c) => c[0] === 'reg').map((c) => c[1]), ['query'], 'not one write')
  const u = installed(userUnit({ ...withHome(), run: theirs })).enable({ now: false })
  assert.notEqual(u.code, 0)
  assert.match(u.err, /code page|UTF-8|U\+FFFD/i)
  assert.equal(u.event.code, 'task-register-failed')
  assert.equal(theirs.reg.value.value, '"C:\\用户\\mine.exe" --quiet', 'the user\'s value is as it was')
  // one of asight's own, read through the code page, is still asight's (the tail is ASCII) and is taken out
  const mine = fakeRegistry({ kind: 'REG_SZ', value: zh }, { codePage: true })
  assert.equal(removeRunValue({ run: mine }).runKey, 'removed')
})

test('W24 off and uninstall remove only the Run value: ours with no prior is deleted, ours over a prior puts the prior back with its kind, one that is not ours is left, and nothing but that one value is named', () => {
  const o = withHome()
  const del = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  assert.deepEqual(userUnit({ ...o, run: del }).disable(), { code: 0, out: '', err: '', task: 'absent', runKey: 'removed' })
  assert.equal(del.reg.value, null)
  assert.deepEqual(del.calls.filter((c) => c[0] === 'reg' && c[1] === 'delete'), [['reg', 'delete', RUN_PATH, '/v', 'asight-collector', '/f']])
  const prior = { kind: 'REG_EXPAND_SZ', value: '%ProgramFiles%\\Tools\\mine.exe' }
  const put = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  assert.deepEqual(userUnit({ ...o, run: put }).remove({ prior }), { code: 0, out: '', err: '', task: 'absent', runKey: 'restored' })
  assert.deepEqual(put.reg.value, prior, 'the user\'s own value is back, with its kind')
  const theirs = fakeRegistry({ kind: 'REG_SZ', value: '"C:\\Tools\\mine.exe" --quiet' })
  assert.deepEqual(userUnit({ ...o, run: theirs }).remove(), { code: 0, out: '', err: '', task: 'absent', runKey: 'left' }, 'a value that is not ours is not ours to delete')
  assert.deepEqual(theirs.calls.filter((c) => c[0] === 'reg').map((c) => c[1]), ['query'])
  const none = fakeRegistry(null)
  assert.deepEqual(userUnit({ ...o, run: none }).remove(), { code: 0, out: '', err: '', task: 'absent', runKey: 'absent' })
  const stuck = fakeRegistry({ kind: 'REG_SZ', value: COMMAND }, { deleteFails: true })
  const f = userUnit({ ...o, run: stuck }).remove()
  assert.deepEqual([f.code, f.runKey], [1, 'failed'])
  assert.match(f.err, /Access is denied/)
  for (const c of [...del.calls, ...put.calls, ...stuck.calls].filter((c) => c[0] === 'reg' && c[1] !== 'query')) assert.ok(c.includes('/v') && c.includes('asight-collector') && c[2] === RUN_PATH, `only the one value is named: ${c.join(' ')}`)
  // a task and a Run value together (an earlier on used the task, a later one the fallback): both go
  const both = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  const bothRun = (file, args) => (file === 'schtasks' && args[0] === '/Query' ? { status: 0, stdout: '', stderr: '' } : null)
  const r = userUnit({ ...o, run: (file, args, opts) => bothRun(file, args) || both(file, args, opts) }).remove()
  assert.deepEqual([r.code, r.task, r.runKey], [0, 'removed', 'removed'])
})

test('W24 exactly one login mechanism is live: enable by the task takes asight\'s earlier Run value out (the user\'s own prior goes back), and enable by the Run value switches an earlier task off', () => {
  // the task registers, an earlier fallback left its Run value: that value goes, and the ledger's prior is what comes back
  const taskOk = (reg) => (file, args, opts) => (file === 'schtasks' && args[0] === '/Create' ? { status: 0, stdout: '', stderr: '' } : file === 'schtasks' && args[0] === '/Run' ? { status: 0, stdout: '', stderr: '' } : reg(file, args, opts))
  const gone = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  const a = installed(userUnit({ ...withHome(), run: taskOk(gone) })).enable({ now: false })
  assert.deepEqual([a.code, a.via, a.runKey, a.warn], [0, 'task', 'removed', undefined])
  assert.equal(gone.reg.value, null, 'the Run value of ours is gone: at login the task is the only start')
  const prior = { kind: 'REG_EXPAND_SZ', value: '%ProgramFiles%\\Tools\\mine.exe' }
  const back = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  const b = installed(userUnit({ ...withHome(), run: taskOk(back) })).enable({ now: false, prior })
  assert.deepEqual([b.code, b.runKey], [0, 'restored'])
  assert.deepEqual(back.reg.value, prior, 'the user\'s own value is back, with its kind')
  const theirs = fakeRegistry({ kind: 'REG_SZ', value: '"C:\\Tools\\mine.exe" --quiet' })
  const c = installed(userUnit({ ...withHome(), run: taskOk(theirs) })).enable({ now: false })
  assert.deepEqual([c.code, c.runKey, theirs.reg.value.value], [0, 'left', '"C:\\Tools\\mine.exe" --quiet'], 'a value that is not ours is not ours to take out')
  // the Run value cannot be taken out: the task is registered all the same (on does not fail), and the caller is told that two mechanisms are live
  const stuck = fakeRegistry({ kind: 'REG_SZ', value: COMMAND }, { deleteFails: true })
  const d = installed(userUnit({ ...withHome(), run: taskOk(stuck) })).enable({ now: false })
  assert.deepEqual([d.code, d.via, d.runKey], [0, 'task', 'failed'])
  assert.match(d.warn, /Run/)
  assert.match(d.warn, /Access is denied/)
  // an answer from reg that is no value at all: not known, said
  const odd = installed(userUnit({ ...withHome(), run: fakeTools({ 'reg query': { status: 0, stdout: 'garbage' } }) })).enable({ now: false })
  assert.equal(odd.runKey, 'failed')
  assert.match(odd.warn, /Run/)
  // the other way round: the Task Scheduler refuses, the Run value is written, and an earlier task is switched off
  const earlier = (over = {}) => {
    const reg = fakeRegistry()
    const run = (file, args, opts) => {
      if (file === 'schtasks' && args[0] === '/Query') return { status: 0, stdout: '', stderr: '' }
      if (file === 'schtasks' && args[0] === '/Change') return { stdout: '', stderr: '', ...(over.change || { status: 0 }) }
      return reg(file, args, opts)
    }
    const calls = []
    return { reg, calls, run: (file, args, opts) => { calls.push([file, ...args]); return run(file, args, opts) } }
  }
  const e1 = earlier()
  const f = installed(userUnit({ ...withHome(), run: e1.run })).enable({ now: false })
  assert.deepEqual([f.code, f.via, f.task, f.warn], [0, 'run-key', 'disabled', undefined])
  assert.deepEqual(e1.calls.filter((c) => c[0] === 'schtasks' && c[1] === '/Change'), [['schtasks', '/Change', '/TN', TASK_NAME, '/DISABLE']], 'the task that an earlier on registered would otherwise start a second supervisor at every login')
  const e2 = earlier({ change: { status: 1, stderr: 'ERROR: Access is denied.' } })
  const g = installed(userUnit({ ...withHome(), run: e2.run })).enable({ now: false })
  assert.deepEqual([g.code, g.via, g.task], [0, 'run-key', 'failed'])
  assert.match(g.warn, /\\asight\\collector/)
  assert.match(g.warn, /Access is denied/)
  const none = fakeRegistry() // schtasks /Query answers 1: no task, nothing to switch off
  const h = installed(userUnit({ ...withHome(), run: none })).enable({ now: false })
  assert.deepEqual([h.code, h.via, h.task, h.warn], [0, 'run-key', undefined, undefined])
  assert.ok(!none.calls.some((c) => c[1] === '/Change'))
  const unsure = fakeTools({ 'schtasks /Create': { status: 1, stderr: 'ERROR: Access is denied.' }, 'schtasks /Query': { status: null, error: new Error('spawnSync schtasks ETIMEDOUT') }, 'reg query': { status: 1 }, 'reg add': { status: 0 } })
  let wrote = null
  const u = installed(userUnit({ ...withHome(), run: (file, args, opts) => { if (file === 'reg' && args[0] === 'add') wrote = args[args.indexOf('/d') + 1]; if (file === 'reg' && args[0] === 'query' && wrote) return { status: 0, stdout: REG_OUT('REG_SZ', wrote), stderr: '' }; return unsure(file, args, opts) } }))
  const i = u.enable({ now: false })
  assert.deepEqual([i.code, i.via], [0, 'run-key'])
  assert.match(i.warn, /\/Query/, 'a task that cannot be looked up is said, not assumed gone')
})

test('W24 a /Run that answered success but started nothing (LastTaskResult 267011, no interactive session for the task — probe-verified on a Windows test machine, 2026-10-12): the daemon is started DIRECTLY, the receipt says exactly that, and the task keeps the login; a task that did run is left alone', () => {
  // the verbose CSV schtasks answers for the task: the Last Result column is found by its header (en), and the value may be decimal or 0x-prefixed
  const head = '"HostName","TaskName","Next Run Time","Status","Last Run Time","Last Result","Creation Date","Task To Run"'
  const csv = (last) => ({ status: 0, stdout: `\r\n${head}\r\n"HOST","\\asight\\collector","2026/10/12 10:00:00","Ready","2026/10/12 10:00:00","${last}","2026/10/11 09:00:00","conhost.exe"\r\n`, stderr: '' })
  const zhHead = '"\u4e3b\u673a\u540d","\u4efb\u52a1\u540d","\u4e0b\u6b21\u8fd0\u884c\u65f6\u95f4","\u6a21\u5f0f","\u4e0a\u6b21\u8fd0\u884c\u65f6\u95f4","\u4e0a\u6b21\u8fd0\u884c\u7ed3\u679c","\u521b\u5efa\u65f6\u95f4","\u8981\u8fd0\u884c\u7684\u4efb\u52a1"'
  const zhCsv = (last) => ({ status: 0, stdout: `\r\n${zhHead}\r\n"HOST","\\asight\\collector","2026/10/12 10:00:00","\u5c31\u7eea","2026/10/12 10:00:00","${last}","2026/10/11 09:00:00","conhost.exe"\r\n`, stderr: '' })
  const none = fakeRegistry()
  // 267011 decimal, 0x41303, and the zh-CN header all read as "has not run": the daemon is started directly, honestly said
  for (const [name, result] of [['decimal 267011', csv('267011')], ['hex 0x41303', csv('0x41303')], ['the zh-CN header, decimal', zhCsv('267011')]]) {
    const spawned = []
    const fakeSpawn = (cmd, args) => { spawned.push([cmd, ...args]); return { pid: 4242, unref() {}, on() {} } }
    const runner = (file, args, opts) => (file === 'schtasks' && (args[0] === '/Create' || args[0] === '/Run') ? { status: 0, stdout: '', stderr: '' } : file === 'schtasks' && args[0] === '/Query' && args.includes('/V') ? result : none(file, args, opts))
    const u = installed(userUnit({ ...withHome(), run: runner, spawn: fakeSpawn }))
    const r = u.enable({ now: true })
    assert.equal(r.code, 0, `${name}: on does not fail`)
    assert.equal(r.via, 'task', `${name}: the task is still the login mechanism`)
    assert.equal(spawned.length, 1, `${name}: the daemon was started directly`)
    assert.match(spawned[0].join(' '), /daemon --supervise/)
    assert.equal(r.pid, 4242, `${name}: the receipt names the started pid`)
    assert.match(r.warn, /LastTaskResult 267011/, `${name}: the receipt says what the task said`)
    assert.match(r.warn, /started directly this run; the task will start it at next login/, `${name}: the receipt is honest about what happened`)
  }
  // a task that did run (Last Result 0), one whose result cannot be read, and now: false: no direct start, no warn
  for (const [name, result, now] of [['Last Result 0 (it ran)', csv('0'), true], ['a /V query that failed', { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' }, true], ['a /V query that did not run', { status: null, stdout: '', stderr: '' }, true], ['no /Run at all', null, false]]) {
    const spawned = []
    const fakeSpawn = (cmd, args) => { spawned.push([cmd, ...args]); return { pid: 1, unref() {}, on() {} } }
    const runner = (file, args, opts) => (result && file === 'schtasks' && args[0] === '/Query' && args.includes('/V') ? result : null) || (file === 'schtasks' && (args[0] === '/Create' || args[0] === '/Run') ? { status: 0, stdout: '', stderr: '' } : null) || none(file, args, opts)
    const u = installed(userUnit({ ...withHome(), run: runner, spawn: fakeSpawn }))
    const r = u.enable({ now })
    assert.deepEqual([r.code, r.via, r.warn, spawned.length], [0, 'task', undefined, 0], `${name}: nothing is started beside the task`)
  }
})

test('W24 which Run value is asight\'s is decided by its tail: the supervised daemon command at the end of the value (blanks after it do not matter); the same words with something after them, or glued to another word, are somebody else\'s and are left', () => {
  for (const [value, runKey] of [[COMMAND, 'removed'], [`${COMMAND}   `, 'removed'], [`"C:\\Other\\launcher.exe" node asight daemon --supervise`, 'removed'], [`${COMMAND} --extra`, 'left'], [`${COMMAND} && del x`, 'left'], ['mydaemon --supervise', 'left'], ['"C:\\Tools\\mine.exe" --daemon --supervise-all', 'left'], ['daemon', 'left']]) {
    const r = fakeRegistry({ kind: 'REG_SZ', value })
    assert.equal(removeRunValue({ run: r }).runKey, runKey, JSON.stringify(value))
    assert.equal(r.reg.value === null, runKey === 'removed', `${JSON.stringify(value)}: ${runKey === 'removed' ? 'deleted' : 'still there'}`)
  }
})

test('W24 daemonCommandLine is the task\'s action as one line, and removeRunValue is the same undo the unit uses', () => {
  assert.equal(daemonCommandLine({ node: NODE, asight: SCRIPT }), COMMAND)
  assert.equal(daemonCommandLine({ node: NODE, asight: SCRIPT, conhost: 'C:\\Windows\\System32\\conhost.exe' }), `C:\\Windows\\System32\\conhost.exe --headless "${NODE}" "${SCRIPT}" daemon --supervise`)
  assert.throws(() => daemonCommandLine({ node: 'C:\\no"de.exe', asight: SCRIPT }), TypeError)
  const r = fakeRegistry({ kind: 'REG_SZ', value: COMMAND })
  assert.equal(removeRunValue({ run: r }).runKey, 'removed')
  assert.equal(runKeyFallback({ command: COMMAND, run: fakeRegistry() }).ok, true, 'and the fallback writes it through the same reader')
})

// ---- W24: the supervisor parent ---------------------------------------------------------------------------------------------------------------------

/** `promise`, or a failure after `ms`: a supervisor that never ends (a mutation that restarts for ever) is a red test in seconds, not a hang. */
const within = (promise, what, ms = 3000) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`${what}: did not finish within ${ms} ms`)), ms); t.unref?.() })])
/** A counter for a clock: `sleep` advances it by what it was asked to wait, and a child that "ran" for a while advances it too. */
const clock = (t = 1_700_000_000_000) => ({ now: () => t, advance: (ms) => { t += ms } })
/**
 * Scripted children. `script[i]` says how the i-th child ends: `{ code }` / `{ signal }` (default: exit 0), `ranMs` (how long it ran: the clock moves by it first), `hang: true` (it ends only when killed), `throws` (the spawn itself throws
 * that errno), `error` (the child emits 'error' and never exits, and has no pid: a spawn that failed), `errorWithPid` (the child is running, emits 'error' (a kill or a message that failed), and then exits as `code` / `signal` says). The recorder keeps every spawn and every kill.
 */
function fakeSpawner(script, clk) {
  const spawns = []
  const kills = []
  let n = 0 // the step for this start: a spawn that throws is a start all the same
  const spawn = (cmd, args, opts) => {
    const step = n > 60 ? { hang: true } : (script[n++] ?? { code: 0 }) // past 60 starts the supervisor is running away: the children stop ending, and `within` says so
    if (step.throws) throw Object.assign(new Error(`spawn ${cmd} ${step.throws}`), { code: step.throws })
    const child = Object.assign(new EventEmitter(), { pid: step.error ? undefined : 5000 + spawns.length, exitCode: null, signalCode: null }) // a child that could not be spawned has no pid
    const finish = (code, signal) => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); child.emit('close', code, signal) }
    child.kill = (sig = 'SIGTERM') => { kills.push([child.pid, sig]); setImmediate(() => finish(null, sig)); return true }
    spawns.push({ cmd, args, opts, child })
    if (step.error) setImmediate(() => child.emit('error', Object.assign(new Error(`child ${step.error}`), { code: step.error })))
    else if (step.errorWithPid) { setImmediate(() => child.emit('error', Object.assign(new Error(`child ${step.errorWithPid}`), { code: step.errorWithPid }))); setTimeout(() => finish(step.code ?? null, step.signal ?? null), 10) }
    else if (!step.hang) setImmediate(() => { clk.advance(step.ranMs ?? 0); finish(step.code ?? null, step.signal ?? null) })
    return child
  }
  return Object.assign(spawn, { spawns, kills })
}
const sleeper = (clk) => { const delays = []; const sleep = async (ms) => { delays.push(ms); clk.advance(ms) }; return Object.assign(sleep, { delays }) }
const COMMAND_OF_DAEMON = { node: NODE, args: [SCRIPT, 'daemon'] }
const supervise = (over = {}) => {
  const clk = over.clk || clock()
  const spawn = over.spawn || fakeSpawner(over.script || [], clk)
  const sleep = over.sleep || sleeper(clk)
  const dir = over.dir || tmpDir('asight-sup-')
  const logs = []
  const sup = superviseChild({ spawn, command: COMMAND_OF_DAEMON, dir, now: clk.now, sleep, pid: 4321, startedAt: 1234567890123, log: (l) => logs.push(l), ...over.opts })
  return { sup, spawn, sleep, dir, logs, clk }
}

test('W24 the supervisor brings the daemon back after a non-zero exit or a kill, waiting 1, 2, 4, 8, 16, 32, then 60 s at most; it runs the daemon itself, never --supervise again', async () => {
  const w = supervise({ script: [{ code: 1 }, { code: 3 }, { code: null, signal: 'SIGKILL' }, { code: 70 }, { code: 1 }, { code: 255 }, { code: 2 }, { code: 1 }, { code: 0 }] })
  assert.equal(await within(w.sup.done, 'the supervisor'), 0)
  assert.deepEqual(w.sleep.delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
  assert.equal(w.spawn.spawns.length, 9)
  for (const { cmd, args, opts } of w.spawn.spawns) {
    assert.deepEqual([cmd, args], [NODE, [SCRIPT, 'daemon']], 'node asight daemon: a child that carried --supervise would start a supervisor of its own, for ever')
    assert.equal(opts.windowsHide, true)
  }
  assert.deepEqual([0, 1, 2, 6, 7, 20].map(supervisorBackoff), [1000, 2000, 4000, 60000, 60000, 60000])
  assert.equal(SUPERVISE_CAP_MS, 60000)
})

test('W24 a daemon that exits 0 was asked to stop (off drained, uninstall, off --now): the supervisor exits too, at once, and does not start another', async () => {
  const w = supervise({ script: [{ code: 0 }] })
  assert.equal(await within(w.sup.done, 'the supervisor'), 0)
  assert.equal(w.spawn.spawns.length, 1)
  assert.deepEqual(w.sleep.delays, [], 'no waiting, no second start')
  const later = supervise({ script: [{ code: 1 }, { code: 0 }] })
  assert.equal(await within(later.sup.done, 'the supervisor'), 0, 'a crash first and a clean stop after it: one restart, then the supervisor is done')
  assert.deepEqual([later.spawn.spawns.length, later.sleep.delays], [2, [1000]])
})

test('W24 the supervisor writes supervisor.lock with its pid and start time before it starts anything, holds nothing else, and removes only its own lock when it ends', async () => {
  const dir = tmpDir('asight-sup-')
  let seen = null
  const clk = clock()
  const spawn = fakeSpawner([{ code: 1 }, { code: 0 }], clk)
  const watching = (...a) => { if (!seen) seen = { lock: JSON.parse(fs.readFileSync(path.join(dir, SUPERVISOR_LOCK), 'utf8')), files: fs.readdirSync(dir) }; return spawn(...a) }
  const w = supervise({ dir, clk, spawn: Object.assign(watching, { spawns: spawn.spawns }) })
  assert.equal(SUPERVISOR_LOCK, 'supervisor.lock')
  await within(w.sup.done, 'the supervisor')
  assert.deepEqual(seen.lock, { pid: 4321, startedAt: 1234567890123 }, 'what `off` checks before it stops the process: the pid and when it started')
  assert.deepEqual(seen.files, [SUPERVISOR_LOCK], 'the lock is the only thing it keeps: no capture state')
  assert.deepEqual(fs.readdirSync(dir), [], 'the lock goes with the supervisor')
  // another supervisor's lock (a newer one) is not ours to delete
  const other = tmpDir('asight-sup-')
  const spawn2 = fakeSpawner([{ code: 0 }], clock())
  const hijack = (...a) => { fs.writeFileSync(path.join(other, SUPERVISOR_LOCK), JSON.stringify({ pid: 9, startedAt: 1 })); return spawn2(...a) }
  await within(supervise({ dir: other, spawn: Object.assign(hijack, { spawns: spawn2.spawns }) }).sup.done, 'the supervisor')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, SUPERVISOR_LOCK), 'utf8')), { pid: 9, startedAt: 1 })
})

test('W24 the default start time of the lock is when this process started (now minus its uptime), the form the process list gives for the identity check', async () => {
  const dir = tmpDir('asight-sup-')
  const spawn = fakeSpawner([{ code: 0 }], clock())
  const seen = []
  const sup = superviseChild({ spawn: (...a) => { seen.push(JSON.parse(fs.readFileSync(path.join(dir, SUPERVISOR_LOCK), 'utf8'))); return spawn(...a) }, command: COMMAND_OF_DAEMON, dir, sleep: async () => {} })
  await within(sup.done, 'the supervisor')
  assert.equal(seen[0].pid, process.pid)
  assert.ok(Math.abs(seen[0].startedAt - (Date.now() - process.uptime() * 1000)) < 2000)
})

test('W24 a daemon that ran for a minute before it died starts the backoff over; one that ran a second less does not', async () => {
  assert.equal(SUPERVISE_STABLE_MS, 60000)
  const a = supervise({ script: [{ code: 1 }, { code: 1, ranMs: 60000 }, { code: 1 }, { code: 0 }] })
  await within(a.sup.done, 'the supervisor')
  assert.deepEqual(a.sleep.delays, [1000, 1000, 2000])
  const b = supervise({ script: [{ code: 1 }, { code: 1, ranMs: 59999 }, { code: 0 }] })
  await within(b.sup.done, 'the supervisor')
  assert.deepEqual(b.sleep.delays, [1000, 2000])
})

test('W24 stop() ends the daemon and the supervisor without a restart, also while it waits to restart, and a second stop is harmless', async () => {
  const running = supervise({ script: [{ hang: true }, { code: 0 }] })
  await new Promise((r) => setImmediate(r))
  assert.equal(running.spawn.spawns.length, 1)
  const result = await within(running.sup.stop(), 'stop()')
  assert.equal(result, 0, 'asked to stop: a clean exit')
  assert.equal(running.spawn.kills.length, 1)
  assert.equal(running.spawn.spawns.length, 1, 'the exit that the kill caused is not a crash to restart from')
  assert.deepEqual(running.sleep.delays, [])
  assert.deepEqual(fs.readdirSync(running.dir), [])
  assert.equal(await within(running.sup.stop(), 'a second stop()'), 0)
  // while it waits out a backoff
  const clk = clock()
  const sleeps = []
  const waiting = supervise({ clk, script: [{ code: 1 }, { code: 0 }], sleep: (ms, { signal }) => { sleeps.push(ms); return new Promise((r) => signal.addEventListener('abort', r, { once: true })) } })
  await until(() => sleeps.length === 1)
  assert.equal(await within(waiting.sup.stop(), 'stop() during the backoff'), 0)
  assert.equal(waiting.spawn.spawns.length, 1, 'the restart it was waiting for did not happen')
})
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 5)) } }

test('W24 a daemon that cannot even be started is a failure to back off from, said in the log, not a crash of the supervisor and not a loop without a pause', async () => {
  const w = supervise({ script: [{ throws: 'ENOENT' }, { error: 'EACCES' }, { code: 0 }] })
  assert.equal(await within(w.sup.done, 'the supervisor'), 0)
  assert.deepEqual(w.sleep.delays, [1000, 2000])
  assert.ok(w.logs.some((l) => /ENOENT/.test(l)))
  assert.ok(w.logs.some((l) => /EACCES/.test(l)))
  assert.ok(w.logs.some((l) => /restart/.test(l) && /1 s/.test(l)), 'each restart is said, with the wait')
})

test('W24 an error of a child that is running (it has a pid: a kill that failed, a message that could not be sent) is not an exit: the supervisor waits for the exit and does not start a second daemon beside it', async () => {
  const w = supervise({ script: [{ errorWithPid: 'EPERM', code: 0 }, { code: 0 }] })
  assert.equal(await within(w.sup.done, 'the supervisor'), 0)
  assert.equal(w.spawn.spawns.length, 1, 'one daemon: the one that was running when the error came; its exit 0 is the stop')
  assert.deepEqual(w.sleep.delays, [], 'and nothing was restarted or waited for')
  assert.ok(w.logs.some((l) => /EPERM/.test(l) && /5000/.test(l)), 'the error is said, with the pid')
  const crash = supervise({ script: [{ errorWithPid: 'EPERM', code: 1 }, { code: 0 }] })
  assert.equal(await within(crash.sup.done, 'the supervisor'), 0)
  assert.deepEqual([crash.spawn.spawns.length, crash.sleep.delays], [2, [1000]], 'when it then dies with 1 it is the exit that restarts, once')
})

test('W24 a lock that cannot be written does not stop the supervision: it is said in the log, and the daemon is still brought back', async () => {
  const dir = path.join(tmpDir('asight-sup-'), 'file-not-dir')
  fs.writeFileSync(dir, 'x')
  const w = supervise({ dir, script: [{ code: 1 }, { code: 0 }] })
  assert.equal(await within(w.sup.done, 'the supervisor'), 0)
  assert.ok(w.logs.some((l) => /supervisor\.lock/.test(l)))
  assert.deepEqual(w.sleep.delays, [1000])
})

/** A world with processes: `live` is the set of "pid:startedAt" that are running. The injected identity check of the lock. */
const world = (...live) => { const asked = []; const isLive = ({ pid, startedAt }) => { asked.push({ pid, startedAt }); return live.includes(`${pid}:${startedAt}`) }; return Object.assign(isLive, { asked }) }

test('W24 the supervisor is a singleton: with a live holder of supervisor.lock the second one says so, starts no daemon, exits 0 and leaves the holder\'s lock alone', async () => {
  const dir = tmpDir('asight-sup-')
  const a = supervise({ dir, script: [{ hang: true }], opts: { pid: 4321, startedAt: 1111 } })
  await new Promise((r) => setImmediate(r))
  assert.equal(a.spawn.spawns.length, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SUPERVISOR_LOCK), 'utf8')), { pid: 4321, startedAt: 1111 })
  const isLive = world('4321:1111')
  const b = supervise({ dir, script: [{ code: 1 }, { code: 1 }, { code: 1 }], opts: { pid: 9999, startedAt: 2222, isLive } })
  assert.equal(await within(b.sup.done, 'the second supervisor'), 0, 'it ends at once and cleanly: the task that started it is not asked to restart anything')
  assert.equal(b.spawn.spawns.length, 0, 'no second daemon: it would exit 1 against the first one\'s control endpoint and be restarted for ever')
  assert.deepEqual(b.sleep.delays, [])
  assert.deepEqual(isLive.asked, [{ pid: 4321, startedAt: 1111 }], 'the check was asked about the holder and nobody else')
  assert.equal(b.logs.length, 1, 'one line')
  assert.match(b.logs[0], /4321/)
  assert.match(b.logs[0], /supervisor\.lock/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SUPERVISOR_LOCK), 'utf8')), { pid: 4321, startedAt: 1111 }, 'the holder\'s lock is not overwritten, and the refused one has no lock of its own to delete')
  assert.equal(await within(b.sup.stop(), 'stop() of the refused one'), 0)
  assert.ok(fs.existsSync(path.join(dir, SUPERVISOR_LOCK)), 'stopping the refused one does not take the holder\'s lock away: `off` still finds the supervisor that runs')
  assert.equal(await within(a.sup.stop(), 'the first supervisor'), 0)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('W24 a lock whose holder is not running (a hard stop leaves one; a pid is reused; the start time differs) is taken over; a lock of this very pid is ours; an identity check that cannot tell is said and treated as not running', async () => {
  /** Starts a supervisor over a lock that is already there, lets it run its daemon, and says whose lock it is while it runs. */
  const takes = async (held, opts, what) => {
    const dir = tmpDir('asight-sup-')
    fs.writeFileSync(path.join(dir, SUPERVISOR_LOCK), typeof held === 'string' ? held : `${JSON.stringify(held)}\n`)
    const w = supervise({ dir, script: [{ hang: true }], opts: { pid: 4321, startedAt: 5555, ...opts } })
    await new Promise((r) => setImmediate(r))
    assert.equal(w.spawn.spawns.length, 1, `${what}: it supervised`)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SUPERVISOR_LOCK), 'utf8')), { pid: 4321, startedAt: 5555 }, `${what}: the lock names this supervisor, so that off can find it`)
    assert.equal(await within(w.sup.stop(), what), 0)
    assert.deepEqual(fs.readdirSync(dir), [], `${what}: and its end takes the lock away`)
    return w
  }
  await takes({ pid: 777, startedAt: 1 }, { isLive: world() }, 'a dead holder')
  await takes({ pid: 777, startedAt: 1 }, { isLive: world('777:2') }, 'a reused pid (running, with another start time)')
  await takes({ pid: 4321, startedAt: 1 }, { isLive: world('4321:1') }, 'a lock that names this very process')
  const broken = await takes({ pid: 777, startedAt: 1 }, { isLive: () => { throw new Error('powershell did not answer') } }, 'an identity check that fails: not known to be running is not running, asight starts rather than not starting')
  assert.ok(broken.logs.some((l) => /powershell did not answer/.test(l)), 'and the failure is said')
  for (const junk of ['', '{', '[]', '{"pid":"x"}', '{"pid":0,"startedAt":1}', '{"pid":1.5,"startedAt":1}', '{"pid":5}']) { // a lock that names nobody is nobody's
    const isLive = world('0:1', '1:1', '5:undefined')
    await takes(junk, { isLive }, `a lock of ${JSON.stringify(junk)}`)
    assert.deepEqual(isLive.asked, [], `the check is not asked about ${JSON.stringify(junk)}`)
  }
})

test('W24 two supervisors that start in the same moment end up as one: the lock is made exclusively, so the one that lost reads the winner\'s lock', async () => {
  const dir = tmpDir('asight-sup-')
  const winner = JSON.stringify({ pid: 4000, startedAt: 7 })
  const racing = { ...fs, writeFileSync: (file, data, opts) => { if (opts && opts.flag === 'wx') { fs.writeFileSync(file, winner); throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }) } return fs.writeFileSync(file, data, opts) } }
  const w = supervise({ dir, script: [{ code: 0 }], opts: { fs: racing, isLive: world('4000:7') } })
  assert.equal(await within(w.sup.done, 'the loser'), 0)
  assert.equal(w.spawn.spawns.length, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SUPERVISOR_LOCK), 'utf8')), { pid: 4000, startedAt: 7 })
})

test('W24 without an identity check (a caller that passes none) the lock is written as before; runSupervisor passes the real one, which asks Windows for the holder\'s start time and accepts the lock\'s own to within 2 s', async () => {
  const dir = tmpDir('asight-sup-')
  fs.writeFileSync(path.join(dir, SUPERVISOR_LOCK), JSON.stringify({ pid: 777, startedAt: 1_700_000_000_000 }))
  const w = supervise({ dir, script: [{ code: 0 }] })
  assert.equal(await within(w.sup.done, 'no check'), 0)
  assert.equal(w.spawn.spawns.length, 1)
  const answers = (out, status = 0) => { const calls = []; const run = (file, args) => { calls.push([file, ...args]); return { status, stdout: out, stderr: '' } }; return Object.assign(run, { calls }) }
  const holder = { pid: 777, startedAt: 1_700_000_000_000 }
  const q = answers('1700000001500\r\n')
  assert.equal(lockHolderAlive(holder, { run: q }), true, '1.5 s from the lock\'s time: the same process')
  assert.equal(q.calls.length, 1)
  assert.equal(q.calls[0][0], 'powershell')
  assert.ok(q.calls[0].includes('-NoProfile') && q.calls[0].includes('-NonInteractive'))
  assert.match(q.calls[0].at(-1), /Get-Process -Id 777\b/, 'one fixed question about one pid')
  assert.equal(lockHolderAlive(holder, { run: answers('1699999998500') }), true, '... and 1.5 s the other way')
  assert.equal(lockHolderAlive(holder, { run: answers('1700000003000') }), false, '3 s apart: another process that has the pid now')
  assert.equal(lockHolderAlive(holder, { run: answers('gone') }), false, 'no such process')
  for (const bad of [answers('unreadable'), answers('<html>'), answers('', 1), answers('', null)]) assert.throws(() => lockHolderAlive(holder, { run: bad }), /777|start time|did not/i, 'cannot tell: an error with the reason, which the supervisor says and goes on')
  for (const pid of [0, -1, 1.5, '5; calc', NaN, undefined]) assert.throws(() => lockHolderAlive({ pid, startedAt: 1 }, { run: answers('gone') }), TypeError, `a pid that is not a positive integer is never put into a command: ${pid}`)
  // runSupervisor: the real check is wired in, over the injected runner
  fs.writeFileSync(path.join(dir, SUPERVISOR_LOCK), JSON.stringify(holder))
  const run = answers('1700000000400')
  const clk = clock()
  const spawn = fakeSpawner([{ code: 0 }], clk)
  const r = await runSupervisor({ node: NODE, asight: SCRIPT, dir, run, proc: new EventEmitter(), deps: { spawn, now: clk.now, sleep: sleeper(clk), pid: 4321 } })
  assert.equal(r, 0)
  assert.equal(spawn.spawns.length, 0, 'the holder answered with its own start time: this one does not start a daemon')
  assert.equal(run.calls.length, 1)
})

test('W24 runSupervisor is what `asight daemon --supervise` calls: it supervises node <asight> daemon, stops its child on SIGINT, SIGTERM or SIGHUP, and leaves no handler behind', async () => {
  const clk = clock()
  const spawn = fakeSpawner([{ hang: true }], clk)
  const proc = new EventEmitter()
  const dir = tmpDir('asight-sup-')
  const p = runSupervisor({ node: NODE, asight: SCRIPT, dir, proc, deps: { spawn, now: clk.now, sleep: sleeper(clk) } })
  await until(() => spawn.spawns.length === 1)
  assert.deepEqual([spawn.spawns[0].cmd, spawn.spawns[0].args], [NODE, [SCRIPT, 'daemon']])
  assert.deepEqual(['SIGHUP', 'SIGINT', 'SIGTERM'].map((s) => proc.listenerCount(s)), [1, 1, 1])
  proc.emit('SIGTERM')
  assert.equal(await within(p, 'runSupervisor after SIGTERM'), 0)
  assert.equal(spawn.kills.length, 1)
  assert.deepEqual(['SIGHUP', 'SIGINT', 'SIGTERM'].map((s) => proc.listenerCount(s)), [0, 0, 0])
  await assert.rejects(async () => runSupervisor({ node: NODE, dir, proc }), TypeError, 'without the script it would supervise nothing')
})

// R7's unsplit-token exception (1.6 R7, D53③): an account with no split token — UAC off (EnableLUA = 0), or the built-in Administrator
// (RID 500) with FilterAdministratorToken not 1 — runs every shell at High, and `on` and `off` use the same token, so the risk R7 guards (a root-written
// item a user-level `off` cannot undo) is not there: its High token is let through. A split token's elevated half and SYSTEM are still refused.
const REG = (name, v) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\r\n    ${name}    REG_DWORD    ${v}\r\n\r\n`
const answers = (map, calls = []) => (file, args) => { calls.push([file, ...args]); const k = Object.keys(map).find((x) => [file, ...args].join(' ').includes(x)); return k ? (typeof map[k] === 'string' ? { status: 0, stdout: map[k], stderr: '' } : map[k]) : { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' } }
const HIGH = WHOAMI('Mandatory Label\\High Mandatory Level')
const USER = (rid) => `"pc\\\\me","S-1-5-21-1-2-3-${rid}"\r\n`

test('R7 unsplit token (off / uninstall, whoami): High with EnableLUA = 0, or the built-in Administrator with FilterAdministratorToken not 1, is let through; a split token\'s High and SYSTEM are not', () => {
  assert.equal(refuseElevatedByWhoami({ run: answers({ '/groups': HIGH, EnableLUA: REG('EnableLUA', '0x0'), '/user': USER(1001) }) }), null, 'UAC off: every token is unsplit')
  assert.equal(refuseElevatedByWhoami({ run: answers({ '/groups': HIGH, EnableLUA: REG('EnableLUA', '0x1'), '/user': USER(500) }) }), null, 'the built-in Administrator, FilterAdministratorToken absent (its default, 0)')
  assert.equal(refuseElevatedByWhoami({ run: answers({ '/groups': HIGH, EnableLUA: REG('EnableLUA', '0x1'), '/user': USER(500), FilterAdministratorToken: REG('FilterAdministratorToken', '0x0') }) }), null)
  for (const [why, map] of [
    ['a split token run as administrator', { '/groups': HIGH, EnableLUA: REG('EnableLUA', '0x1'), '/user': USER(1001) }],
    ['the built-in Administrator under Admin Approval Mode', { '/groups': HIGH, EnableLUA: REG('EnableLUA', '0x1'), '/user': USER(500), FilterAdministratorToken: REG('FilterAdministratorToken', '0x1') }],
    ['EnableLUA unreadable: not known to be unsplit', { '/groups': HIGH, '/user': USER(1001) }],
    ['SYSTEM, whatever UAC says', { '/groups': WHOAMI('Mandatory Label\\System Mandatory Level', '"NT AUTHORITY\\SYSTEM","User","S-1-5-18",""\n'), EnableLUA: REG('EnableLUA', '0x0'), '/user': USER(1001) }],
  ]) assert.equal(refuseElevatedByWhoami({ run: answers(map) })?.code, 'elevated-token', why)
  const calls = []
  refuseElevatedByWhoami({ run: answers({ '/groups': WHOAMI('Mandatory Label\\Medium Mandatory Level') }, calls) })
  assert.deepEqual(calls.map((c) => c[0]), ['whoami'], 'a Medium token asks nothing more')
})

test('R7 unsplit token (on / daemon, whoami as off): High with UAC off or the built-in Administrator unfiltered is let through; High otherwise and SYSTEM are refused (D53③)', async () => {
  const world = ({ label, system = false, lua = '0x1', user = 'S-1-5-21-1-2-3-1001', filter = null }) => (file, args) => {
    if (file === 'whoami' && args[0] === '/groups') return { status: 0, stdout: WHOAMI(label, system ? '"NT AUTHORITY\\SYSTEM","User","S-1-5-18","x"\n' : ''), stderr: '' }
    if (file === 'whoami' && args[0] === '/user') return { status: 0, stdout: `"pc\\u","${user}"\n`, stderr: '' }
    const v = args.at(-1) === 'EnableLUA' ? lua : filter
    return v == null ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `    ${args.at(-1)}    REG_DWORD    ${v}\n`, stderr: '' }
  }
  const ask = (w) => refuseElevated({ run: world(w) })
  const HIGH = 'Mandatory Label\\High Mandatory Level'
  assert.equal(await ask({ label: HIGH, lua: '0x0' }), null, 'UAC off: every shell is High')
  assert.equal(await ask({ label: HIGH, user: 'S-1-5-21-1-2-3-500' }), null, 'the built-in Administrator, FilterAdministratorToken absent')
  assert.equal((await ask({ label: HIGH, user: 'S-1-5-21-1-2-3-500', filter: '0x1' }))?.code, 'elevated-token', 'Admin Approval Mode on: split')
  assert.equal((await ask({ label: HIGH }))?.code, 'elevated-token', 'an elevated shell of a split account')
  assert.equal((await ask({ label: 'Mandatory Label\\System Mandatory Level', system: true, lua: '0x0' }))?.code, 'elevated-token', 'SYSTEM is refused whatever UAC says')
})

// W39 (moved from the old wiring.test.mjs, which went with the old win32 collector): the arch the CLI and daemon reach through loadArch.
import { loadArch } from '../../../../src/collector/arch/index.mjs'
test('W39 loadArch("win32") returns the Windows arch on any OS (imported and built here off Windows: no top-level Windows call), with the pieces the CLI and daemon reach', async () => {
  const A = await loadArch('win32')
  assert.equal(A.os, 'win32')
  assert.equal(A.install, null, 'the machine-wide helper is a Linux thing; Windows needs none')
  assert.equal(A.unit.userUnit, userUnit, 'the autostart unit is this module')
  assert.equal(A.controlEndpoint, controlEndpoint)
  assert.equal(A.refuseElevated, refuseElevated)
  assert.equal(A.nodePreflight, nodePreflight)
  assert.equal(A.runSupervisor, runSupervisor)
  assert.equal(A.prepare, undefined, 'no preflight: the engine is the only local proxy, `on` downloads nothing')
  assert.equal(A.ensureKernel, undefined, 'no kernel to ensure either')
  assert.equal(typeof A.osRoots, 'function', 'the Windows roots are read (4.8 §6.2)')
  assert.equal(typeof A.netFacts, 'function', 'the platform\'s part of the network facts (1.6 §9.7): gatherNetFacts reaches it as archFacts')
})
