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
import { HELPER_PROTO, HELPER_VERBS, HELPER_PS1, REG_KIND_NAMES, REG_READ_ALLOW, POLICY_KEY_PATTERN, POLICY_NAME_PATTERN, declaredRegAllow, policyAllowOf, regKindsOf, startHelper } from '../../../../src/collector/arch/win32/helper.mjs'
import { readSystemProxy } from '../../../../src/collector/arch/win32/upstream.mjs'
import { CMDLINE_STATES, PS_TIMEOUT_MS, elevationOf, factsOfPid, splitCommandLine } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { ownerOfSocket } from '../../../../src/collector/arch/win32/socktable.mjs'
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
/** Polls `fn` until it returns something truthy (a slow machine gets the whole second), instead of sleeping for a guess. */
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true })
/** Is the process still there? signal 0 only asks (ESRCH = gone; EPERM = there, not ours to signal). */
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }

// ---------- W1: the helper is read-only, and its verb set is closed ----------

test('W1 the verb set is the closed list, frozen', () => {
  assert.deepEqual([...HELPER_VERBS], ['ps', 'tcp-table', 'reg-read', 'net-if', 'route', 'token', 'roots', 'pipe-server', 'version', 'proc-env'])
  assert.ok(Object.isFrozen(HELPER_VERBS))
  assert.ok(HELPER_PS1.endsWith('helper.ps1'))
})

