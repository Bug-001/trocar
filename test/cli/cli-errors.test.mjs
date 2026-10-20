// test/cli/cli-errors.test.mjs — what the command line does when something is wrong (RFC 1.6 §1.2, §1.3, D58③): with `--json` every refusal is one
// JSON document on stdout and nothing on stderr, and anything a command throws is exit 70 with the stack only in the document. Sandbox HOMEs and
// injected commands: nothing here reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS } from '../../src/cli/commands.mjs'
import { SCHEMA_VERSION } from '../../src/cli/schema.mjs'
import { sandbox, fakeIo, snapshot } from './fixtures/dispatch-ctx.mjs'

/** The context of a run where every command is a spy that answers 0. */
const spying = (seen) => ({ io: fakeIo(), uid: 1000, platform: 'linux', deps: { commands: Object.fromEntries(COMMANDS.map((c) => [c.name, async (argv) => { seen.push([c.name, ...argv]); return 0 }])) } })

test('§1.2: with --json every refusal is one JSON document on stdout and nothing on stderr — an unknown command, an unknown option, root', async () => {
  const cases = [
    [['nope', '--json'], 'nope', 'usage', /unknown command 'nope'/, 1000],
    [['status', '--frob', '--json'], 'status', 'usage', /unknown option '--frob'/, 1000],
    [['on', '--json'], 'on', 'usage', /not as root/, 0],
  ]
  for (const [argv, command, code, message, uid] of cases) {
    const s = sandbox({ install: false }); const before = snapshot(s.home)
    const { exit, io } = await s.run(argv, { uid })
    assert.equal(exit, 2, argv.join(' ')); assert.equal(io.stderrText(), '', `${argv.join(' ')}: nothing on stderr`)
    const doc = JSON.parse(io.stdoutText())
    assert.deepEqual(Object.keys(doc), ['schema', 'command', 'ok', 'error'], argv.join(' '))
    assert.deepEqual([doc.schema, doc.command, doc.ok, doc.error.code], [SCHEMA_VERSION, command, false, code])
    assert.match(doc.error.message, message)
    assert.equal(io.stdoutText().trim(), JSON.stringify(doc), 'one document, one line into a pipe')
    assert.deepEqual(snapshot(s.home), before, `${argv.join(' ')} wrote nothing`)
  }
})

test('§1.3: a command that throws is exit 70 — one line and how to report it, or the document with the stack under --json', async () => {
  const boom = () => { throw new TypeError('a bug of mine') }
  const plain = spying([]); plain.deps = { commands: { status: boom } }
  assert.equal(await runCli(['status'], plain), 70)
  assert.equal(plain.io.stdoutText(), '')
  const lines = plain.io.stderrText().trim().split('\n')
  assert.equal(lines[0], 'trocar: internal error: a bug of mine')
  assert.match(lines[1], /report/); assert.equal(lines.length, 2, 'no stack on a person\'s screen')
  const json = spying([]); json.deps = { commands: { status: boom } }
  assert.equal(await runCli(['status', '--json'], json), 70)
  assert.equal(json.io.stderrText(), '')
  const doc = JSON.parse(json.io.stdoutText())
  assert.deepEqual([doc.schema, doc.command, doc.ok, doc.error.code], [SCHEMA_VERSION, 'status', false, 'internal'])
  assert.match(doc.error.detail, /TypeError: a bug of mine[\s\S]*at /, 'the stack belongs here and nowhere else')
})
