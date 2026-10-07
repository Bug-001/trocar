// test/cli/receipt.test.mjs — what `asight on` prints and writes: the plan, the confirmation, the receipt (RFC 1.6 §1.6, R1, R5, R6; V7).
// V3 / V29 of the same file belong to the `off` task and V10 (what `status` says when it cannot read) to the `status` task; they are added there. Every case runs in a sandbox HOME with
// the OS tools and the control socket injected; nothing touches the machine the test runs on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { formatOnReceipt, formatPlan } from '../../src/cli/receipt.mjs'
import { validateReceipt, newReceipt } from '../../src/cli/schema.mjs'
import { readStateFile } from '../../src/off/state.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import codex from '../../src/collector/harness/codex.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo, onCtx, snapshot, changedFiles, seedClaude, fakeSystem, fakeDaemon } from './fixtures/on-ctx.mjs'
import { installedHome, flowEvents } from '../off/fixtures/off-ctx.mjs'
import { runStatus, down, reply, asDaemon, NO_VPN } from './fixtures/status-ctx.mjs'

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

// ── T07: what off and uninstall print is what they did (V3, V29) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// asight's own bookkeeping (the state file, the manifest, the lock, the records, the backups) is not a user file: the receipt lists what was taken out of the user's files and what
// asight removed that it had made for them (bundles, plugins, shims, the CA, the unit), and the diff must be exactly that.
const bookkeeping = (rel) => /^\.asight\/(backup|collector\/flows)\//.test(rel) || /(^|\/)(state\.json|install-manifest\.json|op\.lock)$/.test(rel)
const listedPaths = (r) => new Set([...(r.changed || []).map((c) => c.path), ...(r.removed || []).map((x) => (typeof x === 'string' ? x : x.path)), ...(r.kept_bundles || []).map((k) => k.path), ...((r.autostart && r.autostart.removed) || [])])
const ctxOf = (s, io, deps = {}) => ({ io, env: s.sh.env, home: s.home, platform: 'linux', deps: s.offDeps({ getuid: () => 1000, ...deps }) })

test('V3 (off): every file the receipt lists, in the text and in --json, is a file that changed, and every user file that changed is listed', async () => {
  const setup = async () => {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'EDITED_AFTER=1\n') // a file the user edited after asight: still listed, as undone-but-not-identical
    return { s, before: snapshot(s.home) }
  }
  const diffOf = (s, before) => changedFiles(before, snapshot(s.home)).filter((rel) => !bookkeeping(rel)).map((rel) => path.join(s.home, rel))
  const a = await setup(); const io = fakeIo()
  assert.equal(await runOffCli(['--json'], ctxOf(a.s, io)), 0, io.text())
  const listed = listedPaths(io.json()), diff = diffOf(a.s, a.before)
  assert.ok(diff.length >= 3, `off changes several files: ${diff}`)
  assert.deepEqual(diff.filter((f) => !listed.has(f)), [], 'a file that changed and is not in the receipt')
  assert.deepEqual([...listed].filter((f) => !diff.includes(f)), [], 'a file in the receipt that did not change')
  // the text: every changed file has its row, and every row is a changed file (paths under HOME are shown as ~/…)
  const b = await setup(); const io2 = fakeIo()
  assert.equal(await runOffCli([], ctxOf(b.s, io2)), 0, io2.text())
  const text = io2.stdoutText(), shown = (f) => f.replace(b.s.home, '~')
  const rows = text.split('\n').filter((l) => /^ {2}~\//.test(l)).map((l) => l.trim().split(/\s{2,}/)[0].replace('~', b.s.home))
  const diffB = diffOf(b.s, b.before)
  assert.deepEqual(diffB.filter((f) => !text.includes(shown(f))), [], 'every changed file is in the text')
  assert.deepEqual(rows.filter((f) => !diffB.includes(f)), [], 'every row of the text is a changed file')
  assert.ok(rows.length >= 2)
})

