// test/capture/legacy-ops.test.mjs — the old capture's set-up steps say when they fail (D38; RFC 4.1 「过渡期采集源的失败
// 也不静默」 落地细节 (5)–(8)): a LaunchAgent that does not load (L-7), a CA trust that is false or cannot be checked and
// a NODE_EXTRA_CA_CERTS that is not asight's (L-8), a CC-CLI settings file that cannot be parsed, a Desktop steer that
// goes missing or cannot be read (L-12), an uninstall that cannot revert it (L-11). Everything injected: no launchctl,
// no keychain, no real home.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getAutostartInstaller } from '../../src/capture/autostart.mjs'
import { installCaptureAgents } from '../../src/capture/capture-agents.mjs'
import { monitoringOn, monitoringStatus } from '../../src/capture/control.mjs'
import { createSteerWatch, uninstallSteer, legacyOffPending } from '../../src/capture/steer-watch.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const inSet = (recs) => { for (const r of recs) assert.deepEqual(checkRecord({ ts: 't', ...r }), [], JSON.stringify(r)) }
const fakeFs = () => { const files = new Map(); return { files, writeFileSync: (p, c) => files.set(p, c), existsSync: (p) => files.has(p), unlinkSync: (p) => files.delete(p), mkdirSync() {} } }
const launchctl = (fail) => (f, a) => { if (f === 'launchctl' && a[0] === fail) throw Object.assign(new Error('Command failed'), { stderr: Buffer.from(fail === 'load' ? 'Load failed: 5: Input/output error' : `Could not find service "${a[1]}" in domain for port`) }); return { status: 0 } }

test('L-7: launchctl load that throws, or a label not listed after load → {ok:false, loadError}; never {ok:true} with nothing running', () => {
  const a = getAutostartInstaller('darwin', { home: '/Users/x', run: launchctl('load'), fs: fakeFs() }).install({ programArguments: ['/n', '/a'] })
  assert.deepEqual([a.ok, /Load failed: 5: Input\/output error/.test(a.loadError)], [false, true])
  const b = getAutostartInstaller('darwin', { home: '/Users/x', run: launchctl('list'), fs: fakeFs() }).install({ label: 'com.asight.mitm', programArguments: ['/n', '/a'] })
  assert.deepEqual([b.ok, /returned, but com\.asight\.mitm is not loaded .*Could not find service/.test(b.loadError)], [false, true], 'launchctl load can exit 0 without loading')
  assert.equal(getAutostartInstaller('darwin', { home: '/Users/x', run: launchctl(null), fs: fakeFs() }).install({ programArguments: ['/n'] }).ok, true)
  const agents = installCaptureAgents({ caPath: '/ca.crt', out: '/o', asightBin: '/a', nodeBin: '/n', home: '/Users/x', autostart: getAutostartInstaller('darwin', { home: '/Users/x', run: launchctl('list'), fs: fakeFs() }) })
  assert.deepEqual([agents.ok, !!agents.mitm.loadError, !!agents.env.loadError], [false, true, true])
  // monitoringOn: not ok, and one line through the caller's onEvent
  const events = []
  const onboard = { atraceOn: () => ({ install: { ok: true } }), verifyUserTrustOnly: () => true }
  const settings = path.join(tmpDir('asight-lops-'), 'settings.json')
  const out = monitoringOn({ onboard, autostart: getAutostartInstaller('darwin', { home: '/Users/x', run: launchctl('load'), fs: fakeFs() }), settingsPath: settings, onEvent: (e) => events.push(e), getenv: null, asightBin: '/a' })
  assert.equal(out.ok, false)
  assert.deepEqual(events.map((e) => [e.where, e.code]), [['autostart', 'autostart-load-failed']])
  assert.match(events[0].reason, /com\.asight\.monitor: launchctl load .* failed: Load failed/)
  inSet(events)
  const linux = monitoringOn({ onboard, autostart: getAutostartInstaller('linux'), settingsPath: settings, onEvent: (e) => events.push(e), getenv: null })
  assert.equal(linux.ok, true, 'a reserved platform is not a failure')
})

