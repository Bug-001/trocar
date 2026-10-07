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
import { HELPER_PROTO, HELPER_VERBS, HELPER_PS1, REG_READ_ALLOW, startHelper } from '../../../../src/collector/arch/win32/helper.mjs'
import { createProcWatcher, elevationOf, splitCommandLine } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { ownerOf } from '../../../../src/collector/arch/win32/socktable.mjs'
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
  const h = started(t, { verbs: { ps: { delayMs: 400, data: {} } } })
  await rejects(h.call('ps', {}, { timeoutMs: 30 }), 'helper-timeout')
  await new Promise((r) => setTimeout(r, 450)) // the late reply arrives for an id nobody waits for
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
  'kernel32.dll!QueryFullProcessImageName',
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
  for (const m of body.matchAll(/\bOpenProcess\(\s*([^,)]*)/g)) if (m[1].trim() !== '0x1000') out.push(`OpenProcess with access ${m[1].trim()}: only PROCESS_QUERY_LIMITED_INFORMATION (0x1000) reads`)
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
  assert.equal(NATIVE_IMPORTS.length, 17)
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

test('W1 helper.ps1 answers exactly the verbs the JS side allows, and reads exactly the registry names the JS side allows', () => {
  const verbs = [...PS.matchAll(/^\s*'([a-z-]+)'\s*\{/gm)].map((m) => m[1])
  assert.deepEqual([...verbs].sort(), [...HELPER_VERBS].sort())
  assert.equal(Number(/\$script:Proto\s*=\s*(\d+)/.exec(PS)[1]), HELPER_PROTO, 'the protocol number in the ready line')
  const m = /\$RegAllowJson\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/.exec(PS)
  assert.ok(m, 'the allow-list literal is there')
  assert.deepEqual(JSON.parse(m[1]), JSON.parse(JSON.stringify(REG_READ_ALLOW)))
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
    async call(verb, args) {
      this.calls.push({ verb, args })
      if (verb !== 'ps') throw new Error(`unexpected verb ${verb}`)
      const procs = snapshots[Math.min(i++, snapshots.length - 1)]
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (procs instanceof Error) throw procs
      return { sessionId: 2, procs }
    },
  }
}
function collect(w) { const ev = []; for (const n of ['exec', 'exit', 'facts-error', 'poll-error']) w.on(n, (x) => ev.push([n, x])); return ev }
const brief = (ev) => ev.map(([n, x]) => [n, x.pid])

test('W2 a new pid is an exec, a vanished one an exit; the first snapshot is the baseline and says nothing', async () => {
  const w = createProcWatcher({ helper: psHelper([[row(10), row(11)], [row(11), row(12)], [row(11), row(12)]]) })
  const ev = collect(w)
  await w.poll()
  assert.deepEqual(ev, [], 'what was already running is scan()\'s, not an exec')
  await w.poll()
  assert.deepEqual(brief(ev), [['exit', 10], ['exec', 12]])
  assert.deepEqual(ev[0][1], { pid: 10, startedAt: 1010 })
  const facts = ev[1][1]
  assert.deepEqual({ ...facts }, {
    os: 'win32', pid: 12, ppid: 1, name: 'p12.exe', exe: 'C:\\apps\\p12.exe', argv: ['C:\\apps\\p12.exe', '--x'], cmdline: '"C:\\apps\\p12.exe" --x', env: null, cwd: null,
    startedAt: 1012, startTicks: '1012', sessionId: 2, integrity: 'medium', tokenDenied: false, elevated: false, elevationInferred: false, source: 'exec',
  })
  assert.equal(facts.envError, 'env-unreadable', 'another process\'s environment is never read on Windows (4.8 §10.1): null with the reason, not an empty one')
  await w.poll()
  assert.equal(ev.length, 2, 'an unchanged snapshot is silent')
})

test('W2 the same pid with another start time is an exit and then an exec (pid reuse), also when the program is the same', async () => {
  const w = createProcWatcher({ helper: psHelper([[row(10)], [row(10, { startedAt: 5000 })], [row(10, { startedAt: 6000, exe: 'C:\\other\\o.exe' })]]) })
  const ev = collect(w)
  await w.poll()
  await w.poll()
  assert.deepEqual(ev.map(([n, x]) => [n, x.pid, x.startedAt]), [['exit', 10, 1010], ['exec', 10, 5000]])
  await w.poll()
  assert.deepEqual(ev.slice(2).map(([n, x]) => [n, x.pid, x.startedAt]), [['exit', 10, 5000], ['exec', 10, 6000]])
})

test('W2 a start time that cannot be read falls back to the image path to tell a reused pid', async () => {
  const w = createProcWatcher({ helper: psHelper([[row(10, { startedAt: null })], [row(10, { startedAt: null })], [row(10, { startedAt: null, exe: 'C:\\other\\o.exe' })]]) })
  const ev = collect(w)
  await w.poll(); await w.poll()
  assert.deepEqual(ev, [])
  await w.poll()
  assert.deepEqual(brief(ev), [['exit', 10], ['exec', 10]])
  assert.equal(ev[1][1].startTicks, null, 'no start time: no marker identity either')
})

test('W2 scan() lists the live processes as facts (source scan) and changes nothing the diff knows', async () => {
  const h = psHelper([[row(10), row(11)], [row(11), row(12)]])
  const w = createProcWatcher({ helper: h })
  const ev = collect(w)
  const first = await w.scan()
  assert.deepEqual(first.map((f) => [f.pid, f.source]), [[10, 'scan'], [11, 'scan']])
  assert.deepEqual(ev, [])
  await w.poll() // the baseline is the second snapshot; scan() did not take it
  assert.deepEqual(ev, [])
  assert.deepEqual(h.calls.map((c) => c.args), [{}, {}], 'this session only (the helper default)')
  const all = createProcWatcher({ helper: h, all: true })
  await all.scan()
  assert.deepEqual(h.calls.at(-1).args, { all: true })
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

test('W2 a fixture process with tokenDenied and a readable image comes out of scan() elevated and inferred', async () => {
  const w = createProcWatcher({ helper: psHelper([[row(20, { integrity: null, tokenDenied: true }), row(21, { integrity: 'high' })]]) })
  const [a, b] = await w.scan()
  assert.deepEqual([a.elevated, a.elevationInferred, a.tokenDenied], [true, true, true])
  assert.deepEqual([b.elevated, b.elevationInferred], [true, false])
})

test('W2 a process whose image cannot be read is never an exec: one facts-error with what is still readable, listed in unreadable()', async () => {
  const bad = row(30, { exe: null, name: 'svc.exe', cmdline: 'svc.exe --serve' })
  const w = createProcWatcher({ helper: psHelper([[row(10), bad], [row(10), bad], [row(10)]]) })
  const ev = collect(w)
  await w.poll()
  await w.poll()
  assert.deepEqual(ev.map(([n]) => n), ['facts-error'], 'told once, not on every snapshot')
  assert.deepEqual(ev[0][1], { os: 'win32', pid: 30, comm: 'svc.exe', argv: ['svc.exe', '--serve'], code: null, reason: ev[0][1].reason })
  assert.match(ev[0][1].reason, /svc\.exe.*image path.*never judged/)
  assert.deepEqual(w.unreadable(), [{ pid: 30, comm: 'svc.exe', errno: null, argv: ['svc.exe', '--serve'] }])
  assert.deepEqual((await w.scan()).map((f) => f.pid), [10], 'scan() lists the readable ones only; this snapshot no longer has pid 30')
  assert.deepEqual(w.unreadable(), [], 'gone again')
})

test('W2 a helper that fails is one poll-error per run of failures, never a throw; after a good poll it tells again', async () => {
  const down = Object.assign(new Error('helper is down: killed'), { code: 'helper-down' })
  const w = createProcWatcher({ helper: psHelper([[row(10)], down, down, [row(10)], down]) })
  const ev = collect(w)
  assert.equal(await w.poll(), true)
  await w.poll(); await w.poll()
  assert.deepEqual(ev.map(([n, x]) => [n, x.code, x.cause]), [['poll-error', 'helper-error', 'helper-down']], 'the code is the closed set\'s helper-error; what the client said is the cause')
  await w.poll(); await w.poll()
  assert.equal(ev.length, 2)
  assert.match(ev[1][1].reason, /down/)
})

test('W2 start() polls at once and on the interval; a poll still in flight is not started twice; stop() clears the timer', async () => {
  const h = psHelper([[row(10)], [row(10), row(11)]], { delayMs: 30 })
  let tick; let cleared = 0
  const w = createProcWatcher({ helper: h, intervalMs: 77, timers: { setInterval: (fn, ms) => { tick = { fn, ms }; return 'T' }, clearInterval: (t) => { if (t === 'T') cleared++ } } })
  const ev = collect(w)
  w.start()
  assert.equal(tick.ms, 77)
  tick.fn() // a tick while the first poll is still in flight: skipped
  await until(() => w.stats().polls === 1)
  assert.equal(h.calls.length, 1)
  tick.fn()
  await until(() => ev.length)
  assert.deepEqual(brief(ev), [['exec', 11]])
  w.stop()
  assert.equal(cleared, 1)
})

test('W2 through the real client and the fake helper: a ps answer becomes facts', async (t) => {
  const h = started(t, { verbs: { ps: { seq: [{ sessionId: 2, procs: [row(10)] }, { sessionId: 2, procs: [row(10), row(11)] }] } } })
  const w = createProcWatcher({ helper: h })
  const ev = collect(w)
  await w.poll(); await w.poll()
  assert.deepEqual(brief(ev), [['exec', 11]])
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

// ---------- W4: which of the form's processes holds the connection to the hop (4.8 §5.3) ----------

const trow = (pid, remotePort, extra = {}) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: 50000 + pid, remoteAddr: '127.0.0.1', remotePort, ...extra })
/** An in-process helper whose tcp-table answers the given rows as they are (no filtering: ownerOf must not rely on the helper's). */
function tableHelper(rows, { error = null, delayMs = 0 } = {}) {
  return {
    calls: [],
    async call(verb, args, opts) {
      this.calls.push({ verb, args, opts })
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (error) throw error
      return { rows }
    },
  }
}
const HOP = { port: 7897 }

test('W4 exactly one of the form\'s processes holds a connection to the hop (any state): its pid, from the socket table', async () => {
  const h = tableHelper([trow(10, 7897), trow(11, 443), trow(11, 8080)])
  const r = await ownerOf({ helper: h, hop: HOP, candidates: [10, 11] })
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: 10, source: 'socket-table' })
  assert.equal(typeof r.ms, 'number')
  assert.deepEqual(h.calls.map((c) => [c.verb, c.args.pids, c.args.remotePort]), [['tcp-table', [10, 11], 7897]])
})

test('W4 two processes of the form hold one: null, never a guess', async () => {
  const r = await ownerOf({ helper: tableHelper([trow(10, 7897), trow(11, 7897)]), hop: HOP, candidates: [10, 11] })
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
  assert.equal((await ownerOf({ helper: tableHelper([trow(10, 443)]), hop: HOP, candidates: [10, 11] })).pid, null, 'none holds one')
})

test('W4 a long-lived connection opened before `on` counts like any other, and nothing is ever "claimed": the same table gives the same answer every time', async () => {
  const old = trow(10, 7897, { state: 'close-wait', localPort: 40000 }) // older than the switch, half closed: any state, any age
  const h = tableHelper([old])
  for (let i = 0; i < 3; i++) assert.equal((await ownerOf({ helper: h, hop: HOP, candidates: [10, 11] })).pid, 10)
  // a second process opens a connection later: now it is ambiguous, however old the first one is
  assert.equal((await ownerOf({ helper: tableHelper([old, trow(11, 7897)]), hop: HOP, candidates: [10, 11] })).pid, null)
})

test('W4 one candidate is the answer without a table read (single-process); no candidate, no answer', async () => {
  const h = tableHelper([trow(10, 7897)])
  const r = await ownerOf({ helper: h, hop: HOP, candidates: [10] })
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: 10, source: 'single-process' })
  assert.equal((await ownerOf({ helper: h, hop: HOP, candidates: [10, 10] })).source, 'single-process', 'a pid listed twice is one candidate')
  assert.equal((await ownerOf({ helper: h, hop: HOP, candidates: [] })).pid, null)
  assert.equal(h.calls.length, 0, 'zero table reads')
})

