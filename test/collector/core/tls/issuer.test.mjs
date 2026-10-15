// test/collector/core/tls/issuer.test.mjs — CM4, CM5, CM6 (RFC 4.11 §验收, P2): the issuer over a custody, with an injected clock
// and timers. CM4: an intermediate at start, the next at 6 days, a leaf never outlives its intermediate, no key file, the leaf
// cache emptied on rotation. CM5: a real TLS handshake on 127.0.0.1 — a client trusting only the root succeeds; the leaf without
// the intermediate is refused. CM6: a failing custody — unavailable / key missing at start, a re-issue failure kept, retried
// hourly, forward-only at expiry. The file custody (Linux) stays root-signed.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { makeIssuer } from '../../../../src/collector/core/tls/issuer.mjs'
import { checkProfile, INTERMEDIATE, certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { fileCustody } from '../../../../src/collector/core/tls/ca-store.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const DAY = 86400e3
const REISSUE_AFTER_MS = 6 * DAY, RETRY_MS = 3600e3 // 4.11 P2: re-issue at 6 days, retry hourly
const settle = () => new Promise((r) => setImmediate(r))
function fakeTime(start = Date.now()) {
  let now = start
  const q = []
  return {
    clock: () => now,
    timers: { setTimeout: (fn, ms) => { const h = { at: now + ms, fn }; q.push(h); return h }, clearTimeout: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1) } },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        q.sort((a, b) => a.at - b.at)
        if (!q.length || q[0].at > end) break
        const h = q.shift(); now = h.at; h.fn(); await settle()
      }
      now = end
    },
    pending: () => q.length,
  }
}
const certs = (pem) => pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/g).map((p) => new crypto.X509Certificate(p))
const issues = (stub) => stub.calls.filter((c) => c.verb === 'issue').length

async function setup({ before } = {}) {
  const t = fakeTime()
  const stub = custodyStub({ clock: t.clock })
  stub.create()
  if (before) before(stub)
  const records = []
  const issuer = await makeIssuer({ custody: stub, root: stub.rootDer, clock: t.clock, timers: t.timers, record: (r) => records.push(r) })
  return { t, stub, records, issuer }
}

test('CM4 an intermediate at start: the INTERMEDIATE profile, leaf + intermediate served, the leaf ends no later than it', async () => {
  const { stub, issuer, records } = await setup()
  assert.equal(issues(stub), 1)
  assert.equal(issuer.state(), 'ready')
  const { key, cert } = issuer.leafFor('relay.example.test')
  const [leaf, ica, ...rest] = certs(cert)
  assert.equal(rest.length, 0, 'the chain is leaf + intermediate, the root is not sent')
  assert.deepEqual(checkProfile(ica.raw, INTERMEDIATE, { root: stub.rootDer }), [])
  assert.ok(leaf.verify(ica.publicKey) && leaf.checkIssued(ica))
  assert.ok(Date.parse(leaf.validTo) <= Date.parse(ica.validTo), `leaf ${leaf.validTo} outlives ${ica.validTo}`)
  assert.equal(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(leaf.publicKey.export({ type: 'spki', format: 'der' })), true)
  assert.deepEqual(records, [])
  issuer.close()
})

test('CM4 the next intermediate at 6 days; rotation empties the leaf cache; nothing before 6 days', async () => {
  const { t, stub, issuer } = await setup()
  const first = issuer.leafFor('a.test')
  assert.equal(issuer.leafFor('a.test').cert, first.cert, 'cached between rotations')
  await t.advance(REISSUE_AFTER_MS - 60e3)
  assert.equal(issues(stub), 1)
  await t.advance(60e3)
  assert.equal(issues(stub), 2)
  const second = issuer.leafFor('a.test')
  const [leaf2, ica2] = certs(second.cert)
  const [, ica1] = certs(first.cert)
  assert.notEqual(ica2.fingerprint256, ica1.fingerprint256, 'a new intermediate')
  assert.notEqual(second.cert, first.cert, 'the leaf cache was emptied: a new leaf')
  assert.ok(leaf2.verify(ica2.publicKey))
  issuer.close()
  assert.equal(t.pending(), 0, 'close clears the timers')
})

test('CM4 no private key is written: the working dir stays empty, and issuer.mjs has no file system', async () => {
  const dir = tmpDir('asight-issuer-')
  const cwd = process.cwd()
  process.chdir(dir)
  try { const { issuer } = await setup(); issuer.leafFor('a.test'); issuer.close() } finally { process.chdir(cwd) }
  assert.deepEqual(fs.readdirSync(dir), [])
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/collector/core/tls/issuer.mjs'), 'utf8')
  assert.doesNotMatch(src, /from 'node:fs'|ca-store|writeFile/)
})