test('L-8: CA trust is true / false / null + why; NODE_EXTRA_CA_CERTS is reported against the asight CA path; an unparsable settings.json is said', () => {
  const d = tmpDir('asight-lops-')
  try {
    const settings = path.join(d, 'settings.json'); fs.writeFileSync(settings, '{}')
    const autostart = { platform: 'darwin', status: () => ({ installed: false }) }
    const st = (verify, getenv, extra = {}) => monitoringStatus({ onboard: { verifyUserTrustOnly: verify }, autostart, settingsPath: settings, getenv, caPath: '/h/.asight/ca/atrace-ca.crt', ...extra })
    assert.equal(st(() => true, null).caTrusted, true)
    assert.equal(st(() => false, null).caTrusted, false)
    const err = st(() => { throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found') }, null)
    assert.deepEqual([err.caTrusted, err.caError, err.active], [null, 'security: SecKeychainSearchCopyNext: The specified item could not be found', false], 'an error is not folded into "not trusted"')
    assert.deepEqual(st(() => true, () => '/h/.asight/ca/atrace-ca.crt').nodeExtraCaCerts, { value: '/h/.asight/ca/atrace-ca.crt', expected: '/h/.asight/ca/atrace-ca.crt', matches: true })
    assert.deepEqual(st(() => true, () => '').nodeExtraCaCerts.matches, false, 'unset in the login session')
    assert.deepEqual(st(() => true, () => '/old/ca.crt').nodeExtraCaCerts.matches, false)
    const ge = st(() => true, () => { throw new Error('launchctl: not permitted') }).nodeExtraCaCerts
    assert.deepEqual([ge.matches, ge.error], [null, 'launchctl: not permitted'])
    assert.equal(st(() => true, null).nodeExtraCaCerts, null, 'not macOS: not applicable')
    fs.writeFileSync(settings, '{"env": {"HTTPS_PROXY": ')
    assert.match(st(() => true, null).steerError, /settings\.json: .*JSON/)
    fs.rmSync(settings)
    assert.equal(st(() => true, null).steerError, undefined, 'no settings.json is not an error')
    const broken = monitoringStatus({ onboard: { verifyUserTrustOnly: () => true }, autostart: { platform: 'darwin', status: () => { throw new Error('EACCES: LaunchAgents') } }, settingsPath: settings, getenv: null })
    assert.deepEqual([broken.autostart, broken.autostartError], [null, 'EACCES: LaunchAgents'], 'an autostart status that cannot be read is not "not installed"')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('L-12: the steer watch writes one line per transition — gone after being seen, installed but not live, unreadable — and nothing for a steer never installed', async () => {
  const recs = []
  let st = { scriptInstalled: false, live: null, scriptPath: '/v/Script.js', proxyName: 'atrace-mitm' }
  const check = createSteerWatch({ status: async () => st, record: (r) => recs.push(r) })
  await check(); await check()
  assert.deepEqual(recs, [], 'never installed (CC-CLI only): nothing')
  st = { ...st, scriptInstalled: true, live: true }; await check()
  st = { ...st, scriptInstalled: false }; await check(); await check()
  assert.deepEqual(recs.map((r) => r.code), ['steer-missing'], 'gone after being seen: one line, not one per check')
  st = { ...st, scriptInstalled: null, readError: "ENOENT: no such file or directory, open '/v/Script.js'" }; await check()
  assert.equal(recs.length, 1, 'Script.js itself gone is the same "missing", not a new line')
  st = { ...st, scriptInstalled: true, live: true, readError: undefined }; await check()
  st = { ...st, live: false }; await check()
  st = { ...st, scriptInstalled: null, readError: 'EACCES: permission denied' }; await check()
  assert.deepEqual(recs.map((r) => r.code), ['steer-missing', 'steer-missing', 'steer-unreadable'])
  assert.match(recs[1].reason, /not live/)
  assert.ok(recs.every((r) => r.where === 'steer' && r.file === '/v/Script.js'))
  inSet(recs)
  const first = []
  await createSteerWatch({ status: async () => ({ scriptInstalled: null, readError: 'EISDIR: illegal operation on a directory' }), record: (r) => first.push(r) })()
  assert.deepEqual(first.map((r) => r.code), ['steer-unreadable'], 'unreadable at the first check is written too')
  const thrown = []
  await createSteerWatch({ status: async () => { throw new Error('boom') }, record: (r) => thrown.push(r) })()
  assert.deepEqual(thrown.map((r) => r.code), ['steer-unreadable'])
  assert.equal(await createSteerWatch({ status: async () => ({ reserved: true }), record: () => assert.fail() })(), null)
})

// RFC 1.6 §4: `asight off` writes ~/.asight/legacy-off.pending ({pid}) between stripping the block and unloading the MITM; while that pid lives the block's going away is off's doing, not a failure.
test('1.6 §4: while an off is pending (the marker names a live pid) the steer watch says nothing about the block being gone; a dead pid\'s marker is stale; with no off pending the same look is a failure', async () => {
  const recs = []
  let st = { scriptInstalled: true, live: true, scriptPath: '/v/Script.js', proxyName: 'atrace-mitm' }
  let pending = false
  const check = createSteerWatch({ status: async () => st, record: (r) => recs.push(r), pending: () => pending })
  await check()
  st = { ...st, scriptInstalled: false }; pending = true
  assert.equal(await check(), null); assert.deepEqual(recs, [], 'off is taking it out: not a failure')
  pending = false; await check()
  assert.deepEqual(recs.map((r) => r.code), ['steer-missing'], 'the watch is not blind: with no off in progress it is')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-pending-'))
  try {
    const marker = path.join(dir, '.asight', 'legacy-off.pending')
    assert.equal(legacyOffPending({ home: dir, alive: () => true }), false, 'no marker, no pending')
    fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ pid: 4242, at: 'x' }))
    assert.deepEqual([legacyOffPending({ home: dir, alive: (p) => p === 4242 }), legacyOffPending({ home: dir, alive: () => false })], [true, false])
    fs.writeFileSync(marker, '{not json'); assert.equal(legacyOffPending({ home: dir, alive: () => true }), false, 'a marker that cannot be read is no marker')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('L-11: uninstall prints a steer it could not revert and records it; "n/a" only where there is no steer', async () => {
  const recs = []
  const record = (r) => recs.push(r)
  assert.equal(await uninstallSteer({ getSteer: () => ({ off: async () => { throw Object.assign(new Error('EACCES: permission denied, open Script.js'), { code: 'EACCES' }) } }), record }), '⚠ steer 撤销失败:EACCES: permission denied, open Script.js')
  assert.equal(await uninstallSteer({ getSteer: () => ({ off: async () => ({ ok: false, reason: 'mihomo reload FAILED (status 500)' }) }), record }), '⚠ NOT fully removed — mihomo reload FAILED (status 500)')
  assert.deepEqual(recs.map((r) => [r.where, r.code]), [['steer', 'EACCES'], ['steer', 'uninstall-error']])
  inSet(recs)
  assert.equal(await uninstallSteer({ getSteer: () => ({ off: async () => ({ ok: true }) }), record: () => assert.fail() }), 'removed')
  assert.equal(await uninstallSteer({ getSteer: () => ({ off: async () => ({ reserved: true }) }), record: () => assert.fail() }), 'n/a')
})
