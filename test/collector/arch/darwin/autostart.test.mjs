// autostart.test.mjs — the darwin collector's way in and the way it is kept up: the control socket's path and token, the refusal of root, the Node preflight, the LaunchAgent plist and
// its launchctl verbs, and the standalone undo of src/off/darwin.mjs (RFC 4.9 §4 · §7; the case list is 4.8 §7 W24 W25 W26, the off-order clause is MA2's, the equality test is the real,
// passing version of the win32 side's W24 Task 9(b) todo). Nothing here needs macOS: every tool (launchctl) goes through an injected runner, the uid, the spawn and the random source are
// fakes, and the control server listens on a unix socket in a temp directory — which is also what the real one does on darwin (4.9 §7).
//
// What the win32 file has and this one does not, and why (4.9): the supervisor parent and its lock (W24's superviseChild / runSupervisor / lockHolderAlive tests) — dropped, launchd's
// KeepAlive really does bring a killed daemon back (§4); the Run-key fallback — dropped, launchd is the one autostart, no fallback exists to succeed through (§4); the helper's `token`
// verb and `whoami /groups` (W25) — darwin has no resident helper (§1) and the uid is read in-process; the pipe-vs-unix split of W26 — darwin IS the unix half.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { refuseElevated, nodePreflight, plistXml, plistPath, userUnit, directStartEnv, AGENT_LABEL, PLIST_FILE, LAUNCHD_THROTTLE_SECONDS, KICKSTART_TIMEOUT_MS } from '../../../../src/collector/arch/darwin/autostart.mjs'
import { daemonLogPaths } from '../../../../src/collector/arch/daemon-logs.mjs'
import { controlEndpoint, readControlEndpoint, CONTROL_FILE, SOCKET_PREFIX, SOCKET_SUFFIX } from '../../../../src/collector/arch/darwin/control-path.mjs'
import * as offDarwin from '../../../../src/off/darwin.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { startControlServer, CONTROL_TOKEN_HEADER } from '../../../../src/collector/core/control.mjs'


// ---- W26 (the 4.8 mechanism, 4.9 §7): the control plane ----------------------------------------------------------------------------------------

test('W26 the socket name is trocar- + 16 random hex digits + .sock under the user\'s tmp directory, the token is 64; two installs get different ones; control.json is made once, read back, and is 0600 — a real permission on darwin', () => {
  const a = tmpDir('trocar-ctl-'); const b = tmpDir('trocar-ctl-'); const ta = tmpDir('trocar-tmp-'); const tb = tmpDir('trocar-tmp-')
  const ea = controlEndpoint({ dir: a, tmp: ta }); const eb = controlEndpoint({ dir: b, tmp: tb })
  assert.match(path.basename(ea.path), /^trocar-[0-9a-f]{16}\.sock$/)
  assert.ok(ea.path.startsWith(path.join(ta, SOCKET_PREFIX)))
  assert.equal(path.dirname(ea.path), ta, 'directly under the tmp directory, no subdirectory of it')
  assert.equal(path.basename(ea.path).endsWith(SOCKET_SUFFIX), true)
  assert.match(ea.token, /^[0-9a-f]{64}$/)
  assert.notEqual(ea.path, eb.path, 'two installs, two names')
  assert.notEqual(ea.token, eb.token)
  assert.deepEqual(controlEndpoint({ dir: a, tmp: ta }), ea, 'created once: the second call reads what the first wrote')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, CONTROL_FILE), 'utf8')), ea, 'control.json holds exactly the socket path and the token')
  assert.deepEqual(readControlEndpoint({ dir: a, tmp: ta }), ea, 'the reader (the CLI) gets the same')
  assert.equal(fs.statSync(path.join(a, CONTROL_FILE)).mode & 0o777, 0o600, '0600 is a real permission on darwin (4.9 §7), not the inert metadata it is on Windows')
  assert.deepEqual(fs.readdirSync(a), [CONTROL_FILE], 'no temp file is left beside it')
})

test('W26 a reader that finds no control.json says so and writes nothing; a control.json that is not an endpoint is replaced by the writer and is an error to the reader', () => {
  const d = tmpDir('trocar-ctl-'); const t = tmpDir('trocar-tmp-')
  assert.equal(readControlEndpoint({ dir: d, tmp: t }), null, 'absent is null, not an error')
  assert.deepEqual(fs.readdirSync(d), [], 'a reader never creates it')
  for (const bad of ['', '{', '[]', JSON.stringify({ path: path.join(t, 'other.sock'), token: 'x'.repeat(64) }), JSON.stringify({ path: path.join(t, `${SOCKET_PREFIX}0123456789abcdef${SOCKET_SUFFIX}`), token: 'short' }), JSON.stringify({ path: `/tmp/${SOCKET_PREFIX}0123456789abcdef${SOCKET_SUFFIX}`, token: 'f'.repeat(64) })]) {
    fs.writeFileSync(path.join(d, CONTROL_FILE), bad)
    const r = readControlEndpoint({ dir: d, tmp: t })
    assert.ok(r && typeof r.error === 'string' && r.error.length > 0, `the reader names the problem for ${JSON.stringify(bad)}`)
    const e = controlEndpoint({ dir: d, tmp: t })
    assert.match(path.basename(e.path), /^trocar-[0-9a-f]{16}\.sock$/, 'the writer makes a good one')
    assert.deepEqual(readControlEndpoint({ dir: d, tmp: t }), e)
  }
})

