// test/helpers/model-daemon.test.mjs — servableWorld: the world a test takes on a host is one that host can serve, built from that platform's own arch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { servableWorld, unservable } from './model-daemon.mjs'

test('servableWorld: on every host, a platform that host can serve, with that platform\'s own wrapper renderer; a win32 host gets the win32 world', async () => {
  for (const host of ['darwin', 'linux', 'win32']) {
    const w = await servableWorld(host)
    assert.equal(await unservable(w.platform, host), false, host)
    assert.equal(w.renderWrapper, (await import(`../../src/collector/arch/${w.platform}/wrapper.mjs`)).renderWrapper, host)
  }
  assert.equal((await servableWorld('win32')).platform, 'win32') // darwin's control endpoint is a unix socket, which a win32 host cannot listen on
})
