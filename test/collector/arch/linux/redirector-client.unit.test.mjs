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
import { setupHelperCommand } from '../../../../src/version.mjs'

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
        const r = msg && msg.id != null ? reply(msg) : null // null: the helper never answers this one
        if (r) setImmediate(() => stdout.write(JSON.stringify(r) + '\n'))
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

test('binary defaults to the helper path and TROCAR_REDIRECTOR_BIN overrides it', async () => {
  const m1 = mock()
  const c1 = createRedirectorClient({ spawn: m1.spawn, autoHeartbeatMs: 0, env: {} })
  const p1 = c1.start(); m1.pushLine({ ev: 'ready', pid: 1, proto: REDIRECTOR_PROTO }); await p1
  assert.equal(m1.bin, DEFAULT_REDIRECTOR_BIN)
  await c1.close()

  const m2 = mock()
  const c2 = createRedirectorClient({ spawn: m2.spawn, autoHeartbeatMs: 0, env: { TROCAR_REDIRECTOR_BIN: '/opt/red' } })
  const p2 = c2.start(); m2.pushLine({ ev: 'ready', pid: 1, proto: REDIRECTOR_PROTO }); await p2
  assert.equal(m2.bin, '/opt/red')
  await c2.close()
})

// 1.6 §3.2: the reason names the one setup-helper line install and on print (absolute node and trocar.mjs): a script install's root has no trocar on its PATH
test('a missing helper (ENOENT) rejects start with the setup-helper line install prints', async () => {
  const m = mock()
  const c = createRedirectorClient({ binary: '/usr/local/libexec/trocar/trocar-redirector', spawn: m.spawn, autoHeartbeatMs: 0 })
  const p = c.start()
  m.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  await assert.rejects(p, (e) => e.message.includes(setupHelperCommand()))
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
  const { m, c } = await started({ mock: { autoReply: false } }) // a dead helper answers nothing
  const down = once(c, 'down')
  const pending = c.status() // in flight when the pipe breaks
  m.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  assert.match((await down)[0].reason, /loader stdin: EPIPE/)
  await assert.rejects(pending, /redirector loader down: loader stdin: EPIPE/)
})

