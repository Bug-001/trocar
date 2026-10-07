// test/health/read.test.mjs — whether the collector daemon runs, judged from its lock alone (D38 D-25; RFC 4.6
// §控制面): pid + start time + boot id must all match and the mtime must be fresh; a reused pid, a reboot, a stuck
// daemon and an unreadable lock are each said, never shown as "running".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockState, procIdentity, captureHealth, LOCK_FRESH_MS } from '../../src/health/read.mjs'

function box() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-lock-')); return { dir, file: path.join(dir, 'lock'), done: () => fs.rmSync(dir, { recursive: true, force: true }) } }
const LOCK = { pid: 4242, start_time: '9000', boot_id: 'b-1', helper_pid: 4243, engine_port: 7000, socket: '/run/s' }
const same = () => ({ start_time: '9000', boot_id: 'b-1' })

test('lockState: none / running / unresponsive / stale (pid dead, reused, rebooted) / unknown', () => {
  const b = box()
  try {
    const now = Date.now()
    assert.deepEqual(lockState({ file: b.file }), { state: 'none' })
    fs.writeFileSync(b.file, JSON.stringify(LOCK))
    const st = (o) => lockState({ file: b.file, now, alive: () => true, identity: same, ...o })
    assert.equal(st().state, 'running')
    fs.utimesSync(b.file, new Date(now - LOCK_FRESH_MS - 1000), new Date(now - LOCK_FRESH_MS - 1000))
    assert.deepEqual([st().state, st().age_ms >= LOCK_FRESH_MS], ['unresponsive', true], 'a stuck daemon: alive, not refreshing')
    fs.utimesSync(b.file, new Date(now), new Date(now))
    assert.match(st({ alive: () => false }).why, /pid 4242 is not running/)
    const reused = st({ identity: () => ({ start_time: '123', boot_id: 'b-1' }) })
    assert.deepEqual([reused.state, /another process now/.test(reused.why)], ['stale', true], 'pid reused after kill -9')
    const rebooted = st({ identity: () => ({ start_time: '9000', boot_id: 'b-2' }) })
    assert.deepEqual([rebooted.state, /rebooted/.test(rebooted.why)], ['stale', true], 'a lock that survived a reboot')
    assert.deepEqual([st({ identity: () => ({ start_time: null, boot_id: null }) }).state, st({ identity: () => ({ start_time: null, boot_id: null }) }).verified], ['running', false], 'no /proc to check against: said, not hidden')
    fs.writeFileSync(b.file, '{"pid": 42')
    const cut = st()
    assert.deepEqual([cut.state, /not valid JSON/.test(cut.error)], ['unknown', true], 'a lock cut short')
    fs.rmSync(b.file); fs.mkdirSync(b.file)
    assert.equal(st().state, 'unknown', 'an unreadable lock is "state unknown", never "not running"')
  } finally { b.done() }
})

test('procIdentity reads /proc/<pid>/stat field 22 and the boot id; nothing readable is null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-proc-'))
  try {
    fs.mkdirSync(path.join(root, '77')); fs.writeFileSync(path.join(root, '77', 'stat'), `77 (a b) c) S 1 ${'0 '.repeat(17)}31337 0 0\n`)
    fs.mkdirSync(path.join(root, 'sys', 'kernel', 'random'), { recursive: true }); fs.writeFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), 'abc-def\n')
    assert.deepEqual(procIdentity(77, { root }), { start_time: '31337', boot_id: 'abc-def' })
    assert.deepEqual(procIdentity(78, { root }), { start_time: null, boot_id: 'abc-def' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ── the switch as state.json version 2 says it (1.6 §1.5; the board's "capture off since T") ──────────────────────────────────────
test('captureHealth reads state.json per harness: all on → on, none → off, some → mixed, with since = the newest per-harness updated_at; version 1 still reads', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-sw-read-'))
  const dir = path.join(home, 'collector'); fs.mkdirSync(dir, { recursive: true })
  const put = (v) => fs.writeFileSync(path.join(dir, 'state.json'), typeof v === 'string' ? v : JSON.stringify(v))
  const sw = () => captureHealth({ home, now: Date.parse('2026-10-07T12:00:00Z'), alive: () => false }).collector.switch
  try {
    assert.deepEqual(sw(), { desired: 'off', since: null, harnesses: {} }, 'never switched: off, and it says since nowhere')
    put({ version: 2, updated_at: 'T9', harnesses: { a: { desired: 'on', updated_at: 'T1' }, b: { desired: 'on', updated_at: 'T3' } } })
    assert.deepEqual(sw(), { desired: 'on', since: 'T3', harnesses: { a: { desired: 'on', updated_at: 'T1' }, b: { desired: 'on', updated_at: 'T3' } } })
    put({ version: 2, updated_at: 'T9', harnesses: { a: { desired: 'on', updated_at: 'T1' }, b: { desired: 'off', updated_at: 'T2' } } })
    assert.deepEqual([sw().desired, sw().since, sw().harnesses.b], ['mixed', 'T2', { desired: 'off', updated_at: 'T2' }])
    put({ version: 2, updated_at: 'T9', harnesses: { a: { desired: 'off', updated_at: 'T5' }, b: { desired: 'off', updated_at: 'T4' } } })
    assert.deepEqual([sw().desired, sw().since], ['off', 'T5'], 'capture off since the last harness went off')
    put({ version: 2, updated_at: 'T9', harnesses: {} })
    assert.deepEqual([sw().desired, sw().since], ['off', 'T9'], 'no harness recorded: the file\'s own time')
    put({ version: 1, desired: 'on', updated_at: 'T7' })
    assert.deepEqual([sw().desired, sw().since, 'harnesses' in sw()], ['on', 'T7', false], 'a version 1 file left by an older daemon')
    put({ desired: 'off', updated_at: 'T6' })
    assert.deepEqual([sw().desired, sw().since], ['off', 'T6'])
    for (const bad of ['{ torn', '[]', JSON.stringify({ version: 3, harnesses: {} })]) {
      put(bad)
      const h = captureHealth({ home, now: Date.now(), alive: () => false })
      assert.deepEqual([h.collector.switch.desired, typeof h.collector.switch.error, h.read.errors.length], [null, 'string', 1], `${bad}: unreadable is said, never "off"`)
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