test('V3 (uninstall): the receipt lists what changed and what asight removed — the files that changed or went are exactly those, the captures and the records excepted', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  fs.mkdirSync(path.join(s.dir, 'audit'), { recursive: true }); fs.writeFileSync(path.join(s.dir, 'audit', 'a.ndjson'), '{}\n') // a capture: kept, so not in the receipt
  const before = snapshot(s.home)
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--json'], ctxOf(s, io)), 0, io.text())
  const r = io.json()
  const diff = changedFiles(before, snapshot(s.home)).filter((rel) => !/^\.asight\/collector\/(flows|audit)\//.test(rel) && !/^\.asight\/backup\//.test(rel) && !/(^|\/)op\.lock$/.test(rel)).map((rel) => path.join(s.home, rel))
  const listed = listedPaths(r)
  assert.deepEqual(diff.filter((f) => !listed.has(f)), [], 'a file that changed or went and is not in the receipt')
  assert.deepEqual([...listed].filter((f) => !diff.includes(f) && fs.existsSync(f)), [], 'a file in the receipt that is still there unchanged')
  assert.ok(fs.existsSync(path.join(s.dir, 'audit', 'a.ndjson')), 'the capture is not in the receipt and is still there')
  assert.ok(r.dropped_backups.length > 0 && r.dropped_backups.every((b) => !fs.existsSync(b)), 'the backups it deleted are named')
})

test('V3 (off, the install manifest cannot be saved at the end): the entries were undone all the same, so the receipt — text and --json — lists exactly the files that changed, says why it stopped, exits 1; the next off finishes', async () => {
  const setup = async () => {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    const manifestFile = path.join(s.dir, 'install-manifest.json')
    const state = { broken: true }
    const full = { ...fs, renameSync: (a, b) => { if (state.broken && b === manifestFile) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return fs.renameSync(a, b) } } // the disk is full for the manifest only
    return { s, state, full, before: snapshot(s.home) }
  }
  const diffOf = (s, before) => changedFiles(before, snapshot(s.home)).filter((rel) => !bookkeeping(rel) && !/install-manifest\.json\.asight-tmp-/.test(rel)).map((rel) => path.join(s.home, rel))
  const a = await setup(); const io = fakeIo()
  assert.equal(await runOffCli(['--json'], ctxOf(a.s, io, { fs: a.full })), 1, io.text())
  const r = io.json(), diff = diffOf(a.s, a.before), listed = listedPaths(r)
  assert.ok(diff.length >= 3, `the entries really were undone: ${diff}`)
  assert.deepEqual(diff.filter((f) => !listed.has(f)), [], 'a file that changed and is not in the receipt')
  assert.deepEqual([...listed].filter((f) => !diff.includes(f)), [], 'a file in the receipt that did not change')
  assert.equal(r.ok, false); assert.match(r.problems.join('\n'), /undoing the entries stopped: ENOSPC.*install manifest on disk still names those entries/)
  assert.deepEqual([flowEvents(a.s.dir).at(-1).kind, flowEvents(a.s.dir).at(-1).outcome], ['result', 'failed'])
  assert.ok(flowEvents(a.s.dir).some((e) => e.event === 'failure' && e.code === 'entry-not-undone' && /ENOSPC/.test(e.reason)))
  const b = await setup(); const io2 = fakeIo()
  assert.equal(await runOffCli([], ctxOf(b.s, io2, { fs: b.full })), 1)
  const text = io2.stdoutText(), shown = (f) => f.replace(b.s.home, '~')
  assert.doesNotMatch(text, /没有改任何用户文件/, 'the text does not say nothing changed over files that were put back')
  assert.deepEqual(diffOf(b.s, b.before).filter((f) => !text.includes(shown(f))), [], 'every changed file is in the text')
  assert.match(text, /问题: undoing the entries stopped: ENOSPC/)
  b.state.broken = false // space again: what the receipt said to do
  const finished = await runOffCli([], ctxOf(b.s, fakeIo(), { fs: b.full }))
  assert.equal(finished, 0, 'the second off finishes: an entry that is back as it was reads as already restored')
  assert.deepEqual(readManifest(b.s.dir).entries, [])
})

