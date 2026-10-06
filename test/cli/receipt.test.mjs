// test/cli/receipt.test.mjs — what `asight on` prints and writes: the plan, the confirmation, the receipt (RFC 1.6 §1.6, R1, R5, R6; V7).
// V3 / V10 / V29 of the same file belong to the `off` and `status` tasks and are added there. Every case runs in a sandbox HOME with
// the OS tools and the control socket injected; nothing touches the machine the test runs on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { formatOnReceipt, formatPlan } from '../../src/cli/receipt.mjs'
import { validateReceipt, newReceipt } from '../../src/cli/schema.mjs'
import { readStateFile } from '../../src/off/state.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import codex from '../../src/collector/harness/codex.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo, onCtx, snapshot, changedFiles, seedClaude, fakeSystem, fakeDaemon } from './fixtures/on-ctx.mjs'

const settingsOf = (home) => path.join(home, '.claude', 'settings.json')

test('V7: a first on outside a terminal without --yes prints the plan, writes nothing, exits 2; --dry-run writes nothing, exits 0, same receipt in the future tense; --yes writes and validates', async () => {
  const home = tmpDir('asight-v7-'); seedClaude(home); const before = snapshot(home)
  const io = fakeIo({ tty: false })
  assert.equal(await runOnCli([], onCtx(home, io)), 2)
  assert.match(io.text(), /~\/\.claude\/settings\.json/, 'the plan names the file it would change, as the user knows the path')
  assert.match(io.text(), /--yes/, 'and says how to go on')
  for (const [re, what] of [[/install manifest: ~\/\.asight\/collector\/install-manifest\.json/, 'the manifest'], [/state file[^\n]*: ~\/\.asight\/collector\/state\.json/, 'state.json, which on creates'], [/collector CA[^\n]*ca\.key/, 'the CA'], [/runtime directory[^\n]*~\/\.asight\/collector\/run\/trust\//, 'the runtime directory'], [/backups[^\n]*~\/\.asight\/backup\//, 'the backups of the files it changes (R2)']]) assert.match(io.text(), re, `the plan lists ${what}`)
  assert.deepEqual(snapshot(home), before, 'exit 2: not one byte written, no directory made')

  const dry = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--dry-run', '--json'], onCtx(home, dry)), 0)
  assert.deepEqual(snapshot(home), before, '--dry-run writes nothing')

  const { exec: ex, daemon } = fakeSystem()
  const real = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, real, { exec: ex, daemon })), 0)
  const a = dry.json(), b = real.json()
  assert.deepEqual(a.changed.map((c) => [c.path, c.change]), b.changed.map((c) => [c.path, c.change]), 'the dry run lists what the real run changed, word for word')
  assert.deepEqual(a.created.slice().sort(), b.created.slice().sort(), 'and what it created')
  assert.deepEqual([a.dry_run, b.dry_run ?? false], [true, false])
  assert.deepEqual(validateReceipt(b), [])
  assert.deepEqual(validateReceipt(a), [])
  assert.equal(JSON.parse(fs.readFileSync(settingsOf(home), 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'), '--yes writes')
  assert.equal(readStateFile(path.join(home, '.asight', 'collector', 'state.json')).state.harnesses['claude-code'].desired, 'on')
  assert.ok(ex.has(/^systemctl --user enable --now asight-collector\.service$/), 'no daemon answered: the unit is enabled and started')
  assert.deepEqual(daemon.calls.filter((c) => c.startsWith('POST')), ['POST /on {"harnesses":["claude-code"]}'], 'and the daemon is asked to attach, by name')
  assert.deepEqual(b.relayed, { closing: 0, waiting: 0, cut: 0 }, 'on relays nothing: zeros on purpose, not "unknown"')
  assert.equal(b.linger, true)
})

test('V7: a terminal asks once, only the first time; "n" writes nothing and exits 1; "y" goes on; a later on that changes no new file does not ask', async () => {
  const home = tmpDir('asight-v7q-'); seedClaude(home); const before = snapshot(home)
  const no = fakeIo({ tty: true, answers: ['n'] })
  assert.equal(await runOnCli([], onCtx(home, no)), 1)
  assert.equal(no.asked.length, 1)
  assert.deepEqual(snapshot(home), before, 'declined: nothing written')

  const yes = fakeIo({ tty: true, answers: ['y'] })
  assert.equal(await runOnCli([], onCtx(home, yes)), 0)
  assert.equal(yes.asked.length, 1)
  assert.match(yes.stdoutText(), /asight on[\s\S]*asight off[\s\S]*asight status[\s\S]*asight uninstall/, 'the receipt names the four commands (R1, 1.6 §1.6)')

  const again = fakeIo({ tty: true, answers: [] })
  assert.equal(await runOnCli([], onCtx(home, again)), 0)
  assert.equal(again.asked.length, 0, 'nothing new to change: no question')
})

test('V7: a later on that would change files beyond the confirmed ones lists only the new ones and asks again — no terminal, no --yes: exit 2 and nothing written; a terminal asks once; --yes writes and confirms them, so the next on asks nothing (1.6 §1.6, R6)', async () => {
  const home = tmpDir('asight-v7n-'); seedClaude(home)
  const dir = path.join(home, '.asight', 'collector')
  const sys = fakeSystem()
  const ctx = (io) => onCtx(home, io, { harnesses: [cc, codex], exec: sys.exec, daemon: sys.daemon })
  assert.equal(await runOnCli(['--yes'], ctx(fakeIo())), 0, 'claude-code alone is installed first')
  const before = readManifest(dir)
  assert.equal(before.entries.some((e) => e.harness === 'codex'), false)
  const codexEnv = path.join(home, '.codex', '.env')
  fs.mkdirSync(path.dirname(codexEnv)); fs.writeFileSync(codexEnv, 'OPENAI_API_KEY=sk-test\n') // Codex is installed since

  const snap = snapshot(home)
  const quiet = fakeIo({ tty: false })
  assert.equal(await runOnCli([], ctx(quiet)), 2, 'a file nobody confirmed yet, and nobody to ask')
  assert.match(quiet.text(), /~\/\.codex\/\.env/, 'the plan names what is new')
  assert.match(quiet.text(), /install manifest: [^\n]*\n[^\n]*state file/, 'and the manifest and the state file, which this on writes again (codex turns on)')
  assert.doesNotMatch(quiet.text(), /settings\.json|collector CA \(in no trust store\)|runtime directory/, 'and nothing of what was confirmed, or is there already and is not written again')
  assert.match(quiet.text(), /--yes/)
  assert.deepEqual(snapshot(home), snap, 'exit 2: not one byte written')

  const no = fakeIo({ tty: true, answers: ['n'] })
  assert.equal(await runOnCli([], ctx(no)), 1)
  assert.equal(no.asked.length, 1)
  assert.deepEqual(snapshot(home), snap, 'declined: nothing written')

  const yes = fakeIo({ tty: true, answers: ['y'] })
  assert.equal(await runOnCli([], ctx(yes)), 0)
  assert.equal(yes.asked.length, 1, 'asked exactly once')
  const m = readManifest(dir)
  assert.ok(m.confirmed_paths.includes(codexEnv), 'what was just shown and confirmed is recorded')
  assert.ok(m.confirmed_paths.some((p) => p === settingsOf(home)), 'and what was confirmed before is still there')
  const done = fakeIo({ tty: true, answers: [] })
  assert.equal(await runOnCli([], ctx(done)), 0)
  assert.equal(done.asked.length, 0, 'now nothing is new: no question')
})

test('V7: --json keeps stdout for the one JSON; the plan of a terminal run goes to stderr', async () => {
  const home = tmpDir('asight-v7j-'); seedClaude(home)
  const io = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--json'], onCtx(home, io)), 2)
  const r = io.json() // parses: only one document on stdout
  assert.deepEqual([r.command, r.ok, r.needs_yes, validateReceipt(r)], ['on', false, true, []])
  assert.match(io.stderrText(), /~\/\.claude\/settings\.json/)
})

test('on: usage errors exit 2 and touch nothing — an unknown harness lists the names, the old --proxy points at monitor, --no-autostart with --no-unit, an unknown flag', async () => {
  const home = tmpDir('asight-on-usage-'); seedClaude(home); const before = snapshot(home)
  let io = fakeIo(); assert.equal(await runOnCli(['clade'], onCtx(home, io)), 2)
  assert.match(io.text(), /clade/); assert.match(io.text(), /claude-code/); assert.match(io.text(), /dsh/)
  io = fakeIo(); assert.equal(await runOnCli(['--proxy', 'http://127.0.0.1:8899'], onCtx(home, io)), 2)
  assert.match(io.text(), /asight monitor on --no-autostart/)
  io = fakeIo(); assert.equal(await runOnCli(['--no-autostart', '--no-unit', '--yes'], onCtx(home, io)), 2)
  io = fakeIo(); assert.equal(await runOnCli(['--yess'], onCtx(home, io)), 2)
  assert.deepEqual(snapshot(home), before)
})

test('on: refused as root (R7), with the helper missing it writes nothing and says sudo asight setup-helper, and a platform without the new collector goes to the legacy hook', async () => {
  const home = tmpDir('asight-on-refuse-'); seedClaude(home); const before = snapshot(home)
  let io = fakeIo(); assert.equal(await runOnCli(['--yes'], onCtx(home, io, { deps: { getuid: () => 0 } })), 1)
  assert.match(io.text(), /root/)
  io = fakeIo(); assert.equal(await runOnCli(['--yes'], onCtx(home, io, { deps: { helperState: () => ({ ok: false, reason: 'no helper at /usr/local/libexec/asight/asight-redirector' }) } })), 1)
  assert.match(io.text(), /sudo asight setup-helper/)
  assert.deepEqual(snapshot(home), before, 'nothing written, not even the manifest')
  const seen = []
  io = fakeIo(); const ctx = onCtx(home, io, { deps: { legacyOn: async (argv) => { seen.push(argv); return 0 } } }); ctx.platform = 'darwin'
  assert.equal(await runOnCli(['--yes'], ctx), 0); assert.deepEqual(seen, [['--yes']])
  io = fakeIo(); const bare = onCtx(home, io); bare.platform = 'win32'; delete bare.deps.legacyOn
  assert.equal(await runOnCli([], bare), 1); assert.match(io.text(), /win32|本平台/)
  assert.deepEqual(snapshot(home), before)
})

test('on --no-unit with no daemon answering: everything is written and it exits 0, but the text says nothing is captured yet and how to start the daemon — never "已打开采集"', async () => {
  const home = tmpDir('asight-on-idle-'); seedClaude(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes', '--no-unit'], onCtx(home, io, { daemon: fakeDaemon({ up: false }) })), 0)
  assert.match(io.stdoutText(), /^asight 已写好入口与期望态,但守护进程没在跑/m)
  assert.doesNotMatch(io.stdoutText(), /已打开采集/)
  assert.match(io.stdoutText(), /守护进程: 没在跑,什么都没有被采集/)
  assert.match(io.stdoutText(), /asight collector start/, 'and how to start it')
  const j = fakeIo()
  assert.equal(await runOnCli(['--no-unit', '--json'], onCtx(home, j, { daemon: fakeDaemon({ up: false }) })), 0)
  assert.equal(j.json().daemon.state, 'not-running', '--json says the same, as a field')
})

test('receipt: every file the receipt lists is a file the run wrote, and every file the run wrote is listed (the on side of V3)', async () => {
  const home = tmpDir('asight-on-v3-'); seedClaude(home); const before = snapshot(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, io)), 0)
  const r = io.json()
  const wrote = changedFiles(before, snapshot(home)).map((rel) => path.join(home, rel))
  const listed = [...r.changed.map((c) => c.path), ...r.created.map((c) => (typeof c === 'string' ? c : c.path))]
  const unlisted = wrote.filter((f) => !listed.some((l) => l === f || f.startsWith(`${l}${path.sep}`)) && !f.includes(`${path.sep}backup${path.sep}`) && !f.includes(`${path.sep}flows${path.sep}`))
  assert.deepEqual(unlisted, [], 'a file written but not in the receipt')
  const missing = listed.filter((l) => !fs.existsSync(l))
  assert.deepEqual(missing, [], 'a file in the receipt that was not written')
  assert.ok(r.changed.every((c) => c.backup === null || fs.existsSync(c.backup)), 'a backup in the receipt exists')
  assert.equal(r.changed.find((c) => c.path === settingsOf(home)).backup !== null, true, 'settings.json existed: it was backed up first (R2)')
  assert.ok(r.log && fs.existsSync(r.log), 'the receipt says where the record is, and it is there (R1)')
})

test('formatOnReceipt: past and future tense, the four commands, the restart list, the skipped harnesses, and the linger line only when it is not on', () => {
  const home = '/home/alice'
  const r = {
    ...newReceipt('on'), user: 'alice', relayed: { closing: 0, waiting: 0, cut: 0 }, linger: false,
    changed: [{ path: '/home/alice/.claude/settings.json', change: '加 env.NODE_EXTRA_CA_CERTS', backup: '/home/alice/.asight/backup/aa-bb' }],
    created: ['/home/alice/.asight/collector/install-manifest.json'],
    skipped: [{ what: 'hermes', reason: '~/.hermes 不存在' }],
    restart: [{ harness: 'claude-code', pid: 4121, reason: 'config-after-start' }],
    undo: ['asight off'], log: '/home/alice/.asight/collector/flows',
  }
  const past = formatOnReceipt(r, { tense: 'past', home })
  assert.match(past, /^asight 已打开采集/)
  assert.match(past, /~\/\.claude\/settings\.json +加 env\.NODE_EXTRA_CA_CERTS +备份 ~\/\.asight\/backup\/aa-bb/)
  assert.match(past, /跳过: hermes\(~\/\.hermes 不存在\)/)
  assert.match(past, /登出后停采\(未开 linger\)[^\n]*loginctl enable-linger alice/)
  assert.match(past, /claude-code\(pid 4121\)重启后才会被采集/)
  for (const c of ['asight on', 'asight off', 'asight status', 'asight uninstall']) assert.ok(past.includes(c), c)
  const future = formatOnReceipt({ ...r, dry_run: true }, { tense: 'future', home })
  assert.match(future, /^asight 将打开采集/); assert.match(future, /将改这些文件/)
  assert.doesNotMatch(formatOnReceipt({ ...r, linger: true }, { home }), /linger/)
  assert.match(formatOnReceipt({ ...r, linger: 'unknown', linger_reason: 'EACCES' }, { home }), /登出后停采[^\n]*不知道[^\n]*EACCES/)
  assert.doesNotMatch(formatOnReceipt({ ...r, linger: 'unknown', linger_reason: 'EACCES' }, { home }), /已开/)
  assert.match(formatOnReceipt({ ...r, ok: false, notes: ['守护进程没有应答'] }, { home }), /没有做完[\s\S]*守护进程没有应答/)
  // --no-unit with nothing answering: done, exit 0, but nothing is captured: the header and the daemon line say so, never 已打开采集
  const idle = formatOnReceipt({ ...r, ok: true, daemon: { state: 'not-running', started: false }, unit: null }, { home })
  assert.match(idle, /^asight 已写好入口与期望态,但守护进程没在跑[^\n]*什么都不会被采集/)
  assert.doesNotMatch(idle, /已打开采集/)
  assert.match(idle, /守护进程: 没在跑,什么都没有被采集/)
  assert.match(formatOnReceipt({ ...r, ok: true, daemon: { state: 'running', pid: 77, started: true } }, { home }), /^asight 已打开采集[\s\S]*守护进程: 在跑\(pid 77\),这次拉起的/, 'a daemon that runs: as before')
})

test('formatPlan: every file the first on will write is listed before any is written — the CA, the trust file and whose certificates it carries, a link by the file that really changes, an owned file by its role, a text entry by what it adds, the unit and its env, the event log, what the agent may write itself', () => {
  const plan = {
    unit: { path: '/h/.config/systemd/user/asight-collector.service', env: { NODE_EXTRA_CA_CERTS: '/corp/ca.pem' }, links: ['/h/.config/systemd/user/default.target.wants/asight-collector.service'] },
    manifest: '/h/.asight/collector/install-manifest.json', ca: ['/h/.asight/collector/ca/ca.key', '/h/.asight/collector/ca/asight-ca.pem'],
    files: [{ harness: 'h', path: '/h/.asight/collector/ca/extra-h.pem', sources: ['/corp/ca.pem'] }],
    entries: [{ harness: 'h', path: '/h/s.json', real_path: '/dot/s.json', keys: ['env', 'K'], value: '/h/.asight/collector/ca/extra-h.pem' }, { harness: 'd', path: '/h/.d/patch.yml', what: 'line "- insert: x"' }],
    owned: [{ harness: 'd', path: '/h/.asight/collector/plugins/d/index.js', role: 'plugin' }],
    records: '/h/.asight/collector/flows', watch: [{ harness: 'o', path: '/h/.config/o/node_modules', why: 'npm install' }],
    state: '/h/.asight/collector/state.json', run: '/h/.asight/collector/run/trust', backups: '/h/.asight/backup',
  }
  const text = formatPlan(plan, { home: '/h', autostart: true })
  assert.match(text, /state file \(which agents are on\): ~\/\.asight\/collector\/state\.json/, 'the file `on` writes first')
  assert.match(text, /runtime directory[^\n]*: ~\/\.asight\/collector\/run\/trust\//)
  assert.match(text, /backups[^\n]*: ~\/\.asight\/backup\/\n/, 'where the copies of the changed files go')
  const quietPlan = formatPlan({ ...plan, manifest: null, ca: [], run: null, backups: null, files: [], owned: [], entries: [], unit: null, watch: [], first: false }, { home: '/h' })
  assert.doesNotMatch(quietPlan, /install manifest|collector CA|runtime directory|backups/, 'what is not written is not listed')
  assert.match(quietPlan, /state file/, 'an on that only writes the state file says so')
  assert.match(text, /collector CA \(in no trust store\): ~\/\.asight\/collector\/ca\/ca\.key, ~\/\.asight\/collector\/ca\/asight-ca\.pem/)
  assert.match(text, /h: ~\/\.asight\/collector\/ca\/extra-h\.pem = the certificates of \/corp\/ca\.pem \+ the collector CA/, 'whose certificates the trust file carries (G8 merge path)')
  assert.match(text, /h: ~\/s\.json → \/dot\/s\.json env\.K = ~\/\.asight\/collector\/ca\/extra-h\.pem/, 'a link is shown with the file that actually changes')
  assert.match(text, /d: ~\/\.asight\/collector\/plugins\/d\/index\.js \(asight's plugin\)\n  h: /)
  assert.match(text, /d: ~\/\.d\/patch\.yml line "- insert: x"/)
  assert.match(text, /autostart unit \(systemd --user, enabled --now\): ~\/\.config\/systemd\/user\/asight-collector\.service with NODE_EXTRA_CA_CERTS=\/corp\/ca\.pem for the daemon alone/, 'the env the unit gives the daemon is listed')
  assert.match(text, /autostart link \(made by systemctl --user enable\): ~\/\.config\/systemd\/user\/default\.target\.wants\/asight-collector\.service/, 'the link enable makes is listed too')
  assert.match(text, /install notes \(event log\): ~\/\.asight\/collector\/flows\/\n  o itself may write ~\/\.config\/o\/node_modules \(npm install\); uninstall reports it, never deletes it$/)
  const once = formatPlan(plan, { home: '/h', autostart: false })
  assert.match(once, /started, not enabled/, '--no-autostart: the unit is started once, not enabled')
  assert.doesNotMatch(once, /autostart link/, 'and no link is made')
})
