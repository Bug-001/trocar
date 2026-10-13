import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getTrustStoreInstaller, darwinInstaller, linuxInstaller, defaultRun,
  CA_CN, CA_NICKNAME,
} from '../../src/capture/trust-store.mjs'
import { monitoringStatus } from '../../src/capture/control.mjs'

// A recording runner: captures (file,args) and returns an injectable canned result,
// so the whole unit is exercised WITHOUT mutating any real trust store.
function recorder(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = []
  const run = (file, args) => { calls.push({ file, args }); return typeof result === 'function' ? result(file, args) : result }
  return { run, calls }
}

test('dispatch: platform -> installer; win32 reserved; unknown unsupported', () => {
  assert.equal(getTrustStoreInstaller('darwin').platform, 'darwin')
  assert.equal(getTrustStoreInstaller('linux').platform, 'linux')
  assert.throws(() => getTrustStoreInstaller('win32'), /reserved|not implemented|D22/i)
  assert.throws(() => getTrustStoreInstaller('sunos'), /unsupported/i)
})

test('darwin: installs into login keychain, import-only, NEVER machine trust', () => {
  const { run, calls } = recorder()
  const inst = darwinInstaller({ run, keychain: '/Users/x/Library/Keychains/login.keychain-db' })
  const argv = inst.installArgv('/Users/x/.atrace/ca/atrace-ca.crt')
  assert.equal(argv.file, 'security')
  assert.ok(argv.args.includes('add-certificates'))
  assert.ok(argv.args.includes('-k'))
  assert.ok(argv.args.some((a) => a.endsWith('login.keychain-db')))
  assert.ok(argv.args.includes('/Users/x/.atrace/ca/atrace-ca.crt'))
  // 必拒: never widen machine-wide TLS trust
  const blob = JSON.stringify([inst.installArgv('/c'), inst.verifyArgv(), inst.uninstallArgv()])
  assert.ok(!blob.includes('add-trusted-cert'), 'darwin MUST NOT add-trusted-cert')
  assert.ok(!blob.includes('trustRoot'), 'darwin MUST NOT trustRoot')
  // execution goes through the injected runner (no real keychain touched)
  inst.install('/Users/x/.atrace/ca/atrace-ca.crt')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'security')
})

test('darwin: verify/uninstall use the CA common-name; status maps to boolean', () => {
  const inst = darwinInstaller({ run: () => ({ status: 0 }) })
  assert.ok(inst.verifyArgv().args.includes('find-certificate'))
  assert.ok(inst.verifyArgv().args.includes(CA_CN))
  assert.ok(inst.uninstallArgv().args.includes('delete-certificate'))
  assert.equal(inst.verifyUserTrustOnly(), true)
  const absent = darwinInstaller({ run: () => ({ status: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' }) })
  assert.equal(absent.verifyUserTrustOnly(), false)
})

test('linux: installs into user NSS db, import-only, NEVER system anchors', () => {
  const { run, calls } = recorder()
  const inst = linuxInstaller({ run, nssdb: '/home/x/.pki/nssdb' })
  const argv = inst.installArgv('/home/x/.atrace/ca/atrace-ca.crt')
  assert.equal(argv.file, 'certutil')
  assert.ok(argv.args.includes('-A'))
  assert.ok(argv.args.includes('-n'))
  assert.ok(argv.args.includes(CA_NICKNAME))
  assert.ok(argv.args.includes('sql:/home/x/.pki/nssdb'))
  assert.ok(argv.args.includes('/home/x/.atrace/ca/atrace-ca.crt'))
  // 必拒: never write system-wide anchors
  const blob = JSON.stringify([inst.installArgv('/c'), inst.verifyArgv(), inst.uninstallArgv()])
  assert.ok(!blob.includes('/etc/ssl'), 'linux MUST NOT touch /etc/ssl')
  assert.ok(!blob.includes('update-ca-certificates'), 'linux MUST NOT update-ca-certificates')
  inst.install('/home/x/.atrace/ca/atrace-ca.crt')
  assert.equal(calls[0].file, 'certutil')
})

test('linux: verify/uninstall target the nickname in the user db', () => {
  const inst = linuxInstaller({ run: () => ({ status: 0 }), nssdb: '/home/x/.pki/nssdb' })
  assert.ok(inst.verifyArgv().args.includes('-L'))
  assert.ok(inst.verifyArgv().args.includes(CA_NICKNAME))
  assert.ok(inst.uninstallArgv().args.includes('-D'))
  assert.equal(inst.verifyUserTrustOnly(), true)
})

// 4.1 落地细节 (6): only the store's own "not found" answer is false; anything else — the tool missing
// (ENOENT), a keychain or NSS db that cannot be opened — could not be checked: it throws with the reason, so
// /control/status says caTrusted:null + caError ("CA ? reason"), never "not trusted".
test('verify: only the store\'s own not-found is false; a tool that is missing or fails is "could not be checked"', () => {
  assert.equal(linuxInstaller({ run: () => ({ status: 255, stderr: 'certutil: Could not find cert: asight-ca\n: PR_FILE_NOT_FOUND_ERROR: File not found' }) }).verifyUserTrustOnly(), false)
  const enoent = defaultRun('asight-no-such-tool-d2-08', ['-L'])
  assert.deepEqual([enoent.status, enoent.error], [null, 'ENOENT'], 'the default runner says the tool could not be run')
  for (const [name, inst] of [
    ['certutil missing', linuxInstaller({ run: () => enoent })],
    ['bad NSS db', linuxInstaller({ run: () => ({ status: 255, stderr: 'certutil: function failed: SEC_ERROR_BAD_DATABASE: security library: bad database.' }) })],
    ['keychain unreadable', darwinInstaller({ run: () => ({ status: 50, stderr: 'security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct.' }), keychain: '/k' })],
  ]) {
    assert.throws(() => inst.verifyUserTrustOnly(), /could not be checked/, name)
    const st = monitoringStatus({ onboard: { verifyUserTrustOnly: () => inst.verifyUserTrustOnly() }, autostart: { platform: 'linux', status: () => ({ installed: false }) }, settingsPath: '/nonexistent/settings.json', getenv: null, caPath: '/nonexistent/ca.crt' })
    assert.equal(st.caTrusted, null, `${name}: caTrusted is null, not false`)
    assert.match(st.caError, /could not be checked/, name)
  }
})
