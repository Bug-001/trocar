// test/off/switch-proc-asks.test.mjs — D62 (1.6 §3.1): how many processes a SWITCH starts on Windows to answer its process questions.
//
// Measured on the Windows test machine 2026-10-19, `off codex` took 2034 ms of which 1758 ms were four powershell.exe starts (~450 ms each): this
// process's identity for op.lock, the daemon lock's for its judgement, the supervisor's, and the whole process table. `on codex` took 990 ms
// with one of them. The daemon keeps ONE resident read-only PowerShell and answers `POST /helper` (4.8 §7), and since D62 ⑥ it is still there
// during and after an `off` in proxy mode — so the switch asks it, ONCE, for the table, and every other question is answered out of that
// answer (src/off/proc.mjs primeProcQuestions). With no daemon to ask, the one local question is asked instead and the receipt says so (D38).
//
// The contracts here: with the daemon answering, zero powershell.exe; with it dead, the local questions and the SAME receipt plus the reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOff } from '../../src/off/orchestrate.mjs'
import { SUPERVISOR_LOCK } from '../../src/off/daemon-stop.mjs'
import { newManifest, applyTextEntry, saveManifest } from '../../src/collector/core/trust/journal.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const PIPE = '\\\\.\\pipe\\trocar-d62-switch'
const BOOTED = 1_740_000_000_000
const DAEMON_PID = 4242, SUP_PID = 4243
const CREATED = { [DAEMON_PID]: 1_740_000_111_000, [SUP_PID]: 1_740_000_112_000, [process.pid]: 1_740_000_113_000 }

/** The helper's `ps` rows (4.8 §1) for the three pids a switch asks about: the daemon's, its supervisor's, and this very process's. */
const ROWS = Object.entries(CREATED).map(([pid, startedAt]) => ({ pid: Number(pid), ppid: 1, name: 'node.exe', exe: 'C:\\n.exe', cmdline: 'node trocar.mjs', startedAt, cmdlineState: 'ok' }))

