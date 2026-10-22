// test/cli/args.test.mjs — the declarative option parsing of the command table (src/cli/args.mjs; RFC 1.6 §1, §2): which options a command takes
// is data in src/cli/commands.mjs, so nothing has to be guessed from the shape of an argument, and an option nobody declared is a usage error.
import test from 'node:test'
import assert from 'node:assert/strict'
import { optionsOf, parseArgs } from '../../src/cli/args.mjs'

const cmd = { name: 'demo', usage: 'trocar demo [<harness>...] [--now] [--port <port>]', options: [['--now', 'at once'], ['--port <port>', 'the port']] }

test('optionsOf: the declaration says the name, whether it takes a value, and its one line of help', () => {
  const o = optionsOf(cmd)
  assert.deepEqual([...o.keys()], ['--now', '--port'])
  assert.deepEqual(o.get('--now'), { name: '--now', value: null, help: 'at once' })
  assert.deepEqual(o.get('--port'), { name: '--port', value: 'port', help: 'the port' })
  assert.deepEqual([...optionsOf({ name: 'x' }).keys()], [], 'a command with no options declares none')
})

test('parseArgs: positionals keep their order, a declared value is taken from the next argument or after =, a flag is true', () => {
  assert.deepEqual(parseArgs(cmd, ['claude-code', 'codex', '--now']), { positionals: ['claude-code', 'codex'], flags: { now: true }, error: null })
  assert.deepEqual(parseArgs(cmd, ['--port', '9801', 'x']), { positionals: ['x'], flags: { port: '9801' }, error: null }, 'the value of an option is never a positional')
  assert.deepEqual(parseArgs(cmd, ['--port=9801']), { positionals: [], flags: { port: '9801' }, error: null })
  assert.deepEqual(parseArgs(cmd, []), { positionals: [], flags: {}, error: null })
  assert.deepEqual(parseArgs(cmd, ['-']).positionals, ['-'], 'a lone dash is a positional, not an option')
})

test('parseArgs: an option nobody declared, and a value-taking option with nothing after it, are usage errors naming the command and its usage line', () => {
  const bad = parseArgs(cmd, ['--frob'])
  assert.deepEqual(bad.flags, {}); assert.deepEqual(bad.positionals, [])
  assert.deepEqual(bad.error, { code: 'usage', message: "trocar demo: unknown option '--frob'", usage: cmd.usage })
  assert.equal(parseArgs(cmd, ['--now=1']).error.message, "trocar demo: option '--now' takes no value")
  assert.equal(parseArgs(cmd, ['--port']).error.message, "trocar demo: option '--port' needs a value")
  assert.equal(parseArgs(cmd, ['x', '--frob', '--now']).error.message, "trocar demo: unknown option '--frob'", 'the first unknown option is the one reported')
  assert.equal(parseArgs(cmd, ['-x']).error.message, "trocar demo: unknown option '-x'", 'a short option nobody declared too')
})

test('parseArgs: a command with open options (query, whose parameters are the query\'s own) keeps every option it is given', () => {
  const open = { name: 'query', usage: 'trocar query <name> [--<param> <value>...]', openOptions: true }
  assert.deepEqual(parseArgs(open, ['sessions', '--since', '7d', '--limit', '10']), { positionals: ['sessions'], flags: { since: '7d', limit: '10' }, error: null })
  assert.deepEqual(parseArgs(open, ['sessions', '--verbose']).flags, { verbose: true }, 'an option with no value is true')
  assert.equal(parseArgs(open, ['--json']).error, null)
  assert.deepEqual(parseArgs(open, ['sessions', '--limit', '-1', '--ratio', '-0.5', '-2']),
    { positionals: ['sessions', '-2'], flags: { limit: '-1', ratio: '-0.5' }, error: null },
    'a negative number is a value (and a positional), not an option name nobody declared')
  assert.deepEqual(parseArgs(open, ['block', '--ref', 'a', '--ref=b', '--ref', 'c']).flags, { ref: ['a', 'b', 'c'] },
    'an option given more than once is a list of its values, in order (1.6 §4.1 参数)')
})
