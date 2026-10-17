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
  assert.deepEqual(r.skipped, [{ file: '/corp/mixed.pem', type: 'PRIVATE KEY', index: 1, why: 'a private key is never copied' }, { file: '/corp/mixed.pem', type: 'TRUSTED CERTIFICATE', index: 3, why: 'only CERTIFICATE blocks are carried over' }, { file: '/corp/mixed.pem', type: 'CERTIFICATE', index: 4, why: 'it does not parse as a certificate' }], 'named by type and position, never by content (D-28)')
  assert.deepEqual(certsOf('/corp/ca.der', Buffer.from([0x30, 0x82, 0x01, 0x0a])).skipped, [{ file: '/corp/ca.der', type: null, index: null, why: 'it holds no PEM block (a DER file, or not a certificate file)' }])
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
      m.files.push({ path: f, role: 'bundle', phase: 'install', harness: h, user_fps: b.user_fps, roots_fp: b.roots_fp })
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

test('T14 / D38 F1(d): a bundle that is missing or unreadable is rebuilt from the recorded user CA files; one that cannot be written is reported, its old file untouched, the other bundles still rebuilt', { skip: process.getuid && process.getuid() === 0 ? 'root ignores file modes' : false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-b-'))
  try {
    const dir = path.join(root, 'collector'); const ca = path.join(dir, 'ca'); fs.mkdirSync(ca, { recursive: true })
    const corp = path.join(root, 'corp.pem'); fs.writeFileSync(corp, `${KEY}\n${CORP.certPem}\n`)
    const m = newManifest()
    const put = (h, src) => {
      const b = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: src ? [CORP.certPem] : [], caPem: ASIGHT.certPem })
      const f = path.join(ca, `combined-${h}.pem`); fs.writeFileSync(f, b.data)
      m.files.push({ path: f, role: 'bundle', phase: 'install', harness: h, user_fps: b.user_fps, roots_fp: b.roots_fp, ...(src ? { sources: [src] } : {}) })
      return f
    }
    const a = put('alpha', corp); const z = put('zeta', null); const y = put('yota', null)
    const args = { dir, manifest: m, nodeRoots: [R1.certPem], osRootsText: '', caPem: ASIGHT.certPem }
    // a deleted bundle and an unreadable one come back with their harness's user CA (from its source file) and the asight CA
    fs.rmSync(a); fs.chmodSync(z, 0o000)
    const report = { rebuilt: [], failed: [] }
    assert.deepEqual(rewriteBundles({ ...args, report }), [a, z].sort(), 'same roots, yet the two that cannot be read are rebuilt')
    assert.deepEqual(report.rebuilt.map((r) => [r.harness, r.why]).sort(), [['alpha', 'ENOENT'], ['zeta', 'EACCES']])
    assert.deepEqual(fps(fs.readFileSync(a, 'utf8')), [fp(R1), fp(CORP), fp(ASIGHT)], 'alpha: its own user CA, from the recorded source, never the private key in that file')
    assert.ok(!fs.readFileSync(a, 'utf8').includes('PRIVATE KEY'))
    assert.deepEqual(fps(fs.readFileSync(z, 'utf8')), [fp(R1), fp(ASIGHT)], 'zeta had no user CA')
    assert.deepEqual(m.files[0].user_fps, [fp(CORP)], 'the manifest follows the rebuild')
    // at uninstall (withCa:false) a bundle that is already gone has nothing to rewrite
    fs.rmSync(y)
    assert.deepEqual(rewriteBundles({ ...args, withCa: false }).includes(y), false)
    assert.ok(!fs.existsSync(y), 'uninstall never recreates a bundle')
    for (const f of m.files) delete f.without_ca // the rewrite above flagged them as kept without the CA; `on` clears that (D39), and what follows is the daemon's rebuild of a harness that is on
    // a rebuild that cannot write: reported with the bundle, the old file as it was, the rest still done
    fs.chmodSync(ca, 0o555)
    try {
      const before = fs.readFileSync(z, 'utf8')
      fs.chmodSync(z, 0o600) // readable, stale: its roots changed
      const r2 = { rebuilt: [], failed: [] }
      rewriteBundles({ ...args, nodeRoots: [R1.certPem, R2.certPem], report: r2 })
      assert.deepEqual([r2.failed.map((f) => [f.harness, f.error.code]).sort(), r2.rebuilt], [[['alpha', 'EACCES'], ['yota', 'EACCES'], ['zeta', 'EACCES']], []], 'every bundle that could not be written is listed, none silently skipped')
      assert.equal(fs.readFileSync(z, 'utf8'), before, 'the old file is untouched')
      assert.throws(() => rewriteBundles({ ...args, nodeRoots: [R1.certPem, R2.certPem] }), /EACCES/, 'without a report the first failure throws, as uninstall wants')
    } finally { fs.chmodSync(ca, 0o700) }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// RV-2 (review): at uninstall (withCa:false) "gone" is ENOENT and only ENOENT. A bundle that is there but cannot be read
// (EACCES, EIO, EISDIR, …) still holds the asight CA: skipping it let uninstall say "uninstalled" over a live process's trust
// root. It is a failure of its own — reported with the bundle and the errno, the file untouched, the others still rewritten —
// and without a report the first one throws. An injected fs, so it holds for root too.
test('T14 / D38 (RV-2): uninstall step 2 skips a bundle that is gone (ENOENT), and only that: one that cannot be read is a failure, its file untouched, the rest rewritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-b-'))
  try {
    const dir = path.join(root, 'collector'); const ca = path.join(dir, 'ca'); fs.mkdirSync(ca, { recursive: true })
    const m = newManifest()
    const put = (h) => {
      const b = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: [CORP.certPem], caPem: ASIGHT.certPem })
      const f = path.join(ca, `combined-${h}.pem`); fs.writeFileSync(f, b.data)
      m.files.push({ path: f, role: 'bundle', phase: 'install', harness: h, user_fps: b.user_fps, roots_fp: b.roots_fp })
      return f
    }
    const a = put('alpha'); const z = put('zeta'); const y = put('yota')
    fs.rmSync(y)
    const before = fs.readFileSync(z, 'utf8')
    const readsAs = (code) => ({ ...fs, readFileSync: (p, ...r) => { if (p === z) throw Object.assign(new Error(`${code}: cannot read`), { code }); return fs.readFileSync(p, ...r) } })
    const args = { dir, manifest: m, nodeRoots: [R1.certPem], osRootsText: '', caPem: ASIGHT.certPem, withCa: false }
    for (const code of ['EACCES', 'EIO', 'EISDIR']) {
      const report = { rebuilt: [], failed: [] }
      assert.deepEqual(rewriteBundles({ ...args, report, fs: readsAs(code) }), [a], `${code}: only the readable one is rewritten`)
      assert.deepEqual(report.failed.map((f) => [f.harness, f.path, f.error.code]), [['zeta', z, code]], `${code}: the unreadable one is listed with its errno, not skipped`)
      assert.match(report.failed[0].error.message, /not rewritten without the asight CA/)
      assert.equal(fs.readFileSync(z, 'utf8'), before, 'its file is untouched: it still holds the asight CA, and the caller must say so')
      assert.ok(fps(fs.readFileSync(z, 'utf8')).includes(fp(ASIGHT)))
      assert.ok(!fs.existsSync(y), 'a bundle that is already gone is still not recreated')
    }
    assert.deepEqual(fps(fs.readFileSync(a, 'utf8')), [fp(R1), fp(CORP)], 'alpha: the same bundle without the asight CA')
    assert.throws(() => rewriteBundles({ ...args, fs: readsAs('EACCES') }), (e) => e.code === 'EACCES' && /not rewritten without the asight CA/.test(e.message), 'without a report it throws, as it did before the rebuild feature')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// RV-3 (review): a bundle that went missing is rebuilt from the user CA files the install recorded; a file that moved leaves
