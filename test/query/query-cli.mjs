// test/query/query-cli.mjs — `trocar query` as the command line runs it, for the tests that read through a real daemon. Exports only: node --test runs every .mjs.
import assert from 'node:assert/strict'
import { run as runQueryCli } from '../../src/cli/query.mjs'
import { commandNamed } from '../../src/cli/commands.mjs'
import { parseArgs } from '../../src/cli/args.mjs'

const QUERY = commandNamed('query')

/** `trocar query <argv>` as the command line runs it → { out, exit }: the flags are what the real parser makes of argv (a repeated
 *  option reaches the command as the list of its values), one document on stdout, nothing injected. */
export async function cli(argv, { home, env, platform }) {
  const out = [], err = []
  const io = { out: (s) => out.push(s), err: (s) => { out.push(s); err.push(s) }, stdout: { isTTY: false }, stderr: {}, stdin: { isTTY: false } }
  const args = parseArgs(QUERY, argv)
  assert.equal(args.error, null, `${argv.join(' ')} parses`)
  const exit = await runQueryCli(argv, { io, json: !!args.flags.json, args, home, env, platform, deps: {} })
  return { out: out.join('\n'), err: err.join('\n'), exit }
}
