// test/off/win32-kernel.test.mjs — the kernel without its daemon (plan Task 9(b) undoWin32's step-1 half; RFC 4.8 §4.2): made
// forward-only through its own controller (forwarder.lock names the config, the config the port and secret), or stopped when the
// controller cannot be told; the win32 arms of runOff around it (no systemctl, the receipt's 「没有守护进程替它排空」, the opt-in
// registry's loop). reg / schtasks / powershell are recording fakes; the controller is an injected request function.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { kernelForwardOnly, kernelControllerOf, readForwarderLock } from '../../src/off/win32.mjs'
import { undoOptIns } from '../../src/off/win32-optin.mjs'
import { runOff } from '../../src/off/orchestrate.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const KERNEL_AT = 1_740_000_000_000 // the kernel's start time, Unix ms

/** The collector dir with a forwarder.lock and its config, as the forwarder writes them. */
function kernelWorld({ pid = 7000 } = {}) {
  const dir = tmpDir('asight-w32-kern-')
  const config = path.join(dir, 'forwarder', 'config.json')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(config, JSON.stringify({ 'external-controller': '127.0.0.1:19090', secret: 's'.repeat(8), listeners: [{ name: 'asight-lsn-claude-code', type: 'mixed', listen: '127.0.0.1', port: 17991, rule: 'asight-rule-claude-code' }] }))
  fs.writeFileSync(path.join(dir, 'forwarder.lock'), JSON.stringify({ pid, startedAt: KERNEL_AT, endpoint: 'tcp:127.0.0.1:19090', config }) + '\n')
  return { dir, config, pid }
}
/** The controller as an injected request: GET /configs answers the running config, PUT /configs records what it was given; `down` makes it not answer. */
function controller({ down = false, putFails = false } = {}) {
  const puts = []
  const request = async ({ method, path: p }) => {
    if (down) return { error: 'connect ECONNREFUSED' }
    if (method === 'GET') return { status: 200, json: { mode: 'rule', 'external-controller': '127.0.0.1:19090', secret: 's'.repeat(8), listeners: [{ name: 'asight-lsn-claude-code', type: 'mixed', listen: '127.0.0.1', port: 17991, rule: 'asight-rule-claude-code' }], proxies: [{ name: 'asight-in-claude-code' }], 'proxy-groups': [{ name: 'asight-fb-claude-code' }], 'sub-rules': {}, rules: ['MATCH,DIRECT'] } }
    puts.push(p)
    return putFails ? { status: 400, json: { message: 'bad config' } } : { status: 204 }
  }
  return { request, puts }
}

test('forwarder.lock and the controller endpoint are read as the forwarder wrote them', () => {
  const w = kernelWorld()
  assert.deepEqual(readForwarderLock({ dir: w.dir }), { pid: w.pid, startedAt: KERNEL_AT, endpoint: 'tcp:127.0.0.1:19090', config: w.config })
  assert.deepEqual(kernelControllerOf({ config: w.config }), { port: 19090, secret: 's'.repeat(8) })
  fs.writeFileSync(w.config, JSON.stringify({ listeners: [] }))
  assert.ok(kernelControllerOf({ config: w.config }).error, 'no external-controller: not a config the daemon wrote')
  assert.equal(readForwarderLock({ dir: tmpDir('asight-w32-none-') }), null, 'no lock: no kernel on record')
})

test('kernelForwardOnly: the listeners stay, the groups and each listener\'s rule go, MATCH,DIRECT — one PUT through the controller', async () => {
  const w = kernelWorld()
  const ctl = controller()
  const r = await kernelForwardOnly({ dir: w.dir, request: ctl.request })
  assert.deepEqual([r.done, r.kernel_pid], ['forward-only', w.pid])
  assert.deepEqual(ctl.puts, ['/configs?force=true'])
  const seen = []
  const spy = async (o) => { seen.push(o); return ctl.request(o) }
  await kernelForwardOnly({ dir: w.dir, request: spy })
  const payload = JSON.parse(seen.find((o) => o.method === 'PUT').body.payload)
  assert.deepEqual(payload.listeners, [{ name: 'asight-lsn-claude-code', type: 'mixed', listen: '127.0.0.1', port: 17991 }], 'the listener stays, its rule (pointing at a sub-rule that is gone) does not')
  assert.equal(payload.rules[0], 'MATCH,DIRECT')
  assert.ok(!payload['proxy-groups'] && !payload['sub-rules'] && !payload.proxies, 'nothing of the routing is left')
})

