// custody.test.mjs — the Windows CNG custody over a STUB powershell (CM3 stub side; the real custody.ps1 runs in acceptance L4, plan §E.3,
// because a Mac cannot drive CNG), and the CurrentUser\Root binding (CM7 argv). The stub runner answers custody.ps1's verbs, exit
// codes and JSON from test/helpers/custody-stub.mjs, which keeps its key in memory and builds what it signs itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { cngCustody, CUSTODY_PS1, PS_FILE_ARGS } from '../../../../src/collector/arch/win32/custody.mjs'
import { userRootStore } from '../../../../src/collector/arch/win32/root-store.mjs'
import { ROOT, INTERMEDIATE, checkProfile } from '../../../../src/collector/core/tls/cert.mjs'

/** A runner standing in for powershell.exe -File custody.ps1: logs each argv, answers from the in-memory stub. */
function stubPowershell({ mode = '' } = {}) {
  const key = custodyStub()
  const calls = []
  const run = (file, args) => {
    calls.push({ file, args })
    const i = args.indexOf('-File'), a = args.slice(i + 2), arg = (f) => a[a.indexOf(f) + 1]
    const out = (o, status = 0) => ({ status, stdout: JSON.stringify(o) + '\n', stderr: '' })
    if (mode === 'unavailable') return out({ error: 'unavailable', message: 'no CNG key storage provider opens' }, 3)
    if (mode === 'crash') return { status: 1, stdout: '', stderr: 'Add-Type: boom' }
    if (mode === 'no-root' && a[0] === 'issue') return out({ error: 'no-root', message: 'no certificate of the key in Cert:\\CurrentUser\\Root' }, 6)
    if (a[0] === 'exists') return out({ exists: key.exists() })
    if (a[0] === 'remove') { const had = key.exists(); key.remove(); return out({ removed: had }) }
    if (a[0] === 'create') { if (key.exists()) return out({ error: 'exists' }, 5); return out({ rootDer: key.create({ subject: arg('--subject') }).rootDer.toString('base64'), provider: 'Microsoft Software Key Storage Provider' }) }
    if (a[0] === 'issue') {
      if (!key.exists()) return out({ error: 'no-key' }, 4)
      return out({ certDer: key.issueIntermediate({ spkiDer: Buffer.from(arg('--spki'), 'base64'), serial: Buffer.from(arg('--serial'), 'hex'), notBefore: new Date(arg('--not-before')) }).toString('base64') })
    }
    return out({ error: 'usage' }, 2)
  }
  return { run, calls }
}
const p256 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' })

test('CM3 (stub): create → a ROOT-profile root; issue carries only spki / serial / notBefore and returns an INTERMEDIATE of that root', () => {
  const ps = stubPowershell(), c = cngCustody({ run: ps.run })
  assert.equal(c.kind, 'cng')
  assert.equal(c.exists(), false)
  const { rootDer, fp256, provider } = c.create({ subject: 'asight root (test)' })
  assert.deepEqual(checkProfile(rootDer, ROOT), [])
  assert.equal(provider, 'Microsoft Software Key Storage Provider', 'the provider the key went to is passed on (D38: a software fallback is never silent)')
  assert.equal(fp256, new crypto.X509Certificate(rootDer).fingerprint256)
  assert.equal(c.exists(), true)
  const spkiDer = p256(), serial = crypto.randomBytes(16), notBefore = new Date(Date.UTC(2026, 9, 15, 12, 0, 0))
  const cert = c.issueIntermediate({ spkiDer, serial, notBefore })
  assert.deepEqual(checkProfile(cert, INTERMEDIATE, { root: rootDer }), [])
  for (const { file, args } of ps.calls) {
    assert.equal(file, 'powershell.exe')
    assert.deepEqual(args.slice(0, PS_FILE_ARGS.length + 1), [...PS_FILE_ARGS, CUSTODY_PS1], 'no profile, no prompt, -File the shipped script')
  }
  const issue = ps.calls.find((x) => x.args.includes('issue')).args.slice(PS_FILE_ARGS.length + 1)
  assert.deepEqual(issue, ['issue', '--spki', spkiDer.toString('base64'), '--serial', serial.toString('hex'), '--not-before', notBefore.toISOString()], 'the argv is the public key, the serial and notBefore: no TBS, no profile, nothing to sign')
  assert.deepEqual(c.remove(), { removed: true })
  assert.equal(c.exists(), false)
  assert.equal(CUSTODY_PS1.endsWith('custody.ps1') && fs.existsSync(CUSTODY_PS1), true)
})

