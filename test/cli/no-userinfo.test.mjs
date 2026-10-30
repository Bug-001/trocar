// test/cli/no-userinfo.test.mjs — RFC 1.6 §1.2「不印凭据」at the dispatch: whatever a command that changes state prints through its io, as text or as
// a JSON document, carries no `user:password@` of a URL; a command that reads data prints its bytes as they are (§4.1). Generated over the command
// table × the URL forms a password can take × the channel; each command is a spy that prints the URL (deps.commands), so this holds for any command
// the table gains.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from '../../src/cli/main.mjs'
import { COMMANDS } from '../../src/cli/commands.mjs'
import { parseArgs } from '../../src/cli/args.mjs'

const PW = 'pw-not-a-real-secret-41f9'
const URLS = [
  `http://claude-code:settings:${PW}@127.0.0.1:47011`,
  `http://door:${PW}@x@127.0.0.1:47011/`,
  `socks5h://u:${PW}@[::1]:1080`,
  `https://${PW}@proxy.example:8443`,
  `http://u:it's!$&()*+,;=-${PW}@proxy.example:8080`,
]
const CARRIERS = [
  (u) => `env.https_proxy = ${u}`, // a JSON key, as a receipt names it
  (u) => `block with HTTPS_PROXY=${u}, NO_PROXY=localhost`, // a dotenv block
  (u) => `line "export HTTPS_PROXY=${u} # trocar"`, // a line
  (u) => JSON.stringify({ what: u, nested: [{ value: u }] }, null, 2), // a --json document
]
// a mutating form of each command: no argument, or the first positional its `mutates` answers yes to
const mutatingArgv = (cmd) => {
  if (typeof cmd.mutates !== 'function') return cmd.mutates ? [] : null
  for (const p of ['set', 'add', 'rm', 'reset', 'seal']) if (cmd.mutates(parseArgs(cmd, [p]))) return [p]
  return null
}

for (const cmd of COMMANDS.filter((c) => !c.needsRoot && c.name !== 'help')) {
  test(`${cmd.name}: what it prints ${mutatingArgv(cmd) ? 'carries no URL password' : 'is printed as it is'}`, async () => {
    const argv = mutatingArgv(cmd) ?? (cmd.name === 'query' ? ['calls'] : [])
    for (const url of URLS) {
      for (const carry of CARRIERS) {
        const said = []
        const io = { out: (s) => said.push(s), err: (s) => said.push(s), stdin: { isTTY: false }, stdout: { isTTY: false } }
        const spy = async (_argv, ctx) => { ctx.io.out(carry(url)); ctx.io.err(carry(url)); return 0 }
        assert.equal(await runCli([cmd.name, ...argv], { io, uid: 1000, platform: 'linux', deps: { commands: { [cmd.name]: spy } } }), 0, said.join('\n'))
        assert.equal(said.length, 2)
        if (mutatingArgv(cmd)) {
          for (const s of said) {
            assert.ok(!s.includes(PW), `${cmd.name} printed a password: ${s}`)
            assert.ok(s.includes('***@'), `${cmd.name}: the URL is still shown, its userinfo as ***@: ${s}`)
          }
          if (carry === CARRIERS[3]) assert.doesNotThrow(() => JSON.parse(said[0]), 'a JSON document stays one')
        } else assert.deepEqual(said, [carry(url), carry(url)], `${cmd.name} reads data: its bytes are its own`)
      }
    }
  })
}
