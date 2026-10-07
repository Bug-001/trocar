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

test('static redirector: lookup waits for a late-registered port, else null (accept race)', async () => {
  const r = createStaticRedirector(null, { waitMs: 200, pollMs: 5 })
  const pending = r.lookup({ address: '127.0.0.1', port: 51000 })
  setTimeout(() => r.set(51000, { ...META, pid: 9 }), 20) // registered a tick after lookup, like sockops
  assert.equal((await pending).pid, 9)
  assert.equal(await r.lookup({ address: '127.0.0.1', port: 52000 }), null) // never registered → null after the wait
})

test('static redirector: setBeatGate exists (the contract of the daemon) and does nothing — there are no beats to gate', () => {
  const r = createStaticRedirector(META)
  assert.equal(r.setBeatGate(() => false), undefined)
})
