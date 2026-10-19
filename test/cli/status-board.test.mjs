// test/cli/status-board.test.mjs — V90 (RFC 1.6 §3.5 Board line, 附录 C.3 `board`): `status` says the board's state from the reply it already gets
// (D62: no second round trip), its url from ingress.json, never its token, and the board never moves the exit code. Sandbox HOME, injected
// daemon replies (0.1 §3). The V43 half (GET /api/status board == status --json board) is test/server/api-parity.test.mjs's whole-document equality.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { runStatus, down, reply, asDaemon, SOCK } from './fixtures/status-ctx.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { ensureBoardPort } from '../../src/collector/core/ingress-config.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

test('V90: board.state follows the daemon\'s own reply, url is ingress.json\'s boardPort, the token is in neither output, and the board never moves the exit code', async () => {
  const s = await installedHome()
  const { port } = await ensureBoardPort({ dir: s.dir, isFree: async () => true })
  const token = crypto.randomBytes(32).toString('base64url')
  fs.writeFileSync(path.join(s.dir, 'board.token'), token, { mode: 0o600 })
  const up = (board) => asDaemon(reply(board ? { board } : {}))
  const cases = [ // what the daemon says (or that it is not there) → board.state; the exit of the up cases is one value
    ['serving', up({ port, state: 'serving', reason: null }), true],
    ['port-taken', up({ port, state: 'port-taken', reason: 'EADDRINUSE' }), true],
    ['not-running', up({ port: null, state: 'no-port', reason: 'no board port recorded' }), true],
    ['unknown', up(null), true],
    ['not-running', down(), false],
  ]
  const exits = new Set()
  for (const [state, request, daemonUp] of cases) {
    const t = await runStatus(s, [], { request }), j = await runStatus(s, ['--json'], { request })
    const b = j.io.json().board
    assert.equal(b.state, state, JSON.stringify(b))
    assert.equal(b.url, `http://127.0.0.1:${port}/`)
    assert.equal(b.reason === null, state === 'serving', JSON.stringify(b))
    if (b.reason !== null) assert.equal(typeof b.reason, 'string')
    for (const out of [t.text, j.text, t.io.stderrText(), j.io.stderrText()]) assert.ok(!out.includes(token), 'the token is printed only by asight board')
    assert.equal(t.exit, j.exit)
    if (daemonUp) exits.add(t.exit)
  }
  assert.equal(exits.size, 1, `the board's state never changes the exit code: ${[...exits]}`)
})

test('V90: with no install record the board is not-installed, with a reason and no url', async () => {
  const home = tmpDir('asight-fresh-')
  const io = fakeIo()
  await runStatusCli(['--json'], { io, home, platform: 'linux', env: { HOME: home }, deps: { request: down(), socketPath: SOCK, procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
  const b = io.json().board
  assert.deepEqual([b.state, b.url, typeof b.reason], ['not-installed', null, 'string'])
})
