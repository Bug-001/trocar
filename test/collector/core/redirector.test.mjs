import test from 'node:test'
import assert from 'node:assert/strict'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'

const META = { dst: { address: '127.0.0.1', port: 8443, family: 4 }, pid: 42, agent: 'claude-code', decrypt: true }

test('static redirector: per-port override wins over the default, unknown peers get null without a default', async () => {
  const r = createStaticRedirector(META)
  r.set(50000, { ...META, pid: 7 })
  assert.equal((await r.lookup({ address: '127.0.0.1', port: 50000 })).pid, 7)
  assert.equal((await r.lookup({ address: '127.0.0.1', port: 50001 })).pid, 42)
  assert.equal(await createStaticRedirector().lookup({ address: '127.0.0.1', port: 1 }), null)
  assert.equal(r.lookups, 2)
})
