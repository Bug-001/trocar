// `trocar install` (RFC 1.6 §1.1, §1.6): its own command; root refused before anything is read; a v2 manifest refused before any write;
// no terminal and no --yes → the plan only, exit 2, nothing written; --yes → the model install, its receipt and an install-note; exit 0 / 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglish } from '../helpers/english.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { runInstallCli } from '../../src/cli/install.mjs'
import { commandNamed } from '../../src/cli/commands.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { unservable } from '../helpers/model-daemon.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { ERROR_CODES } from '../../src/cli/json.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { BOARD_RANGE } from '../../src/collector/core/ingress-config.mjs'

function fakeIo({ tty = false } = {}) {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: tty }, stdout: { isTTY: tty }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
/** launchctl as a recording fake: install registers and starts the LaunchAgent (D61), and no test may run the real tool (0.1 §3). */
function fakeLaunchctl() {
  const calls = []
  return { calls, run: (file, args) => { calls.push([file, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } } }
}
async function cli(argv, { tty = false, over = {}, setup = null } = {}) {
  const w = await modelWorld({ commands: ['codex'] })
  if (setup) setup(w)
  const io = fakeIo({ tty })
  const launchctl = fakeLaunchctl()
  // the control endpoint a daemon publishes (arch/darwin/control-path.mjs): without the file the CLI has no socket to ask, so the
  // probe below would never be asked anything and a started daemon could not be seen
  const { controlEndpoint } = await import('../../src/collector/arch/darwin/control-path.mjs')
  const endpoint = () => controlEndpoint({ dir: w.dir }) // called below only when this run gets as far as writing: as root nothing may appear under ~/.trocar
  // nothing answers until the registration started it: the first probe is ENOENT, the ones after it answer (D61: install registers AND starts)
  let probes = 0
  const deps = { getuid: () => 501, exec: launchctl.run, request: async () => { if (probes++ === 0) throw Object.assign(new Error('nothing answers yet'), { code: 'ENOENT' }); return {} }, sleep: async () => {}, launchctl, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, ...over }
  if ((over.getuid ? over.getuid() : 501) !== 0) endpoint()
  const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps })
  return { w, io, exit, launchctl: deps.launchctl || launchctl }
}

test('install is a command of its own (and the hidden `collector install` alias is gone, 1.6 §2: one feature, one name)', () => {
  assert.ok(commandNamed('install'))
  assert.equal(commandNamed('collector'), undefined)
})

test('1.6 §1.5: as root, install refuses before it reads anything — exit 2 with the manual\'s one line, no ~/.trocar', async () => {
  const { w, exit, io } = await cli(['--yes'], { over: { getuid: () => 0 } })
  assert.equal(exit, 2)
  assert.match(io.text(), /^trocar install: run this as your own user, not as root\.$/m)
  assertEnglish(io.text(), 'the root refusal')
  assert.equal(fs.existsSync(path.join(w.home, '.trocar')), false)
})

test('1.6 §1.6: no terminal and no --yes → the plan (cost and residual-risk lines) and exit 2, nothing written; --dry-run → exit 0, nothing written', async () => {
  const a = await cli([])
  assert.equal(a.exit, 2)
  assert.match(a.io.text(), /^While installed, programs you run trust certificates issued by this/m) // the cost line (§3.2)
  assert.match(a.io.text(), /^Any program running as you can ask trocar to issue a trusted certificate/m) // the residual risk of a same-user root
  assert.match(a.io.text(), /^  codex +reads your user trust store$/m, 'every agent found is a line of the plan')
  assert.match(a.io.text(), /Nothing was changed\. Read the plan above, then run it again with --yes/)
  assertEnglish(a.io.text(), 'the install plan')
  assert.equal(fs.existsSync(path.join(a.w.home, '.trocar', 'collector', 'install-manifest.json')), false)
  const b = await cli(['--dry-run'])
  assert.equal(b.exit, 0)
  assert.equal(fs.existsSync(path.join(b.w.home, '.trocar', 'collector', 'install-manifest.json')), false)
})

test('4.11 ⑰: a version 2 manifest is refused before any write — exit 1, the file as it was', async () => {
  const w = await modelWorld()
  const f = path.join(w.home, '.trocar', 'collector', 'install-manifest.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ version: 2, entries: [], files: [] }))
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501 } }), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).version, 2)
})

