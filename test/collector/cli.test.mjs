// test/collector/cli.test.mjs — `asight collector` verbs over injected daemon / install modules, and the real bin.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { fileURLToPath } from 'node:url'
import { runCollector, runSetupHelper, formatStatus } from '../../src/collector/cli.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const io = () => { const o = []; const e = []; return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) } }
const STATUS = { desired: 'on', actual: 'on', recording: true, degraded: null, engine: { port: 4711, v6: 4711, decrypted: 2, spliced: 1 }, helper: { pid: 9, proto: 1, ok: true }, running_untrusted: 1,
  agents: [{ pid: 10, agent: 'claude-code', trusted: true, trust_var: 'NODE_EXTRA_CA_CERTS', trust_via: 'user settings env', direct: 0 }, { pid: 11, agent: 'claude-code', trusted: false, reason: 'var-missing', direct: 2 },
    { pid: 12, agent: 'opencode', parent_agent: 'claude-code', trusted: true, trust_var: 'asight:marker', trust_via: 'plugin marker', not_via_trust_path: [{ host: 'models.dev', reason: 'before-plugin' }], direct: 0 },
    { pid: 14, agent: 'claude-code', trusted: true, trust_var: 'NODE_EXTRA_CA_CERTS', trust_via: 'user settings env', direct: 0, unreachable: [{ transport: 'af-unix', var: 'ANTHROPIC_UNIX_SOCKET' }, { transport: 'quic', var: 'BUN_OPTIONS' }] },
    { pid: 13, agent: 'deepseek-dsh', trusted: false, reason: 'dsh-node-too-old', hint: 'this dsh runs on a Node older than 22.19.0', direct: 1 }],
  unjudged: { count: 3, sample: [{ pid: 20, comm: 'sshd', errno: 'EACCES' }, { pid: 21, comm: '(sd-pam)', errno: 'EACCES' }] } }

test('cli: off/status go to the control socket; exit 1 when the kernel did not reach the asked state; 3 with no daemon; 2 without XDG_RUNTIME_DIR', async () => {
  const calls = []
  const request = async (q) => { calls.push([q.method, q.path, q.socketPath]); return q.path === '/off' ? { ...STATUS, desired: 'off', actual: 'on' } : STATUS }
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
  let t = io(); assert.equal(await runCollector(['off'], { env, request, ...t }), 1)
  t = io(); assert.equal(await runCollector(['status'], { env, request, ...t }), 0)
  assert.deepEqual(calls, [['POST', '/off', '/run/user/1000/asight/collector.sock'], ['GET', '/status', '/run/user/1000/asight/collector.sock']], '`on` is not here: it plans, confirms and writes before it asks the daemon anything (src/cli/on.mjs); a POST /on without the install is not an `on`')
  assert.match(t.o[0], /2 decrypted/); assert.match(t.o[0], /untrusted: var-missing · 2 direct/)
  assert.match(t.o[0], /  12 opencode \(started by claude-code\) decrypt \(asight:marker via plugin marker\) · 0 direct\n    not captured \(not via the trust path\): models\.dev \(before-plugin\)/)
  assert.match(t.o[0], /  14 claude-code decrypt .*\n    not captured \(transport the engine cannot reach\): af-unix \(ANTHROPIC_UNIX_SOCKET\), quic \(BUN_OPTIONS\)/, 'the agent line lists them (B-4b)')
  assert.match(t.o[0], /not judged: 3 process\(es\) of yours whose executable cannot be read and whose command line fits no harness .*: 20 sshd \(EACCES\), 21 \(sd-pam\) \(EACCES\), …/, 'said, not silent (B-1)')
  assert.match(t.o[0], /  13 deepseek-dsh untrusted: dsh-node-too-old — this dsh runs on a Node older than 22\.19\.0 · 1 direct/)
  const home = tmpDir('asight-cli-') // never the operator's own ~/.asight
  t = io(); assert.equal(await runCollector(['status'], { env, home, request: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, ...t }), 3)
  t = io(); assert.equal(await runCollector(['status'], { env: {}, home, request, ...t }), 2)
  fs.rmSync(home, { recursive: true, force: true })
  t = io(); assert.equal(await runCollector(['bogus'], { env, request, ...t }), 2)
})

