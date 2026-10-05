// test/collector/core/trust-plan.test.mjs — acceptance T10, generic half (the CC half: harness/claude-code.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'

const CA = createCa({ commonName: 'asight collector CA' })
const USER = createCa({ commonName: 'corp CA' })
const DIR = '/h/.asight/collector'
const files = { '/corp/ca.pem': `-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n${USER.certPem}`, '/corp/dup.pem': USER.certPem }
const ctx = { readText: (f) => files[f] ?? null }
const plan = (inject) => planTrust({ descriptors: [{ name: 'alpha', inject }], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: DIR })
const entry = (o) => ({ kind: 'json-key', path: '/h/.alpha/settings.json', keys: ['env', 'CA_FILE'], value: `${DIR}/ca/asight-ca.pem`, semantic: 'append', ...o })

test('trust plan: entries and trust files are listed before anything is written; trust files hold only certificates', () => {
  const p = plan(() => ({ entries: [entry({ value: `${DIR}/ca/extra-alpha.pem` })], files: [{ path: `${DIR}/ca/extra-alpha.pem`, certsFrom: ['/corp/ca.pem', '/corp/dup.pem', '/corp/gone.pem'] }], notes: ['n'] }))
  assert.deepEqual(p.paths, [`${DIR}/ca/extra-alpha.pem`, '/h/.alpha/settings.json'])
  assert.deepEqual(p.entries.map((e) => e.harness), ['alpha'])
  assert.ok(!p.files[0].data.includes('PRIVATE KEY'), 'never a private key')
  assert.equal(p.files[0].data.match(/BEGIN CERTIFICATE/g).length, 2, 'user CA once (deduplicated by fingerprint) + the asight CA')
  assert.deepEqual(p.files[0].sources, ['/corp/ca.pem', '/corp/dup.pem'], 'the readable user files it carries certificates from')
  assert.deepEqual(p.notes, ['alpha: /corp/gone.pem is unreadable; its certificates are not carried over', 'alpha: n'])
})

test('trust plan: refuses login-environment files, forbidden keys, values outside the collector dir, relative paths', () => {
  for (const bad of ['/h/.bashrc', '/h/.config/environment.d/asight.conf', '/h/.profile', '/etc/environment']) assert.throws(() => plan(() => ({ entries: [entry({ path: bad })] })), /login-environment/, bad)
  for (const k of ['NODE_OPTIONS', 'SSL_CERT_DIR', 'NODE_TLS_REJECT_UNAUTHORIZED']) assert.throws(() => plan(() => ({ entries: [entry({ keys: ['env', k] })] })), /never written/, k)
  assert.throws(() => plan(() => ({ entries: [entry({ value: '/tmp/x.pem' })] })), /must be a file under/)
  assert.throws(() => plan(() => ({ entries: [entry({ path: 'rel/settings.json' })] })), /absolute/)
})

test('trust plan: a replace-semantics entry may only point at its own harness\'s combined bundle', () => {
  assert.throws(() => plan(() => ({ entries: [entry({ semantic: 'replace' })] })), /combined bundle/)
  assert.equal(plan(() => ({ entries: [entry({ semantic: 'replace', value: `${DIR}/ca/combined-alpha.pem` })] })).entries.length, 1)
  assert.throws(() => plan(() => ({ entries: [entry({ semantic: 'replace', value: `${DIR}/ca/combined-beta.pem` })] })), /combined-alpha\.pem — never .* another harness's bundle/)
  // library-level replace variables are replace whatever the descriptor declares (the retired L-08 list)
  for (const k of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
    assert.throws(() => plan(() => ({ entries: [entry({ keys: ['env', k], semantic: 'append' })] })), /replaces the trust store/, k)
    assert.equal(plan(() => ({ entries: [entry({ keys: ['env', k], semantic: 'append', value: `${DIR}/ca/combined-alpha.pem` })] })).entries.length, 1, k)
  }
  // a harness-specific replace variable named in the descriptor's own trust chain, whatever the entry says
  const gamma = { name: 'gamma', trust: { chain: [{ var: 'GAMMA_CA_BUNDLE', semantic: 'replace' }] }, inject: () => ({ entries: [entry({ keys: ['env', 'GAMMA_CA_BUNDLE'], semantic: 'append' })] }) }
  assert.throws(() => planTrust({ descriptors: [gamma], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: DIR }), /GAMMA_CA_BUNDLE replaces the trust store/)
  assert.deepEqual(planTrust({ descriptors: [{ name: 'beta' }], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: DIR }).paths, [])
})