test('W26 a control.json that is not JSON is reported without any of its text: the parser\'s message quotes the characters around the error, and a damaged file may have the token in them', () => {
  const d = tmpDir('trocar-ctl-'); const t = tmpDir('trocar-tmp-')
  const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
  for (const damaged of [`{"path":"${path.join(t, `${SOCKET_PREFIX}0123456789abcdef${SOCKET_SUFFIX}`)}","token":${secret}}`, `{"token":"${secret}" "x"}`, `${secret}`, `{"token":"${secret.slice(0, 30)}`]) {
    fs.writeFileSync(path.join(d, CONTROL_FILE), damaged)
    const r = readControlEndpoint({ dir: d, tmp: t })
    assert.deepEqual(r, { error: 'control.json is not JSON' }, 'one fixed sentence')
    assert.ok(!JSON.stringify(r).includes('a1b2c3'), 'no digit of the file in what a CLI prints')
  }
})

test('W26 two starts at the same moment end up with one endpoint: the one that linked first wins and the other reads it; a file system that cannot link still gets its file', () => {
  const d = tmpDir('trocar-ctl-'); const t = tmpDir('trocar-tmp-')
  const winner = { path: path.join(t, `${SOCKET_PREFIX}aaaaaaaaaaaaaaaa${SOCKET_SUFFIX}`), token: 'b'.repeat(64) }
  const racing = { ...fs, linkSync: (from, to) => { fs.writeFileSync(to, `${JSON.stringify(winner)}\n`); throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }) } }
  assert.deepEqual(controlEndpoint({ dir: d, tmp: t, fs: racing }), winner, 'the loser returns what the winner wrote')
  assert.deepEqual(readControlEndpoint({ dir: d, tmp: t }), winner)
  assert.deepEqual(fs.readdirSync(d), [CONTROL_FILE], 'and leaves no temp file')
  const e = tmpDir('trocar-ctl-'); const te = tmpDir('trocar-tmp-')
  const noLinks = { ...fs, linkSync: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) } }
  const made = controlEndpoint({ dir: e, tmp: te, fs: noLinks })
  assert.deepEqual(readControlEndpoint({ dir: e, tmp: te }), made)
  assert.deepEqual(fs.readdirSync(e), [CONTROL_FILE])
})

test('W26 the names come from the injected random source, 8 bytes for the socket name and 32 for the token, and the socket path is the tmp directory\'s own child', () => {
  const asked = []
  const t = tmpDir('trocar-tmp-')
  const e = controlEndpoint({ dir: tmpDir('trocar-ctl-'), tmp: t, randomBytes: (n) => { asked.push(n); return Buffer.alloc(n, asked.length) } })
  assert.deepEqual(asked, [8, 32])
  assert.equal(e.path, path.join(t, `${SOCKET_PREFIX}0101010101010101${SOCKET_SUFFIX}`))
  assert.equal(e.token, '02'.repeat(32))
})

/** One request to a control server on a unix socket, with the headers given; → { status, body }. (The client of `trocar off` is the CLI's; this is the least a test needs.) */
const call = (socketPath, headers = {}, p = '/status') => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method: 'GET', path: p, headers }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
  })
  req.on('error', reject)
  req.end()
})

test('W26 a request without the token is refused and never reaches a route; a wrong one too; the right one is answered — the token is checked first, on the unix socket as on the pipe', async () => {
  const dir = tmpDir('as-')
  // the socket goes directly under the user's tmp directory — the product's own shape (4.9 §7), and the only one that fits darwin's 104-byte sun_path:
  // a deeper test-only nest leaks the guard's trocar-run-<run> level into the path, macOS bind() silently truncates the name, and the server's chmod misses (ENOENT)
  const { path: socketPath, token } = controlEndpoint({ dir })
  const reached = []
  const srv = await startControlServer({ socketPath, token, routes: { 'GET /status': async () => { reached.push('status'); return { ok: 1 } }, 'POST /off': async () => { reached.push('off'); return {} } } })
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
    assert.equal(CONTROL_TOKEN_HEADER, 'x-trocar-token')
  } finally { await srv.close() }
})

test('W26 the unix socket the daemon serves is 0600 where the mode is real (darwin, 4.9 §7), its directory 0700 when the server has to make it, and a token too short to be a secret is a bug of the caller, not a server that checks nothing', async () => {
  const dir = tmpDir('as-')
  const socketPath = path.join(dir, 'sub', 'c.sock') // `sub` does not exist: the server makes it (0700)
  const srv = await startControlServer({ socketPath, routes: { 'GET /status': async () => ({ unix: true }) } })
  try {
    assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, 'the socket itself, next to control.json\'s 0600')
    assert.equal(fs.existsSync(socketPath), true)
  } finally { await srv.close() }
  assert.equal(fs.existsSync(socketPath), false, 'the socket goes with the server; control.json names a path, it does not own one')
  await assert.rejects(startControlServer({ socketPath, token: 'short', routes: {} }), /token/i)
})

