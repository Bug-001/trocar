// test/off/root-store.test.mjs — CM7, the argv half (RFC 4.11 P3, plan §E.5 #3): the user root store's commands, generated over
// platform × op with an injected runner. Exact argv; never `-p` (an unrestricted root, M7 / M8); `-user` on every certutil call;
// never LocalMachine or a system keychain; the certificate file it hands the tool is gone afterwards.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rootStore, rootIdOf } from '../../src/off/root-store.mjs'
import { custodyStub } from '../helpers/custody-stub.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { certutilModel } from '../helpers/certutil-model.mjs'

const stub = custodyStub(); const { rootDer } = stub.create()
const id = rootIdOf(rootDer)
const pemOf = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
const other = custodyStub(); other.create()
const FILE = '<file>'

// what each (platform, op) runs, with the store holding the root (present) or not
const KC = (home) => path.join(home, 'Library', 'Keychains', 'login.keychain-db')
const TRUST = (home) => path.join(home, '.trocar', 'collector', 'root-store-trust.plist')
// the user trust domain as `security trust-settings-export` writes it: trustList keyed by SHA-1; `deny` sets kSecTrustSettingsResult 3 (Deny)
const trustPlist = (sha1s, { deny = [] } = {}) => `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>trustList</key><dict>${sha1s.map((h) => `<key>${h.toUpperCase()}</key><dict><key>issuerName</key><data>AA==</data><key>trustSettings</key>${deny.includes(h) ? '<array><dict><key>kSecTrustSettingsResult</key><integer>3</integer></dict></array>' : '<array/>'}</dict>`).join('')}</dict><key>trustVersion</key><integer>1</integer></dict></plist>\n`
const expected = {
  darwin: {
    add: (home) => [['security', ['add-trusted-cert', '-r', 'trustRoot', '-k', KC(home), FILE]]],
    has: (home, present) => [['security', ['find-certificate', '-a', '-Z', '-p', KC(home)]], ...(present ? [['security', ['trust-settings-export', TRUST(home)]]] : [])],
    remove: (home, present) => [['security', ['find-certificate', '-a', '-Z', '-p', KC(home)]],
      ...(present ? [['security', ['remove-trusted-cert', FILE]], ['security', ['delete-certificate', '-Z', id.sha1, KC(home)]]] : [])],
  },
  win32: {
    add: () => [['certutil', ['-user', '-addstore', 'Root', FILE]]],
    has: () => [['certutil', ['-user', '-store', 'Root']]],
    remove: (home, present) => [['certutil', ['-user', '-store', 'Root']], ...(present ? [['certutil', ['-user', '-delstore', 'Root', id.sha1]]] : [])],
  },
}

function runner({ platform, present, files }) {
  const calls = [], win = certutilModel({ store: present ? [id.sha1] : [] })
  const run = (file, args) => {
    const a = args.map((x) => (x.endsWith('root-store-tmp.pem') ? (files.push(fs.readFileSync(x, 'utf8')), FILE) : x))
    calls.push([file, a])
    if (platform === 'darwin' && args[0] === 'trust-settings-export') { fs.writeFileSync(args[1], trustPlist([id.sha1])); return { status: 0, stdout: '' } }
    if (platform === 'darwin' && args[0] === 'find-certificate') return { status: 0, stdout: `SHA-1 hash: X\n${pemOf(other.rootDer)}${present ? `SHA-1 hash: ${id.sha1}\n${pemOf(rootDer)}` : ''}` }
    if (platform === 'win32') return win.run(file, args)
    return { status: 0, stdout: '' }
  }
  return { run, calls }
}

for (const platform of ['darwin', 'win32']) {
  for (const op of ['add', 'has', 'remove']) {
    for (const present of [true, false]) {
      test(`CM7 ${platform} ${op} (${present ? 'in the store' : 'not in the store'}): exact argv, user store only, no -p`, () => {
        const home = tmpDir('trocar-rs-')
        const files = []
        const { run, calls } = runner({ platform, present, files })
        const store = rootStore({ platform, run, home })
        const out = op === 'add' ? store.add(rootDer) : store[op](id)
        assert.deepEqual(calls, expected[platform][op](home, present))
        for (const [, args] of calls) {
          assert.ok(!args.includes('-p') || args[0] === 'find-certificate', 'no -p on a trust write') // find-certificate's -p prints PEM
          assert.ok(!args.some((a) => /localmachine|System\.keychain|-d$/i.test(a)), `a machine store: ${args.join(' ')}`)
          if (platform === 'win32') assert.equal(args[0], '-user')
        }
        for (const f of files) assert.equal(f, pemOf(rootDer), 'the file handed over is the root')
        assert.ok(!fs.existsSync(path.join(home, '.trocar', 'collector', 'root-store-tmp.pem')), 'the temp file is gone')
        assert.ok(!fs.existsSync(TRUST(home)), 'the exported trust settings are gone')
        if (op === 'has') assert.deepEqual(out, { present })
        else if (op === 'remove' && !present) assert.deepEqual(out, { ok: true, absent: true })
        else assert.deepEqual(out, { ok: true })
      })
    }
  }
}

