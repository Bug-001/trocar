// Unit tests for the D36 client-side contract of redirector-client.mjs, with a mock spawn (no
// real process, no root). They assert the exact wire frames and spawn argv so the client's half
// of the protocol is pinned: config carries no engine_uid, --parent-pid is passed, the default
// binary + env override resolve, a missing helper gives a setup-helper error, a version skew
// fails open, watch(self) is refused, and lookup carries the peer family.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createRedirectorClient, REDIRECTOR_PROTO, DEFAULT_REDIRECTOR_BIN } from '../../../../src/collector/arch/linux/redirector-client.mjs'

function replyFor(msg) {
  if (msg.op === 'lookup') return { id: msg.id, ok: true, found: false, dst: null, pid: null, decrypt: 0 }
  return { id: msg.id, ok: true }
}

// A mock child process whose stdout is a real stream (so the client's readline works) and whose
// stdin captures every frame. autoReply answers each request with ok so client promises resolve.
function mock({ autoReply = true, reply = replyFor } = {}) {
  const stdout = new PassThrough()
  const writes = []
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdout = stdout
  child.kill = (sig) => { child.signalCode = sig || 'SIGTERM'; child.emit('exit', null, child.signalCode) }
  let spawnBin = null, spawnArgs = null
  child.stdin = Object.assign(new EventEmitter(), {
    write(line, cb) {
      writes.push(line)
      if (autoReply) {
        let msg; try { msg = JSON.parse(line) } catch {}
        if (msg && msg.id != null) setImmediate(() => stdout.write(JSON.stringify(reply(msg)) + '\n'))
      }
      if (cb) cb()
      return true
    },
    // The real loader exits on stdin EOF; simulate that so close() resolves.
    end() { setImmediate(() => { if (child.exitCode == null && child.signalCode == null) { child.exitCode = 0; child.emit('exit', 0, null) } }) },
  })
  const spawn = (bin, args) => { spawnBin = bin; spawnArgs = args; return child }
  const pushLine = (obj) => stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n')
  return {
    child, writes, spawn, pushLine,
    frames: () => writes.map((w) => JSON.parse(w)),
    get bin() { return spawnBin }, get args() { return spawnArgs },
  }
}

async function started(opts = {}) {
  const m = mock(opts.mock)
  const c = createRedirectorClient({ binary: '/x/bin', spawn: m.spawn, autoHeartbeatMs: 0, parentPid: 1234, ...opts })
  const p = c.start()
  m.pushLine({ ev: 'ready', pid: 7, proto: REDIRECTOR_PROTO, build: 'test' })
  await p
  return { m, c }
}

test('configure sends engine_port and no engine_uid', async () => {
  const { m, c } = await started()
  await c.configure(8443)
  const cfg = m.frames().find((f) => f.op === 'config')
  assert.equal(cfg.engine_port, 8443)
  assert.ok(!('engine_uid' in cfg), 'config frame must not carry engine_uid (D36)')
  await c.close()
})

test('start passes --parent-pid after any script args, and spawns the configured binary', async () => {
  const m = mock()
  const c = createRedirectorClient({ binary: 'node', args: ['loader.mjs'], spawn: m.spawn, parentPid: 4321, autoHeartbeatMs: 0 })
  const p = c.start(); m.pushLine({ ev: 'ready', pid: 1, proto: REDIRECTOR_PROTO }); await p
  assert.equal(m.bin, 'node')
  assert.deepEqual(m.args, ['loader.mjs', '--parent-pid', '4321'])
  await c.close()
})

test('binary defaults to the helper path and ASIGHT_REDIRECTOR_BIN overrides it', async () => {
  const m1 = mock()
  const c1 = createRedirectorClient({ spawn: m1.spawn, autoHeartbeatMs: 0, env: {} })
  const p1 = c1.start(); m1.pushLine({ ev: 'ready', pid: 1, proto: REDIRECTOR_PROTO }); await p1
  assert.equal(m1.bin, DEFAULT_REDIRECTOR_BIN)
  await c1.close()

  const m2 = mock()
  const c2 = createRedirectorClient({ spawn: m2.spawn, autoHeartbeatMs: 0, env: { ASIGHT_REDIRECTOR_BIN: '/opt/red' } })
  const p2 = c2.start(); m2.pushLine({ ev: 'ready', pid: 1, proto: REDIRECTOR_PROTO }); await p2
  assert.equal(m2.bin, '/opt/red')
  await c2.close()
})

test('a missing helper (ENOENT) rejects start with a clear setup-helper message', async () => {
  const m = mock()
  const c = createRedirectorClient({ binary: '/usr/local/libexec/asight/asight-redirector', spawn: m.spawn, autoHeartbeatMs: 0 })
  const p = c.start()
  m.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  await assert.rejects(p, /install it once per machine with "sudo asight setup-helper"/)
})

