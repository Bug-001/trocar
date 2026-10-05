// test/collector/core/bundle.test.mjs — acceptance T14 (RFC 4.6 「合并包」): what goes into combined-<h>.pem (roots,
// that harness's user CAs, the asight CA; certificate blocks only, the rest named), the atomic rebuild when the roots
// change, the rewrite without the asight CA at uninstall, and isolation between harnesses.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { certsOf, composeBundle, rewriteBundles, rootsFingerprint, userCertsIn } from '../../../src/collector/core/trust/bundle.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { newManifest, readManifest } from '../../../src/collector/core/trust/journal.mjs'

const mk = (cn) => createCa({ commonName: cn })
const ASIGHT = mk('asight collector CA'); const R1 = mk('root one'); const R2 = mk('root two'); const OS1 = mk('os root'); const CORP = mk('corp CA'); const OTHER = mk('other corp CA')
const fps = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p).fingerprint256)
const fp = (ca) => new X509Certificate(ca.certPem).fingerprint256
const KEY = '-----BEGIN PRIVATE KEY-----\nU0VDUkVULUtFWQ==\n-----END PRIVATE KEY-----'

test('T14: from a user CA file only CERTIFICATE blocks are taken; every other block and a DER file are named by type and file', () => {
  const mixed = `${KEY}\n${CORP.certPem}\n-----BEGIN TRUSTED CERTIFICATE-----\nAAAA\n-----END TRUSTED CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nnot base64 der\n-----END CERTIFICATE-----\n`
  const r = certsOf('/corp/mixed.pem', mixed)
  assert.deepEqual(r.certs.map((p) => new X509Certificate(p).fingerprint256), [fp(CORP)])
  assert.deepEqual(r.skipped, [{ file: '/corp/mixed.pem', type: 'PRIVATE KEY' }, { file: '/corp/mixed.pem', type: 'TRUSTED CERTIFICATE' }, { file: '/corp/mixed.pem', type: 'CERTIFICATE (unparsable)' }])
  assert.deepEqual(certsOf('/corp/ca.der', Buffer.from([0x30, 0x82, 0x01, 0x0a])).skipped, [{ file: '/corp/ca.der', type: 'DER or other non-PEM content' }])
})

test('T14: a bundle is Node roots + OS roots + the user CAs + the asight CA, each once; the user CAs are remembered by fingerprint', () => {
  const b = composeBundle({ nodeRoots: [R1.certPem, R2.certPem], osRootsText: `${OS1.certPem}\n${R1.certPem}`, userCerts: [CORP.certPem, R2.certPem], caPem: ASIGHT.certPem })
  assert.deepEqual(fps(b.data), [fp(R1), fp(R2), fp(OS1), fp(CORP), fp(ASIGHT)])
  assert.deepEqual(b.user_fps, [fp(CORP), fp(R2)], 'a user CA that is also a root today is still the user\'s')
  assert.equal(b.roots_fp, rootsFingerprint([R1.certPem, R2.certPem], `${OS1.certPem}\n${R1.certPem}`))
  assert.ok(!b.data.includes('PRIVATE KEY'))
  assert.deepEqual(userCertsIn(b.data, b.user_fps).map((p) => new X509Certificate(p).fingerprint256), [fp(R2), fp(CORP)])
})

