import test from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { readTlv, int } from '../../../src/collector/core/tls/der.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

test('DER: integers are minimal and positive', () => {
  assert.deepEqual(int(0n), Buffer.from([0x02, 0x01, 0x00]))
  assert.deepEqual(int(128n), Buffer.from([0x02, 0x02, 0x00, 0x80]))
  const t = readTlv(Buffer.from([0x30, 0x82, 0x01, 0x00]), 0)
  assert.deepEqual([t.tag, t.headerLen, t.len], [0x30, 4, 256])
})

test('createCa: a v3 CA that node parses and openssl verifies against itself', () => {
  const { keyPem, certPem } = createCa({ now: new Date('2026-10-05T00:00:00Z') })
  const x = new X509Certificate(certPem)
  assert.equal(x.ca, true)
  assert.match(x.subject, /CN=trocar collector CA/)
  assert.equal(x.verify(x.publicKey), true)
  const ca = loadCa({ keyPem, certPem })
  assert.equal(ca.ski.length, 20)
  const dir = tmpDir('trocar-ca-')
  fs.writeFileSync(path.join(dir, 'ca.pem'), certPem)
  const text = execFileSync('openssl', ['x509', '-in', path.join(dir, 'ca.pem'), '-noout', '-text']).toString()
  assert.match(text, /CA:TRUE/)
  assert.match(text, /Certificate Sign/)
  assert.match(text, /Subject Key Identifier/)
})

// D-4 (4.6 §身份与信任「CA」): the CA is checked, not just read — a key and certificate that are not one pair, a
// certificate out of its validity, or files that do not parse each say which part is wrong.
test('checkCa: ok; key / cert that do not parse; expired; not yet valid; key and certificate from two CAs', async () => {
  const { checkCa } = await import('../../../src/collector/core/tls/ca.mjs')
  const a = createCa(), b = createCa()
  const ok = checkCa(a)
  assert.deepEqual([ok.ok, typeof ok.not_after], [true, 'string'])
  assert.deepEqual(['key', 'cert', 'pair'].map((w) => checkCa(w === 'key' ? { ...a, keyPem: 'garbage' } : w === 'cert' ? { ...a, certPem: 'garbage' } : { keyPem: b.keyPem, certPem: a.certPem }).which), ['key', 'cert', 'pair'])
  const old = createCa({ now: new Date('2000-01-01T00:00:00Z'), years: 1 })
  assert.deepEqual([checkCa(old).ok, checkCa(old).which], [false, 'expired'])
  assert.equal(checkCa({ ...a, now: new Date('1999-01-01T00:00:00Z') }).which, 'not-yet-valid')
})
