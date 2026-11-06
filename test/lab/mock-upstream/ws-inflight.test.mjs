// The mock's in-flight count (GET /__mock/state `inflight`) covers WebSocket replies too: a test that acts mid-stream waits on it,
// whichever transport the client speaks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream } from './server.mjs'
import { wsConnect } from '../ws-client.mjs'

const create = JSON.stringify({ type: 'response.create', model: 'gpt-test-1', store: false, stream: true, input: [{ role: 'user', content: 'hold' }] })
const inflight = async (mock) => (await (await fetch(`${mock.adminUrl}/__mock/state`)).json()).inflight
async function until(fn, ms = 5000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 10))) if (await fn()) return true
  return false
}

test('a WebSocket reply counts as in flight while it is written, and drops back to 0 when it completes or the client goes away', async (t) => {
  const mock = await startMockUpstream({ delays: { dripMs: 20 } }) // long-drip: 120 pieces, about 2.4 s
  t.after(() => mock.close())

  const done = await wsConnect(mock.port, { headers: { 'X-Mock-Scenario': 'long-drip' } })
  t.after(() => done.sock.destroy())
  done.sendText(create)
  assert.ok(await until(async () => (await inflight(mock)) === 1), 'in flight while the reply streams')
  assert.equal((await done.events()).at(-1).type, 'response.completed')
  assert.ok(await until(async () => (await inflight(mock)) === 0), 'back to 0 once it completed, the connection still open')

  const cut = await wsConnect(mock.port, { headers: { 'X-Mock-Scenario': 'long-drip' } })
  cut.sendText(create)
  assert.ok(await until(async () => (await inflight(mock)) === 1))
  cut.sock.destroy()
  assert.ok(await until(async () => (await inflight(mock)) === 0), 'back to 0 once the client dropped mid-reply')
})