test('CM7 a failing tool is a reason, never a throw; Linux has no user root store; Windows needs the thumbprint', () => {
  const home = tmpDir('trocar-rs-')
  const run = () => ({ status: 5, stderr: 'User canceled' })
  assert.deepEqual(rootStore({ platform: 'darwin', run, home }).add(rootDer), { ok: false, reason: 'security add-trusted-cert failed (exit 5: User canceled)' })
  assert.match(rootStore({ platform: 'darwin', run, home }).has(id).error, /find-certificate failed/)
  assert.equal(rootStore({ platform: 'win32', run, home }).add(rootDer).ok, false)
  assert.throws(() => rootStore({ platform: 'linux', run, home }), /no user root store/)
  assert.throws(() => rootStore({ platform: 'win32', run, home }).has({ fp256: id.fp256 }), /thumbprint/)
})

// win32: membership is the user's store listed and searched by thumbprint. The lookup of one thumbprint exits NTE_NOT_FOUND on a
// Windows test machine (certutilModel), which the old exit-code reading took for an error: install then never added the root. Generated over the listing's
// shapes; a listing that did not succeed (spawn failure / timeout: status null, any other exit) is an error, never "absent", and remove
// never runs -delstore then (D38).
const other1 = rootIdOf(other.rootDer).sha1
for (const [label, opts, present] of [['empty', { store: [] }, false], ['other roots only', { store: [other1] }, false], ['it among others', { store: [other1, id.sha1] }, true], ['it, the older spaced hash', { store: [id.sha1], spaced: true }, true], ['others, spaced', { store: [other1], spaced: true }, false]]) {
  test(`CM7 win32 has / remove over the real certutil, the user's store ${label} → present ${present}`, () => {
    const m = certutilModel(opts)
    const store = rootStore({ platform: 'win32', run: m.run, home: tmpDir('trocar-rs-') })
    assert.deepEqual(store.has(id), { present })
    assert.deepEqual(store.remove(id), present ? { ok: true } : { ok: true, absent: true })
    assert.equal(m.store.has(id.sha1.toUpperCase()), false)
    assert.equal(m.store.has(other1.toUpperCase()), opts.store.includes(other1))
  })
}
test('CM7 win32 install path over the real certutil: absent → add → present (the old lookup read absent as an error and never added)', () => {
  const m = certutilModel()
  const store = rootStore({ platform: 'win32', run: m.run, home: tmpDir('trocar-rs-') })
  assert.deepEqual(store.has(id), { present: false })
  assert.deepEqual(store.add(rootDer), { ok: true })
  assert.deepEqual(store.has(id), { present: true })
})
for (const [what, status] of [['a spawn failure or timeout', null], ['an unexpected exit', 5], ['access denied', 0x80070005], ['access denied, signed', 0x80070005 | 0]]) {
  test(`CM7 win32 has / remove with ${what}: an error, never "absent"`, () => {
    const home = tmpDir('trocar-rs-')
    const calls = []
    const run = (file, args) => { calls.push(args[1]); return { status, stderr: 'boom' } }
    const store = rootStore({ platform: 'win32', run, home })
    assert.match(store.has(id).error, /certutil -user -store failed/)
    const out = store.remove(id)
    assert.equal(out.ok, false); assert.match(out.reason, /certutil -user -store failed/)
    assert.ok(!calls.includes('-delstore'))
  })
}

// D38 · CM7: on macOS `present` means TRUSTED. add-trusted-cert imports the certificate before it asks; a declined or ignored prompt leaves it in the
// login keychain with no trust setting, and an install that read that as present would record the root and never ask again (every root-only
// form then fails its handshake). Generated over the trust domain's states; only a setting for this SHA-1 that is not Deny is present.
const TRUST_AXIS = [
  ['a setting for it', { status: 0, sha1s: () => [id.sha1] }, { present: true }],
  ['a setting for it, lower-case key', { status: 0, sha1s: () => [id.sha1.toLowerCase()] }, { present: true }],
  ['no user trust settings at all', { status: 1, stderr: 'SecTrustSettingsCreateExternalRepresentation: No Trust Settings were found.' }, { present: false }],
  ['settings for other certificates only', { status: 0, sha1s: () => ['0'.repeat(40), rootIdOf(other.rootDer).sha1] }, { present: false }],
  ['a Deny setting for it', { status: 0, sha1s: () => [id.sha1], deny: () => [id.sha1] }, { present: false }],
  ['a Deny setting for the next one only', { status: 0, sha1s: () => [id.sha1, '0'.repeat(40)], deny: () => ['0'.repeat(40)] }, { present: true }],
]
for (const [label, ans, want] of TRUST_AXIS) {
  test(`CM7 darwin has, imported with ${label} → ${JSON.stringify(want)}`, () => {
    const home = tmpDir('trocar-rs-')
    const run = (file, args) => {
      if (args[0] === 'find-certificate') return { status: 0, stdout: `SHA-1 hash: ${id.sha1}\n${pemOf(rootDer)}` }
      if (args[0] === 'trust-settings-export') { if (ans.status === 0) fs.writeFileSync(args[1], trustPlist(ans.sha1s(), { deny: ans.deny ? ans.deny() : [] })); return { status: ans.status, stdout: '', stderr: ans.stderr || '' } }
      throw new Error(`unexpected ${args.join(' ')}`)
    }
    assert.deepEqual(rootStore({ platform: 'darwin', run, home }).has(id), want)
    assert.ok(!fs.existsSync(TRUST(home)))
  })
}
test('CM7 darwin has: a trust export that fails for another reason is an error, never "absent" (D38)', () => {
  const run = (file, args) => (args[0] === 'find-certificate' ? { status: 0, stdout: pemOf(rootDer) } : { status: 36, stderr: 'interaction not allowed' })
  assert.match(rootStore({ platform: 'darwin', run, home: tmpDir('trocar-rs-') }).has(id).error, /trust-settings-export failed \(exit 36/)
})
