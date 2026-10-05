// test/collector/core/trust.test.mjs — acceptance T12, generic half (harness halves: Tasks 8 and 10).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { createTrustChecker, effectiveEnv, fingerprintsInBundle, certBlocks } from '../../../src/collector/core/trust/confirm.mjs'

const asight = createCa({ commonName: 'asight collector CA' })
const other = createCa({ commonName: 'someone else' })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-trust-'))
const file = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f }
const ONLY = file('asight.pem', asight.certPem)
const MERGED = file('merged.pem', other.certPem + '\n' + asight.certPem) // "system roots + asight CA"
const FOREIGN = file('foreign.pem', other.certPem)
const env = (o) => new Map(Object.entries(o))
const additive = { chain: [{ var: 'EXTRA_CA', semantic: 'append' }] }
const replacing = { chain: ['TOP_BUNDLE', 'CERT_FILE', 'REQ_BUNDLE'].map((v) => ({ var: v, semantic: 'replace' })) }
const explicitCa = { chain: [{ var: 'AGENT_CA', semantic: 'replace', emptyStops: true }, { var: 'cfg:caFile', semantic: 'replace' }, { var: 'EXTRA_CA', semantic: 'append' }] }
const checker = createTrustChecker({ caCertPem: asight.certPem })
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('trust: a merged bundle holding the asight CA is trusted by fingerprint, not by path', () => {
  const r = checker.check(replacing, { environ: env({ CERT_FILE: MERGED }) })
  assert.deepEqual([r.trusted, r.reason, r.var, r.via, r.file], [true, 'ok', 'CERT_FILE', 'environ', MERGED])
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: ONLY }) }).trusted, true)
})

test('trust: a higher-precedence replace source without the CA shadows one that has it', () => {
  const r = checker.check(replacing, { environ: env({ TOP_BUNDLE: FOREIGN, CERT_FILE: MERGED }) })
  assert.deepEqual([r.trusted, r.reason, r.var], [false, 'shadowed', 'TOP_BUNDLE'])
})

test('trust: missing, unreadable, replace-without-CA and append-without-CA each report their reason', () => {
  assert.equal(checker.check(additive, { environ: env({}) }).reason, 'var-missing')
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: '' }) }).reason, 'var-missing')
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: path.join(tmp, 'gone.pem') }) }).reason, 'file-unreadable')
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: FOREIGN }) }).reason, 'ca-not-in-file')
  assert.equal(checker.check(replacing, { environ: env({ CERT_FILE: FOREIGN }) }).reason, 'replace-without-ca')
})

test('trust: an append counts only while no replace source is in effect', () => {
  const r = checker.check(explicitCa, { environ: env({ AGENT_CA: FOREIGN, EXTRA_CA: ONLY }) })
  assert.deepEqual([r.trusted, r.reason, r.var], [false, 'shadowed', 'AGENT_CA'])
  assert.equal(checker.check(explicitCa, { environ: env({ EXTRA_CA: ONLY }) }).trusted, true)
})

test('trust: an empty emptyStops source disables lower replace sources but keeps appends', () => {
  const layer = { name: 'cfg', mode: 'override', vars: { 'cfg:caFile': MERGED } }
  const a = checker.check(explicitCa, { environ: env({ AGENT_CA: '' }), layers: [layer] })
  assert.deepEqual([a.trusted, a.reason, a.var], [false, 'shadowed', 'AGENT_CA'])
  assert.equal(checker.check(explicitCa, { environ: env({ AGENT_CA: '', EXTRA_CA: ONLY }) }).trusted, true)
  assert.equal(checker.check(explicitCa, { environ: env({}), layers: [layer] }).via, 'cfg')
})

test('trust: an override layer beats environ; a fill layer only supplies what environ lacks', () => {
  const dotenv = { name: '~/.app/.env', mode: 'override', vars: { CERT_FILE: MERGED } }
  assert.deepEqual(Object.values(pick(checker.check(replacing, { environ: env({ CERT_FILE: FOREIGN }), layers: [dotenv] }))), [true, '~/.app/.env'])
  const fill = { name: 'fallback', mode: 'fill', vars: { EXTRA_CA: ONLY } }
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: FOREIGN }), layers: [fill] }).trusted, false)
  assert.equal(checker.check(additive, { environ: env({}), layers: [fill] }).trusted, true)
})
const pick = (r) => ({ trusted: r.trusted, via: r.via })