test('a protocol-version mismatch fails open: start still resolves, a warning fires, ops still work', async () => {
  const m = mock()
  const c = createRedirectorClient({ binary: '/x/bin', spawn: m.spawn, autoHeartbeatMs: 0 })
  const vmP = once(c, 'version-mismatch')
  const p = c.start()
  m.pushLine({ ev: 'ready', pid: 1, proto: REDIRECTOR_PROTO + 999, build: 'newer' })
  const ready = await p
  assert.equal(ready.proto, REDIRECTOR_PROTO + 999)
  const [vm] = await vmP
  assert.equal(vm.got, REDIRECTOR_PROTO + 999)
  assert.equal(vm.expected, REDIRECTOR_PROTO)
  const s = await c.status() // still operational
  assert.equal(s.ok, true)
  await c.close()
})

test('watch refuses this engine process (self)', async () => {
  const { c } = await started()
  await assert.rejects(() => c.watch(process.pid), /self/)
  await c.close()
})

test('lookup carries the peer address family (v6 vs v4)', async () => {
  const { m, c } = await started({ lookupWaitMs: 0 })
  await c.lookup({ address: '::1', port: 5000 })
  await c.lookup({ address: '127.0.0.1', port: 5001 })
  const looks = m.frames().filter((f) => f.op === 'lookup')
  assert.equal(looks[0].family, 6)
  assert.equal(looks[0].port, 5000)
  assert.equal(looks[1].family, 4)
  assert.equal(looks[1].port, 5001)
  await c.close()
})

test('attach sends a heartbeat before the attach frame, so steering is live when attach resolves', async () => {
  const { m, c } = await started({ autoHeartbeatMs: 60000 }) // the periodic beat would come a minute later
  await c.attach()
  const ops = m.frames().map((f) => f.op)
  assert.deepEqual(ops.slice(ops.indexOf('heartbeat')), ['heartbeat', 'attach'], 'a heartbeat, then attach, and nothing waits for the interval')
  await c.close()
})

test('a helper that dies under a write (stdin EPIPE) is reported down, never an uncaught exception', async () => {
  const { m, c } = await started()
  const down = once(c, 'down')
  const pending = c.status() // in flight when the pipe breaks
  m.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  assert.match((await down)[0].reason, /loader stdin: EPIPE/)
  await assert.rejects(pending, /redirector loader down: loader stdin: EPIPE/)
})

test('a failed periodic heartbeat is reported (heartbeat-error), never swallowed (D38)', async () => {
  const { c } = await started({ autoHeartbeatMs: 20, mock: { reply: (msg) => (msg.op === 'heartbeat' && msg.id > 3 ? { id: msg.id, ok: false, error: 'config map write failed' } : replyFor(msg)) } })
  const got = once(c, 'heartbeat-error')
  const keepAlive = setTimeout(() => {}, 5000) // the client's beat timer is unref'd
  await c.attach() // its own first beat succeeds; the periodic ones fail
  assert.deepEqual((await got)[0], { code: 'heartbeat-failed', reason: 'config map write failed' })
  clearTimeout(keepAlive); await c.close()
})

test('beats further apart than the kernel freshness window (a stalled event loop) are reported too (D38)', async () => {
  const { c } = await started({ autoHeartbeatMs: 20 })
  const got = once(c, 'heartbeat-error')
  const keepAlive = setTimeout(() => {}, 5000)
  await c.attach()
  const until = Date.now() + 2100; while (Date.now() < until) { /* block the event loop past 2 s */ }
  assert.match((await got)[0].reason, /^no heartbeat for \d+ ms \(the kernel stops steering after 2000 ms\); connections in that window went direct$/)
  assert.equal((await got)[0].code, 'heartbeat-gap')
  clearTimeout(keepAlive); await c.close()
})

test('a line from the helper that is not JSON, or an event this client does not know, is reported (loader-error), never dropped (D38)', async () => {
  const { m, c } = await started()
  const seen = []; c.on('loader-error', (e) => seen.push(e.reason))
  m.pushLine('{"ev":"exec","tgid":12') // torn
  m.pushLine({ ev: 'quota', n: 1 })
  m.pushLine({ id: 999, ok: true }) // a reply nobody waits for is not an event
  await c.status() // a round trip: every line above has been read
  assert.deepEqual(seen, ['unparsable line from the helper, ignored: {"ev":"exec","tgid":12', 'unknown helper event "quota", ignored (a helper newer than this daemon?)'])
  await c.close()
})

test('lookup rejects when the helper cannot be asked — a transport error is never read as a miss (D38)', async () => {
  const { m, c } = await started({ lookupWaitMs: 0, mock: { reply: (msg) => (msg.op === 'lookup' ? { id: msg.id, ok: false, error: 'by_port map read failed' } : replyFor(msg)) } })
  await assert.rejects(c.lookup({ address: '127.0.0.1', port: 5002 }), /by_port map read failed/)
  m.child.kill()
  await assert.rejects(c.lookup({ address: '127.0.0.1', port: 5003 }))
})