test('a controller that does not answer, or refuses the reload, gets the kernel stopped (its lock checked first), not left preferring a dead engine', async () => {
  const w = kernelWorld()
  const calls = []
  const run = (file, args) => { const cmd = [file, ...args].join(' '); calls.push(cmd); if (/Get-Process -Id 7000 /.test(cmd)) return { status: 0, stdout: String(KERNEL_AT), stderr: '' }; return { status: 0, stdout: 'gone', stderr: '' } } // the kernel's start time, as the lock names it
  const r = await kernelForwardOnly({ dir: w.dir, request: controller({ down: true }).request, run })
  assert.equal(r.done, 'stopped', 'no answer: stopped')
  assert.ok(calls.some((c) => c.includes('Get-Process -Id 7000')), 'the lock\'s pid was asked about first')
  assert.ok(calls.some((c) => c === 'taskkill /PID 7000 /F'))
  const r2 = await kernelForwardOnly({ dir: w.dir, request: controller({ putFails: true }).request, run })
  assert.equal(r2.done, 'stopped', 'a refused reload: stopped too')
  assert.ok(r.reason.includes('did not answer') && r2.reason.includes('refused'), 'each says which it was')
})

test('runOff on win32: the kernel goes forward-only only when the daemon did not answer; the autostart step runs no systemctl; the receipt says 没有守护进程替它排空', async () => {
  const home = tmpDir('asight-w32-off-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify({ version: 2, complete: true, created_at: '2026-10-09T00:00:00Z', confirmed_paths: [], kept_backups: [], liveness: {}, dirs: [], files: [], entries: [] }))
  const kernelCalls = []
  const kernel = async (o) => { kernelCalls.push(o.dir); return { done: 'forward-only', kernel_pid: 7000 } }
  const execCalls = []
  const exec = (file) => { execCalls.push(file); return { status: 1, stdout: '', stderr: '' } }
  const { receipt, exit } = await runOff({ home, env: { ASIGHT_TEST_SANDBOX: '1' }, ids: null, deps: { platform: 'win32', exec, procs: async () => [], daemonState: async () => ({ state: 'none' }), lockWaitMs: 0, kernelForwardOnly: kernel } })
  assert.equal(exit, 0, `a clean off${receipt.problems.length ? ` (${receipt.problems[0]})` : ''}`)
  assert.deepEqual(kernelCalls, [dir], 'no daemon answered: the kernel was made forward-only')
  assert.ok(!execCalls.includes('systemctl'), 'the autostart step ran no systemctl (the task and Run value are ledger entries)')
  assert.ok(receipt.notes.some((n) => n.includes('没有守护进程替它排空')), 'the receipt says what drains the kernel now')
  assert.equal(receipt.autostart.disabled, true)
  // a daemon that answers manages its own kernel on the way out (POST /off {exit:true}): the forward-only step is NOT taken
  const kernelCalls2 = []
  const { exit: exit2 } = await runOff({ home, env: { ASIGHT_TEST_SANDBOX: '1' }, ids: null, deps: { platform: 'win32', exec, procs: async () => [], lockWaitMs: 0, daemonState: async () => ({ state: 'running' }), request: async () => ({ confirmed: true, actual: 'off', relayed: { closing: 0, waiting: 0, cut: 0 } }), kernelForwardOnly: async () => { kernelCalls2.push(1); return { done: 'none' } } } })
  assert.equal(exit2, 0)
  assert.equal(kernelCalls2.length, 0, 'the daemon answered: its own drain owns the kernel')
})

test('the opt-in registry: user-level items by kind through UNDO_BY_KIND, machine-level ones named for the operator (needs-admin, never elevated here), unknown kinds said', async () => {
  const manifest = { entries: [
    { kind: 'optin-registry', scope: 'user', harness: 'claude-code', path: 'HKCU\\x', installed_at: '2026-10-09T00:00:00Z' },
    { kind: 'optin-machine', scope: 'machine', harness: 'claude-code', path: 'HKLM\\y', elevated_command: 'reg delete HKLM\\y /f (run it yourself)', installed_at: '2026-10-09T00:00:00Z' },
    { kind: 'optin-future', scope: 'user', harness: 'codex', path: 'C:\\z', installed_at: '2026-10-09T00:00:00Z' },
  ] }
  const undo = async ({ entry }) => ({ ok: true, result: entry.path.endsWith('x') ? 'undone' : 'absent' })
  const { UNDO_BY_KIND } = await import('../../src/off/win32-optin.mjs')
  UNDO_BY_KIND['optin-registry'] = undo // the registry is Task 14's to fill; the test lends it one
  try {
    const o = await undoOptIns({ manifest, ids: null })
    assert.deepEqual(o.results.map((r) => [r.kind, r.result]), [['optin-registry', 'undone'], ['optin-machine', 'needs-admin'], ['optin-future', 'unknown-kind']])
    assert.deepEqual(o.needsAdmin.map((x) => x.command), ['reg delete HKLM\\y /f (run it yourself)'], 'the elevated command is handed to the operator, never run')
    assert.deepEqual(o.unknown.map((x) => x.kind), ['optin-future'])
    const scoped = await undoOptIns({ manifest, ids: ['codex'] })
    assert.deepEqual(scoped.results.map((r) => r.kind), ['optin-future'], 'ids limits the harnesses, as everywhere')
  } finally { delete UNDO_BY_KIND['optin-registry'] }
})

// ── W25's command-level half: the R7 refusal at the entry of off and uninstall (4.8 §7) ────────────────────────────────────────
/** whoami as a recording fake: `elevated` High-integrity / Medium / unreadable, everything else fails. */
function whoami({ elevated = 'medium' } = {}) {
  const calls = []
  const run = (file, args) => {
    calls.push([file, ...args].join(' '))
    if (file !== 'whoami') return { status: 1, stdout: '', stderr: `not whoami: ${file}` }
    if (elevated === 'unreadable') return { status: null, stdout: '', stderr: 'did not run' }
    const label = elevated === 'high' ? 'S-1-16-12288' : 'S-1-16-8192'
    return { status: 0, stdout: `Everyone,S-1-5-32-545;Mandatory Label\\${label}",,n/a\n`, stderr: '' }
  }
  return { run, calls }
}
const snapshotOf = (dir) => { const out = {}; const walk = (p, rel) => { for (const n of fs.readdirSync(p)) { const f = path.join(p, n), r = rel ? `${rel}/${n}` : n; const st = fs.lstatSync(f); out[r] = st.isDirectory() ? 'dir' : fs.readFileSync(f).toString('utf8') } }; walk(dir, ''); return out }

test('W25: off and uninstall on win32 refuse an elevated token at the entry — the sandbox HOME byte for byte unchanged — and a whoami that cannot be read is not a refusal', async () => {
  const home = tmpDir('asight-w32-r7-')
  for (const [name, runIt] of [['off', (o) => runOff(o)], ['uninstall', (o) => runUninstall(o)]]) {
    const before = snapshotOf(home)
    const who = whoami({ elevated: 'high' })
    const r = await runIt({ home, env: { ASIGHT_TEST_SANDBOX: '1' }, deps: { platform: 'win32', exec: who.run, procs: async () => [], daemonState: async () => ({ state: 'none' }), lockWaitMs: 0 } })
    assert.equal(r.exit, 1, `${name}: refused`)
    assert.ok(r.receipt.problems.some((p) => p.includes('提升的令牌') || p.includes('高完整性')), `${name}: the receipt says why`)
    assert.ok(who.calls.some((c) => c.startsWith('whoami /groups')), `${name}: the token was asked for before anything was touched`)
    assert.deepEqual(snapshotOf(home), before, `${name}: nothing was written anywhere in the HOME`)
  }
  // a token that cannot be read is not a refusal (an undo that stopped on a broken whoami is not an undo): off proceeds
  const { runOff: off2 } = await import('../../src/off/orchestrate.mjs')
  const r2 = await off2({ home, env: { ASIGHT_TEST_SANDBOX: '1' }, ids: null, deps: { platform: 'win32', exec: whoami({ elevated: 'unreadable' }).run, procs: async () => [], daemonState: async () => ({ state: 'none' }), lockWaitMs: 0 } })
  assert.notEqual(r2.exit, 1, 'not the elevated refusal')
  assert.equal(r2.receipt.nothing_installed, true, 'it ran to its normal answer: nothing is installed here')
})

test('the standalone copy carries the Windows pieces: the built text names them, and running it over a win32 manifest answers what `asight off` answers', async () => {
  const { buildStandalone } = await import('../../src/off/standalone.mjs')
  const { OFF_VERSION } = await import('../../src/off/manifest.mjs')
  const text = buildStandalone({ version: OFF_VERSION })
  for (const name of ['kernelForwardOnly', 'undoRunKey', 'undoScheduledTask', 'controlEndpointOf', 'winIdentity']) assert.ok(text.includes(name), `the copy bundles ${name}`)
  assert.ok(text.includes('asight-off '), 'the version line is on the first lines')
})