test('install --yes --json: the receipt (fingerprint, carriers, residual risk, commands) and an install-note; exit 0; a declined root store → exit 1', async () => {
  const { w, io, exit, launchctl } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual([r.command, r.ok, typeof r.fp256, r.commands.includes('trocar uninstall')], ['install', true, 'string', true])
  // D61: install registers the login autostart, enables it (an `enable` clears a disable an earlier version left) and starts the daemon now
  assert.deepEqual(launchctl.calls.filter((c) => /enable|bootstrap/.test(c)), ['launchctl enable gui/501/com.trocar.collector', `launchctl bootstrap gui/501 ${path.join(w.home, 'Library', 'LaunchAgents', 'com.trocar.collector.plist')}`], launchctl.calls.join(' | '))
  assert.deepEqual([r.daemon.state, r.daemon.started], ['running', true])
  // 附录 C.2: the receipt confirms the login entry it registered, and carries no key C.2 does not name (H-1)
  assert.deepEqual(r.autostart, { entry: path.join(w.home, 'Library', 'LaunchAgents', 'com.trocar.collector.plist'), enabled: true })
  assert.deepEqual(validateReceipt(r), [])
  const day = fs.readdirSync(path.join(w.dir, 'flows')).find((n) => n.endsWith('.ndjson'))
  assert.ok(fs.readFileSync(path.join(w.dir, 'flows', day), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.event === 'install-note' && e.kind === 'result'))
  w.store.answer = 'declined'
  const again = await cli(['--yes'])
  again.w.store.answer = 'declined'
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: again.w.env, home: tmpHomeOf(again.w), platform: 'darwin', deps: { getuid: () => 501, unit: null, backends: { custody: again.w.custody, rootStore: again.w.store, dirs: again.w.ctx.dirs }, harnesses: [], owns: again.w.owns } }), 1)
})
const tmpHomeOf = () => tmpDir('trocar-model-2-') // a second HOME, made where the leak guard sweeps

// 1.6 §3.3 / 附录 C.2: `autostart.enabled` is the login entry asked again after the run, not "no error was seen". A daemon that holds the control
// socket and does not answer stops the run before anything is registered; launchd then has no such job, and the receipt must not say it starts at login.
test('install: a daemon that does not answer stops the run before the login entry is registered, and the receipt says it is not enabled', async () => {
  let loaded = false
  const launchctl = { calls: [], run: (file, args) => { launchctl.calls.push([file, ...args].join(' ')); if (args[0] === 'bootstrap') loaded = true; return args[0] === 'print' && !loaded ? { status: 113, stdout: '', stderr: 'Could not find service' } : { status: 0, stdout: '', stderr: '' } } }
  const { io, exit } = await cli(['--yes', '--json'], { over: { launchctl, exec: launchctl.run, request: async () => { throw Object.assign(new Error('timed out after 2000 ms'), { code: 'ETIMEDOUT' }) } } })
  assert.equal(exit, 1, io.text())
  const r = io.json()
  assert.deepEqual([r.ok, r.autostart.enabled, r.daemon.state], [false, false, 'not-responding'])
  assert.equal(launchctl.calls.some((c) => / bootstrap /.test(c)), false, 'nothing was registered')
  assert.deepEqual(validateReceipt(r), [])
})

// the documented order — install, then on — through the CLI: install writes the root, its carriers and
// the inert autostart unit; on enables the unit, which starts the REAL daemon (test/helpers/model-daemon.mjs), asks it for the doors and writes the entries.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: install then on through the CLI (temp HOME, stub backends) — on starts: exit 0, the doors' entries written`, { skip: await unservable(platform), timeout: 30_000 }, async () => {
    const { runOnCli } = await import('../../src/cli/on.mjs')
    const { liveUnit, withScratchCwd } = await import('../helpers/model-daemon.mjs')
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const box = await liveUnit({ w, platform })
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: box.unit }
    await withScratchCwd(platform, async () => { // install already starts the daemon (enable --now), so it runs in the scratch cwd too
      try {
        const io = fakeIo()
        assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text())
        const io2 = fakeIo()
        // `on` asks the OS for the process table once (D62: the op lock's identity question comes out of it) — injected here, this platform being
        // simulated: an empty table (boot time, no rows) is what a machine with nothing on it would print.
        const exec = (file, args) => ({ status: 0, stdout: /ForEach-Object/.test([file, ...args].join(' ')) ? 'boot 1740000000000\n' : '', stderr: '' })
        const exit = await runOnCli(['--yes'], { io: io2, env: w.env, home: w.home, platform, deps: { ...deps, parts: box.parts, exec, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))) } })
        assert.equal(exit, 0, io2.text())
        assert.doesNotMatch(io2.text(), /ca\.key|CA is unusable/, 'the old on refusing the model install\'s root (the finding) is gone')
        assert.match(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'), /127\.0\.0\.1:\d+/, 'codex\'s entry holds its door')
        const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
        assert.ok(m.files.some((f) => f.role === 'unit' && f.phase === 'install'), 'the unit is install\'s item')
      } finally { await box.stop() }
    })
  })
}