// helper.ps1 reads each value's kind as `$k.GetValueKind($n).ToString()`, which is .NET's RegistryValueKind (DWord, String, ExpandString, ...), and 4.8 §1 gives kinds as the registry names them (`REG_EXPAND_SZ`). The readers and
// the fakes of every other test say REG_*; the client is where the two meet, so that a reader that asks for a DWORD does not get `DWord` from the real helper and find nothing.
test('W1 reg-read answers give each value\'s kind in the registry\'s own names, whichever spelling the script wrote (the eight kinds .NET has); nothing else in the answer moves', async (t) => {
  const net = { Unknown: 'REG_UNKNOWN', String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', Binary: 'REG_BINARY', DWord: 'REG_DWORD', MultiString: 'REG_MULTI_SZ', QWord: 'REG_QWORD', None: 'REG_NONE' }
  assert.deepEqual(Object.fromEntries(Object.keys(net).map((k) => [k, REG_KIND_NAMES[k.toLowerCase()]])), net, 'the table is exactly the eight names of [Microsoft.Win32.RegistryValueKind]')
  assert.ok(Object.isFrozen(REG_KIND_NAMES))
  const answer = { keyExists: true, values: { ProxyEnable: { kind: 'DWord', value: 1 }, ProxyServer: { kind: 'String', value: '127.0.0.1:7897' }, Path: { kind: 'ExpandString', value: '%X%;C:\\a' }, Blob: { kind: 'Binary', value: 'AQID' }, Already: { kind: 'REG_SZ', value: 'x' }, Odd: { kind: 'Weird', value: 1 }, Bare: 5 } }
  assert.deepEqual(regKindsOf(answer), { keyExists: true, values: { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, ProxyServer: { kind: 'REG_SZ', value: '127.0.0.1:7897' }, Path: { kind: 'REG_EXPAND_SZ', value: '%X%;C:\\a' }, Blob: { kind: 'REG_BINARY', value: 'AQID' }, Already: { kind: 'REG_SZ', value: 'x' }, Odd: { kind: 'Weird', value: 1 }, Bare: 5 } })
  assert.equal(answer.values.ProxyEnable.kind, 'DWord', 'the answer it was given is not changed')
  for (const x of [null, undefined, 'garbage', 7, [], { keyExists: false }, { values: 'no' }]) assert.deepEqual(regKindsOf(x), x, `not a registry read, returned as it is: ${JSON.stringify(x)}`)
  // through the client, over the real line protocol: only reg-read is touched
  const h = started(t, { verbs: { 'reg-read': { data: answer }, version: { data: { values: { A: { kind: 'DWord', value: 1 } } } } } })
  const got = await h.call('reg-read', { hive: 'HKCU', key: 'Environment', names: ['Path'] })
  assert.equal(got.values.Path.kind, 'REG_EXPAND_SZ')
  assert.equal(got.values.ProxyEnable.kind, 'REG_DWORD')
  assert.equal((await h.call('version')).values.A.kind, 'DWord', 'another verb\'s answer is not a registry read')
})

test('W71 the system proxy through the real client: a `DWord` ProxyEnable of 1 from the script is ON, a `String` one is not (the reader and the helper agree on the kind\'s name)', async (t) => {
  const reg = (kind) => ({ keyExists: true, values: { ProxyEnable: { kind, value: kind === 'String' ? '1' : 1 }, ProxyServer: { kind: 'String', value: '127.0.0.1:7897' } } })
  const dword = started(t, { verbs: { 'reg-read': { data: reg('DWord') } } })
  assert.deepEqual(await readSystemProxy({ helper: dword }), { ok: true, enable: true, server: '127.0.0.1:7897', override: null, autoConfigUrl: null })
  const text = started(t, { verbs: { 'reg-read': { data: reg('String') } } })
  assert.equal((await readSystemProxy({ helper: text })).enable, null, 'text "1" is no DWORD 1 (4.8 §2.2)')
})

test('W1 an unknown verb is rejected in JS: no line reaches the helper', async (t) => {
  const log = path.join(tmpDir('asight-helper-'), 'in.log')
  const h = started(t, { log })
  await h.call('version')
  for (const verb of ['rm', 'Set-ItemProperty', 'toString', '__proto__', '', undefined, 7, 'ps ']) await rejects(h.call(verb), 'helper-unknown-verb')
  assert.deepEqual(lines(log).map((l) => l.verb), ['version'], 'only the allowed verb was written')
  assert.equal(h.failures.length, 0, 'a refused verb is the caller\'s mistake, not a helper failure')
})

test('W1 reg-read: only the allowed keys and their names go through, checked in JS before any write', async (t) => {
  const log = path.join(tmpDir('asight-helper-'), 'in.log')
  const h = started(t, { log, verbs: { 'reg-read': { data: { keyExists: true, values: {} } } } })
  const IS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const SAC = 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'
  const SME = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  const ok = [
    { hive: 'HKCU', key: IS, names: ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'] },
    { hive: 'hkcu', key: IS.toLowerCase() + '\\', names: ['proxyserver'] }, // case and a trailing backslash are not a way round the list
    { hive: 'HKCU', key: 'Software/Microsoft/Windows/CurrentVersion/Internet Settings', names: ['ProxyServer'] },
    { hive: 'HKCU', key: 'Environment', names: ['Path'] },
    { hive: 'HKCU', key: 'Environment', names: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] }, // the login environment's proxy variables, which 4.8 §2.2 reads for the agent's own proxy
    { hive: 'HKCU', key: 'Environment', names: ['https_proxy', 'no_proxy'] }, // registry value names are not case-sensitive
    { hive: 'HKLM', key: SME, names: ['Path'] }, // the machine PATH, which Windows reads before the user's (4.8 §6.3)
    { hive: 'HKLM', key: SAC, names: ['VerifiedAndReputablePolicyState'] },
  ]
  for (const a of ok) await h.call('reg-read', a)
  const bad = [
    { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', names: ['x'] },
    { hive: 'HKCU', key: 'Environment', names: ['TEMP'] }, // the proxy variables and Path of Environment: not the CA variables, not the whole block
    { hive: 'HKCU', key: 'Environment', names: ['Path', 'NODE_EXTRA_CA_CERTS'] },
    { hive: 'HKCU', key: 'Environment', names: ['HTTPS_PROXY', 'SSL_CERT_FILE'] }, // one name outside the list refuses the whole request
    { hive: 'HKCU', key: 'Environment', names: ['HTTPS_PROXY_X'] },
    { hive: 'HKCU', key: 'Environment', names: [] }, // no names = everything: refused
    { hive: 'HKLM', key: 'Environment', names: ['Path'] },
    { hive: 'HKLM', key: SME, names: ['TEMP'] }, // the machine environment: Path only
    { hive: 'HKLM', key: SME, names: ['Path', 'ComSpec'] },
    { hive: 'HKLM', key: SME, names: ['HTTPS_PROXY'] }, // the proxy variables are the user's key's, not the machine's
    { hive: 'HKCU', key: SME, names: ['Path'] }, // the machine key is HKLM's
    { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager', names: ['Path'] },
    { hive: 'HKLM', key: SME + '\\Sub', names: ['Path'] },
    { hive: 'HKCU', key: SAC, names: ['VerifiedAndReputablePolicyState'] },
    { hive: 'HKLM', key: IS, names: ['ProxyServer'] },
    { hive: 'HKU', key: 'Environment', names: ['Path'] },
    { hive: 'HKCU', key: IS + '\\Connections', names: ['ProxyServer'] },
    { hive: 'HKCU', key: 'Environment\\..\\Software', names: ['Path'] },
    { hive: 'HKCU', key: 'Software\\Policies\\Claude', names: ['egressProxyUrl'] }, // a policy key is readable only when a harness file declared it (below)
    {}, null, undefined,
  ]
  for (const a of bad) await rejects(h.call('reg-read', a), 'helper-forbidden-key')
  assert.equal(lines(log).filter((l) => l.verb === 'reg-read').length, ok.length, 'nothing refused was written')
  assert.deepEqual(REG_READ_ALLOW.map((r) => `${r.hive}\\${r.key}`).sort(), ['HKCU\\Environment', `HKCU\\${IS}`, `HKLM\\${SAC}`, `HKLM\\${SME}`].sort())
})

const POLICY = { hive: 'HKCU', key: 'SOFTWARE\\Policies\\Claude', names: ['egressProxyUrl'] } // what Claude Desktop's harness file declares (win32/claude-code.mjs)

test('W1 a policy key a harness file declares is readable, and only that key and name: checked in JS before any write, and handed to the script', async (t) => {
  const log = path.join(tmpDir('asight-helper-'), 'in.log')
  const spawned = []
  const h = started(t, { log, verbs: { 'reg-read': { data: { keyExists: true, values: {} } } } }, { regAllow: [POLICY], spawn: (exe, args, opts) => { spawned.push(args); return fakeSpawn({ log, verbs: { 'reg-read': { data: { keyExists: true, values: {} } } } })(exe, args, opts) } })
  await h.call('reg-read', POLICY)
  await h.call('reg-read', { hive: 'hkcu', key: 'software/policies/claude/', names: ['EGRESSPROXYURL'] }) // case, slashes and a trailing backslash are not a way round it
  for (const a of [
    { hive: 'HKCU', key: POLICY.key, names: ['egressProxyUrl', 'other'] },
    { hive: 'HKCU', key: POLICY.key, names: ['other'] },
    { hive: 'HKCU', key: 'SOFTWARE\\Policies\\Other', names: ['egressProxyUrl'] },
    { hive: 'HKCU', key: 'SOFTWARE\\Policies', names: ['egressProxyUrl'] },
    { hive: 'HKCU', key: POLICY.key + '\\Sub', names: ['egressProxyUrl'] },
    { hive: 'HKLM', key: POLICY.key, names: ['egressProxyUrl'] }, // the hive is part of the declaration
    { hive: 'HKCU', key: POLICY.key, names: [] },
  ]) await rejects(h.call('reg-read', a), 'helper-forbidden-key')
  assert.equal(lines(log).filter((l) => l.verb === 'reg-read').length, 2, 'only the two declared reads were written')
  // the script gets the same declaration, base64 of JSON, as the one parameter it takes; it checks it again (below)
  assert.equal(spawned.length, 1)
  const i = spawned[0].indexOf('-ExtraRegAllowB64')
  assert.ok(i > 0 && i === spawned[0].length - 2, 'the parameter is the last pair: -ExtraRegAllowB64 <base64>')
  assert.deepEqual(JSON.parse(Buffer.from(spawned[0][i + 1], 'base64').toString('utf8')), [{ hive: 'HKCU', key: 'SOFTWARE\\Policies\\Claude', names: ['egressProxyUrl'] }])
  assert.deepEqual(spawned[0].slice(0, i), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1], 'the rest of the command line is what it was')
})

test('W1 without a declaration the helper is started as it was: no extra parameter, nothing beyond the list', async (t) => {
  const spawned = []
  const h = started(t, { verbs: { 'reg-read': { data: { keyExists: true, values: {} } } } }, { spawn: (exe, args, opts) => { spawned.push(args); return fakeSpawn({})(exe, args, opts) } })
  await h.call('version')
  assert.ok(!spawned[0].includes('-ExtraRegAllowB64'))
  await rejects(h.call('reg-read', POLICY), 'helper-forbidden-key')
})

test('W1 a declaration that is not a policy key is refused when the helper is started, before any process: the declaration cannot widen what the helper reads', () => {
  const spawned = []
  const spawn = () => { spawned.push(1); throw new Error('must not start') }
  const bad = {
    'a key that is not under Policies': [{ hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', names: ['x'] }],
    'the login environment': [{ hive: 'HKCU', key: 'Environment', names: ['NODE_EXTRA_CA_CERTS'] }],
    'a parent of Policies': [{ hive: 'HKCU', key: 'Software', names: ['Policies'] }],
    'Policies itself': [{ hive: 'HKCU', key: 'Software\\Policies', names: ['x'] }],
    'a dot-dot segment': [{ hive: 'HKCU', key: 'Software\\Policies\\..\\..\\Microsoft', names: ['x'] }],
    'a dot segment': [{ hive: 'HKCU', key: 'Software\\Policies\\.', names: ['x'] }],
    'another hive': [{ hive: 'HKU', key: 'Software\\Policies\\Claude', names: ['x'] }],
    'a class root': [{ hive: 'HKCR', key: 'Software\\Policies\\Claude', names: ['x'] }],
    'no names': [{ hive: 'HKCU', key: 'Software\\Policies\\Claude', names: [] }],
    'a name with a backslash': [{ hive: 'HKCU', key: 'Software\\Policies\\Claude', names: ['a\\b'] }],
    'a name with a quote': [{ hive: 'HKCU', key: 'Software\\Policies\\Claude', names: ['a"b'] }],
    'an empty name': [{ hive: 'HKCU', key: 'Software\\Policies\\Claude', names: [''] }],
    'a name that is not a string': [{ hive: 'HKCU', key: 'Software\\Policies\\Claude', names: [7] }],
    'a key with a control character': [{ hive: 'HKCU', key: 'Software\\Policies\\Cla\nude', names: ['x'] }],
    'not a list': { hive: 'HKCU', key: 'Software\\Policies\\Claude', names: ['x'] },
    'an entry that is not an object': ['HKCU'],
    'more entries than any harness has': Array.from({ length: 17 }, (_, i) => ({ hive: 'HKCU', key: `Software\\Policies\\V${i}`, names: ['x'] })),
  }
  for (const [what, list] of Object.entries(bad)) {
    assert.throws(() => startHelper({ spawn, regAllow: list }), TypeError, what)
    assert.throws(() => declaredRegAllow(list), TypeError, what)
  }
  assert.equal(spawned.length, 0, 'none of them started a process')
  assert.deepEqual(declaredRegAllow(undefined), [])
  assert.deepEqual(declaredRegAllow([]), [])
  const good = declaredRegAllow([{ hive: 'hkcu', key: 'software/policies/Claude Desktop/', names: ['egressProxyUrl'] }, { hive: 'HKLM', key: 'SOFTWARE\\Policies\\Kimi\\Code', names: ['a', 'B_c-1.2'] }])
  assert.deepEqual(good, [{ hive: 'HKCU', key: 'software\\policies\\Claude Desktop', names: ['egressProxyUrl'] }, { hive: 'HKLM', key: 'SOFTWARE\\Policies\\Kimi\\Code', names: ['a', 'B_c-1.2'] }], 'hive upper-cased, key with backslashes and no trailing one, names as given')
})

test('W1 the policy keys the harness files declare (their proxyEntry of kind policy) are what policyAllowOf gives, and the helper accepts them', async () => {
  const { default: claude } = await import('../../../../src/collector/harness/win32/claude-code.mjs')
  const { default: codex } = await import('../../../../src/collector/harness/win32/codex.mjs')
  assert.deepEqual(policyAllowOf([...claude.groups, ...codex.groups]), [{ hive: 'HKCU', key: 'SOFTWARE\\Policies\\Claude', names: ['egressProxyUrl'] }], 'the groups that keep their entry in a file declare nothing')
  assert.deepEqual(policyAllowOf([]), [])
  assert.deepEqual(policyAllowOf([{ proxyEntry: { kind: 'policy', hive: 'HKCU', key: 'SOFTWARE\\Policies\\A', name: 'x' } }, { proxyEntry: { kind: 'policy', hive: 'HKCU', key: 'SOFTWARE\\Policies\\A', name: 'y' } }]), [{ hive: 'HKCU', key: 'SOFTWARE\\Policies\\A', names: ['x', 'y'] }], 'two names of one key are one entry')
  assert.doesNotThrow(() => declaredRegAllow(policyAllowOf([...claude.groups]))) // the real declaration passes the same check the helper applies
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
  const h = started(t, { verbs: { ps: { delayMs: 400, data: {} } } })
  await rejects(h.call('ps', {}, { timeoutMs: 30 }), 'helper-timeout')
  await new Promise((r) => setTimeout(r, 450)) // the late reply arrives for an id nobody waits for
  assert.equal((await h.call('version')).proto, 1)
  assert.equal(h.failures.length, 0)
})

test('W1 a timed-out call is abandoned until its late answer arrives; a closed helper has none', async (t) => {
  const h = started(t, { verbs: { ps: { delayMs: 500, data: { procs: [] } } } }) // late enough that a stalled test runner still sees it outstanding
  assert.equal(h.abandoned('ps'), 0)
  await rejects(h.call('ps', {}, { timeoutMs: 20 }), 'helper-timeout')
  assert.equal(h.abandoned('ps'), 1, 'the helper is still working on it: it is single-threaded, so anything sent now waits behind it')
  assert.equal(h.abandoned('route'), 0, 'counted by verb')
  await until(() => h.abandoned('ps') === 0) // the late answer came, was dropped, and the helper is free again
  const hung = started(t, { verbs: { ps: { hang: true } } })
  await rejects(hung.call('ps', {}, { timeoutMs: 20 }), 'helper-timeout')
  assert.equal(hung.abandoned('ps'), 1, 'an answer that never comes stays abandoned')
  await hung.close()
  assert.equal(hung.abandoned('ps'), 0, 'a helper that is gone has nothing left to wait for')
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
  const pid = h.pid
  await assert.rejects(h.ready)
  assert.equal(h.failures.length, 1)
  assert.equal(h.failures[0].code, 'helper-start-failed')
  assert.match(h.failures[0].reason, /protocol 9/)
  await until(() => !alive(pid)) // a helper we gave up on does not linger: on Windows that is a powershell.exe nobody owns, its stdin open for as long as the daemon lives
})

// ---------- W1: a helper that dies is a rejection of every pending call, plus ONE helper-down; a start that fails is helper-start-failed ----------

test('W1 killing the helper rejects every pending call and writes one helper-down', async (t) => {
  const h = started(t, { verbs: { ps: { hang: true }, 'tcp-table': { hang: true } } })
  await h.ready
  const pending = [h.call('ps'), h.call('tcp-table', {})]
  const settled = Promise.allSettled(pending)
  await new Promise((r) => setTimeout(r, 30))
  process.kill(h.pid, 'SIGKILL')
  for (const r of await settled) { assert.equal(r.status, 'rejected'); assert.equal(r.reason.code, 'helper-down') }
  await rejects(h.call('version'), 'helper-down') // and later calls fail at once, instead of waiting out their timeout
  assert.equal(h.failures.length, 1, 'one helper-down, not one per pending call')
  assert.equal(h.failures[0].event, 'helper-down')
  assert.match(h.failures[0].reason, /SIGKILL/)
  assert.equal(h.failures[0].exit, 'SIGKILL')
  assert.deepEqual(checkRecord(h.failures[0]), [])
  assert.equal(h.exits.length, 1)
})

test('W1 an exit with a code after the helper was ready is helper-down with that code and its last stderr lines', async (t) => {
  const h = started(t, { stderr: ['Add-Type : policy', 'at line 3'], exitAfter: 1, exitCode: 3 })
  await h.call('version')
  await until(() => h.failures.length)
  assert.equal(h.failures.length, 1)
  const [f] = h.failures
  assert.equal(f.event, 'helper-down')
  assert.equal(f.exit, 'code 3')
  assert.deepEqual(f.stderr, ['Add-Type : policy', 'at line 3'])
  assert.deepEqual(checkRecord(f), [])
})

test('W1 a helper that exits before it is ready is helper-start-failed (policy blocking Add-Type, no PowerShell)', async (t) => {
  const h = started(t, { ready: false, exitCode: 1, stderr: ['Cannot invoke method. Method invocation is supported only on core types in this language mode.'] })
  await rejects(h.call('version'), 'helper-start-failed')
  await assert.rejects(h.ready)
  assert.equal(h.failures.length, 1)
  const [f] = h.failures
  assert.deepEqual([f.event, f.where, f.code], ['failure', 'helper', 'helper-start-failed'])
  assert.match(f.stderr[0], /language mode/)
  assert.deepEqual(checkRecord(f), [])
})

test('W1 a helper whose native code did not compile is up but is helper-start-failed once; the verbs that need no native code still answer', async (t) => {
  const h = started(t, { native: false, nativeError: 'csc.exe is blocked by policy', verbs: { 'net-if': { data: { interfaces: [] } }, ps: { error: 'native-unavailable: csc.exe is blocked by policy' } } })
  const info = await h.ready
  assert.equal(info.native, false)
  assert.equal(h.failures.length, 1)
  const [f] = h.failures
  assert.deepEqual([f.event, f.where, f.code, f.nativeError], ['failure', 'helper', 'helper-start-failed', 'csc.exe is blocked by policy'])
  assert.match(f.reason, /native code did not compile.*csc\.exe is blocked/)
  assert.deepEqual(checkRecord(f), [])
  assert.deepEqual(await h.call('net-if'), { interfaces: [] })
  await assert.rejects(h.call('ps'), (e) => e.code === 'helper-verb-error' && /native-unavailable/.test(e.message))
  assert.equal(h.failures.length, 1, 'the verbs that fail afterwards are their callers\' to record, not another helper-start-failed')
  assert.equal(h.exits.length, 0, 'the helper is still there')
})

test('W1 a spawn that fails (the program is not there, or spawn throws) is helper-start-failed', async () => {
  for (const spawnFn of [
    () => ghostChild((c) => c.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))),
    () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) },
  ]) {
    const failures = []
    const h = startHelper({ spawn: spawnFn, onFailure: (r) => failures.push(r) })
    await assert.rejects(h.call('ps'), (e) => e.code === 'helper-start-failed')
    assert.equal(failures.length, 1)
    assert.deepEqual([failures[0].event, failures[0].where, failures[0].code], ['failure', 'helper', 'helper-start-failed'])
    assert.match(failures[0].errno, /^E(NOENT|ACCES)$/)
    assert.deepEqual(checkRecord(failures[0]), [])
    h.close()
  }
})

