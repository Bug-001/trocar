// test/cli/closed-pipe.test.mjs — RFC 1.6 §1.2: a reader that goes away (`trocar skill | head`) is no error, for any command and on either stream.
// The real command in a real process under a sandbox HOME. The read end is closed before the process has started, so its first write meets a pipe with no reader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))

/** `trocar ...argv` with `closed` shut from the start; what the other stream said and the exit code. */
function run(argv, closed) {
  const home = tmpDir('closed-pipe-')
  const kid = spawn(process.execPath, [BIN, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, USERPROFILE: home } })
  const open = closed === 'stdout' ? 'stderr' : 'stdout'
  kid[closed].destroy()
  let said = ''
  kid[open].on('data', (chunk) => { said += chunk })
  return new Promise((resolve) => kid.on('close', (code, signal) => resolve({ code, signal, said })))
}

for (const argv of [['skill'], ['skill', 'trocar-pr'], ['skill', '--json'], ['help']]) {
  test(`trocar ${argv.join(' ')} with stdout closed: exit 0, no stack`, async () => {
    assert.deepEqual(await run(argv, 'stdout'), { code: 0, signal: null, said: '' })
  })
}

test('with stderr closed a refusal keeps its own exit code', async () => {
  assert.deepEqual(await run(['no-such-command'], 'stderr'), { code: 2, signal: null, said: '' })
})
