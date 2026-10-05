// test/collector/arch/linux/redirector-adapter.test.mjs — the Linux Redirector adapter over the fake helper
// (a real spawned process speaking the helper's line protocol; no root, no eBPF).
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRedirectorClient } from '../../../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../../../src/collector/arch/linux/redirector.mjs'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { fakeProc } from './fixtures/fake-proc.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-loader.mjs', import.meta.url))
function rig(p) {
  const clients = []
  const makeClient = () => {
    const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 })
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
    assert.equal(r.directCount(600), 0)
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

test('arch: only Linux is wired; another platform is a clear error', async () => {
  assert.equal((await loadArch('linux')).os, 'linux')
  assert.equal((await loadArch('linux')).osRootsFile, '/etc/ssl/certs/ca-certificates.crt', 'the OS bundle combined bundles start from (4.6 合并包)')
  await assert.rejects(loadArch('darwin'), /darwin is not supported yet/)
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
