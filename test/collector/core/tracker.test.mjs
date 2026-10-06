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
import { createTracker, watchDirNames, toProxyEntry } from '../../../src/collector/core/tracker.mjs'

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
function rig(descriptors = [agent], o = {}) {
  const redirector = fakeRedirector()
  const errors = []
  const tracker = createTracker({ redirector, registry: createRegistry(descriptors), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir, onError: (e, at) => errors.push([at.pid, at.phase, e.message]), alive: () => false, ...o })
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
  assert.deepEqual(tracker.metaFor(101), { agent: 'alpha', exe: '/opt/alpha', parentPid: 1, parentAgent: null })
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

// A plugin harness (D37④): trust only through the per-pid marker its plugin writes (4.6 「标记」).
const plugged = { ...agent, name: 'beta', hosts: ['api.beta.test'], signatures: { linux: { match: [{ exe: /\/beta$/ }], longLived: [{ argv: [/^serve$/] }] } },
  trust: { chain: [{ var: 'EXTRA_CA', semantic: 'append' }, { var: 'asight:marker', semantic: 'append' }], refine: (r) => (r.reason === 'var-missing' ? 'no-marker' : null) } }
function markerRig(o = {}) {
  const markerDir = fs.mkdtempSync(path.join(dir, 'run-trust-'))
  const redirector = fakeRedirector()
  let onName = null; const timers = []; let clock = 1_000_000
  const tracker = createTracker({ redirector, registry: createRegistry([agent, plugged]), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir,
    markerDir, caPem: PEM, watchDir: (d, cb) => { assert.equal(d, markerDir); onName = cb; return () => {} }, alive: () => false,
    now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }, ...o })
  tracker.start()
  return { redirector, tracker, markerDir, timers, tick: (ms) => { clock += ms }, appear: async (pid, ticks) => { fs.writeFileSync(path.join(markerDir, String(pid)), `${ticks}\n`); onName(String(pid)); await settle() }, get clock() { return clock } }
}

test('tracker: a plugin marker that appears after exec re-judges that process; until then it is marker-pending; one of another start time is marker-stale (4.6 「标记」, T12)', async () => {
  const r = markerRig()
  r.redirector.emit('exec', facts(800, { exe: '/opt/beta', argv: ['beta'], startTicks: '9001', startedAt: r.clock })); await settle()
  assert.deepEqual([r.tracker.describe(800).trusted, r.tracker.describe(800).reason], [false, 'marker-pending'])
  assert.equal(r.timers.length, 1, 'the end of the grace is scheduled once')
  await r.appear(800, 9000) // an earlier process with this pid
  assert.deepEqual([r.tracker.describe(800).trusted, r.tracker.describe(800).reason], [false, 'marker-stale'])
  await r.appear(800, 9001)
  assert.deepEqual([r.tracker.describe(800).trusted, r.tracker.describe(800).trustVia, r.tracker.describe(800).trustVar], [true, 'plugin marker', 'asight:marker'])
  assert.deepEqual(r.redirector.calls, [['watch', 800, false], ['watch', 800, false], ['watch', 800, true]])
  r.redirector.emit('exec', facts(801, { exe: '/opt/alpha', startTicks: '1', startedAt: r.clock })); await settle()
  fs.writeFileSync(path.join(r.markerDir, '801'), '1\n'); r.redirector.calls.length = 0; await r.appear(801, 1)
  assert.deepEqual([r.tracker.describe(801).trusted, r.tracker.describe(801).reason], [false, 'var-missing'], 'a harness without a plugin entry never trusts a marker')
  await r.appear(999, 5); await r.appear('junk.pem', 5)
  assert.deepEqual(r.redirector.calls.filter((c) => c[1] !== 801), [], 'markers of unknown pids and stray names change nothing')
  r.redirector.emit('exit', { pid: 800 }); await settle()
  assert.ok(!fs.existsSync(path.join(r.markerDir, '800')), 'the marker of an exited pid is removed')
})