// macOS test machine, 2026-10-18: in a HOME with no login keychain the signing helper reports "A default keychain could not be found" and `install`
// exited 70 with the stack of that throw. A custody that cannot be used is a stated refusal: exit 1, `error.code` from the closed set
// (src/cli/json.mjs ERROR_CODES), and a sentence that says what the reader has to do. Driven with a custody stand-in that fails the same way.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a key custody that cannot be used is a refusal — exit 1, error.code, and what to do; never a stack`, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    w.custody.switches.failed = true
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
    const io = fakeIo()
    const exit = await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps })
    assert.equal(exit, 1, io.text())
    assertEnglish(io.text(), 'the refusal of an install whose key custody failed')
    assert.match(io.text(), /trocar install/, 'it names what to run once the custody can be used')
    const j = fakeIo()
    assert.equal(await runInstallCli(['--yes', '--json'], { io: j, env: w.env, home: w.home, platform, deps }), 1, j.text())
    const doc = j.json()
    assert.equal(doc.ok, false)
    assert.ok(ERROR_CODES.includes(doc.error.code), `error.code is in the closed set: ${JSON.stringify(doc.error)}`)
    assert.ok(doc.error.message.includes('trocar install'), doc.error.message)
    assert.equal(doc.fp256, null, 'no root was made')
  })
}

// §1.1 / D58 (macOS and Windows test machines, 2026-10-18): a receipt has no two identical rows, and it never prints trocar's own ids at a person — a form id
// (`codex.vscode`) and a carrier kind (`config-key`) are read out in words (src/cli/receipt.mjs formWords / carrierWords, one vocabulary).
test('the install receipt prints each (agent, carrier, file) fact once, in words — never one row per form, never a form or carrier id', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['claude', 'codex', 'dsh', 'kimi', 'opencode', 'hermes'] })
  const io = fakeIo()
  const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 0, io.text())
  const text = io.text().slice(io.text().indexOf('Installed.')) // the receipt alone: the plan above it is a screen of its own, printed before anything was written
  const rows = text.split('\n').filter((l) => /^ {2}\S/.test(l))
  assert.deepEqual(rows.filter((l, i) => rows.indexOf(l) !== i), [], `a row is printed twice:\n${text}`)
  const forms = w.harnesses.flatMap((d) => ((d.proxyMode && d.proxyMode.forms) || []).map((f) => f.id))
  assert.ok(forms.length > 0, 'the world has forms to name')
  for (const id of forms) assert.ok(!text.includes(id), `the receipt prints the form id ${id} instead of what the form is`)
  // the whole run says the residual risk once: it is the last line of the plan (§3.2), not a paragraph the receipt repeats (macOS test machine run 2, 2026-10-18)
  const risk = io.text().match(/Any program running as you can ask trocar/g) || []
  assert.equal(risk.length, 1, `the residual-risk paragraph is printed ${risk.length} times`)
  assertEnglish(text, 'the install receipt')
})

// V85 (the model path): the plan names every file of yours outside ~/.trocar by full path, and trocar's own tree in one line — the line the
// model path had no equivalent of (it listed the carriers and the root, and nothing about ~/.trocar at all).
test('V85: the model install plan names trocar\'s own tree in one line and every carrier of yours by path', async () => {
  const { io, exit, w } = await cli(['--dry-run', '--json'])
  assert.equal(exit, 0)
  const plan = io.json().planned
  const trocarLine = plan.filter((p) => /^~[\\/]\.trocar[\\/]:/.test(p.detail))
  assert.equal(trocarLine.length, 1, `trocar's own tree is one line, not ${trocarLine.length}: ${JSON.stringify(plan)}`)
  assert.match(trocarLine[0].detail, /trocar-off/, 'and that line names the undo program, so the plan is readable without a second lookup')
  assert.equal(plan.filter((p) => p.detail.includes(w.home)).length, 0, 'every path is written under ~, never the home twice')
  for (const item of plan) assert.ok(item.detail.length > 0 && item.what, 'every planned item says what it is about')
})

test('4.4 §Plan 「端口」 · V67: install records the board\'s port in ingress.json once — a second install leaves the file byte- and mtime-identical', async () => {
  const { w, io, exit } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const file = path.join(w.dir, 'ingress.json')
  const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs
  const { boardPort } = JSON.parse(bytes)
  assert.ok(boardPort >= BOARD_RANGE[0] && boardPort <= BOARD_RANGE[1], String(boardPort))
  await new Promise((r) => setTimeout(r, 20))
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501, unit: null, backends: { custody: w.custody, rootStore: w.store, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns } }), 0, io2.text())
  assert.deepEqual([fs.readFileSync(file), fs.statSync(file).mtimeMs], [bytes, mtime])
})