/** A counting runner for every OS tool `off` may reach for: it answers reg / schtasks / whoami, and records each powershell question by name. */
function tools() {
  const shells = [], calls = []
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (file === 'powershell') {
      shells.push(/Win32_Process \| ForEach-Object/.test(cmd) ? 'table' : /Win32_Process -Filter/.test(cmd) ? 'identity' : /Get-Process -Id/.test(cmd) ? 'supervisor' : 'other')
      if (/Win32_Process \| ForEach-Object/.test(cmd)) return { status: 0, stdout: `boot ${BOOTED}\n${JSON.stringify(ROWS.map((r) => ({ p: r.pid, pp: r.ppid, n: r.name, x: r.exe, s: r.startedAt, c: r.cmdline })))}`, stderr: '' }
      if (/Win32_Process -Filter "ProcessId=(\d+)"/.test(cmd)) { const p = Number(/ProcessId=(\d+)/.exec(cmd)[1]); return { status: 0, stdout: JSON.stringify({ s: CREATED[p], b: BOOTED }), stderr: '' } }
      if (/Get-Process -Id (\d+)/.test(cmd)) return { status: 0, stdout: String(CREATED[Number(/Get-Process -Id (\d+)/.exec(cmd)[1])]), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    if (file === 'whoami') return { status: 0, stdout: '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' } // reg / schtasks: the manifest here has neither
  }
  return { run, shells, calls }
}

/** A sandbox HOME with one codex trust-entry on record, a daemon lock naming DAEMON_PID and a supervisor lock naming SUP_PID. */
function world() {
  const home = tmpDir('trocar-d62-switch-')
  const dir = path.join(home, '.trocar', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  const envFile = path.join(home, '.codex', '.env')
  fs.mkdirSync(path.dirname(envFile), { recursive: true })
  fs.writeFileSync(envFile, 'MY_OWN=1\n')
  const pre = fs.readFileSync(envFile)
  const m = newManifest(new Date())
  m.install = { at: '2026-10-19T00:00:00Z', harnesses: ['codex'], items: {}, root: { sha256: 'x' } }
  applyTextEntry({ phase: 'on', dir, manifest: m, harness: 'codex', file: envFile, edit: { format: 'dotenv-block', vars: { HTTPS_PROXY: 'http://127.0.0.1:17998' } }, home, now: new Date(), fs })
  saveManifest(dir, m, fs)
  fs.writeFileSync(path.join(dir, 'lock'), `${JSON.stringify({ pid: DAEMON_PID, start_time: String(CREATED[DAEMON_PID]), boot_id: String(BOOTED), socket: PIPE })}\n`)
  fs.writeFileSync(path.join(dir, SUPERVISOR_LOCK), JSON.stringify({ pid: SUP_PID, startedAt: CREATED[SUP_PID] }))
  return { home, dir, envFile, pre }
}

const request = async ({ path: p }) => {
  if (p === '/status') return { pid: DAEMON_PID, actual: 'on' }
  if (p === '/off') return { confirmed: true, actual: 'off', pid: DAEMON_PID, relayed: {} }
  throw Object.assign(new Error(`no route ${p}`), { status: 404 })
}

/** One `off codex` on a simulated Windows, with the daemon's read client either answering (`warm`) or failing. */
async function offOnce(reader) {
  const { home, envFile, pre } = world()
  const t = tools()
  const { receipt, exit } = await runOff({
    home, env: { TROCAR_TEST_SANDBOX: '1', USERPROFILE: home, HOME: home }, ids: ['codex'], yes: true,
    deps: { platform: 'win32', exec: t.run, request, socketPath: PIPE, daemonReader: reader, alive: () => true, lockWaitMs: 0 },
  })
  return { receipt, exit, shells: t.shells, envAfter: fs.readFileSync(envFile), pre, home }
}

const warmReader = () => ({
  ready: Promise.resolve({ ready: true, via: 'daemon' }), close: async () => {},
  call: async (verb) => (verb === 'ps' ? { procs: ROWS } : (() => { throw new Error(`not asked here: ${verb}`) })()),
  self: () => ({ pid: DAEMON_PID, start_time: String(CREATED[DAEMON_PID]), boot_id: String(BOOTED) }),
})
const DEAD = 'ps: connect ECONNREFUSED'
const deadReader = () => ({
  ready: Promise.resolve({ ready: true, via: 'daemon' }), close: async () => {}, self: () => null,
  call: async () => { throw Object.assign(new Error(`the daemon did not answer the read question: ${DEAD}`), { code: 'daemon-read-failed', reason: DEAD }) },
})

test('D62 (1.6 §3.1): with the daemon answering, one `off codex` on Windows starts NO powershell.exe — the table it asks the daemon for answers every identity question too (op.lock\'s own, the daemon lock\'s, the supervisor\'s)', async () => {
  const hot = await offOnce(warmReader())
  assert.equal(hot.exit, 0, `off finished${hot.receipt.problems.length ? `: ${hot.receipt.problems[0]}` : ''}`)
  assert.deepEqual(hot.shells, [], 'not one powershell.exe start (each is ~450 ms on the Windows test machine)')
  assert.deepEqual(hot.envAfter, hot.pre, 'and codex\'s own file is byte for byte back')
  assert.deepEqual(hot.receipt.notes.filter((n) => /could not answer a read question/.test(n)), [], 'nothing to report: the daemon answered')
})

test('D62: with the daemon dead, the same `off codex` asks the OS instead — ONE local table question and no identity question of its own — the receipt says why, and everything else about it is unchanged', async () => {
  const hot = await offOnce(warmReader())
  const cold = await offOnce(deadReader())
  assert.equal(cold.exit, 0, `off finished${cold.receipt.problems.length ? `: ${cold.receipt.problems[0]}` : ''}`)
  assert.deepEqual(cold.shells, ['table'], 'the one local question, and the identity of all three pids comes out of it')
  assert.deepEqual(cold.envAfter, cold.pre, 'codex\'s own file is byte for byte back, whichever side answered')
  const why = cold.receipt.notes.filter((n) => /could not answer a read question/.test(n))
  assert.equal(why.length, 1, 'the fallback is never silent (D38)')
  assert.match(why[0], /ECONNREFUSED/, 'and the reason says which reader could not answer, and why')
  const same = (r, home) => JSON.parse(JSON.stringify({ ...r, notes: r.notes.filter((n) => !/could not answer a read question/.test(n)), log: null, at: null }).split(JSON.stringify(home).slice(1, -1)).join('<home>'))
  assert.deepEqual(same(cold.receipt, cold.home), same(hot.receipt, hot.home), 'the receipt is otherwise the same document')
})

test('D62: `on` on Windows asks the daemon for the table once and starts no powershell.exe for op.lock\'s identity question (990 ms measured with it, one 490 ms start)', async () => {
  const { modelWorld } = await import('../helpers/model-world.mjs')
  const { liveUnit, withScratchCwd } = await import('../helpers/model-daemon.mjs')
  const { runOnCli } = await import('../../src/cli/on.mjs')
  const { runInstallCli } = await import('../../src/cli/install.mjs')
  const { renderWrapper } = await import('../../src/collector/core/proxymode/hooks/wrapper.mjs')
  const fakeIo = () => { const lines = []; return { out: (s) => lines.push(s), err: (s) => lines.push(s), stdin: {}, stdout: {}, stderr: {}, text: () => lines.join('\n') } }
  const w = await modelWorld({ os: 'win32', commands: ['codex'] })
  const box = await liveUnit({ w, platform: 'win32' })
  const t = tools()
  const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: box.unit }
  await withScratchCwd('win32', async () => { // install already starts the daemon (enable --now), so it runs in the scratch cwd too
    try {
      assert.equal(await runInstallCli(['--yes'], { io: fakeIo(), env: w.env, home: w.home, platform: 'win32', deps }), 0)
      const io = fakeIo()
      const exit = await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform: 'win32', deps: { ...deps, parts: box.parts, exec: t.run, daemonReader: warmReader(), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))) } })
      assert.equal(exit, 0, io.text())
      assert.deepEqual(t.shells, [], 'op.lock\'s question about this very process came out of the daemon\'s table: no powershell.exe start')
    } finally { await box.stop() }
  })
})
