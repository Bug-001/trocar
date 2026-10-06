// test/helpers/bounded.test.mjs — the bounded waits the collector's socket tests stand on (test/helpers/bounded.mjs). A wait
// that never ends must fail the test with what it waited for, never park the file: see the header of bounded.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { within, onceWithin, closeWithin } from './bounded.mjs'
import { createEngine } from '../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'

test('within: the value of a promise that settles in time, and its own rejection, pass through', async () => {
  assert.equal(await within(Promise.resolve(7), 1000, 'x'), 7)
  await assert.rejects(within(Promise.reject(new Error('its own')), 1000, 'x'), /^Error: its own$/)
})

test('within: a promise that never settles is a rejection that says what was waited for and for how long, and onTimeout ran first', async () => {
  const order = []
  await assert.rejects(within(new Promise(() => {}), 30, 'the proxy reply', () => order.push('onTimeout')), (e) => { order.push('rejected'); return /^Error: the proxy reply: no answer within 30 ms$/.test(String(e)) })
  assert.deepEqual(order, ['onTimeout', 'rejected'])
  await assert.rejects(within(new Promise(() => {}), 10, 'x', () => { throw new Error('the cleanup threw') }), /no answer within 10 ms/, 'a throwing cleanup does not hide the timeout')
})

test('within: a settled wait leaves no timer behind (the process is not held for the bound)', async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  for (let i = 0; i < 20; i++) await within(Promise.resolve(i), 60_000, 'x')
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, before)
})

test('onceWithin: an event that never comes destroys the socket it was waited on and names the event; one that comes is returned', async (t) => {
  const srv = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => c.write('pong')) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close())
  const c = net.connect(srv.address().port, '127.0.0.1'); await onceWithin(c, 'connect')
  c.write('ping')
  const [d] = await onceWithin(c, 'data'); assert.equal(String(d), 'pong')
  await assert.rejects(onceWithin(c, 'end', 50), /^Error: waiting for 'end': no answer within 50 ms$/)
  assert.equal(c.destroyed, true, 'the socket the wait was on is destroyed, so nothing holds an engine flow open for it')
})

test('closeWithin: an engine with a flow still open fails the close and says what it waited on; once the flow ends the close goes through', { timeout: 20_000 }, async (t) => {
  const up = net.createServer((s) => { s.on('error', () => {}); s.resume() }) // neither answers nor hangs up: the flow stays in flight
  await new Promise((r) => up.listen(0, '127.0.0.1', r)); t.after(() => up.close())
  const engine = createEngine({ redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 1, agent: 'x', decrypt: false }),
    issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} } })
  const { port } = await engine.listen({})
  const c = net.connect(port, '127.0.0.1'); c.on('error', () => {}); await onceWithin(c, 'connect'); c.write('ping')
  await new Promise((r) => setTimeout(r, 100))
  await assert.rejects(closeWithin(engine, 150), /^Error: engine\.close\(\) \(a flow or a client socket is still open\): no answer within 150 ms$/)
  c.destroy() // the client lets go: the flow ends, and the close that was parked on it is no longer needed
  await closeWithin(engine, 5000)
  assert.equal(engine.stats().active, 0)
  await assert.rejects(closeWithin({ close: () => new Promise(() => {}) }, 20, 'a stand-in that never closes'), /^Error: a stand-in that never closes: no answer within 20 ms$/)
  await assert.rejects(closeWithin({ close: () => { throw new Error('its own') } }, 1000), /^Error: its own$/, 'a close that throws is its own rejection')
})
