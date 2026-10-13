// test/collector/arch/linux/redirector-adapter.test.mjs — the Linux Redirector adapter over the fake helper
// (a real spawned process speaking the helper's line protocol; no root, no eBPF).
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRedirectorClient } from '../../../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector, lingerRead, lingerState } from '../../../../src/collector/arch/linux/redirector.mjs'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { createCa } from '../../../../src/collector/core/tls/ca.mjs'
import { fakeProc } from './fixtures/fake-proc.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-loader.mjs', import.meta.url))
function rig(p, { autoHeartbeatMs = 0 } = {}) {
  const clients = []
  const makeClient = () => {
    const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs })
    clients.push(c)
    return c
  }
  return { clients, r: createLinuxRedirector({ makeClient, procRoot: p.root, uid: 1000 }) }
}

test('adapter: an exec of this uid becomes ProcFacts; other users and vanished pids are dropped', async () => {
  const p = fakeProc(); const { r, clients } = rig(p)
  try {
    p.add(500, { uid: 1000, exe: '/opt/alpha', argv: ['alpha', 'x'], cwd: '/w' })
    p.add(501, { uid: 0, exe: '/opt/alpha' })
    await r.start()
    const seen = []
    r.on('exec', (f) => seen.push(f))
    for (const tgid of [501, 999, 500]) await clients[0].raw({ op: '__emit', ev: 'exec', tgid, pid: tgid, comm: 'alpha', filename: '/opt/alpha', ts_ns: 1 })
    await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(seen.map((f) => [f.pid, f.source, f.exe, f.argv[1], f.cwd, f.os]), [[500, 'exec', '/opt/alpha', 'x', '/w', 'linux']])
    const exits = []
    r.on('exit', (e) => exits.push(e))
    await clients[0].raw({ op: '__emit', ev: 'exit', tgid: 500, ts_ns: 2 })
    await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(exits, [{ pid: 500 }])
  } finally { await r.close(); p.done() }
})

test('adapter: scan lists only this uid\'s processes; directCount reads the OS', async () => {
  const p = fakeProc(); const { r } = rig(p)
  try {
    p.add(600, { uid: 1000 }); p.add(601, { uid: 1000 }); p.add(602, { uid: 33 })
    assert.deepEqual((await r.scan()).map((f) => [f.pid, f.source]).sort(), [[600, 'scan'], [601, 'scan']])
    assert.deepEqual(r.directCount(600), { count: 0, error: null })
    const fs = await import('node:fs'), path = await import('node:path')
    fs.mkdirSync(path.join(p.root, '601', 'fd')); fs.chmodSync(path.join(p.root, '601', 'fd'), 0)
    assert.deepEqual(r.directCount(601), { count: null, error: 'EACCES' }, 'unknown with the errno, never 0 (D-17)')
    fs.chmodSync(path.join(p.root, '601', 'fd'), 0o700)
  } finally { p.done() }
})

test('adapter: configure/attach reach the helper; a helper death is reported as down and calls then fail', async () => {
  const p = fakeProc(); const { r, clients } = rig(p)
  try {
    const info = await r.start()
    assert.equal(info.pid, clients[0]._child.pid)
    assert.equal(r.helperInfo().proto, r.expectedProto)
    await r.configure(43210)
    await r.attach()
    assert.deepEqual([(await r.status()).engine_port, (await r.status()).attached], [43210, true])
    const down = once(r, 'down')
    clients[0]._child.kill('SIGKILL')
    const [{ reason }] = await down
    assert.match(reason, /SIGKILL/)
    await assert.rejects(r.status(), /not running/)
  } finally { await r.close(); p.done() }
})

