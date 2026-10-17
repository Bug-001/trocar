// custody.test.mjs — the macOS keychain custody over a STUB signing helper (CM3, stub side; the real helper is L1's, plan §E.3):
// the stub is a node script named asight-sign-helper in a temp dir that speaks the helper's verbs, exit codes and JSON, keeps its
// key in a file there and logs every argv. The real helper is never run (it would write the login keychain).
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { keychainCustody, installHelper } from '../../../../src/collector/arch/darwin/custody.mjs'
import { NATIVE, nativePath, sha256 } from '../../../../src/collector/arch/darwin/native.mjs'
import { ROOT, INTERMEDIATE, checkProfile } from '../../../../src/collector/core/tls/cert.mjs'

const CERT = new URL('../../../../src/collector/core/tls/cert.mjs', import.meta.url).href
const STUB = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const dir = __dirname, a = process.argv.slice(2), arg = (f) => a[a.indexOf(f) + 1]
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(a) + '\\n')
const mode = fs.existsSync(path.join(dir, 'mode')) ? fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() : ''
const out = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(code) }
if (mode === 'unavailable') out({ error: 'unavailable', status: -25308 }, 3)
if (mode === 'crash') { process.stderr.write('boom'); process.exit(1) }
const keyFile = path.join(dir, 'key.pem'), rootFile = path.join(dir, 'root.der')
import(${JSON.stringify(CERT)}).then(({ rootCertDer, intermediateCertDer }) => {
  const sign = (k) => (tbs) => crypto.sign('sha256', tbs, k)
  const DAY = 86400e3, now = Date.now()
  if (a[0] === 'exists') out({ exists: fs.existsSync(keyFile) })
  if (a[0] === 'remove') { const had = fs.existsSync(keyFile); fs.rmSync(keyFile, { force: true }); out({ removed: had }) }
  if (a[0] === 'create') {
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    fs.writeFileSync(keyFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const der = rootCertDer({ subject: arg('--subject'), spkiDer: k.publicKey.export({ type: 'spki', format: 'der' }), serial: Buffer.from([1]), notBefore: new Date(now - DAY), notAfter: new Date(now + 3650 * DAY), sign: sign(k.privateKey) })
    fs.writeFileSync(rootFile, der); out({ rootDer: der.toString('base64') })
  }
  if (a[0] === 'issue') {
    if (!fs.existsSync(keyFile)) out({ error: 'no-key' }, 4)
    const nb = new Date(arg('--not-before'))
    const der = intermediateCertDer({ root: fs.readFileSync(rootFile), subject: 'asight intermediate ' + nb.toISOString(), spkiDer: Buffer.from(arg('--spki'), 'base64'), serial: Buffer.from(arg('--serial'), 'hex'), notBefore: nb, sign: sign(crypto.createPrivateKey(fs.readFileSync(keyFile))) })
    out({ certDer: der.toString('base64') })
  }
  out({ error: 'usage' }, 2)
})
`
function stubHelper() {
  const dir = tmpDir('asight-custody-')
  const helperPath = path.join(dir, NATIVE.signHelper)
  fs.writeFileSync(helperPath, STUB, { mode: 0o755 })
  return { dir, helperPath, argv: () => fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)), mode: (m) => fs.writeFileSync(path.join(dir, 'mode'), m) }
}
const p256 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' })

test('CM3: create → a root of the ROOT profile; issue carries only spki / serial / notBefore and returns an INTERMEDIATE of that root', () => {
  const h = stubHelper(), c = keychainCustody({ helperPath: h.helperPath })
  assert.equal(c.kind, 'keychain')
  assert.equal(c.exists(), false)
  const { rootDer, fp256 } = c.create({ subject: 'asight root (test)' })
  assert.deepEqual(checkProfile(rootDer, ROOT), [])
  assert.equal(fp256, new crypto.X509Certificate(rootDer).fingerprint256)
  assert.equal(c.exists(), true)
  const spkiDer = p256(), serial = crypto.randomBytes(16), notBefore = new Date(Date.UTC(2026, 9, 15, 12, 0, 0))
  serial[0] &= 0x7f
  const der = c.issueIntermediate({ spkiDer, serial, notBefore })
  assert.deepEqual(checkProfile(der, INTERMEDIATE, { root: rootDer }), [])
  assert.ok(new crypto.X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' }).equals(spkiDer))
  const issue = h.argv().find((a) => a[0] === 'issue')
  assert.deepEqual(issue, ['issue', '--spki', spkiDer.toString('base64'), '--serial', serial.toString('hex'), '--not-before', notBefore.toISOString()], 'no TBS, no subject, no profile on the argv')
  assert.deepEqual(c.remove(), { removed: true })
  assert.equal(c.exists(), false)
})

test('CM3: the helper\'s unavailable exit is the value \'unavailable\' on every verb, never a throw; another failure throws with its word', () => {
  const h = stubHelper(), c = keychainCustody({ helperPath: h.helperPath })
  h.mode('unavailable')
  assert.equal(c.create({ subject: 'x' }), 'unavailable')
  assert.equal(c.exists(), 'unavailable')
  assert.equal(c.issueIntermediate({ spkiDer: p256(), serial: Buffer.from([1]), notBefore: new Date() }), 'unavailable')
  assert.equal(c.remove(), 'unavailable')
  h.mode('')
  assert.throws(() => c.issueIntermediate({ spkiDer: p256(), serial: Buffer.from([1]), notBefore: new Date() }), { code: 'no-key' })
  h.mode('crash')
  assert.throws(() => c.exists(), (e) => e.code === 'helper-failed' && /boom/.test(e.message))
})

test('CM3: an injected runner sees the same argv (the runner seam the daemon uses)', () => {
  const seen = []
  const run = (file, args) => { seen.push([file, ...args]); return { status: 0, stdout: JSON.stringify({ exists: true }), stderr: '' } }
  assert.equal(keychainCustody({ helperPath: '/x/asight-sign-helper', run }).exists(), true)
  assert.deepEqual(seen, [['/x/asight-sign-helper', 'exists']])
})

test('installHelper: fresh → written via <dest>.new-* and renamed; same hash → no-op; differing + non-interactive → kept; differing + interactive → replaced, then one foreground issue', () => {
  const dest = path.join(tmpDir('asight-bin-'), 'bin', NATIVE.signHelper)
  const renames = []
  const fsSpy = { ...fs, renameSync: (a, b) => { renames.push([path.basename(a), path.basename(b)]); return fs.renameSync(a, b) } }
  const packaged = fs.readFileSync(nativePath(NATIVE.signHelper))
  assert.deepEqual(installHelper({ dest, interactive: false, fs: fsSpy }), { replaced: true })
  assert.equal(renames.length, 1)
  assert.match(renames[0][0], new RegExp(`^${NATIVE.signHelper}\\.new-[0-9a-f]+$`))
  assert.equal(sha256(fs.readFileSync(dest)), sha256(packaged))
  assert.equal(fs.statSync(dest).mode & 0o777, 0o755)
  assert.deepEqual(installHelper({ dest, interactive: true, fs: fsSpy }), { replaced: false, why: 'same' })
  assert.equal(renames.length, 1, 'same hash: nothing written')

  fs.writeFileSync(dest, STUB, { mode: 0o755 }) // an older helper is installed (its key exists: create through it)
  keychainCustody({ helperPath: dest }).create({ subject: 'asight root (test)' })
  const r = installHelper({ dest, interactive: false, fs: fsSpy })
  assert.equal(r.replaced, false)
  assert.match(r.why, /differs/)
  assert.equal(fs.readFileSync(dest, 'utf8'), STUB, 'non-interactive: the installed copy stays')

  const issued = []
  const run = (file, args) => { issued.push([file, ...args]); return { status: 0, stdout: JSON.stringify(args[0] === 'exists' ? { exists: true } : { certDer: 'AA==' }), stderr: '' } }
  assert.deepEqual(installHelper({ dest, interactive: true, fs: fsSpy, run }), { replaced: true, prompted: 'signed' })
  assert.equal(sha256(fs.readFileSync(dest)), sha256(packaged))
  assert.deepEqual(issued.map((a) => a[1]), ['exists', 'issue'], 'one issue in the foreground, through the NEW helper')
  assert.ok(issued.every((a) => a[0] === dest))
  assert.deepEqual(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes('.new-')), [], 'no temp left')
})

test('installHelper: a packaged binary that is not the pinned one is refused before any write', () => {
  const dir = tmpDir('asight-bin-'), src = path.join(dir, 'fake'), dest = path.join(dir, 'bin', NATIVE.signHelper)
  fs.writeFileSync(src, 'not the helper')
  assert.throws(() => installHelper({ dest, interactive: true, src }), /is not the pinned asight-sign-helper/)
  assert.equal(fs.existsSync(dest), false)
})
