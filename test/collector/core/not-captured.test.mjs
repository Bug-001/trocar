// not-captured.test.mjs — RFC 4.6 §记录 (D38) · acceptance F2 (engine half): every connection row whose
// bytes did not go into an envelope carries a not_captured code from the closed set, one row per
// connection, with the expected code per path (连接行怎么落码). Also T-5: the 5 s first-byte valve ends
// at the first byte — a slow upstream TLS handshake or proxy reply is recorded (upstream-slow), never cut.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'; import tls from 'node:tls'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { handleFlow } from '../../../src/collector/core/engine/flow.mjs'
import { createNegativeCache } from '../../../src/collector/core/engine/negcache.mjs'
import { NOT_CAPTURED, ENGINE_EVENTS, isNotCapturedCode } from '../../../src/collector/core/engine/codes.mjs'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { EventEmitter } from 'node:events'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTrustChecker } from '../../../src/collector/core/trust/confirm.mjs'
import { createTracker } from '../../../src/collector/core/tracker.mjs'

const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
const asightCa = createCa(); const issuer = createLeafIssuer(loadCa(asightCa))
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REQ = 'POST /v1/messages HTTP/1.1\r\nHost: upstream.test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'
const RESP = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'

// One engine in front of `upstream`; ctx overrides (policy, timers) per case. settled() = every flow written.
async function rig(upstream, { meta = {}, ...over } = {}) {
  const upPort = await listen(upstream)
  const flows = [], failures = [], done = []
  const ctx = { issuer, upstreamCa: upCa.certPem, policy: () => true, isRecording: () => true, negCache: createNegativeCache(), newFlowId: () => 'f' + done.length,
    counters: { notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }, failure: (r) => failures.push(r),
    store: { envelope: () => true, flow: (f) => { flows.push(structuredClone(f)); return true } },
    connectUpstream: (dst) => net.connect(dst.port, dst.address), ...over }
  const engine = net.createServer((c) => done.push(handleFlow(c, { dst: { address: '127.0.0.1', port: upPort, family: 4 }, pid: 1, agent: 't', decrypt: true, ...meta }, ctx)))
  const port = await listen(engine)
  return { port, flows, failures, settled: () => Promise.all(done), close: async () => { await Promise.all(done); engine.close(); upstream.close() } }
}
const tlsUp = (alpn = ['http/1.1']) => tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: alpn }, (s) => { s.on('error', () => {}); s.on('data', () => s.end(RESP)) })
const sink = () => net.createServer((s) => { s.on('error', () => {}); s.resume(); s.on('end', () => s.end()) })
const tlsTalk = (port, opts = {}) => new Promise((resolve) => {
  const c = tls.connect({ port, host: '127.0.0.1', servername: 'upstream.test', ca: [upCa.certPem, asightCa.certPem], ALPNProtocols: ['http/1.1'], ...opts }, () => c.write(REQ))
  let got = ''; c.on('data', (d) => { got += d }); c.on('error', () => {}); c.on('close', () => resolve(got))
})
const rawTalk = (port, bytes, { end = true } = {}) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => { if (bytes) c.write(bytes); if (end) setTimeout(() => c.end(), 50) })
  let got = Buffer.alloc(0); c.on('data', (d) => { got = Buffer.concat([got, d]) }); c.on('error', () => {}); c.on('close', () => resolve(got))
})

// Every engine failure record carries a code from the closed event set (RFC 4.6 §记录 事件行, D38).
const assertEvents = (fs) => { for (const f of fs) assert.ok(ENGINE_EVENTS.includes(f.code) && typeof f.reason === 'string', `${f.code} is not an engine event code, or has no reason`) }

// The §记录 criterion, as the board's scan will apply it: a row the bytes missed has a closed code.
function assertCriterion(rows) {
  for (const r of rows) {
    const captured = r.decision === 'decrypt' || (r.decision === 'tunnel' && r.inner === 'decrypt')
    if (!captured || r.reason === 'client-rejected-leaf') assert.ok(isNotCapturedCode(r.not_captured), `row ${JSON.stringify(r)} needs a closed not_captured`)
    if (r.not_captured != null) assert.ok(isNotCapturedCode(r.not_captured), `${r.not_captured} is not in the closed set`)
  }
}