test('arch: the wired platforms answer; another is a clear error', async () => {
  assert.equal((await loadArch('linux')).os, 'linux')
  const linux = await loadArch('linux')
  const fedora = '/etc/pki/tls/certs/ca-bundle.crt', pem = createCa({ commonName: 'a Fedora root' }).certPem
  const read = (f) => { if (f === fedora) return pem; throw Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' }) }
  assert.deepEqual([linux.osRootsFile, linux.osRoots({ read }).file], [undefined, fedora], 'the OS roots combined bundles start from are read, the first OS bundle this machine has (4.6 合并包)')
  assert.equal((await loadArch('darwin')).os, 'darwin', '4.9: darwin is wired too (proxy mode, the shape of 4.8\'s win32)')
  await assert.rejects(loadArch('freebsd'), /freebsd is not supported yet/)
})

test('adapter: helper and heartbeat errors are forwarded for the daemon to record (D38)', async () => {
  const p = fakeProc(); const { r, clients } = rig(p)
  try {
    await r.start()
    const got = []
    r.on('helper-error', (m) => got.push(['helper', m.reason])); r.on('heartbeat-error', (m) => got.push(['heartbeat', m.reason]))
    await clients[0].raw({ op: '__emit', ev: 'error', reason: 'ringbuf poll failed' })
    clients[0].emit('heartbeat-error', { reason: 'timeout' })
    await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(got.sort(), [['heartbeat', 'timeout'], ['helper', 'ringbuf poll failed']])
  } finally { await r.close(); p.done() }
})

// D-22 (4.6 OPEN 登出后): whether logind keeps the daemon after logout, said in daemon-start — never guessed.
test('adapter: linger() is true with the logind marker, false without, null when it cannot be told', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-linger-'))
  try {
    const r = (o) => createLinuxRedirector({ makeClient: () => null, procRoot: dir, uid: 1000, lingerDir: dir, ...o })
    assert.equal(r({ userName: () => 'u' }).linger(), false)
    fs.writeFileSync(path.join(dir, 'u'), '')
    assert.equal(r({ userName: () => 'u' }).linger(), true)
    assert.equal(r({ lingerDir: path.join(dir, 'u', 'x'), userName: () => 'u' }).linger(), null, 'ENOTDIR: unknown, not "off"')
    // 1.6 §1.1 / V39: the same reading as plain functions (what `asight on` and `asight status` call), and a null that says why: the file and the errno
    assert.deepEqual([lingerState({ user: 'u', dir }), lingerState({ user: 'nobody', dir })], [true, false])
    assert.deepEqual(lingerRead({ user: 'u', dir }), { state: true })
    const unreadable = lingerRead({ user: 'u', dir: path.join(dir, 'u', 'x') })
    assert.equal(unreadable.state, null); assert.match(unreadable.error, new RegExp(`${path.join(dir, 'u', 'x', 'u').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ENOTDIR`))
    assert.equal(lingerState({ user: 'u', dir: path.join(dir, 'u', 'x') }), null)
    assert.equal(r({ userName: () => 'u' }).lingerRead().state, true, 'the adapter has it too (the daemon\'s own redirector is what asight on asks)')
    assert.match(r({ userName: () => { throw new Error('no passwd entry') } }).lingerRead().error, /no passwd entry/, 'a user name that cannot be read is unknown, with the reason')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// Review B-1 (4.6 exe-unreadable): the facts-error carries what is still readable; the helper's own pid is ours, never a
// finding; unreadable() lists what a scan saw (a pid that exited, or that a later scan no longer finds, is gone from it).
test('adapter: facts-error carries comm and the command line; the helper\'s own pid is not reported; unreadable() follows exits and scans', async () => {
  const fs = await import('node:fs'), path = await import('node:path')
  const p = fakeProc(); const { r, clients } = rig(p)
  const unreadableExe = (pid, argv, comm) => { p.add(pid, { uid: 1000, exe: '/x/y', argv, comm }); fs.rmSync(path.join(p.root, String(pid), 'exe')); fs.mkdirSync(path.join(p.root, String(pid), 'exe')) }
  try {
    await r.start()
    const helper = clients[0].loaderInfo.pid
    unreadableExe(710, ['sshd: u@notty'], 'sshd'); unreadableExe(711, ['(sd-pam)'], '(sd-pam)'); unreadableExe(helper, ['asight-redirector', '--parent-pid', '1'], 'asight-redirect')
    const errs = []; r.on('facts-error', (x) => errs.push(x))
    assert.deepEqual(await r.scan(), [], 'nothing readable')
    assert.deepEqual(errs.map((x) => [x.os, x.pid, x.comm, x.argv]).sort((a, b) => a[1] - b[1]), [['linux', 710, 'sshd', ['sshd: u@notty']], ['linux', 711, '(sd-pam)', ['(sd-pam)']]], 'the helper is not among them')
    assert.deepEqual(r.unreadable().map((u) => [u.pid, u.comm, u.errno]).sort(), [[710, 'sshd', 'EINVAL'], [711, '(sd-pam)', 'EINVAL']])
    await clients[0].raw({ op: '__emit', ev: 'exit', tgid: 710, ts_ns: 3 }); await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(r.unreadable().map((u) => u.pid), [711], 'an exit takes it out')
    for (const g of ['710', '711']) fs.rmSync(path.join(p.root, g), { recursive: true }); await r.scan()
    assert.deepEqual(r.unreadable(), [], 'a scan names the ones that are there now')
  } finally { await r.close(); p.done() }
})

// D-30: an exec of this user's process whose exe cannot be read is a facts-error, not a dropped event.
test('adapter: a process of this uid whose exe is unreadable is a facts-error with the errno; one that is gone is not', async () => {
  const fs = await import('node:fs'), path = await import('node:path')
  const p = fakeProc(); const { r, clients } = rig(p)
  try {
    p.add(700, { uid: 1000 }); fs.rmSync(path.join(p.root, '700', 'exe')); fs.mkdirSync(path.join(p.root, '700', 'exe')) // readlink: EINVAL, not "gone"
    await r.start()
    const errs = [], execs = []
    r.on('facts-error', (x) => errs.push(x)); r.on('exec', (f) => execs.push(f.pid))
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 700, pid: 700, comm: 'sudo', filename: '/usr/bin/sudo' })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 799, pid: 799, comm: 'gone', filename: '/bin/true' }) // exited already
    await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(execs, [])
    assert.deepEqual(errs.map((x) => [x.pid, x.code, /\/proc\/700\/exe of sudo is unreadable/.test(x.reason)]), [[700, 'EINVAL', true]])
  } finally { await r.close(); p.done() }
})

test('adapter: setBeatGate reaches the client it will make, and the one already running (the daemon sets it before start; a test may after)', async () => {
  const p = fakeProc(); const { r, clients } = rig(p, { autoHeartbeatMs: 10 })
  const beats = async () => (await clients[0].raw({ op: '__oplog' })).log.filter((o) => o === 'heartbeat').length
  const keepAlive = setTimeout(() => {}, 5000)
  try {
    let open = false
    r.setBeatGate(async () => open)
    await r.start(); await r.configure(1); await r.attach()
    await new Promise((res) => setTimeout(res, 80))
    assert.equal(await beats(), 1, 'the gate set before start is in force: only attach\'s own beat')
    open = true
    await new Promise((res) => setTimeout(res, 80))
    assert.ok(await beats() > 2)
    r.setBeatGate(() => false) // swapped on the running client
    await new Promise((res) => setTimeout(res, 30)); const stopped = await beats()
    await new Promise((res) => setTimeout(res, 80))
    assert.equal(await beats(), stopped)
  } finally { clearTimeout(keepAlive); await r.close(); p.done() }
})