// D-14: a helper killed while a request is in flight breaks our stdin before its 'exit' arrives; helper-down still
// carries how it ended (the exit name), not only "loader stdin: EPIPE".
test('a helper killed under a write reports its exit (SIGKILL), not just the broken pipe (D-14)', async () => {
  const { m, c } = await started({ mock: { autoReply: false } })
  const down = once(c, 'down')
  const pending = c.status()
  m.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) // the pipe breaks first …
  await new Promise((r) => setImmediate(r))
  m.child.signalCode = 'SIGKILL'; m.child.emit('exit', null, 'SIGKILL') // … then the exit is seen
  const [d] = await down
  assert.deepEqual([d.exit, d.reason], ['SIGKILL', 'loader killed by SIGKILL'])
  await assert.rejects(pending, /loader killed by SIGKILL/)
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

// D-13: a request the helper never answers rejects as loader-timeout (the agent's connection is closed, not hung);
// timing uses a monotonic clock, so a wall-clock jump neither fakes nor hides a heartbeat gap or cuts a lookup short.
test('a request the helper does not answer is loader-timeout after requestTimeoutMs, counted (D-13)', async () => {
  const { c } = await started({ requestTimeoutMs: 40, mock: { reply: (msg) => (msg.op === 'lookup' ? null : replyFor(msg)) } })
  const t0 = Date.now()
  const keepAlive = setTimeout(() => {}, 5000) // the request timer is unref'd: in the daemon the engine keeps the loop alive
  await assert.rejects(c.lookup({ address: '127.0.0.1', port: 5000 }), (e) => e.code === 'loader-timeout' && /did not answer lookup within 40 ms/.test(e.message))
  clearTimeout(keepAlive)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(c.counters.timeouts, 1)
  assert.equal((await c.status()).ok, true, 'answered requests are unaffected')
  await c.close()
})

test('heartbeat gaps and lookup deadlines follow the monotonic clock, not the wall clock (D-13)', async () => {
  let mono = 0
  const { m, c } = await started({ autoHeartbeatMs: 20, clock: () => mono })
  const errs = []; c.on('heartbeat-error', (e) => errs.push(e))
  const keepAlive = setTimeout(() => {}, 5000)
  const realNow = Date.now; Date.now = () => realNow() + 3600e3 // the wall clock jumps an hour ahead
  try {
    await c.attach()
    await new Promise((r) => setTimeout(r, 120))
    assert.deepEqual(errs, [], 'a wall-clock jump is not a gap')
    mono += 2500 // the monotonic clock says 2.5 s passed between two beats: that is a gap
    await new Promise((r) => setTimeout(r, 80))
    assert.deepEqual(errs.map((e) => e.code), ['heartbeat-gap'])
  } finally { Date.now = realNow; clearTimeout(keepAlive) }
  const before = m.frames().filter((f) => f.op === 'lookup').length
  mono = 0
  const pending = c.lookup({ address: '127.0.0.1', port: 6000 }) // lookupWaitMs 200: keeps asking while the clock stands still
  await new Promise((r) => setTimeout(r, 60)); mono = 1e6 // …and stops at the next try once the monotonic deadline is past
  assert.equal(await pending, null)
  assert.ok(m.frames().filter((f) => f.op === 'lookup').length - before >= 2)
  await c.close()
})

// D-14: why the helper went down — its exit code by name and its last stderr lines — goes with the down event.
test('a helper that exits carries the exit name and its last stderr lines into down (D-14)', async () => {
  const m = mock()
  m.child.stderr = new PassThrough()
  const c = createRedirectorClient({ binary: '/x/bin', spawn: m.spawn, autoHeartbeatMs: 0, parentPid: 1234 })
  const down = once(c, 'down')
  const p = c.start().catch(() => {})
  const writes = []; const realWrite = process.stderr.write; process.stderr.write = (x) => { writes.push(String(x)); return true }
  try {
    m.child.stderr.write('trocar-redirector: /sys/fs/cgroup is not a cgroup2 mount (unified hierarchy required)\n')
    await new Promise((r) => setImmediate(r))
    m.child.exitCode = 4; m.child.emit('exit', 4, null)
    const [d] = await down
    assert.deepEqual([d.exit, /exited with code 4 \(environment\)/.test(d.reason), d.stderr], ['environment', true, ['trocar-redirector: /sys/fs/cgroup is not a cgroup2 mount (unified hierarchy required)']])
    assert.ok(writes.some((w) => w.startsWith('[helper] trocar-redirector: /sys/fs/cgroup')), 'still on our stderr')
  } finally { process.stderr.write = realWrite }
  await p
})

// 4.6 §命名空间前提: a helper that cannot number processes the way this namespace does exits 6, and down names it.
test('a helper refusing its namespace (exit 6) goes down with exit namespace', async () => {
  const m = mock()
  const c = createRedirectorClient({ binary: '/x/bin', spawn: m.spawn, autoHeartbeatMs: 0, parentPid: 1234 })
  const down = once(c, 'down')
  const p = c.start().catch(() => {})
  m.child.exitCode = 6; m.child.emit('exit', 6, null)
  const [d] = await down
  assert.equal(d.exit, 'namespace')
  await p
})

// D38: an orderly stop is the daemon's daemon-stop record, never a failure. Measured on Linux 2026-10-30: on stdin EOF the real helper says
// {"ev":"down","reason":"loader exiting"} and exits 0, and that was written as helper-down — a "Problem" in status after every off, logout and unit stop.
test('close(): the helper saying "loader exiting" and exiting 0 is the close, no down; ending any other way during close is still down, with its exit (D38)', async () => {
  const clean = await started()
  const downs = []; clean.c.on('down', (d) => downs.push(d))
  clean.m.child.stdin.end = () => setImmediate(() => { clean.m.pushLine({ ev: 'down', reason: 'loader exiting' }); setImmediate(() => { clean.m.child.exitCode = 0; clean.m.child.emit('exit', 0, null) }) })
  await clean.c.close()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(downs, [], 'an orderly close is not the helper going down')
  for (const [code, signal, exit] of [[9, null, 'code 9'], [null, 'SIGSEGV', 'SIGSEGV']]) {
    const bad = await started()
    const got = once(bad.c, 'down')
    bad.m.child.stdin.end = () => setImmediate(() => { bad.m.pushLine({ ev: 'down', reason: 'loader exiting' }); setImmediate(() => { bad.m.child.exitCode = code; bad.m.child.signalCode = signal; bad.m.child.emit('exit', code, signal) }) })
    await bad.c.close()
    const [d] = await got
    assert.equal(d.exit, exit, `a close that ends with ${signal || `code ${code}`} is reported`)
  }
})

// ── the heartbeat gate (4.6 §开关语义, 1.6 §1.5): before each periodic beat the daemon re-reads state.json, and a stalled loop must
// not beat again until it has ───────────────────────────────────────────────────────────────────────────────────────────────────────
const beatsOf = (m) => m.frames().filter((f) => f.op === 'heartbeat').length
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) } }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('the beat gate: every periodic beat first awaits the gate; false sends none; attach and an explicit heartbeat are not gated', async () => {
  let open = false; let asked = 0
  const { m, c } = await started({ autoHeartbeatMs: 10, beforeBeat: async () => { asked++; return open } })
  const keepAlive = setTimeout(() => {}, 5000)
  await c.attach() // its own beat: the request that follows the operator's `on`
  assert.deepEqual([beatsOf(m), asked], [1, 0])
  await until(() => asked >= 3)
  assert.equal(beatsOf(m), 1, 'the gate said no each time: not one periodic beat')
  await c.heartbeat()
  assert.equal(beatsOf(m), 2, 'an explicit heartbeat is the caller\'s business, not gated')
  open = true
  await until(() => beatsOf(m) >= 4)
  clearTimeout(keepAlive); await c.close()
})

