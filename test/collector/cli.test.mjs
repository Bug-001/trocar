// test/collector/cli.test.mjs — the capture commands over injected daemon / install modules (through the one dispatch, src/cli/main.mjs), and the real bin.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { newManifest, saveManifest } from '../../src/off/manifest.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { fileURLToPath } from 'node:url'
import { runSetupHelper } from '../../src/collector/cli.mjs'
import { formatStatus } from '../../src/cli/status-text.mjs'
import { runCli as runOne } from '../../src/cli/main.mjs'
import { runDaemonCli } from '../../src/cli/daemon.mjs'
import { DAEMON_ALREADY_UP, DAEMON_ENDPOINT_BUSY } from '../../src/collector/core/control.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { osStubs } from '../helpers/os-stubs.mjs' // on a Mac the real bin's status asks launchd and the keychain (read-only): stubs answer, 0.1 §3

const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
const NO_EXEC = () => ({ status: 0, stdout: '', stderr: '' }) // and `ss` / `ip`, which it reads for the topology, find nothing (0.1 §3)
// `trocar daemon` refuses before install and writes nothing (1.6 §5.2), so a test that drives the daemon records an install
// the daemon may start on first (manifest.mjs daemonMayStart: an install record and a root in custody).
const markInstalled = (home) => { const dir = path.join(home, '.trocar', 'collector'); fs.mkdirSync(dir, { recursive: true })
  saveManifest(dir, { ...newManifest(), install: { state: 'complete' }, entries: [{ phase: 'install', kind: 'root-key', what: 'the root in the login keychain' }] }); return dir }
