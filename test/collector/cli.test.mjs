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
  agents: [{ pid: 10, agent: 'claude-code', trusted: true, trust_var: 'NODE_EXTRA_CA_CERTS', trust_via: 'user settings env', direct: 0 }, { pid: 11, agent: 'claude-code', trusted: false, reason: 'var-missing', direct: 2 },
    { pid: 12, agent: 'opencode', parent_agent: 'claude-code', trusted: true, trust_var: 'asight:marker', trust_via: 'plugin marker', not_via_trust_path: [{ host: 'models.dev', reason: 'before-plugin' }], direct: 0 },
    { pid: 13, agent: 'deepseek-dsh', trusted: false, reason: 'dsh-node-too-old', hint: 'this dsh runs on a Node older than 22.19.0', direct: 1 }] }

test('cli: on/off/status go to the control socket; exit 1 when the kernel did not reach the asked state; 3 with no daemon; 2 without XDG_RUNTIME_DIR', async () => {
  const calls = []
  const request = async (q) => { calls.push([q.method, q.path, q.socketPath]); return q.path === '/off' ? { ...STATUS, desired: 'off', actual: 'on' } : STATUS }
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
  let t = io(); assert.equal(await runCollector(['on'], { env, request, ...t }), 0)
  t = io(); assert.equal(await runCollector(['off'], { env, request, ...t }), 1)
  t = io(); assert.equal(await runCollector(['status'], { env, request, ...t }), 0)
  assert.deepEqual(calls, [['POST', '/on', '/run/user/1000/asight/collector.sock'], ['POST', '/off', '/run/user/1000/asight/collector.sock'], ['GET', '/status', '/run/user/1000/asight/collector.sock']])
  assert.match(t.o[0], /2 decrypted/); assert.match(t.o[0], /untrusted: var-missing · 2 direct/)
  assert.match(t.o[0], /  12 opencode \(started by claude-code\) decrypt \(asight:marker via plugin marker\) · 0 direct\n    not captured \(not via the trust path\): models\.dev \(before-plugin\)/)
  assert.match(t.o[0], /  13 deepseek-dsh untrusted: dsh-node-too-old — this dsh runs on a Node older than 22\.19\.0 · 1 direct/)
  t = io(); assert.equal(await runCollector(['status'], { env, request: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, ...t }), 3)
  t = io(); assert.equal(await runCollector(['status'], { env: {}, request, ...t }), 2)
  t = io(); assert.equal(await runCollector(['bogus'], { env, request, ...t }), 2)
})

