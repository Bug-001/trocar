import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'

test('engine: lookup miss closes the socket; a known flow is spliced to its destination; stats count both', async () => {
  const echo = net.createServer((s) => s.pipe(s)); await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector()
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} } })
  const { port } = await engine.listen({})
  const miss = await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', () => r(true)); c.on('error', () => {}) })
  assert.equal(miss, true)
  redirector.set = redirector.set // static redirector keyed by client port: register on connect
  const echoed = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    c.on('connect', () => { redirector.set(c.localPort, { dst: { address: '127.0.0.1', port: echo.address().port, family: 4 }, pid: 1, agent: 'x', decrypt: false }); c.write('ping') })
    c.on('data', (d) => { resolve(d.toString()); c.end() })
  })
  assert.equal(echoed, 'ping')
  await engine.close(); echo.close()
  const s = engine.stats(); assert.equal(s.lookupMisses, 1); assert.equal(s.total, 2)
})

test('engine: a connection that closes before speaking is finalized, not leaked, and close() never hangs', async () => {
  const up = net.createServer((sk) => sk.resume()); await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 1, agent: 'x', decrypt: false })
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} } })
  const { port } = await engine.listen({})
  await new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => c.destroy()); c.on('close', resolve); c.on('error', () => {}) })
  // close() must resolve promptly: the pre-decision flow was finalized (not left pending forever)
  await Promise.race([engine.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('engine.close() hung on a leaked flow')), 2000))])
  up.close()
  assert.equal(engine.stats().active, 0)
})

test('engine: a client that resets while its redirector lookup is pending does not crash the engine; the flow is finalized', async () => {
  const up = net.createServer((sk) => { sk.on('error', () => {}); sk.resume() }); await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const meta = { dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 1, agent: 'x', decrypt: false }
  let lookupStarted, release
  const started = new Promise((r) => { lookupStarted = r }); const gate = new Promise((r) => { release = r })
  const redirector = { lookup: async () => { lookupStarted(); await gate; return meta } }
  const flows = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow: (f) => flows.push(f) } })
  const { port } = await engine.listen({})
  // Observe (not alter) the engine-side socket's 'error': it is the accepted socket whose peer is
  // our client. The lookup is held open until that error has been emitted, so the reset lands
  // inside the lookup window on every run.
  let clientPort = 0, sawError
  const errored = new Promise((r) => { sawError = r })
  const emit = net.Socket.prototype.emit
  net.Socket.prototype.emit = function (ev, ...a) { if (ev === 'error' && clientPort && this.remotePort === clientPort) sawError(a[0]); return emit.call(this, ev, ...a) }
  try {
    const c = net.connect(port, '127.0.0.1'); c.on('error', () => {})
    await new Promise((r) => c.once('connect', r)); clientPort = c.localPort
    await started
    c.resetAndDestroy()
    const err = await Promise.race([errored, new Promise((_, rej) => setTimeout(() => rej(new Error('engine-side socket never saw the reset')), 2000).unref())])
    assert.equal(err.code, 'ECONNRESET')
  } finally { net.Socket.prototype.emit = emit }
  release()
  await Promise.race([engine.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('engine.close() hung on a leaked flow')), 2000))])
  up.close()
  assert.equal(engine.stats().active, 0)
  assert.equal(flows.length, 1); assert.equal(flows[0].decision, 'error'); assert.equal(flows[0].error?.type, 'ECONNRESET')
})
