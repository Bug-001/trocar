// test/cli/keep.test.mjs — D39 × D40 (RFC 1.6 §2 `keep`, §1.1, §3, R7; V59–V62): `asight keep` is a command of the table like any other, and what the switch commands do — and do not do — to the retention
// settings (~/.asight/retention.json and the log of its changes, 4.6 §记录「保存级别」). Sandbox HOMEs laid out like the user's, a fake systemd and a fake daemon; nothing here reaches the machine
// the tests run on (0.1 §3). The sizes of the show mode are injected (`deps.sizes`): the DuckDB read has its own tests (test/query/*, test/capture/keep-cli.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { runCli } from '../../src/cli/main.mjs'
import { settingHarness } from '../../src/cli/keep.mjs'
import { retentionHarnessIds, harnessIdOfAgent } from '../../src/dissect/traffic.mjs'
import { HARNESS_IDS, NAME_ALIASES } from '../../src/cli/harness-names.mjs'
import { sandbox, installedViaCli, snapshot, fakeIo } from './fixtures/dispatch-ctx.mjs'
import { changedFiles } from './fixtures/on-ctx.mjs'

const files = (home) => ({ file: path.join(home, '.asight', 'retention.json'), log: path.join(home, '.asight', 'logs', 'retention.ndjson') })
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null)
const noSizes = { sizes: async () => ({ sizes: null, sizes_reason: '需要先跑 asight etl', disk: null, db: null }) }
const levels = (home) => JSON.parse(fs.readFileSync(files(home).file, 'utf8')).levels

test('V59: `off` (one harness, then none) leaves the settings file and its change log byte for byte as they were — they say what to store of later calls, not what asight does to an agent — and `on` again finds them', async () => {
  const s = await installedViaCli()
  assert.equal((await s.run(['keep', 'cc', 'telemetry', 'log'])).exit, 0)
  assert.equal((await s.run(['keep', 'codex', 'llm', 'log'])).exit, 0)
  const { file, log } = files(s.home); const before = [sha(file), sha(log)]
  assert.ok(before.every(Boolean) && fs.readFileSync(log, 'utf8').trim().split('\n').length === 2)
  for (const argv of [['off', 'claude-code'], ['off'], ['on', '--yes'], ['off', '--now']]) {
    const r = await s.run(argv); assert.equal(r.exit, 0, `${argv.join(' ')}: ${r.io.text()}`)
    assert.deepEqual([sha(file), sha(log)], before, `${argv.join(' ')} did not touch the settings`)
  }
  const shown = await s.run(['keep'], { deps: noSizes })
  assert.equal(shown.exit, 0); assert.match(shown.io.stdoutText(), /cc\s+full\s+full\s+full\s+log\s/, 'the table still says what was set')
})

test('V60: `uninstall` and `uninstall --purge-data` leave the settings file and its log: the operator\'s choice outlives the install (the CA rotation of D39 is uninstall, then on), and it is not capture data', async () => {
  for (const argv of [['uninstall', '--yes'], ['uninstall', '--purge-data', '--yes']]) {
    const s = await installedViaCli()
    assert.equal((await s.run(['keep', 'cc', 'files', 'log'])).exit, 0)
    const { file, log } = files(s.home); const before = [sha(file), sha(log)]
    const r = await s.run(argv); assert.equal(r.exit, 0, `${argv.join(' ')}: ${r.io.text()}`)
    assert.deepEqual([sha(file), sha(log)], before, `${argv.join(' ')} left both`)
    assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'collector', 'state.json')), 'while it did remove asight\'s own state, so the check is not vacuous')
  }
})

test('V61: `keep` takes the harness names of `on` / `off` / `status` (code ids and aliases, 1.6 §3) as well as the settings\' own ids, files them under the settings\' id, and refuses a name that is neither — exit 2, nothing written', async () => {
  const s = sandbox()
  const ids = retentionHarnessIds(), asked = { 'claude-code': 'cc', claude: 'cc', 'deepseek-dsh': 'dsh', dsh: 'dsh', 'kimi-code': 'kimi', kimi: 'kimi', 'z-code': 'zcode', zcode: 'zcode', codex: 'codex', hermes: 'hermes', opencode: 'opencode', cc: 'cc' }
  for (const [name, id] of Object.entries(asked)) {
    assert.equal(settingHarness(name, { ids, idOfAgent: harnessIdOfAgent }), id, name)
    const r = await s.run(['keep', name, 'telemetry', 'log']); assert.equal(r.exit, 0, `${name}: ${r.io.text()}`)
    assert.equal(levels(s.home)[id].telemetry, 'log', `${name} is filed under ${id}`)
  }
  assert.deepEqual([...HARNESS_IDS, ...Object.keys(NAME_ALIASES)].filter((n) => !(n in asked)), [], 'every name `on` accepts is a name `keep` accepts')
  const { file, log } = files(s.home); const before = [sha(file), sha(log)]
  for (const argv of [['keep', 'clade', 'files', 'log'], ['keep', 'Claude', 'files', 'log'], ['keep', 'claude', 'nope', 'log'], ['keep', 'claude', 'files', 'half'], ['keep', 'claude', 'files']]) {
    const r = await s.run(argv); assert.equal(r.exit, 2, argv.join(' ')); assert.match(r.io.stderrText(), /usage:/)
    assert.deepEqual([sha(file), sha(log)], before, `${argv.join(' ')} wrote nothing`)
  }
  const all = await s.run(['keep', 'all', 'account', 'log']); assert.equal(all.exit, 0)
  assert.ok(Object.values(levels(s.home)).every((row) => row.account === 'log') && Object.keys(levels(s.home)).length === ids.length, '`all` still expands over every settings id')
})

test('V62: `keep` writes the settings file and its log and nothing else — not state.json, not the install manifest, no agent file — and as root it is refused before anything is read or written (R7)', async () => {
  const s = await installedViaCli()
  const before = snapshot(s.home)
  const r = await s.run(['keep', 'claude', 'session-sync', 'log']); assert.equal(r.exit, 0, r.io.text())
  assert.deepEqual(changedFiles(before, snapshot(s.home)), ['.asight/logs/retention.ndjson', '.asight/retention.json'], 'the two files of the setting, and no other')
  const fresh = sandbox(); const untouched = snapshot(fresh.home)
  for (const argv of [['keep'], ['keep', 'cc', 'files', 'log'], ['keep', 'nonsense']]) {
    const { exit, io } = await fresh.run(argv, { uid: 0 })
    assert.equal(exit, 1, argv.join(' ')); assert.match(io.stderrText(), /用你自己的账号跑/); assert.equal(io.stdoutText(), '')
    assert.deepEqual(snapshot(fresh.home), untouched, `${argv.join(' ')} as root wrote nothing`); assert.equal(fresh.sys.exec.calls.length, 0)
  }
  const c = { io: fakeIo(), uid: 1000, platform: 'linux', env: {}, home: fresh.home, deps: { ...noSizes } }
  assert.equal(await runCli(['keep', '--help'], c), 0); assert.match(c.io.stdoutText(), /asight keep \[<harness\|all>/, '`--help` says it, as for every command')
})