async function handshake(serverCert, key, ca) {
  const server = tls.createServer({ key, cert: serverCert }, (s) => s.end('hi'))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await new Promise((resolve) => {
      const c = tls.connect({ port: server.address().port, host: '127.0.0.1', servername: 'relay.example.test', ca }, () => { resolve({ ok: c.authorized }); c.destroy() })
      c.on('error', (e) => resolve({ ok: false, code: e.code }))
    })
  } finally { server.close() }
}

test('CM5 a client trusting only the root completes a real handshake; the leaf without the intermediate is refused', async () => {
  const stub = custodyStub(); stub.create()
  const issuer = await makeIssuer({ custody: stub, root: stub.rootDer })
  const { key, cert } = issuer.leafFor('relay.example.test')
  const rootPem = certPem(stub.rootDer)
  assert.deepEqual(await handshake(cert, key, [rootPem]), { ok: true })
  const leafOnly = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/)[0]
  const control = await handshake(leafOnly, key, [rootPem])
  assert.equal(control.ok, false)
  assert.match(String(control.code), /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/)
  issuer.close()
})

test('CM6 unavailable at start: no issuer (leafFor null), one cert-intermediate-unavailable record, retried hourly', async () => {
  const { t, stub, issuer, records } = await setup({ before: (s) => { s.switches.unavailable = true } })
  assert.equal(issuer.state(), 'unavailable')
  assert.equal(issuer.leafFor('a.test'), null)
  assert.deepEqual(records.map((r) => r.code), ['cert-intermediate-unavailable'])
  for (const r of records) assert.deepEqual(checkRecord(r), [])
  await t.advance(RETRY_MS)
  assert.equal(issues(stub), 2)
  assert.equal(records.length, 1, 'once per failure streak')
  stub.switches.unavailable = false
  await t.advance(RETRY_MS)
  assert.equal(issuer.state(), 'ready')
  assert.ok(issuer.leafFor('a.test'))
  issuer.close()
})

test('CM6 the key missing: state key-missing, cert-key-missing, the custody is never asked to issue', async () => {
  const { stub, issuer, records } = await setup({ before: (s) => { s.switches.keyLost = true } })
  assert.equal(issuer.state(), 'key-missing')
  assert.equal(issuer.leafFor('a.test'), null)
  assert.equal(issues(stub), 0)
  assert.deepEqual(records.map((r) => [r.event, r.where, r.code]), [['failure', 'ca', 'cert-key-missing']])
  issuer.close()
})

for (const [what, fault] of [['answers unavailable', 'unavailable'], ['throws', 'throws'], ['returns a wrong-profile certificate', 'wrongProfile']]) {
  test(`CM6 a re-issue that ${what}: the current intermediate is kept, retried hourly, forward-only at its expiry, back on success`, async () => {
    const { t, stub, issuer, records } = await setup()
    const before = certs(issuer.leafFor('a.test').cert)[1].fingerprint256
    stub.switches[fault] = true
    await t.advance(REISSUE_AFTER_MS)
    assert.equal(issuer.state(), 'ready')
    assert.equal(certs(issuer.leafFor('a.test').cert)[1].fingerprint256, before, 'still the current intermediate')
    assert.deepEqual(records.map((r) => r.code), ['cert-intermediate-unavailable'])
    await t.advance(RETRY_MS)
    assert.equal(issues(stub), 3, 'retried after an hour')
    assert.equal(records.length, 1, 'once per failure streak')
    await t.advance(DAY) // past the 7-day notAfter (issued at start − 10 min)
    assert.notEqual(issuer.state(), 'ready')
    assert.equal(issuer.leafFor('a.test'), null, 'forward-only')
    stub.switches[fault] = false
    await t.advance(RETRY_MS)
    assert.equal(issuer.state(), 'ready')
    assert.notEqual(certs(issuer.leafFor('a.test').cert)[1].fingerprint256, before)
    issuer.close()
  })
}

test('the file custody (Linux): leaves stay root-signed, chain = leaf + root; a missing CA is cert-key-missing', async () => {
  const dir = path.join(tmpDir('asight-fc-'), 'collector', 'ca')
  const custody = fileCustody({ dir })
  assert.equal(custody.exists(), false)
  const records = []
  const none = await makeIssuer({ custody, record: (r) => records.push(r) })
  assert.equal(none.state(), 'key-missing'); assert.equal(none.leafFor('a.test'), null)
  assert.deepEqual(records.map((r) => r.code), ['cert-key-missing'])
  const { rootDer, fp256 } = custody.create()
  assert.equal(custody.exists(), true)
  assert.equal(new crypto.X509Certificate(rootDer).fingerprint256, fp256)
  const issuer = await makeIssuer({ custody })
  const [leaf, root, ...rest] = certs(issuer.leafFor('a.test').cert)
  assert.equal(rest.length, 0)
  assert.equal(root.fingerprint256, fp256)
  assert.ok(leaf.verify(root.publicKey))
  custody.remove()
  assert.equal(custody.exists(), false)
})