test('tracker: no marker by the end of the grace → the harness reason (no-marker), judged by the scheduled re-judge; a CA file that lost the asight CA is not trusted by its marker', async () => {
  const r = markerRig()
  r.redirector.emit('exec', facts(810, { exe: '/opt/beta', argv: ['beta'], startTicks: '7', startedAt: r.clock })); await settle()
  assert.equal(r.tracker.describe(810).reason, 'marker-pending')
  r.tick(10_001)
  r.timers[0].fn(); await settle()
  assert.deepEqual([r.tracker.describe(810).trusted, r.tracker.describe(810).reason], [false, 'no-marker'])
  r.redirector.emit('exec', facts(811, { exe: '/opt/beta', argv: ['beta'], startTicks: '8', startedAt: r.clock - 60_000 })); await settle()
  assert.equal(r.tracker.describe(811).reason, 'no-marker', 'a process found long after its start is not pending')
  const other = createCa(); const foreign = path.join(dir, 'foreign.pem'); fs.writeFileSync(foreign, other.certPem)
  const r2 = markerRig({ caPem: foreign })
  r2.redirector.emit('exec', facts(812, { exe: '/opt/beta', argv: ['beta'], startTicks: '9', startedAt: r2.clock })); await settle()
  await r2.appear(812, 9)
  assert.deepEqual([r2.tracker.describe(812).trusted, r2.tracker.describe(812).reason], [false, 'ca-not-in-file'], 'trust is confirmed by fingerprint, never by the marker alone')
})

test('tracker: hosts a harness declares as not via the trust path are never decrypted, under all and operator hosts too (4.6 不经信任路径, T12)', async () => {
  const gamma = { ...agent, name: 'gamma', signatures: { linux: { match: [{ exe: /\/gamma$/ }] } },
    bypass: (ctx) => [{ host: 'models.alpha.test', reason: 'before-plugin' }, ...(ctx.env.get('ALPHA_WS') ? [{ host: 'api.alpha.test', reason: 'ws-path' }] : [])] }
  const { redirector, tracker } = rig([gamma])
  redirector.emit('exec', facts(600, { exe: '/opt/gamma', env: new Map([['EXTRA_CA', PEM]]) }))
  redirector.emit('exec', facts(601, { exe: '/opt/gamma', env: new Map([['EXTRA_CA', PEM], ['ALPHA_WS', '1']]) })); await settle()
  assert.equal(tracker.policy({ pid: 600 }, 'api.alpha.test'), true)
  assert.equal(tracker.policy({ pid: 601 }, 'api.alpha.test'), false, 'the ws path shares the API host: passthrough for that process only')
  tracker.setPolicy({ mode: 'all', extraHosts: ['models.alpha.test'] })
  assert.equal(tracker.policy({ pid: 600 }, 'models.alpha.test'), false, 'all and operator hosts do not override it')
  assert.equal(tracker.policy({ pid: 600 }, 'anything.example'), true)
  assert.deepEqual(tracker.agents().find((x) => x.pid === 601).bypass, [{ host: 'models.alpha.test', reason: 'before-plugin' }, { host: 'api.alpha.test', reason: 'ws-path' }])
})

