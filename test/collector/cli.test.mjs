// test/collector/cli.test.mjs — `asight collector` verbs over injected daemon / install modules, and the real bin.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCollector, runSetupHelper, formatStatus } from '../../src/collector/cli.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const io = () => { const o = []; const e = []; return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) } }
const STATUS = { desired: 'on', actual: 'on', recording: true, degraded: null, engine: { port: 4711, v6: 4711, decrypted: 2, spliced: 1 }, helper: { pid: 9, proto: 1, ok: true }, running_untrusted: 1,
  agents: [{ pid: 10, agent: 'claude-code', trusted: true, trust_var: 'NODE_EXTRA_CA_CERTS', trust_via: 'user settings env', direct: 0 }, { pid: 11, agent: 'claude-code', trusted: false, reason: 'var-missing', direct: 2 }] }

test('cli: on/off/status go to the control socket; exit 1 when the kernel did not reach the asked state; 3 with no daemon; 2 without XDG_RUNTIME_DIR', async () => {
  const calls = []
  const request = async (q) => { calls.push([q.method, q.path, q.socketPath]); return q.path === '/off' ? { ...STATUS, desired: 'off', actual: 'on' } : STATUS }
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
  let t = io(); assert.equal(await runCollector(['on'], { env, request, ...t }), 0)
  t = io(); assert.equal(await runCollector(['off'], { env, request, ...t }), 1)
  t = io(); assert.equal(await runCollector(['status'], { env, request, ...t }), 0)
  assert.deepEqual(calls, [['POST', '/on', '/run/user/1000/asight/collector.sock'], ['POST', '/off', '/run/user/1000/asight/collector.sock'], ['GET', '/status', '/run/user/1000/asight/collector.sock']])
  assert.match(t.o[0], /2 decrypted/); assert.match(t.o[0], /untrusted: var-missing · 2 direct/)
  t = io(); assert.equal(await runCollector(['status'], { env, request: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, ...t }), 3)
  t = io(); assert.equal(await runCollector(['status'], { env: {}, request, ...t }), 2)
  t = io(); assert.equal(await runCollector(['bogus'], { env, request, ...t }), 2)
})

test('cli: install / uninstall hand the descriptors, OS and process table from daemon.loadParts to install.mjs', async () => {
  const seen = []
  const parts = { os: 'linux', harnesses: [{ name: 'h' }], scan: async () => [], match: () => ({ agent: null }) }
  const daemon = { loadParts: async () => parts }
  const install = {
    installCollector: async (o) => {
      seen.push(['install', o.osName, o.harnesses, o.scan === parts.scan, o.home])
      o.onPlan({ ca: ['/h/.asight/collector/ca/ca.key', '/h/.asight/collector/ca/asight-ca.pem'], files: [{ harness: 'h', path: '/h/.asight/collector/ca/extra-h.pem', sources: ['/corp/ca.pem'] }], entries: [{ harness: 'h', path: '/h/s.json', keys: ['env', 'K'], value: '/h/.asight/collector/ca/extra-h.pem' }] })
      seen.push(['written'])
      return { manifest: { engine_port: 4711, entries: [{ harness: 'h', path: '/h/s.json', keys: ['env', 'K'], value: '/h/.asight/collector/ca/extra-h.pem', prior_value: '/old.pem' }] }, plan: { notes: ['n'] } }
    },
    uninstallCollector: async (o) => { seen.push(['uninstall', o.purgeData]); return { daemon: 'stopped', kept_captures: !o.purgeData, entries: [{ harness: 'h', path: '/h/s.json', result: 'restored' }], still_trusting: [{ pid: 7, agent: 'h' }], notes: [] } },
  }
  let t = io(); assert.equal(await runCollector(['install'], { home: '/h', daemon, install, ...t }), 0)
  assert.equal(t.o.length, 2, 'the file list, then the result')
  assert.match(t.o[0], /^asight collector install will write or change these files, and nothing else:/, 'the list comes first, before anything is written (4.6)')
  assert.match(t.o[0], /collector CA \(in no trust store\): \/h\/.asight\/collector\/ca\/ca.key, \/h\/.asight\/collector\/ca\/asight-ca.pem/)
  assert.match(t.o[0], /h: \/h\/.asight\/collector\/ca\/extra-h.pem = the certificates of \/corp\/ca.pem \+ the collector CA/, 'whose certificates the trust file carries (G8 merge path)')
  assert.match(t.o[0], /h: \/h\/s.json env.K = \/h\/.asight\/collector\/ca\/extra-h.pem/)
  assert.match(t.o[1], /^installed for .*: engine port 4711\n  h: \/h\/s.json env.K was \/old.pem\nnote: n$/)
  t = io(); assert.equal(await runCollector(['uninstall', '--purge-data'], { daemon, install, ...t }), 0)
  assert.match(t.o[0], /captures removed/); assert.match(t.o[0], /pid 7 \(h\) trusts the asight CA until it restarts/)
  assert.deepEqual(seen, [['install', 'linux', parts.harnesses, true, '/h'], ['written'], ['uninstall', true]])
  t = io(); assert.equal(await runCollector(['install'], { daemon, install: { installCollector: async () => { throw new Error('boom') } }, ...t }), 1)
})

test('cli: setup-helper installs or removes through arch; a failure is exit 1', async () => {
  const done = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/asight/asight-redirector' }, setupHelper: (o) => { done.push(o.binarySrc); return { bin: '/b', getcap: 'caps' } }, uninstallHelper: () => ({ warnings: [] }) } }
  let t = io(); assert.equal(await runSetupHelper(['--binary', '/tmp/h'], { arch, ...t }), 0)
  t = io(); assert.equal(await runSetupHelper(['--remove'], { arch, ...t }), 0)
  assert.deepEqual(done, ['/tmp/h'])
  t = io(); assert.equal(await runSetupHelper([], { arch: { install: { setupHelper: () => { throw new Error('must run as root') } } }, ...t }), 1)
  assert.deepEqual(t.e, ['must run as root'])
})

test('cli: the real bin dispatches `collector` (usage → 2) and `collector status` without a runtime dir (→ 2)', () => {
  const env = { ...process.env }; delete env.XDG_RUNTIME_DIR
  assert.equal(spawnSync(process.execPath, [BIN, 'collector', 'nope'], { env, encoding: 'utf8' }).status, 2)
  const r = spawnSync(process.execPath, [BIN, 'collector', 'status'], { env, encoding: 'utf8' })
  assert.equal(r.status, 2); assert.match(r.stderr, /XDG_RUNTIME_DIR is not set/)
  assert.ok(formatStatus({ ...STATUS, agents: [] }).includes('agents: none running'))
  assert.ok(path.isAbsolute(BIN))
})
