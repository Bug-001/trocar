// test/cli/dispatch.test.mjs — the command line as a whole (RFC 1.6 §1.2, §1.3, §1.5, §2; V6 V9 V19 V20 V26): one table of commands, the help made
// from it, the exit codes, the root and non-root refusals, the JSON error document and exit 70. Sandbox HOMEs, injected OS tools, process tables,
// control sockets and VPN probes: nothing here reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS, helpText, commandNamed, usageLine } from '../../src/cli/commands.mjs'
import { WIDTH } from '../../src/cli/text.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox, installedViaCli, fakeIo, snapshot } from './fixtures/dispatch-ctx.mjs'

const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
import { codeId } from '../../src/version.mjs'

const CODE = codeId() // D67⑥: the version with HEAD's first 7 in a git checkout
/** The context of a run where every command is a spy that records `[name, ...argv]` and answers 0: what the dispatch did, not what the commands do. */
const spying = (seen) => ({ io: fakeIo(), uid: 1000, platform: 'linux', deps: { commands: Object.fromEntries(COMMANDS.map((c) => [c.name, async (argv) => { seen.push([c.name, ...argv]); return 0 }])) } })
const commandsOf = (text) => new Set(text.split('\n').map((l) => l.match(/^ {2}(?:sudo )?trocar ([a-z-]+)/)).filter(Boolean).map((m) => m[1]))

test('V19: help is the dispatch — every command help lists is reached by its own name, with its arguments as typed and nothing else; there is no other way to reach one', async () => {
  const listed = [...commandsOf(helpText())]
  assert.deepEqual(listed.sort(), COMMANDS.filter((c) => c.group).map((c) => c.name).sort())
  for (const name of [...listed, 'help']) {
    const seen = [], c = spying(seen)
    c.uid = commandNamed(name).needsRoot ? 0 : 1000
    const argv = commandNamed(name).openOptions ? [name, 'x', '--y', 'z'] : [name, 'x']
    assert.equal(await runCli(argv, c), 0, name)
    assert.deepEqual(seen, [argv], `${name}: dispatched with its arguments as typed, and nothing else`)
  }
  for (const argv of [['collector', 'on'], ['verify'], ['version'], ['etl', 'x'], ['shard'], ['keep']]) {
    const c = spying([])
    assert.equal(await runCli(argv, c), 2, `${argv.join(' ')} is no command any more`)
    assert.match(c.io.stderrText(), /^trocar: unknown command '[a-z]+'\. Run: trocar help\n?$/, 'one line, not a screen of help')
  }
})

test('V19: the real table entry of every command resolves to a function (no renamed import, no module that is not there)', async () => {
  for (const c of COMMANDS) {
    const src = fs.readFileSync(fileURLToPath(new URL('../../src/cli/commands.mjs', import.meta.url)), 'utf8')
    const m = new RegExp(`name: '${c.name}'[\\s\\S]{0,600}?via\\('([^']+)', '([^']+)'\\)`).exec(src)
    if (!m) continue
    const mod = await import(new URL(m[1], new URL('../../src/cli/', import.meta.url)))
    assert.equal(typeof mod[m[2]], 'function', `${c.name}: ${m[1]} exports ${m[2]}`)
  }
})

