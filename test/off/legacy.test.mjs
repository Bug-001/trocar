// test/off/legacy.test.mjs — src/off/legacy.mjs, the old capture's undo (RFC 1.6 §4): which platforms have the new collector, the steer and CA undo that src/capture/onboard.mjs and trust-store.mjs
// now call (one undo, not two), and what the old capture leaves is found by its own marks. Sandbox HOME, injected runners (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { hasNewCollector, caRemoveArgv, clearCliSteer, legacyPaths, legacyArtifacts, LEGACY_CA_CN, LEGACY_CA_NICKNAME } from '../../src/off/legacy.mjs'
import { macHome, fakeMac, fakeCore, CA_CN as CA_SUBJECT } from '../cli/fixtures/legacy-ctx.mjs'
import { snapshot } from '../cli/fixtures/on-ctx.mjs'
import * as onboard from '../../src/capture/onboard.mjs'
import { getTrustStoreInstaller, CA_CN, CA_NICKNAME } from '../../src/capture/trust-store.mjs'

test('hasNewCollector: Linux only today — the one question every command asks to pick the generation it drives', () => {
  assert.deepEqual(['linux', 'darwin', 'win32', 'freebsd'].map((p) => hasNewCollector(p)), [true, false, false, false])
  assert.equal(hasNewCollector(), process.platform === 'linux')
})

test('the CA is taken out of the USER-level store only: the login keychain by CN on macOS, the user NSS database by nickname on Linux — and the trust-store installers use these same argv', () => {
  const home = '/h'
  assert.deepEqual(caRemoveArgv({ platform: 'darwin', home }), { file: 'security', args: ['delete-certificate', '-c', 'atrace local MITM CA', '/h/Library/Keychains/login.keychain-db'] })
  assert.deepEqual(caRemoveArgv({ platform: 'linux', home }), { file: 'certutil', args: ['-D', '-d', 'sql:/h/.pki/nssdb', '-n', 'asight-ca'] })
  assert.throws(() => caRemoveArgv({ platform: 'win32', home }), /no user-level trust store/)
  for (const bad of [caRemoveArgv({ platform: 'darwin', home }), caRemoveArgv({ platform: 'linux', home })]) assert.ok(!bad.args.includes('remove-trusted-cert') && !bad.args.some((a) => /\/etc\/ssl/.test(a)), 'nothing machine-wide')
  assert.deepEqual([CA_CN, CA_NICKNAME], [LEGACY_CA_CN, LEGACY_CA_NICKNAME], 'the legacy names are defined once')
  assert.deepEqual(getTrustStoreInstaller('darwin', { keychain: '/k' }).uninstallArgv(), caRemoveArgv({ platform: 'darwin', keychain: '/k' }))
  assert.deepEqual(getTrustStoreInstaller('linux', { nssdb: '/n' }).uninstallArgv(), caRemoveArgv({ platform: 'linux', nssdb: '/n' }))
})

test('clearCliSteer: the values the steer displaced come back from the stash, the keys it introduced go; onboard.clearCliSteer is this function; backup:false writes no .asight-bak next to settings.json', () => {
  const dir = tmpDir('asight-legacy-')
  const settingsPath = path.join(dir, 'settings.json'), stashPath = path.join(dir, 'steer-backup.json')
  const seed = () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'x', env: { HTTPS_PROXY: 'http://127.0.0.1:9898', NO_PROXY: '127.0.0.1,localhost', KEEP: '1' } }, null, 2) + '\n')
    fs.writeFileSync(stashPath, JSON.stringify({ settingsPath: null, env: { HTTPS_PROXY: 'http://corp:3128' } }) + '\n')
  }
  seed()
  const env = clearCliSteer({ settingsPath, stashPath, backup: false })
  assert.deepEqual(env, { HTTPS_PROXY: 'http://corp:3128', KEEP: '1' }, 'displaced value back, introduced key gone, the user\'s other key kept')
  assert.equal(fs.existsSync(settingsPath + '.asight-bak'), false, 'backup:false: the receipt lists what `asight off` writes, and this is not in it')
  assert.equal(fs.existsSync(stashPath), false, 'the stash is consumed')
  seed()
  assert.deepEqual(onboard.clearCliSteer({ settingsPath, stashPath }), { HTTPS_PROXY: 'http://corp:3128', KEEP: '1' })
  assert.equal(fs.existsSync(settingsPath + '.asight-bak'), true, 'the old `monitor off` keeps its one-time copy')
})

test('legacyPaths: the places of the old capture for one HOME — and the legacy names (~/.atrace/steer-backup.json, the Verge directory) are not renamed', () => {
  const p = legacyPaths({ home: '/h', platform: 'darwin' })
  assert.equal(p.stashPath, '/h/.atrace/steer-backup.json')
  assert.equal(p.scriptPath, '/h/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/profiles/Script.js')
  assert.equal(p.plist('com.asight.mitm'), '/h/Library/LaunchAgents/com.asight.mitm.plist')
})

// ── legacyArtifacts: what of the old capture is on the machine, read only (1.6 §4, §6, R11) ───────────────────────────────────────────────────────────────────────────────────────────