// its CA out of the rebuilt bundle. That is right for Node, the OS and asight, but an agent that REPLACES its roots with the
// bundle can no longer reach a relay signed by that CA, and the manifest's user_fps fell from 1 to 0 with nothing said. The
// report now carries each bundle's lost fingerprints, and each unreadable source with its errno (the daemon records it).
test('T14 / D38 (RV-3): a bundle rebuilt without a user CA it held reports the lost fingerprints and each unreadable source; nothing is reported when nothing was lost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-b-'))
  try {
    const dir = path.join(root, 'collector'); const ca = path.join(dir, 'ca'); fs.mkdirSync(ca, { recursive: true })
    const m = newManifest()
    const put = (h, src, certs) => {
      const b = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: certs, caPem: ASIGHT.certPem })
      const f = path.join(ca, `combined-${h}.pem`); fs.writeFileSync(f, b.data)
      m.files.push({ path: f, role: 'bundle', phase: 'install', harness: h, user_fps: b.user_fps, roots_fp: b.roots_fp, ...(src ? { sources: [src] } : {}) })
      return f
    }
    const srcs = {}; for (const h of ['moved', 'kept', 'edited', 'none']) srcs[h] = path.join(root, `${h}.pem`)
    fs.writeFileSync(srcs.kept, CORP.certPem); fs.writeFileSync(srcs.edited, `${OTHER.certPem}\n`) // 'edited': the file is there, the CA is not in it any more
    const files = { moved: put('moved', srcs.moved, [CORP.certPem]), kept: put('kept', srcs.kept, [CORP.certPem]), edited: put('edited', srcs.edited, [CORP.certPem]), none: put('none', srcs.none, []) }
    for (const f of Object.values(files)) fs.rmSync(f) // every bundle deleted
    const report = { rebuilt: [], failed: [] }
    rewriteBundles({ dir, manifest: m, nodeRoots: [R1.certPem], osRootsText: '', caPem: ASIGHT.certPem, report })
    assert.deepEqual(report.rebuilt.map((r) => r.harness).sort(), ['edited', 'kept', 'moved', 'none'])
    assert.deepEqual(report.lost.map((l) => [l.harness, l.path, l.fps, l.sources]).sort((p, q) => p[0].localeCompare(q[0])), [
      ['edited', files.edited, [fp(CORP)], []], // readable, but the certificate is gone from it: no unreadable source to blame
      ['moved', files.moved, [fp(CORP)], [{ file: srcs.moved, errno: 'ENOENT' }]],
    ], 'moved: named with the errno of its source; kept and none: nothing lost, nothing said')
    assert.deepEqual(fps(fs.readFileSync(files.moved, 'utf8')), [fp(R1), fp(ASIGHT)], 'the bundle is still right for Node, the OS and asight')
    assert.deepEqual(m.files.find((f) => f.harness === 'moved').user_fps, [], 'the manifest follows the rebuild (which is why the report is the only record of the loss)')
    // no report, no `lost`: a caller that does not ask for one is not handed a field to ignore
    fs.rmSync(files.kept)
    assert.doesNotThrow(() => rewriteBundles({ dir, manifest: m, nodeRoots: [R1.certPem], osRootsText: '', caPem: ASIGHT.certPem }))
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
  assert.deepEqual(p.records.filter((r) => r.code === 'cert-not-merged').map((r) => [r.harness, /\/a\/ca\.pem: block 1 \(PRIVATE KEY\) is not carried over/.test(r.reason)]), [['alpha', true]])
})

