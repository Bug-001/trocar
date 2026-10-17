// test/cli/dispatch.test.mjs — the command line as a whole (RFC 1.6 §2, R4, R5; V9 V26): the exit codes and `--json` of a real run through src/cli/main.mjs.
// The table, the help, the refusals and the error documents are test/cli/{commands,cli-errors}.test.mjs. Sandbox HOMEs, injected OS tools, process
// tables, control sockets and VPN probes: nothing here reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { runCli } from '../../src/cli/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { sandbox, installedViaCli, snapshot } from './fixtures/dispatch-ctx.mjs'

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
  const plan = await sandbox().run(['install', '--json']) // not in a terminal and no --yes: the plan is stderr, stdout is still one JSON (or nothing), exit 2 (D55: the first plan is install's)
  assert.equal(plan.exit, 2); assert.match(plan.io.stderrText(), /将写 \d+ 个文件/); assert.ok(plan.io.stdoutText() === '' || JSON.parse(plan.io.stdoutText()).command === 'install')
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