test('legacyArtifacts reads the whole old capture of a Mac and writes nothing: the steer and its stash, the route in Script.js and in the runtime, the three LaunchAgents (loaded, with the pid of the MITM), the login variable, the CA', async () => {
  const s = macHome({ displaced: { HTTPS_PROXY: 'http://corp:3128' } })
  const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath } }); const before = snapshot(s.home)
  const a = await legacyArtifacts({ home: s.home, platform: 'darwin', exec: mac.run, env: {} })
  assert.deepEqual(a.ccSteer.stash, { HTTPS_PROXY: 'http://corp:3128' }); assert.equal(a.ccSteer.proxy, 'http://127.0.0.1:9898')
  assert.deepEqual([a.clashBlock.verge, a.clashBlock.script, a.clashBlock.runtime, a.clashBlock.merge], [true, true, true, false])
  assert.deepEqual(['mitm', 'monitor', 'env'].map((k) => [a.agents[k].installed, a.agents[k].loaded]), [[true, true], [true, true], [true, true]])
  assert.equal(a.agents.mitm.pid, 4242); assert.equal(a.agents.monitor.pid, null)
  assert.equal(a.agents.env.caPath, s.caPath, 'what the primer sets the variable to, read from its plist')
  assert.deepEqual([a.envValue.value, a.oldCa.where, a.oldCa.present, a.ledger], [s.caPath, 'keychain', true, null])
  assert.deepEqual(snapshot(s.home), before, 'read only')
  assert.deepEqual(mac.calls.filter((c) => !/^(launchctl (list|getenv)|security find-certificate)/.test(c)), [], 'and only the reading commands ran')
  assert.ok(mac.has(new RegExp(`^security find-certificate -c ${CA_SUBJECT}`)))
})

test('legacyArtifacts: what could not be read says why and is null — never false, never "absent" (R11); a Verge with no route of ours reads false', async () => {
  const s = macHome({ block: false, runtime: false, agents: [], steer: false })
  fs.rmSync(s.script); fs.mkdirSync(s.script) // Script.js is a directory now: it cannot be read
  const broken = (file, args) => (file === 'launchctl' && args[0] === 'list' ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn launchctl ENOENT'), { code: 'ENOENT' }) } : file === 'security' ? { status: 1, stdout: '', stderr: 'security: boom' } : { status: 0, stdout: '', stderr: '' })
  const a = await legacyArtifacts({ home: s.home, platform: 'darwin', exec: broken, env: {} })
  assert.equal(a.clashBlock.script, null); assert.match(a.clashBlock.error, /Script\.js/)
  assert.equal(a.clashBlock.runtime, false, 'a runtime that was read and has no route is false')
  assert.equal(a.agents.mitm.loaded, null); assert.match(a.agents.mitm.error, /launchctl list com\.asight\.mitm/)
  assert.equal(a.oldCa.present, null); assert.match(a.oldCa.error, /security find-certificate/)
  assert.equal(a.ccSteer.stash, null, 'no stash: not steered by asight')
})

test('legacyArtifacts live:true asks the Clash core whether the route is in its live proxy list (read only); a core that does not answer is null with the socket it tried', async () => {
  const s = macHome()
  const core = await fakeCore({ live: true }); const mac = fakeMac()
  try {
    const a = await legacyArtifacts({ home: s.home, platform: 'darwin', exec: mac.run, env: { ASIGHT_MIHOMO_SOCK: core.sock }, live: true })
    assert.deepEqual([a.clashBlock.live, a.clashBlock.sock, core.state.puts.length], [true, core.sock, 0])
    core.state.live = false
    assert.equal((await legacyArtifacts({ home: s.home, platform: 'darwin', exec: mac.run, env: { ASIGHT_MIHOMO_SOCK: core.sock }, live: true })).clashBlock.live, false)
  } finally { await core.close() }
  const dead = path.join(s.home, 'dead.sock')
  const b = await legacyArtifacts({ home: s.home, platform: 'darwin', exec: fakeMac().run, env: { ASIGHT_MIHOMO_SOCK: dead }, live: true })
  assert.deepEqual([b.clashBlock.live, b.clashBlock.tried], [null, [dead]])
})

test('legacyArtifacts on Linux asks nothing of launchd or the keychain, and looks into the NSS database only when there is one (no certutil run on a machine that never had it)', async () => {
  const s = macHome({ agents: [], block: false, runtime: false, steer: true })
  const calls = []
  const exec = (f, a) => { calls.push([f, ...a].join(' ')); return { status: 0, stdout: '', stderr: '' } }
  const a = await legacyArtifacts({ home: s.home, platform: 'linux', exec, env: {} })
  assert.deepEqual([calls, a.oldCa.where, a.oldCa.present, a.clashBlock.verge, a.agents.mitm.loaded], [[], 'nss', false, false, null])
  assert.notEqual(a.ccSteer.stash, null, 'the steer of `monitor on` is found on Linux too')
  fs.mkdirSync(path.join(s.home, '.pki', 'nssdb'), { recursive: true })
  const b = await legacyArtifacts({ home: s.home, platform: 'linux', exec, env: {} })
  assert.deepEqual(calls, [`certutil -L -d sql:${path.join(s.home, '.pki', 'nssdb')} -n asight-ca`]); assert.equal(b.oldCa.present, true)
})
