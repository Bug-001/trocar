// test/collector/core/tracker.test.mjs — acceptance T7 (unit), S3 (unit), decrypt policy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTrustChecker } from '../../../src/collector/core/trust/confirm.mjs'
import { createTracker } from '../../../src/collector/core/tracker.mjs'

const ca = createCa()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-trk-'))
const PEM = path.join(dir, 'asight.pem'); fs.writeFileSync(PEM, ca.certPem)
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

const agent = {
  name: 'alpha', runtime: 'node', hosts: ['api.alpha.test', '.alpha-cdn.test'],
  signatures: { linux: { match: [{ exe: /\/alpha$/ }] } },
  configHosts: (ctx) => [ctx.env.get('ALPHA_BASE_URL')].filter(Boolean).map((u) => new URL(u).hostname),
  trust: { chain: [{ var: 'EXTRA_CA', semantic: 'append' }] },
}
function fakeRedirector() {
  const r = new EventEmitter()
  r.watched = new Map(); r.calls = []; r.live = []
  r.watch = async (pid, v) => { r.calls.push(['watch', pid, v.decrypt]); r.watched.set(pid, v) }
  r.unwatch = async (pid) => { r.calls.push(['unwatch', pid]); r.watched.delete(pid) }
  r.scan = async () => r.live
  return r
}
const facts = (pid, o = {}) => ({ os: 'linux', pid, ppid: 1, uid: 1000, exe: '/opt/alpha', argv: ['alpha'], env: new Map(), cwd: '/', source: 'exec', startedAt: 0, ...o })
function rig(descriptors = [agent]) {
  const redirector = fakeRedirector()
  const errors = []
  const tracker = createTracker({ redirector, registry: createRegistry(descriptors), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir, onError: (e, at) => errors.push([at.pid, at.phase, e.message]) })
  tracker.start()
  return { redirector, tracker, errors }
}
const settle = () => new Promise((r) => setImmediate(r))

test('tracker: same program — no CA variable → observe verdict; CA variable → decrypt verdict (T7)', async () => {
  const { redirector, tracker } = rig()
  redirector.emit('exec', facts(100)); await settle()
  redirector.emit('exec', facts(101, { env: new Map([['EXTRA_CA', PEM]]) })); await settle()
  assert.deepEqual(redirector.calls, [['watch', 100, false], ['watch', 101, true]])
  const [a, b] = tracker.agents()
  assert.deepEqual([a.trusted, a.reason, b.trusted, b.reason, b.trustVar], [false, 'var-missing', true, 'ok', 'EXTRA_CA'])
  assert.deepEqual(tracker.metaFor(101), { agent: 'alpha', exe: '/opt/alpha' })
})

test('tracker: a process no descriptor matches is never watched (S3); re-exec into a non-agent unwatches', async () => {
  const { redirector, tracker } = rig()
  redirector.emit('exec', facts(200, { exe: '/usr/bin/curl', argv: ['curl'] })); await settle()
  assert.deepEqual(redirector.calls, [])
  redirector.emit('exec', facts(201)); await settle()
  redirector.emit('exec', facts(201, { exe: '/usr/bin/env', argv: ['env'] })); await settle()
  assert.deepEqual(redirector.calls, [['watch', 201, false], ['unwatch', 201]])
  assert.equal(tracker.agents().length, 0)
})

test('tracker: judgement is by the process itself — a non-agent child of an agent is not watched', async () => {
  const { redirector } = rig()
  redirector.emit('exec', facts(400, { env: new Map([['EXTRA_CA', PEM]]) })); await settle()
  redirector.emit('exec', facts(401, { ppid: 400, exe: '/usr/bin/node', argv: ['node', 'mcp-server.js'] })); await settle()
  assert.equal(redirector.watched.has(401), false)
})

test('tracker: policy = known hosts ∪ config hosts ∪ operator hosts, or all; untrusted and unknown processes never', async () => {
  const { redirector, tracker } = rig()
  redirector.emit('exec', facts(500, { env: new Map([['EXTRA_CA', PEM], ['ALPHA_BASE_URL', 'https://Relay.Example.com/v1']]) })); await settle()
  redirector.emit('exec', facts(501)); await settle()
  for (const h of ['api.alpha.test', 'eu.alpha-cdn.test', 'relay.example.com']) assert.equal(tracker.policy({ pid: 500 }, h), true, h)
  for (const h of ['registry.npmjs.org', 'alpha-cdn.test']) assert.equal(tracker.policy({ pid: 500 }, h), false, h)
  assert.equal(tracker.policy({ pid: 501 }, 'api.alpha.test'), false)
  assert.equal(tracker.policy({ pid: 999 }, 'api.alpha.test'), false)
  tracker.setPolicy({ mode: 'auto', extraHosts: ['Registry.npmjs.org'] })
  assert.equal(tracker.policy({ pid: 500 }, 'registry.npmjs.org'), true)
  tracker.setPolicy({ mode: 'all' })
  assert.equal(tracker.policy({ pid: 500 }, 'anything.example'), true)
  assert.equal(tracker.policy({ pid: 501 }, 'anything.example'), false, 'all never covers an untrusted process')
})