const cases = [
  ['untrusted (TLS)', () => tlsUp(), { meta: { decrypt: false } }, (p) => tlsTalk(p), ['splice', 'untrusted']],
  ['untrusted (plain HTTP)', () => sink(), { meta: { decrypt: false } }, (p) => rawTalk(p, REQ), ['splice', 'untrusted']],
  ['malformed ClientHello', () => sink(), {}, (p) => rawTalk(p, Buffer.from([0x16, 3, 1, 0, 4, 2, 0, 0, 0])), ['splice', 'malformed-hello']],
  ['outside the decrypt policy (TLS)', () => tlsUp(), { policy: () => false }, (p) => tlsTalk(p), ['splice', 'policy']],
  ['outside the decrypt policy (plain HTTP)', () => sink(), { policy: () => false }, (p) => rawTalk(p, REQ), ['splice', 'policy']],
  ['the daemon says not-trust-path', () => tlsUp(), { policy: () => ({ not_captured: 'not-trust-path', reason: 'declared' }) }, (p) => tlsTalk(p), ['splice', 'not-trust-path', 'declared']],
  ['an unknown code from the policy is just policy', () => tlsUp(), { policy: () => ({ not_captured: 'made-up' }) }, (p) => tlsTalk(p), ['splice', 'policy']],
  ['the daemon no longer holds the pid (untracked)', () => tlsUp(), { policy: () => ({ not_captured: 'untracked' }) }, (p) => tlsTalk(p), ['splice', 'untracked']],
  ['an untrusted process: the resolver\'s reason from the daemon', () => tlsUp(), { meta: { decrypt: false }, policy: () => ({ not_captured: 'untrusted', reason: 'settings shadowed' }) }, (p) => tlsTalk(p), ['splice', 'untrusted', 'settings shadowed']],
  ['an untrusted process the daemon no longer holds', () => sink(), { meta: { decrypt: false }, policy: () => ({ not_captured: 'untracked' }) }, (p) => rawTalk(p, REQ), ['splice', 'untracked']],
  ['an untrusted process whose policy() throws: still untrusted, the throw recorded', () => tlsUp(), { meta: { decrypt: false }, policy: () => { throw new Error('boom') } }, (p) => tlsTalk(p), ['splice', 'untrusted'], (r, h) => assert.deepEqual(h.failures.map((f) => [f.code, f.flow_id, /policy threw: boom/.test(f.reason)]), [['engine-error', r.flow_id, true]])],
  ['only h2', () => tlsUp(['h2']), {}, (p) => tlsTalk(p, { ALPNProtocols: ['h2'] }), ['splice', 'h2', 'alpn-h2-only']],
  ['an ALPN offer with neither h2 nor http/1.1', () => tlsUp(['x-other']), {}, (p) => tlsTalk(p, { ALPNProtocols: ['x-other'] }), ['splice', 'unknown-protocol', 'alpn x-other']],
  ['the upstream speaks first', () => net.createServer((s) => { s.on('error', () => {}); s.end('SSH-2.0-banner\r\n') }), {}, (p) => rawTalk(p, null, { end: false }), ['splice', 'upstream-first']],
  ['an unknown first byte', () => sink(), {}, (p) => rawTalk(p, 'SSH-2.0-client\r\n'), ['splice', 'unknown-protocol', 'first-byte 0x53']],
  ['CONNECT refused by the proxy', () => net.createServer((c) => c.once('data', () => c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'))), {}, (p) => rawTalk(p, 'CONNECT x.test:443 HTTP/1.1\r\n\r\n', { end: false }), ['tunnel', 'proxy-refused', 'proxy-status-407']],
  ['closed before a routing decision', () => sink(), {}, (p) => rawTalk(p, null), ['error', 'error'], (r) => assert.deepEqual([r.error.type, r.error.side], ['closed_before_decision', 'client'])],
  ['nobody speaks: first-byte timeout', () => sink(), { firstByteTimeoutMs: 50 }, (p) => rawTalk(p, null, { end: false }), ['error', 'error'], (r) => assert.equal(r.error.type, 'first_byte_timeout')],
]
for (const [name, up, opts, drive, [decision, code, reason], more] of cases) {
  test(`not_captured: ${name} → ${code} (D38 · F2)`, async () => {
    const h = await rig(up(), opts)
    await drive(h.port); await h.close()
    assert.equal(h.flows.length, 1, 'exactly one connection row')
    const [r] = h.flows
    assert.deepEqual([r.decision, r.not_captured], [decision, code]); if (reason) assert.equal(r.reason, reason)
    assert.equal(NOT_CAPTURED.failure.includes(code) || NOT_CAPTURED.expected.includes(code), true)
    if (more) more(r, h)
    assertCriterion(h.flows); assertEvents(h.failures)
  })
}

// Review B-4(a) (4.6 子进程与嵌套 agent): who started this agent is on every connection row of it, so the board can mark a
// nested agent; a process nobody launched an agent for has no parent_agent (not null noise), and no engine meta, no field.
test('a connection row carries parent_pid and parent_agent of the process that started its agent (B-4a)', async () => {
  const rows = []
  for (const meta of [{ parentPid: 4100, parentAgent: 'claude-code' }, { parentPid: 1, parentAgent: null }, {}]) {
    const h = await rig(tlsUp(), { meta, policy: () => false })
    await tlsTalk(h.port); await h.close()
    rows.push(h.flows[0])
  }
  assert.deepEqual(rows.map((r) => [r.parent_pid ?? null, r.parent_agent ?? null, 'parent_agent' in r]), [[4100, 'claude-code', true], [1, null, false], [null, null, false]])
})

// Review B-3 (缺接线): the tracker said "false" for a host a harness declares not via the trust path, and the engine wrote
// `policy` — while every test of the engine stubbed the object form and every test of the tracker asserted the bare false, so
// both halves were green and the code 4.6 §记录 names was never produced. This one runs the daemon's own wiring: the real
// tracker's policy() as the engine's policy, one row per host of ONE trusted process.
test('not_captured: a host the harness declares not via the trust path is not-trust-path with the harness\'s reason; the same process\'s other host outside the policy is policy (tracker → engine, B-3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-nc-')); const pem = path.join(dir, 'asight.pem'); fs.writeFileSync(pem, asightCa.certPem)
  try {
    const redirector = Object.assign(new EventEmitter(), { watch: async () => {}, unwatch: async () => {}, scan: async () => [] })
    const gamma = { name: 'gamma', runtime: 'node', hosts: ['api.gamma.test'], signatures: { linux: { match: [{ exe: /\/gamma$/ }] } }, trust: { chain: [{ var: 'EXTRA_CA', semantic: 'append' }] },
      bypass: () => [{ host: 'upstream.test', reason: 'ws-path' }] }
    const tracker = createTracker({ redirector, registry: createRegistry([gamma]), trust: createTrustChecker({ caCertPem: asightCa.certPem }), home: dir, onError: (e) => { throw e }, alive: () => false })
    tracker.start()
    redirector.emit('exec', { os: 'linux', pid: 7, ppid: 1, uid: 1000, exe: '/opt/gamma', argv: ['gamma'], env: new Map([['EXTRA_CA', pem]]), cwd: '/', source: 'exec', startedAt: 0 })
    await sleep(20)
    assert.equal(tracker.describe(7).trusted, true, 'a trusted process')
    const rows = []
    for (const servername of ['upstream.test', 'other.test']) {
      const h = await rig(tlsUp(), { meta: { pid: 7, agent: 'gamma' }, policy: (m, host) => tracker.policy(m, host) })
      await tlsTalk(h.port, { servername }); await h.close()
      rows.push(...h.flows); assertCriterion(h.flows)
    }
    assert.deepEqual(rows.map((r) => [r.decision, r.not_captured, r.reason ?? null]), [['splice', 'not-trust-path', 'ws-path'], ['splice', 'policy', null]])
    assert.equal(NOT_CAPTURED.expected.includes('not-trust-path'), true, 'an expected code: counted and listed, never ⚠')
    tracker.stop()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a CONNECT tunnel row: decision tunnel, the tunnelled decision in inner, reason left for the why (D38)', async () => {
  const origin = tlsUp(); const originPort = await listen(origin)
  const proxy = () => net.createServer((c) => c.once('data', () => { const o = net.connect(originPort, '127.0.0.1', () => { c.write('HTTP/1.1 200 OK\r\n\r\n'); c.pipe(o); o.pipe(c) }); o.on('error', () => c.destroy()); c.on('error', () => o.destroy()) }))
  for (const [policy, inner, code] of [[() => true, 'decrypt', undefined], [() => false, 'splice', 'policy']]) {
    const h = await rig(proxy(), { policy })
    await new Promise((resolve) => {
      const raw = net.connect(h.port, '127.0.0.1', () => raw.write('CONNECT upstream.test:443 HTTP/1.1\r\n\r\n'))
      raw.once('data', () => { const t = tls.connect({ socket: raw, servername: 'upstream.test', ca: [upCa.certPem, asightCa.certPem] }, () => t.write(REQ)); t.on('error', () => {}); t.on('close', resolve); t.resume() })
      raw.on('error', () => {})
    })
    await h.close()
    assert.deepEqual([h.flows[0].decision, h.flows[0].inner, h.flows[0].not_captured, h.flows[0].reason], ['tunnel', inner, code, null], 'reason no longer carries the inner decision')
    assertCriterion(h.flows)
  }
  origin.close()
})

// T-5 (AGENT-BREAK before): the first-byte valve used to keep running through our upstream TLS handshake
// and the proxy's CONNECT reply, so a slow upstream cut the agent with first_byte_timeout.
test('a slow upstream TLS handshake is waited for, not cut: the agent gets its reply; upstream-slow is recorded (D38 T-5)', async () => {
  const origin = tlsUp(); const originPort = await listen(origin)
  // a hop that holds the origin's first flight (its ServerHello) for 300 ms
  const slow = net.createServer((c) => { const o = net.connect(originPort, '127.0.0.1'); let first = true
    o.on('data', (d) => { if (first) { first = false; o.pause(); setTimeout(() => { c.write(d); o.resume() }, 300) } else c.write(d) })
    c.on('data', (d) => o.write(d)); c.on('end', () => o.end()); o.on('end', () => c.end()); c.on('error', () => o.destroy()); o.on('error', () => c.destroy()) })
  const h = await rig(slow, { firstByteTimeoutMs: 50, upstreamSlowMs: 100 })
  const got = await tlsTalk(h.port)
  await h.close(); origin.close()
  assert.equal(got, RESP, 'the agent was not cut while the engine waited on its upstream')
  assert.deepEqual([h.flows[0].decision, h.flows[0].error], ['decrypt', undefined])
  assert.deepEqual(h.failures.map((f) => [f.code, f.flow_id, f.phase, f.host, f.waited_ms >= 100]), [['upstream-slow', h.flows[0].flow_id, 'tls', 'upstream.test', true]]); assertEvents(h.failures)
})

test('a slow proxy reply to CONNECT is waited for, not cut; relayed verbatim when it comes (D38 T-5)', async () => {
  const reply = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'
  const h = await rig(net.createServer((c) => c.once('data', () => setTimeout(() => c.end(reply), 300))), { firstByteTimeoutMs: 50, upstreamSlowMs: 100 })
  const got = await rawTalk(h.port, 'CONNECT x.test:443 HTTP/1.1\r\n\r\n', { end: false })
  await h.close()
  assert.equal(got.toString(), reply)
  assert.deepEqual([h.flows[0].decision, h.flows[0].not_captured], ['tunnel', 'proxy-refused'])
  assert.deepEqual(h.failures.map((f) => [f.code, f.phase]), [['upstream-slow', 'proxy-reply']])
})

test('a fast upstream writes no upstream-slow event', async () => {
  const h = await rig(tlsUp(), { upstreamSlowMs: 2000 })
  assert.equal(await tlsTalk(h.port), RESP)
  await h.close(); await sleep(20)
  assert.deepEqual(h.failures, [])
})

// The flows/ row of a DECRYPTED connection: envelopes the store did not write (write_failed) and a 101 after
// which nothing is framed (upgrade-not-followed) are said on the row itself (RFC 4.6 §记录, D38 T-13 / T-15).
test('a decrypted row counts envelopes the store did not write; a non-WebSocket 101 marks it upgrade-not-followed', async () => {
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, (s) => {
    s.on('error', () => {}); let n = 0
    s.on('data', (d) => { if (/Upgrade: h2c/.test(d)) s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\nPRI-bytes'); else if (++n) s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok') })
  })
  const h = await rig(up, { store: { envelope: () => false, flow: (f) => { h.flows.push(structuredClone(f)); return true } } })
  await new Promise((resolve) => {
    const c = tls.connect({ port: h.port, host: '127.0.0.1', servername: 'upstream.test', ca: asightCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write('GET /a HTTP/1.1\r\nHost: upstream.test\r\n\r\n'))
    let got = ''
    c.on('data', (d) => { got += d; if (got.endsWith('ok')) { got = ''; c.write('GET /b HTTP/1.1\r\nHost: upstream.test\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n') } else if (got.includes('PRI-bytes')) c.end() })
    c.on('error', () => {}); c.on('close', resolve)
  })
  await h.close()
  const [r] = h.flows
  assert.deepEqual([r.decision, r.write_failed, r.not_captured, r.reason], ['decrypt', 2, 'upgrade-not-followed', '101 h2c'])
  assertCriterion(h.flows)
})

