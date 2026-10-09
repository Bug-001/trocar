// test/collector/arch/win32/userpath.test.mjs — the user PATH, the command lookup, Smart App Control and the shortcut read of the opt-in items
// (4.8 §6.3; W21; plan Task 14). Everything runs through an injected reg.exe/powershell runner over a fake registry: no real tool is spawned
// (0.1 §3; the .ps1 writers are DATA to the tests on a Mac, their first real run is the lab's). The three commands this module issues are the
// same bytes src/off's inline undo issues — that equality is test/off/win32-optin.test.mjs's, which reads this module's exported argv.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  USER_PATH_KEY, readUserPathArgs, setUserPathArgs, BROADCAST_ARGS,
  readUserPath, prependUserPath, removeUserPathItem, resolveCommand, PATH_EXTS,
  sacOf, sacBlocksShims, SAC_KEY, readShortcutTarget, shortcutPlaces,
} from '../../../../src/collector/arch/win32/userpath.mjs'
import { MACHINE_PATH_KEY } from '../../../../src/collector/arch/win32/elevate.mjs'
import { sacBlocks as forwarderSacBlocks } from '../../../../src/collector/arch/win32/forwarder.mjs'

/** reg.exe / powershell as a recording fake over one fake registry: `reg` is { hive-key: { NAME: { kind, value } } }, `powershell` answers the
 *  fixed reads (the broadcast, the shortcut read) and counts the broadcasts. reg.exe's real output shape is spelled out below — the same shape
 *  readMachinePath's test pins for the machine PATH. */
