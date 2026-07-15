import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getTrustStoreInstaller, darwinInstaller, linuxInstaller,
  CA_CN, CA_NICKNAME,
} from '../../src/capture/trust-store.mjs'

// A recording runner: captures (file,args) and returns an injectable canned result,
// so the whole unit is exercised WITHOUT mutating any real trust store (RFC 4.1 §验收5).
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
  const absent = darwinInstaller({ run: () => ({ status: 1 }) })
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