test('V20: setup-helper off Linux is exit 2 and not needed here; as a user it says to use sudo; as root on Linux it runs — --binary and --remove reach the installer', async () => {
  const done = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/trocar/trocar-redirector' }, setupHelper: (o) => { done.push(['setup', o.binarySrc]); return { bin: '/b', getcap: 'caps' } }, uninstallHelper: () => { done.push(['remove']); return { warnings: [] } } } }
  const run = async (argv, { over = arch, uid = 0, platform = 'linux' } = {}) => { const io = fakeIo(); const exit = await runCli(argv, { io, uid, platform, deps: { arch: over } }); return { exit, io } }
  for (const platform of ['darwin', 'win32']) {
    const r = await run(['setup-helper'], { platform, uid: 0 })
    assert.equal(r.exit, 2, platform); assert.equal(r.io.stdoutText(), '')
    assert.equal(r.io.stderrText().trim(), 'trocar setup-helper: not needed on this platform.')
  }
  const user = await run(['setup-helper'], { uid: 1000 })
  assert.equal(user.exit, 2); assert.match(user.io.stderrText(), /run it with sudo: sudo trocar setup-helper/)
  assert.deepEqual(done, [], 'refused before anything was installed')
  let r = await run(['setup-helper', '--binary', '/tmp/h'])
  assert.equal(r.exit, 0); assert.match(r.io.stdoutText(), /^installed \/b \(caps\)/); assert.equal(r.io.stderrText(), '')
  r = await run(['setup-helper', '--remove'])
  assert.equal(r.exit, 0); assert.match(r.io.stdoutText(), /^Removed the kernel helper \/usr\/local\/libexec\/trocar\/trocar-redirector/)
  assert.deepEqual(done, [['setup', '/tmp/h'], ['remove']], 'the installer was asked once each, with the binary as typed')
  r = await run(['setup-helper'], { over: { install: { setupHelper: () => { throw new Error('the capability bit could not be set') } } } })
  assert.equal(r.exit, 1); assert.equal(r.io.stdoutText(), ''); assert.match(r.io.stderrText(), /the capability bit could not be set/)
})

test('help through the dispatch: no arguments, `help`, `--help`, `help <command>` and `<command> --help` are exit 0; an unknown topic is exit 2; --version prints `trocar <version>`', async () => {
  const say = async (argv) => { const c = spying([]); c.deps = {}; return { exit: await runCli(argv, c), c } }
  for (const argv of [[], ['--help'], ['-h'], ['help']]) {
    const { exit, c } = await say(argv)
    assert.equal(exit, 0, argv.join(' ')); assert.equal(c.io.stdoutText().trim(), helpText()); assert.equal(c.io.stderrText(), '')
  }
  for (const argv of [['help', 'off'], ['off', '--help'], ['off', '-h'], ['off', '--yes', '--help'], ['board', '--help'], ['query', '--help']]) {
    const { exit, c } = await say(argv)
    const name = argv[0] === 'help' ? argv[1] : argv[0]
    assert.equal(exit, 0, argv.join(' ')); assert.equal(c.io.stdoutText().trim(), helpText(name)); assert.ok(!/trocar uninstall/.test(c.io.stdoutText()), 'one command only')
  }
  let r = await say(['help', 'nope'])
  assert.equal(r.exit, 2); assert.match(r.c.io.stderrText(), /trocar help: unknown command 'nope'\. Run: trocar help/); assert.equal(r.c.io.stdoutText(), '')
  assert.equal((await say(['help', 'off', 'on'])).exit, 2, 'one command at a time')
  r = await say(['--version'])
  assert.deepEqual([r.exit, r.c.io.stdoutText().trim()], [0, `trocar ${CODE}`])
  for (const argv of [['-v'], ['version']]) assert.equal((await say(argv)).exit, 2, `${argv[0]} is gone: one feature, one name`)
})

