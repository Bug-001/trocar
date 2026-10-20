// test/off/win32-undo.test.mjs — the Windows collector's manifest kinds and their undo (plan Task 9(b), audit F3; RFC 4.8 §4.2, 1.6 R3 / V35):
// KNOWN_KINDS carries proxy-entry · trust-entry · forwarder-binary · scheduled-task · run-key, OFF_VERSION is bumped, and `off` undoes each
// kind by its own rule — so the flip never writes a kind that undo skips. reg and schtasks are recording fakes (0.1 §3); the file kinds
// undo real files in a sandbox HOME.
import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { KNOWN_KINDS, OFF_VERSION, FILE_ENTRY_KINDS, undoByHand, parseManifest, PHASES } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { runOff } from '../../src/off/orchestrate.mjs'
import { TASK_NAME, RUN_KEY } from '../../src/off/win32.mjs'
import { TASK_NAME as ARCH_TASK_NAME, RUN_KEY as ARCH_RUN_KEY } from '../../src/collector/arch/win32/autostart.mjs'
import { newManifest, applyJsonKey, applyTextEntry, saveManifest as saveCoreManifest } from '../../src/collector/core/trust/journal.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

// ── the fakes: reg and schtasks as recording runners ──────────────────────────────────────────────────────────────────────────
const OURS = 'conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\x\\trocar.mjs" daemon --supervise'
/** reg: the Run value starts as `value` ('ours' | 'theirs:<text>' | 'gone'); every call is recorded; `breakOn` a substring that makes the tool die. */
function reg({ value = 'ours', breakOn = null } = {}) {
  const calls = []
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (file !== 'reg') return { status: 1, stdout: '', stderr: `not reg: ${file}` }
    if (breakOn && cmd.includes(breakOn)) return { status: null, stdout: '', stderr: 'did not run' }
    if (args[0] === 'query') {
      if (value === 'gone') return { status: 1, stdout: '', stderr: '' }
      const text = value === 'ours' ? OURS : value.slice('theirs:'.length)
      return { status: 0, stdout: `HKEY_CURRENT_USER\\${RUN_KEY.key}\n    ${RUN_KEY.name}    REG_SZ    ${text}\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' } // add / delete
  }
  return { run, calls, handles: ['reg'] }
}
/** schtasks: the task starts as `state` ('present' | 'absent' | 'unknown'); every call recorded. */
function schtasks({ state = 'present', fail = [] } = {}) {
  const calls = []
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (file !== 'schtasks') return { status: 1, stdout: '', stderr: `not schtasks: ${file}` }
    if (fail.some((f) => cmd.includes(f))) return { status: null, stdout: '', stderr: 'did not run' }
    if (args[0] === '/Query') return state === 'unknown' ? { status: 5, stdout: '', stderr: 'ERROR: The service is not responding.' } : { status: state === 'present' ? 0 : 1, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' } // /Change /Delete
  }
  return { run, calls, handles: ['schtasks'] }
}
const execOf = (...tools) => (file, args) => { const t = tools.find((x) => x.handles.includes(file)); return t ? t.run(file, args) : { status: 1, stdout: '', stderr: `no fake for ${file}` } }

test('the kinds are known, the file rule takes proxy-entry and trust-entry, and OFF_VERSION is bumped past 2 (a version-2 copy leaves the collector items)', () => {
  for (const k of ['proxy-entry', 'trust-entry', 'forwarder-binary', 'scheduled-task', 'run-key']) assert.ok(KNOWN_KINDS.includes(k), k)
  assert.deepEqual(FILE_ENTRY_KINDS, ['json-key', 'text', 'proxy-entry', 'trust-entry', 'json-array-item'])
  assert.ok(OFF_VERSION >= 3, 'the bump is the point: doctor compares the copy\'s line with this')
  for (const k of ['run-key', 'scheduled-task', 'forwarder-binary', 'proxy-entry', 'trust-entry']) assert.ok(undoByHand({ kind: k, path: 'C:/x' }), `${k} says what to do by hand`)
})

test('a run-key entry: ours is deleted, ours over a prior restores it, a value that is not ours is left (and the entry is done — trocar has nothing there), an absent one is already as asked, a dead reg says so and stays', async () => {
  const dir = tmpDir('trocar-w32-rk-')
  const entry = (prior = null) => ({ phase: 'on', kind: 'run-key', harness: 'claude-code', hive: RUN_KEY.hive, key: RUN_KEY.key, name: RUN_KEY.name, value: OURS, prior, installed_at: '2026-10-09T00:00:00Z' })
  const run = async (e, tools) => {
    const m = { version: 3, entries: [e], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
    return { out: await undoHarnesses({ dir, home: dir, phases: PHASES, manifest: m, ids: null, procs: async () => [], now: new Date(), fs, exec: execOf(...tools), env: {} }), m }
  }
  let r = await run(entry(), [reg()])
  assert.deepEqual(r.out.results.map((x) => [x.result, x.path]), [['restored', `HKCU\\${RUN_KEY.key}\\${RUN_KEY.name}`]], 'ours, no prior: deleted')
  assert.ok(r.m.entries.length === 0, 'the entry leaves the manifest')
  const prior = { kind: 'REG_SZ', value: 'C:\\my\\own.exe at login' }
  const rg = reg()
  r = await run(entry(prior), [rg])
  assert.equal(r.out.results[0].result, 'restored', 'ours over a prior: the prior is put back')
  assert.ok(rg.calls.some((c) => c.startsWith('reg add') && c.includes(prior.value) && c.includes('/t REG_SZ')), 'with its kind')
  r = await run(entry(), [reg({ value: 'theirs:C:\\my\\own.exe at login' })])
  assert.equal(r.out.results[0].result, 'left-user-value', 'a value the user set: left as is')
  assert.equal(r.m.entries.length, 0, 'and done: nothing of trocar\'s is there')
  r = await run(entry(), [reg({ value: 'gone' })])
  assert.equal(r.out.results[0].result, 'already-restored', 'absent: already as asked')
  r = await run(entry(), [reg({ breakOn: 'query' })])
  assert.equal(r.out.results[0].result, 'error')
  assert.equal(r.m.entries.length, 1, 'a dead reg is not a guess: the entry stays')
})

test('a scheduled-task entry: off disables the task, uninstall deletes it, an absent one is already as asked, a query that cannot tell changes nothing on a guess', async () => {
  const dir = tmpDir('trocar-w32-task-')
  const entry = { phase: 'on', kind: 'scheduled-task', harness: 'claude-code', task: TASK_NAME, installed_at: '2026-10-09T00:00:00Z' }
  const run = async (dropCa, tools) => {
    const m = { version: 3, entries: [entry], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
    return { out: await undoHarnesses({ dir, home: dir, manifest: m, ids: null, procs: async () => [], now: new Date(), dropCa, fs, exec: execOf(...tools), env: {} }), m }
  }
  const st = schtasks()
  let r = await run(false, [st, reg()])
  assert.deepEqual(r.out.results.map((x) => x.result), ['restored'])
  assert.deepEqual(st.calls.filter((c) => c.startsWith('schtasks')), ['schtasks /Query /TN \\trocar\\collector', 'schtasks /Change /TN \\trocar\\collector /DISABLE'], 'an off disables; the Run value goes with it')
  assert.equal(r.m.entries.length, 0)
  const del = schtasks()
  r = await run(true, [del, reg()])
  assert.deepEqual(del.calls.filter((c) => c.startsWith('schtasks')), ['schtasks /Query /TN \\trocar\\collector', 'schtasks /Delete /TN \\trocar\\collector /F'], 'an uninstall deletes')
  r = await run(false, [schtasks({ state: 'absent' }), reg({ value: 'gone' })])
  assert.equal(r.out.results[0].result, 'already-restored', 'neither the task nor the Run value is there')
  r = await run(false, [schtasks({ state: 'unknown' }), reg()])
  assert.equal(r.out.results[0].result, 'error')
  assert.ok(r.out.results[0].reason.includes('not known'), 'the query could not tell')
  assert.equal(r.m.entries.length, 1, 'nothing was changed on a guess')
})

test('a forwarder-binary entry: an off keeps it (draining) and the entry STAYS for the uninstall; the uninstall removes the file, and one Windows holds is reported, not papered over', async () => {
  const dir = tmpDir('trocar-w32-kernel-')
  const exe = path.join(dir, 'kernel', 'trocar-forwarder.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'the kernel')
  const entry = { phase: 'on', kind: 'forwarder-binary', harness: 'claude-code', path: exe, sha256: 'x', installed_at: '2026-10-09T00:00:00Z' }
  const run = async (dropCa) => {
    const m = { version: 3, entries: [entry], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
    return { out: await undoHarnesses({ dir, home: dir, manifest: m, ids: null, procs: async () => [], now: new Date(), dropCa, fs, exec: execOf(reg(), schtasks({ state: 'absent' })), env: {} }), m }
  }
  let r = await run(false)
  assert.equal(r.out.results.length, 0, 'an off does not touch the kernel\'s copy')
  assert.ok(r.out.notes.some((n) => n.includes('drain')), 'the receipt says why it stays')
  assert.equal(r.m.entries.length, 1, 'the entry stays in the manifest: the uninstall is the one that takes it')
  assert.ok(fs.existsSync(exe))
  r = await run(true)
  assert.deepEqual(r.out.results.map((x) => x.result), ['restored'], 'the uninstall removes it')
  assert.ok(!fs.existsSync(exe))
  assert.ok(!fs.existsSync(path.dirname(exe)), 'the uninstall takes the kernel directory too')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'held')
  const broken = { ...fs, rmSync: (p, o) => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }, existsSync: fs.existsSync }
  const m = { version: 3, entries: [entry], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
  const out = await undoHarnesses({ dir, home: dir, manifest: m, ids: null, procs: async () => [], now: new Date(), dropCa: true, fs: broken, exec: execOf(reg(), schtasks({ state: 'absent' })), env: {} })
  assert.equal(out.results[0].result, 'error')
  assert.ok(out.results[0].reason.includes('EBUSY') || out.results[0].reason.includes('trocar off --now'), 'a kernel Windows holds is said, with the way out')
})

test('the round trip (audit F3): an off over a manifest of every collector kind returns each file to its pre_sha256, takes the Run value and the task out, keeps only the draining kernel copy, and exits 0', async () => {
  const home = tmpDir('trocar-w32-round-')
  const dir = path.join(home, '.trocar', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  // two real files, written through the REAL journal writers (the same ones the win32 entries module uses), then relabelled
  // proxy-entry / trust-entry: what the flip's on will write, undone by the file rule either way
  const settings = path.join(home, 'settings.json')
  const envFile = path.join(home, '.env')
  fs.writeFileSync(settings, JSON.stringify({ other: true }, null, 2) + '\n')
  fs.writeFileSync(envFile, 'MY_OWN=1\n')
  const preSettings = fs.readFileSync(settings)
  const preEnv = fs.readFileSync(envFile)
  const m = newManifest(new Date())
  applyJsonKey({ phase: 'on', dir, manifest: m, harness: 'claude-code', file: settings, keys: ['proxy'], value: 'http://127.0.0.1:17999', home, now: new Date(), fs })
  applyTextEntry({ phase: 'on', dir, manifest: m, harness: 'codex', file: envFile, edit: { format: 'dotenv-block', vars: { HTTPS_PROXY: 'http://127.0.0.1:17998' } }, home, now: new Date(), fs })
  assert.equal(m.entries.length, 2, 'the writers ledgered the two files')
  m.entries[0].kind = 'proxy-entry'
  m.entries[1].kind = 'trust-entry'
  const exe = path.join(dir, 'kernel', 'trocar-forwarder.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'the kernel')
  m.entries.push(
    { phase: 'on', kind: 'run-key', harness: 'claude-code', hive: RUN_KEY.hive, key: RUN_KEY.key, name: RUN_KEY.name, value: OURS, prior: null, installed_at: '2026-10-09T00:00:00Z' },
    { phase: 'on', kind: 'scheduled-task', harness: 'claude-code', task: TASK_NAME, installed_at: '2026-10-09T00:00:00Z' },
    { phase: 'on', kind: 'forwarder-binary', harness: 'claude-code', path: exe, sha256: 'x', installed_at: '2026-10-09T00:00:00Z' },
  )
  saveCoreManifest(dir, m)
  const rg = reg(), st = schtasks()
  const { receipt, exit } = await runOff({ home, env: { TROCAR_TEST_SANDBOX: '1' }, ids: null, yes: true, deps: {
    platform: 'win32',
    exec: execOf(rg, st),
    procs: async () => [],
    daemonState: async () => ({ state: 'none' }),
    lockWaitMs: 0,
  } })
  assert.equal(exit, 0, `off finished${receipt.problems.length ? `: ${receipt.problems[0]}` : ''}; left: ${JSON.stringify(receipt.left.map((l) => [l.path, l.reason]))}`)
  assert.deepEqual(fs.readFileSync(settings), preSettings, 'the proxy entry: byte for byte back')
  assert.deepEqual(fs.readFileSync(envFile), preEnv, 'the trust entry: byte for byte back')
  assert.ok(rg.calls.some((c) => c.startsWith('reg delete')), 'the Run value taken out')
  assert.ok(st.calls.some((c) => c.includes('/Change') && c.includes('/DISABLE')), 'the task disabled')
  assert.ok(fs.existsSync(exe), 'the kernel copy kept while it drains')
  const after = parseManifest(fs.readFileSync(path.join(dir, 'install-manifest.json'), 'utf8'))
  assert.deepEqual(after.entries.map((e) => e.kind), ['forwarder-binary'], 'only the draining kernel copy is left in the ledger')
  assert.ok(receipt.notes.some((n) => n.includes('drain')), 'the receipt says why')
})

test('the names the undo touches are the arch module\'s own (the inlined pieces cannot drift)', () => {
  assert.equal(TASK_NAME, ARCH_TASK_NAME)
  assert.deepEqual(RUN_KEY, ARCH_RUN_KEY)
})

const sha256of = (buf) => createHash('sha256').update(buf).digest('hex')
