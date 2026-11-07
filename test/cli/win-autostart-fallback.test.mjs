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
import { readManifest } from '../../src/off/manifest.mjs'
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
      if (args[0] === '/Create') { if (w.refuse) return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' }; w.task = true; return ok() }
      if (args[0] === '/Query') return w.task ? ok(args.includes('/XML') ? TASK_XML : '') : { status: 1, stdout: '', stderr: '' }
      if (args[0] === '/Delete') { w.task = false; return ok() }
      return ok()
    }
    if (file === 'reg') {
      if (args[0] === 'query') return w.value ? ok(`\r\nHKEY_CURRENT_USER\\${RUN_KEY.key}\r\n    ${RUN_KEY.name}    ${w.value.kind}    ${w.value.value}\r\n`) : { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
      if (args[0] === 'add') { w.value = { kind: args[args.indexOf('/t') + 1], value: args[args.indexOf('/d') + 1] }; return ok() }
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
  const install = async (args = ['--yes', '--json']) => {
    let probes = 0 // nothing answers until enable started the daemon, then it answers
    const deps = { getuid: () => 501, exec: win.run, unit, request: async () => { if (probes++ === 0) throw Object.assign(new Error('nothing answers yet'), { code: 'ENOENT' }); return {} }, sleep: async () => {}, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '.exe' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns }
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

for (const task of [false, true]) {
  test(`uninstall takes trocar's Run value out (the task ${task ? 'still registered' : 'gone'}) and leaves no record`, async () => {
    const win = windows()
    const w = await world(win)
    await install1(w)
    win.task = task
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