test('W1 a helper that goes down by two routes at once (error, then close) is still ONE record', async () => {
  const failures = []
  const h = startHelper({ spawn: () => ghostChild((c) => { c.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })); c.emit('close', 1, null); c.emit('error', new Error('again')) }), onFailure: (r) => failures.push(r) })
  await assert.rejects(h.ready)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(failures.length, 1)
})

test('W1 a helper that never says ready is killed and is helper-start-failed', async (t) => {
  const h = started(t, { hangBeforeReady: true }, { readyTimeoutMs: 100 })
  const pid = h.pid
  assert.ok(alive(pid), 'the fake is up and silent')
  await rejects(h.call('version'), 'helper-start-failed')
  assert.equal(h.failures.length, 1)
  assert.match(h.failures[0].reason, /not ready within 100 ms/)
  await until(() => !alive(pid)) // killed, not just forgotten
})

test('W1 close() is not a failure: no helper-down, the child is gone, later calls are refused', async (t) => {
  const h = started(t, {})
  await h.call('version')
  await h.close()
  await rejects(h.call('version'), 'helper-closed')
  assert.equal(h.failures.length, 0)
  assert.equal(h.exits.length, 1)
  assert.equal(h.exits[0].closed, true)
})

// ---------- W1: helper.ps1 has no write verb (static scan), and says what the JS side says ----------

