// RFC 4.8 §7 「自启的后备」 through the CLI: when `schtasks /Create` is refused, `install` falls back to the HKCU Run value, and that value is an
// install item like any other: one `run-key` entry in the install record, a `task-register-failed` failure record that `status --failures` lists, a
// receipt whose autostart names the Run value, and an `uninstall` that takes it out. Windows is a stateful fake of schtasks and reg (0.1 §3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { userUnit, RUN_KEY, TASK_NAME } from '../../src/collector/arch/win32/autostart.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { statusDoc } from '../../src/cli/status.mjs'
import { readManifest, saveManifest, manifestPath } from '../../src/off/manifest.mjs'
import { acquireOpLock, tryOpLock } from '../../src/off/lock.mjs'
import { identityFor } from '../../src/off/proc.mjs'
import { autostartBlock } from '../../src/collector/install.mjs'
import { opLockFile } from '../../src/off/paths.mjs'
import { controlEndpoint } from '../../src/collector/arch/win32/control-path.mjs'

const RUN = `${RUN_KEY.hive}\\${RUN_KEY.key}`
const TASK_XML = '<?xml version="1.0"?><Task version="1.4"><Settings></Settings></Task>'
/** Windows as schtasks and reg see it: `refuse` makes /Create answer Access is denied; `value` is the Run value ({ kind, value } or null). */
function windows({ refuse = true, value = null } = {}) {
  const w = { refuse, task: false, value, calls: [] }
  w.run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    w.calls.push(cmd)
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    if (file === 'schtasks') {
      // the task registered is the XML /Create was handed (schtasks reads it before trocar deletes its copy), and /Query /XML prints that back
      if (args[0] === '/Create') { if (w.refuse) return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' }; w.task = true; const x = args.indexOf('/XML'); w.xml = x >= 0 ? fs.readFileSync(args[x + 1]).toString('utf16le').replace(/^\uFEFF/, '') : TASK_XML; return ok() }
      if (args[0] === '/Query') return w.task ? ok(args.includes('/XML') ? w.xml || TASK_XML : '') : { status: 1, stdout: '', stderr: '' }
      if (args[0] === '/Delete') { w.task = false; return ok() }
      return ok()
    }
    if (file === 'reg') {
      if (args[0] === 'query') return w.value ? ok(`\r\nHKEY_CURRENT_USER\\${RUN_KEY.key}\r\n    ${RUN_KEY.name}    ${w.value.kind}    ${w.value.value}\r\n`) : { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
      if (args[0] === 'add') { if (w.onAdd) w.onAdd(); w.value = { kind: args[args.indexOf('/t') + 1], value: args[args.indexOf('/d') + 1] }; return ok() }
      if (args[0] === 'delete') { w.value = null; return ok() }
    }
    if (file === 'whoami') return { status: null, stdout: '', stderr: 'not here' } // the token is not read: no refusal (4.8 §7)
    return ok()
  }
  return w
}
const fakeIo = () => { const out = []; return { out: (s) => out.push(s), err: (s) => out.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => out.join('\n'), json: () => JSON.parse(out.join('\n')) } }

async function world(win) {
  const w = await modelWorld({ os: 'win32', commands: ['codex'] })
  controlEndpoint({ dir: w.dir }) // the endpoint a daemon publishes: without it the CLI has no pipe to ask
  const unit = userUnit({ home: w.home, node: 'C:\\node\\node.exe', script: 'C:\\trocar\\bin\\trocar.mjs', run: win.run, env: { USERDOMAIN: 'PC', USERNAME: 'ada' }, spawn: () => ({ pid: 77, unref() {}, on() {} }) })
  const install = async (args = ['--yes', '--json'], extra = {}) => {
    let probes = 0 // nothing answers until enable started the daemon, then it answers
    const deps = { getuid: () => 501, exec: win.run, unit, request: async () => { if (probes++ === 0) throw Object.assign(new Error('nothing answers yet'), { code: 'ENOENT' }); return {} }, sleep: async () => {}, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '.exe' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, ...extra }
    const io = fakeIo()
    const exit = await runInstallCli(args, { io, env: w.env, home: w.home, platform: 'win32', deps })
    return { exit, io }
  }
  const runKeys = () => (readManifest(w.dir) || { entries: [] }).entries.filter((e) => e.kind === 'run-key')
  return { ...w, unit, install, runKeys }
}

test('4.8 §7: a refused /Create → the Run value is one install item, the failure is recorded and listed, the receipt names the Run value; a second install adds no second item', async () => {
  const win = windows()
  const w = await world(win)
  const a = await install1(w)
  assert.ok(win.value && /daemon --supervise$/.test(win.value.value), 'the Run value was written')
  const rk = w.runKeys()
  assert.equal(rk.length, 1, 'one run-key entry')
  assert.deepEqual([rk[0].phase, rk[0].name, rk[0].value, rk[0].prior], ['install', RUN_KEY.name, win.value.value, null])
  assert.equal(a.doc.autostart.entry, `${RUN}\\${RUN_KEY.name}`, 'the receipt names the Run value, not the task')
  assert.equal(a.doc.autostart.enabled, true)
  assert.ok(a.doc.notes.some((n) => n.includes('Access is denied')), 'the receipt says why the task was not registered')
  const doc = await statusDoc({ home: w.home, env: w.env, platform: 'win32', deps: { exec: win.run, procs: async () => [], netFactsDeps: async () => null, request: async () => { throw Object.assign(new Error('down'), { code: 'ENOENT' }) } } })
  const g = (doc.failures && doc.failures.groups || []).find((x) => x.code === 'task-register-failed')
  assert.ok(g && g.level === 'problem', `status --failures lists task-register-failed as a problem: ${JSON.stringify(doc.failures)}`)
  await install1(w)
  assert.equal(w.runKeys().length, 1, 'a second install leaves one entry')
})

test('4.8 §7: a later install whose /Create is accepted takes the Run value out and the record drops its entry; a user\'s own prior value comes back', async () => {
  const win = windows({ value: { kind: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\mine.exe' } }) // the user's own value under trocar's name, there before install
  const w = await world(win)
  await install1(w)
  assert.deepEqual(w.runKeys().map((e) => e.prior), [{ kind: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\mine.exe' }])
  win.refuse = false
  const b = await install1(w)
  assert.equal(w.runKeys().length, 0, 'the record holds no run-key entry once the task is the login entry')
  assert.deepEqual(win.value, { kind: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\mine.exe' }, 'the user\'s value is back')
  assert.equal(b.doc.autostart.entry, TASK_NAME)
})

// D38 · 1.6 §3.3: a Run value that cannot be recorded (here: another command holds op.lock) is not written, and trocar then has no login entry:
// install says so with exit 1 and the way out, and on's precondition (the one question every on asks) refuses with the same way out
test('D38: a Run value that cannot be recorded is not written; install exits 1 naming trocar install, and on refuses autostart-missing', async () => {
  const win = windows()
  const w = await world(win)
  const enable = w.unit.enable
  w.unit.enable = (o) => { const held = tryOpLock({ file: opLockFile(w.home), identity: identityFor({ platform: 'win32', exec: win.run }) }); try { return enable(o) } finally { held.lock.release() } }
  const r = await w.install()
  const doc = r.io.json()
  assert.deepEqual([r.exit, doc.ok, win.value, w.runKeys().length], [1, false, null, 0], r.io.text())
  assert.ok(doc.problems.some((p) => p.includes('trocar install')), `the problem gives the way out: ${JSON.stringify(doc.problems)}`)
  const blk = autostartBlock({ unit: w.unit, osName: 'win32' })
  assert.ok(blk && blk.includes('trocar install'), `on refuses before it writes anything: ${blk}`)
})

// 1.6 R12: off waits at most 10 s for op.lock, and the OS may hold the collector's start longer (launchd's 10 s throttle, the 15 s wait for the
// daemon to answer): install holds the lock for the record's save, never for the start
test('R12: op.lock is free while install registers and starts the collector', async () => {
  const w = await world(windows())
  const lockFile = opLockFile(w.home)
  let seen = null
  const enable = w.unit.enable
  w.unit.enable = (o) => { seen = fs.existsSync(lockFile); return enable(o) }
  const r = await w.install()
  assert.equal(r.exit, 0, r.io.text())
  assert.equal(seen, false, 'no lock held when the registration starts')
})

test('R12: the run-key entry is recorded under op.lock: another command that saves the install record while install registers keeps its entry', async () => {
  const win = windows()
  const w = await world(win)
  const foreign = { kind: 'text', path: path.join(w.home, 'foreign.txt'), harness: 'codex', phase: 'on' }
  const lockFile = opLockFile(w.home)
  // another command, as every writer of the record behaves: it holds op.lock while it reads and saves. It saves at the moment install reads the
  // record after the registration; while install holds the lock, it waits for it and saves after.
  let armed = false, other = null
  const save = () => { const m = readManifest(w.dir); m.entries.push({ ...foreign }); saveManifest(w.dir, m) }
  const pfs = { ...fs, readFileSync(file, ...rest) {
    const b = fs.readFileSync(file, ...rest)
    if (armed && file === manifestPath(w.dir)) {
      armed = false
      if (fs.existsSync(lockFile)) other = (async () => { const l = await acquireOpLock({ file: lockFile, identity: identityFor({ platform: 'win32', exec: win.run }), waitMs: 5000 }); try { save() } finally { l.release() } })()
      else save()
    }
    return b
  } }
  const enable = w.unit.enable
  w.unit.enable = (o) => { armed = true; return enable(o) }
  const r = await w.install(undefined, { fs: pfs })
  await other
  assert.equal(r.exit, 0, r.io.text())
  const m = readManifest(w.dir)
  assert.ok(m.entries.some((e) => e.path === foreign.path), 'the other command\'s entry is kept')
  assert.equal(w.runKeys().length, 1, 'and the run-key entry is recorded')
})

test('4.8 §7 W24: the user\'s prior Run value is in the install record before trocar writes its own value', async () => {
  const win = windows({ value: { kind: 'REG_SZ', value: 'C:\\mine.exe' } })
  const w = await world(win)
  const seen = []
  win.onAdd = () => seen.push(w.runKeys().map((e) => e.prior))
  await install1(w)
  assert.deepEqual(seen[0], [{ kind: 'REG_SZ', value: 'C:\\mine.exe' }], 'recorded before reg add')
})

test('D38: a task-register-failed record that cannot be written makes the run not ok, exit 1', async () => {
  const win = windows()
  const w = await world(win)
  fs.rmSync(path.join(w.dir, 'flows'), { recursive: true, force: true })
  fs.writeFileSync(path.join(w.dir, 'flows'), 'not a directory') // every failure record write fails
  const r = await w.install()
  const doc = r.io.json()
  assert.ok(doc.problems.some((p) => p.includes('task-register-failed') || p.includes('Access is denied')), JSON.stringify(doc.problems))
  assert.equal(doc.ok, false)
  assert.notEqual(r.exit, 0)
})

for (const task of [false, true]) {
  test(`uninstall takes trocar's Run value out (the task ${task ? 'still registered' : 'gone'}) and leaves no record`, async () => {
    const win = windows()
    const w = await world(win)
    await install1(w)
    win.task = task // registered meanwhile: trocar's own task, the one install wrote (uninstall leaves a task that is not trocar's, 4.8 §7)
    if (task) win.xml = fs.readFileSync(path.join(w.dir, 'trocar-collector.task.xml'), 'utf8')
    const r = await uninstallWin(w, win)
    assert.ok(win.calls.some((c) => c.startsWith(`reg delete ${RUN} /v ${RUN_KEY.name}`)), `reg delete issued: ${JSON.stringify([r.receipt.problems, r.receipt.left])}`)
    assert.equal(win.value, null, 'no Run value left')
    assert.equal(win.task, false, 'no task left')
    assert.equal(fs.existsSync(path.join(w.dir, 'install-manifest.json')), false, `the record is gone: ${JSON.stringify(r.receipt.left)} ${r.receipt.problems}`)
  })
}

test('uninstall puts a recorded prior back, and leaves no record', async () => {
  const win = windows()
  const w = await world(win)
  win.value = { kind: 'REG_SZ', value: 'C:\\mine.exe' }
  await install1(w)
  await uninstallWin(w, win)
  assert.deepEqual(win.value, { kind: 'REG_SZ', value: 'C:\\mine.exe' })
  assert.equal(fs.existsSync(path.join(w.dir, 'install-manifest.json')), false)
})

test('uninstall takes out a Run value of trocar\'s that no entry records (an install of before), and nothing else', async () => {
  const win = windows()
  const w = await world(win)
  await install1(w)
  const m = readManifest(w.dir)
  m.entries = m.entries.filter((e) => e.kind !== 'run-key')
  fs.writeFileSync(path.join(w.dir, 'install-manifest.json'), JSON.stringify(m))
  await uninstallWin(w, win)
  assert.equal(win.value, null, 'the Run value is gone')
})

async function install1(w) {
  const r = await w.install()
  assert.equal(r.exit, 0, r.io.text())
  return { ...r, doc: r.io.json() }
}
function uninstallWin(w, win) {
  return runUninstall({ home: w.home, env: w.env, yes: true, purgeData: true, deps: { platform: 'win32', exec: win.run, custody: w.custody, rootStore: w.store, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501, daemonState: async () => ({ state: 'none' }), lockWaitMs: 0 } })
}
