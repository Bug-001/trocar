// test/query/stamp.test.mjs — each name's stamp follows every file its answer depends on, and only those
// (RFC 4.4 §条件 GET, acceptance #9). One case per dependency; the 200 / 304 half lands with the server wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, requiredFor } from './raw-home.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { QUERIES, stampOf, QueryArgError } from '../../src/query/named/index.mjs'

const CORPUS = ['sessions', 'session', 'calls', 'block', 'segments', 'traffic', 'overview']
const SEG = '20261018T100000Z'
const T0 = Date.parse('2026-10-19T12:00:10Z')
const ctxOf = (home, o = {}) => ({ home, now: () => T0, env: {}, ...o })
const stamps = (names, ctx) => Object.fromEntries(names.map((n) => [n, stampOf(n, requiredFor(n), ctx)]))
function world() {
  const home = rawHome('trocar-stamp-')
  writeSegment(home, SEG, [{ id: 'a', sessionKey: 's-1' }])
  return home
}

test('appending a line to a segment changes every corpus name, and classes', () => {
  const home = world(), ctx = ctxOf(home)
  const before = stamps([...CORPUS, 'classes'], ctx)
  writeSegment(home, SEG, [{ id: 'b', sessionKey: 's-1' }])
  const after = stamps([...CORPUS, 'classes'], ctx)
  for (const n of Object.keys(before)) assert.notEqual(after[n], before[n], n)
})

test('sealing a segment changes the corpus stamp', async () => {
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  const home = world(), ctx = ctxOf(home)
  const before = stamps(CORPUS, ctx)
  await sealSegment(path.join(home, 'raw', `${SEG}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  const after = stamps(CORPUS, ctx)
  for (const n of CORPUS) assert.notEqual(after[n], before[n], n)
})

test('a new segment file changes the corpus stamp', () => {
  const home = world(), ctx = ctxOf(home)
  const before = stamps(CORPUS, ctx)
  writeSegment(home, '20261018T110000Z', [{ id: 'c' }])
  const after = stamps(CORPUS, ctx)
  for (const n of CORPUS) assert.notEqual(after[n], before[n], n)
})

test('classes.json changes classes and not sessions', () => {
  const home = world(), ctx = ctxOf(home)
  const before = stamps(['classes', 'sessions'], ctx)
  fs.writeFileSync(path.join(home, 'classes.json'), '{}')
  const after = stamps(['classes', 'sessions'], ctx)
  assert.notEqual(after.classes, before.classes)
  assert.equal(after.sessions, before.sessions)
})

test('appending to logs/classes.ndjson changes classes', () => {
  const home = world(), ctx = ctxOf(home)
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(home, 'logs', 'classes.ndjson'), '{}\n')
  const before = stampOf('classes', {}, ctx)
  fs.appendFileSync(path.join(home, 'logs', 'classes.ndjson'), '{}\n')
  assert.notEqual(stampOf('classes', {}, ctx), before)
})

test('TROCAR_PRICING pointed elsewhere, or that file touched, changes pricing', () => {
  const home = world(), dir = tmpDir('trocar-stamp-p-')
  const a = path.join(dir, 'a.json'), b = path.join(dir, 'b.json')
  fs.writeFileSync(a, '{}'); fs.writeFileSync(b, '{}')
  const sa = stampOf('pricing', {}, ctxOf(home, { env: { TROCAR_PRICING: a } }))
  assert.notEqual(stampOf('pricing', {}, ctxOf(home, { env: { TROCAR_PRICING: b } })), sa)
  assert.notEqual(stampOf('pricing', {}, ctxOf(home)), sa)
  fs.appendFileSync(a, ' ')
  assert.notEqual(stampOf('pricing', {}, ctxOf(home, { env: { TROCAR_PRICING: a } })), sa)
})

test('the minute tick: classes and a relative window move with the clock, an absolute window does not', () => {
  const home = world()
  const at = (ms) => ctxOf(home, { now: () => ms })
  const later = T0 + 60e3
  assert.notEqual(stampOf('classes', {}, at(later)), stampOf('classes', {}, at(T0)))
  assert.notEqual(stampOf('sessions', { since: '24h' }, at(later)), stampOf('sessions', { since: '24h' }, at(T0)))
  assert.notEqual(stampOf('calls', { until: '30m' }, at(later)), stampOf('calls', { until: '30m' }, at(T0)))
  const abs = { since: '2026-10-18T00:00:00Z' }
  assert.equal(stampOf('sessions', abs, at(later)), stampOf('sessions', abs, at(T0)))
  assert.equal(stampOf('sessions', {}, at(later)), stampOf('sessions', {}, at(T0)))
})

test('nothing touched → the same stamp for every name; status and doctor have none', () => {
  const home = world(), ctx = ctxOf(home)
  const names = Object.keys(QUERIES)
  const a = stamps(names, ctx), b = stamps(names, ctx)
  assert.deepEqual(b, a)
  assert.equal(a.status, null)
  assert.equal(a.doctor, null)
  for (const n of names.filter((n) => !['status', 'doctor'].includes(n))) assert.match(a[n], /^[0-9a-f]{40}$/, n)
})

test('stampOf rejects what runQuery rejects', () => {
  const ctx = ctxOf(world())
  assert.throws(() => stampOf('nope', {}, ctx), QueryArgError)
  assert.throws(() => stampOf('sessions', { nope: 1 }, ctx), QueryArgError)
  assert.throws(() => stampOf('sessions', { since: 'yesterday' }, ctx), QueryArgError)
})

test('stamping is stat-only: no file is opened or read for any name', () => {
  const home = world()
  fs.writeFileSync(path.join(home, 'classes.json'), '{}')
  let reads = 0, stats = 0
  const counted = new Set(['openSync', 'readSync', 'readFileSync', 'createReadStream', 'open', 'readFile'])
  const spy = new Proxy(fs, { get: (t, k) => (counted.has(k) ? (...a) => { reads++; return t[k](...a) } : k === 'statSync' ? (...a) => { stats++; return t[k](...a) } : t[k]) })
  for (const n of Object.keys(QUERIES)) stampOf(n, requiredFor(n), ctxOf(home, { fs: spy }))
  assert.equal(reads, 0)
  assert.ok(stats > 0, 'the stamps were taken through the given fs')
})

test('4.4:35 overview follows the usage sidecars; the other corpus names do not', async () => {
  const home = world(), ctx = ctxOf(home)
  const before = stamps(['overview', 'sessions', 'traffic'], ctx)
  const { usageFile } = await import('../../src/query/usage.mjs')
  fs.mkdirSync(path.dirname(usageFile(home, SEG)), { recursive: true })
  fs.writeFileSync(usageFile(home, SEG), '{"m":{},"v":1}\n')
  const after = stamps(['overview', 'sessions', 'traffic'], ctx)
  assert.notEqual(after.overview, before.overview)
  assert.equal(after.sessions, before.sessions)
  assert.equal(after.traffic, before.traffic)
})