test('V6: an unknown command, an unknown option, an unknown harness and a flag that was removed are exit 2, say one line and the usage, and leave the sandbox HOME byte for byte as it was', async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const argv of [['nope'], ['on', 'clade'], ['off', 'clade'], ['status', 'clade'], ['uninstall', 'claude-code'], ['on', '--proxy', 'http://127.0.0.1:8899'],
      ['on', '--opt-in'], ['off', '--remove-ca'], ['doctor', '--source', '/x'], ['doctor', '--only', 'old-ca'], ['board', '--port', '9800'], ['daemon', '--bogus'], ['status', '--frob']]) {
      const s = sandbox({ platform, install: false }); const before = snapshot(s.home); const calls = s.sys.exec.calls.length
      const { exit, io } = await s.run(argv)
      assert.equal(exit, 2, `${platform}: ${argv.join(' ')}: ${io.text()}`)
      assert.deepEqual(snapshot(s.home), before, `${platform}: ${argv.join(' ')} wrote nothing`)
      assert.equal(s.sys.exec.calls.length, calls, `${platform}: ${argv.join(' ')} ran no OS tool`)
      assert.ok(io.stderrText().length > 0 && io.stdoutText() === '', 'what is wrong is said on stderr, stdout stays empty')
    }
  }
  const unknownOption = await sandbox().run(['status', '--frob'])
  assert.equal(unknownOption.io.stderrText().trim(), `trocar status: unknown option '--frob'\n${usageLine(commandNamed('status'))}`)
  const unknownCommand = await sandbox().run(['nope'])
  assert.equal(unknownCommand.io.stderrText().trim(), "trocar: unknown command 'nope'. Run: trocar help")
  // §1.1⑥: a usage line longer than 80 columns folds under itself here as it does in help, it is not printed ragged
  const long = await sandbox({ install: false }).run(['on', '--bogus'])
  const lines = long.io.stderrText().trimEnd().split('\n')
  assert.equal(lines[0], "trocar on: unknown option '--bogus'")
  for (const line of lines) assert.ok(line.length <= WIDTH, `${line.length} columns: ${line}`)
  assert.equal(lines.slice(1).join(' ').replace(/\s+/g, ' ').trim(), usageLine(commandNamed('on')), 'the whole usage line is there, folded')
})

test('V20: install / on / off / uninstall / daemon and the subcommands that change state (classes set|add|rm|reset) refuse root and write nothing; what changes nothing of yours is not refused (§1.5)', async () => {
  for (const argv of [['install'], ['on'], ['off'], ['uninstall'], ['daemon'], ['on', '--yes'], ['off', 'clade'],
    ['classes', 'set', 'models', 'log'], ['classes', 'add', 'models', 'x'], ['classes', 'rm', 'models'], ['classes', 'reset']]) {
    const s = sandbox({ install: false }); const before = snapshot(s.home)
    const { exit, io } = await s.run(argv, { uid: 0 })
    assert.equal(exit, 2, argv.join(' '))
    assert.equal(io.stderrText().trim(), `trocar ${argv[0]}: run this as your own user, not as root.`, argv.join(' '))
    assert.equal(io.stdoutText(), '')
    assert.deepEqual(snapshot(s.home), before, `${argv.join(' ')} wrote nothing`); assert.equal(s.sys.exec.calls.length, 0, 'and ran no tool')
  }
  // only reading: `classes` shown and `raw` run as root like any other read
  for (const argv of [['help'], ['--version'], ['status'], ['doctor'], ['query'], ['classes'], ['classes', 'models'], ['raw', 'seg-1']]) {
    const c = spying([]); c.uid = 0
    assert.equal(await runCli(argv, c), 0, `${argv.join(' ')} as root`)
    assert.equal(c.io.stderrText(), '', `${argv.join(' ')} is not refused`)
  }
  // and the real `classes` shown and `raw` as root: they read and answer, they are never the root refusal (§4.2, §5.1)
  const s = sandbox({ install: false })
  for (const argv of [['query'], ['classes'], ['raw', 'no-such-segment']]) {
    const { exit, io } = await s.run(argv, { uid: 0 })
    assert.ok([0, 1].includes(exit), `${argv.join(' ')} as root: exit ${exit}: ${io.text()}`)
    assert.ok(!/not as root/.test(io.text()), `${argv.join(' ')} as root was refused: ${io.text()}`)
  }
})

test('V9: status, off, on, doctor and uninstall with --json print one JSON value that passes validateReceipt, its `command` is the command, and what is said besides goes to stderr', async () => {
  const s = await installedViaCli()
  for (const argv of [['status', '--json'], ['doctor', '--json'], ['off', '--json'], ['on', '--yes', '--json'], ['uninstall', '--yes', '--json']]) {
    const { exit, io } = await s.run(argv)
    const out = io.stdoutText()
    const v = JSON.parse(out)
    assert.deepEqual(validateReceipt(v), [], `${argv.join(' ')}: ${out.slice(0, 300)}`)
    assert.equal(v.command, argv[0]); assert.equal(typeof v.ok, 'boolean')
    assert.equal(out.trim(), JSON.stringify(v, null, 2), `${argv.join(' ')}: stdout is that one value and nothing else`)
    assert.ok([0, 1, 3].includes(exit), `${argv.join(' ')}: exit ${exit}`)
  }
  const plan = await sandbox().run(['install', '--json']) // not in a terminal and no --yes: the plan is stderr, stdout is still one JSON (or nothing), exit 2
  assert.equal(plan.exit, 2); assert.ok(plan.io.stdoutText() === '' || JSON.parse(plan.io.stdoutText()).command === 'install')
})