test('CM3 (stub): unavailable is a value, not a throw; a missing key and a crash throw with the script\'s word', () => {
  const off = cngCustody({ run: stubPowershell({ mode: 'unavailable' }).run })
  assert.equal(off.create({ subject: 'x' }), 'unavailable')
  assert.equal(off.exists(), 'unavailable')
  assert.equal(off.issueIntermediate({ spkiDer: p256(), serial: Buffer.from([1]), notBefore: new Date() }), 'unavailable')
  const none = cngCustody({ run: stubPowershell().run })
  assert.throws(() => none.issueIntermediate({ spkiDer: p256(), serial: Buffer.from([1]), notBefore: new Date() }), (e) => e.code === 'no-key' && /custody\.ps1 issue/.test(e.message))
  const twice = cngCustody({ run: stubPowershell().run })
  twice.create({ subject: 'a' })
  assert.throws(() => twice.create({ subject: 'a' }), (e) => e.code === 'exists')
  assert.throws(() => cngCustody({ run: stubPowershell({ mode: 'crash' }).run }).exists(), (e) => e.code === 'helper-failed' && /boom/.test(e.message))
  const noRoot = cngCustody({ run: stubPowershell({ mode: 'no-root' }).run })
  noRoot.create({ subject: 'a' })
  assert.throws(() => noRoot.issueIntermediate({ spkiDer: p256(), serial: Buffer.from([1]), notBefore: new Date() }), (e) => e.code === 'no-root')
})

test('custody.ps1 builds and signs itself: no caller TBS, X509SignatureGenerator, a non-exportable key, the TPM before the software KSP', () => {
  const ps1 = fs.readFileSync(CUSTODY_PS1, 'utf8')
  assert.match(ps1, /X509SignatureGenerator\]::CreateForECDsa/)
  assert.match(ps1, /ExportPolicy = \[System\.Security\.Cryptography\.CngExportPolicies\]::None/)
  assert.ok(ps1.indexOf('Microsoft Platform Crypto Provider') < ps1.indexOf('Microsoft Software Key Storage Provider'), 'the TPM is tried first (R3-W1)')
  assert.doesNotMatch(ps1, /--tbs|Export\(\s*\[System\.Security\.Cryptography\.CngKeyBlobFormat\]::(EccPrivate|Pkcs8Private|GenericPrivate)/i, 'nothing signs a caller\'s bytes; the private key is never exported')
  assert.doesNotMatch(ps1, /SetProperty|GetProperty|CngProperty/, 'the key holds no state of asight\'s: the TPM provider keeps only its own property set, so a property would push a TPM machine onto the software KSP')
  assert.match(ps1, /Get-ChildItem Cert:\\CurrentUser\\Root/, 'issue takes the issuer name from the root certificate in the user\'s Root store')
  for (const verb of ['create', 'exists', 'issue', 'remove']) assert.match(ps1, new RegExp(`^  '${verb}' \\{`, 'm'), verb)
  assert.ok(ps1.split('\n').length <= 120, 'one-shot and short')
  assert.doesNotMatch(ps1, /[^\x00-\x7f]/, 'ASCII only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page')
})

test('CM7 (argv): the Windows root store is always certutil -user on the Root store', () => {
  const home = tmpDir('asight-rs-win-')
  const calls = []
  const der = custodyStub().create({ subject: 'r' }).rootDer
  const run = (file, args) => { calls.push([file, ...args]); return { status: args.includes('-store') ? 0x80092004 : 0, stdout: '', stderr: '' } }
  const rs = userRootStore({ home, run })
  const id = { fp256: new crypto.X509Certificate(der).fingerprint256, sha1: new crypto.X509Certificate(der).fingerprint.replace(/:/g, '') }
  assert.deepEqual(rs.add(der), { ok: true })
  assert.deepEqual(rs.has(id), { present: false })
  assert.deepEqual(rs.remove(id), { ok: true, absent: true })
  assert.equal(calls.length, 3)
  for (const c of calls) {
    assert.equal(c[0], 'certutil')
    assert.equal(c[1], '-user', `the user's store, never the machine's: ${c.join(' ')}`)
    assert.equal(c[3], 'Root')
  }
  assert.deepEqual(calls.map((c) => c[2]), ['-addstore', '-store', '-store'])
})
