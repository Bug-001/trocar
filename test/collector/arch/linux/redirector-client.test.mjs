import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createRedirectorClient } from '../../../../src/collector/arch/linux/redirector-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(here, 'fixtures', 'fake-loader.mjs')

// The fake loader IS a real spawned Node process speaking the exact line protocol, so these
// tests cover spawn + readline + id-correlation + the lookup wait, with no root and no eBPF.
function makeClient(opts = {}) {
  return createRedirectorClient({ binary: process.execPath, args: [FAKE], autoHeartbeatMs: 0, lookupWaitMs: 200,
    env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, ...opts })
}

test('start resolves on ready; status round-trips the kernel-derived object', async () => {
  const c = makeClient()
  await c.start()
  await c.configure(8443)
  await c.attach()
  await c.heartbeat()
  const s = await c.status()
  assert.equal(s.attached, true)
  assert.equal(s.engine_port, 8443)
  assert.deepEqual(s.links.map((l) => l.name), ['connect4', 'connect6', 'sockops'])
  await c.detach()
  assert.equal((await c.status()).attached, false)
  await c.close()
})

test('watch records the agent label; lookup joins it onto the kernel row', async () => {
  const c = makeClient()
  await c.start()
  await c.watch(4242, { decrypt: true, agent: 'claude-code' })
  // kernel (fake) now has a by_port row for the client source port 50000 -> real upstream
  await c.raw({ op: '__inject_port', port: 50000, dst: { address: '203.0.113.7', port: 443, family: 4 }, pid: 4242, decrypt: 1 })
  const meta = await c.lookup({ address: '127.0.0.1', port: 50000 })
  assert.deepEqual(meta, {
    dst: { address: '203.0.113.7', port: 443, family: 4 },
    pid: 4242,
    agent: 'claude-code',
    decrypt: true,
  })
  await c.close()
})

test('lookup for an unknown port resolves null after the wait window', async () => {
  const c = makeClient({ lookupWaitMs: 80 })
  await c.start()
  const t0 = Date.now()
  const meta = await c.lookup({ address: '127.0.0.1', port: 51111 })
  assert.equal(meta, null)
  assert.ok(Date.now() - t0 >= 70, 'waited roughly the window before giving up')
  await c.close()
})

test('lookup resolves a port that appears late (within the wait window)', async () => {
  const c = makeClient({ lookupWaitMs: 400 })
  await c.start()
  await c.raw({ op: '__inject_port', port: 52222, dst: { address: '198.51.100.9', port: 8080, family: 4 }, pid: 7, decrypt: 0, after: 90 })
  const meta = await c.lookup({ address: '127.0.0.1', port: 52222 })
  assert.ok(meta, 'resolved after the row appeared')
  assert.equal(meta.pid, 7)
  assert.equal(meta.decrypt, false)
  assert.equal(meta.agent, null) // no watch label for pid 7
  await c.close()
})

test('lookup sends the peer address family; a v4 row is not returned for a v6 peer on the same port', async () => {
  const c = makeClient({ lookupWaitMs: 60 })
  await c.start()
  // Only a v4 row exists for source port 50505.
  await c.raw({ op: '__inject_port', port: 50505, family: 4, dst: { address: '203.0.113.9', port: 443, family: 4 }, pid: 11, decrypt: 1 })
  // A v6 peer on the same source port must NOT join onto the v4 row.
  const miss = await c.lookup({ address: '::1', port: 50505 })
  assert.equal(miss, null, 'v6 lookup did not match the v4 row')
  // The v4 peer joins it.
  const hit = await c.lookup({ address: '127.0.0.1', port: 50505 })
  assert.ok(hit && hit.pid === 11, 'v4 lookup matched the v4 row')
  await c.close()
})

test('exec/exit/flow-meta/down events are emitted; id-correlation survives interleaved events', async () => {
  const c = makeClient()
  await c.start()
  const execP = once(c, 'exec')
  const flowP = once(c, 'flow-meta')
  const exitP = once(c, 'exit')
  // Fire async events AND a request that must still correlate by id.
  await c.raw({ op: '__emit', ev: 'exec', tgid: 900, pid: 900, comm: 'claude', filename: '/x/claude', ts_ns: 1 })
  await c.raw({ op: '__emit', ev: 'flow', pid: 901, dst: { address: '10.0.0.1', port: 443, family: 4 }, ts_ns: 2 })
  await c.raw({ op: '__emit', ev: 'exit', tgid: 900, ts_ns: 3 })
  const [[execEv], [flowEv], [exitEv]] = await Promise.all([execP, flowP, exitP])
  assert.equal(execEv.tgid, 900)
  assert.equal(execEv.comm, 'claude')
  assert.deepEqual(flowEv.dst, { address: '10.0.0.1', port: 443, family: 4 })
  assert.equal(exitEv.tgid, 900)
  // status still works after the event burst (id correlation intact)
  assert.equal((await c.status()).attached, false)
  await c.close()
})

test('unexpected loader exit emits down and rejects pending calls', async () => {
  const c = makeClient()
  await c.start()
  const downP = once(c, 'down')
  c._child.kill('SIGKILL')
  const [ev] = await downP
  assert.ok(ev.reason)
  await assert.rejects(() => c.status())
  await c.close()
})