test('W4 the answer does not depend on the helper having filtered: rows of other pids and other ports are ignored here too', async () => {
  const rows = [trow(999, 7897), trow(10, 9999), trow(11, 7897, { remoteAddr: '10.1.2.3' }), trow(12, 7897)]
  assert.equal((await ownerOf({ helper: tableHelper(rows), hop: HOP, candidates: [10, 11, 12] })).pid, null, 'pid 11 also holds a row to that port, on another host: still ambiguous')
  assert.equal((await ownerOf({ helper: tableHelper(rows), hop: { port: 7897, address: '127.0.0.1' }, candidates: [10, 11, 12] })).pid, 12, 'a hop that names its address narrows the rows')
})

test('W4 a table that answers after 250 ms is null with ms >= 250, and not a failure', async () => {
  const failures = []
  const r = await ownerOf({ helper: tableHelper([trow(10, 7897)], { delayMs: 1500 }), hop: HOP, candidates: [10, 11], onFailure: (f) => failures.push(f) })
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
  assert.ok(r.ms >= 250, `ms ${r.ms}`)
  assert.ok(r.ms < 1200, `it did not wait for the late answer: ${r.ms}`)
  assert.deepEqual(failures, [])
  // the budget is a parameter, and the helper's own timeout is the same budget
  const h = tableHelper([trow(10, 7897)])
  await ownerOf({ helper: h, hop: HOP, candidates: [10, 11], budgetMs: 80 })
  assert.equal(h.calls[0].opts.timeoutMs, 80)
  const slow = Object.assign(new Error('helper tcp-table timed out after 80 ms'), { code: 'helper-timeout' })
  const t = await ownerOf({ helper: tableHelper([], { error: slow }), hop: HOP, candidates: [10, 11], budgetMs: 80, onFailure: (f) => failures.push(f) })
  assert.ok(t.pid === null && t.ms >= 80)
  assert.deepEqual(failures, [], 'a helper-side timeout is over budget too')
})

