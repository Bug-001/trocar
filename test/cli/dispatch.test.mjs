// test/cli/dispatch.test.mjs — the command line as a whole (RFC 1.6 §2, R4, R5, R7, R10; V6 V9 V19 V20 V26): one table of commands, the help that is made from it, the hidden aliases, the exit codes, root
// and non-root refusals, and `--json`. Sandbox HOMEs, injected OS tools, process tables, control sockets and VPN probes: nothing here reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS, HIDDEN_ALIASES, helpText, commandNamed } from '../../src/cli/commands.mjs'
import { LEGACY_COMMANDS } from '../../src/cli/legacy-commands.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox, installedViaCli, fakeIo, snapshot } from './fixtures/dispatch-ctx.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const PACKAGE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
/** The context of a run where every command is a spy that records `[name, ...argv]` and answers 0: what the dispatch did, not what the commands do. */
const spying = (seen) => ({ io: fakeIo(), uid: 1000, platform: 'linux', deps: { commands: Object.fromEntries(COMMANDS.map((c) => [c.name, async (argv) => { seen.push([c.name, ...argv]); return 0 }])) } })
const commandsOf = (text) => new Set(text.split('\n').map((l) => l.match(/^ {2}(?:sudo )?asight ([a-z-]+)/)).filter(Boolean).map((m) => m[1]))

test('V19: every command help lists is dispatched to by name — as root for setup-helper, as a user for the rest — and nothing else is: the spy sees the one command and its arguments as typed', async () => {
  const listed = [...commandsOf(helpText(undefined, { platform: 'linux' }))]
  assert.deepEqual(listed.sort(), COMMANDS.map((c) => c.name).sort())
  for (const name of listed) {
    const seen = [], c = spying(seen); c.uid = commandNamed(name).needsRoot ? 0 : 1000
    assert.equal(await runCli([name, 'x', '--y'], c), 0, name)
    assert.deepEqual(seen, [[name, 'x', '--y']], `${name}: dispatched with its arguments as typed, and nothing else`)
  }
})

// The spy above replaces each command's `run`, so it cannot see whether the table's own `run` reaches the function it should (a `legacy('monitr')` or a renamed import passed it, 2026-10-07 review).
// The two tests below go through the real `run`: the old bodies by `deps.runLegacy` (what they do reads and writes the machine), setup-helper by a fake arch.
test('V19: every old body (LEGACY_COMMANDS) is reached through the real `run` of the command of its own name, with its arguments as typed and nothing else', async () => {
  const asked = []
  for (const name of [...LEGACY_COMMANDS].sort()) {
    asked.length = 0
    assert.ok(commandNamed(name), `${name} is a command of the table`)
    const c = { io: fakeIo(), uid: 1000, platform: 'linux', deps: { runLegacy: async (n, argv) => { asked.push([n, ...argv]); return 0 } } }
    assert.equal(await runCli([name, 'x', '--y'], c), 0, name)
    assert.deepEqual(asked, [[name, 'x', '--y']], `${name} asks for the old body of that name`)
  }
  const failing = { io: fakeIo(), uid: 1000, platform: 'linux', deps: { runLegacy: async () => 1 } }
  assert.equal(await runCli(['serve', 'status'], failing), 1, 'and the exit code the body gave is the one the command leaves with')
})

test('V19: the names the table passes to legacy() are exactly LEGACY_COMMANDS (once each), and each has a case in the switch of legacy-commands.mjs', () => {
  const src = (f) => fs.readFileSync(fileURLToPath(new URL(`../../src/cli/${f}`, import.meta.url)), 'utf8')
  const passed = [...src('commands.mjs').matchAll(/\blegacy\('([a-z-]+)'\)/g)].map((m) => m[1])
  assert.deepEqual([...passed].sort(), [...LEGACY_COMMANDS].sort(), 'a name in the table that LEGACY_COMMANDS does not know is a RangeError when run; one it knows and the table lacks is a body nobody can reach')
  assert.equal(new Set(passed).size, passed.length, 'each once')
  for (const name of LEGACY_COMMANDS) assert.match(src('legacy-commands.mjs'), new RegExp(`^ {4}case '${name}': \\{`, 'm'), `${name} has its case`)
})