test('W26 a second server on a live endpoint is refused, and the first one is not harmed', async () => {
  const dir = tmpDir('as-')
  // directly under the user's tmp directory like the product's own daemon (see the token test above: darwin's sun_path is 104 bytes)
  const { path: socketPath, token } = controlEndpoint({ dir })
  const a = await startControlServer({ socketPath, token, routes: { 'GET /status': async () => ({ who: 'a' }) } })
  try {
    await assert.rejects(startControlServer({ socketPath, token, routes: {} }), /another collector daemon/)
    assert.deepEqual(await call(socketPath, { [CONTROL_TOKEN_HEADER]: token }), { status: 200, body: { who: 'a' } })
    assert.ok(fs.existsSync(socketPath), 'the refused one did not remove the first one\'s endpoint')
  } finally { await a.close() }
})


// ---- W25 (the 4.8 rule under the darwin name, 4.9 §7 · §12): refuse root ------------------------------------------------------------------------

test('W25 root is refused by the daemon\'s check with the closed-set code root-token, and a plain user is not (the darwin name of win32\'s elevated-token)', async () => {
  const cases = [
    ['uid 0 (sudo)', { getuid: () => 0, geteuid: () => 0 }, true],
    ['euid 0 alone (a setuid binary)', { getuid: () => 501, geteuid: () => 0 }, true],
    ['the user of a Mac (uid 501)', { getuid: () => 501, geteuid: () => 501 }, false],
    ['a platform without getuid (a test on Windows): neither is 0, not refused — that platform\'s own check is the win32 helper\'s', { getuid: () => -1, geteuid: () => -1 }, false],
  ]
  for (const [what, w, refused] of cases) {
    const r = await refuseElevated(w)
    if (!refused) { assert.equal(r, null, what); continue }
    assert.equal(r.code, 'root-token', what)
    assert.match(r.reason, /R7/, 'the reason names the rule')
    assert.match(r.reason, /sudo/, '... and says what not to do')
    assert.deepEqual(r.token, { uid: w.getuid(), euid: w.geteuid() }, 'what it saw')
    assert.deepEqual(checkRecord({ event: 'failure', where: 'start', code: r.code, reason: r.reason }), [], 'a failure record the closed set takes')
  }
})

test('W25 off and uninstall (no source tree, no helper): the standalone check of src/off/darwin.mjs refuses the same root with the same code — nothing is asked of any tool, the uid is this process\'s own', async () => {
  assert.equal(offDarwin.refuseElevatedByUid({ getuid: () => 501, geteuid: () => 501 }), null)
  for (const w of [{ getuid: () => 0, geteuid: () => 0 }, { getuid: () => 501, geteuid: () => 0 }]) {
    const r = offDarwin.refuseElevatedByUid(w)
    assert.equal(r.code, 'root-token')
    assert.match(r.reason, /not as root/) // human text names no spec rule (D58)
    assert.deepEqual(checkRecord({ event: 'failure', where: 'start', code: r.code, reason: r.reason }), [])
  }
  // the same refusal the arch module gives on and daemon: one rule, two homes (src/off cannot import it, 0.1 §2)
  const archR = await refuseElevated({ getuid: () => 0, geteuid: () => 0 })
  assert.equal(offDarwin.refuseElevatedByUid({ getuid: () => 0, geteuid: () => 0 }).code, archR.code)
})


// ---- the Node preflight (4.8 §7) ----------------------------------------------------------------------------------------------------------------

test('W24 `on` on darwin refuses a Node below 22.15 (4.9 §7, MA5: a root added in the keychain is only in getCACertificates(\'system\')) with a doctor line that says what was found and what is needed; package.json engines stays the floor Linux / Windows keep', () => {
  const NODE_MIN = '22.15' // 4.9 §7's number, asserted against the answer's own `min` below
  assert.equal(nodePreflight({ versions: { node: '24.0.0' } }).min, NODE_MIN)
  const engines = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).engines.node
  assert.equal(engines, '>=20', 'engines unchanged: Linux and Windows still accept 20 (the win32 test holds its preflight to it)')
  for (const v of ['22.15.0', '22.23.1', '23.0.0', '24.1.0']) assert.deepEqual(nodePreflight({ versions: { node: v } }), { ok: true, have: v, min: NODE_MIN }, v)
  for (const v of ['22.14.0', '22.0.0', '20.19.5', '20.0.0', '18.20.4', '16.0.0']) {
    const r = nodePreflight({ versions: { node: v } })
    assert.equal(r.ok, false, v)
    assert.equal(r.have, v)
    assert.match(r.doctor, new RegExp(v.replaceAll('.', '\\.')), 'the doctor line names the version found')
    assert.match(r.doctor, new RegExp(NODE_MIN.replaceAll('.', '\\.')), '... and the one needed')
    assert.match(r.doctor, /launchd/, '... and who starts the daemon with it')
  }
  assert.equal(nodePreflight({ versions: { node: '22.15.0' } }).ok, true)
  for (const v of [undefined, '', 'twenty', null, '22']) {
    const r = nodePreflight({ versions: { node: v } })
    assert.equal(r.ok, false, `an unreadable version (${JSON.stringify(v)}) is not a pass`)
    assert.match(r.doctor, /Node/)
  }
})


// ---- W24 (the 4.8 shape under launchd, 4.9 §4): the LaunchAgent ---------------------------------------------------------------------------------