test('W4 a table that cannot be read is null and one socktable-unavailable (a record the closed set knows)', async () => {
  for (const error of [Object.assign(new Error('native-unavailable: Add-Type blocked'), { code: 'helper-verb-error' }), Object.assign(new Error('helper is down: killed'), { code: 'helper-down' })]) {
    const failures = []
    const r = await ownerOf({ helper: tableHelper([], { error }), hop: HOP, candidates: [10, 11], onFailure: (f) => failures.push(f) })
    assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
    assert.equal(failures.length, 1)
    assert.deepEqual([failures[0].event, failures[0].where, failures[0].code], ['failure', 'helper', 'socktable-unavailable'])
    assert.ok(failures[0].reason.includes(error.message))
    assert.deepEqual(checkRecord(failures[0]), [])
  }
  const failures = []
  await ownerOf({ helper: { call: async () => ({ nonsense: true }) }, hop: HOP, candidates: [10, 11], onFailure: (f) => failures.push(f) })
  assert.equal(failures.length, 1, 'an answer with no rows is an unreadable table, not an empty one')
})

test('W4 a lookup in flight when the helper is closed is null and NOT a failure: an operator\'s stop (off, stop) is not an unreadable table', async (t) => {
  const failures = []
  const h = started(t, { verbs: { 'tcp-table': { delayMs: 300, data: { rows: [trow(10, 7897)] } } } })
  await h.ready
  const asked = ownerOf({ helper: h, hop: HOP, candidates: [10, 11], budgetMs: 2000, onFailure: (f) => failures.push(f) })
  await new Promise((r) => setTimeout(r, 20))
  await h.close()
  const r = await asked
  assert.deepEqual({ pid: r.pid, source: r.source }, { pid: null, source: null })
  assert.deepEqual(failures, [], 'helper-closed is the daemon stopping its own helper')
  // the helper being closed before the question is asked is the same
  assert.equal((await ownerOf({ helper: h, hop: HOP, candidates: [10, 11], onFailure: (f) => failures.push(f) })).pid, null)
  assert.deepEqual(failures, [])
  // while a helper that DIED under the question is still a failure (W4's unreadable case, above)
})

test('W4 through the real client and the fake helper: the verb filters, the answer is the same; a failing verb is the failure record', async (t) => {
  const rows = [trow(10, 7897), trow(11, 443), trow(12, 7897, { family: 6, localAddr: '::1', remoteAddr: '::1' })]
  const h = started(t, { verbs: { 'tcp-table': { data: { rows } } } })
  assert.equal((await ownerOf({ helper: h, hop: HOP, candidates: [10, 11] })).pid, 10)
  assert.equal((await ownerOf({ helper: h, hop: HOP, candidates: [10, 12] })).pid, null)
  const bad = started(t, { verbs: { 'tcp-table': { error: 'GetExtendedTcpTable af=23 rc=50' } } })
  const failures = []
  assert.equal((await ownerOf({ helper: bad, hop: HOP, candidates: [10, 11], onFailure: (f) => failures.push(f) })).pid, null)
  assert.match(failures[0].reason, /rc=50/)
})