// Review finding (stage A): with the first-byte valve gone, a client that gives up (FIN) while the engine
// waits on a silent upstream's TLS handshake must still end the flow — a paused socket never reports 'end'.
test('a client that gives up while the upstream never answers our TLS handshake ends the flow: one error row, nothing hangs', async () => {
  const hello = await new Promise((resolve) => {
    const srv = net.createServer((s) => s.once('data', (d) => { resolve(d); s.destroy(); srv.close() }))
    srv.listen(0, '127.0.0.1', () => tls.connect({ port: srv.address().port, host: '127.0.0.1', servername: 'upstream.test', ALPNProtocols: ['http/1.1'] }).on('error', () => {}))
  })
  const h = await rig(net.createServer((s) => { s.on('error', () => {}); s.resume() }), { firstByteTimeoutMs: 50, upstreamSlowMs: 10000 }) // accepts, never answers
  // a TLS client that times out says close_notify, then FIN: those alert bytes sit in a paused socket's buffer,
  // and a paused socket with buffered bytes never emits 'end'
  const c = net.connect(h.port, '127.0.0.1', () => { c.write(hello); setTimeout(() => c.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x01, 0x00])), 150) })
  c.on('error', () => {})
  try {
    for (let i = 0; h.flows.length === 0; i++) { if (i > 300) throw new Error('the flow never finished: the client FIN went unseen'); await sleep(10) }
  } finally { c.destroy() }
  await h.close()
  assert.deepEqual([h.flows.length, h.flows[0].decision, h.flows[0].not_captured, h.flows[0].error.type, h.flows[0].error.side], [1, 'error', 'error', 'closed_before_decision', 'client'])
})

test('a decrypted row whose response could not be framed says framer_error (the rest is not recorded) (D38 review A)', async () => {
  const bad = 'HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\nxyz'
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, (s) => { s.on('error', () => {}); s.on('data', () => s.end(bad)) })
  const h = await rig(up)
  assert.equal(await tlsTalk(h.port), bad, 'the bytes still reach the agent verbatim')
  await h.close()
  assert.deepEqual([h.flows[0].decision, h.flows[0].framer_error], ['decrypt', { side: 'response', message: 'bad content-length' }])
  assert.deepEqual(h.failures.map((f) => [f.code, f.side]), [['framer-error', 'response']]); assertEvents(h.failures)
})