const PS = fs.readFileSync(HELPER_PS1, 'utf8')
/** What a read-only helper must never contain: the spec's list (Set-ItemProperty New-Item Remove- netsh schtasks setx Register-) and the other
 *  ways to write, run, fetch or stop something. The scan reads the whole file, comments included, so a comment cannot hide one either. */
const WRITE_PATTERNS = [
  /\bSet-[A-Za-z]+/, /\bNew-(?!Object\b)[A-Za-z]+/, /\b(Remove|Register|Unregister|Clear|Export|Import|Enable|Disable|Install|Uninstall|Restart|Rename|Move|Copy)-[A-Za-z]*/,
  /\bOut-File\b/, /\bAdd-Content\b/, /\b(Start|Stop)-(Process|Service|Job|Sleep)\b/, /\bInvoke-[A-Za-z]+/, /\b(iex|iwr|irm|sc\.exe|reg\.exe)\b/i,
  /\bnetsh\b/i, /\bschtasks\b/i, /\bsetx\b/i, /\breg\s+(add|delete|import|copy|save|load|restore)\b/i,
  /\[(System\.)?IO\.(File|Directory)\]::(Write|Append|Create|Delete|Move|Copy|Open|Replace|SetAttributes)/i, /\.(SetValue|DeleteValue|DeleteSubKey|DeleteSubKeyTree|CreateSubKey|Kill|Terminate)\(/,
  /\bWebClient\b|\bHttpClient\b|\bTcpClient\b|\bSocket\b|\bNamedPipeClientStream\b/,
]
const writeVerbsIn = (text) => WRITE_PATTERNS.filter((re) => re.test(text)).map(String)

test('W1 helper.ps1 contains no write, run or fetch verb (static scan); the scan can fail', () => {
  assert.deepEqual(writeVerbsIn(PS), [])
  for (const planted of ['Set-ItemProperty -Path x', 'New-Item y', 'Remove-Item z', 'netsh winhttp', 'schtasks /Create', 'setx A B', 'Register-ScheduledTask', 'Set-Content f', 'Out-File f', '[IO.File]::WriteAllText($f,$t)', '$k.SetValue("a",1)', 'Start-Process x', 'Invoke-Expression $x', 'reg add HKCU\\x']) {
    assert.ok(writeVerbsIn(planted).length > 0, `the scan misses: ${planted}`)
  }
  assert.deepEqual(writeVerbsIn('New-Object System.Text.StringBuilder'), [], 'New-Object builds a .NET object in memory: the one New- the helper uses')
})

// The native half is where the power is: the C# in the Add-Type here-string can write a file, start a process, kill one or set a registry
// value with a single line that WRITE_PATTERNS (PowerShell verbs and bracketed calls) never sees. So the native surface is pinned instead:
// the P/Invoke imports are exactly this list (dll and function), each used the read way, and nothing else that writes, runs or fetches is in the C#.
const NATIVE_IMPORTS = [
  'advapi32.dll!GetSidSubAuthority', 'advapi32.dll!GetSidSubAuthorityCount', 'advapi32.dll!GetTokenInformation', 'advapi32.dll!OpenProcessToken',
  'iphlpapi.dll!GetBestInterface', 'iphlpapi.dll!GetExtendedTcpTable',
  'kernel32.dll!CloseHandle', 'kernel32.dll!CreateFile', 'kernel32.dll!CreateToolhelp32Snapshot', 'kernel32.dll!GetCurrentProcess', 'kernel32.dll!GetNamedPipeServerProcessId',
  'kernel32.dll!GetProcessTimes', 'kernel32.dll!OpenProcess', 'kernel32.dll!Process32FirstW', 'kernel32.dll!Process32NextW', 'kernel32.dll!ProcessIdToSessionId',
  'kernel32.dll!QueryFullProcessImageName', 'kernel32.dll!ReadProcessMemory', 'ntdll.dll!NtQueryInformationProcess',
]
const IMPORT_RE = /\[(?:System\.Runtime\.InteropServices\.)?DllImport\(\s*"([^"]+)"([^\]]*)\)\]\s*(?:(?:public|private|internal|static|extern|unsafe)\s+)+[\w.<>[\]]+\s+(\w+)\s*\(/g
/** What the C# may not contain, wherever it sits (comments too). */
const CS_BANS = [
  [/\bSystem\s*\.\s*IO\b|\bFile\s*\.|\bDirectory\s*\./, 'file access'],
  [/\bProcess\s*\.\s*Start\b|\bProcessStartInfo\b|\.Kill\s*\(|\.CloseMainWindow\b/, 'starting or stopping a process'],
  [/\bRegistry(Key)?\b/, 'the registry'],
  [/\bEnvironment\s*\.\s*(Exit|FailFast|SetEnvironmentVariable)\b/, 'ending the process or writing the environment'],
  [/\bMarshal\s*\.\s*Write/, 'writing memory'],
  [/\bMarshal\s*\.\s*Copy\s*\((?!row\b)/, 'a Marshal.Copy that is not a read of a table row'],
  [/\bWebClient\b|\bHttpClient\b|\bHttpWebRequest\b|\bWebRequest\b|\bTcpClient\b|\bSocket\b|\bNamedPipeClientStream\b|\bSystem\s*\.\s*Net\s*\.\s*Sockets\b/, 'the network'],
  [/\bAssembly\s*\.|GetDelegateForFunctionPointer|GetProcAddress|LoadLibrary|\bActivator\s*\./, 'loading or calling code that is not listed'],
  [/\bEntryPoint\b/, 'a DllImport whose entry point is not its name'],
]
/** What a read-only native half still has to look like at the call sites: the access masks that cannot write, kill or create. */
function callSiteViolations(cs) {
  const body = cs.split('\n').filter((l) => !/\bextern\b/.test(l)).join('\n') // the declarations name the parameters; the calls give the values
  const out = []
  for (const m of body.matchAll(/\bOpenProcess\(\s*([^,)]*)/g)) if (!['0x1000', '0x1010'].includes(m[1].trim())) out.push(`OpenProcess with access ${m[1].trim()}: only PROCESS_QUERY_LIMITED_INFORMATION (0x1000), with PROCESS_VM_READ (0x0010) for proc-env, reads`)
  for (const m of body.matchAll(/\bOpenProcessToken\(\s*[^,]+,\s*([^,]+),/g)) if (m[1].trim() !== '0x8') out.push(`OpenProcessToken with access ${m[1].trim()}: only TOKEN_QUERY (0x8) reads`)
  for (const m of body.matchAll(/\bCreateFile\(\s*[^,]+,\s*([^,]+),\s*[^,]+,\s*[^,]+,\s*([^,]+),/g)) {
    if (m[1].trim() !== '0x80000000') out.push(`CreateFile with access ${m[1].trim()}: only GENERIC_READ (0x80000000) reads`)
    if (m[2].trim() !== '3') out.push(`CreateFile with disposition ${m[2].trim()}: only OPEN_EXISTING (3) cannot create`)
  }
  return out
}
/** Everything the native surface of a helper script may not be, as short sentences; [] = it can only read. */
function nativeViolations(text) {
  const out = []
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') // PowerShell comment lines may mention Add-Type
  const compiles = code.match(/\bAdd-Type\b/g) || []
  if (compiles.length !== 1 || !/\bAdd-Type\s+-TypeDefinition\s+\$cs\b/.test(code)) out.push('Add-Type is not exactly one `-TypeDefinition $cs`: native code compiled from somewhere else')
  if (/\bAssembly\b|-MemberDefinition|\bLoadFile\b|\bLoadFrom\b/.test(code)) out.push('the script loads an assembly or compiles a member definition')
  const imports = [...text.matchAll(IMPORT_RE)].map((m) => `${m[1].toLowerCase()}!${m[3]}`)
  if ((text.match(/DllImport/g) || []).length !== imports.length || (text.match(/\bextern\b/g) || []).length !== imports.length) out.push('a DllImport or extern the scan cannot read: every import must be written in the one shape it parses')
  const extra = imports.filter((i) => !NATIVE_IMPORTS.includes(i))
  const missing = NATIVE_IMPORTS.filter((i) => !imports.includes(i))
  if (extra.length) out.push(`imports outside the read-only list: ${extra.join(', ')}`)
  if (missing.length) out.push(`imports of the list that are gone (update the list): ${missing.join(', ')}`)
  const natives = [...text.matchAll(/@'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]).filter((h) => /\bDllImport\b|\bclass\b/.test(h))
  if (natives.length !== 1) { out.push(`the native code is ${natives.length} here-strings, not one`); return out }
  for (const [re, what] of CS_BANS) if (re.test(natives[0])) out.push(`the C# touches ${what}`)
  return [...out, ...callSiteViolations(natives[0])]
}

test('W1 the C# in helper.ps1 imports exactly the read-only native functions, uses them the read way, and touches no file, registry value or process', () => {
  assert.deepEqual(nativeViolations(PS), [])
  const imports = [...PS.matchAll(IMPORT_RE)].map((m) => `${m[1].toLowerCase()}!${m[3]}`)
  assert.deepEqual([...imports].sort(), [...NATIVE_IMPORTS].sort())
  assert.equal(NATIVE_IMPORTS.length, 19)
})

test('W1 the native scan can fail: each planted write, run, kill or registry change in the C# is caught', () => {
  const plant = (from, to) => { assert.ok(PS.includes(from), `the plant point moved: ${from}`); return PS.replace(from, to) }
  const inClass = (member) => plant('  static string N(long v)', `  ${member}\n  static string N(long v)`)
  const planted = {
    'a file write': inClass('static void X() { System.IO.File.WriteAllText("a", "b"); }'),
    'a file delete through a using': inClass('static void X() { Directory.Delete("c:\\\\x", true); }'),
    'a process start': inClass('static void X() { System.Diagnostics.Process.Start("cmd.exe"); }'),
    'a Kill': inClass('static void X() { System.Diagnostics.Process.GetCurrentProcess().Kill(); }'),
    'a registry write': inClass('static void X() { Microsoft.Win32.Registry.CurrentUser.CreateSubKey("x"); }'),
    'Environment.Exit': inClass('static void X() { Environment.Exit(0); }'),
    'a memory write': inClass('static void X(IntPtr p) { Marshal.WriteInt32(p, 0, 1); }'),
    'a Marshal.Copy into native memory': inClass('static void X(byte[] x, IntPtr p) { Marshal.Copy(x, 0, p, 16); }'),
    'a web client': inClass('static void X() { new System.Net.WebClient().DownloadString("http://x"); }'),
    'a delegate from a function pointer': inClass('static void X(IntPtr p) { Marshal.GetDelegateForFunctionPointer(p, typeof(Action)); }'),
    'TerminateProcess imported': plant('  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);', '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);\n  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);'),
    'RegSetValueEx imported': plant('  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);', '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);\n  [DllImport("advapi32.dll")] static extern int RegSetValueEx(IntPtr k, string n, int r, int t, byte[] d, int c);'),
    'a listed import redirected with EntryPoint': plant('[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);', '[DllImport("kernel32.dll", EntryPoint = "TerminateProcess")] static extern bool CloseHandle(IntPtr h);'),
    'a listed import taken from another dll': plant('[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);', '[DllImport("evil.dll")] static extern bool CloseHandle(IntPtr h);'),
    'an import written in a shape the scan cannot read': plant('  static string N(long v)', '  [DllImport("kernel32.dll")]\n  [return: MarshalAs(UnmanagedType.Bool)] static extern bool TerminateProcess(IntPtr h, uint c);\n  static string N(long v)'),
    'a process opened for termination': plant('OpenProcess(0x1000, false, pid)', 'OpenProcess(0x0001, false, pid)'),
    'a token opened for writing': plant('OpenProcessToken(proc, 0x8, out tok)', 'OpenProcessToken(proc, 0x20, out tok)'),
    'a pipe opened for writing': plant('0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)', '0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)'),
    'a pipe opened with CREATE_ALWAYS': plant('0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)', '0x80000000, 3, IntPtr.Zero, 2, 0, IntPtr.Zero)'),
    'a second Add-Type': PS + '\nAdd-Type -MemberDefinition \'[DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint c);\' -Name X -Namespace Y\n',
    'an assembly loaded': PS + '\n[System.Reflection.Assembly]::LoadFile("c:\\\\x.dll")\n',
  }
  for (const [what, text] of Object.entries(planted)) assert.ok(nativeViolations(text).length > 0, `the native scan misses: ${what}`)
  // and the unplanted text is still clean, so the plants above are what turned it red
  assert.deepEqual(nativeViolations(PS), [])
})

test('W1 helper.ps1 opens the registry and the certificate stores read-only', () => {
  const opens = [...PS.matchAll(/OpenSubKey\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(opens.length > 0)
  for (const a of opens) assert.match(a, /,\s*\$false\s*$/, `OpenSubKey(${a}) is not read-only`)
  const stores = [...PS.matchAll(/\.Open\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(stores.length > 0)
  for (const a of stores) assert.match(a, /OpenFlags\]::ReadOnly/, `X509Store.Open(${a}) is not read-only`)
})

test('W1 every Get-CimInstance in helper.ps1 has an operation timeout shorter than the client\'s, so a stuck WMI cannot hold the single-threaded helper for ever', () => {
  const cim = (text) => text.split('\n').filter((l) => /^[^#]*\bGet-CimInstance\b/.test(l))
  const calls = cim(PS)
  assert.ok(calls.length >= 2, 'the filtered query and the full enumeration')
  for (const c of calls) {
    const m = /-OperationTimeoutSec\s+(\d+)/.exec(c)
    assert.ok(m, `no -OperationTimeoutSec: ${c.trim()}`)
    assert.ok(Number(m[1]) * 1000 < PS_TIMEOUT_MS, `CIM must give up (${m[1]} s) before the client does (${PS_TIMEOUT_MS} ms): its answer is then an error, not silence`)
  }
  assert.equal(cim('$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId)').filter((l) => !/-OperationTimeoutSec/.test(l)).length, 1, 'the check can fail')
})

test('W1 helper.ps1 answers exactly the verbs the JS side allows, and reads exactly the registry names the JS side allows', () => {
  const verbs = [...PS.matchAll(/^\s*'([a-z-]+)'\s*\{/gm)].map((m) => m[1])
  assert.deepEqual([...verbs].sort(), [...HELPER_VERBS].sort())
  assert.equal(Number(/\$script:Proto\s*=\s*(\d+)/.exec(PS)[1]), HELPER_PROTO, 'the protocol number in the ready line')
  const m = /\$RegAllowJson\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/.exec(PS)
  assert.ok(m, 'the allow-list literal is there')
  assert.deepEqual(JSON.parse(m[1]), JSON.parse(JSON.stringify(REG_READ_ALLOW)))
})

test('W1 helper.ps1 takes the declared policy keys as its one parameter, first, checks each against the same patterns as helper.mjs, and refuses to start on one that fails', () => {
  const code = PS.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.ok(/^\s*param\(\[string\]\$ExtraRegAllowB64 = ''\)\s*$/m.test(code), 'the parameter')
  assert.ok(code.indexOf('param(') < code.indexOf('$ErrorActionPreference'), 'a param block must be the first statement of a script')
  assert.equal((code.match(/\$ExtraRegAllowB64/g) || []).length, 3, 'the parameter is declared, tested and decoded, and used nowhere else')
  // the patterns the script checks with are the ones helper.mjs exports: one text, so the two cannot drift
  assert.ok(PS.includes(`$PolicyKeyPattern = '${POLICY_KEY_PATTERN}'`), 'the key pattern of the script is POLICY_KEY_PATTERN')
  assert.ok(PS.includes(`$PolicyNamePattern = '${POLICY_NAME_PATTERN}'`), 'the name pattern of the script is POLICY_NAME_PATTERN')
  assert.ok(/-match \$PolicyKeyPattern/.test(code) && /-match \$PolicyNamePattern|-notmatch \$PolicyNamePattern/.test(code), 'both patterns are applied')
  assert.ok(/\(\$eh -ieq 'HKCU'\) -or \(\$eh -ieq 'HKLM'\)/.test(code), 'only the two hives')
  assert.ok(/throw \('extra reg-read entry refused/.test(code), 'an entry that fails is a start failure, never silently dropped or accepted')
  // the extra entries join the list only through that check: of the two lines that append to it, the first loads the fixed list, and the second is inside the check
  assert.ok(!/\$script:RegAllow\s*\+=/.test(code), 'no `+=`: it would need the list to be an array, and the list is a List')
  const adds = code.split('\n').filter((l) => /\$script:RegAllow\.Add\(/.test(l))
  assert.equal(adds.length, 2)
  assert.ok(code.indexOf(adds[0]) < code.indexOf('$PolicyKeyPattern ='), 'the first loads the fixed list')
  assert.ok(code.indexOf(adds[1]) > code.indexOf('-match $PolicyKeyPattern'), 'the second is after the check')
})

/** Every place the script turns JSON into a list must enumerate it the way that holds in Windows PowerShell 5.1 AND in PowerShell 7. 5.1 sends an array out of ConvertFrom-Json as ONE object (7 enumerates it), and
 *  @( ) does not unwrap that: @(ConvertFrom-Json '[a,b]') is a list holding one list, and `$r.hive -ieq $h -and $r.key -ieq $k` then reads 「some entry has this hive and some entry has this key」. A foreach over the parenthesised
 *  call enumerates the same under both. The only other use is the request line, which is one object (a request is never a list). Returns the lines that break the rule. */
function jsonListViolations(text) {
  const out = []
  for (const l of text.split('\n').filter((x) => !/^\s*#/.test(x) && /ConvertFrom-Json/.test(x))) {
    if (/@\(\s*ConvertFrom-Json/.test(l) || /@\([^)]*\(\s*ConvertFrom-Json/.test(l)) out.push(`wrapped in @( ): ${l.trim()}`)
    else if (!/\bforeach\s*\(\$\w+\s+in\s+\(ConvertFrom-Json\s+-InputObject\s+\$\w+\)\)/.test(l) && !/^\s*\$req\s*=\s*ConvertFrom-Json\s+-InputObject\s+\$line\s*$/.test(l)) out.push(`not a foreach over the parenthesised call: ${l.trim()}`)
  }
  return out
}

test('W1 helper.ps1 enumerates every JSON list through a foreach over the parenthesised call, never through @( ) (Windows PowerShell 5.1 sends an array out as one object); the scan can fail', () => {
  assert.deepEqual(jsonListViolations(PS), [])
  const uses = PS.split('\n').filter((x) => !/^\s*#/.test(x) && /ConvertFrom-Json/.test(x))
  assert.equal(uses.length, 3, 'the fixed list, the declared keys and the request line: a new use has to be looked at')
  // what it was: a list of one list under 5.1, which let a request the JS side refuses pass the script's own check, and made two declared keys throw
  assert.equal(jsonListViolations('$script:RegAllow = @(ConvertFrom-Json -InputObject $RegAllowJson)').length, 1)
  assert.equal(jsonListViolations('  $extra = @(ConvertFrom-Json -InputObject ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExtraRegAllowB64))))').length, 1)
  assert.equal(jsonListViolations('$list = ConvertFrom-Json -InputObject $RegAllowJson').length, 1, 'a bare assignment is no better to rely on once a one-entry array arrives from PowerShell 7')
  assert.equal(jsonListViolations('foreach ($r in @(ConvertFrom-Json -InputObject $x)) { }').length, 1)
  assert.deepEqual(jsonListViolations('foreach ($e in (ConvertFrom-Json -InputObject $extraJson)) {'), [])
})

test('W1 helper.ps1 refuses a declared key AND each declared value name that holds a control character: .NET\'s `$` also matches before a final line feed, JavaScript\'s does not, so the pattern alone is not the same check', () => {
  const code = PS.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.ok(/\$ek -notmatch '\[\\x00-\\x1f\]'/.test(code), 'the key')
  assert.ok(/foreach \(\$n in \$en\) \{ if \(\(\$n -notmatch \$PolicyNamePattern\) -or \(\$n -match '\[\\x00-\\x1f\]'\)\) \{ \$namesOk = \$false \} \}/.test(code), 'each name, in the same test as its pattern')
  // the JavaScript side: a trailing line feed is no declaration (so the lines above stay unreachable from helper.mjs, and the script is only the second check)
  for (const bad of [{ key: 'Software\\Policies\\Claude\n', names: ['x'] }, { key: 'Software\\Policies\\Claude', names: ['x\n'] }, { key: 'Software\\Policies\\Claude', names: ['x', 'y\u0001'] }]) {
    assert.throws(() => declaredRegAllow([{ hive: 'HKCU', ...bad }]), TypeError, JSON.stringify(bad))
  }
})

test('W1 the policy key pattern: helper.mjs accepts exactly what the table says (the script carries the same text; that .NET reads it the same way, trailing line feed aside, is checked on a real PowerShell in Task 11)', () => {
  const key = new RegExp(POLICY_KEY_PATTERN, 'i')
  const name = new RegExp(POLICY_NAME_PATTERN)
  const keys = { 'Software\\Policies\\Claude': true, 'SOFTWARE\\Policies\\Claude\\Sub Key': true, 'software\\policies\\A.B-C_D': true, 'Software\\Policies': false, 'Software': false, 'Software\\Policies\\': false, 'Software\\Policies\\..': false, 'Software\\Policies\\.x': false, 'Software\\PoliciesX\\a': false, 'Software\\Microsoft\\Run': false, 'Environment': false, '': false, 'Software\\Policies\\a\\\\b': false, 'Software\\Policies\\a\nb': false, 'Software\\Policies\\a\n': false }
  for (const [k, want] of Object.entries(keys)) {
    assert.equal(key.test(k), want, JSON.stringify(k))
    let accepted = true
    try { declaredRegAllow([{ hive: 'HKCU', key: k, names: ['x'] }]) } catch { accepted = false }
    assert.equal(accepted, want, `declaredRegAllow: ${JSON.stringify(k)}`)
  }
  const names = { egressProxyUrl: true, 'a b': true, 'A_b-1.2': true, '': false, '.x': false, 'a\\b': false, 'a"b': false, 'a\nb': false, 'a\n': false, [`x${'y'.repeat(64)}`]: false }
  for (const [n, want] of Object.entries(names)) assert.equal(name.test(n), want, JSON.stringify(n))
})

/** Delimiters balance outside comments, strings and here-strings: the cheapest guard against a typo in code no CI here can run. */
function balanced(src, { comment }) {
  const stack = []
  const pairs = { ')': '(', ']': '[', '}': '{' }
  const ps = comment === '#'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if ((ps && c === '#') || (!ps && c === '/' && src[i + 1] === '/')) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '\'' || c === '"') {
      i++
      while (i < src.length) {
        if (ps && c === '\'' && src[i] === '\'' && src[i + 1] === '\'') { i += 2; continue } // '' inside a PowerShell single-quoted string
        if (src[i] === c) break
        if ((ps && c === '"' && src[i] === '`') || (!ps && src[i] === '\\')) i++
        i++
      }
      i++
      continue
    }
    if ('([{'.includes(c)) stack.push(c)
    else if (pairs[c]) { if (stack.pop() !== pairs[c]) return `unbalanced ${c} near offset ${i}` }
    i++
  }
  return stack.length ? `unclosed ${stack.join('')}` : null
}

test('W1 helper.ps1 and the C# inside it have balanced delimiters', () => {
  const hereStrings = [...PS.matchAll(/@'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1])
  assert.ok(hereStrings.length >= 2, 'the C# and the allow-list are here-strings')
  const cs = hereStrings.find((h) => h.includes('DllImport'))
  assert.ok(cs, 'the native code is a here-string')
  assert.equal(balanced(cs, { comment: '//' }), null)
  const rest = PS.replace(/@'\r?\n[\s\S]*?\r?\n'@/g, '')
  assert.equal(balanced(rest, { comment: '#' }), null)
  assert.equal(balanced('function f { if ($a) { 1 }', { comment: '#' }), 'unclosed {', 'the checker itself can fail')
  assert.equal(balanced("$x = 'it''s (' # }", { comment: '#' }), null, "a doubled quote stays inside the string")
})

test('W1 helper.ps1 is ASCII only (Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page)', () => {
  assert.equal([...PS].filter((ch) => ch.charCodeAt(0) > 126).length, 0)
  assert.ok(!PS.startsWith('\uFEFF'))
})

// ---------- W2: process facts and exec / exit by snapshot difference ----------

const row = (pid, extra = {}) => ({ pid, ppid: 1, name: `p${pid}.exe`, exe: `C:\\apps\\p${pid}.exe`, cmdline: `"C:\\apps\\p${pid}.exe" --x`, startedAt: 1000 + pid, sessionId: 2, integrity: 'medium', tokenDenied: false, ...extra })
/** An in-process helper whose `ps` answers the given snapshots in turn (the last repeats); an Error in the list is thrown. */
function psHelper(snapshots, { delayMs = 0 } = {}) {
  let i = 0
  return {
    calls: [],
    async call(verb, args, opts) {
      this.calls.push({ verb, args, opts })
      if (verb !== 'ps') throw new Error(`unexpected verb ${verb}`)
      const procs = snapshots[Math.min(i++, snapshots.length - 1)]
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (procs instanceof Error) throw procs
      return { sessionId: 2, procs }
    },
  }
}
function collect(w) { const ev = []; for (const n of ['exec', 'exit', 'facts-update', 'facts-error', 'poll-error']) w.on(n, (x) => ev.push([n, x])); return ev }
const brief = (ev) => ev.map(([n, x]) => [n, x.pid])







// ---------- W2: a command line that is not there yet is told, not lost (4.8 §1 `ps`) ----------

/** A ps row whose command line the helper has no answer for (yet). */
const noCmd = (pid, state, extra = {}) => row(pid, { cmdline: null, cmdlineState: state, ...extra })






test('W2 helper.ps1 gives each ps row a cmdlineState from exactly the set the watcher knows, and the C# writes it', () => {
  const states = [...PS.matchAll(/\$state\[\$p\.Pid\]\s*=\s*'([a-z-]+)'/g)].map((m) => m[1])
  assert.deepEqual([...new Set(states)].sort(), [...CMDLINE_STATES].sort())
  assert.ok(/ProcsJson\(\$list, \$dict, \$state\)/.test(PS), 'the verb hands the states to the JSON builder')
  assert.ok(/\\"cmdlineState\\":/.test(PS), 'the JSON builder writes the field')
  assert.deepEqual([...CMDLINE_STATES], ['ok', 'pending', 'cim-backoff', 'empty', 'not-asked'])
})

test('W2 elevation: integrity High or above is elevated; a token that cannot be opened while the image path can is elevated, marked inferred (4.8 §10.1)', () => {
  assert.deepEqual(elevationOf({ integrity: 'high', tokenDenied: false, exe: 'C:\\a.exe' }), { elevated: true, inferred: false })
  assert.deepEqual(elevationOf({ integrity: 'system', exe: 'C:\\a.exe' }), { elevated: true, inferred: false })
  assert.deepEqual(elevationOf({ integrity: 'medium', exe: 'C:\\a.exe' }), { elevated: false, inferred: false })
  assert.deepEqual(elevationOf({ integrity: 'low', exe: 'C:\\a.exe' }), { elevated: false, inferred: false })
  assert.deepEqual(elevationOf({ integrity: null, tokenDenied: true, exe: 'C:\\a.exe' }), { elevated: true, inferred: true })
  assert.deepEqual(elevationOf({ integrity: null, tokenDenied: true, exe: null }), { elevated: null, inferred: false }, 'neither token nor image: not known')
  assert.deepEqual(elevationOf({ integrity: null, tokenDenied: false, exe: 'C:\\a.exe' }), { elevated: null, inferred: false })
})












test('W2 a command line is split the way CommandLineToArgvW does (the documented cases), and a missing one is no arguments', () => {
  // the documented argument rules, after a program name (the first token has rules of its own, below)
  const args = [
    ['"abc" d e', ['abc', 'd', 'e']],
    ['a\\\\\\b d"e f"g h', ['a\\\\\\b', 'de fg', 'h']], // backslashes not before a quote are literal
    ['a\\\\\\"b c d', ['a\\"b', 'c', 'd']], // 3 backslashes and a quote: one backslash, a literal quote
    ['a\\\\\\\\"b c" d e', ['a\\\\b c', 'd', 'e']], // 4 backslashes and a quote: two backslashes, and the quote opens a string
    ['"""CallMeIshmael"""  b  c', ['"CallMeIshmael"', 'b', 'c']], // "" inside a quoted string is a quote
    ['"C:\\a b\\x.mjs" --flag="v w" c:\\p\\', ['C:\\a b\\x.mjs', '--flag=v w', 'c:\\p\\']],
    ['x ""', ['x', '']],
    ['a\tb', ['a', 'b']],
  ]
  for (const [input, want] of args) assert.deepEqual(splitCommandLine('p.exe ' + input), ['p.exe', ...want], input)
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\x.mjs"'), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\x.mjs'])
  assert.deepEqual(splitCommandLine('"C:\\dir with space\\" next'), ['C:\\dir with space\\', 'next'], 'the program name takes no backslash escapes')
  assert.deepEqual(splitCommandLine('C:\\x\\a.exe'), ['C:\\x\\a.exe'])
  assert.deepEqual(splitCommandLine('node.exe  \t x'), ['node.exe', 'x'])
  for (const none of ['   ', '', null, undefined, 7]) assert.deepEqual(splitCommandLine(none), [], String(none))
})

// ---------- W4: who owns the accepted socket's peer end — the targeted 4-tuple question (4.8 §5.3, D47's twin) ----------

/** A row of the helper's tcp-table answer: the AGENT's own socket would carry the peer as its local end. */
const trow = (pid, localPort, extra = {}) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort, remoteAddr: '127.0.0.1', remotePort: 17991, ...extra })
/** An in-process helper whose tcp-table answers the given rows as they are (it is trusted to filter, the ask says what it wants: the client filters again here). */
function tableHelper(rows, { error = null, delayMs = 0 } = {}) {
  return {
    calls: [],
    async call(verb, args, opts) {
      this.calls.push({ verb, args, opts })
      if (opts && typeof opts.onStart === 'function') opts.onStart() // an in-process helper is on the read at once
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (error) throw error
      return { rows }
    },
  }
}
const PEER = { address: '127.0.0.1', port: 5010 }

test('W4 the row whose local end is the peer answers its pid, from the socket table', async () => {
  const h = tableHelper([trow(10, 5010), trow(11, 5011)])
  const r = await ownerOfSocket({ helper: h, peer: PEER })
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: 10, source: 'socket-table' })
  assert.equal(typeof r.ms, 'number')
  assert.deepEqual(h.calls.map((c) => [c.verb, c.args]), [['tcp-table', { localPort: 5010, states: ['established'] }]], 'one targeted question: the table filtered to the peer\'s local port and established rows')
})

test('W4 two rows of that local end (a wrapped pid mid-query): null, never a guess', async () => {
  assert.equal((await ownerOfSocket({ helper: tableHelper([trow(10, 5010), trow(11, 5010)]), peer: PEER })).pid, null)
  assert.equal((await ownerOfSocket({ helper: tableHelper([trow(10, 5011)]), peer: PEER })).pid, null, 'no row of that local end: the socket is gone')
})

test('W4 the engine\'s own accepted socket and ownerless rows are not holders: pid exclusion and pid 0 (TIME_WAIT)', async () => {
  assert.equal((await ownerOfSocket({ helper: tableHelper([trow(process.pid, 5010)]), peer: PEER })).pid, null, 'the engine\'s pid is excluded (belt and braces: its accepted socket shows the peer as its REMOTE end and does not match the local-end filter anyway)')
  assert.equal((await ownerOfSocket({ helper: tableHelper([trow(0, 5010, { state: 'time-wait' }), trow(11, 5010)]), peer: PEER })).pid, 11, 'a TIME_WAIT row has no owner; it is the end of some earlier connection')
})

test('W4 the client filters the answer again: rows of other ports or addresses are ignored, whatever the helper did', async () => {
  const rows = [trow(999, 9999), trow(10, 5010, { localAddr: '10.1.2.3' }), trow(11, 5010, { localPort: 5011 }), trow(12, 5010)]
  assert.equal((await ownerOfSocket({ helper: tableHelper(rows), peer: PEER })).pid, 12)
})

test('W4 a peer that is not an IPv4 literal is answered null at once, with no table read', async () => {
  const h = tableHelper([trow(10, 5010)])
  assert.equal((await ownerOfSocket({ helper: h, peer: { address: '::1', port: 5010 } })).ms, 0)
  assert.equal(h.calls.length, 0, 'the doors bind 127.0.0.1 only: an IPv6 peer cannot be one of the agents\' sockets')
})

test('W4 a table that answers after 250 ms is null with ms >= 250, and not a failure', async () => {
  const failures = []
  const r = await ownerOfSocket({ helper: tableHelper([trow(10, 5010)], { delayMs: 1500 }), peer: PEER, onFailure: (f) => failures.push(f) })
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
  assert.ok(r.ms >= 250, `ms ${r.ms}`)
  assert.ok(r.ms < 1200, `it did not wait for the late answer: ${r.ms}`)
  assert.deepEqual(failures, [])
  const h = tableHelper([trow(10, 5010)])
  await ownerOfSocket({ helper: h, peer: PEER, budgetMs: 80 })
  assert.equal(h.calls[0].opts.timeoutMs, 80)
  const slow = Object.assign(new Error('helper tcp-table timed out after 80 ms'), { code: 'helper-timeout' })
  const t = await ownerOfSocket({ helper: tableHelper([], { error: slow }), peer: PEER, budgetMs: 80, onFailure: (f) => failures.push(f) })
  assert.ok(t.pid === null && t.ms >= 80)
  assert.deepEqual(failures, [], 'a helper-side timeout is over budget too: slow, not unavailable')
})

test('W4 a table that cannot be read is null and one socktable-unavailable (a record the closed set knows)', async () => {
  for (const error of [Object.assign(new Error('native-unavailable: Add-Type blocked'), { code: 'helper-verb-error' }), Object.assign(new Error('helper is down: killed'), { code: 'helper-down' })]) {
    const failures = []
    const r = await ownerOfSocket({ helper: tableHelper([], { error }), peer: PEER, onFailure: (f) => failures.push(f) })
    assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
    assert.equal(failures.length, 1)
    assert.deepEqual([failures[0].event, failures[0].where, failures[0].code], ['failure', 'helper', 'socktable-unavailable'])
    assert.ok(failures[0].reason.includes(error.message))
    assert.deepEqual(checkRecord(failures[0]), [])
  }
  const failures = []
  await ownerOfSocket({ helper: { call: async () => ({ nonsense: true }) }, peer: PEER, onFailure: (f) => failures.push(f) })
  assert.equal(failures.length, 1, 'an answer with no rows is an unreadable table, not an empty one')
})

test('W4 a lookup in flight when the helper is closed is null and NOT a failure: an operator\'s stop (off, stop) is not an unreadable table', async (t) => {
  const failures = []
  const h = started(t, { verbs: { 'tcp-table': { delayMs: 300, data: { rows: [trow(10, 5010)] } } } })
  await h.ready
  const asked = ownerOfSocket({ helper: h, peer: PEER, budgetMs: 2000, onFailure: (f) => failures.push(f) })
  await new Promise((r) => setTimeout(r, 20))
  await h.close()
  const r = await asked
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
  assert.deepEqual(failures, [], 'helper-closed is the daemon stopping its own helper')
  assert.equal((await ownerOfSocket({ helper: h, peer: PEER, onFailure: (f) => failures.push(f) })).pid, null)
  assert.deepEqual(failures, [])
})

test('W4 through the real client and the fake helper: the verb answers the rows of the peer\'s local port, the rest is the same; a failing verb is the failure record', async (t) => {
  const rows = [trow(10, 5010), trow(11, 5011), trow(12, 5010, { family: 6, localAddr: '::1' })]
  const h = started(t, { verbs: { 'tcp-table': { data: { rows } } } })
  assert.equal((await ownerOfSocket({ helper: h, peer: PEER })).pid, 10, 'the ::1 row does not hold the 127.0.0.1 peer')
  const bad = started(t, { verbs: { 'tcp-table': { error: 'GetExtendedTcpTable af=23 rc=50' } } })
  const failures = []
  assert.equal((await ownerOfSocket({ helper: bad, peer: PEER, onFailure: (f) => failures.push(f) })).pid, null)
  assert.match(failures[0].reason, /rc=50/)
})

// ---------- W2: the targeted facts question of one pid (4.8 §5.3, D47's twin) ----------

test('W2 factsOfPid: the pid\'s row of the helper\'s ps answer, as ProcFacts with source accept; a pid nobody lists is null, not an error', async () => {
  const h = tableHelper([]) // shape only; a ps helper of its own below
  const psHelper = (procs) => ({ calls: [], async call(verb, args, opts) { this.calls.push({ verb, args, opts }); return { sessionId: 2, procs } } })
  const row = { pid: 12, ppid: 1, name: 'p12.exe', exe: 'C:\\apps\\p12.exe', cmdline: '"C:\\apps\\p12.exe" --x', startedAt: 1012, sessionId: 2, sameUser: true, integrity: 'medium', tokenDenied: false }
  const good = psHelper([row, { ...row, pid: 13 }])
  const facts = await factsOfPid(12, { helper: good })
  assert.deepEqual({ ...facts }, {
    os: 'win32', pid: 12, ppid: 1, name: 'p12.exe', exe: 'C:\\apps\\p12.exe', argv: ['C:\\apps\\p12.exe', '--x'], cmdline: '"C:\\apps\\p12.exe" --x', env: null, envRead: false, cwd: null,
    startedAt: 1012, startTicks: '1012', sessionId: 2, sameUser: true, integrity: 'medium', tokenDenied: false, elevated: false, elevationInferred: false, source: 'accept', cmdlineState: 'ok',
  })
  assert.equal(facts.envError, 'env-unreadable')
  assert.deepEqual(good.calls.map((c) => [c.verb, c.args]), [['ps', {}]], 'one targeted ask: the session snapshot, the row picked here')
  assert.equal((await factsOfPid(99, { helper: psHelper([row]) })), null, 'the process is gone between the accept and the ask: the honest answer')
  assert.equal((await factsOfPid(12, { helper: { call: async () => { throw Object.assign(new Error('helper is down: killed'), { code: 'helper-down' }) } } })), null, 'a helper that is down: no facts, the fail-safe answer, never a throw into the lookup')
  await assert.rejects(() => factsOfPid('12', { helper: good }), /needs the pid/)
  await assert.rejects(() => factsOfPid(12, {}), /needs the helper/)
  assert.ok(h, 'unused')
})
