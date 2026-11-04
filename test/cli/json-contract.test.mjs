// test/cli/json-contract.test.mjs — the one document of `--json` (RFC 1.6 §1.2; V120): every command that declares the option answers with exactly one JSON document, on one line
// into a pipe and indented two spaces at a terminal, when it worked and when it refused, and stderr stays empty. The rows come from the table of commands, so a row added later is
// held to this by itself. Nothing here reaches the machine the tests run on: a temp HOME, injected deps, and a temp `root` so `update` has no checkout to fetch (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import path from 'node:path'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS } from '../../src/cli/commands.mjs'
import { optionsOf } from '../../src/cli/args.mjs'
import { SCHEMA_VERSION, EXIT, UNDO_LINE, newReceipt } from '../../src/cli/schema.mjs'
import { printJson, errorDoc, ERROR_CODES } from '../../src/cli/json.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox, installedViaCli, fakeIo } from './fixtures/dispatch-ctx.mjs'

const ROWS = COMMANDS.filter((c) => optionsOf(c).has('--json')).map((c) => c.name)

/** `argv` in a world of its own where nothing is installed. */
async function fresh(argv, { tty = false, commands } = {}) {
  const c = sandbox({ install: false }).ctx({ io: fakeIo({ tty }), deps: { root: tmpDir('trocar-root-'), ...(commands ? { commands } : {}) } })
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

test('V120: a positional no command knows is refused with one `usage` document on one line, and the exit of the text mode', async () => {
  for (const name of ROWS) {
    const { exit, out, err } = await fresh([name, 'no-such-name', '--json'])
    const doc = oneLine(out, name)
    assert.equal(err, '', name)
    assert.equal(doc.ok, false, name); assert.equal(doc.error.code, 'usage', name)
    assert.equal(exit, (await fresh([name, 'no-such-name'])).exit, `${name}: the same exit as without --json`)
  }
})

test('V74: a command that only says why it failed answers with a `failed` document holding those lines, under its own exit', async () => {
  for (const name of ROWS) {
    const spy = async (_argv, ctx) => { ctx.io.err('first'); ctx.io.err('second'); return EXIT.incomplete }
    const { exit, out, err } = await fresh([name, '--json'], { commands: { [name]: spy } })
    assert.equal(exit, EXIT.incomplete, name); assert.equal(err, '', name)
    assert.deepEqual(oneLine(out, name), JSON.parse(JSON.stringify(errorDoc(name, 'failed', 'first\nsecond'))), name)
  }
})

// The failures a command writes its own receipt for, each made by an injected dep. `install` fails where its undo copy cannot be placed; the rest come through the deps each asks first.
const boom = () => { throw new Error('the injected failure') }
const FAILURES = [
  ['on: thrown', 'on', (d) => ({ parts: { ...d.parts, arch: { ...d.parts.arch, nodePreflight: boom } } })],
  ['on: the Node floor', 'on', (d) => ({ parts: { ...d.parts, arch: { ...d.parts.arch, nodePreflight: () => ({ ok: false, doctor: 'too old' }) } } })],
  ['on: refused', 'on', (d) => ({ parts: { ...d.parts, arch: { ...d.parts.arch, refuseElevated: async () => ({ code: 'elevated', reason: 'elevated' }) } } })],
  ['on: half done', 'on', () => ({ install: { turnOn: async () => ({ receipt: { ...newReceipt('on'), ok: false, notes: ['half done'] }, exit: EXIT.incomplete }) } })],
  ['off: thrown', 'off', () => ({ now: boom })],
  ['uninstall: thrown', 'uninstall', () => ({ now: boom })],
  ['install: the copy', 'install', () => ({ fs: { ...nodeFs, mkdirSync: (p, ...rest) => (path.basename(String(p)) === 'bin' ? boom() : nodeFs.mkdirSync(p, ...rest)) } })],
]

test('V74: a command that fails on its own road answers with error.code from the closed set, nothing on stderr, and the exit of the text mode', async () => {
  assert.deepEqual([...new Set(FAILURES.map(([, name]) => name))].sort(), Object.keys(UNDO_LINE).sort(), 'every command that changes state has a row')
  for (const [label, name, over] of FAILURES) {
    const run = async (argv) => { const s = sandbox({ install: false }); const c = s.ctx({ io: fakeIo(), deps: { ...over(s.deps()), root: tmpDir('trocar-root-') } }); return { exit: await runCli(argv, c), out: c.io.stdoutText(), err: c.io.stderrText() } }
    const { exit, out, err } = await run([name, '--yes', '--json'])
    const doc = oneLine(out, label)
    assert.equal(doc.schema, SCHEMA_VERSION, label); assert.equal(doc.command, name, label); assert.equal(doc.ok, false, label)
    assert.ok(ERROR_CODES.includes(doc.error.code), `${label}: ${JSON.stringify(doc.error)}`); assert.ok(doc.error.message, label)
    assert.equal(err, '', label); assert.equal(exit, EXIT.incomplete, `${label}: its own failure, not a crash`)
    assert.equal(exit, (await run([name, '--yes'])).exit, `${label}: the same exit as without --json`)
  }
})

test('V74: every failed receipt carries an error whatever it says; one that waits for a person does not, a code of its own stays, and a reading is left alone', () => {
  const printed = (doc) => { let line; printJson({ out: (s) => { line = s } }, doc); return JSON.parse(line) }
  for (const name of Object.keys(UNDO_LINE)) {
    const failed = { ...newReceipt(name), ok: false }
    for (const said of [{}, { notes: ['a note'] }, { problems: ['a problem'], notes: ['a note'] }, { problems: [], notes: [] }]) {
      const { error } = printed({ ...failed, ...said })
      assert.equal(error.code, 'failed', name); assert.equal(error.message, said.problems?.[0] ?? said.notes?.[0] ?? error.message, name); assert.ok(error.message, name)
    }
    for (const stop of ['needs_yes', 'declined', 'dry_run']) assert.equal(printed({ ...failed, [stop]: true }).error, undefined, `${name} ${stop}`)
    assert.equal(printed({ ...failed, error: { code: 'older-install', message: 'old' } }).error.code, 'older-install', name)
    assert.equal(printed(newReceipt(name)).error, undefined, name)
  }
  assert.equal(printed({ schema: SCHEMA_VERSION, command: 'status', ok: false, health: 'failing' }).error, undefined)
})

test('V120: a command that says something on stderr and prints its document leaves that one document and nothing else', async () => {
  for (const name of ROWS) {
    const doc = errorDoc(name, 'its-own', 'its own words')
    const spy = async (_argv, ctx) => { ctx.io.err('on the way'); printJson(ctx.io, doc); return EXIT.incomplete }
    const { out, err } = await fresh([name, '--json'], { commands: { [name]: spy } })
    assert.equal(err, '', name); assert.deepEqual(oneLine(out, name), JSON.parse(JSON.stringify(doc)), name)
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