const NODE = '/usr/local/bin/node'
const SCRIPT = '/Users/ada/.npm-global/lib/node_modules/trocar/bin/trocar.mjs'
const plist = () => plistXml({ node: NODE, trocar: SCRIPT })
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

test('W24 the plist has the fields of 4.9 §4: Label com.trocar.collector, ProgramArguments = node <trocar> daemon (no --supervise: launchd\'s KeepAlive is the restart), RunAtLoad and KeepAlive both true', () => {
  const x = plist()
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'a plain UTF-8 plist (launchctl reads it as it declares; there is no Windows code-page dance to make a copy of)')
  assert.match(x, /^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">$/m)
  assert.ok(balanced(x), 'every element is closed')
  assert.match(x, /<plist version="1\.0">/)
  assert.match(x, /<key>Label<\/key>\s*<string>com\.trocar\.collector<\/string>/)
  assert.deepEqual([...inner(x, 'array').matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]), [NODE, SCRIPT, 'daemon'], 'node <trocar> daemon, and nothing more')
  assert.doesNotMatch(x, /--supervise/, 'the supervisor flag went with the supervisor parent (4.9 §4)')
  assert.match(x, /<key>RunAtLoad<\/key>\s*<true\/>/, 'launchd starts the daemon at every login')
  assert.match(x, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/, 'launchd brings a crashed daemon back (no supervisor), but not one that drained after off and exited 0')
  // D62 ⑥: trocar writes NO ThrottleInterval. Under KeepAlive {SuccessfulExit: false} a smaller throttle is the respawn interval of a daemon that
  // crashes at start (every second = 15-25 % of a core, against about 2 % at launchd's 10 s default), and no `on` needs it any more: an `off` with no
  // names leaves the daemon running, so `on` asks the one that is there instead of having launchd spawn one.
  assert.doesNotMatch(x, /ThrottleInterval/, 'launchd\'s own throttle is what bounds a crash loop: trocar does not shorten it (D62 ⑥)')
  assert.doesNotMatch(x, /EnvironmentVariables/, 'no environment needed: the daemon\'s env is empty unless install says otherwise')
  const withEnv = plistXml({ node: NODE, trocar: SCRIPT, env: { NODE_EXTRA_CA_CERTS: '/usr/local/etc/corp-ca.pem' } })
  assert.ok(balanced(withEnv))
  assert.match(withEnv, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>NODE_EXTRA_CA_CERTS<\/key>\s*<string>\/usr\/local\/etc\/corp-ca\.pem<\/string>\s*<\/dict>/, 'what install decides the daemon needs is carried (the linux unit\'s Environment=; a launchd job starts with none of the shell\'s exports)')
  assert.equal(plistPath('/h'), path.join('/h', 'Library', 'LaunchAgents', 'com.trocar.collector.plist'))
  assert.equal(PLIST_FILE, 'com.trocar.collector.plist')
  assert.equal(AGENT_LABEL, 'com.trocar.collector')
})

test('W24 what goes into the plist is escaped or refused: & < > are escaped, a control character, a non-string or a bad env key is a bug of the caller (a quote in a path is harmless plist element content, unlike the Windows command line)', () => {
  const x = plistXml({ node: '/opt/R&D/bin/node', trocar: '/Users/ada/a>b/trocar.mjs' })
  assert.ok(balanced(x))
  assert.deepEqual([...inner(x, 'array').matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]), ['/opt/R&amp;D/bin/node', '/Users/ada/a&gt;b/trocar.mjs', 'daemon'])
  assert.match(plistXml({ node: NODE, trocar: '/Users/张三/.npm-global/lib/node_modules/trocar/bin/trocar.mjs' }), /张三/, 'a profile path in Chinese is carried as it is: UTF-8 holds it')
  assert.equal(plistXml({ node: '/opt/"node"', trocar: SCRIPT }).includes('"node"'), true, 'a quote is not escaped and not refused here')
  for (const bad of [{ node: '/no\u0007de' }, { trocar: '' }, { node: undefined }, { env: 'x' }, { env: null }, { env: { 'not a name': 'v' } }, { env: { K: 5 } }]) {
    assert.throws(() => plistXml({ node: NODE, trocar: SCRIPT, ...bad }), TypeError, JSON.stringify(bad))
  }
})


// ---- W24: the unit's verbs ----------------------------------------------------------------------------------------------------------------------

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
const withHome = (over = {}) => { const home = tmpDir('trocar-unit-'); return { home, node: NODE, script: SCRIPT, env: { HOME: home, USER: 'ada' }, ...over } }
/** What `trocar on` does before it enables: writes the unit's text where the unit says it lives. */
const installed = (u) => { fs.mkdirSync(path.dirname(u.path), { recursive: true }); fs.writeFileSync(u.path, u.text({})); return u }

