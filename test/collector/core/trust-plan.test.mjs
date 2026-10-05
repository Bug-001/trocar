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
  assert.deepEqual(p.notes, ['alpha: /corp/ca.pem: a PRIVATE KEY block is not a CERTIFICATE PEM block, so it is not merged into extra-alpha.pem (only certificates are carried over)', 'alpha: /corp/gone.pem is unreadable; its certificates are not carried over', 'alpha: n'])
  assert.deepEqual(p.records.map((r) => r.code), ['cert-not-merged', 'source-unreadable', 'harness-note'], 'each note carries its code (D38)')
})

test('trust plan: refuses login-environment files, forbidden keys, values outside the collector dir, relative paths', () => {
  for (const bad of ['/h/.bashrc', '/h/.config/environment.d/asight.conf', '/h/.profile', '/etc/environment']) assert.throws(() => plan(() => ({ entries: [entry({ path: bad })] })), /login-environment/, bad)
  for (const k of ['NODE_OPTIONS', 'SSL_CERT_DIR', 'NODE_TLS_REJECT_UNAUTHORIZED']) assert.throws(() => plan(() => ({ entries: [entry({ keys: ['env', k] })] })), /never written/, k)
  assert.throws(() => plan(() => ({ entries: [entry({ value: '/tmp/x.pem' })] })), /must be a file under/)
  assert.throws(() => plan(() => ({ entries: [entry({ path: 'rel/settings.json' })] })), /absolute/)
})

