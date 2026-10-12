// test/off/win32-undo.test.mjs — the Windows collector's manifest kinds and their undo (plan Task 9(b), audit F3; RFC 4.8 §4.2, 1.6 R3 / V35):
// KNOWN_KINDS carries proxy-entry · trust-entry · forwarder-binary · scheduled-task · run-key, OFF_VERSION is bumped, and `off` undoes each
// kind by its own rule — so the flip never writes a kind that undo skips. reg and schtasks are recording fakes (0.1 §3); the file kinds
// undo real files in a sandbox HOME.
import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { KNOWN_KINDS, OFF_VERSION, FILE_ENTRY_KINDS, undoByHand, parseManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { runOff } from '../../src/off/orchestrate.mjs'
import { TASK_NAME, RUN_KEY } from '../../src/off/win32.mjs'
import { TASK_NAME as ARCH_TASK_NAME, RUN_KEY as ARCH_RUN_KEY } from '../../src/collector/arch/win32/autostart.mjs'
import { newManifest, applyJsonKey, applyTextEntry, saveManifest as saveCoreManifest } from '../../src/collector/core/trust/journal.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

// ── the fakes: reg and schtasks as recording runners ──────────────────────────────────────────────────────────────────────────
const OURS = 'conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\x\\asight.mjs" daemon --supervise'
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
  assert.deepEqual(FILE_ENTRY_KINDS, ['json-key', 'text', 'proxy-entry', 'trust-entry'])
  assert.ok(OFF_VERSION >= 3, 'the bump is the point: doctor compares the copy\'s line with this')
  for (const k of ['run-key', 'scheduled-task', 'forwarder-binary', 'proxy-entry', 'trust-entry']) assert.ok(undoByHand({ kind: k, path: 'C:/x' }), `${k} says what to do by hand`)
})