test('tracker: exit forgets; rescan re-judges live processes and drops vanished ones', async () => {
  const { redirector, tracker } = rig()
  redirector.emit('exec', facts(600)); redirector.emit('exec', facts(601)); await settle()
  redirector.emit('exit', { pid: 600 }); await settle()
  assert.deepEqual(tracker.agents().map((a) => a.pid), [601])
  redirector.live = [facts(602, { source: 'scan', env: new Map([['EXTRA_CA', PEM]]) })]
  await tracker.rescan()
  assert.deepEqual(tracker.agents().map((a) => [a.pid, a.source, a.decrypt]), [[602, 'scan', true]])
})

test('tracker: a descriptor callback that throws degrades to known hosts, never breaks the table', async () => {
  const broken = { ...agent, configHosts: () => { throw new Error('bad config') } }
  const { redirector, tracker } = rig([broken])
  redirector.emit('exec', facts(700, { env: new Map([['EXTRA_CA', PEM]]) })); await settle()
  assert.deepEqual(tracker.describe(700).hosts, ['api.alpha.test', '.alpha-cdn.test'])
  assert.equal(tracker.describe(700).configError, 'bad config')
})

test('tracker: an error judging a process reaches onError with its pid; it is left unwatched and the rest carries on (D38, review 2 #4)', async () => {
  const thrower = { ...agent, trust: { ...agent.trust, refine: () => { throw new Error('refine blew up') } } } // runs only for an untrusted verdict
  const { redirector, tracker, errors } = rig([thrower])
  const withCa = { env: new Map([['EXTRA_CA', PEM]]) }
  redirector.emit('exec', facts(800)); await settle()
  assert.deepEqual(errors, [[800, 'judge', 'refine blew up']])
  assert.equal(tracker.describe(800), null)
  assert.ok(!redirector.watched.has(800), 'never watched')
  // a trusted pid re-execs into a judgement that throws: its earlier verdict must not outlive it
  redirector.emit('exec', facts(801, withCa)); await settle()
  assert.equal(redirector.watched.get(801).decrypt, true)
  redirector.emit('exec', facts(801)); await settle()
  assert.deepEqual([tracker.describe(801), redirector.watched.has(801), errors[1]], [null, false, [801, 'judge', 'refine blew up']])
  // rescan: one process that throws never blocks the others (or `on`)
  redirector.live = [facts(802, { source: 'scan' }), facts(803, { source: 'scan', ...withCa })]
  await tracker.rescan()
  assert.deepEqual([tracker.agents().map((a) => a.pid), errors[2]], [[803], [802, 'judge', 'refine blew up']])
  // an unwatch the helper refuses is reported too, not dropped
  redirector.unwatch = async () => { throw new Error('the redirector helper is down') }
  redirector.emit('exit', { pid: 803 }); await settle()
  assert.deepEqual(errors[3], [803, 'unwatch', 'the redirector helper is down'])
})

test('tracker: a layer read only at start is judged against installedAt when asight wrote its value, else its mtime (review 2 #5)', async () => {
  const layered = { ...agent, layers: () => [{ name: 'cfg', file: '/h/cfg.json', mode: 'override', vars: { EXTRA_CA: PEM }, live: false, mtimeMs: 5_000 }] }
  const seen = []
  const make = (installedAt) => createTracker({ redirector: fakeRedirector(), registry: createRegistry([layered]), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir, installedAt })
  const byMtime = make(undefined)
  assert.deepEqual([(await byMtime.onExec(facts(900, { startedAt: 3_000 }))).trusted, byMtime.describe(900).reason], [false, 'config-after-start'])
  const byInstall = make((l) => { seen.push(l.file); return 2_000 })
  assert.equal((await byInstall.onExec(facts(901, { startedAt: 3_000 }))).trusted, true, 'asight wrote this value before the process started; the later edit was something else')
  assert.deepEqual(seen, ['/h/cfg.json'])
  assert.equal((await byInstall.onExec(facts(902, { startedAt: null }))).reason, 'start-time-unknown')
})
