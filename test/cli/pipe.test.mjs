import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))

// `trocar … | head`: the reader leaves before trocar has printed everything. The rest of the output has nowhere to go; that is not an error of trocar's
// (no stack trace, no crash), and the command's own exit code stands.
test('cli: a reader that closes the pipe early gets no crash; the exit code is the command\'s', async () => {
  const child = spawn(process.execPath, [BIN, 'help'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.destroy() // closed before trocar writes a byte: every write meets a closed pipe
  let err = ''
  child.stderr.on('data', (b) => { err += b })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(err, '')
  assert.equal(code, 0)
})