test('tracker: extrasFor hands the engine this process\'s own proxies and the harness WebSocket terminators (plan 3c describe, 4.6 §引擎 3)', async () => {
  const delta = { ...agent, name: 'delta', signatures: { linux: { match: [{ exe: /\/delta$/ }] } },
    proxies: (ctx) => ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].filter((k) => ctx.env.get(k)).map((k) => ({ url: ctx.env.get(k), source: `env:${k}` })),
    wsTerminal: [{ pathSuffix: '/ws', patterns: ['^\\{"done"'] }] }
  const { redirector, tracker } = rig([delta, agent])
  const env = new Map([['EXTRA_CA', PEM], ['HTTPS_PROXY', 'https://user:secret@Proxy.Example.com:8443'], ['HTTP_PROXY', 'plain-proxy.example.com:3128'], ['ALL_PROXY', 'ftp://x']])
  redirector.emit('exec', facts(550, { exe: '/opt/delta', env }))
  redirector.emit('exec', facts(551, { env: new Map([['EXTRA_CA', PEM], ['HTTPS_PROXY', 'https://p.example.com']]) })); await settle()
  assert.deepEqual(tracker.extrasFor(550), {
    wsTerminal: [{ pathSuffix: '/ws', patterns: ['^\\{"done"'] }],
    proxies: [
      { scheme: 'https', host: 'proxy.example.com', port: 8443, own: true, source: 'env:HTTPS_PROXY' }, // no credentials
      { scheme: 'http', host: 'plain-proxy.example.com', port: 3128, own: true, source: 'env:HTTP_PROXY' },
    ],
  })
  assert.deepEqual(tracker.extrasFor(551), { wsTerminal: null, proxies: [] }, 'a harness that declares no proxy reader hands none over')
  assert.deepEqual([tracker.extrasFor(null), tracker.extrasFor(9999)], [{}, {}])
  // its proxies are not decrypt hosts: the engine's proxy path decides from FlowExtras (4.6 §引擎 3, plan 3c-7)
  assert.deepEqual(['proxy.example.com', 'plain-proxy.example.com'].map((h) => tracker.policy({ pid: 550 }, h)), [false, false])
  assert.deepEqual(toProxyEntry({ url: 'socks5h://[::1]:1080', source: 's' }), { scheme: 'socks5h', host: '::1', port: 1080, own: true, source: 's' })
  assert.deepEqual([toProxyEntry({ url: 'socks://127.0.0.1', source: 's' }).scheme, toProxyEntry({ url: 'https://h', source: 's' }).port], ['socks5', 443])
  assert.deepEqual([toProxyEntry({ url: 'ftp://x', source: 's' }), toProxyEntry({ url: 'http://', source: 's' })], [null, null])
})

test('tracker: a long-lived process missing the variable is env-frozen; a config file that exists but cannot be read is reported, not taken for absent (D38)', async () => {
  const r = markerRig()
  r.redirector.emit('exec', facts(820, { exe: '/opt/beta', argv: ['beta', 'serve'], startTicks: '1', startedAt: r.clock - 60_000 })); await settle()
  assert.equal(r.tracker.describe(820).reason, 'no-marker', 'a plugin harness says the marker, not env-frozen')
  r.redirector.emit('exec', facts(821, { exe: '/opt/alpha', argv: ['alpha'] })); await settle()
  const longLived = { ...agent, name: 'delta', signatures: { linux: { match: [{ exe: /\/delta$/ }], longLived: [{ argv: [/^serve$/] }] } },
    layers: (ctx) => [ctx.readText('/locked/.env'), ctx.readText('/absent/.env')].filter(Boolean).map(() => null) }
  const errs = []
  const t = createTracker({ redirector: fakeRedirector(), registry: createRegistry([longLived]), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir,
    readFile: (f) => { const e = new Error(f); e.code = f.startsWith('/locked') ? 'EACCES' : 'ENOENT'; throw e } })
  const row = await t.onExec(facts(822, { exe: '/opt/delta', argv: ['delta', 'serve'] }))
  assert.deepEqual([row.reason, row.readErrors], ['env-frozen', ['/locked/.env: EACCES']], errs.join())
})

test('tracker: rescan removes markers whose pid is gone', async () => {
  const r = markerRig()
  fs.writeFileSync(path.join(r.markerDir, '4242'), '1\n'); fs.writeFileSync(path.join(r.markerDir, 'notes.txt'), 'x')
  r.redirector.live = [facts(830, { exe: '/opt/beta', argv: ['beta'], startTicks: '3', source: 'scan', startedAt: r.clock })]
  fs.writeFileSync(path.join(r.markerDir, '830'), '3\n')
  await r.tracker.rescan()
  assert.deepEqual(fs.readdirSync(r.markerDir).sort(), ['830', 'notes.txt'])
  assert.equal(r.tracker.describe(830).trusted, true)
})