test('V20: setup-helper as root runs the real table entry — --binary and --remove reach the arch, what it did is said on stdout, an arch that throws is exit 1 with its words on stderr', async () => {
  const done = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/asight/asight-redirector' }, setupHelper: (o) => { done.push(['setup', o.binarySrc]); return { bin: '/b', getcap: 'caps' } }, uninstallHelper: () => { done.push(['remove']); return { warnings: [] } } } }
  const run = async (argv, over = arch) => { const io = fakeIo(); const exit = await runCli(argv, { io, uid: 0, platform: 'linux', deps: { arch: over } }); return { exit, io } }
  let r = await run(['setup-helper', '--binary', '/tmp/h'])
  assert.equal(r.exit, 0); assert.match(r.io.stdoutText(), /^installed \/b \(caps\)/); assert.equal(r.io.stderrText(), '')
  r = await run(['setup-helper', '--remove'])
  assert.equal(r.exit, 0); assert.match(r.io.stdoutText(), /^removed \/usr\/local\/libexec\/asight\/asight-redirector/)
  assert.deepEqual(done, [['setup', '/tmp/h'], ['remove']], 'the arch was asked once each, with the binary as typed')
  r = await run(['setup-helper'], { install: { setupHelper: () => { throw new Error('the capability bit could not be set') } } })
  assert.equal(r.exit, 1); assert.equal(r.io.stdoutText(), ''); assert.match(r.io.stderrText(), /the capability bit could not be set/)
})

test('V19: every hidden alias dispatches to the command it claims, the rest of the arguments follow, and `collector` with anything else is a usage error', async () => {
  for (const a of HIDDEN_ALIASES) {
    const seen = []
    assert.equal(await runCli(a.argv, spying(seen)), 0, a.argv.join(' '))
    assert.deepEqual(seen, [a.to], `${a.argv.join(' ')} runs ${a.to.join(' ')} and nothing else`)
  }
  const seen = []
  await runCli(['collector', 'install', '--no-unit', '--yes', 'claude'], spying(seen)); await runCli(['collector', 'uninstall', '--purge-data'], spying(seen))
  assert.deepEqual(seen, [['install', '--no-unit', '--yes', 'claude'], ['uninstall', '--purge-data']], 'what follows the alias is passed on as typed (`collector install` is install now)')
  for (const argv of [['collector'], ['collector', 'bogus']]) {
    const c = spying([])
    assert.equal(await runCli(argv, c), 2, argv.join(' '))
    assert.match(c.io.stderrText(), /asight collector: .*on \/ off \/ status \/ uninstall \/ daemon/)
  }
})

test('help through the dispatch: no command, `help`, `--help`, `help <command>` and `<command> --help` are exit 0 and say it; an unknown topic is exit 2; -v and --version print the version', async () => {
  const say = async (argv, platform = 'linux') => { const c = spying([]); c.deps = {}; c.platform = platform; return { exit: await runCli(argv, c), c } }
  for (const argv of [[], ['help'], ['--help'], ['-h']]) {
    const { exit, c } = await say(argv)
    assert.equal(exit, 0, argv.join(' ')); assert.equal(c.io.stdoutText().trim(), helpText(undefined, { platform: 'linux' })); assert.equal(c.io.stderrText(), '')
  }
  assert.match((await say(['help'], 'darwin')).c.io.stdoutText(), /本平台\(darwin\):on \/ off 驱动按进程采集器/, 'the platform it runs on is the one help names')
  assert.match((await say(['help'], 'freebsd')).c.io.stdoutText(), /本平台\(freebsd\):on \/ off 驱动按进程采集器/, 'one wording for every platform now — a platform without a collector is named by loadArch\'s own refusal, not the help (D39⑥)')
  for (const argv of [['help', 'off'], ['off', '--help'], ['off', '-h'], ['off', '--yes', '--help'], ['serve', '--help']]) {
    const { exit, c } = await say(argv)
    assert.equal(exit, 0, argv.join(' ')); assert.equal(c.io.stdoutText().trim(), helpText(argv.includes('serve') ? 'serve' : 'off')); assert.ok(!/asight uninstall/.test(c.io.stdoutText()), 'one command only')
  }
  let r = await say(['help', 'nope'])
  assert.equal(r.exit, 2); assert.match(r.c.io.stderrText(), /nope/); assert.equal(r.c.io.stdoutText(), '')
  assert.equal((await say(['help', 'off', 'on'])).exit, 2)
  for (const argv of [['-v'], ['--version'], ['version']]) { r = await say(argv); assert.equal(r.exit, 0, argv.join(' ')); assert.equal(r.c.io.stdoutText().trim(), PACKAGE.version) }
})