function fakeWin({ reg = {}, lnks = {} } = {}) {
  const state = {
    'HKCU\\Environment': { Path: reg.userPath ? { kind: 'REG_EXPAND_SZ', value: reg.userPath } : null },
    [MACHINE_PATH_KEY]: { Path: { kind: 'REG_EXPAND_SZ', value: reg.machinePath ?? 'C:\\Windows\\system32;C:\\Windows' } },
    [SAC_KEY]: reg.sac === undefined ? null : { VerifiedAndReputablePolicyState: { kind: 'REG_DWORD', value: reg.sac } },
    ...(reg.policy ? { 'HKCU\\SOFTWARE\\Policies\\Claude': { egressProxyUrl: { kind: 'REG_SZ', value: reg.policy } } } : {}),
  }
  const calls = []
  const broadcasts = []
  const out = (v) => ({ status: 0, stdout: v, stderr: '' })
  const run = (file, args, opts = {}) => {
    calls.push([file, ...args])
    if (file === 'reg') {
      const key = args[1], name = args[args.indexOf('/v') + 1]
      const hive = state[key]
      if (args[0] === 'query') {
        if (!hive || !hive[name]) return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
        const v = hive[name]
        const text = v.kind === 'REG_DWORD' ? `0x${v.value.toString(16)}` : v.value
        return out(`\r\n${key}\r\n    ${name}    ${v.kind}    ${text}\r\n\r\n`)
      }
      if (args[0] === 'add') {
        const kind = args[args.indexOf('/t') + 1], value = args[args.indexOf('/d') + 1]
        state[key] = state[key] || {}
        state[key][name] = { kind, value }
        return out('')
      }
    }
    if (file === 'powershell') {
      const cmd = args[args.length - 1]
      if (/SendMessageTimeout/.test(cmd)) { broadcasts.push(cmd); return out('') }
      const m = /CreateShortcut\('(.*)'\)/.exec(cmd)
      if (m) return out(lnks[m[1]] ?? '')
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls, broadcasts, state }
}
const ENV = { USERPROFILE: 'C:\\Users\\alice' }

test('W21 readUserPath: the one query, the two kinds, absent vs unreadable (an unreadable PATH is refused, never guessed on)', () => {
  const w = fakeWin({ reg: { userPath: 'C:\\bin;%USERPROFILE%\\bin' } })
  assert.deepEqual(readUserPath({ run: w.run, env: ENV }), { kind: 'REG_EXPAND_SZ', value: 'C:\\bin;%USERPROFILE%\\bin' })
  assert.deepEqual(w.calls, [['reg', ...readUserPathArgs()]])
  assert.equal(readUserPath({ run: fakeWin({ reg: { userPath: 'C:\\a' } }).run, env: ENV }).kind, 'REG_EXPAND_SZ')
  const w2 = fakeWin({ reg: { userPath: 'C:\\a' } })
  w2.state['HKCU\\Environment'].Path = { kind: 'REG_SZ', value: 'C:\\a' }
  assert.deepEqual(readUserPath({ run: w2.run, env: ENV }), { kind: 'REG_SZ', value: 'C:\\a' }, 'the kind is kept as reg.exe spells it')
  const none = fakeWin({})
  assert.deepEqual(readUserPath({ run: none.run, env: ENV }), { absent: true }, 'no value yet: a fresh profile, not an error')
  const bad = { run: () => ({ status: 5, stdout: '', stderr: 'Access is denied.' }) }
  assert.match(readUserPath({ run: bad.run, env: ENV }).error, /reg query of the user PATH failed/)
})

test('W21 prependUserPath: the directory first, the type kept, zero setx, ONE WM_SETTINGCHANGE; the prior is the answer the ledger records', () => {
  const w = fakeWin({ reg: { userPath: 'C:\\npm;C:\\Windows' } })
  const r = prependUserPath({ dir: 'C:\\Users\\alice\\.asight\\collector\\bin', run: w.run, env: ENV })
  assert.equal(r.ok, true)
  assert.deepEqual(r.prior, { kind: 'REG_EXPAND_SZ', value: 'C:\\npm;C:\\Windows' })
  assert.equal(w.state['HKCU\\Environment'].Path.value, 'C:\\Users\\alice\\.asight\\collector\\bin;C:\\npm;C:\\Windows')
  assert.deepEqual(w.calls.filter((c) => c[0] === 'reg' && c[1] === 'add'), [['reg', ...setUserPathArgs('C:\\Users\\alice\\.asight\\collector\\bin;C:\\npm;C:\\Windows')]])
  assert.equal(w.calls.some((c) => c[0] === 'setx'), false, 'never setx: it truncates at 1024 characters')
  assert.equal(w.broadcasts.length, 1, 'one WM_SETTINGCHANGE broadcast per write')
  // the value's type is kept: a REG_SZ PATH stays REG_SZ, a fresh value is the REG_EXPAND_SZ Windows gives Path
  const sz = fakeWin({ reg: { userPath: 'C:\\npm' } })
  sz.state['HKCU\\Environment'].Path = { kind: 'REG_SZ', value: 'C:\\npm' }
  prependUserPath({ dir: 'C:\\b', run: sz.run, env: ENV })
  assert.deepEqual(sz.state['HKCU\\Environment'].Path, { kind: 'REG_SZ', value: 'C:\\b;C:\\npm' })
  const fresh = fakeWin({})
  prependUserPath({ dir: 'C:\\b', run: fresh.run, env: ENV })
  assert.deepEqual(fresh.state['HKCU\\Environment'].Path, { kind: 'REG_EXPAND_SZ', value: 'C:\\b' })
  assert.equal(fresh.broadcasts.length, 1)
  // idempotent: the directory already first -> the value is not rewritten (only the broadcast happens), adding it twice is a no-op
  const again = fakeWin({ reg: { userPath: 'C:\\b;C:\\npm' } })
  const r2 = prependUserPath({ dir: 'C:\\b', run: again.run, env: ENV })
  assert.deepEqual([r2.ok, again.calls.some((c) => c[0] === 'reg' && c[1] === 'add'), again.broadcasts.length], [true, false, 1])
  const dup = fakeWin({ reg: { userPath: 'C:\\x;C:\\b;C:\\npm' } })
  prependUserPath({ dir: 'C:\\b', run: dup.run, env: ENV })
  assert.equal(dup.state['HKCU\\Environment'].Path.value, 'C:\\b;C:\\x;C:\\npm', 'only our entry moves; the rest keeps its order')
  // a reg add that fails is a failure, and a broadcast that fails is said, not hidden
  const fails = { run: (file, args) => (file === 'reg' && args[0] === 'add' ? { status: 1, stdout: '', stderr: 'Access is denied.' } : { status: 0, stdout: '', stderr: '' }) }
  assert.equal(prependUserPath({ dir: 'C:\\b', run: fails.run, env: ENV }).ok, false)
  const quietWorld = fakeWin({ reg: { userPath: 'C:\\npm' } })
  const quiet = (file, args) => (file === 'powershell' ? { status: 1, stdout: '', stderr: '' } : quietWorld.run(file, args))
  const warned = prependUserPath({ dir: 'C:\\b', run: quiet, env: ENV })
  assert.deepEqual([warned.ok, /broadcast failed/.test(warned.broadcast_failed)], [true, true], 'the PATH stands, the warning is carried')
})

test('W21 removeUserPathItem: asight\'s one directory off the CURRENT value (never the pre-asight one written back), type kept, one broadcast, absent is fine', () => {
  const w = fakeWin({ reg: { userPath: 'C:\\Users\\alice\\.asight\\collector\\bin;C:\\npm' } })
  const r = removeUserPathItem({ dir: 'C:\\Users\\alice\\.asight\\collector\\bin', run: w.run, env: ENV })
  assert.deepEqual([r.ok, r.result, r.value], [true, 'undone', 'C:\\npm'])
  assert.equal(w.state['HKCU\\Environment'].Path.value, 'C:\\npm', 'D28: the item is dropped from the current value, the old value is not written back wholesale')
  assert.equal(w.broadcasts.length, 1)
  assert.equal(removeUserPathItem({ dir: 'C:\\asight-bin', run: fakeWin({ reg: { userPath: 'C:\\npm' } }).run, env: ENV }).result, 'absent')
  assert.equal(removeUserPathItem({ dir: 'C:\\b', run: fakeWin({}).run, env: ENV }).result, 'absent', 'no Path value at all: already as asked')
  const gone = fakeWin({ reg: { userPath: 'C:\\npm;C:\\b;C:\\WINDOWS\\system32' } })
  removeUserPathItem({ dir: 'c:\\B', run: gone.run, env: ENV })
  assert.equal(gone.state['HKCU\\Environment'].Path.value, 'C:\\npm;C:\\WINDOWS\\system32', 'the drop is case-blind')
})

test('resolveCommand follows Windows\' order — the machine PATH first, then the user PATH — from the registry, with PATHEXT\'s extensions; skip leaves directories out', () => {
  const files = new Set(['C:\\Windows\\system32\\kimi.com', 'C:\\Program Files\\kimi\\kimi.exe', 'C:\\Users\\alice\\AppData\\Roaming\\npm\\opencode.cmd', 'C:\\Users\\alice\\.asight\\collector\\bin\\opencode.cmd'])
  const exists = (p) => files.has(p)
  const reg = { userPath: 'C:\\Users\\alice\\.asight\\collector\\bin;C:\\Users\\alice\\AppData\\Roaming\\npm', machinePath: 'C:\\Windows\\system32;C:\\Program Files\\kimi' }
  assert.deepEqual(resolveCommand('kimi', { run: fakeWin({ reg }).run, env: ENV, exists }), { where: 'machine', path: 'C:\\Windows\\system32\\kimi.com' }, '.COM before .EXE, machine before user')
  const npmOnly = fakeWin({ reg: { ...reg, machinePath: 'C:\\Windows\\system32' } })
  assert.deepEqual(resolveCommand('opencode', { run: npmOnly.run, env: ENV, exists }), { where: 'user', path: 'C:\\Users\\alice\\.asight\\collector\\bin\\opencode.cmd' }, 'asight\'s own shim is an honest answer: this is the 「is the entry in effect」 read')
  assert.deepEqual(resolveCommand('opencode', { run: npmOnly.run, env: ENV, exists, skip: ['c:\\users\\alice\\.asight\\collector\\bin'] }), { where: 'user', path: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\opencode.cmd' }, 'the real-binary lookup skips asight\'s bin (a shim of an earlier opt-in is not the real binary)')
  assert.equal(resolveCommand('nope', { run: npmOnly.run, env: ENV, exists }), null)
  assert.equal(resolveCommand('bad name', { run: npmOnly.run, env: ENV, exists }), null, 'a command name is a word')
  const base = fakeWin({ reg: { userPath: 'C:\\npm', machinePath: 'C:\\Windows\\system32' } })
  const noUser = (file, args) => (file === 'reg' && args[1] === 'HKCU\\Environment' ? { status: 1, stdout: '', stderr: 'x' } : base.run(file, args))
  assert.equal(resolveCommand('kimi', { run: noUser, env: ENV, exists: () => false }), null, 'an unreadable half is skipped, not guessed on')
  assert.deepEqual(PATH_EXTS, ['.com', '.exe', '.bat', '.cmd'])
})

test('sacOf reads the one value reg.exe-style (0 off, 1 on, 2 evaluation, none = off) and blames only the two states forwarder.mjs blames', () => {
  assert.equal(sacOf({ run: fakeWin({ reg: { sac: 0 } }).run, env: ENV }), 'off')
  assert.equal(sacOf({ run: fakeWin({ reg: { sac: 1 } }).run, env: ENV }), 'on')
  assert.equal(sacOf({ run: fakeWin({ reg: { sac: 2 } }).run, env: ENV }), 'evaluation')
  assert.equal(sacOf({ run: fakeWin({}).run, env: ENV }), 'off', 'no key or value: the system has no Smart App Control')
  const weird = fakeWin({ reg: { sac: 1 } })
  weird.state[SAC_KEY].VerifiedAndReputablePolicyState = { kind: 'REG_SZ', value: 'yes' }
  assert.deepEqual(sacOf({ run: weird.run, env: ENV }), { unknown: { reason: 'unparseable', detail: 'the answer held no such DWORD' } })
  assert.deepEqual(sacOf({ run: () => ({ status: null, stdout: '', stderr: '' }), env: ENV }), { unknown: { reason: 'denied', detail: 'reg query exited none' } })
  for (const s of ['off', 'on', 'evaluation', { unknown: { reason: 'denied' } }]) assert.equal(sacBlocksShims(s), forwarderSacBlocks(s), `the same two states as the kernel's sacBlocks, and never an unknown one (${JSON.stringify(s)})`)
})

test('readShortcutTarget: the one fixed read-only line, the target is the answer (an empty one is real), a failure is an error', () => {
  const w = fakeWin({ lnks: { 'C:\\Users\\alice\\Desktop\\OpenCode.lnk': 'C:\\Users\\alice\\AppData\\Local\\Programs\\OpenCode\\OpenCode.exe' } })
  assert.deepEqual(readShortcutTarget({ shortcut: 'C:\\Users\\alice\\Desktop\\OpenCode.lnk', run: w.run, env: ENV }), { target: 'C:\\Users\\alice\\AppData\\Local\\Programs\\OpenCode\\OpenCode.exe' })
  assert.equal(w.calls[0][0], 'powershell')
  assert.match(w.calls[0].join(' '), /WScript\.Shell.*TargetPath/)
  assert.deepEqual(readShortcutTarget({ shortcut: 'C:\\x\\none.lnk', run: w.run, env: ENV }), { target: '' })
  const bad = { run: () => ({ status: 1, stdout: '', stderr: 'The system cannot find the file specified.' }) }
  assert.match(readShortcutTarget({ shortcut: 'C:\\x.lnk', run: bad.run, env: ENV }).error, /could not be read/)
})

test('shortcutPlaces names the Start menu and the desktop, APPDATA honoured and derived when absent', () => {
  const withAppdata = shortcutPlaces({ name: 'OpenCode.lnk', home: 'C:\\Users\\alice', env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' } })
  assert.deepEqual(withAppdata, ['C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\OpenCode.lnk', 'C:\\Users\\alice\\Desktop\\OpenCode.lnk'])
  assert.deepEqual(shortcutPlaces({ name: 'x.lnk', home: 'C:\\Users\\bob', env: {} }), ['C:\\Users\\bob\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\x.lnk', 'C:\\Users\\bob\\Desktop\\x.lnk'])
})