test('W24 userUnit gives the shape turnOn and install consume: the plist\'s path under ~/Library/LaunchAgents (launchd scans it at every login), no links, the text, and the verbs enable / start / reload / disable / remove', () => {
  const o = withHome()
  const u = userUnit({ ...o, run: fakeTools(), uid: 501 })
  assert.equal(u.path, path.join(o.home, 'Library', 'LaunchAgents', PLIST_FILE))
  assert.deepEqual(u.links, [], 'a LaunchAgent has no wants/ link — the file in LaunchAgents is the whole registration')
  assert.equal(u.name, 'com.trocar.collector')
  const sinks = daemonLogPaths(o.home)
  assert.equal(u.text({}), plistXml({ node: NODE, trocar: SCRIPT, logs: sinks }), 'the text is the plist; an empty daemon env is no EnvironmentVariables key')
  assert.match(u.text({}), new RegExp('<key>StandardOutPath</key>\n  <string>' + sinks.out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</string>'), 'D46: the daemon console is the log file under ~/.trocar/collector/logs')
  assert.match(u.text({}), new RegExp('<key>StandardErrorPath</key>\n  <string>' + sinks.err.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</string>'))
  assert.notEqual(u.text({ NODE_EXTRA_CA_CERTS: '/usr/local/etc/corp-ca.pem' }), plist(), 'the daemon env install offers is carried (unlike the win32 task, 4.8 §7)')
  for (const verb of ['enable', 'start', 'startNow', 'reload', 'remove']) assert.equal(typeof u[verb], 'function', verb) // D61: no `disable` verb — nothing in an off touches the registration
  assert.deepEqual(u.reload(), { code: 0, out: '', err: '' }, 'a rewritten plist is replaced by the next enable (bootout + bootstrap), so there is nothing to reload')
})

// D62 ⑥ (a review's find): `launchctl kickstart` does not return until launchd spawned the job, and launchd spawns one at most once every
// ThrottleInterval seconds — 10 s by default, which is exactly execTool's default deadline. A kickstart right after a respawn would then
// time out, be reported as "the collector could not be started through the LaunchAgent" and send `on` down the direct-start path (D38:
// never a wrong reason). The deadline must be ABOVE launchd's throttle.
test('W24 startNow gives the kickstart a deadline above launchd\'s own respawn throttle, so a throttled wait is not misread as a refusal', () => {
  const seen = []
  const run = (file, args, opts) => { seen.push({ file, args, timeout: opts && opts.timeout }); return { status: 0, stdout: '', stderr: '' } }
  const u = installed(userUnit({ ...withHome(), run, uid: 501 }))
  assert.deepEqual(u.startNow(), { code: 0, out: '', err: '' })
  assert.deepEqual(seen.map((c) => [c.file, ...c.args]), [['launchctl', 'kickstart', 'gui/501/com.trocar.collector']])
  assert.equal(seen[0].timeout, KICKSTART_TIMEOUT_MS, 'the kickstart carries its own deadline, not execTool\'s default')
  assert.ok(KICKSTART_TIMEOUT_MS > LAUNCHD_THROTTLE_SECONDS * 1000, `${KICKSTART_TIMEOUT_MS} ms must exceed launchd's ${LAUNCHD_THROTTLE_SECONDS} s throttle`)
})

test('W24 enable bootstraps the job into the user\'s GUI session domain (gui/<uid>) from the plist install wrote — after a best-effort bootout of an earlier copy, the win32 /Create /F analog — and now is the default', () => {
  const run = fakeTools()
  const u = installed(userUnit({ ...withHome(), run, uid: 501 }))
  assert.deepEqual(u.enable({ now: true }), { code: 0, out: '', err: '' })
  assert.deepEqual(run.calls, [['launchctl', 'enable', 'gui/501/com.trocar.collector'], ['launchctl', 'bootout', 'gui/501/com.trocar.collector'], ['launchctl', 'bootstrap', 'gui/501', u.path]], 'off disabled the job, so on enables it before the bootstrap')
  assert.deepEqual(u.enable(), { code: 0, out: '', err: '' }, 'now is the default')
  assert.equal(run.calls.filter((c) => c[1] === 'bootstrap').length, 2)
  // a bootout that answers "no such job" (a fresh install) is not a failure: the bootstrap below is the answer
  const fresh = fakeTools({ 'launchctl bootout': { status: 36, stderr: 'Boot-out failed: 36: No such process' } })
  assert.deepEqual(installed(userUnit({ ...withHome(), run: fresh, uid: 501 })).enable(), { code: 0, out: '', err: '' })
})

test('W24 enable({ now: false }) (a daemon already answers) asks launchctl nothing: the plist in ~/Library/LaunchAgents is what launchd loads at the next login, and a bootstrap would start a second daemon beside the one that answers (拉起不是重启, R8)', () => {
  const run = fakeTools()
  const u = installed(userUnit({ ...withHome(), run, uid: 501 }))
  assert.deepEqual(u.enable({ now: false }), { code: 0, out: '', err: '' })
  assert.deepEqual(run.calls, [['launchctl', 'enable', 'gui/501/com.trocar.collector']], 'only enable (a job off disabled is not loaded at the next login): the daemon that answers is not started a second time')
})

test('W24 enable says why it failed, with the launchd-register-failed record (launchd is the only autostart, so on\'s receipt says it; no fallback exists to succeed through, 4.9 §12)', () => {
  const refused = fakeTools({ 'launchctl bootstrap': { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' } })
  const a = installed(userUnit({ ...withHome(), run: refused, uid: 501 })).enable()
  assert.equal(a.code, 5)
  assert.match(a.err, /Input\/output error/)
  assert.deepEqual(a.event, { event: 'failure', where: 'install', code: 'launchd-register-failed', reason: a.event.reason })
  assert.match(a.event.reason, /bootstrap/)
  assert.match(a.event.reason, /only autostart/)
  assert.deepEqual(checkRecord(a.event), [], 'a record of the closed set')
  const notRun = fakeTools({ 'launchctl bootstrap': { status: null, error: Object.assign(new Error('spawnSync launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' }) } })
  const b = installed(userUnit({ ...withHome(), run: notRun, uid: 501 })).enable()
  assert.equal(b.code, 1, 'a tool that did not run is code 1, a failure a caller\'s `if (r.code)` sees')
  assert.match(b.err, /ETIMEDOUT/)
  assert.match(b.event.reason, /did not run/)
  assert.deepEqual(checkRecord(b.event), [])
  const none = fakeTools()
  const c = userUnit({ ...withHome(), run: none, uid: 501 }).enable()
  assert.equal(c.code, null)
  assert.match(c.err, /plist/)
  assert.equal(c.precondition, true, 'install writes the file first: launchctl was not asked, so it is not a refusal of it')
  assert.deepEqual(none.calls, [], 'no launchctl without a file to bootstrap')
})

test('W24 start (the direct start `on` falls back to: this session, nothing at login) starts the daemon itself without registering anything: detached, no window, no supervisor flag, and a spawn that did not start is a failure, not a success', () => {
  const o = withHome()
  const run = fakeTools()
  const spawned = []
  const fakeSpawn = (cmd, args, opts) => { const child = { pid: 321, unrefd: false, unref() { this.unrefd = true }, on() {} }; spawned.push({ cmd, args, opts, child }); return child }
  const u = userUnit({ ...o, run, spawn: fakeSpawn, uid: 501 })
  assert.deepEqual(u.start(), { code: 0, out: '', err: '', via: 'direct', pid: 321 })
  assert.deepEqual(run.calls, [], 'no launchctl: a LaunchAgent with RunAtLoad would be an autostart')
  assert.equal(spawned.length, 1)
  assert.deepEqual([spawned[0].cmd, spawned[0].args], [NODE, [SCRIPT, 'daemon']], 'node <trocar> daemon, no --supervise (there is no supervisor parent to run it, 4.9 §4)')
  assert.equal(spawned[0].opts.detached, true)
  assert.equal(spawned[0].child.unrefd, true, 'the daemon is not tied to the process that started it: this one can exit')
  const dead = userUnit({ ...o, run, spawn: () => ({ pid: undefined, unref() {}, on() {} }) }).start()
  assert.equal(dead.code, null)
  assert.match(dead.err, /did not start/)
  const thrown = userUnit({ ...o, run, spawn: () => { throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) } }).start()
  assert.equal(thrown.code, null)
  assert.match(thrown.err, /ENOENT/)
})

test('W24 a daemon started directly (start()) gets the environment a login-started daemon would have, not the installer shell\'s trust and proxy variables: the same daemon however it was started', () => {
  const shell = { PATH: '/usr/bin:/bin', HOME: '/Users/ada', USER: 'ada', LOGNAME: 'ada', SHELL: '/bin/zsh', TMPDIR: '/var/folders/xx/T/', CODEX_HOME: '/Users/ada/.codex', NODE_EXTRA_CA_CERTS: '/usr/local/etc/corp/ca.pem', NODE_OPTIONS: '--use-system-ca', NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0', SSL_CERT_FILE: '/usr/local/etc/x.pem', SSL_CERT_DIR: '/usr/local/etc/certs', HTTPS_PROXY: 'http://u:p@127.0.0.1:3128', http_proxy: 'http://127.0.0.1:3128', ALL_PROXY: 'socks5://127.0.0.1:1080', no_proxy: 'localhost', Https_Proxy: 'x', WS_PROXY: 'y', wss_proxy: 'z', FTP_PROXY: 'f' }
  const kept = { PATH: shell.PATH, HOME: shell.HOME, USER: shell.USER, LOGNAME: shell.LOGNAME, SHELL: shell.SHELL, TMPDIR: shell.TMPDIR, CODEX_HOME: shell.CODEX_HOME }
  assert.deepEqual(directStartEnv(shell), kept, 'the trust and proxy ones are not carried, whatever the case of their names (the lowercase spellings are as meaningful as the uppercase ones on darwin); TMPDIR stays — the daemon\'s control socket lives under it')
  assert.ok(Object.keys(shell).includes('NODE_EXTRA_CA_CERTS'), 'the caller\'s environment is not changed')
  assert.deepEqual(directStartEnv({}), {})
  const spawned = []
  const fakeSpawn = (cmd, args, opts) => { spawned.push(opts); return { pid: 5, unref() {}, on() {} } }
  assert.equal(userUnit({ ...withHome({ env: shell }), run: fakeTools(), spawn: fakeSpawn, uid: 501 }).start().code, 0)
  assert.deepEqual(spawned[0].env, kept, 'start()')
  assert.equal(spawned[0].detached, true, 'the rest of the spawn is as before')
})

test('W24 remove (an uninstall) is the undo: the agent is booted out and the plist leaves ~/Library/LaunchAgents — the file IS the registration, there is no wants/-link to split off (the linux unit\'s file stays, 4.6; darwin\'s cannot)', () => {
  const present = fakeTools({ 'launchctl print': { status: 0, stdout: 'com.trocar.collector = {"state": "running", "pid": 4242}' } })
  const u = installed(userUnit({ ...withHome(), run: present, uid: 501 }))
  assert.deepEqual(u.remove(), { code: 0, out: '', err: '', agent: 'booted-out', plist: 'removed' })
  assert.deepEqual(present.calls, [['launchctl', 'print', 'gui/501/com.trocar.collector'], ['launchctl', 'bootout', 'gui/501/com.trocar.collector']])
  assert.ok(!fs.existsSync(u.path), 'the plist is gone: the next login has nothing to load')
  const again = fakeTools({ 'launchctl print': { status: 0, stdout: '' } })
  const u2 = installed(userUnit({ ...withHome(), run: again, uid: 501 }))
  assert.deepEqual(u2.remove(), { code: 0, out: '', err: '', agent: 'booted-out', plist: 'removed' }, 'remove makes the same calls as disable')
  assert.deepEqual(again.calls, [['launchctl', 'print', 'gui/501/com.trocar.collector'], ['launchctl', 'bootout', 'gui/501/com.trocar.collector']])
})

test('W24 an agent that is not loaded is already as asked, not an error — and the plist still leaves, or the next login would load it; a print that did not run is a failure for the launchd half, never "absent", and the file still goes (a separate part of the undo)', () => {
  const gone = fakeTools({ 'launchctl print': { status: 113, stderr: 'Could not find service "com.trocar.collector" in domain for gui/501' } })
  const u = installed(userUnit({ ...withHome(), run: gone, uid: 501 }))
  assert.deepEqual(u.remove(), { code: 0, out: '', err: '', agent: 'absent', plist: 'removed' })
  assert.deepEqual(gone.calls.map((c) => c[1]), ['print'], 'nothing is booted out on a guess')
  const didNot = [
    ['timed out', { status: null, error: Object.assign(new Error('spawnSync launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' }) }],
    ['could not start', { status: null, error: Object.assign(new Error('spawn launchctl ENOENT'), { code: 'ENOENT' }) }],
    ['killed without a reason', { status: null }],
  ]
  for (const [what, print] of didNot) {
    for (const verb of ['remove']) {
      const base = fakeTools()
      const asked = (file, args) => (file === 'launchctl' && args[0] === 'print' ? { stdout: '', stderr: '', ...print } : null)
      const calls = []
      const uu = installed(userUnit({ ...withHome(), run: (file, args, opts) => { calls.push([file, ...args]); return asked(file, args) || base(file, args, opts) }, uid: 501 }))
      const r = uu[verb]()
      assert.equal(r.agent, 'failed', `${verb}, ${what}: the agent is not reported absent — launchd may still hold it`)
      assert.equal(typeof r.code, 'number', `${verb}, ${what}: a code a caller's \`if (r.code)\` sees`)
      assert.notEqual(r.code, 0, `${verb}, ${what}`)
      assert.match(r.err, /print/, `${verb}, ${what}: it says which call did not run`)
      assert.deepEqual(calls.map((c) => c[1]), ['print'], `${verb}, ${what}: nothing is booted out on a guess`)
      assert.equal(r.plist, 'removed', `${verb}, ${what}: the plist is a separate part of the undo and still goes — its removal only prevents the next login's load`)
      assert.ok(!fs.existsSync(uu.path))
    }
  }
  const nothing = fakeTools({ 'launchctl print': { status: 113, stderr: 'Could not find service' } })
  const bare = userUnit({ ...withHome(), run: nothing, uid: 501 })
  assert.deepEqual(bare.remove(), { code: 0, out: '', err: '', agent: 'absent', plist: 'absent' }, 'nothing there at all: already as asked')
  assert.deepEqual(nothing.calls.map((c) => c[1]), ['print'])
})

test('W24 a bootout that was refused or did not run is a failure with the reason (launchd still holds the daemon), and a plist that cannot be removed is said separately', () => {
  const stuck = fakeTools({ 'launchctl print': { status: 0 }, 'launchctl bootout': { status: 5, stderr: 'Boot-out failed: 5: Input/output error' } })
  const u = installed(userUnit({ ...withHome(), run: stuck, uid: 501 }))
  assert.deepEqual(u.remove(), { code: 5, out: '', err: 'Boot-out failed: 5: Input/output error', agent: 'failed', plist: 'removed' }, 'the tool\'s own exit code is the answer (the win32 settle\'s rule); a caller\'s `if (r.code)` sees it')
  const lost = fakeTools({ 'launchctl print': { status: 0 }, 'launchctl bootout': { status: null, error: Object.assign(new Error('spawnSync launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' }) } })
  const u2 = installed(userUnit({ ...withHome(), run: lost, uid: 501 }))
  const f = u2.remove()
  assert.deepEqual([f.code, f.agent, f.plist], [1, 'failed', 'removed'], 'a tool that did not run is a failure a caller\'s `if (r.code)` sees')
  assert.match(f.err, /ETIMEDOUT/)
  const o = withHome()
  const refusing = { ...fs, rmSync: (p, opts) => { if (p === plistPath(o.home)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.rmSync(p, opts) } }
  const u3 = installed(userUnit({ ...o, run: fakeTools({ 'launchctl print': { status: 0 } }), fs: refusing, uid: 501 }))
  const g = u3.remove()
  assert.deepEqual([g.code, g.agent, g.plist], [1, 'booted-out', 'failed'])
  assert.match(g.err, /EACCES|plist/)
})

test('the off order (4.9 §4, MA2\'s clause) is the undo\'s own sequence: print, then bootout — the autostart off the hook — and only then the plist\'s removal; the verb returns only after launchd has answered, and its answer says whether the daemon is still held (the caller stops the daemon AFTER this, never before: a process stopped while the agent is loaded is pulled right back by KeepAlive)', () => {
  const order = []
  const run = (file, args) => { order.push(args[0]); return { status: 0, stdout: '', stderr: '' } }
  const hookFs = { ...fs, rmSync: (p, opts) => { order.push(`rm ${path.basename(p)}`); return fs.rmSync(p, opts) } }
  const u = installed(userUnit({ ...withHome(), run, fs: hookFs, uid: 501 }))
  assert.deepEqual(u.remove(), { code: 0, out: '', err: '', agent: 'booted-out', plist: 'removed' })
  assert.deepEqual(order, ['print', 'bootout', `rm ${PLIST_FILE}`], 'bootout before the file, both before the caller\'s stop')
  const held = fakeTools({ 'launchctl print': { status: 0 }, 'launchctl bootout': { status: 5, stderr: 'Boot-out failed: 5: Input/output error' } })
  const r = installed(userUnit({ ...withHome(), run: held, uid: 501 })).remove()
  assert.equal(r.agent, 'failed', 'the caller is told launchd still holds the daemon: it must not count the autostart off')
  assert.notEqual(r.code, 0)
})


// ---- the standalone undo of src/off/darwin.mjs (the real version of the win32 side\'s W24 Task 9(b) todo) ---------------------------------------

test('src/off keeps its own copy of the agent label and the plist path, equal to arch/darwin/autostart.mjs — the linux shape (test/off/autostart.test.mjs holds unit.mjs equal the same way)', () => {
  assert.equal(offDarwin.AGENT_LABEL, AGENT_LABEL)
  assert.equal(offDarwin.PLIST_FILE_NAME, PLIST_FILE)
  assert.equal(offDarwin.plistFilePath('/h'), plistPath('/h'))
  assert.equal(offDarwin.plistFilePath('/h'), '/h/Library/LaunchAgents/com.trocar.collector.plist')
})

test('the standalone undo (undoAutostart) is the same undo the arch module\'s disable and remove are: the same launchctl calls in the same order, the same answers — for an agent that is loaded, one that is not, one that cannot be asked, and one whose bootout was refused', () => {
  const worlds = {
    'the agent is loaded': { 'launchctl print': { status: 0, stdout: 'com.trocar.collector = {"pid": 4242}' }, 'launchctl bootout': { status: 0 } },
    'the agent is not loaded': { 'launchctl print': { status: 113, stderr: 'Could not find service "com.trocar.collector" in domain for gui/501' } },
    'launchctl print did not run': { 'launchctl print': { status: null, error: Object.assign(new Error('spawnSync launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' }) } },
    'the bootout was refused': { 'launchctl print': { status: 0 }, 'launchctl bootout': { status: 5, stderr: 'Boot-out failed: 5: Input/output error' } },
  }
  for (const [what, answers] of Object.entries(worlds)) {
    for (const verb of ['remove']) {
      const archRun = fakeTools(answers)
      const a = installed(userUnit({ ...withHome(), run: archRun, uid: 501 }))[verb]()
      const home = tmpDir('trocar-off-')
      fs.mkdirSync(path.dirname(offDarwin.plistFilePath(home)), { recursive: true })
      fs.writeFileSync(offDarwin.plistFilePath(home), 'plist')
      const offRun = fakeTools(answers)
      const b = offDarwin.undoAutostart({ home, exec: offRun, uid: 501 })
      assert.deepEqual(offRun.calls, archRun.calls, `${what}, ${verb}: the same launchctl calls in the same order`)
      assert.deepEqual(b, a, `${what}, ${verb}: the same answer`)
      assert.ok(!fs.existsSync(offDarwin.plistFilePath(home)), `${what}, ${verb}: the plist is gone`)
    }
  }
  // the same file rules as the arch side: a plist that is not there is already as asked, and one that cannot be removed is said
  const home = tmpDir('trocar-off-')
  const absent = fakeTools({ 'launchctl print': { status: 113, stderr: 'Could not find service' } })
  assert.deepEqual(offDarwin.undoAutostart({ home, exec: absent, uid: 501 }), { code: 0, out: '', err: '', agent: 'absent', plist: 'absent' })
  fs.mkdirSync(path.dirname(offDarwin.plistFilePath(home)), { recursive: true })
  fs.writeFileSync(offDarwin.plistFilePath(home), 'plist')
  const refusing = { ...fs, rmSync: (p, opts) => { if (p === offDarwin.plistFilePath(home)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.rmSync(p, opts) } }
  const g = offDarwin.undoAutostart({ home, exec: fakeTools({ 'launchctl print': { status: 0 } }), fs: refusing, uid: 501 })
  assert.deepEqual([g.code, g.agent, g.plist], [1, 'booted-out', 'failed'])
})
