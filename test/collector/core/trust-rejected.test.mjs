// test/collector/core/trust-rejected.test.mjs — RFC 4.6 R9 (D51④): a decrypted connection whose client refuses trocar's leaf is a
// critical failure `trust-rejected` with its fields, one per (pid, host) and never folded; the daemon's failure recorder also tells
// stderr; capture health and `status --json` put it first. A real engine and real TLS: the client trusts another CA only.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import tls from 'node:tls'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { appendEvent, createFailureRecorder } from '../../../src/collector/core/events.mjs'
import { captureHealth } from '../../../src/health/read.mjs'
import { LEVELS, UNFOLDED_CODES, CODES } from '../../../src/health/codes.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { closeWithin } from '../../helpers/bounded.mjs'
import { sandbox } from '../../cli/fixtures/dispatch-ctx.mjs'
import { failureWord } from '../../../src/cli/words.mjs'

const T = { timeout: 20_000 }
const TRUST = { var: 'NODE_EXTRA_CA_CERTS', via: 'environ', file: '/home/u/.trocar/ca/extra-dsh.pem' }

test('4.6 R9: a client that refuses trocar\'s leaf → one critical trust-rejected per (pid, host), fields complete, stderr told; capture health and status --json put it first', T, async () => {
  assert.deepEqual(LEVELS, ['critical'])
  assert.ok(UNFOLDED_CODES.includes('trust-rejected') && CODES.includes('trust-rejected'))
  const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.end('x')) })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const meta = { dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 5, agent: 'deepseek-dsh', decrypt: true, door: 'g-dsh', negKey: '5', exe: '/usr/local/bin/dsh', argv: ['dsh', 'chat'], trust: TRUST }
  const redirector = createStaticRedirector(meta)
  const home = tmpDir('trocar-trust-rejected-'); const dir = path.join(home, 'collector')
  const logged = []
  const recorder = createFailureRecorder(dir, { log: (where, e) => logged.push(`[${where}] ${e.message}`) })
  appendEvent(dir, { event: 'daemon-start', pid: process.pid, reason: 'test' })
  const fails = [], flows = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), upstreamCa: upCa.certPem, store: { envelope() {}, flow: (f) => flows.push(f) },
    onFailure: (f) => { fails.push(f); recorder.event(f) } })
  const { port } = await engine.listen({})
  const hello = (servername) => new Promise((resolve) => {
    const c = tls.connect({ port, host: '127.0.0.1', servername, ca: upCa.certPem }, () => { c.end(); resolve('accepted') })
    c.on('error', () => resolve('rejected'))
  })
  const settled = (n) => new Promise((r) => { const t = setInterval(() => { if (flows.length >= n) { clearInterval(t); r() } }, 5) })
  assert.equal(await hello('api.deepseek.com'), 'rejected'); await settled(1)
  assert.equal(await hello('api.deepseek.com'), 'rejected'); await settled(2)
  const tr = fails.filter((f) => f.code === 'trust-rejected')
  assert.equal(tr.length, 1, 'the same (pid, host) refused twice: one record')
  const r = tr[0]
  assert.deepEqual({ event: r.event, where: r.where, level: r.level, harness: r.harness, door: r.door, process: r.process, pid: r.pid, host: r.host, trust_entry: r.trust_entry },
    { event: 'failure', where: 'engine', level: 'critical', harness: 'deepseek-dsh', door: 'g-dsh', process: 'dsh', pid: 5, host: 'api.deepseek.com', trust_entry: TRUST })
  assert.equal(r.alert, flows[0].error.type, 'alert = the connection row\'s client-side error type')
  assert.equal(typeof r.reason, 'string')
  assert.doesNotMatch(JSON.stringify(r), /BEGIN CERTIFICATE/, 'no certificate content in the record')
  assert.deepEqual(logged.filter((l) => l.startsWith('[critical]')), [`[critical] trust-rejected harness=deepseek-dsh pid=5 host=api.deepseek.com: ${r.reason}`], 'one stderr line')
  // another host of the same pid is its own record
  assert.equal(await hello('chat.deepseek.com'), 'rejected'); await settled(3)
  assert.deepEqual(fails.filter((f) => f.code === 'trust-rejected').map((f) => f.host), ['api.deepseek.com', 'chat.deepseek.com'])
  recorder.flush()

  // capture health: the critical conditions first, with `level`
  const health = captureHealth({ home })
  const conds = health.collector.conditions
  assert.deepEqual(conds.slice(0, 2).map((c) => [c.kind, c.level, c.host]), [['trust-rejected', 'critical', 'api.deepseek.com'], ['trust-rejected', 'critical', 'chat.deepseek.com']])
  assert.ok(conds.some((c) => c.kind === 'negative-cache'), 'the negative cache\'s own condition is still there, after them')
  assert.deepEqual(conds[0].trust_entry, TRUST); assert.equal(conds[0].door, 'g-dsh'); assert.equal(conds[0].process, 'dsh')

  // the process exits: forgetPid ends the pairs (negative-cache-cleared), so a reused pid that refuses again is recorded again
  assert.equal(engine.forgetPid(5), 2, 'the negative entry of api.deepseek.com + the record-only chat.deepseek.com')
  assert.equal(await hello('chat.deepseek.com'), 'rejected'); await settled(4)
  assert.equal(fails.filter((f) => f.code === 'trust-rejected').length, 3)
  await closeWithin(engine); up.close()

  // status --json: the same critical conditions, first and with `level`
  const s = sandbox()
  const res = await s.run(['status', '--json'], { deps: { captureHealth: () => health } })
  const doc = res.io.json()
  assert.deepEqual(doc.critical.map((c) => [c.kind, c.level, c.harness, c.pid, c.host]), [['trust-rejected', 'critical', 'deepseek-dsh', 5, 'api.deepseek.com'], ['trust-rejected', 'critical', 'deepseek-dsh', 5, 'chat.deepseek.com']])
  const text = (await s.run(['status', '--failures'], { deps: { captureHealth: () => health } })).io.stdoutText()
  // the critical kind first, in English (the summary's own layout is §3.5's, guarded by test/cli/status-doctor-en.test.mjs; this sandbox has nothing installed, so the summary says so)
  // a row is its first line and the lines folded under it (§1.1⑥); the sentence is the catalog's (words.mjs)
  const rows = text.split('\n').reduce((acc, l) => { if (/^ {2}\S/.test(l)) acc.push(l); else if (/^ {3,}\S/.test(l) && acc.length) acc[acc.length - 1] += ` ${l.trim()}`; return acc }, []).map((r) => r.replace(/\s+/g, ' '))
  assert.ok(rows[0].includes(failureWord(null, 'trust-rejected')), text)
  assert.ok(rows.length > 1, `the other condition is listed too:\n${text}`)
})