// V108, the third failure: a collector on other code that cannot be stopped (it refuses the drain) is left running — exit 1, ok false, problems,
// not replaced, and the receipt says it still runs. A real daemon always obeys the drain (test/cli/install-replace-e2e.test.mjs), so the
// refusal is the control channel's answer here. A 400 naming `by` (an earlier build that does not know install) is asked once more as update, never
// again: a collector that refuses that too is left the same way; any other refusal is not asked again (1.6 §3.2 step 5).
for (const [why, status, asks] of [['refuses the drain', 409, ['install']], ['refuses by:install and by:update', 400, ['install', 'update']]]) {
  test(`V108: install leaves a collector on other code that ${why}, and says so`, async () => {
    const posted = []
    const refuse = async ({ method, body }) => { if (method === 'POST') { posted.push(body.by); throw Object.assign(new Error(`${status}: "by" is not one this collector knows`), { status }) } return {} }
    const { io, exit } = await cli(['--yes', '--json'], { over: { daemonCode: async () => '0.1.0+0000000', request: refuse, daemonState: async () => ({ state: 'running', socket: 'control.sock', lock: { pid: 4242 } }), drainMs: 0 } })
    const r = io.json()
    assert.deepEqual([exit, r.ok, r.problems.length > 0, r.daemon.replaced, r.daemon.state], [1, false, true, false, 'running'], io.text())
    assert.deepEqual(posted, asks, 'the exit requests the collector was sent')
  })
}

// 1.6 §3.2 计划: every row that names a place says what changes there — a carrier with no key (a launch command, a plug-in) in the receipt's words,
// from the carrier kind (the macOS plan printed `kimi-code  ~/.kimi-code/bin` and nothing else)
test('1.6 §3.2: every plan row that names a path says what changes there, a carrier with no key included', async () => {
  const kimi = (w) => { const f = path.join(w.home, '.kimi-code', 'bin', 'kimi'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])) }
  const { io, exit } = await cli(['--dry-run', '--json'], { setup: kimi })
  assert.equal(exit, 0)
  const plan = io.json().planned
  assert.ok(plan.some((p) => p.what === 'kimi-code'), JSON.stringify(plan))
  for (const p of plan.filter((x) => /^~[\\/]/.test(x.detail))) assert.match(p.detail, /^\S.*: \S/, `${p.what}: the path, then what changes there`)
})

// 4.4 Set up (install <harness>) · V85: its plan names only what the run then changes — rule U's block already intact in the user's certificate file
// is not a "will change" row, though another carrier of that harness is missing
test('V85 · Set up: a rule U block that is intact is not in the plan of the harness that is set up again', async () => {
  const { install } = await import('../../src/cli/install.mjs')
  const { readManifest } = await import('../../src/off/manifest.mjs')
  const w = await modelWorld({ commands: ['kimi'], env: (home) => ({ NODE_EXTRA_CA_CERTS: path.join(home, 'certs', 'mine.pem') }) })
  w.file = w.env.NODE_EXTRA_CA_CERTS
  fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, `${(await import('node:tls')).rootCertificates[1].trim()}\n`)
  const kimi = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])) // its native program: the wrapper's precondition
  await w.install({ wrapperKit: { renderWrapper } })
  const wrapper = readManifest(w.dir).files.find((f) => f.harness === 'kimi-code' && f.role === 'wrapper')
  assert.ok(wrapper, 'kimi-code has a carrier of its own to lose')
  fs.writeFileSync(wrapper.path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9, 9, 9, 9])) // the agent's update put its own program back over trocar's launch command
  const io = fakeIo()
  const deps = { getuid: () => 501, unit: null, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses.filter((d) => d.name === 'kimi-code'), which: w.ctx.which, owns: w.owns } // kimi-code alone: this machine's own agents name no file of this world
  assert.equal(await install({ io, env: w.env, home: w.home, platform: 'darwin', deps, flags: new Set(['--dry-run', '--json']), only: 'kimi-code' }), 0, io.text())
  const planned = io.json().planned
  assert.ok(planned.some((p) => p.carrier === 'wrapper'), `the lost carrier is planned: ${JSON.stringify(planned)}`)
  assert.deepEqual(planned.filter((p) => !p.state && (p.paths || []).includes(w.file)), [], 'the intact block is not a change')
})