const BUNDLE = { path: `${DIR}/ca/combined-alpha.pem`, bundle: true }
test('trust plan: a replace-semantics entry may only point at its own harness\'s combined bundle, declared as one', () => {
  assert.throws(() => plan(() => ({ entries: [entry({ semantic: 'replace' })] })), /combined bundle/)
  assert.equal(plan(() => ({ entries: [entry({ semantic: 'replace', value: `${DIR}/ca/combined-alpha.pem` })], files: [BUNDLE] })).entries.length, 1)
  assert.throws(() => plan(() => ({ entries: [entry({ semantic: 'replace', value: `${DIR}/ca/combined-alpha.pem` })] })), /does not declare as its combined bundle/)
  assert.throws(() => plan(() => ({ files: [{ path: `${DIR}/ca/bundle.pem`, bundle: true }] })), /a combined bundle is named combined-alpha\.pem/)
  assert.throws(() => plan(() => ({ entries: [entry({ semantic: 'replace', value: `${DIR}/ca/combined-beta.pem` })] })), /combined-alpha\.pem — never .* another harness's bundle/)
  // library-level replace variables are replace whatever the descriptor declares (the retired L-08 list)
  for (const k of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
    assert.throws(() => plan(() => ({ entries: [entry({ keys: ['env', k], semantic: 'append' })] })), /replaces the trust store/, k)
    assert.equal(plan(() => ({ entries: [entry({ keys: ['env', k], semantic: 'append', value: `${DIR}/ca/combined-alpha.pem` })], files: [BUNDLE] })).entries.length, 1, k)
  }
  // a harness-specific replace variable named in the descriptor's own trust chain, whatever the entry says
  const gamma = { name: 'gamma', trust: { chain: [{ var: 'GAMMA_CA_BUNDLE', semantic: 'replace' }] }, inject: () => ({ entries: [entry({ keys: ['env', 'GAMMA_CA_BUNDLE'], semantic: 'append' })] }) }
  assert.throws(() => planTrust({ descriptors: [gamma], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: DIR }), /GAMMA_CA_BUNDLE replaces the trust store/)
  assert.deepEqual(planTrust({ descriptors: [{ name: 'beta' }], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: DIR }).paths, [])
})

test('trust plan: text entries — a dotenv block passes the same checks as a key; a login-environment file only ever gets the shim PATH line', async () => {
  const { lineComment } = await import('../../../src/collector/core/trust/text-edit.mjs')
  const block = (vars, o = {}) => ({ kind: 'text', format: 'dotenv-block', path: '/h/.alpha/.env', vars, semantic: 'replace', ...o })
  assert.equal(plan(() => ({ entries: [block({ SSL_CERT_FILE: `${DIR}/ca/combined-alpha.pem` })], files: [BUNDLE] })).entries[0].format, 'dotenv-block')
  assert.throws(() => plan(() => ({ entries: [block({ SSL_CERT_FILE: `${DIR}/ca/asight-ca.pem` })] })), /SSL_CERT_FILE replaces the trust store/)
  assert.throws(() => plan(() => ({ entries: [block({ NODE_OPTIONS: `${DIR}/x` })] })), /NODE_OPTIONS is never written/)
  assert.throws(() => plan(() => ({ entries: [block({ SSL_CERT_FILE: `${DIR}/ca/combined-alpha.pem` }, { path: '/h/.zshenv' })], files: [BUNDLE] })), /login-environment/)
  const shim = `export PATH="${DIR}/bin:$PATH" ${lineComment('alpha shim')}`
  const rc = (o) => ({ kind: 'text', format: 'line', path: '/h/.bashrc', line: shim, after: 'alpha/bin', ...o })
  assert.deepEqual(plan(() => ({ entries: [rc()] })).paths, ['/h/.bashrc'])
  assert.throws(() => plan(() => ({ entries: [rc({ after: undefined })] })), /only ever gets the launch-shim PATH line/, 'not placed after the installer\'s line')
  assert.throws(() => plan(() => ({ entries: [rc({ line: `export PATH="/opt/bin:$PATH" ${lineComment('x')}` })] })), /only ever gets the launch-shim PATH line/)
  assert.throws(() => plan(() => ({ entries: [rc({ line: `export NODE_EXTRA_CA_CERTS=${DIR}/ca/asight-ca.pem ${lineComment('x')}` })] })), /never sets a CA variable/)
  assert.throws(() => plan(() => ({ entries: [rc({ path: '/h/.alpha/patch.yml', format: 'yaml-list', line: '- insert: [x]' })] })), /carries the sentinel/)
  assert.throws(() => plan(() => ({ entries: [{ kind: 'text', format: 'ini', path: '/h/a.ini' }] })), /unknown entry kind text \/ format ini/)
})

test('trust plan: owned files — in an agent\'s directory only with "asight" in the name and the sentinel inside; shims only in <collector>/bin, one per name; watch and notes are carried', () => {
  const P = { path: '/h/.config/alpha/plugins/asight-ca.js', role: 'plugin', data: '// asight collector: trust plugin\n' }
  const p = plan(() => ({ owned: [P, { path: `${DIR}/plugins/alpha/package.json`, role: 'plugin', data: '{"type":"module"}\n' }], watch: [{ path: '/h/.config/alpha/node_modules', why: 'npm install' }], notes: [{ code: 'harness-note', text: 'first run fetches a package' }, 'plain'] }))
  assert.deepEqual(p.paths, [P.path, `${DIR}/plugins/alpha/package.json`], 'owned files are listed before anything is written')
  assert.deepEqual([p.owned[0].harness, p.owned[0].mode, p.watch], ['alpha', 0o600, [{ harness: 'alpha', path: '/h/.config/alpha/node_modules', why: 'npm install' }]])
  assert.deepEqual(p.records, [{ harness: 'alpha', code: 'harness-note', reason: 'first run fetches a package' }, { harness: 'alpha', code: 'harness-note', reason: 'plain' }])
  assert.throws(() => plan(() => ({ owned: [{ ...P, path: '/h/.config/alpha/plugins/ca.js' }] })), /has "asight" in its name and the sentinel/)
  assert.throws(() => plan(() => ({ owned: [{ ...P, data: '// trust plugin\n' }] })), /has "asight" in its name and the sentinel/)
  assert.throws(() => plan(() => ({ owned: [{ ...P, path: '/h/.local/bin/alpha', role: 'shim' }] })), /lives in .*\/bin, the shim directory/)
  const sh = { path: `${DIR}/bin/alpha`, role: 'shim', data: '#!/bin/sh\n' }
  assert.equal(plan(() => ({ owned: [sh] })).owned.length, 1)
  assert.throws(() => plan(() => ({ owned: [sh, sh] })), /one shim per command/)
  assert.throws(() => plan(() => ({ owned: [{ ...P, role: 'daemon' }] })), /unknown owned-file role/)
})