test('T14: roots that changed rebuild each bundle atomically (temp + rename) with its own user CAs; unchanged roots leave it; uninstall rewrites it without the asight CA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-b-'))
  try {
    const dir = path.join(root, 'collector'); fs.mkdirSync(path.join(dir, 'ca'), { recursive: true })
    const m = newManifest()
    const put = (h, user) => {
      const b = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: [user.certPem], caPem: ASIGHT.certPem })
      const f = path.join(dir, 'ca', `combined-${h}.pem`); fs.writeFileSync(f, b.data)
      m.files.push({ path: f, role: 'bundle', harness: h, user_fps: b.user_fps, roots_fp: b.roots_fp })
      return f
    }
    const a = put('alpha', CORP); const z = put('zeta', OTHER)
    const env = path.join(root, '.alpha.env'); fs.writeFileSync(env, `SSL_CERT_FILE=${a}\n`)
    assert.deepEqual(rewriteBundles({ dir, manifest: m, nodeRoots: [R1.certPem], osRootsText: '', caPem: ASIGHT.certPem }), [], 'same roots: nothing rewritten')
    const calls = []
    const spy = { ...fs, openSync: (p, ...r) => { calls.push(['open', path.basename(p)]); return fs.openSync(p, ...r) }, renameSync: (x, y) => { calls.push(['rename', path.basename(x), path.basename(y)]); return fs.renameSync(x, y) } }
    assert.deepEqual(rewriteBundles({ dir, manifest: m, nodeRoots: [R1.certPem, R2.certPem], osRootsText: OS1.certPem, caPem: ASIGHT.certPem, fs: spy }), [a, z])
    assert.ok(calls.some((c) => c[0] === 'rename' && c[2] === 'combined-alpha.pem' && /asight-tmp/.test(c[1])), `written to a temp file, then renamed over: ${JSON.stringify(calls)}`)
    assert.ok(!calls.some((c) => c[0] === 'open' && c[1] === 'combined-alpha.pem'), 'the bundle itself is never opened for writing: a reader sees the old file or the new one')
    assert.deepEqual(fps(fs.readFileSync(a, 'utf8')), [fp(R1), fp(R2), fp(OS1), fp(CORP), fp(ASIGHT)])
    assert.ok(!fps(fs.readFileSync(a, 'utf8')).includes(fp(OTHER)) && !fps(fs.readFileSync(z, 'utf8')).includes(fp(CORP)), 'harness A\'s CA never reaches B\'s bundle')
    assert.equal(readManifest(dir).files[0].roots_fp, rootsFingerprint([R1.certPem, R2.certPem], OS1.certPem))
    assert.equal(fs.readFileSync(env, 'utf8'), `SSL_CERT_FILE=${a}\n`, 'a rebuild never touches an entry file')
    rewriteBundles({ dir, manifest: m, nodeRoots: [R1.certPem, R2.certPem], osRootsText: OS1.certPem, caPem: ASIGHT.certPem, withCa: false })
    assert.deepEqual(fps(fs.readFileSync(a, 'utf8')), [fp(R1), fp(R2), fp(OS1), fp(CORP)], 'the same bundle without the asight CA: the user\'s relay still works')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('T14 through the plan: each harness\'s bundle carries only its own CAs; a private key in a user file reaches nothing under the collector dir', () => {
  const DIR = '/h/.asight/collector'
  const files = { '/a/ca.pem': `${KEY}\n${CORP.certPem}`, '/b/ca.pem': OTHER.certPem }
  const harness = (name, src) => ({ name, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] }, inject: () => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: `/h/.${name}/.env`, vars: { SSL_CERT_FILE: `${DIR}/ca/combined-${name}.pem` }, semantic: 'replace' }], files: [{ path: `${DIR}/ca/combined-${name}.pem`, bundle: true, certsFrom: [src] }] }) })
  const p = planTrust({ descriptors: [harness('alpha', '/a/ca.pem'), harness('beta', '/b/ca.pem')], ctxFor: () => ({ readText: (f) => files[f] ?? null }), caCertPem: ASIGHT.certPem, collectorDir: DIR, roots: { node: [R1.certPem], osText: OS1.certPem } })
  const [a, b] = p.files
  assert.deepEqual([a.role, fps(a.data)], ['bundle', [fp(R1), fp(OS1), fp(CORP), fp(ASIGHT)]])
  assert.deepEqual(fps(b.data), [fp(R1), fp(OS1), fp(OTHER), fp(ASIGHT)])
  assert.deepEqual([a.sources, a.user_fps], [['/a/ca.pem'], [fp(CORP)]])
  assert.ok(!JSON.stringify(p.files).includes('U0VDUkVULUtFWQ'), 'the private key is nowhere in what will be written')
  assert.deepEqual(p.records.filter((r) => r.code === 'cert-not-merged').map((r) => [r.harness, /\/a\/ca\.pem: a PRIVATE KEY block/.test(r.reason)]), [['alpha', true]])
})
