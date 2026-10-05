// test/collector/core/ca-store.test.mjs — acceptance T9 (collector CA isolation).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadOrCreateCa, readCa, caPaths, COLLECTOR_CA_CN } from '../../../src/collector/core/tls/ca-store.mjs'

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ca-home-'))
const mode = (p) => fs.statSync(p).mode & 0o777

// Record every path the store touches, so "never reads or writes the legacy CA dirs" is asserted.
function spyFs() {
  const touched = []
  const wrap = (name) => (p, ...a) => { touched.push(String(p)); return fs[name](p, ...a) }
  const spy = Object.fromEntries(['existsSync', 'mkdirSync', 'chmodSync', 'readFileSync', 'writeFileSync', 'renameSync', 'statSync', 'openSync', 'fsyncSync', 'closeSync', 'rmSync'].map((n) => [n, wrap(n)]))
  spy.fsyncSync = (fd) => fs.fsyncSync(fd); spy.closeSync = (fd) => fs.closeSync(fd)
  return { spy, touched }
}

test('ca-store: mints a v3 CA under ~/.asight/collector/ca with a 0600 key and 0700 dir', () => {
  const h = home()
  try {
    const dir = path.join(h, '.asight', 'collector', 'ca')
    const ca = loadOrCreateCa({ dir })
    const p = caPaths(dir)
    assert.equal(ca.created, true)
    assert.equal(mode(p.key), 0o600)
    assert.equal(mode(dir), 0o700)
    const x = new X509Certificate(fs.readFileSync(p.pem))
    assert.equal(x.ca, true)
    assert.match(x.subject, new RegExp(`CN=${COLLECTOR_CA_CN}`))
    assert.doesNotMatch(x.subject, /atrace local MITM CA/)
    assert.equal(fs.readFileSync(p.pem, 'utf8'), ca.certPem)
  } finally { fs.rmSync(h, { recursive: true, force: true }) }
})

test('ca-store: loading again returns the same CA (never rotated)', () => {
  const h = home()
  try {
    const dir = path.join(h, '.asight', 'collector', 'ca')
    const a = loadOrCreateCa({ dir }); const b = loadOrCreateCa({ dir })
    assert.equal(b.created, false); assert.equal(b.certPem, a.certPem); assert.equal(b.keyPem, a.keyPem)
  } finally { fs.rmSync(h, { recursive: true, force: true }) }
})

test('ca-store: never touches the legacy CA directories', () => {
  const h = home()
  try {
    for (const legacy of [path.join(h, '.asight', 'ca'), path.join(h, '.atrace', 'ca')]) {
      fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'ca.crt'), 'LEGACY')
    }
    const { spy, touched } = spyFs()
    loadOrCreateCa({ dir: path.join(h, '.asight', 'collector', 'ca'), fs: spy })
    loadOrCreateCa({ dir: path.join(h, '.asight', 'collector', 'ca'), fs: spy })
    assert.ok(touched.length > 0)
    for (const p of touched) assert.ok(p.startsWith(path.join(h, '.asight', 'collector', 'ca')), `touched ${p}`)
    assert.equal(fs.readFileSync(path.join(h, '.asight', 'ca', 'ca.crt'), 'utf8'), 'LEGACY')
    assert.throws(() => loadOrCreateCa({ dir: path.join(h, '.asight', 'ca') }), /legacy/)
  } finally { fs.rmSync(h, { recursive: true, force: true }) }
})

test('ca-store: key without certificate (crash mid-mint) re-mints; certificate without key refuses', () => {
  const h = home()
  try {
    const dir = path.join(h, '.asight', 'collector', 'ca')
    const first = loadOrCreateCa({ dir }); const p = caPaths(dir)
    fs.rmSync(p.pem)
    const again = loadOrCreateCa({ dir })
    assert.equal(again.created, true); assert.notEqual(again.certPem, first.certPem)
    fs.rmSync(p.key)
    assert.throws(() => loadOrCreateCa({ dir }), /ca\.key is missing/)
  } finally { fs.rmSync(h, { recursive: true, force: true }) }
})

test('ca-store: the module never spawns anything (no trust-store commands)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../../../src/collector/core/tls/ca-store.mjs', import.meta.url)), 'utf8')
  assert.doesNotMatch(src, /child_process|security\s+add|certutil|update-ca-certificates|trust\s+anchor/)
})

test('ca-store: readCa returns the installed pair and never mints one', () => {
  const h = home()
  try {
    const dir = path.join(h, '.asight', 'collector', 'ca')
    assert.equal(readCa({ dir }), null)
    assert.ok(!fs.existsSync(dir), 'reading created nothing')
    const ca = loadOrCreateCa({ dir })
    assert.equal(readCa({ dir }).certPem, ca.certPem)
  } finally { fs.rmSync(h, { recursive: true, force: true }) }
})