// D-2: whenever no daemon answers — none running, no runtime dir, or one that does not reply — status still reads
// flows/ from disk, and an unreadable flows/ is said instead of looking like "no failures".
test('cli: with no daemon answering (not running, no runtime dir, stuck) status reads the failure records from disk; an unreadable flows/ is said (D-2)', async () => {
  const home = tmpDir('asight-cli-')
  const dir = path.join(home, '.asight', 'collector')
  try {
    appendEvent(dir, { event: 'failure', where: 'start', code: 'EADDRINUSE', reason: 'the engine port is held by another process' })
    fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify({ version: 1, complete: true, entries: [], files: [] })) // installed
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
    let t = io(); assert.equal(await runCollector(['status'], { env: {}, home, ...t }), 2)
    assert.match(t.e.join('\n'), /XDG_RUNTIME_DIR/); assert.match(t.o.join('\n'), /failure \(start\/EADDRINUSE\): the engine port is held by another process/)
    t = io(); assert.equal(await runCollector(['status'], { env, home, request: async () => { throw Object.assign(new Error('timed out after 2000 ms'), { code: 'ETIMEDOUT' }) }, ...t }), 1)
    assert.match(t.e.join('\n'), /did not answer: timed out/); assert.match(t.o.join('\n'), /failure \(start\/EADDRINUSE\)/)
    fs.rmSync(path.join(dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(dir, 'flows'), 'x')
    t = io(); assert.equal(await runCollector(['status'], { env, home, request: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }, ...t }), 3)
    assert.match(t.o.join('\n'), /capture health could not be read: .*flows: ENOTDIR/)
    assert.match(t.o[0], /collector daemon: not running \(it stopped cleanly, or never started\)/, 'no lock')
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: 2 ** 22 + 7, start_time: '1', boot_id: 'b', socket: '/x' })) // a pid nothing runs as
    t = io(); await runCollector(['status'], { env, home, request: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, ...t })
    assert.match(t.o[0], /collector daemon: not running — its last run ended without a clean stop \(pid \d+ is not running\)/, 'kill -9: said from the lock alone')
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, socket: '/x' })); const old = new Date(Date.now() - 30_000); fs.utimesSync(path.join(dir, 'lock'), old, old)
    t = io(); await runCollector(['status'], { env, home, request: async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, ...t })
    assert.match(t.o[0], /collector daemon: not responding — pid \d+ has not refreshed its lock for 3\d s/, 'a stuck daemon')
    const health = { generated_at: 'T', summary: { state: 'ok', since: 'T0', read_errors: 1 }, collector: { installed: true, daemon: { state: 'running' }, conditions: [], failures: [], expected: { policy: 3 } }, legacy: { present: false }, raw: { problems: [] }, read: { errors: [{ file: '/f', error: 'EACCES' }], truncated: true } }
    assert.match(formatStatus({ ...STATUS, health, events: { lost: 2 } }), /capture health: ✓ capturing since T0 · 读不全[^\n]*\nnot captured by design \(last 24 h\): policy 3\ncould not read \/f: EACCES\n\(older records were left out[^\n]*\nevent log: 2 line\(s\) could not be written/)
    assert.match(formatStatus({ ...STATUS, health: { error: 'capture health could not be read: /x/flows: EACCES' } }), /capture health could not be read: \/x\/flows: EACCES/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// D-27 / D-5 / stop exit code: `start` waits for SIGTERM, SIGINT, SIGHUP or SIGQUIT and tells stop() which; a stop
// with a failed step exits 1; an uncaught exception is one `crash` record, then exit 70.
test('cli: start stops on SIGHUP like SIGTERM, passes the signal to stop, exits 1 when a stop step failed, and records a crash (D-5, D-27)', async () => {
  const { EventEmitter } = await import('node:events')
  const home = tmpDir('asight-cli-start-')
  try {
    const stops = []
    let failed = []
    const daemon = { startDaemon: async (o) => ({ port: 1, socketPath: '/s', foreground: o.foreground, stop: async (x) => { stops.push(x); return { failed } } }) }
    const proc = new EventEmitter()
    let t = io()
    const running = runCollector(['start'], { home, env: {}, daemon, proc, exit: () => {}, ...t }) // the real signal wait
    await new Promise((r) => setImmediate(r))
    process.emit('SIGHUP')
    assert.equal(await running, 0)
    assert.deepEqual(stops, [{ signal: 'SIGHUP' }])
    failed = ['helper']
    t = io(); assert.equal(await runCollector(['start'], { home, env: {}, daemon, proc, exit: () => {}, waitForStop: async () => 'SIGTERM', ...t }), 1, 'a stop step failed: non-zero')
    assert.match(t.e.join('\n'), /helper failed while stopping/)
    const exits = []
    t = io(); await runCollector(['start'], { home, env: {}, daemon, proc: (proc.removeAllListeners(), proc), exit: (c) => exits.push(c), waitForStop: async () => 'SIGTERM', ...t })
    proc.emit('uncaughtException', new TypeError('boom in a timer'))
    assert.deepEqual(exits, [70])
    const f = JSON.parse(fs.readFileSync(path.join(home, '.asight', 'collector', 'flows', fs.readdirSync(path.join(home, '.asight', 'collector', 'flows'))[0]), 'utf8').trim())
    assert.deepEqual([f.where, f.code, /TypeError: boom in a timer/.test(f.reason)], ['daemon', 'crash', true])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// 1.6 §1.4 5: after `off` with no names the daemon stops itself once nothing is relayed; `start` then returns 0 without any signal, so the unit exits
// cleanly and systemd does not restart it (Restart=on-failure)
test('cli: start returns when the daemon has stopped itself (off), exit 0, without waiting for a signal; a signal arriving later gets the first stop\'s result', async () => {
  const home = tmpDir('asight-cli-start-')
  try {
    let result = { failed: [] }
    const stops = []
    const daemon = { startDaemon: async () => ({ port: 1, socketPath: '/s', exited: Promise.resolve(result), stop: async (x) => { stops.push(x); return result } }) }
    let t = io()
    assert.equal(await runCollector(['start'], { home, env: {}, daemon, proc: { on() {} }, waitForStop: () => new Promise(() => {}), ...t }), 0, 'no signal ever came')
    assert.deepEqual(stops, [{ signal: null }])
    result = { failed: ['helper'] }
    t = io(); assert.equal(await runCollector(['start'], { home, env: {}, daemon, proc: { on() {} }, waitForStop: () => new Promise(() => {}), ...t }), 1, 'a step of its own stop failed')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('cli: install / on go to the one `asight on` (src/cli/on.mjs) with the descriptors, OS and process table from daemon.loadParts; uninstall hands them to uninstall.mjs', async () => {
  const seen = []
  const mkU = () => ({ UNIT_NAME: 'asight-collector.service', userUnit: ({ home, node, script, run }) => ({ path: `${home}/.config/systemd/user/asight-collector.service`, links: [`${home}/.config/systemd/user/default.target.wants/asight-collector.service`], text: (env) => `${JSON.stringify(env)} ExecStart="${node}" "${script}" collector start`, ran: run }), unitPath: (h) => `${h}/.config/systemd/user/asight-collector.service`, wantsLink: (h) => `${h}/.config/systemd/user/default.target.wants/asight-collector.service`, unitText: ({ node, script, env }) => `${JSON.stringify(env)} ExecStart="${node}" "${script}" collector start`, systemctl: () => ({ code: 0 }), removeWantsLinks: () => [] })
  const parts = { os: 'linux', osRootsFile: '/os/roots.pem', arch: { unit: mkU() }, harnesses: [{ name: 'h' }], scan: async () => [], match: () => ({ agent: null }) }
  const daemon = { loadParts: async () => parts }
  const { newReceipt } = await import('../../src/cli/schema.mjs')
  const install = {
    turnOn: async (o) => {
      seen.push(['on', o.osName, o.harnesses, o.scan === parts.scan, o.home, o.osRootsFile, o.unit ? [o.unit.path, o.unit.links, o.unit.text({ NODE_EXTRA_CA_CERTS: '/corp/ca.pem' })] : null, o.dryRun, o.autostart])
      o.onPlan({ manifest: '/h/.asight/collector/install-manifest.json', ca: [], files: [], entries: [] })
      return { receipt: { ...newReceipt('on'), user: 'u', relayed: { closing: 0, waiting: 0, cut: 0 }, linger: true, changed: [{ path: '/h/s.json', change: '加 env.K', backup: null }], undo: ['asight off'], log: '/h/.asight/collector/flows' }, exit: 0 }
    },
    uninstallCollector: async (o) => { seen.push(['uninstall', o.purgeData, !!o.unit]); return { daemon: 'stopped', kept_captures: !o.purgeData, entries: [{ harness: 'h', path: '/h/s.json', result: 'restored' }], still_trusting: [{ pid: 7, agent: 'h' }], notes: [] } },
  }
  const base = { home: '/h', daemon, install, script: '/repo/bin/asight.mjs', platform: 'linux' }
  let t = io(); assert.equal(await runCollector(['install', '--yes'], { ...base, ...t }), 0)
  assert.equal(t.o.length, 2, 'the plan, then the receipt (src/cli/receipt.mjs)')
  assert.match(t.o[0], /^asight on 将写或改下面这些文件/); assert.match(t.o[1], /^asight 已打开采集/)
  t = io(); assert.equal(await runCollector(['on', '--yes', '--no-unit'], { ...base, ...t }), 0, '`collector on` is `on` too: the daemon-only POST /on path is gone')
  t = io(); assert.equal(await runCollector(['install', '--yes', '--no-autostart'], { ...base, ...t }), 0)
  t = io(); assert.equal(await runCollector(['install', '--dry-run'], { ...base, ...t }), 0)
  assert.deepEqual(seen, [
    ['on', 'linux', parts.harnesses, true, '/h', '/os/roots.pem', ['/h/.config/systemd/user/asight-collector.service', ['/h/.config/systemd/user/default.target.wants/asight-collector.service'], `{"NODE_EXTRA_CA_CERTS":"/corp/ca.pem"} ExecStart="${process.execPath}" "/repo/bin/asight.mjs" collector start`], false, true],
    ['on', 'linux', parts.harnesses, true, '/h', '/os/roots.pem', null, false, true],
    ['on', 'linux', parts.harnesses, true, '/h', '/os/roots.pem', ['/h/.config/systemd/user/asight-collector.service', ['/h/.config/systemd/user/default.target.wants/asight-collector.service'], `{"NODE_EXTRA_CA_CERTS":"/corp/ca.pem"} ExecStart="${process.execPath}" "/repo/bin/asight.mjs" collector start`], false, false],
    ['on', 'linux', parts.harnesses, true, '/h', '/os/roots.pem', ['/h/.config/systemd/user/asight-collector.service', ['/h/.config/systemd/user/default.target.wants/asight-collector.service'], `{"NODE_EXTRA_CA_CERTS":"/corp/ca.pem"} ExecStart="${process.execPath}" "/repo/bin/asight.mjs" collector start`], true, true],
  ])
  seen.length = 0
  t = io(); assert.equal(await runCollector(['install'], { ...base, install: { turnOn: async () => { throw new Error('boom') } }, ...t, onDeps: {} }), 1, 'a throw is exit 1, said once')
  assert.match(t.e.join('\n'), /boom/)
  t = io(); assert.equal(await runCollector(['install', '--yes'], { ...base, platform: 'darwin', ...t }), 1, 'a platform without the new collector is not given the Linux install')
  t = io(); assert.equal(await runCollector(['uninstall', '--purge-data'], { daemon, install, ...t }), 0)
  assert.match(t.o[0], /captures removed/); assert.match(t.o[0], /pid 7 \(h\) trusts the asight CA until it restarts/)
  assert.deepEqual(seen, [['uninstall', true, true]])
  // an item uninstall could not undo: exit 1, the manifest keeps it, the user is told to run uninstall again (D38)
  const leftOne = { uninstallCollector: async (o) => { seen.push(['uninstall-opts', o.harnesses === undefined && o.match === undefined && o.scan === parts.scan, o.osRootsFile]); return { daemon: 'none', kept_captures: true, entries: [{ harness: 'h', path: '/h/s.json', result: 'left-unparsable' }], residue: ['/h/.config/h/node_modules'], kept_bundles: [{ path: '/h/ca/combined-h.pem', pids: [5, 6] }, { path: '/h/ca/combined-g.pem', pids: [7], holds_ca: true, error: 'EACCES' }], still_trusting: [{ pid: 5, agent: 'h', until: 'next-connection' }], notes: [], left: [{ path: '/h/s.json', harness: 'h', result: 'left-unparsable' }] } } }
  t = io(); assert.equal(await runCollector(['uninstall'], { daemon, install: leftOne, ...t }), 1)
  assert.deepEqual(seen.at(-1), ['uninstall-opts', true, '/os/roots.pem'], 'the process table and the OS roots reach uninstall; the descriptors and the registry do not: liveness is judged from the manifest, as `asight off` judges it (1.6 R3)')
  assert.match(t.o[0], /left in place: \/h\/.config\/h\/node_modules/)
  assert.match(t.o[0], /kept \/h\/ca\/combined-h\.pem without the asight CA for pid 5, 6; run uninstall again once they exit/)
  assert.match(t.o[0], /kept \/h\/ca\/combined-g\.pem STILL WITH the asight CA \(it could not be rewritten: EACCES\) for pid 7; fix the file, then run uninstall again/, 'a bundle that could not be rewritten is not said to be without the CA (RV-2)')
  assert.match(t.o[0], /pid 5 \(h\) trusts the asight CA until its next new connection/)
  assert.match(t.e[0], /1 item\(s\) could not be undone \(\/h\/s\.json: left-unparsable\); the install manifest is kept — fix them, then run uninstall again/)
  // D-18: something left that could not be undone — exit 1, and says the manifest is kept
  const partial = { uninstallCollector: async () => ({ daemon: 'none', kept_captures: true, entries: [{ harness: 'h', path: '/h/s.json', result: 'left-link' }], still_trusting: [], notes: [], left: [{ path: '/h/s.json', harness: 'h', result: 'left-link' }] }) }
  t = io(); assert.equal(await runCollector(['uninstall'], { daemon, install: partial, ...t }), 1)
  assert.match(t.o[0], /^uninstalled, except/)
  assert.match(t.e[0], /1 item\(s\) could not be undone \(\/h\/s\.json: left-link\); the install manifest is kept — fix them, then run uninstall again/)
})

test('cli: setup-helper installs or removes through arch; a failure is exit 1', async () => {
  const done = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/asight/asight-redirector' }, setupHelper: (o) => { done.push(o.binarySrc); return { bin: '/b', getcap: 'caps' } }, uninstallHelper: () => ({ warnings: [] }) } }
  let t = io(); assert.equal(await runSetupHelper(['--binary', '/tmp/h'], { arch, ...t }), 0)
  t = io(); assert.equal(await runSetupHelper(['--remove'], { arch, ...t }), 0)
  assert.deepEqual(done, ['/tmp/h'])
  t = io(); assert.equal(await runSetupHelper([], { arch: { install: { setupHelper: () => { throw new Error('must run as root') } } }, ...t }), 1)
  assert.deepEqual(t.e, ['must run as root'])
  // a staged copy an interrupted setup-helper left is removed and said, by both directions (D38)
  const swept = { install: { DEFAULTS: arch.install.DEFAULTS, setupHelper: () => ({ bin: '/b', getcap: 'caps', swept: ['.asight-redirector.new.67915'] }), uninstallHelper: () => ({ warnings: ['removed 1 copy(ies) an interrupted setup-helper had staged: .asight-redirector.new.67915'] }) } }
  t = io(); await runSetupHelper([], { arch: swept, ...t })
  assert.match(t.o.join('\n'), /removed 1 copy\(ies\) an interrupted setup-helper had staged: \.asight-redirector\.new\.67915/)
  t = io(); await runSetupHelper(['--remove'], { arch: swept, ...t })
  assert.match(t.o.join('\n'), /warning: removed 1 copy\(ies\)/)
})

test('cli: the real bin dispatches `collector` (usage → 2) and `collector status` without a runtime dir (→ 2)', () => {
  const home = tmpDir('asight-cli-bin-')
  const env = { ...process.env, HOME: home }; delete env.XDG_RUNTIME_DIR // status reads flows/ from disk: never the operator's own
  assert.equal(spawnSync(process.execPath, [BIN, 'collector', 'nope'], { env, encoding: 'utf8' }).status, 2)
  const r = spawnSync(process.execPath, [BIN, 'collector', 'status'], { env, encoding: 'utf8' })
  assert.equal(r.status, 2); assert.match(r.stderr, /XDG_RUNTIME_DIR is not set/)
  assert.ok(formatStatus({ ...STATUS, agents: [] }).includes('agents: none running'))
  const groups = [{ key: 'agent-untrusted:config-after-start', count: 1, last_ts: 'T1', last: { ts: 'T1', event: 'agent-untrusted', pid: 11, agent: 'claude-code', code: 'config-after-start', reason: 'restart it' } },
    { key: 'engine/lookup-miss', count: 4, last_ts: 'T2', last: { ts: 'T2', event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'no original destination', suppressed: 3 } }]
  const health = { generated_at: 'T3', summary: { state: 'failing', n: 3 }, collector: { installed: true, daemon: { state: 'running' }, conditions: [{ kind: 'untrusted', pid: 11, agent: 'claude-code', since: 'T1', reason: 'config-after-start' }], failures: groups, expected: {} }, legacy: { present: false }, raw: { problems: [] }, read: { errors: [], truncated: false } }
  assert.match(formatStatus({ ...STATUS, health }), /capture health: ⚠ 3 failure\(s\)[^\n]*\nconditions now:\n  now: untrusted pid 11 claude-code since T1: config-after-start\nrecent failures \(2 kind\(s\), last 24 h\):\n  T1 agent-untrusted pid 11 claude-code: config-after-start — restart it\n  T2 failure \(engine\/lookup-miss\): no original destination \(×4 in 24 h\)$/, 'status prints the durable failure records by kind (D38)')
  assert.ok(path.isAbsolute(BIN))
  fs.rmSync(home, { recursive: true, force: true })
})