test('a run-key entry: ours is deleted, ours over a prior restores it, a value that is not ours is left (and the entry is done — asight has nothing there), an absent one is already as asked, a dead reg says so and stays', async () => {
  const dir = tmpDir('asight-w32-rk-')
  const entry = (prior = null) => ({ kind: 'run-key', harness: 'claude-code', hive: RUN_KEY.hive, key: RUN_KEY.key, name: RUN_KEY.name, value: OURS, prior, installed_at: '2026-10-09T00:00:00Z' })
  const run = async (e, tools) => {
    const m = { version: 2, entries: [e], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
    return { out: await undoHarnesses({ dir, home: dir, manifest: m, ids: null, procs: async () => [], now: new Date(), fs, exec: execOf(...tools), env: {} }), m }
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
  assert.equal(r.m.entries.length, 0, 'and done: nothing of asight\'s is there')
  r = await run(entry(), [reg({ value: 'gone' })])
  assert.equal(r.out.results[0].result, 'already-restored', 'absent: already as asked')
  r = await run(entry(), [reg({ breakOn: 'query' })])
  assert.equal(r.out.results[0].result, 'error')
  assert.equal(r.m.entries.length, 1, 'a dead reg is not a guess: the entry stays')
})

test('a scheduled-task entry: off disables the task, uninstall deletes it, an absent one is already as asked, a query that cannot tell changes nothing on a guess', async () => {
  const dir = tmpDir('asight-w32-task-')
  const entry = { kind: 'scheduled-task', harness: 'claude-code', task: TASK_NAME, installed_at: '2026-10-09T00:00:00Z' }
  const run = async (dropCa, tools) => {
    const m = { version: 2, entries: [entry], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
    return { out: await undoHarnesses({ dir, home: dir, manifest: m, ids: null, procs: async () => [], now: new Date(), dropCa, fs, exec: execOf(...tools), env: {} }), m }
  }
  const st = schtasks()
  let r = await run(false, [st, reg()])
  assert.deepEqual(r.out.results.map((x) => x.result), ['restored'])
  assert.deepEqual(st.calls.filter((c) => c.startsWith('schtasks')), ['schtasks /Query /TN \\asight\\collector', 'schtasks /Change /TN \\asight\\collector /DISABLE'], 'an off disables; the Run value goes with it')
  assert.equal(r.m.entries.length, 0)
  const del = schtasks()
  r = await run(true, [del, reg()])
  assert.deepEqual(del.calls.filter((c) => c.startsWith('schtasks')), ['schtasks /Query /TN \\asight\\collector', 'schtasks /Delete /TN \\asight\\collector /F'], 'an uninstall deletes')
  r = await run(false, [schtasks({ state: 'absent' }), reg({ value: 'gone' })])
  assert.equal(r.out.results[0].result, 'already-restored', 'neither the task nor the Run value is there')
  r = await run(false, [schtasks({ state: 'unknown' }), reg()])
  assert.equal(r.out.results[0].result, 'error')
  assert.ok(r.out.results[0].reason.includes('not known'), 'the query could not tell')
  assert.equal(r.m.entries.length, 1, 'nothing was changed on a guess')
})

test('a forwarder-binary entry: an off keeps it (draining) and the entry STAYS for the uninstall; the uninstall removes the file, and one Windows holds is reported, not papered over', async () => {
  const dir = tmpDir('asight-w32-kernel-')
  const exe = path.join(dir, 'kernel', 'asight-forwarder.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'the kernel')
  const entry = { kind: 'forwarder-binary', harness: 'claude-code', path: exe, sha256: 'x', installed_at: '2026-10-09T00:00:00Z' }
  const run = async (dropCa) => {
    const m = { version: 2, entries: [entry], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
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
  assert.ok(!fs.existsSync(path.dirname(exe)), 'D44: the uninstall takes the kernel directory too')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'held')
  const broken = { ...fs, rmSync: (p, o) => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }, existsSync: fs.existsSync }
  const m = { version: 2, entries: [entry], files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [] }
  const out = await undoHarnesses({ dir, home: dir, manifest: m, ids: null, procs: async () => [], now: new Date(), dropCa: true, fs: broken, exec: execOf(reg(), schtasks({ state: 'absent' })), env: {} })
  assert.equal(out.results[0].result, 'error')
  assert.ok(out.results[0].reason.includes('EBUSY') || out.results[0].reason.includes('asight off --now'), 'a kernel Windows holds is said, with the way out')
})

test('the round trip (audit F3): an off over a manifest of every collector kind returns each file to its pre_sha256, takes the Run value and the task out, keeps only the draining kernel copy, and exits 0', async () => {
  const home = tmpDir('asight-w32-round-')
  const dir = path.join(home, '.asight', 'collector')
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
  applyJsonKey({ dir, manifest: m, harness: 'claude-code', file: settings, keys: ['proxy'], value: 'http://127.0.0.1:17999', home, now: new Date(), fs })
  applyTextEntry({ dir, manifest: m, harness: 'codex', file: envFile, edit: { format: 'dotenv-block', vars: { HTTPS_PROXY: 'http://127.0.0.1:17998' } }, home, now: new Date(), fs })
  assert.equal(m.entries.length, 2, 'the writers ledgered the two files')
  m.entries[0].kind = 'proxy-entry'
  m.entries[1].kind = 'trust-entry'
  const exe = path.join(dir, 'kernel', 'asight-forwarder.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'the kernel')
  m.entries.push(
    { kind: 'run-key', harness: 'claude-code', hive: RUN_KEY.hive, key: RUN_KEY.key, name: RUN_KEY.name, value: OURS, prior: null, installed_at: '2026-10-09T00:00:00Z' },
    { kind: 'scheduled-task', harness: 'claude-code', task: TASK_NAME, installed_at: '2026-10-09T00:00:00Z' },
    { kind: 'forwarder-binary', harness: 'claude-code', path: exe, sha256: 'x', installed_at: '2026-10-09T00:00:00Z' },
  )
  saveCoreManifest(dir, m)
  const rg = reg(), st = schtasks()
  const { receipt, exit } = await runOff({ home, env: { ASIGHT_TEST_SANDBOX: '1' }, ids: null, yes: true, deps: {
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

test('off step 5 disables the scheduled task ITSELF, whatever the manifest holds (a manifest without a scheduled-task entry — or none at all — used to leave the task ENABLED while the receipt said `autostart: disabled`): schtasks /Change /DISABLE runs, the receipt says what happened, and a refusal is a failure, not a silent claim', async () => {
  const home = tmpDir('asight-w32-step5-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  const settings = path.join(home, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ other: true }, null, 2) + '\n')
  const m = newManifest(new Date())
  applyJsonKey({ dir, manifest: m, harness: 'claude-code', file: settings, keys: ['proxy'], value: 'http://127.0.0.1:17999', home, now: new Date(), fs })
  m.entries[0].kind = 'proxy-entry'
  saveCoreManifest(dir, m) // no scheduled-task entry in the ledger: the task was registered by an on whose manifest is gone, or by hand from asight's file
  const st = schtasks()
  const { receipt, exit } = await runOff({ home, env: { ASIGHT_TEST_SANDBOX: '1' }, ids: null, yes: true, deps: {
    platform: 'win32',
    exec: execOf(reg({ value: 'gone' }), st),
    procs: async () => [],
    daemonState: async () => ({ state: 'none' }),
    lockWaitMs: 0,
  } })
  assert.equal(exit, 0, `off finished${receipt.problems.length ? `: ${receipt.problems[0]}` : ''}`)
  assert.ok(st.calls.some((c) => c.includes('/Change') && c.includes('/DISABLE')), 'the task was ACTUALLY disabled (schtasks /Change /TN \\asight\\collector /DISABLE ran)')
  assert.deepEqual(receipt.autostart, { disabled: true, removed: [], note: 'the task is disabled now; the Run value is a ledger entry, undone with the rest (4.8 §4.2)' })
  // a task that cannot be disabled: the receipt says so and the off is not clean
  const bad = schtasks({ fail: ['/Change'] })
  const f = await runOff({ home: (() => { const h = tmpDir('asight-w32-step5f-'); const d = path.join(h, '.asight', 'collector'); fs.mkdirSync(d, { recursive: true }); const sf = path.join(h, 'settings.json'); fs.writeFileSync(sf, JSON.stringify({ other: true }, null, 2) + '\n'); const mm = newManifest(new Date()); applyJsonKey({ dir: d, manifest: mm, harness: 'claude-code', file: sf, keys: ['proxy'], value: 'http://127.0.0.1:17999', home: h, now: new Date(), fs }); mm.entries[0].kind = 'proxy-entry'; saveCoreManifest(d, mm); return h })(), env: { ASIGHT_TEST_SANDBOX: '1' }, ids: null, yes: true, deps: {
    platform: 'win32',
    exec: execOf(reg({ value: 'gone' }), bad),
    procs: async () => [],
    daemonState: async () => ({ state: 'none' }),
    lockWaitMs: 0,
  } })
  assert.equal(f.exit, 0, 'the entries were undone; the autostart failure is the receipt\'s own line (as on darwin and linux), not the off\'s exit')
  assert.equal(f.receipt.autostart.disabled, false, 'the receipt says NOT disabled, it does not claim it')
  assert.match(f.receipt.autostart.error, /did not run|failed/)
  assert.ok(f.receipt.notes.some((n) => /did not run|failed/.test(n)), 'the failure is said in the notes')
})

test('the names the undo touches are the arch module\'s own (the inlined pieces cannot drift)', () => {
  assert.equal(TASK_NAME, ARCH_TASK_NAME)
  assert.deepEqual(RUN_KEY, ARCH_RUN_KEY)
})

const sha256of = (buf) => createHash('sha256').update(buf).digest('hex')