test('V29: the first on receipt, in the text and in --json, carries the four commands and the absolute path of asight-off; every item of the manifest has a kind and an undo_by_hand; flows/ has the install-note and the off-note runs, each ending in a result line', async () => {
  const home = tmpDir('asight-on-v29-'); seedClaude(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, io)), 0)
  const r = io.json()
  const everything = JSON.stringify(r)
  for (const c of ['asight on', 'asight off', 'asight status', 'asight uninstall']) assert.ok(everything.includes(c), `--json carries ${c}`)
  assert.ok(r.undo.includes(standalonePath(home)) && r.standalone === standalonePath(home), 'the absolute path of asight-off: the undo list and the key')
  assert.ok(path.isAbsolute(r.standalone))
  assert.ok(fs.statSync(r.standalone).isFile() && (fs.statSync(r.standalone).mode & 0o100), 'and the path is a file asight wrote, executable (test/off/standalone.test.mjs runs it)')
  const io2 = fakeIo(); const home2 = tmpDir('asight-on-v29b-'); seedClaude(home2)
  assert.equal(await runOnCli(['--yes'], onCtx(home2, io2)), 0)
  for (const c of ['asight on', 'asight off', 'asight status', 'asight uninstall', standalonePath(home2)]) assert.ok(io2.stdoutText().includes(c), `the text carries ${c}`)
  const m = readManifest(path.join(home, '.asight', 'collector'))
  const items = [...m.entries, ...m.files]
  assert.ok(items.length >= 3)
  for (const it of items) assert.deepEqual([typeof it.kind === 'string' && it.kind !== '', typeof it.undo_by_hand === 'string' && it.undo_by_hand !== ''], [true, true], `${it.path}: kind and undo_by_hand`)
  // the records: one run of install-note and one of off-note, each ends with kind 'result'
  const s = await installedHome({ names: ['claude-code'] })
  assert.equal(await runOffCli([], ctxOf(s, fakeIo())), 0)
  const events = flowEvents(s.dir)
  for (const name of ['install-note', 'off-note']) {
    const runs = [...new Set(events.filter((e) => e.event === name).map((e) => e.run))]
    assert.ok(runs.length >= 1, `${name} has a run`)
    for (const run of runs) assert.equal(events.filter((e) => e.event === name && e.run === run).at(-1).kind, 'result', `${name} ${run} ends with a result line`)
  }
})

