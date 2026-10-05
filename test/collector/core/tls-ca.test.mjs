import test from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { readTlv, int } from '../../../src/collector/core/tls/der.mjs'

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
  assert.match(x.subject, /CN=asight collector CA/)
  assert.equal(x.verify(x.publicKey), true)
  const ca = loadCa({ keyPem, certPem })
  assert.equal(ca.ski.length, 20)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ca-'))
  fs.writeFileSync(path.join(dir, 'ca.pem'), certPem)
  const text = execFileSync('openssl', ['x509', '-in', path.join(dir, 'ca.pem'), '-noout', '-text']).toString()
  assert.match(text, /CA:TRUE/)
  assert.match(text, /Certificate Sign/)
  assert.match(text, /Subject Key Identifier/)
})
