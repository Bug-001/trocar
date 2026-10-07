// test/collector/arch/win32/helper.test.mjs — RFC 4.8 §1, §5.3, §10.1: the resident read-only helper's client, the process watcher
// and the socket-table pid lookup (W1, W2, W4). Nothing here runs Windows or a real powershell: the helper is the Node child
// in fixtures/fake-helper.mjs speaking the same JSON-lines protocol, or an in-process object with the same `call()`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { HELPER_VERBS, HELPER_PS1, REG_READ_ALLOW, startHelper } from '../../../../src/collector/arch/win32/helper.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url))
const fakeSpawn = (fixture) => (exe, args, opts) => spawn(process.execPath, [FAKE, JSON.stringify(fixture)], { ...opts, env: { ...process.env, ASIGHT_FAKE_HELPER: '1' } })
/** A child that never ran: what `spawn` hands back when the program is not there (it emits 'error' next tick). */
function ghostChild(emit) {
  const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true })
  process.nextTick(() => emit(c))
  return c
}
/** startHelper over the fake; every failure record and every exit is kept for the assertions; closed when the test ends. */
function started(t, fixture, opts = {}) {
  const seen = { failures: [], exits: [] }
  const h = startHelper({ spawn: fakeSpawn(fixture), onFailure: (r) => seen.failures.push(r), onExit: (x) => seen.exits.push(x), ...opts })
  t.after(() => h.close())
  return Object.assign(h, seen)
}
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true })

// ---------- W1: the helper is read-only, and its verb set is closed ----------

test('W1 the verb set is the closed list, frozen', () => {
  assert.deepEqual([...HELPER_VERBS], ['ps', 'tcp-table', 'reg-read', 'net-if', 'route', 'token', 'roots', 'pipe-server', 'version'])
  assert.ok(Object.isFrozen(HELPER_VERBS))
  assert.ok(HELPER_PS1.endsWith('helper.ps1'))
})

test('W1 an unknown verb is rejected in JS: no line reaches the helper', async (t) => {
  const log = path.join(tmpDir('asight-helper-'), 'in.log')
  const h = started(t, { log })
  await h.call('version')
  for (const verb of ['rm', 'Set-ItemProperty', 'toString', '__proto__', '', undefined, 7, 'ps ']) await rejects(h.call(verb), 'helper-unknown-verb')
  assert.deepEqual(lines(log).map((l) => l.verb), ['version'], 'only the allowed verb was written')
  assert.equal(h.failures.length, 0, 'a refused verb is the caller\'s mistake, not a helper failure')
})

test('W1 reg-read: only the three allowed keys and their names go through, checked in JS before any write', async (t) => {
  const log = path.join(tmpDir('asight-helper-'), 'in.log')
  const h = started(t, { log, verbs: { 'reg-read': { data: { keyExists: true, values: {} } } } })
  const IS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const SAC = 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'
  const ok = [
    { hive: 'HKCU', key: IS, names: ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'] },
    { hive: 'hkcu', key: IS.toLowerCase() + '\\', names: ['proxyserver'] }, // case and a trailing backslash are not a way round the list
    { hive: 'HKCU', key: 'Software/Microsoft/Windows/CurrentVersion/Internet Settings', names: ['ProxyServer'] },
    { hive: 'HKCU', key: 'Environment', names: ['Path'] },
    { hive: 'HKLM', key: SAC, names: ['VerifiedAndReputablePolicyState'] },
  ]
  for (const a of ok) await h.call('reg-read', a)
  const bad = [
    { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', names: ['x'] },
    { hive: 'HKCU', key: 'Environment', names: ['TEMP'] }, // only Path of Environment: not the CA variables, not the whole block
    { hive: 'HKCU', key: 'Environment', names: ['Path', 'NODE_EXTRA_CA_CERTS'] },
    { hive: 'HKCU', key: 'Environment', names: [] }, // no names = everything: refused
    { hive: 'HKLM', key: 'Environment', names: ['Path'] },
    { hive: 'HKCU', key: SAC, names: ['VerifiedAndReputablePolicyState'] },
    { hive: 'HKLM', key: IS, names: ['ProxyServer'] },
    { hive: 'HKU', key: 'Environment', names: ['Path'] },
    { hive: 'HKCU', key: IS + '\\Connections', names: ['ProxyServer'] },
    { hive: 'HKCU', key: 'Environment\\..\\Software', names: ['Path'] },
    {}, null, undefined,
  ]
  for (const a of bad) await rejects(h.call('reg-read', a), 'helper-forbidden-key')
  assert.equal(lines(log).filter((l) => l.verb === 'reg-read').length, ok.length, 'nothing refused was written')
  assert.deepEqual(REG_READ_ALLOW.map((r) => `${r.hive}\\${r.key}`).sort(), ['HKCU\\Environment', `HKCU\\${IS}`, `HKLM\\${SAC}`].sort())
})

test('W1 a reply is matched to its request by id, whatever the order it comes back in', async (t) => {
  const h = started(t, { verbs: { ps: { delayMs: 80, data: { procs: ['slow'] } }, route: { data: { dest: 'fast' } } } })
  const slow = h.call('ps')
  const fast = h.call('route')
  assert.deepEqual(await fast, { dest: 'fast' })
  assert.deepEqual(await slow, { procs: ['slow'] })
})

test('W1 a verb the helper fails is a rejection with its message, and the helper stays up', async (t) => {
  const h = started(t, { verbs: { 'tcp-table': { error: 'native-unavailable: Add-Type blocked' } } })
  await assert.rejects(h.call('tcp-table', {}), (e) => e.code === 'helper-verb-error' && /Add-Type blocked/.test(e.message) && e.verb === 'tcp-table')
  assert.equal((await h.call('version')).proto, 1)
  assert.equal(h.failures.length, 0)
})

test('W1 a slow verb times out without taking the helper down; its late answer is dropped', async (t) => {
  const h = started(t, { verbs: { ps: { delayMs: 120, data: {} } } })
  await rejects(h.call('ps', {}, { timeoutMs: 30 }), 'helper-timeout')
  await new Promise((r) => setTimeout(r, 150)) // the late reply arrives for an id nobody waits for
  assert.equal((await h.call('version')).proto, 1)
  assert.equal(h.failures.length, 0)
})

test('W1 stdout noise that is not a reply is skipped', async (t) => {
  const h = started(t, { noise: ['WARNING: something a shell printed', '{"not":"a reply"}'] })
  assert.equal((await h.call('version')).proto, 1)
})

test('W1 the helper is ready before the first verb is written, and a call made at once waits for it', async (t) => {
  const log = path.join(tmpDir('asight-helper-'), 'in.log')
  const h = started(t, { log, readyDelayMs: 120 }) // Add-Type compiles for a while on a cold machine
  const first = h.call('version', {}, { timeoutMs: 50 }) // the timeout counts from the write, not from the call
  const info = await h.ready
  assert.equal(info.proto, 1)
  assert.equal(info.native, true)
  assert.equal((await first).proto, 1)
  assert.equal(lines(log).length, 1)
})

test('W1 a helper that speaks another protocol is a failed start, and says so', async (t) => {
  const h = started(t, { proto: 9 })
  await assert.rejects(h.ready)
  assert.equal(h.failures.length, 1)
  assert.equal(h.failures[0].code, 'helper-start-failed')
  assert.match(h.failures[0].reason, /protocol 9/)
})

