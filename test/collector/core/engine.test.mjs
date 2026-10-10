import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { closeWithin } from '../../helpers/bounded.mjs'

// A wait that never ends parks the file under --test-force-exit: every test has a deadline, and engine.close() (which waits for
// every flow still open and never destroys one) a bound that says what it waited for (test/helpers/bounded.mjs).
const T = { timeout: 20_000 }

test('engine: lookup miss closes the socket; a known flow is spliced to its destination; stats count both', T, async () => {
  const echo = net.createServer((s) => s.pipe(s)); await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector()
  const failures = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} }, onFailure: (f) => failures.push(f) })
  const { port } = await engine.listen({})
  let missPort = 0
  const miss = await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { missPort = c.localPort }); c.on('close', () => r(true)); c.on('error', () => {}) })
  assert.equal(miss, true)
  // the agent's connection was closed: not silent (D38) — a failure event names the peer
  assert.deepEqual(failures.map((f) => [f.event, f.where, f.code, f.peer.port, typeof f.reason]), [['failure', 'engine', 'lookup-miss', missPort, 'string']])
  redirector.set = redirector.set // static redirector keyed by client port: register on connect
  const echoed = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    c.on('connect', () => { redirector.set(c.localPort, { dst: { address: '127.0.0.1', port: echo.address().port, family: 4 }, pid: 1, agent: 'x', decrypt: false }); c.write('ping') })
    c.on('data', (d) => { resolve(d.toString()); c.end() })
  })
  assert.equal(echoed, 'ping')
  await closeWithin(engine); echo.close()
  const s = engine.stats(); assert.equal(s.lookupMisses, 1); assert.equal(s.total, 2)
})

test('engine: a connection that closes before speaking is finalized, not leaked, and close() never hangs', T, async () => {
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

test('engine: a client that resets while its redirector lookup is pending does not crash the engine; the flow is finalized', T, async () => {
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

// RFC 4.6 §引擎 5 · W9 (D37): the negative cache is per (pid, host) and only ever means "splice this host".
// The kernel can only stop steering a whole process, so the engine never tells the redirector: the hosts
// the same process does trust keep being decrypted. forgetPid (the process exited) clears the pid.
test('engine: two consecutive rejections on one host splice that host only; another host of the same pid is still decrypted; the redirector is never told; forgetPid clears the pid (§引擎 5 · W9)', T, async () => {
  const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.end('x')) })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 5, agent: 'dsh', decrypt: true })
  const told = []; for (const m of ['watch', 'unwatch', 'detach']) redirector[m] = async (...a) => { told.push([m, ...a]) }
  const asightCa = createCa(); const flows = [], fails = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: upCa.certPem, store: { envelope() {}, flow: (f) => flows.push(f) }, onFailure: (f) => fails.push(f) })
  const { port } = await engine.listen({})
  const hello = (servername, ca) => new Promise((resolve) => {
    const c = tls.connect({ port, host: '127.0.0.1', servername, ca }, () => { const issuer = c.getPeerX509Certificate().issuer; c.on('end', () => resolve(issuer)); c.resume(); c.write('x') })
    c.on('error', () => resolve('rejected'))
  })
  const settled = (n) => new Promise((r) => { const t = setInterval(() => { if (flows.length >= n) { clearInterval(t); r() } }, 5) })
  assert.equal(await hello('api.deepseek.com', upCa.certPem), 'rejected'); await settled(1)
  assert.equal(await hello('api.deepseek.com', upCa.certPem), 'rejected'); await settled(2)
  assert.deepEqual(engine.negatives().map((e) => [e.pid, e.agent, e.host, e.cause, e.rejections]), [[5, 'dsh', 'api.deepseek.com', 'client-rejected-leaf', 2]])
  assert.deepEqual(fails.map((f) => [f.where, f.code, f.pid, f.host, f.cause]), [['engine', 'negative-cache', 5, 'api.deepseek.com', 'client-rejected-leaf']], 'the write is a failure event, once (D-12)')
  assert.deepEqual([fails[0].neg_key, engine.negatives()[0].negKey], ['5', '5'], 'keyed by the pid: neg_key is "<pid>" (4.8 §5.5)')
  assert.match(await hello('api.deepseek.com', upCa.certPem), /upstream test CA/, 'the rejected host is spliced')
  assert.match(await hello('chat.deepseek.com', asightCa.certPem), /asight collector CA/, 'another host of the same pid is still decrypted')
  // the process exits: the daemon calls forgetPid, so a reused pid starts clean
  assert.equal(engine.forgetPid(5), 1); assert.deepEqual(engine.negatives(), [])
  assert.match(await hello('api.deepseek.com', asightCa.certPem), /asight collector CA/, 'decrypted again after forgetPid')
  await closeWithin(engine); up.close()
  assert.deepEqual(told, [], 'kernel steering is never touched')
  const by = (h) => flows.filter((f) => f.host === h).map((f) => [f.decision, f.not_captured ?? null])
  assert.deepEqual(by('api.deepseek.com'), [['decrypt', 'client-rejected-leaf'], ['decrypt', 'client-rejected-leaf'], ['splice', 'negative-cache'], ['decrypt', null]])
  assert.deepEqual(by('chat.deepseek.com'), [['decrypt', null]])
  assert.deepEqual(engine.stats().notCaptured, { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 1, leafError: 0 })
})

