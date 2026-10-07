// test/off/legacy.test.mjs — src/off/legacy.mjs, the old capture's undo (RFC 1.6 §4): which platforms have the new collector, the steer and CA undo that src/capture/onboard.mjs and trust-store.mjs
// now call (one undo, not two), and what the old capture leaves is found by its own marks. Sandbox HOME, injected runners (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { hasNewCollector, caRemoveArgv, clearCliSteer, legacyPaths, LEGACY_CA_CN, LEGACY_CA_NICKNAME } from '../../src/off/legacy.mjs'
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