// ── RFC 4.6 §引擎 5 (D37) rejection criterion: a client refuses our leaf in the handshake or at once after it; a trusting client's
// connection kept past the window and closed unused (a pooled socket timing out) is no rejection, and acceptance
// counts the moment it is seen. Real engine, real TLS; the window is shortened through the engine's timing seam.
const W = 300
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function windowRig() {
  const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')) })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const trocarCa = createCa()
  const meta = { dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 7, agent: 'claude-code', decrypt: true, door: 'g', negKey: '7', exe: '/x/claude', argv: ['claude'] }
  const fails = [], flows = []
  const engine = createEngine({ redirector: createStaticRedirector(meta), issuer: createLeafIssuer(loadCa(trocarCa)), upstreamCa: upCa.certPem, systemCa: { certs: [], sources: ['test'], errors: [] },
    store: { envelope() {}, flow: (f) => flows.push(f) }, onFailure: (f) => fails.push(f), timing: { rejectWindowMs: W } })
  const { port } = await engine.listen({})
  const settled = (n) => new Promise((r) => { const t = setInterval(() => { if (flows.length >= n) { clearInterval(t); r() } }, 5) })
  const connect = (ca, maxVersion) => new Promise((resolve) => { const c = tls.connect({ port, host: '127.0.0.1', servername: 'h.test', ca, maxVersion }, () => resolve(c)); c.on('error', () => resolve(null)) })
  const unused = async (idleMs) => { const c = await connect(trocarCa.certPem); await sleep(idleMs); c.end(); await new Promise((r) => c.once('close', r)) }
  const rejecting = (maxVersion = 'TLSv1.3') => connect(upCa.certPem, maxVersion) // Node: handshake, check, destroy — no alert
  const used = async () => { const c = await connect(trocarCa.certPem); c.write('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n'); await new Promise((r) => c.once('data', r)); return c }
  const rejections = () => fails.filter((f) => f.code === 'trust-rejected' || f.code === 'negative-cache')
  return { engine, fails, flows, settled, unused, rejecting, used, rejections, close: async () => { await closeWithin(engine); up.close() } }
}

test('4.6 §引擎 5: a trusting client\'s connection kept past the window and closed unused is no rejection — no critical, no strike, no not_captured', T, async () => {
  const s = await windowRig()
  await s.unused(2 * W); await s.settled(1); await s.unused(2 * W); await s.settled(2)
  assert.deepEqual(s.flows.map((f) => [f.decision, f.not_captured ?? null, f.reason ?? null, f.error ?? null]), [['decrypt', null, null, null], ['decrypt', null, null, null]])
  assert.deepEqual(s.rejections(), [])
  assert.deepEqual(s.engine.negatives(), [])
  await s.close()
})

for (const v of ['TLSv1.2', 'TLSv1.3']) {
  test(`4.6 §引擎 5: a Node client that refuses the leaf (${v}, no alert) is judged at once under the window — critical on the first, negative on the second`, T, async () => {
    const s = await windowRig()
    await s.rejecting(v); await s.settled(1); await s.rejecting(v); await s.settled(2)
    assert.deepEqual(s.flows.map((f) => [f.decision, f.not_captured]), [['decrypt', 'client-rejected-leaf'], ['decrypt', 'client-rejected-leaf']])
    assert.equal(s.fails.filter((f) => f.code === 'trust-rejected').length, 1)
    assert.deepEqual(s.engine.negatives().map((e) => [e.host, e.cause, e.rejections]), [['h.test', 'client-rejected-leaf', 2]])
    await s.close()
  })
}

test('4.6 §引擎 5: acceptance counts when it is seen — rejected, data on a connection still open, rejected → not negative', T, async () => {
  const s = await windowRig()
  await s.rejecting(); await s.settled(1)
  const open = await s.used()
  await s.rejecting(); await s.settled(2)
  assert.deepEqual(s.engine.negatives(), [], 'the open connection that carried data reset the count before the second rejection')
  open.end(); await s.settled(3)
  await s.close()
})

test('4.6 §引擎 5: a connection still open when the window elapses counts as acceptance at that moment', T, async () => {
  const s = await windowRig()
  await s.rejecting(); await s.settled(1)
  const pending = s.unused(10 * W) // accepted at W, closes at 10 W
  await sleep(2 * W)
  await s.rejecting(); await s.settled(2)
  assert.deepEqual(s.engine.negatives(), [])
  await pending; await s.settled(3)
  assert.equal(s.flows[2].not_captured, undefined, 'the unused connection that closed after the window is no failure')
  await s.close()
})