test('cli: install / uninstall hand the descriptors, OS and process table from daemon.loadParts to install.mjs', async () => {
  const seen = []
  const U = { UNIT_NAME: 'asight-collector.service', unitPath: (h) => `${h}/.config/systemd/user/asight-collector.service`, unitText: ({ node, script }) => `ExecStart="${node}" "${script}" collector start`, systemctl: () => ({ code: 0 }), removeWantsLinks: () => [] }
  const parts = { os: 'linux', osRootsFile: '/os/roots.pem', arch: { unit: U }, harnesses: [{ name: 'h' }], scan: async () => [], match: () => ({ agent: null }) }
  const daemon = { loadParts: async () => parts }
  const install = {
    installCollector: async (o) => {
      seen.push(['install', o.osName, o.harnesses, o.scan === parts.scan, o.home, o.osRootsFile, o.unit ? [o.unit.path, o.unit.text] : null])
      o.onPlan({ manifest: '/h/.asight/collector/install-manifest.json', ca: ['/h/.asight/collector/ca/ca.key', '/h/.asight/collector/ca/asight-ca.pem'], files: [{ harness: 'h', path: '/h/.asight/collector/ca/extra-h.pem', sources: ['/corp/ca.pem'] }], entries: [{ harness: 'h', path: '/h/s.json', real_path: '/dot/s.json', keys: ['env', 'K'], value: '/h/.asight/collector/ca/extra-h.pem' }] })
      seen.push(['written'])
      return { manifest: { engine_port: 4711, entries: [{ harness: 'h', path: '/h/s.json', keys: ['env', 'K'], value: '/h/.asight/collector/ca/extra-h.pem', prior_value: '/old.pem' }] }, plan: { notes: ['n'] } }
    },
    uninstallCollector: async (o) => { seen.push(['uninstall', o.purgeData, !!o.unit]); return { daemon: 'stopped', kept_captures: !o.purgeData, entries: [{ harness: 'h', path: '/h/s.json', result: 'restored' }], still_trusting: [{ pid: 7, agent: 'h' }], notes: [] } },
  }
  let t = io(); assert.equal(await runCollector(['install'], { home: '/h', daemon, install, script: '/repo/bin/asight.mjs', ...t }), 0)
  assert.equal(t.o.length, 2, 'the file list, then the result')
  assert.match(t.o[0], /^asight collector install will write or change these files, and nothing else:/, 'the list comes first, before anything is written (4.6)')
  assert.match(t.o[0], /collector CA \(in no trust store\): \/h\/.asight\/collector\/ca\/ca.key, \/h\/.asight\/collector\/ca\/asight-ca.pem/)
  assert.match(t.o[0], /h: \/h\/.asight\/collector\/ca\/extra-h.pem = the certificates of \/corp\/ca.pem \+ the collector CA/, 'whose certificates the trust file carries (G8 merge path)')
  assert.match(t.o[0], /h: \/h\/s.json → \/dot\/s.json env.K = \/h\/.asight\/collector\/ca\/extra-h.pem/, 'a link is shown with the file that actually changes')
  assert.match(t.o[0], /install manifest: \/h\/.asight\/collector\/install-manifest.json/)
  assert.match(t.o[1], /^installed for .*: engine port 4711\n  h: \/h\/s.json env.K was \/old.pem\nnote: n$/)
  t = io(); assert.equal(await runCollector(['uninstall', '--purge-data'], { daemon, install, ...t }), 0)
  assert.match(t.o[0], /captures removed/); assert.match(t.o[0], /pid 7 \(h\) trusts the asight CA until it restarts/)
  t = io(); assert.equal(await runCollector(['install', '--no-unit'], { home: '/h', daemon, install, ...t }), 0)
  assert.deepEqual(seen, [['install', 'linux', parts.harnesses, true, '/h', '/os/roots.pem', ['/h/.config/systemd/user/asight-collector.service', `ExecStart="${process.execPath}" "/repo/bin/asight.mjs" collector start`]], ['written'], ['uninstall', true, true], ['install', 'linux', parts.harnesses, true, '/h', '/os/roots.pem', null], ['written']])
  t = io(); assert.equal(await runCollector(['install'], { daemon, install: { installCollector: async () => { throw new Error('boom') } }, ...t }), 1)
  // an item uninstall could not undo: exit 1, the manifest keeps it, the user is told to run uninstall again (D38)
  const leftOne = { uninstallCollector: async (o) => { seen.push(['uninstall-opts', o.harnesses === parts.harnesses, o.osRootsFile]); return { daemon: 'none', kept_captures: true, entries: [{ harness: 'h', path: '/h/s.json', result: 'left-unparsable' }], residue: ['/h/.config/h/node_modules'], kept_bundles: [{ path: '/h/ca/combined-h.pem', pids: [5, 6] }], still_trusting: [{ pid: 5, agent: 'h', until: 'next-connection' }], notes: [], left: 1 } } }
  t = io(); assert.equal(await runCollector(['uninstall'], { daemon, install: leftOne, ...t }), 1)
  assert.deepEqual(seen.at(-1), ['uninstall-opts', true, '/os/roots.pem'], 'the descriptors and the OS roots reach uninstall step 2')
  assert.match(t.o[0], /left in place: \/h\/.config\/h\/node_modules/)
  assert.match(t.o[0], /kept \/h\/ca\/combined-h\.pem without the asight CA for pid 5, 6; run uninstall again once they exit/)
  assert.match(t.o[0], /pid 5 \(h\) trusts the asight CA until its next new connection/)
  assert.match(t.e[0], /1 item\(s\) could not be undone and stay in the install manifest; .* run uninstall again/)
  // the plan shows a text entry by what it adds, an owned file by its role, the event log, and what the agent may write
  const plan2 = { installCollector: async (o) => { o.onPlan({ manifest: '/m', ca: ['/k', '/c'], files: [], owned: [{ harness: 'd', path: '/h/.asight/collector/plugins/d/index.js', role: 'plugin' }], entries: [{ harness: 'd', path: '/h/.d/patch.yml', what: 'line "- insert: x"' }], records: '/h/.asight/collector/flows', watch: [{ harness: 'o', path: '/h/.config/o/node_modules', why: 'npm install' }] }); return { already: true } } }
  t = io(); assert.equal(await runCollector(['install'], { daemon, install: plan2, ...t }), 0)
  assert.match(t.o[0], /d: \/h\/.asight\/collector\/plugins\/d\/index.js \(asight's plugin\)\n  d: \/h\/.d\/patch.yml line "- insert: x"\n  install notes \(event log\): \/h\/.asight\/collector\/flows\/\n  o itself may write \/h\/.config\/o\/node_modules \(npm install\); uninstall reports it, never deletes it$/)
})

test('cli: setup-helper installs or removes through arch; a failure is exit 1', async () => {
  const done = []
  const arch = { install: { DEFAULTS: { helperBin: '/usr/local/libexec/asight/asight-redirector' }, setupHelper: (o) => { done.push(o.binarySrc); return { bin: '/b', getcap: 'caps' } }, uninstallHelper: () => ({ warnings: [] }) } }
  let t = io(); assert.equal(await runSetupHelper(['--binary', '/tmp/h'], { arch, ...t }), 0)
  t = io(); assert.equal(await runSetupHelper(['--remove'], { arch, ...t }), 0)
  assert.deepEqual(done, ['/tmp/h'])
  t = io(); assert.equal(await runSetupHelper([], { arch: { install: { setupHelper: () => { throw new Error('must run as root') } } }, ...t }), 1)
  assert.deepEqual(t.e, ['must run as root'])
  // a staged copy an interrupted setup-helper left is removed and said, by both directions (D38)
  const swept = { install: { DEFAULTS: arch.install.DEFAULTS, setupHelper: () => ({ bin: '/b', getcap: 'caps', swept: ['.asight-redirector.new.67915'] }), uninstallHelper: () => ({ warnings: ['removed 1 copy(ies) an interrupted setup-helper had staged: .asight-redirector.new.67915'] }) } }
  t = io(); await runSetupHelper([], { arch: swept, ...t })
  assert.match(t.o.join('\n'), /removed 1 copy\(ies\) an interrupted setup-helper had staged: \.asight-redirector\.new\.67915/)
  t = io(); await runSetupHelper(['--remove'], { arch: swept, ...t })
  assert.match(t.o.join('\n'), /warning: removed 1 copy\(ies\)/)
})

test('cli: the real bin dispatches `collector` (usage → 2) and `collector status` without a runtime dir (→ 2)', () => {
  const env = { ...process.env }; delete env.XDG_RUNTIME_DIR
  assert.equal(spawnSync(process.execPath, [BIN, 'collector', 'nope'], { env, encoding: 'utf8' }).status, 2)
  const r = spawnSync(process.execPath, [BIN, 'collector', 'status'], { env, encoding: 'utf8' })
  assert.equal(r.status, 2); assert.match(r.stderr, /XDG_RUNTIME_DIR is not set/)
  assert.ok(formatStatus({ ...STATUS, agents: [] }).includes('agents: none running'))
  const withFailures = formatStatus({ ...STATUS, failures: [{ ts: 'T1', event: 'agent-untrusted', pid: 11, agent: 'claude-code', code: 'config-after-start', reason: 'restart it' }, { ts: 'T2', event: 'failure', where: 'engine', reason: 'no original destination', suppressed: 3 }] })
  assert.match(withFailures, /recent failures \(2\):\n  T1 agent-untrusted pid 11 claude-code: config-after-start — restart it\n  T2 failure \(engine\): no original destination \(\+3 more\)$/, 'status prints the durable failure records (D38)')
  assert.ok(path.isAbsolute(BIN))
})