test('tracker: an agent that execs during a rescan (after its scan) keeps its row and its marker; an unlisted row judged before the rescan goes, even if its pid lives on as another user\'s process (review 3 #7, review 4 #8)', async () => {
  const living = new Set([840, 842]) // 842: reused by a process of another uid (signal 0 says EPERM: "alive")
  const r = markerRig({ alive: (pid) => living.has(pid) })
  r.redirector.emit('exec', facts(842, { exe: '/opt/beta', argv: ['beta'], startTicks: '7', startedAt: r.clock })); await settle()
  r.redirector.emit('exec', facts(841, { exe: '/opt/beta', argv: ['beta'], startTicks: '6', startedAt: r.clock })); await settle()
  await r.appear(841, 6) // 841 exits later, its exit event missed
  r.tick(1000)
  r.redirector.scan = async () => { // the snapshot is taken, then 840 execs and writes its marker before the rescan ends
    const snapshot = []
    r.tick(10); r.redirector.emit('exec', facts(840, { exe: '/opt/beta', argv: ['beta'], startTicks: '5', startedAt: r.clock })); await settle()
    await r.appear(840, 5)
    return snapshot
  }
  await r.tracker.rescan()
  assert.deepEqual([r.tracker.describe(840) && r.tracker.describe(840).trusted, r.tracker.describe(841), r.tracker.describe(842)], [true, null, null])
  assert.deepEqual(fs.readdirSync(r.markerDir), ['840'])
})

test('tracker: a marker-directory watcher that fails is reported, never swallowed (D38, review 3 #7)', () => {
  const markerDir = fs.mkdtempSync(path.join(dir, 'run-trust-'))
  const errors = []
  let fail = null
  const t = createTracker({ redirector: fakeRedirector(), registry: createRegistry([agent, plugged]), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir, markerDir, caPem: PEM,
    watchDir: (d, cb, onWatchError) => { fail = onWatchError; return () => {} }, onError: (e, at) => errors.push([at.pid, at.phase, e.message]) })
  t.start()
  fail(Object.assign(new Error('watch EMFILE'), { code: 'EMFILE' }))
  assert.deepEqual(errors, [[null, 'marker-watch', 'watch EMFILE']])
  t.stop()
})

test('tracker: the default marker watcher hands its error event on', async () => {
  const { EventEmitter } = await import('node:events')
  const w = Object.assign(new EventEmitter(), { close() {} })
  const got = []
  watchDirNames('/x', () => {}, (e) => got.push(e.message), () => w)
  w.emit('error', new Error('ENOSPC'))
  assert.deepEqual(got, ['ENOSPC'])
})

test('tracker: a harness\'s refine can read its own files through the tracker\'s reader and knows the collector dir and the exe (a launch shim lives there)', async () => {
  const shimmed = { ...agent, name: 'gamma', signatures: { linux: { match: [{ exe: /\/gamma$/ }] } },
    trust: { chain: [{ var: 'EXTRA_CA', semantic: 'append' }], refine: (r, env, { readText, collectorDir, exe }) => (r.reason !== 'var-missing' ? null : `${readText(path.join(collectorDir, 'bin', 'gamma')) == null ? 'no-shim' : 'not-via-shim'}@${exe}`) } }
  const cdir = fs.mkdtempSync(path.join(dir, 'collector-'))
  const redirector = fakeRedirector()
  const tracker = createTracker({ redirector, registry: createRegistry([shimmed]), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir, collectorDir: cdir })
  tracker.start()
  redirector.emit('exec', facts(900, { exe: '/opt/gamma', argv: ['gamma'] })); await settle()
  assert.equal(tracker.describe(900).reason, 'no-shim@/opt/gamma')
  fs.mkdirSync(path.join(cdir, 'bin')); fs.writeFileSync(path.join(cdir, 'bin', 'gamma'), '#!/bin/sh\n')
  redirector.emit('exec', facts(901, { exe: '/opt/gamma', argv: ['gamma'] })); await settle()
  assert.equal(tracker.describe(901).reason, 'not-via-shim@/opt/gamma')
})

test('tracker: a harness reports a config file that does not parse; the row carries it for the daemon (D38, review 3 #9)', async () => {
  const picky = { ...agent, name: 'eps', signatures: { linux: { match: [{ exe: /\/eps$/ }] } }, layers: (ctx) => { ctx.unparsable('/cfg/a.json'); ctx.unparsable('/cfg/a.json'); return [] } }
  const { redirector, tracker } = rig([picky])
  redirector.emit('exec', facts(850, { exe: '/opt/eps', argv: ['eps'] })); await settle()
  assert.deepEqual(tracker.describe(850).parseErrors, ['/cfg/a.json'])
  assert.deepEqual(tracker.agents()[0].parseErrors, ['/cfg/a.json'])
})
