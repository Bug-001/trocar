// test/helpers/model-daemon.test.mjs — servableWorld: every host gets a world it can serve; a win32 host, whose control endpoint is a
// named pipe, gets the win32 world (darwin's is a unix socket).
import test from 'node:test'
import assert from 'node:assert/strict'
import { servableWorld } from './model-daemon.mjs'

test('servableWorld: every host gets a world; a win32 host gets the win32 world', async () => {
  for (const host of ['darwin', 'linux', 'win32']) await servableWorld(host)
  assert.equal((await servableWorld('win32')).platform, 'win32')
})