// 4.6 「合并包」 / D39: `off` keeps a bundle a live process may hold as the same file without the asight CA (`without_ca`); the daemon's rebuild (roots changed,
// or the file went missing) is for a harness whose desired state is on, and MUST NOT write the CA back into one `off` stripped. `force` — what `on` uses when
// it turns the harness on again — does.
test('D39: a bundle off kept without the asight CA is not rebuilt back with it by the daemon\'s rebuild, whether the roots changed or the file went missing; force rebuilds it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-b-'))
  try {
    const dir = path.join(root, 'collector'); fs.mkdirSync(path.join(dir, 'ca'), { recursive: true })
    const m = newManifest()
    const stripped = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: [CORP.certPem], caPem: null })
    const kept = path.join(dir, 'ca', 'combined-kept.pem'); fs.writeFileSync(kept, stripped.data)
    const live = path.join(dir, 'ca', 'combined-live.pem'); const lb = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: [CORP.certPem], caPem: ASIGHT.certPem }); fs.writeFileSync(live, lb.data)
    m.files.push({ path: kept, role: 'bundle', phase: 'install', harness: 'kept', user_fps: stripped.user_fps, roots_fp: stripped.roots_fp, without_ca: true }, { path: live, role: 'bundle', phase: 'install', harness: 'live', user_fps: lb.user_fps, roots_fp: lb.roots_fp })
    const args = { dir, manifest: m, nodeRoots: [R1.certPem, R2.certPem], osRootsText: '', caPem: ASIGHT.certPem }
    assert.deepEqual(rewriteBundles(args), [live], 'the roots changed: the bundle of a harness that is on is rebuilt, the stripped one is not')
    assert.deepEqual(fps(fs.readFileSync(kept, 'utf8')), [fp(R1), fp(CORP)], 'still without the asight CA, and with its old roots')
    fs.rmSync(kept)
    assert.deepEqual(rewriteBundles({ ...args, report: { rebuilt: [], failed: [] } }), [], 'gone: not made again either — nothing of asight\'s is meant to be there')
    assert.ok(!fs.existsSync(kept))
    assert.deepEqual(rewriteBundles({ ...args, force: true }), [kept, live], 'force: `on` writes it back, with the CA (and the flag goes)')
    assert.ok(fps(fs.readFileSync(kept, 'utf8')).includes(fp(ASIGHT)) && m.files[0].without_ca === undefined)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 4.6 「合并包」: the rebuild is for the harnesses whose desired state is on (`only`, a Set the daemon makes from state.json); a bundle of another harness is
