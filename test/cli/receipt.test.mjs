// test/cli/receipt.test.mjs — what `asight on` prints and writes: the plan, the confirmation, the receipt (RFC 1.6 §1.6, R1, R5, R6; V7).
// V3 / V29 of the same file belong to the `off` task and V10 (what `status` says when it cannot read) to the `status` task; they are added there. Every case runs in a sandbox HOME with
// the OS tools and the control socket injected; nothing touches the machine the test runs on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { formatOnReceipt, formatPlan } from '../../src/cli/receipt.mjs'
import { validateReceipt, newReceipt } from '../../src/cli/schema.mjs'
import { readStateFile } from '../../src/off/state.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import codex from '../../src/collector/harness/codex.mjs'
import * as unit from '../../src/collector/arch/linux/unit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo, onCtx, snapshot, changedFiles, seedClaude, fakeSystem, fakeDaemon, installFirst } from './fixtures/on-ctx.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { installedHome, flowEvents } from '../off/fixtures/off-ctx.mjs'
import { runStatus, down, reply, asDaemon } from './fixtures/status-ctx.mjs'

const settingsOf = (home) => path.join(home, '.claude', 'settings.json')

// D55, override #15: the first-run plan and its confirmation are install's now (it writes the user files); on, after install, has no user file left to
// confirm. The plan names every file, without a terminal and --yes nothing is written (exit 2), the dry run writes nothing, --yes writes.
test('V7: a first install outside a terminal without --yes prints the plan, writes nothing, exits 2; --dry-run writes nothing, exits 0; --yes writes; the on after it changes no user file and validates', async () => {
  const home = tmpDir('asight-v7-'); seedClaude(home); const before = snapshot(home)
  const io = fakeIo({ tty: false })
  assert.equal(await runInstallCli([], onCtx(home, io)), 2)
  assert.match(io.text(), /^asight install will write \d+ files:/m, 'the plan is install\'s')
  assert.match(io.text(), /~\/\.claude\/settings\.json/, 'the plan names the file it would change, as the user knows the path')
  assert.match(io.text(), /--yes/, 'and says how to go on')
  assertEnglish(io.text(), 'the install plan')
  for (const [re, what] of [[/record +~\/\.asight\/collector\/install-manifest\.json/, 'the manifest'], [/certificate +~\/\.asight\/collector\/ca\/ca\.key/, 'the CA'], [/record +~\/\.asight\/collector\/run\/trust\//, 'the runtime directory'], [/goes to ~\/\.asight\/backup\//, 'the backups of the files it changes (R2)']]) assert.match(io.text(), re, `the plan lists ${what}`)
  assert.deepEqual(snapshot(home), before, 'exit 2: not one byte written, no directory made')

  const dry = fakeIo({ tty: false })
  assert.equal(await runInstallCli(['--dry-run', '--json'], onCtx(home, dry)), 0)
  assert.equal(dry.json().dry_run, true)
  assert.deepEqual(snapshot(home), before, '--dry-run writes nothing')

  const inst = fakeIo({ tty: false })
  assert.equal(await runInstallCli(['--yes', '--json'], onCtx(home, inst)), 0)
  assert.deepEqual(inst.json().changed.map((c) => c.path), [settingsOf(home)], 'the file that existed is changed, not created')
  assert.equal(JSON.parse(fs.readFileSync(settingsOf(home), 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'), 'install --yes writes')

  const odry = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--dry-run', '--json'], onCtx(home, odry)), 0)
  const { exec: ex, daemon } = fakeSystem()
  const real = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--json'], onCtx(home, real, { exec: ex, daemon })), 0, 'after install, on has nothing for the user to confirm: no --yes needed')
  const a = odry.json(), b = real.json()
  assert.deepEqual([a.changed, b.changed], [[], []], 'on changes no user file (D55 1)')
  assert.deepEqual(a.created.slice().sort(), b.created.slice().sort(), 'the dry run lists what the real run created')
  assert.deepEqual([a.dry_run, b.dry_run ?? false], [true, false])
  assert.deepEqual(validateReceipt(b), [])
  assert.deepEqual(validateReceipt(a), [])
  assert.equal(readStateFile(path.join(home, '.asight', 'collector', 'state.json')).state.harnesses['claude-code'].desired, 'on')
  assert.ok(ex.has(/^systemctl --user enable --now asight-collector\.service$/), 'no daemon answered: the unit is enabled and started')
  assert.deepEqual(daemon.calls.filter((c) => c.startsWith('POST')), ['POST /on {"harnesses":["claude-code"]}'], 'and the daemon is asked to attach, by name')
  assert.deepEqual(b.relayed, { closing: 0, waiting: 0, cut: 0 }, 'on relays nothing: zeros on purpose, not "unknown"')
  assert.equal(b.linger, true)
})

test('V7: install in a terminal asks once, only the first time; "n" writes nothing and exits 1; "y" goes on; a later install or on that changes no new file does not ask', async () => {
  const home = tmpDir('asight-v7q-'); seedClaude(home); const before = snapshot(home)
  const no = fakeIo({ tty: true, answers: ['n'] })
  assert.equal(await runInstallCli([], onCtx(home, no)), 1)
  assert.equal(no.asked.length, 1)
  assert.deepEqual(snapshot(home), before, 'declined: nothing written')

  const yes = fakeIo({ tty: true, answers: ['y'] })
  assert.equal(await runInstallCli([], onCtx(home, yes)), 0)
  assert.equal(yes.asked.length, 1)
  // §1.1③ gives one or two next steps, so the text names the next command and the undo; the four commands live in `--json`'s `commands` (appendix C install)
  assert.match(yes.stdoutText(), /Next: asight on/, 'the receipt names the next step (R1, 1.6 §3.2)')
  assert.match(yes.stdoutText(), /If asight itself breaks: /, 'and the undo that works without this source tree')
  assertEnglish(yes.stdoutText(), 'the install receipt')
  const asJson = fakeIo({ tty: false })
  assert.equal(await runInstallCli(['--json'], onCtx(home, asJson)), 0)
  assert.deepEqual(asJson.json().commands, ['asight on', 'asight off', 'asight status', 'asight uninstall'], 'the four commands are in --json')

  for (const [run, what] of [[runInstallCli, 'install'], [runOnCli, 'on'], [runOnCli, 'on again']]) {
    const again = fakeIo({ tty: true, answers: [] })
    assert.equal(await run([], onCtx(home, again)), 0, what)
    assert.equal(again.asked.length, 0, `${what}: nothing new to change, no question`)
  }
})

test('V7: an install that would change files beyond the confirmed ones lists only the new ones and asks again — no terminal, no --yes: exit 2 and nothing written; a terminal asks once; --yes writes and confirms them, so the next install asks nothing (1.6 §1.6, R6)', async () => {
  const home = tmpDir('asight-v7n-'); seedClaude(home)
  const dir = path.join(home, '.asight', 'collector')
  const ctx = (io) => onCtx(home, io, { harnesses: [cc, codex] })
  assert.equal(await runInstallCli(['--yes'], ctx(fakeIo())), 0, 'claude-code alone is installed first')
  const before = readManifest(dir)
  assert.equal(before.entries.some((e) => e.harness === 'codex'), false)
  const codexEnv = path.join(home, '.codex', '.env')
  fs.mkdirSync(path.dirname(codexEnv)); fs.writeFileSync(codexEnv, 'OPENAI_API_KEY=sk-test\n') // Codex is installed since

  const snap = snapshot(home)
  const quiet = fakeIo({ tty: false })
  assert.equal(await runInstallCli([], ctx(quiet)), 2, 'a file nobody confirmed yet, and nobody to ask')
  assert.match(quiet.text(), /~\/\.codex\/\.env/, 'the plan names what is new')
  assert.doesNotMatch(quiet.text(), /settings\.json|in no trust store|what the plugins trust/, 'and nothing of what was confirmed, or is there already and is not written again')
  assert.match(quiet.text(), /--yes/)
  assert.deepEqual(snapshot(home), snap, 'exit 2: not one byte written')

  const no = fakeIo({ tty: true, answers: ['n'] })
  assert.equal(await runInstallCli([], ctx(no)), 1)
  assert.equal(no.asked.length, 1)
  assert.deepEqual(snapshot(home), snap, 'declined: nothing written')

  const yes = fakeIo({ tty: true, answers: ['y'] })
  assert.equal(await runInstallCli([], ctx(yes)), 0)
  assert.equal(yes.asked.length, 1, 'asked exactly once')
  const m = readManifest(dir)
  assert.ok(m.entries.some((e) => e.harness === 'codex'), 'codex is installed now')
  const done = fakeIo({ tty: true, answers: [] })
  assert.equal(await runInstallCli([], ctx(done)), 0)
  assert.equal(done.asked.length, 0, 'now nothing is new: no question')
})

test('V7: --json keeps stdout for the one JSON and stderr empty; the plan is the document\'s `planned` (1.6 §1.2)', async () => {
  const home = tmpDir('asight-v7j-'); seedClaude(home)
  const io = fakeIo({ tty: false })
  assert.equal(await runInstallCli(['--json'], onCtx(home, io)), 2)
  const r = io.json() // parses: only one document on stdout
  assert.deepEqual([r.command, r.ok, r.needs_yes], ['install', false, true])
  assert.equal(io.stderrText(), '', 'nothing on stderr under --json')
  assert.ok(r.planned.some((p) => p.detail.includes('~/.claude/settings.json')), 'the plan is in the document')
})

test('on: usage errors exit 2 and touch nothing — an unknown harness lists the names, the retired --proxy and the retired --no-unit are plain unknown options, an unknown flag', async () => {
  const home = tmpDir('asight-on-usage-'); seedClaude(home); const before = snapshot(home)
  let io = fakeIo(); assert.equal(await runOnCli(['clade'], onCtx(home, io)), 2)
  assert.match(io.text(), /clade/); assert.match(io.text(), /claude-code/); assert.match(io.text(), /dsh/)
  io = fakeIo(); assert.equal(await runOnCli(['--proxy', 'http://127.0.0.1:8899'], onCtx(home, io)), 2)
  // 1.6 §2 has no `--proxy` on `on`, so it is the one usage error of §1.3: `asight on: unknown option '--proxy'`
  assert.match(io.text(), /unknown option '--proxy'/)
  io = fakeIo(); assert.equal(await runOnCli(['--no-autostart', '--no-unit', '--yes'], onCtx(home, io)), 2)
  assert.match(io.text(), /unknown option '--no-unit'/, '--no-unit is gone: --no-autostart is the one flag (1.6 §3.3)')
  io = fakeIo(); assert.equal(await runOnCli(['--yess'], onCtx(home, io)), 2)
  assert.deepEqual(snapshot(home), before)
})

test('on: refused as root (R7), with the helper missing it writes nothing and says sudo asight setup-helper', async () => {
  const home = tmpDir('asight-on-refuse-'); seedClaude(home); await installFirst(home); const before = snapshot(home)
  let io = fakeIo(); assert.equal(await runOnCli(['--yes'], onCtx(home, io, { deps: { getuid: () => 0 } })), 2, 'root: §1.4 — nothing read or written, exit 2')
  assert.match(io.text(), /^asight on: run this as your own user, not as root\.$/m)
  io = fakeIo(); assert.equal(await runOnCli(['--yes'], onCtx(home, io, { deps: { helperState: () => ({ ok: false, reason: 'no helper at /usr/local/libexec/asight/asight-redirector' }) } })), 1)
  assert.match(io.text(), /sudo asight setup-helper/)
  assert.deepEqual(snapshot(home), before, 'nothing written, not even the manifest')
  // D39⑥ executed 2026-10-11: the legacy-on hook went with the old capture — every platform runs the NEW on: its plan (a dry run touches nothing)
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    io = fakeIo(); const bare = onCtx(home, io); bare.platform = platform
    assert.equal(await runOnCli(['--dry-run'], bare), 0, `${platform}: ${io.text()}`)
    assert.match(io.text(), /^asight will start capturing /m, `${platform}: the new collector's plan, not a refusal`)
    assertEnglish(io.text(), `the dry-run plan of on on ${platform}`)
  }
  assert.deepEqual(snapshot(home), before)
})

test('on --no-autostart with no daemon answering: everything is written and it exits 0, but the text says nothing is captured yet and how to start the daemon — never "Capturing"', async () => {
  const home = tmpDir('asight-on-idle-'); seedClaude(home); await installFirst(home)
  const io = fakeIo()
  const ctx = onCtx(home, io, { daemon: fakeDaemon({ up: false }) })
  ctx.deps.parts = { ...ctx.deps.parts, arch: {} } // a platform with no autostart entry at all: nothing starts the collector, so nothing is captured yet
  assert.equal(await runOnCli(['--yes', '--no-autostart'], ctx), 0)
  assert.match(io.stdoutText(), /^The settings are in place, but no collector is running/m)
  assert.doesNotMatch(io.stdoutText(), /^Capturing /m)
  assert.match(io.stdoutText(), /The collector is not running, so nothing is captured yet/)
  assert.match(io.stdoutText(), /asight daemon/, 'and how to start it')
  assertEnglish(io.stdoutText(), 'the receipt of an on with no collector running')
  const j = fakeIo()
  const jctx = onCtx(home, j, { daemon: fakeDaemon({ up: false }) })
  jctx.deps.parts = { ...jctx.deps.parts, arch: {} }
  assert.equal(await runOnCli(['--no-autostart', '--json'], jctx), 0)
  assert.equal(j.json().daemon.state, 'not-running', '--json says the same, as a field')
})

test('receipt: every file the receipt lists is a file the run wrote, and every file the run wrote is listed — install, then on (V3)', async () => {
  const home = tmpDir('asight-on-v3-'); seedClaude(home)
  for (const [run, command] of [[runInstallCli, 'install'], [runOnCli, 'on']]) {
    const before = snapshot(home)
    const io = fakeIo()
    assert.equal(await run(['--yes', '--json'], onCtx(home, io)), 0, command)
    const r = io.json()
    const wrote = changedFiles(before, snapshot(home)).map((rel) => path.join(home, rel))
    const listed = [...r.changed.map((c) => c.path), ...r.created.map((c) => (typeof c === 'string' ? c : c.path))]
    // on rewrites the install manifest, asight's own record of what is in place, on every run (the plan lists it); the receipt lists the files of the run's effect
    const own = command === 'on' ? [path.join(home, '.asight', 'collector', 'install-manifest.json')] : []
    const unlisted = wrote.filter((f) => !own.includes(f) && !listed.some((l) => l === f || f.startsWith(`${l}${path.sep}`)) && !f.includes(`${path.sep}backup${path.sep}`) && !f.includes(`${path.sep}flows${path.sep}`))
    assert.deepEqual(unlisted, [], `${command}: a file written but not in the receipt`)
    assert.deepEqual(listed.filter((l) => !fs.existsSync(l)), [], `${command}: a file in the receipt that was not written`)
    assert.ok(r.changed.every((c) => c.backup === null || fs.existsSync(c.backup)), 'a backup in the receipt exists')
    if (command === 'install') assert.notEqual(r.changed.find((c) => c.path === settingsOf(home)).backup, null, 'settings.json existed: install backed it up first (R2)')
    else { assert.deepEqual(r.changed, [], 'on changes no user file (D55)'); assert.ok(r.log && fs.existsSync(r.log), 'the receipt says where the record is, and it is there (R1)') }
  }
})

test('formatOnReceipt: past and future tense, the four commands, the restart list, the skipped harnesses, and the linger line only when it is not on', () => {
  const home = '/home/alice'
  const r = {
    ...newReceipt('on'), user: 'alice', relayed: { closing: 0, waiting: 0, cut: 0 }, linger: false,
    changed: [{ path: '/home/alice/.claude/settings.json', change: 'env.NODE_EXTRA_CA_CERTS added', backup: '/home/alice/.asight/backup/aa-bb' }],
    created: ['/home/alice/.asight/collector/install-manifest.json'],
    skipped: [{ what: 'hermes', reason: '~/.hermes does not exist' }],
    restart: [{ harness: 'claude-code', pid: 4121, reason: 'config-after-start' }],
    undo: ['asight off'], log: '/home/alice/.asight/collector/flows',
  }
  const past = formatOnReceipt(r, { tense: 'past', home })
  assert.match(past, /^Capturing /)
  assert.match(past, /~\/\.claude\/settings\.json\n +env\.NODE_EXTRA_CA_CERTS added \(backup ~\/\.asight\/backup\/aa-bb\)/)
  assert.match(past, /Skipped: hermes \(~\/\.hermes does not exist\)/)
  assert.match(past, /Capture stops when you log out[^\n]*loginctl enable-linger alice/)
  assert.match(past, /Restart to capture: claude-code \(pid 4121 started before the[\s\S]*was\n? *there\)/, '1.6 §1.1: on names each process with the phrase status uses')
  for (const c of ['asight off', 'asight status', 'asight uninstall']) assert.ok(past.includes(c), c)
  assertEnglish(past, 'the receipt of on')
  const future = formatOnReceipt({ ...r, dry_run: true }, { tense: 'future', home })
  assert.match(future, /^asight will start capturing /); assert.match(future, /Will change:/)
  assertEnglish(future, 'the dry-run receipt of on')
  assert.doesNotMatch(formatOnReceipt({ ...r, linger: true }, { home }), /linger/)
  assert.match(formatOnReceipt({ ...r, linger: 'unknown', linger_reason: 'EACCES' }, { home }), /Whether capture survives a logout is unknown \(EACCES\)/)
  assert.match(formatOnReceipt({ ...r, ok: false, notes: ['the collector does not answer'] }, { home }), /did not finish[\s\S]*the collector does not answer/)
  // --no-autostart with nothing answering: done, exit 0, but nothing is captured: the header and the daemon line say so, never "Capturing"
  const idle = formatOnReceipt({ ...r, ok: true, daemon: { state: 'not-running', started: false }, unit: null }, { home })
  assert.match(idle, /^The settings are in place, but no collector is running: nothing is\n? *captured\n? *until it is./)
  assert.doesNotMatch(idle, /^Capturing /m)
  assert.match(idle, /The collector is not running, so nothing is captured yet\.\nStart it: asight daemon/)
  assertEnglish(idle, 'the receipt of an on with no collector running')
  assert.match(formatOnReceipt({ ...r, ok: true, daemon: { state: 'running', pid: 77, started: true } }, { home }), /^Capturing [^\n]*Collector running \(pid 77\), started by this run\./m, 'a daemon that runs: the verdict line says it')
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
  assert.match(text, /record +~\/\.asight\/collector\/state\.json: which agents are on/, 'the file `on` writes first')
  assert.match(text, /record +~\/\.asight\/collector\/run\/trust\/: what the plugins trust/)
  assert.match(text, /goes to ~\/\.asight\/backup\/ first\./, 'where the copies of the changed files go')
  assertEnglish(text, 'the plan of on')
  const quietPlan = formatPlan({ ...plan, manifest: null, ca: [], run: null, backups: null, files: [], owned: [], entries: [], unit: null, watch: [], first: false }, { home: '/h' })
  assert.doesNotMatch(quietPlan, /install-manifest\.json|in no trust store|what the plugins trust/, 'what is not written is not listed')
  assert.match(quietPlan, /state\.json: which agents are on/, 'an on that only writes the state file says so')
  assert.match(text, /certificate +~\/\.asight\/collector\/ca\/ca\.key: in no trust store/)
  assert.match(text, /certificate +~\/\.asight\/collector\/ca\/asight-ca\.pem: in no trust store/)
  assert.match(text, /~\/\.asight\/collector\/ca\/extra-h\.pem: the certificates of ca\.pem plus\n? *asight's/, 'whose certificates the trust file carries (G8 merge path)')
  assert.match(text, /~\/s\.json -> \/dot\/s\.json: env\.K/, 'a link is shown with the file that actually changes')
  assert.match(text, /d +~\/\.asight\/collector\/plugins\/d\/index\.js: asight's plugin/)
  assert.match(text, /d +~\/\.d\/patch\.yml: line "- insert: x"/)
  assert.match(text, /~\/\.config\/systemd\/user\/asight-collector\.service: starts the collector\n? *at login/, 'the autostart unit is listed')
  assert.match(text, /~\/\.config\/systemd\/user\/default\.target\.wants\/asight-collector\.service: the\n? *link that enables it/, 'the link enable makes is listed too')
  assert.match(text, /record +~\/\.asight\/collector\/flows\/: what each run did/, 'the event log is listed')
  assert.match(text, /o itself may write ~\/\.config\/o\/node_modules \(npm install\); uninstall[\s\S]*never deletes it$/)
  const once = formatPlan(plan, { home: '/h', autostart: false })
  assert.match(once, /The collector is started this once; nothing is added to your login\./, '--no-autostart: started once, nothing at login')
  assert.doesNotMatch(once, /default\.target\.wants/, 'and no link is made')
  assertEnglish(once, 'the plan of on --no-autostart')
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
    return { s, before: snapshot(s.home), certs: new Set(s.installItems().map((x) => x[2])) }
  }
  const diffOf = (s, before) => changedFiles(before, snapshot(s.home)).filter((rel) => !bookkeeping(rel)).map((rel) => path.join(s.home, rel))
  const a = await setup(); const io = fakeIo()
  assert.equal(await runOffCli(['--json'], ctxOf(a.s, io)), 0, io.text())
  const listed = listedPaths(io.json()), diff = diffOf(a.s, a.before)
  assert.deepEqual(diff.filter((f) => a.certs.has(f)), [], 'off changed no certificate item, the edited one neither (D55①)')
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
  assert.deepEqual(rows.filter((f) => b.certs.has(f)), [], 'and lists none')
})

test('V3 (uninstall): the receipt lists what changed and what asight removed — the files that changed or went are exactly those, the captures and the records excepted', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  fs.mkdirSync(path.join(s.dir, 'audit'), { recursive: true }); fs.writeFileSync(path.join(s.dir, 'audit', 'a.ndjson'), '{}\n') // a capture: kept, so not in the receipt
  const before = snapshot(s.home)
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--json', '--yes'], ctxOf(s, io)), 0, io.text()) // §3.6: it always asks, and --json never prompts — so --yes is the answer
  const r = io.json()
  const diff = changedFiles(before, snapshot(s.home)).filter((rel) => !/^\.asight\/collector\/(flows|audit)\//.test(rel) && !/^\.asight\/backup\//.test(rel) && !/(^|\/)op\.lock$/.test(rel)).map((rel) => path.join(s.home, rel))
  const listed = listedPaths(r)
  assert.deepEqual(diff.filter((f) => !listed.has(f)), [], 'a file that changed or went and is not in the receipt')
  assert.deepEqual([...listed].filter((f) => !diff.includes(f) && fs.existsSync(f)), [], 'a file in the receipt that is still there unchanged')
  assert.ok(fs.existsSync(path.join(s.dir, 'audit', 'a.ndjson')), 'the capture is not in the receipt and is still there')
  assert.ok(r.dropped_backups.length > 0 && r.dropped_backups.every((b) => !fs.existsSync(b)), 'the backups it deleted are named')
})

test('V3 (uninstall — the certificate entries are its, D55① — the install manifest cannot be saved at the end): the entries were undone all the same, so the receipt — text and --json — lists exactly the files that changed, says why it stopped, exits 1; the next off finishes', async () => {
  const setup = async () => {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    const manifestFile = path.join(s.dir, 'install-manifest.json')
    const state = { broken: true }
    const full = { ...fs, renameSync: (a, b) => { if (state.broken && b === manifestFile) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return fs.renameSync(a, b) } } // the disk is full for the manifest only
    return { s, state, full, before: snapshot(s.home) }
  }
  const diffOf = (s, before) => changedFiles(before, snapshot(s.home)).filter((rel) => !bookkeeping(rel) && !/install-manifest\.json\.asight-tmp-/.test(rel)).map((rel) => path.join(s.home, rel))
  const a = await setup(); const io = fakeIo()
  assert.equal(await runUninstallCli(['--json', '--yes'], ctxOf(a.s, io, { fs: a.full })), 1, io.text())
  const r = io.json(), diff = diffOf(a.s, a.before), listed = listedPaths(r)
  assert.ok(diff.length >= 3, `the entries really were undone: ${diff}`)
  assert.deepEqual(diff.filter((f) => !listed.has(f)), [], 'a file that changed and is not in the receipt')
  assert.deepEqual([...listed].filter((f) => !diff.includes(f)), [], 'a file in the receipt that did not change')
  assert.equal(r.ok, false); assert.match(r.problems.join('\n'), /undoing the entries stopped: ENOSPC.*install manifest on disk still names those entries/)
  assert.deepEqual([flowEvents(a.s.dir).at(-1).kind, flowEvents(a.s.dir).at(-1).outcome], ['result', 'failed'])
  assert.ok(flowEvents(a.s.dir).some((e) => e.event === 'failure' && e.code === 'entry-not-undone' && /ENOSPC/.test(e.reason)))
  const b = await setup(); const io2 = fakeIo()
  assert.equal(await runUninstallCli(['--yes'], ctxOf(b.s, io2, { fs: b.full })), 1)
  const text = io2.stdoutText(), shown = (f) => f.replace(b.s.home, '~')
  assert.doesNotMatch(text, /No file of yours was changed/, 'the text does not say nothing changed over files that were put back')
  assert.deepEqual(diffOf(b.s, b.before).filter((f) => !text.includes(shown(f))), [], 'every changed file is in the text')
  assert.match(text, /Problem: undoing the entries stopped: ENOSPC/)
  b.state.broken = false // space again: what the receipt said to do
  const finished = await runUninstallCli(['--yes'], ctxOf(b.s, fakeIo(), { fs: b.full }))
  assert.equal(finished, 0, 'the second uninstall finishes: an entry that is back as it was reads as already restored')
  assert.ok(!fs.existsSync(path.join(b.s.dir, 'install-manifest.json')) || readManifest(b.s.dir).entries.length === 0)
})

test('V29: the on receipt after install, in the text and in --json, carries the four commands and the absolute path of asight-off; every item of the manifest has a kind and an undo_by_hand; flows/ has the install-note and the off-note runs, each ending in a result line', async () => {
  const home = tmpDir('asight-on-v29-'); seedClaude(home); await installFirst(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, io)), 0)
  const r = io.json()
  const everything = JSON.stringify(r)
  for (const c of ['asight on', 'asight off', 'asight status', 'asight uninstall']) assert.ok(everything.includes(c), `--json carries ${c}`)
  assert.ok(r.undo.includes(standalonePath(home)) && r.standalone === standalonePath(home), 'the absolute path of asight-off: the undo list and the key')
  assert.ok(path.isAbsolute(r.standalone))
  assert.ok(fs.statSync(r.standalone).isFile() && (fs.statSync(r.standalone).mode & 0o100), 'and the path is a file asight wrote, executable (install wrote it; test/off/standalone.test.mjs runs it)')
  const io2 = fakeIo(); const home2 = tmpDir('asight-on-v29b-'); seedClaude(home2); await installFirst(home2)
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

// V10 (1.6 R11, §6, D49): what `status` could not read is `unknown (<reason>)` — the connections still relayed (a daemon whose reply carries no count), the
// daemon itself (a lock that cannot be read) — and never a confident 0 or none, in the text and in --json
test('V10: status says unknown with the reason for connections the daemon did not count, and a lock that could not be read — never 0 or none', async () => {
  const s = await installedHome()
  // the daemon answers, but its reply has no `relayed`
  let r = await runStatus(s, [], { request: asDaemon(reply({ relayed: undefined })) })
  const flat = (text) => text.replace(/\s+/g, ' ') // a row's value may wrap onto the next line (§1.1 width)
  assert.match(flat(r.text), /Connections unknown \(the daemon's reply does not carry the connection counts\)/)
  assert.ok(!/Connections (0|none|no )/.test(flat(r.text)), 'never a confident 0 or none')
  // the lock cannot be read and nothing answers
  const lock = path.join(s.dir, 'lock'); fs.writeFileSync(lock, '{}')
  const broken = { ...fs, readFileSync: (f, ...a) => { if (f === lock) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } }
  r = await runStatus(s, [], { request: down(), fs: broken })
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(flat(r.text), new RegExp(`Daemon: unknown \\(${esc(lock)}: EACCES`))
  assert.match(flat(r.text), /Connections unknown \(whether a daemon runs is not known/)
  assert.ok(!/Connections (0|none|no )/.test(flat(r.text))); assert.equal(r.exit, 3, 'and the agents it cannot judge make it 3')
  // --json: the same, as data
  const j = await runStatus(s, ['--json'], { request: down(), fs: broken })
  const doc = j.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual([doc.relayed, typeof doc.relayed_reason, 'netenv' in doc, doc.daemon.state], ['unknown', 'string', false, 'unknown'])
})

// D49 (1.6 §6): `on` looks at no VPN / proxy software — no 本机网络环境 line in the plan or the receipt, no `netenv` key in --json, and it writes no netenv.json when it has nothing to adopt (the receipt lists
// exactly the files `on` wrote, V3; a second `on` writes nothing, R9).
test('on prints no network-environment line and its --json receipt has no netenv key; --dry-run writes nothing', async () => {
  const home = tmpDir('asight-ne-on-'); seedClaude(home); await installFirst(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, io, { deps: {} })), 0, io.text())
  assert.ok(!/本机网络环境/.test(io.stdoutText()), 'neither in the plan nor in the receipt')
  assert.ok(!fs.existsSync(path.join(home, '.asight', 'netenv.json')), 'on does not write the board\'s cache')
  const j = fakeIo(); const home2 = tmpDir('asight-ne-on-'); seedClaude(home2); await installFirst(home2)
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home2, j, { deps: {} })), 0)
  assert.ok(!('netenv' in j.json()), 'no netenv key in the receipt')
  const dry = fakeIo(); const home4 = tmpDir('asight-ne-on-'); seedClaude(home4); await installFirst(home4); const before = snapshot(home4)
  assert.equal(await runOnCli(['--dry-run'], onCtx(home4, dry, { deps: {} })), 0)
  assert.ok(!/本机网络环境/.test(dry.stdoutText())); assert.deepEqual(changedFiles(before, snapshot(home4)), [], '--dry-run writes nothing')
})

// Windows ignores the shebang, so the bare path of asight-off runs nothing there; every place that prints it as a command says `node "<path>"` on win32.
test('the standalone asight-off is printed as a runnable command: node "<path>" on win32, the path elsewhere (receipt, --json undo, doctor)', async () => {
  const { standaloneCommand } = await import('../../src/off/paths.mjs')
  const win = 'C:\\Users\\a\\.asight\\bin\\asight-off', posix = '/home/a/.asight/bin/asight-off'
  assert.equal(standaloneCommand(win, 'win32'), `node "${win}"`)
  for (const p of ['darwin', 'linux']) assert.equal(standaloneCommand(posix, p), posix)
  const r = { ...newReceipt('on'), ok: true, standalone: win }
  assert.ok(formatOnReceipt(r, { platform: 'win32' }).includes(`node "${win}"`), 'the receipt line runs on Windows')
  assert.ok(!formatOnReceipt({ ...r, standalone: posix }, { platform: 'darwin' }).includes('node "'))
  const src = (f) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8')
  for (const f of ['collector/install.mjs', 'cli/doctor.mjs']) assert.match(src(f), /standaloneCommand\(/, `${f} prints the command, not the bare path`)
})
