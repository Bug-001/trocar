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
  const rows = text.split('\n').filter((l) => /^ {2}\S/.test(l))
  assert.match(rows[0], /refused trocar's certificate under TLS, so that host is not captured/, text)
  assert.ok(rows.length > 1, `the other condition is listed too:\n${text}`)
})