test('trust: a non-live layer edited after the process started is not believed (config-after-start)', () => {
  const layer = { name: '~/.app/.env', mode: 'override', vars: { CERT_FILE: MERGED }, live: false, mtimeMs: 2_000 }
  const before = checker.check(replacing, { environ: env({}), layers: [layer], startedAt: 3_000 })
  assert.equal(before.trusted, true)
  const after = checker.check(replacing, { environ: env({}), layers: [layer], startedAt: 1_000 })
  assert.deepEqual([after.trusted, after.reason], [false, 'config-after-start'])
  assert.equal(checker.check(replacing, { environ: env({}), layers: [{ ...layer, live: true }], startedAt: 1_000 }).trusted, true)
})

test('trust: an ignored layer is left out and named when it would have granted trust', () => {
  const layer = { name: 'settings env', mode: 'override', vars: { EXTRA_CA: ONLY }, ignored: 'settings-ignored' }
  const r = checker.check(additive, { environ: env({}), layers: [layer] })
  assert.deepEqual([r.trusted, r.reason], [false, 'settings-ignored'])
})

test('trust: a disable switch set to false is verify-disabled, not trusted (gate G10)', () => {
  const spec = { ...replacing, disable: ['cfg:ssl_verify'] }
  const r = checker.check(spec, { environ: env({ CERT_FILE: MERGED }), layers: [{ name: 'cfg', mode: 'override', vars: { 'cfg:ssl_verify': 'false' } }] })
  assert.deepEqual([r.trusted, r.reason], [false, 'verify-disabled'])
})

test('trust: refine lets a harness rename a reason (it sees env and argv); relative paths resolve against the process cwd', () => {
  const spec = { ...explicitCa, refine: (r, e) => (r.var === 'AGENT_CA' && e.get('AGENT_CA') === e.get('cfg:desktop')) ? 'desktop-ca-override' : null }
  const r = checker.check(spec, { environ: env({ AGENT_CA: FOREIGN }), layers: [{ name: 'desk', mode: 'override', vars: { 'cfg:desktop': FOREIGN } }] })
  assert.equal(r.reason, 'desktop-ca-override')
  const byArgv = { ...additive, refine: (res, e, { argv }) => (argv.includes('--pure') ? 'plugins-skipped' : null) }
  assert.equal(checker.check(byArgv, { environ: env({}), argv: ['app', '--pure'] }).reason, 'plugins-skipped')
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: 'merged.pem' }), cwd: tmp }).trusted, true)
})

test('trust: every applicable variant must trust; a `when` variant applies only when its variable is set', () => {
  const spec = {
    chain: [{ var: 'CERT_FILE', semantic: 'append' }],
    variants: [
      { name: 'other build', chain: [{ var: 'TOP_BUNDLE', semantic: 'replace' }, { var: 'CERT_FILE', semantic: 'replace' }] },
      { name: 'per-route files', when: 'cfg:route_ca', chain: [{ var: 'cfg:route_ca', semantic: 'replace', list: true }] },
    ],
  }
  const route = (v) => [{ name: 'cfg', mode: 'override', vars: { 'cfg:route_ca': v } }]
  assert.equal(checker.check(spec, { environ: env({ CERT_FILE: MERGED }) }).trusted, true)
  const shadow = checker.check(spec, { environ: env({ CERT_FILE: MERGED, TOP_BUNDLE: FOREIGN }) })
  assert.deepEqual([shadow.trusted, shadow.reason, shadow.variant], [false, 'shadowed', 'other build'])
  assert.equal(checker.check(spec, { environ: env({ CERT_FILE: MERGED }), layers: route(`${ONLY}\n${MERGED}`) }).trusted, true)
  const one = checker.check(spec, { environ: env({ CERT_FILE: MERGED }), layers: route(`${ONLY}\n${FOREIGN}`) })
  assert.deepEqual([one.trusted, one.reason, one.file, one.variant], [false, 'replace-without-ca', FOREIGN, 'per-route files'])
})

test('trust: the fingerprint cache refreshes when the file changes; malformed PEM blocks are skipped', () => {
  const f = file('changing.pem', other.certPem)
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: f }) }).trusted, false)
  fs.writeFileSync(f, other.certPem + asight.certPem)
  assert.equal(checker.check(additive, { environ: env({ EXTRA_CA: f }) }).trusted, true)
  assert.equal(fingerprintsInBundle('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n' + asight.certPem).size, 1)
  assert.deepEqual(certBlocks('-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n' + asight.certPem), [asight.certPem.trim()])
  const { env: e, origin } = effectiveEnv(env({ A: '1' }), [{ name: 'L', mode: 'fill', vars: { A: '2', B: '3' } }])
  assert.deepEqual([e.get('A'), e.get('B'), origin.get('A'), origin.get('B')], ['1', '3', 'environ', 'L'])
})