test('V6: an unknown command, an unknown harness, the old --proxy flag and the gone `test` are exit 2 and the sandbox HOME is byte for byte as it was', async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const argv of [['nope'], ['on', 'clade'], ['off', 'clade'], ['status', 'clade'], ['uninstall', 'claude-code'], ['on', '--proxy', 'http://127.0.0.1:8899'], ['on', '--proxy=http://127.0.0.1:8899'], ['test'], ['collector', 'bogus'], ['daemon', '--bogus']]) {
      const s = sandbox({ platform }); const before = snapshot(s.home); const calls = s.sys.exec.calls.length
      const { exit, io } = await s.run(argv)
      assert.equal(exit, 2, `${platform}: ${argv.join(' ')}: ${io.text()}`)
      assert.deepEqual(snapshot(s.home), before, `${platform}: ${argv.join(' ')} wrote nothing`)
      assert.equal(s.sys.exec.calls.length, calls, `${platform}: ${argv.join(' ')} ran no OS tool`)
      assert.ok(io.stderrText().length > 0 && io.stdoutText() === '', 'what is wrong is said on stderr, stdout stays empty')
    }
  }
  const s = sandbox(); const { io } = await s.run(['nope'])
  assert.match(io.stderrText(), /nope/); assert.match(io.stderrText(), /asight help/, 'and where the commands are listed')
  assert.match((await sandbox().run(['on', '--proxy', 'http://127.0.0.1:8899'])).io.stderrText(), /按进程采集器不需要它/, 'the old flag is refused with its retirement said')
})

test('V20: on / off / uninstall / daemon refuse root and write nothing, the aliases too; setup-helper refuses anyone but root; help and version work as root (R7)', async () => {
  for (const argv of [['on'], ['off'], ['uninstall'], ['daemon'], ['install'], ['collector', 'install'], ['collector', 'on'], ['collector', 'off'], ['collector', 'uninstall'], ['collector', 'start'], ['on', '--yes'], ['off', 'clade']]) {
    const s = sandbox(); const before = snapshot(s.home)
    const { exit, io } = await s.run(argv, { uid: 0 })
    assert.equal(exit, 1, argv.join(' ')); assert.match(io.stderrText(), /用你自己的账号跑/, argv.join(' ')); assert.equal(io.stdoutText(), '')
    assert.deepEqual(snapshot(s.home), before, `${argv.join(' ')} wrote nothing`); assert.equal(s.sys.exec.calls.length, 0, 'and ran no tool')
  }
  const s = sandbox(); const seen = [], before = snapshot(s.home)
  for (const uid of [501, 1000]) {
    const { exit, io } = await s.run(['setup-helper'], { uid }); assert.equal(exit, 1, String(uid)); assert.match(io.stderrText(), /sudo asight setup-helper/)
  }
  assert.deepEqual(snapshot(s.home), before, 'refused before anything is read or written')
  const root = spying(seen); root.uid = 0
  assert.equal(await runCli(['setup-helper', '--remove'], root), 0); assert.deepEqual(seen, [['setup-helper', '--remove']], 'as root it is let through')
  const user = spying(seen); user.uid = 501
  assert.equal(await runCli(['setup-helper'], user), 1); assert.equal(seen.length, 1, 'and as a user it is not run')
  for (const argv of [['help'], ['--version'], ['status'], ['doctor'], ['serve']]) { const c = spying([]); c.uid = 0; assert.equal(await runCli(argv, c), 0, `${argv.join(' ')} as root: a command that changes nothing of the user's is not refused`) }
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
  const plan = await sandbox().run(['on', '--json']) // not in a terminal and no --yes: the plan is stderr, stdout is still one JSON (or nothing), exit 2
  assert.equal(plan.exit, 2); assert.match(plan.io.stderrText(), /asight on · 将写 \d+ 个文件/); assert.ok(plan.io.stdoutText() === '' || JSON.parse(plan.io.stdoutText()).command === 'on')
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
  assert.equal(unknown.exit, 3, unknown.io.text()); assert.match(unknown.io.stdoutText(), /不知道/)
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

test('the real bin: --version, help, help off, an unknown command, `daemon --bogus` and `collector nope` (sandbox HOME, no OS tool): 0 and the version, 0 and the first screen, 0 and one command, 2 and the words on stderr', () => {
  const home = tmpDir('asight-bin-')
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || '/tmp', ASIGHT_TEST_SANDBOX: '1' }
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const v = run('--version'); assert.deepEqual([v.status, v.stdout.trim(), v.stderr], [0, PACKAGE.version, ''])
  const h = run('help'); assert.equal(h.status, 0); assert.match(h.stdout, /开 asight on · 关 asight off · 状态 asight status/); assert.deepEqual([...commandsOf(h.stdout)].sort(), COMMANDS.map((c) => c.name).sort())
  const o = run('help', 'off'); assert.equal(o.status, 0); assert.match(o.stdout, /asight off \[harness…\]/); assert.ok(!/asight serve/.test(o.stdout))
  const n = run('nope'); assert.equal(n.status, 2); assert.equal(n.stdout, ''); assert.match(n.stderr, /nope/)
  const d = run('daemon', '--bogus'); assert.deepEqual([d.status, d.stdout], [2, '']); assert.match(d.stderr, /asight daemon: takes no arguments/)
  const c = run('collector', 'nope'); assert.equal(c.status, 2); assert.match(c.stderr, /asight collector: .*asight on \/ off \/ status \/ uninstall \/ daemon/)
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written')
})
