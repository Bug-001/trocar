// test/cli/help-json.test.mjs — the CLI describing itself (RFC 1.6 §2, §4.1, §5.4, C.6; V121 V122): `help --json` and `query <name> --help` answer from the same two tables help and
// the dispatch read, so everything here is generated over COMMANDS and QUERIES and a row added later is held to it by itself. Words and counts are not pinned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS, commandNamed, helpText } from '../../src/cli/commands.mjs'
import { optionsOf } from '../../src/cli/args.mjs'
import { SCHEMA_VERSION, EXIT } from '../../src/cli/schema.mjs'
import { QUERIES } from '../../src/query/named/index.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { sandbox, fakeIo } from './fixtures/dispatch-ctx.mjs'

const LISTED = COMMANDS.filter((c) => !c.hidden)
const world = sandbox({ install: false })

async function ask(argv, deps = {}) {
  const c = world.ctx({ io: fakeIo(), deps })
  const exit = await runCli(argv, c)
  return { exit, out: c.io.stdoutText(), err: c.io.stderrText() }
}
const whole = async () => JSON.parse((await ask(['help', '--json'])).out)
const entry = (list, name) => list.find((e) => e.name === name)

test('V122: `help --json` is one line holding the table of commands minus the hidden rows, every data field of a row and no code, and every query', async () => {
  const { exit, out, err } = await ask(['help', '--json'])
  assert.equal(exit, EXIT.ok); assert.equal(err, '')
  assert.equal(out.indexOf('\n'), out.length - 1, 'one line')
  const doc = JSON.parse(out)
  assert.equal(doc.schema, SCHEMA_VERSION); assert.equal(doc.command, 'help'); assert.equal(doc.ok, true)
  assert.deepEqual(doc.commands.map((d) => d.name), LISTED.map((c) => c.name))
  for (const c of LISTED) {
    const d = entry(doc.commands, c.name)
    for (const [key, value] of Object.entries(c)) if (typeof value !== 'function') assert.ok(Object.hasOwn(d, key), `${c.name}: ${key}`)
    assert.ok(!Object.hasOwn(d, 'run'), `${c.name}: no code`)
    assert.equal(d.mutates, typeof c.mutates === 'function' ? 'depends' : c.mutates, c.name)
    assert.deepEqual(d.options, [...optionsOf(c).values()], c.name)
    assert.deepEqual(d.exits.map((e) => e.code), c.exits.map(([code]) => code), c.name)
  }
  assert.deepEqual(doc.queries.map((q) => q.name), Object.keys(QUERIES))
  for (const [name, q] of Object.entries(QUERIES)) {
    const d = entry(doc.queries, name)
    assert.equal(d.summary, q.about.summary, name)
    assert.deepEqual(d.params.map((p) => p.name), q.params, name)
    for (const p of d.params) assert.equal(p.text, q.about.params[p.name], `${name} --${p.name}`)
  }
})

test('V122: one command\'s document is its entry of the whole document, however it is asked; `--help --json` is `help --json`', async () => {
  const doc = await whole()
  for (const { name } of LISTED) {
    const asked = await ask(['help', name, '--json'])
    assert.equal(asked.exit, EXIT.ok, name)
    const one = JSON.parse(asked.out)
    assert.deepEqual(one.commands, [entry(doc.commands, name)], name)
    assert.ok(!Object.hasOwn(one, 'queries'), name)
    assert.equal((await ask([name, '--help', '--json'])).out, asked.out, `${name}: the same bytes`)
  }
  assert.equal((await ask(['--help', '--json'])).out, (await ask(['help', '--json'])).out)
  const hidden = COMMANDS.filter((c) => c.hidden)
  for (const { name } of hidden) assert.deepEqual(JSON.parse((await ask(['help', name, '--json'])).out).commands.map((d) => d.name), [name], `${name}: named, it answers as its text page does`)
})

test('V122: `help` refuses a name that is no command with one `usage` document', async () => {
  const { exit, out, err } = await ask(['help', 'nope', '--json'])
  assert.equal(exit, EXIT.usage); assert.equal(err, '')
  assert.equal(JSON.parse(out).error.code, 'usage')
})

test('V121: `query <name> --help` is that query\'s page: text, a line for each parameter and each exit code', async () => {
  for (const [name, q] of Object.entries(QUERIES)) {
    const { exit, out, err } = await ask(['query', name, '--help'])
    assert.equal(exit, EXIT.ok, name); assert.equal(err, '', name)
    assert.throws(() => JSON.parse(out), SyntaxError, `${name}: a page, not a document`)
    for (const p of q.params) assert.match(out, new RegExp(`^\\s*--${p}\\b`, 'm'), `${name}: --${p} opens its own line`)
    for (const [code] of commandNamed('query').exits) assert.match(out, new RegExp(`^\\s*${code}\\s`, 'm'), `${name}: exit ${code}`)
    assertEnglish(out, name, { placeholders: true })
  }
})

test('V121: `query <name> --help --json` is that query\'s entry of `help --json`, and `query --json` is all of them', async () => {
  const doc = await whole()
  for (const name of Object.keys(QUERIES)) {
    const one = JSON.parse((await ask(['query', name, '--help', '--json'])).out)
    assert.equal(one.schema, SCHEMA_VERSION); assert.equal(one.command, 'help'); assert.equal(one.ok, true)
    assert.deepEqual(one.queries, [entry(doc.queries, name)], name)
    assert.ok(!Object.hasOwn(one, 'commands'), name)
  }
  const list = JSON.parse((await ask(['query', '--json'])).out)
  assert.equal(list.command, 'query')
  assert.deepEqual(list.queries, doc.queries)
})

test('V121: an unknown name with --help is the same refusal as without it', async () => {
  for (const tail of [[], ['--json']]) {
    const plain = await ask(['query', 'nope', ...tail]), helped = await ask(['query', 'nope', '--help', ...tail])
    assert.equal(helped.exit, EXIT.usage, tail.join(' '))
    assert.deepEqual(helped, plain, tail.join(' '))
  }
})

test('V121: `query --help` stays the command\'s own page, wherever --help stands, and a page never reaches the query', async () => {
  assert.equal((await ask(['query', '--help'])).out.trimEnd(), helpText('query'))
  let reached = 0
  const commands = { query: async () => { reached++; return EXIT.ok } }
  for (const name of Object.keys(QUERIES)) {
    assert.equal((await ask(['query', name, '--help'], { commands })).exit, EXIT.ok, name)
    assert.deepEqual(await ask(['query', '--help', name], { commands }), await ask(['query', name, '--help']), `${name}: --help before the name`)
  }
  assert.equal(reached, 0)
})
