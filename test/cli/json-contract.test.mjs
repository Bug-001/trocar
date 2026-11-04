// test/cli/json-contract.test.mjs — the one document of `--json` (RFC 1.6 §1.2; V120): every command that declares the option answers with exactly one JSON document, on one line
// into a pipe and indented two spaces at a terminal, when it worked and when it refused, and stderr stays empty. The rows come from the table of commands, so a row added later is
// held to this by itself. Nothing here reaches the machine the tests run on: a temp HOME, injected deps, and a temp `root` so `update` has no checkout to fetch (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS } from '../../src/cli/commands.mjs'
import { optionsOf } from '../../src/cli/args.mjs'
import { SCHEMA_VERSION, EXIT } from '../../src/cli/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox, installedViaCli, fakeIo } from './fixtures/dispatch-ctx.mjs'

const ROWS = COMMANDS.filter((c) => optionsOf(c).has('--json')).map((c) => c.name)

/** `argv` in a world of its own where nothing is installed. */
async function fresh(argv, { tty = false } = {}) {
  const c = sandbox({ install: false }).ctx({ io: fakeIo({ tty }), deps: { root: tmpDir('trocar-root-') } })
  const exit = await runCli(argv, c)
  return { exit, out: c.io.stdoutText(), err: c.io.stderrText() }
}

/** The document of `out`, after checking that it is one line and nothing else. */
function oneLine(out, label) {
  assert.ok(out.endsWith('\n') && out.indexOf('\n') === out.length - 1, `${label}: one line: ${out.slice(0, 300)}`)
  return JSON.parse(out)
}

test('V120: into a pipe every --json command prints one line holding one document with the shared keys, and nothing on stderr', async () => {
  assert.ok(ROWS.length > 0)
  for (const name of ROWS) {
    const { out, err } = await fresh([name, '--json'])
    const doc = oneLine(out, name)
    assert.equal(doc.schema, SCHEMA_VERSION, name); assert.equal(doc.command, name); assert.equal(typeof doc.ok, 'boolean', name)
    assert.equal(err, '', name)
  }
})

test('V120: a positional no command knows still gets one document on one line, a usage exit is a `usage` error, and a refusal exits as the text mode does', async () => {
  for (const name of ROWS) {
    const { exit, out, err } = await fresh([name, 'no-such-name', '--json'])
    const doc = oneLine(out, name)
    assert.equal(err, '', name)
    if (exit === EXIT.usage) { assert.equal(doc.ok, false, name); assert.equal(doc.error.code, 'usage', name) }
    if (!doc.ok) assert.equal(exit, (await fresh([name, 'no-such-name'])).exit, `${name}: the same exit as without --json`)
  }
})

test('V120: at a terminal the same document is indented two spaces', async () => {
  for (const name of ROWS) {
    const { out } = await fresh([name, '--json'], { tty: true })
    assert.equal(out, `${JSON.stringify(JSON.parse(out), null, 2)}\n`, name)
  }
})

test('V120: on an installed machine the receipts and the readings are one line too', async () => {
  const s = await installedViaCli()
  for (const argv of [['status', '--json'], ['doctor', '--json'], ['off', '--json'], ['on', '--yes', '--json'], ['uninstall', '--yes', '--json']]) {
    oneLine((await s.run(argv)).io.stdoutText(), argv.join(' '))
  }
})