// V10 (1.6 R11, §6): what `status` could not read is 「不知道」 with the reason — the connections still relayed (a daemon whose reply carries no count), the VPN probe (a file it could not read, nothing it found), the
// daemon itself (a lock that cannot be read) — and never `0 条` or 「无」, in the text and in --json
test('V10: status says 不知道 with the reason for connections the daemon did not count, a VPN probe that could not read, and a lock that could not be read — never 0 条 or 无', async () => {
  const s = await installedHome()
  // the daemon answers, but its reply has no `relayed`
  let r = await runStatus(s, [], { request: asDaemon(reply({ relayed: undefined })), netenv: async () => { throw new Error("EACCES: permission denied, open '/h/.local/share/io.github.clash-verge-rev.clash-verge-rev/verge.yaml'") } })
  const line = (text, head) => text.split('\n').find((l) => l.startsWith(head)) || ''
  assert.match(line(r.text, '仍经 asight 的连接'), /^仍经 asight 的连接: 不知道\(the daemon's reply does not carry the connection counts\)$/)
  assert.match(line(r.text, '本机网络环境'), /^本机网络环境: 不知道\(EACCES[^)]*verge\.yaml/)
  for (const head of ['仍经 asight 的连接', '本机网络环境']) { assert.ok(!/0 条|无/.test(line(r.text, head)), `${head}: never 0 条 or 无`) }
  // a probe that found nothing is not 「无」 either
  r = await runStatus(s, [], { request: asDaemon(reply()), netenv: async () => NO_VPN })
  assert.match(line(r.text, '本机网络环境'), /^本机网络环境: 不知道\(no Clash Verge directory/); assert.ok(!/无/.test(line(r.text, '本机网络环境')))
  // the lock cannot be read and nothing answers
  const lock = path.join(s.dir, 'lock'); fs.writeFileSync(lock, '{}')
  const broken = { ...fs, readFileSync: (f, ...a) => { if (f === lock) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } }
  r = await runStatus(s, [], { request: down(), fs: broken })
  assert.match(line(r.text, '守护进程'), new RegExp(`^守护进程: 不知道\\([^\\n]*${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*EACCES`))
  assert.match(line(r.text, '仍经 asight 的连接'), /^仍经 asight 的连接: 不知道\(whether a daemon runs is not known/)
  assert.ok(!/0 条|无/.test(line(r.text, '仍经 asight 的连接'))); assert.equal(r.exit, 3, 'and the agents it cannot judge make it 3')
  // --json: the same, as data
  const j = await runStatus(s, ['--json'], { request: down(), fs: broken, netenv: async () => { throw new Error('probe failed') } })
  const doc = j.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual([doc.relayed, typeof doc.relayed_reason, doc.netenv, doc.daemon.state], ['unknown', 'string', { error: 'probe failed' }, 'unknown'])
})

// 1.6 §1.6 / §6 / §7: the plan and the receipt of `on` name the machine's VPN / proxy software — what was found, which of the harnesses being turned on go through it, that asight changes none of it — and
// say 不知道 with the reason when the probe cannot tell. `on` does not write the board's cache ~/.asight/netenv.json (the receipt lists exactly the files `on` wrote, V3; a second `on` writes nothing, R9).
test('on names the network environment in the plan and in the receipt (text and --json), 不知道 with the reason when the probe failed, and writes no netenv.json', async () => {
  const { CLASH } = await import('./fixtures/status-ctx.mjs')
  const home = tmpDir('asight-ne-on-'); seedClaude(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, io, { deps: { netenv: async () => CLASH() } })), 0, io.text())
  const lines = io.stdoutText().split('\n').filter((l) => l.startsWith('本机网络环境'))
  assert.deepEqual(lines, ['本机网络环境: Clash Verge(规则模式,系统代理已开);claude-code 的流量经过它;asight 没有改它', '本机网络环境: Clash Verge(规则模式,系统代理已开);claude-code 的流量经过它;asight 没有改它'], 'once in the plan, once in the receipt — only the harness being turned on')
  assert.ok(!fs.existsSync(path.join(home, '.asight', 'netenv.json')), 'on does not write the board\'s cache')
  const j = fakeIo(); const home2 = tmpDir('asight-ne-on-'); seedClaude(home2)
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home2, j, { deps: { netenv: async () => CLASH() } })), 0)
  assert.equal(j.json().netenv.products[0].product, 'clash-verge')
  const bad = fakeIo(); const home3 = tmpDir('asight-ne-on-'); seedClaude(home3)
  assert.equal(await runOnCli(['--yes'], onCtx(home3, bad, { deps: { netenv: async () => { throw new Error('EACCES: permission denied, open verge.yaml') } } })), 0, 'a probe that fails does not stop the on')
  assert.equal(bad.stdoutText().split('\n').filter((l) => l === '本机网络环境: 不知道(EACCES: permission denied, open verge.yaml)').length, 2)
  const dry = fakeIo(); const home4 = tmpDir('asight-ne-on-'); seedClaude(home4); const before = snapshot(home4)
  assert.equal(await runOnCli(['--dry-run'], onCtx(home4, dry, { deps: { netenv: async () => CLASH() } })), 0)
  assert.match(dry.stdoutText(), /^本机网络环境: Clash Verge/m); assert.deepEqual(changedFiles(before, snapshot(home4)), [], '--dry-run writes nothing')
})