test('the beat gate is not asked again while it is still answering, and no beat goes out until it has said yes', async () => {
  let asked = 0; let answer
  const { m, c } = await started({ autoHeartbeatMs: 10, beforeBeat: () => { asked++; return new Promise((r) => { answer = r }) } })
  const keepAlive = setTimeout(() => {}, 5000)
  await c.attach()
  await pause(80)
  assert.deepEqual([asked, beatsOf(m)], [1, 1], 'one question in flight, ticks that fall inside it are skipped, no beat meanwhile')
  answer(true)
  await until(() => beatsOf(m) === 2)
  clearTimeout(keepAlive); await c.close()
})

test('setBeatGate swaps the gate while running; null removes it; a gate that throws is a heartbeat-error and no beat, and it is asked again next tick', async () => {
  const { m, c } = await started({ autoHeartbeatMs: 10 })
  const keepAlive = setTimeout(() => {}, 5000)
  await c.attach()
  await until(() => beatsOf(m) >= 3) // no gate: beats as before
  c.setBeatGate(() => false)
  await pause(30); const stopped = beatsOf(m)
  await pause(80)
  assert.equal(beatsOf(m), stopped, 'a closed gate: the beats stop')
  const errs = []; c.on('heartbeat-error', (e) => errs.push(e))
  let n = 0; c.setBeatGate(() => { n++; throw new Error('state.json is a directory') })
  await until(() => n >= 2)
  assert.equal(beatsOf(m), stopped, 'a gate that cannot answer sends nothing: the steering lapses (fail open) rather than holding on')
  assert.deepEqual([errs[0].code, /beat gate.*state\.json is a directory/.test(errs[0].reason)], ['heartbeat-failed', true])
  c.setBeatGate(null)
  await until(() => beatsOf(m) > stopped)
  clearTimeout(keepAlive); await c.close()
})