// left as it is, a missing one too (`off` took it), a bundle with no harness is rebuilt as ever, `force` (`on`) and uninstall (`withCa: false`) are not limited by it.
test('D39: only= limits the daemon\'s rebuild to the harnesses that are on — a bundle of another harness is not rebuilt, not even when it is missing; force and uninstall ignore it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-b-'))
  try {
    const dir = path.join(root, 'collector'); fs.mkdirSync(path.join(dir, 'ca'), { recursive: true })
    const m = newManifest()
    const b = composeBundle({ nodeRoots: [R1.certPem], osRootsText: '', userCerts: [CORP.certPem], caPem: ASIGHT.certPem })
    const put = (name, harness) => { const f = path.join(dir, 'ca', `combined-${name}.pem`); fs.writeFileSync(f, b.data); m.files.push({ path: f, role: 'bundle', phase: 'install', ...(harness ? { harness } : {}), user_fps: b.user_fps, roots_fp: b.roots_fp }); return f }
    const [on, off, orphan] = [put('on', 'on'), put('off', 'off'), put('orphan', null)]
    const args = { dir, manifest: m, nodeRoots: [R1.certPem, R2.certPem], osRootsText: '', caPem: ASIGHT.certPem }
    assert.deepEqual(rewriteBundles({ ...args, only: new Set(['on']) }), [on, orphan], 'roots changed: the harness that is on, and the one bundle with no harness')
    assert.deepEqual(fps(fs.readFileSync(off, 'utf8')), [fp(R1), fp(CORP), fp(ASIGHT)], 'the other harness\'s bundle is as it was')
    fs.rmSync(off)
    assert.deepEqual(rewriteBundles({ ...args, only: new Set(['on']), nodeRoots: [R1.certPem] }).includes(off), false)
    assert.ok(!fs.existsSync(off), 'missing, and not its harness\'s to rebuild: not made again')
    assert.deepEqual(rewriteBundles({ ...args, force: true, only: new Set(['on']) }).includes(off), true, 'force (`on`) is not limited')
    assert.deepEqual(rewriteBundles({ ...args, nodeRoots: [R2.certPem], only: new Set() }), [orphan], 'nothing is on: only the bundle that names no harness follows the roots')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