test('V26: one case per exit code — 0 done, 1 not done, 2 usage, 3 status cannot judge, 70 the daemon crashed', async () => {
  const s = await installedViaCli()
  assert.equal((await s.run(['status'])).exit, 0, 'on and every harness captured')
  const refused = async (q) => { if (q.path === '/off') throw Object.assign(new Error('400: no'), { status: 400 }); return s.deps().request(q) }
  const one = await s.run(['off'], { deps: { request: refused } })
  assert.equal(one.exit, 1, `the daemon refuses the off request: not done: ${one.io.text()}`)
  assert.equal((await s.run(['off', '--bogus'])).exit, 2)
  assert.equal((await s.run(['off'])).exit, 0, 'and the same off, asked properly, is done')
  fs.writeFileSync(path.join(s.dir, 'state.json'), '{not json')
  const down = async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
  const unknown = await s.run(['status'], { deps: { request: down } })
  assert.equal(unknown.exit, 3, unknown.io.text())
  // 70: an uncaught exception once the daemon is up — recorded as a `crash` first, then the process leaves with 70 (here: `exit` is a spy, the run returns the code)
  const proc = new EventEmitter(), exits = []
  const started = { port: 1, socketPath: '/s', stop: async () => ({ failed: [] }) }
  const run = runCli(['daemon'], { ...s.ctx({ deps: { startDaemon: async () => started, proc, exit: (c) => exits.push(c), waitForStop: () => new Promise(() => {}) } }) })
  for (let i = 0; i < 50 && proc.listenerCount('uncaughtException') === 0; i++) await new Promise((r) => setTimeout(r, 5))
  proc.emit('uncaughtException', new TypeError('boom in a timer'))
  const gave = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('the run did not end after the crash'), 3000))]) // a daemon that ignores the crash would wait for ever
  assert.equal(gave, 70); assert.deepEqual(exits, [70])
  const flows = path.join(s.dir, 'flows'), rec = fs.readdirSync(flows).flatMap((n) => fs.readFileSync(path.join(flows, n), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((e) => e.code === 'crash')
  assert.deepEqual(rec.map((e) => [e.where, e.code]), [['daemon', 'crash']]); assert.match(rec[0].reason, /boom in a timer/)
  // and 1 for the daemon: it would not start
  assert.equal((await s.run(['daemon'], { deps: { startDaemon: async () => { throw new Error('the port is taken') } } })).exit, 1)
})

test('the real bin: --version, help, help off, an unknown command and `daemon --bogus` (sandbox HOME, no OS tool)', () => {
  const home = tmpDir('trocar-bin-')
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || '/tmp', TROCAR_TEST_SANDBOX: '1' }
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const v = run('--version'); assert.deepEqual([v.status, v.stdout.trim(), v.stderr], [0, `trocar ${CODE}`, ''])
  const h = run('help'); assert.equal(h.status, 0); assert.deepEqual([...commandsOf(h.stdout)].sort(), COMMANDS.filter((c) => c.group).map((c) => c.name).sort())
  const o = run('help', 'off'); assert.equal(o.status, 0); assert.match(o.stdout, /trocar off \[<harness>\.\.\.\]/); assert.ok(!/trocar serve/.test(o.stdout))
  const n = run('nope'); assert.equal(n.status, 2); assert.equal(n.stdout, ''); assert.match(n.stderr, /unknown command 'nope'/)
  const d = run('daemon', '--bogus'); assert.deepEqual([d.status, d.stdout], [2, '']); assert.match(d.stderr, /trocar daemon: unknown option '--bogus'/)
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written')
})