const io = () => { const o = []; const e = []; return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) } }
// The capture commands through the one dispatch (src/cli/main.mjs, 1.6 §2): this test's flat options are its io / uid / deps.
const runCli = (argv, { env = {}, home, platform = 'linux', request, statusDeps = {}, onDeps = {}, offDeps = {},
  daemon, install, proc, exit, script, waitForStop, getuid, out, err } = {}) =>
  runOne(argv, { io: { out, err, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, env, home, platform,
    uid: getuid ? getuid() : 1000,
    deps: { ...(request ? { request } : {}), ...(daemon ? { daemon } : {}), ...(install ? { install } : {}), ...(proc ? { proc } : {}),
      ...(exit ? { exit } : {}), ...(script ? { script } : {}), ...(waitForStop ? { waitForStop } : {}), ...statusDeps, ...onDeps, ...offDeps } })
const STATUS = { desired: 'on', actual: 'on', recording: true, degraded: null, engine: { port: 4711, v6: 4711, decrypted: 2, spliced: 1 }, helper: { pid: 9, proto: 1, ok: true }, running_untrusted: 1,
  agents: [{ pid: 10, agent: 'claude-code', trusted: true, trust_var: 'NODE_EXTRA_CA_CERTS', trust_via: 'user settings env', direct: 0 }, { pid: 11, agent: 'claude-code', trusted: false, reason: 'var-missing', direct: 2 },
    { pid: 12, agent: 'opencode', parent_agent: 'claude-code', trusted: true, trust_var: 'trocar:marker', trust_via: 'plugin marker', not_via_trust_path: [{ host: 'models.dev', reason: 'before-plugin' }], direct: 0 },
    { pid: 14, agent: 'claude-code', trusted: true, trust_var: 'NODE_EXTRA_CA_CERTS', trust_via: 'user settings env', direct: 0, unreachable: [{ transport: 'af-unix', var: 'ANTHROPIC_UNIX_SOCKET' }, { transport: 'quic', var: 'BUN_OPTIONS' }] },
    { pid: 13, agent: 'deepseek-dsh', trusted: false, reason: 'dsh-node-too-old', hint: 'this dsh runs on a Node older than 22.19.0', direct: 1 }],
  unjudged: { count: 3, sample: [{ pid: 20, comm: 'sshd', errno: 'EACCES' }, { pid: 21, comm: '(sd-pam)', errno: 'EACCES' }] } }

test('cli: `collector status` is the one `trocar status` (src/cli/status.mjs: it only ever GETs the control socket; exit 0 / 1 / 3 are R4\'s); `collector off` is the one `trocar off` (src/off/main.mjs): same arguments, same exit code, nothing posted by this file', async () => {
  const calls = []
  const request = async (q) => { calls.push([q.method, q.path, q.socketPath]); return STATUS }
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
  const home = tmpDir('trocar-cli-') // never the operator's own ~/.trocar: status reads the disk too
  const status = { platform: 'linux', statusDeps: { procs: async () => [], exec: NO_EXEC } }
  let t = io(); assert.equal(await runCli(['status'], { env, home, request, ...status, ...t }), 0)
  assert.ok(calls.length >= 1 && calls.every((c) => c[0] === 'GET' && c[1] === '/status' && c[2] === '/run/user/1000/trocar/collector.sock'), '`on` and `off` are not here: they run src/cli/on.mjs and src/off/main.mjs, which plan, confirm and write before they ask the daemon anything; status only reads')
  const named = []
  const t2 = io(); assert.equal(await runCli(['off', '--bogus'], { env, request, platform: 'linux', ...t2 }), 2, 'and its usage errors are `trocar off`\'s: exit 2')
  assert.match(t2.e.join('\n'), /trocar off: unknown option '--bogus'\ntrocar off \[<harness>/)
  assert.match(t.o.join('\n'), /^No harness is set up for capture yet\./, 'nothing installed: the summary says so (§3.5); the engine summary the daemon reports is behind --failures, below')
  const tf = io(); await runCli(['status', '--failures'], { env, home, request, ...status, ...tf })
  assert.match(tf.o.join('\n'), /No problems in the last 24 hours\.\n\nExpected\n/, '\u00a73.5: `--failures` prints the problems of the last 24 hours, folded, then Expected')
  // the daemon's own answer, word for word (D46 R11): every agent it reported, why each is not captured, and the processes it could not judge
  const all = formatStatus(STATUS)
  assert.match(all, /2 decrypted/)
  assert.match(all, /  11 claude-code not captured: var-missing/)
  assert.match(all, /  12 opencode \(started by claude-code\) captured\n    not captured \(it did not read trocar's certificate\): models\.dev \(before-plugin\)/)
  assert.match(all, /  14 claude-code captured\n    not captured \(a transport trocar cannot reach\): af-unix, quic/, 'the agent line lists them (B-4b)')
  assert.match(all, /not judged: 3 process\(es\) of yours whose program could not be read: 20 sshd, 21 \(sd-pam\), \.\.\./, 'said, not silent (B-1)')
  assert.match(all, /  13 deepseek-dsh not captured: dsh-node-too-old - this dsh runs on a Node older than 22\.19\.0/)
  // R4: 3 is for "could not judge", not for "no daemon": with nothing installed and no daemon there is nothing wrong (0); no runtime dir is no usage error either (the lock names the socket when there is one)
  t = io(); assert.equal(await runCli(['status'], { env, home, request: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, ...status, ...t }), 0)
  assert.match(t.o.join('\n'), /^No harness is set up for capture yet\./)
  t = io(); assert.equal(await runCli(['status'], { env: {}, home, request, ...status, ...t }), 0); assert.deepEqual(t.e, [])
  fs.rmSync(home, { recursive: true, force: true })
})

// D-2: whenever no daemon answers — none running, no runtime dir, or one that does not reply — status still reads
// flows/ from disk, and an unreadable flows/ is said instead of looking like "no failures".
test('cli: with no daemon answering (not running, no runtime dir, stuck) status reads the failure records from disk (exit 1: a failure in 24 h); an unreadable flows/ is said, exit 3 (D-2, R4)', async () => {
  const home = tmpDir('trocar-cli-')
  const dir = path.join(home, '.trocar', 'collector')
  try {
    appendEvent(dir, { event: 'failure', where: 'start', code: 'EADDRINUSE', reason: 'the engine port is held by another process' })
    markInstalled(home) // installed
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
    const status = { platform: 'linux', statusDeps: { procs: async () => [], exec: NO_EXEC } }
    let t = io(); assert.equal(await runCli(['status'], { env: {}, home, ...status, ...t }), 1)
    assert.deepEqual(t.e, [], 'no runtime dir is not an error of the caller\'s: there is just no control socket to ask')
    const wall = io(); await runCli(['status', '--failures'], { env: {}, home, ...status, ...wall })
    assert.match(wall.o.join('\n'), /^ {2}just now\s+x1\s+EADDRINUSE the engine port is held by another process$/m, 'the failure read from disk, with its errno head, squashed reason and count (D46)')
    t = io(); assert.equal(await runCli(['status'], { env, home, request: async () => { throw Object.assign(new Error('timed out after 2000 ms'), { code: 'ETIMEDOUT' }) }, ...status, ...t }), 1)
    assert.equal(t.e.length, 0, 'a daemon that does not answer is not an error of the caller\'s; the failure from disk decides the exit')
    fs.rmSync(path.join(dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(dir, 'flows'), 'x')
    t = io(); assert.equal(await runCli(['status'], { env, home, request: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }, ...status, ...t }), 3)
    assert.match(t.o.join('\n').replace(/\s+/g, ' '), /Could not read capture health: .*flows: ENOTDIR/, 'a read that failed is said, never silence (D38)')
    assert.equal(t.e.length, 0, 'no lock: still nothing the caller did wrong')
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: 2 ** 22 + 7, start_time: '1', boot_id: 'b', socket: '/x' })) // a pid nothing runs as
    t = io(); await runCli(['status'], { env, home, request: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, ...status, ...t })
    assert.equal(t.e.length, 0, 'kill -9: read from the lock alone, no error of the caller\'s')
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, socket: '/x' })); const old = new Date(Date.now() - 30_000); fs.utimesSync(path.join(dir, 'lock'), old, old)
    t = io(); await runCli(['status'], { env, home, request: async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, ...status, ...t })
    assert.equal(t.e.length, 0, 'a stuck daemon')
    const health = { generated_at: 'T', summary: { state: 'ok', since: 'T0', read_errors: 1 }, collector: { installed: true, daemon: { state: 'running' }, conditions: [], failures: [], expected: { policy: 3 } }, raw: { problems: [] }, read: { errors: [{ file: '/f', error: 'EACCES' }], truncated: true } }
    assert.match(formatStatus({ ...STATUS, health, events: { lost: 2 } }), /capture health: capturing since T0 - some files could not be read[^\n]*\nnot captured by design \(last 24 hours\): policy 3\ncould not read \/f: EACCES\n\(older records were left out[^\n]*\nevent log: 2 line\(s\) could not be written/)
    assert.match(formatStatus({ ...STATUS, health: { error: 'capture health could not be read: /x/flows: EACCES' } }), /capture health could not be read: \/x\/flows: EACCES/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// D-27 / D-5 / stop exit code: `start` waits for SIGTERM, SIGINT, SIGHUP or SIGQUIT and tells stop() which; a stop
// with a failed step exits 1; an uncaught exception is one `crash` record, then exit 70.
test('cli: start stops on SIGHUP like SIGTERM, passes the signal to stop, exits 1 when a stop step failed, and records a crash (D-5, D-27)', async () => {
  const { EventEmitter } = await import('node:events')
  const home = tmpDir('trocar-cli-start-')
  try {
    const stops = []
    let failed = []
    const daemon = { startDaemon: async (o) => ({ port: 1, socketPath: '/s', foreground: o.foreground, stop: async (x) => { stops.push(x); return { failed } } }) }
    const proc = new EventEmitter()
    // 1.6 §5.2: before install the daemon refuses and writes nothing — not even the collector directory it would log into
    let t = io(); assert.equal(await runCli(['daemon'], { home, env: {}, daemon, proc, exit: () => {}, platform: 'linux', getuid: () => 1000, ...t }), 1, 'no install, no daemon')
    assert.match(t.e.join('\n'), /^trocar daemon: certificates are not installed\. Run: trocar install$/)
    assertEnglish(t.e.join('\n'))
    assert.deepEqual([t.o, stops, fs.existsSync(path.join(home, '.trocar'))], [[], [], false], 'nothing started, nothing written')
    markInstalled(home)
    t = io()
    const running = runCli(['daemon'], { home, env: {}, daemon, proc, exit: () => {}, platform: 'linux', getuid: () => 1000, ...t }) // the real signal wait
    await new Promise((r) => setImmediate(r))
    process.emit('SIGHUP')
    assert.equal(await running, 0)
    assert.deepEqual(t.o, ['trocar collector: engine 127.0.0.1:1, control /s'], 'the readiness line names the endpoints it has, never a null port (§1.1)')
    assertEnglish(t.o.join('\n'))
    assert.deepEqual(stops, [{ signal: 'SIGHUP' }])
    markInstalled(home) // the signal above also ran tmpDir's own SIGHUP cleanup (test/helpers/tmp.mjs), which took this home's tree with it
    failed = ['helper']
    t = io(); assert.equal(await runCli(['daemon'], { home, env: {}, daemon, proc, exit: () => {}, platform: 'linux', getuid: () => 1000, waitForStop: async () => 'SIGTERM', ...t }), 1, 'a stop step failed: non-zero')
    assert.match(t.e.join('\n'), /helper failed while stopping/)
    const exits = []
    t = io(); await runCli(['daemon'], { home, env: {}, daemon, proc: (proc.removeAllListeners(), proc), exit: (c) => exits.push(c), platform: 'linux', getuid: () => 1000, waitForStop: async () => 'SIGTERM', ...t })
    proc.emit('uncaughtException', new TypeError('boom in a timer'))
    assert.deepEqual(exits, [70])
    const f = JSON.parse(fs.readFileSync(path.join(home, '.trocar', 'collector', 'flows', fs.readdirSync(path.join(home, '.trocar', 'collector', 'flows'))[0]), 'utf8').trim())
    assert.deepEqual([f.where, f.code, /TypeError: boom in a timer/.test(f.reason)], ['daemon', 'crash', true])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// `collector start` is `trocar daemon` (1.6 §2 hidden alias; the autostart units written before the rename run it): refused as root and on any argument before the daemon is asked for anything;
// every platform reaches startDaemon the same way now (D39⑥ executed 2026-10-11: the platform gate went with the old capture — a platform without a collector is refused by loadArch itself)
test('cli: `collector start` is `trocar daemon` (src/cli/daemon.mjs): it refuses root and any argument, starts nothing then, and win32 / darwin / freebsd alike reach startDaemon (R4, R7)', async () => {
  const home = tmpDir('trocar-cli-daemon-')
  markInstalled(home) // every run below is meant to get past the install gate (§5.2); that gate is the test above
  const started = []
  const daemon = { startDaemon: async () => { started.push(1); return { port: 1, socketPath: '/s', stop: async () => ({ failed: [] }) } } }
  const run = (verb, o = {}) => { const t = io(); return runCli(verb, { home, env: {}, daemon, proc: { on() {} }, platform: 'linux', getuid: () => 1000, waitForStop: async () => 'SIGTERM', ...o, ...t }).then((exit) => ({ exit, t })) }
  let r = await run(['daemon'], { getuid: () => 0 })
  assert.equal(r.exit, 2); assert.match(r.t.e.join('\n'), /run this as your own user, not as root/) // §1.5: every mutating command, one refusal
  r = await run(['daemon', '--now'])
  assert.equal(r.exit, 2); assert.match(r.t.e.join('\n'), /trocar daemon: unknown option '--now'\ntrocar daemon \[--supervise\]/)
  assert.deepEqual(started, [], 'none of those got as far as the daemon')
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    r = await run(['daemon'], { platform })
    assert.equal(r.exit, 0, `${platform} reaches startDaemon — the platform gate is loadArch's question now, not the CLI's`)
  }
  assert.deepEqual(started, [1, 1, 1])
  r = await run(['daemon'])
  assert.equal(r.exit, 0); assert.match(r.t.o.join('\n'), /^trocar collector: engine 127\.0\.0\.1:1, control \/s$/, 'the readiness line the test rig waits for')
  const t = io(); const direct = await runDaemonCli([], { io: t, home, env: {}, platform: 'linux', deps: { daemon, proc: { on() {} }, getuid: () => 1000, waitForStop: async () => 'SIGTERM' } })
  assert.equal(direct, 0, '`trocar daemon` itself is the same run')
  fs.rmSync(home, { recursive: true, force: true })
})

// 1.6 §1.4 5: after `off` with no names the daemon stops itself once nothing is relayed; `start` then returns 0 without any signal, so the unit exits
// cleanly and systemd does not restart it (Restart=on-failure)
test('cli: start returns when the daemon has stopped itself (off), exit 0, without waiting for a signal; a signal arriving later gets the first stop\'s result', async () => {
  const home = tmpDir('trocar-cli-start-')
  markInstalled(home)
  try {
    let result = { failed: [] }
    const stops = []
    const daemon = { startDaemon: async () => ({ port: 1, socketPath: '/s', exited: Promise.resolve(result), stop: async (x) => { stops.push(x); return result } }) }
    let t = io()
    assert.equal(await runCli(['daemon'], { home, env: {}, daemon, proc: { on() {} }, platform: 'linux', getuid: () => 1000, waitForStop: () => new Promise(() => {}), ...t }), 0, 'no signal ever came')
    assert.deepEqual(stops, [{ signal: null }])
    result = { failed: ['helper'] }
    t = io(); assert.equal(await runCli(['daemon'], { home, env: {}, daemon, proc: { on() {} }, platform: 'linux', getuid: () => 1000, waitForStop: () => new Promise(() => {}), ...t }), 1, 'a step of its own stop failed')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// `--supervise` (4.8 §7): the scheduled task runs this supervisor parent, which pulls the real `node <trocar> daemon` and re-pulls it on a non-zero
// exit. The CLI hands it to arch.runSupervisor through daemon.mjs's loadArch (layering rule 5: it never imports arch/ itself) with its own entry
// script and the collector dir — and holds no platform list: a platform whose arch has no runSupervisor refuses, so "Linux has no --supervise" is
// the linux arch's shape, not an if in the CLI. The supervisor itself (the backoff, the lock, the signals) is autostart.test.mjs's, W24 there.
test('cli: `daemon --supervise` (4.8 §7, W24): the lone flag goes to arch.runSupervisor through daemon.mjs\'s loadArch with its own script and the collector dir; other arguments stay exit 2, root and a platform without the new collector are refused first, and an arch with no runSupervisor is a usage error', async () => {
  const home = tmpDir('trocar-cli-supervise-')
  try {
    const ran = []
    const supervisor = async (o) => { ran.push([o.trocar, o.dir, typeof o.proc.on === 'function']); try { o.log('up') } catch { /* a log sink that is not one */ } return 7 }
    const daemon = { loadArch: async (p) => (p === 'win32' ? { runSupervisor: supervisor } : {}) } // linux's arch carries none — the CLI must ask, not assume
    const run = (argv, o = {}) => { const t = io(); return runDaemonCli(argv, { io: t, home, env: {}, platform: o.platform || 'win32', deps: { daemon, getuid: () => 1000, proc: { on() {} }, script: '/repo/bin/trocar.mjs', ...o.deps } }).then((exit) => ({ exit, t })) }
    let r = await run(['--supervise'])
    assert.equal(r.exit, 7, 'the supervisor\'s exit code is the command\'s')
    assert.deepEqual(ran, [['/repo/bin/trocar.mjs', path.join(home, '.trocar', 'collector'), true]], 'its own script, the collector dir, the proc to take signals on')
    assert.match(r.t.e.join('\n'), /^\[supervise\] up$/, 'the supervisor\'s log lines reach the terminal with their prefix')
    ran.length = 0
    for (const argv of [['--supervise', '--now'], ['--supervize']]) {
      r = await run(argv)
      assert.equal(r.exit, 2); assert.match(r.t.e.join('\n'), /takes no arguments \(/); assert.match(r.t.e.join('\n'), /usage: trocar daemon \[--supervise\]/)
    }
    r = await run(['--supervise'], { deps: { getuid: () => 0 } })
    assert.equal(r.exit, 2); assert.match(r.t.e.join('\n'), /run this as your own user, not as root/); assert.deepEqual(ran, [], 'root is refused before the supervisor is asked for') // V76: 2, not 1
    r = await run(['--supervise'], { platform: 'linux' })
    assert.equal(r.exit, 2); assert.match(r.t.e.join('\n'), /--supervise is for Windows only/); assert.deepEqual(ran, [], 'the linux arch has no runSupervisor, so the flag is refused there')
    // the `collector start` alias carries its script through (the supervisor child is `node <script> daemon`); a "linux" arch WITH a runSupervisor
    // runs it — the platform name is not what decides, the arch's shape is
    ran.length = 0
    const daemonWithSupervisor = { loadArch: async () => ({ runSupervisor: supervisor }) }
    let t = io()
    assert.equal(await runCli(['daemon', '--supervise'], { home, env: {}, daemon: daemonWithSupervisor, proc: { on() {} }, platform: 'linux', getuid: () => 1000, script: '/repo/bin/trocar.mjs', ...t }), 7)
    assert.deepEqual(ran, [['/repo/bin/trocar.mjs', path.join(home, '.trocar', 'collector'), true]], 'the wrapper passes the script the supervisor child runs')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('cli: install / on go to the one `trocar on` (src/cli/on.mjs) with the descriptors, OS, process table and arch (its OS roots) from daemon.loadParts; uninstall is the one `trocar uninstall` (src/cli/uninstall.mjs)', async () => {
  const seen = []
  const mkU = () => ({ UNIT_NAME: 'trocar-collector.service', userUnit: ({ home, node, script, run }) => ({ path: `${home}/.config/systemd/user/trocar-collector.service`, links: [`${home}/.config/systemd/user/default.target.wants/trocar-collector.service`], text: (env) => `${JSON.stringify(env)} ExecStart="${node}" "${script}" daemon`, ran: run }), unitPath: (h) => `${h}/.config/systemd/user/trocar-collector.service`, wantsLink: (h) => `${h}/.config/systemd/user/default.target.wants/trocar-collector.service`, unitText: ({ node, script, env }) => `${JSON.stringify(env)} ExecStart="${node}" "${script}" daemon`, systemctl: () => ({ code: 0 }), removeWantsLinks: () => [] })
  const parts = { os: 'linux', arch: { unit: mkU() }, harnesses: [{ name: 'h' }], scan: async () => [], match: () => ({ agent: null }) }
  const daemon = { loadParts: async () => parts }
  const { newReceipt } = await import('../../src/cli/schema.mjs')
  const install = {
    turnOn: async (o) => {
      seen.push(['on', o.osName, o.harnesses, o.scan === parts.scan, o.home, o.arch === parts.arch, o.unit ? [o.unit.path, o.unit.links, o.unit.text({ NODE_EXTRA_CA_CERTS: '/corp/ca.pem' })] : null, o.dryRun])
      o.onPlan({ manifest: '/h/.trocar/collector/install-manifest.json', ca: [], files: [], entries: [] })
      return { receipt: { ...newReceipt('on'), user: 'u', relayed: { closing: 0, waiting: 0, cut: 0 }, linger: true, changed: [{ path: '/h/s.json', change: 'adds env.K', backup: null }], undo: ['trocar off'], log: '/h/.trocar/collector/flows' }, exit: 0 }
    },
  }
  const base = { home: '/h', daemon, install, script: '/repo/bin/trocar.mjs', platform: 'linux' }
  let t = io(); assert.equal(await runCli(['on', '--yes'], { ...base, ...t }), 0)
  assert.equal(t.o.length, 2, 'the plan, then the receipt (src/cli/receipt.mjs)')
  assert.match(t.o[0], /^trocar on will write \d+ file/); assert.match(t.o[1], /^Capturing /)
  assertEnglish(t.o.join('\n'))
  t = io(); assert.equal(await runCli(['on', '--dry-run'], { ...base, ...t }), 0)
  assert.deepEqual(seen, [
    ['on', 'linux', parts.harnesses, true, '/h', true, ['/h/.config/systemd/user/trocar-collector.service', ['/h/.config/systemd/user/default.target.wants/trocar-collector.service'], `{"NODE_EXTRA_CA_CERTS":"/corp/ca.pem"} ExecStart="${process.execPath}" "/repo/bin/trocar.mjs" daemon`], false],
    ['on', 'linux', parts.harnesses, true, '/h', true, ['/h/.config/systemd/user/trocar-collector.service', ['/h/.config/systemd/user/default.target.wants/trocar-collector.service'], `{"NODE_EXTRA_CA_CERTS":"/corp/ca.pem"} ExecStart="${process.execPath}" "/repo/bin/trocar.mjs" daemon`], true],
  ])
  seen.length = 0
  t = io(); assert.equal(await runCli(['on', '--yes'], { ...base, install: { turnOn: async () => { throw new Error('boom') } }, ...t }), 1, 'a throw is exit 1, said once')
  assert.match(t.e.join('\n'), /boom/)
  // D39⑥ executed 2026-10-11: no legacy install/uninstall any more. The CLI holds no platform list of its own — a platform
  // without an arch is refused by loadArch (covered by test/collector/arch/linux/redirector-adapter.test.mjs's freebsd cell);
  // here, a platform the stub answers for runs the same new code as linux.
  t = io(); assert.equal(await runCli(['on', '--yes'], { ...base, platform: 'freebsd', ...t }), 0, 'the CLI holds no platform gate: freebsd is loadArch\'s question, and the stub answered for it')
  t = io(); assert.equal(await runCli(['uninstall', '--purge-data', '--yes'], { home: '/h', platform: 'freebsd', ...t }), 0, '`collector uninstall` is `trocar uninstall`: the same entry point — nothing installed, nothing to undo, still done')
  t = io(); assert.equal(await runCli(['uninstall', 'claude-code'], { home: '/h', platform: 'linux', ...t }), 2, 'a harness name is a usage error: uninstall removes trocar for every harness')
  assert.match(t.e.join('\n'), /trocar uninstall: takes no harness name \(claude-code\)/)
})

test('cli: setup-helper installs or removes through arch; a failure is exit 1', async () => {
  const done = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/trocar/trocar-redirector' }, setupHelper: (o) => { done.push(o.binarySrc); return { bin: '/b', caps: 'cap_bpf=ep' } }, uninstallHelper: () => ({ warnings: [] }) } }
  const root = tmpDir('trocar-cli-built-'), dir = path.join(root, 'src', 'collector', 'arch', 'linux'), built = path.join(dir, 'trocar-redirector')
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(built, '')
  let t = io(); assert.equal(await runSetupHelper(['--binary', built], { arch: { install: { ...arch.install, setupHelper: (o) => { done.push(o.binarySrc); return { bin: '/b/trocar-redirector', caps: 'cap_net_admin,cap_perfmon,cap_bpf=ep' } } } }, ...t }), 0)
  assert.equal(t.o.join('\n').split('/b/trocar-redirector').length - 1, 1, `the helper's path is said once (D58)\n${t.o.join('\n')}`)
  assert.ok(t.o.join(' ').includes('cap_net_admin,cap_perfmon,cap_bpf=ep'), `the capabilities the arch reports are said (D38)\n${t.o.join('\n')}`)
  t = io(); assert.equal(await runSetupHelper(['--remove'], { arch, ...t }), 0)
  assert.deepEqual(done, [built])
  t = io(); assert.equal(await runSetupHelper([], { arch: { install: { setupHelper: () => { throw new Error('must run as root') } } }, packageRoot: root, ...t }), 1)
  assert.deepEqual(t.e, ['trocar setup-helper: must run as root'], 'the failure is said once, named by the command')
  // a staged copy an interrupted setup-helper left is removed and said, by both directions (D38)
  const swept = { install: { DEFAULTS: arch.install.DEFAULTS, setupHelper: () => ({ bin: '/b', caps: 'cap_bpf=ep', swept: ['/usr/local/libexec/trocar/.trocar-redirector.new.67915'] }), uninstallHelper: () => ({ warnings: ['removed a staged copy an interrupted setup-helper left: .trocar-redirector.new.67915'] }) } }
  t = io(); await runSetupHelper([], { arch: swept, packageRoot: root, ...t })
  assert.ok(t.o.join('\n').includes('.trocar-redirector.new.67915'), `the staged copy it removed is named (D38)\n${t.o.join('\n')}`)
  assert.doesNotMatch(t.o.join('\n'), /\(ies\)|\(s\)/, 'plain English, no parenthesised plural (D58)')
  assert.ok(t.o.join('\n').split('\n').some((l) => /^ {2}\S/.test(l) && l.trim().endsWith('.trocar-redirector.new.67915')), `a listed path is alone on its line, two in (1.6 §1.1⑥)\n${t.o.join('\n')}`)
  t = io(); await runSetupHelper(['--remove'], { arch: swept, ...t })
  assert.match(t.o.join('\n'), /^Warning: .*\.trocar-redirector\.new\.67915/m)
})

test('cli: setup-helper on a checkout whose helper is not built says how to build it, once, and installs nothing (exit 1)', async () => {
  const called = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/trocar/trocar-redirector' }, setupHelper: (o) => { called.push(o); return { bin: '/b', caps: 'cap_bpf=ep' } } } }
  for (const root of [tmpDir('trocar-cli-unbuilt-'), path.join(tmpDir('trocar-cli-unbuilt-'), "ada's trocar")]) {
    const t = io()
    assert.equal(await runSetupHelper([], { arch, packageRoot: root, ...t }), 1)
    const said = t.e.join('\n'), dir = path.join(root, 'src', 'collector', 'arch', 'linux')
    assert.equal(said.match(/trocar setup-helper:/g).length, 1, 'named by the command once')
    // the build command for this checkout, one line a shell runs as it is (1.6 §1.1): the directory stays one argument
    const line = said.split('\n').find((l) => /^\s*make -C /.test(l))
    const argv = spawnSync('sh', ['-c', `printf '%s\\n' ${line.trim().slice('make -C '.length)}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    assert.deepEqual(argv, [dir])
    assertEnglish(said, 'the output', { width: false }) // the make line carries this checkout's path, however long (1.6 §1.1⑥)
  }
  const t = io(), root = tmpDir('trocar-cli-unbuilt-')
  assert.equal(await runSetupHelper(['--binary', path.join(root, 'nope')], { arch, packageRoot: root, ...t }), 1)
  assert.ok(t.e.join('\n').includes(path.join(root, 'nope')), 'a --binary that is not there is named')
  assert.deepEqual(called, [], 'nothing was handed to the installer')
})

test('cli: the Linux installer\'s own refusals leave the command name to the command (said once)', async () => {
  const { setupHelper } = await import('../../src/collector/arch/linux/install.mjs')
  let message = null
  try { setupHelper({ binarySrc: path.join(tmpDir('trocar-cli-unbuilt-'), 'nope') }) } catch (e) { message = e.message }
  assert.ok(message, 'refused (not root, or not Linux, or no binary)')
  assert.doesNotMatch(message, /^trocar setup-helper:/)
})

test('cli: the real bin runs `status` without a runtime dir on a HOME with nothing installed (→ 0: nothing is wrong, and nothing was written)', () => {
  const home = tmpDir('trocar-cli-bin-')
  const env = { ...process.env, HOME: home, ...osStubs().env }; delete env.XDG_RUNTIME_DIR // status reads the disk: never the operator's own
  const r = spawnSync(process.execPath, [BIN, 'status'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^No harness is set up for capture yet\./); assert.equal(r.stderr, '')
  assert.deepEqual(fs.readdirSync(home), [], 'read-only')
  assert.ok(formatStatus({ ...STATUS, agents: [] }).includes('agents: none running'))
  const groups = [{ key: 'agent-untrusted:config-after-start', count: 1, last_ts: 'T1', last: { ts: 'T1', event: 'agent-untrusted', pid: 11, agent: 'claude-code', code: 'config-after-start', reason: 'restart it' } },
    { key: 'engine/lookup-miss', count: 4, last_ts: 'T2', last: { ts: 'T2', event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'no original destination', suppressed: 3 } }]
  const health = { generated_at: 'T3', summary: { state: 'failing', n: 3 }, collector: { installed: true, daemon: { state: 'running' }, conditions: [{ kind: 'untrusted', pid: 11, agent: 'claude-code', since: 'T1', reason: 'config-after-start' }], failures: groups, expected: {} }, raw: { problems: [] }, read: { errors: [], truncated: false } }
  assert.match(formatStatus({ ...STATUS, health }), /capture health: 3 problem\(s\)[^\n]*\nconditions now:\n  now: untrusted pid 11 claude-code since T1: config-after-start\nproblems in the last 24 hours \(2 kind\(s\)\):\n  T1 agent-untrusted pid 11 claude-code: restart it\n  T2 problem \(engine\/lookup-miss\): no original destination \(x4 in 24 h\)$/, 'status prints the durable failure records by kind (D38)')
  assert.ok(path.isAbsolute(BIN))
  fs.rmSync(home, { recursive: true, force: true })
})


// D62 ⑥ (the hidden loop a review found): a second daemon starting while one answers must EXIT, not fail. A non-zero exit is retried by the platform for
// as long as the other one lives — launchd's KeepAlive {SuccessfulExit: false} every ThrottleInterval, the Windows supervisor on its backoff (4.8 §7: 0 =
// it was asked to stop, do not re-pull) — so the loop would burn CPU every 10 s with nothing to show. The reason is said once, into the daemon log (D38).
test('cli: a daemon that finds another one answering on the control channel says so once and exits 0 — the platform must not retry it; any other start failure still exits 1', async () => {
  const home = tmpDir('trocar-cli-second-')
  markInstalled(home)
  const run = (already) => {
    const daemon = { startDaemon: async () => { throw Object.assign(new Error(already ? 'another collector daemon is answering on /s' : 'the engine port is taken'), already ? { [DAEMON_ALREADY_UP]: true } : {}) } }
    const t = io()
    return runDaemonCli([], { io: t, home, env: {}, platform: 'darwin', deps: { daemon, proc: { on() {} }, getuid: () => 1000 } }).then((exit) => ({ exit, t }))
  }
  const second = await run(true)
  assert.equal(second.exit, 0, 'already as asked: the OS mechanism is given no reason to start another one')
  assert.equal(second.t.e.filter((l) => /another collector daemon is answering/.test(l)).length, 1, `said once: ${JSON.stringify(second.t.e)}`)
  const other = await run(false)
  assert.equal(other.exit, 1, 'a start that failed for any other reason is still a failure')
  fs.rmSync(home, { recursive: true, force: true })
})

// the other half of the same probe (D38): the control endpoint accepts a connection but answers nothing — a daemon with a wedged event loop, another
// program holding the pipe name. Exiting 0 here would leave the machine with no working collector and no record until the next login, so this one is a
// failure: one persistent record naming the pid the lock claims holds it, and a non-zero exit, which the platform retries at its own throttle.
test('cli: a control endpoint held by something that does not answer is a failure record naming the pid that holds it, and a non-zero exit (not exit 0)', async () => {
  const home = tmpDir('trocar-cli-held-')
  const dir = markInstalled(home)
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: 7371 }))
  const daemon = {
    collectorPaths: (d) => ({ lock: path.join(d, 'lock') }),
    startDaemon: async () => { throw Object.assign(new Error('the control endpoint /s is held by something that does not answer'), { [DAEMON_ENDPOINT_BUSY]: true }) },
  }
  const t = io()
  const exit = await runDaemonCli([], { io: t, home, env: {}, platform: 'darwin', deps: { daemon, proc: { on() {} }, getuid: () => 1000 } })
  assert.equal(exit, 1, 'non-zero: the platform retries, and status/doctor have something to show')
  const flows = path.join(dir, 'flows')
  const rows = fs.readdirSync(flows).flatMap((f) => fs.readFileSync(path.join(flows, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  const held = rows.filter((r) => r.code === 'control-endpoint-held')
  assert.equal(held.length, 1, `one record, not none and not a loop of them: ${JSON.stringify(rows)}`)
  assert.deepEqual([held[0].event, held[0].where], ['failure', 'start'], 'a failure, so the board turns it up (D38)')
  assert.match(held[0].reason, /pid 7371/, 'and it names the pid the lock claims holds the endpoint')
  assert.deepEqual(checkRecord(held[0]), [], 'the code and where are in the closed sets')
  fs.rmSync(home, { recursive: true, force: true })
})
