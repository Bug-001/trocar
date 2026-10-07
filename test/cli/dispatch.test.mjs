// test/cli/dispatch.test.mjs — the command line as a whole (RFC 1.6 §2, R4, R7, R10; V6 V19 V20): the dispatch over the table of commands, the help that is made from it, the hidden aliases, root
// and non-root refusals, usage errors that touch nothing. Sandbox HOMEs, injected OS tools, process tables, control sockets and VPN probes: nothing here reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS, HIDDEN_ALIASES, helpText } from '../../src/cli/commands.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox, fakeIo, snapshot } from './fixtures/dispatch-ctx.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const PACKAGE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
/** The context of a run where every command is a spy that records `[name, ...argv]` and answers 0: what the dispatch did, not what the commands do. */
const spying = (seen) => ({ io: fakeIo(), uid: 1000, platform: 'linux', deps: { commands: Object.fromEntries(COMMANDS.map((c) => [c.name, async (argv) => { seen.push([c.name, ...argv]); return 0 }])) } })
const commandsOf = (text) => new Set(text.split('\n').map((l) => l.match(/^ {2}(?:sudo )?asight ([a-z-]+)/)).filter(Boolean).map((m) => m[1]))

test('V19: every hidden alias dispatches to the command it claims, the rest of the arguments follow, and `collector` with anything else is a usage error', async () => {
  for (const a of HIDDEN_ALIASES) {
    const seen = []
    assert.equal(await runCli(a.argv, spying(seen)), 0, a.argv.join(' '))
    assert.deepEqual(seen, [a.to], `${a.argv.join(' ')} runs ${a.to.join(' ')} and nothing else`)
  }
  const seen = []
  await runCli(['collector', 'install', '--no-unit', '--yes', 'claude'], spying(seen)); await runCli(['collector', 'uninstall', '--purge-data'], spying(seen)); await runCli(['install', '--dry-run'], spying(seen))
  assert.deepEqual(seen, [['on', '--no-unit', '--yes', 'claude'], ['uninstall', '--purge-data'], ['on', '--dry-run']], 'what follows the alias is passed on as typed')
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
  assert.match((await say(['help'], 'darwin')).c.io.stdoutText(), /本平台\(darwin\)没有按进程采集器/, 'the platform it runs on is the one help names')
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
  assert.match((await sandbox().run(['on', '--proxy', 'http://127.0.0.1:8899'])).io.stderrText(), /monitor on --no-autostart/, 'the old flag gets its replacement')
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