// D38: asight's own failures are recorded and cost the agent one connection at most, never the collector.
test('engine: connectUpstream throwing (e.g. a bad destination port) is an engine-error record, the socket is closed, the engine lives on (D38)', T, async () => {
  const failures = [], errors = [], flows = []
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: 1, family: 4 }, pid: 1, agent: 'x', decrypt: false })
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), connectUpstream: () => { throw new RangeError('bad port') },
    store: { envelope() {}, flow: (f) => flows.push(f) }, onFailure: (f) => failures.push(f), onError: (e) => errors.push(e.message) })
  const { port } = await engine.listen({})
  for (let i = 0; i < 2; i++) await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', r); c.on('error', () => {}) })
  await closeWithin(engine)
  assert.deepEqual(failures.map((f) => [f.code, f.flow_id, f.reason]), [['engine-error', 'flow_000001', 'bad port'], ['engine-error', 'flow_000002', 'bad port']])
  assert.deepEqual(flows.map((f) => [f.flow_id, f.decision, f.error.type, f.error.side]), [['flow_000001', 'error', 'engine_error', 'engine'], ['flow_000002', 'error', 'engine_error', 'engine']])
  assert.equal(engine.stats().active, 0)
})

test('engine: a flows/ record that cannot be written is a flow-write-failed failure record (D38)', T, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { createRecordStore } = await import('../../../src/collector/core/record/store.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-flowfail-'))
  const flowsDir = path.join(root, 'flows')
  fs.mkdirSync(flowsDir); fs.mkdirSync(path.join(flowsDir, `${new Date().toISOString().slice(0, 10)}.ndjson`)) // the day's connection-row file is a directory
  const store = createRecordStore({ root })
  const failures = []
  const up = net.createServer((sk) => sk.end()); await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const engine = createEngine({ redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 2, agent: 'x', decrypt: false }), issuer: createLeafIssuer(loadCa(createCa())), store, onFailure: (f) => failures.push(f) })
  const { port } = await engine.listen({})
  await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', r); c.on('error', () => {}); c.resume() })
  await closeWithin(engine); up.close(); store.close()
  fs.rmSync(root, { recursive: true, force: true })
  assert.deepEqual(failures.map((l) => [l.where, l.code, l.flow_id, /EISDIR|illegal operation/.test(l.reason)]), [['engine', 'flow-write-failed', 'flow_000001', true]])
})

// Cross-guard: both halves of the merge survive — the failure record for a lookup miss (ws-recorder's side) AND
// the listener 'error' handler after listen (the daemon's side), each a failure record and an onError, never an
// uncaught exception. Dropping either half of a future conflict resolution turns this red.
test('engine: a lookup miss and a listener error after listen are failure records and reach onError, never an uncaught exception (D38)', T, async () => {
  const errors = [], failures = []
  const made = []; const orig = net.createServer
  net.createServer = (...a) => { const s = orig(...a); made.push(s); return s }
  let engine
  try {
    engine = createEngine({ redirector: createStaticRedirector(), issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} }, onFailure: (f) => failures.push(f), onError: (e) => errors.push(e) })
    const { port } = await engine.listen({})
    await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', r); c.on('error', () => {}) })
    made[0].emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))
    assert.deepEqual(errors.map((e) => e.code), ['lookup-miss', 'EMFILE'])
    assert.match(errors[0].message, /no original destination for 127\.0\.0\.1:\d+; the steered connection was closed/)
    assert.deepEqual(failures.map((f) => [f.where, f.code, f.peer ? f.peer.address : null]), [['engine', 'lookup-miss', '127.0.0.1'], ['engine', 'EMFILE', null]])
    assert.match(failures[1].reason, /the engine's listener on 127\.0\.0\.1: accept EMFILE/)
  } finally { net.createServer = orig; if (engine) await closeWithin(engine) }
})

// The daemon's onError AND the failure record, under the same code: loader-down / loader-timeout, never lookup-miss.
test('engine: a lookup the helper cannot answer is its own failure (not a miss), and the connection is closed (D38)', { timeout: 10_000 }, async () => {
  const errors = [], failures = []
  let fail = new Error('redirector loader is not running')
  const engine = createEngine({ redirector: { lookup: async () => { throw fail } }, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} }, onFailure: (f) => failures.push(f), onError: (e) => errors.push(e) })
  try {
    const { port } = await engine.listen({})
    await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', r); c.on('error', () => {}) })
    assert.deepEqual(errors.map((e) => e.code), ['loader-down'], 'one record, not also a lookup-miss')
    assert.match(errors[0].message, /looking up the original destination of 127\.0\.0\.1:\d+ failed \(redirector loader is not running\); the steered connection was closed/)
    assert.equal(engine.stats().lookupMisses, 0)
    assert.deepEqual(failures.map((f) => [f.code, f.peer.address, /redirector loader is not running/.test(f.reason)]), [['loader-down', '127.0.0.1', true]])
    fail = Object.assign(new Error('no answer from the helper in 2000 ms'), { code: 'loader-timeout' })
    await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', r); c.on('error', () => {}) })
    assert.deepEqual(failures.map((f) => f.code), ['loader-down', 'loader-timeout'])
  } finally { await closeWithin(engine) }
})

test('engine: a lookup that timed out is loader-timeout; the helper\'s own errno stays in the error text (D38)', { timeout: 10_000 }, async () => {
  const failures = []
  for (const e of [Object.assign(new Error('no answer in 2000 ms'), { code: 'loader-timeout' }), Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })]) {
    const engine = createEngine({ redirector: { lookup: async () => { throw e } }, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} }, onFailure: (f) => failures.push(f) })
    const { port } = await engine.listen({})
    await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('close', r); c.on('error', () => {}) })
    await closeWithin(engine)
  }
  assert.deepEqual(failures.map((f) => [f.code, /\(([^)]*)\); the steered/.exec(f.reason)[1]]), [['loader-timeout', 'no answer in 2000 ms'], ['loader-down', 'EPIPE: write EPIPE']])
})
