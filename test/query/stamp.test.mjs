// test/query/stamp.test.mjs — each name's stamp follows every file its answer depends on, and only those
// (RFC 4.4 §条件 GET, acceptance #9). One case per dependency; the 200 / 304 half lands with the server wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, requiredFor } from './raw-home.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { QUERIES, stampOf, QueryArgError } from '../../src/query/named/index.mjs'
import * as stamp from '../../src/query/stamp.mjs'
import { PRICING_DIGEST } from '../../src/view/pricing.mjs'

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

test('4.4 #9 price identity: the file edited or TROCAR_PRICING moved changes overview and pricing, and no other name', () => {
  const home = world(), dir = tmpDir('trocar-stamp-id-')
  const moved = path.join(dir, 'other.json'), own = path.join(home, 'pricing.json')
  fs.writeFileSync(moved, '{}')
  const names = ['overview', 'pricing', 'sessions', 'session', 'lane', 'calls']
  const same = (a, b) => { for (const n of ['sessions', 'session', 'lane', 'calls']) assert.equal(a[n], b[n], n) }
  const moves = (a, b) => { for (const n of ['overview', 'pricing']) assert.notEqual(a[n], b[n], n) }
  const start = stamps(names, ctxOf(home))
  fs.writeFileSync(own, '{"m-a":[1,2,3,4]}')
  const edited = stamps(names, ctxOf(home))
  moves(start, edited); same(start, edited)
  fs.writeFileSync(own, '{"m-a":[1,2,3,5]}')
  const again = stamps(names, ctxOf(home))
  moves(edited, again); same(edited, again)
  const pointed = stamps(names, ctxOf(home, { env: { TROCAR_PRICING: moved } }))
  moves(again, pointed); same(again, pointed)
})

test('4.4 #9 price identity: the built-in table is part of it, with no price file at all', () => {
  const home = world(), ctx = { home, fs, env: { TROCAR_PRICING: path.join(home, 'no-such.json') } }
  for (const parts of [stamp.overview(ctx), stamp.pricing(ctx)]) assert.ok(parts.includes(PRICING_DIGEST))
  assert.ok(!stamp.usage(ctx).includes(PRICING_DIGEST))
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
  // `session --since` is a mark (a record id), not a time: no tick (3.5 §会话读)
  const mark = { id: 'x', since: '20261018T100000Z:7' }
  assert.equal(stampOf('session', mark, at(later)), stampOf('session', mark, at(T0)))
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

test('4.4:36 overview and sessions follow the usage sidecars; the other corpus names do not', async () => {
  const home = world(), ctx = ctxOf(home)
  const before = stamps(['overview', 'sessions', 'traffic'], ctx)
  const { usageFile } = await import('../../src/query/usage.mjs')
  fs.mkdirSync(path.dirname(usageFile(home, SEG)), { recursive: true })
  fs.writeFileSync(usageFile(home, SEG), '{"m":{},"v":1}\n')
  const after = stamps(['overview', 'sessions', 'traffic'], ctx)
  assert.notEqual(after.overview, before.overview)
  assert.notEqual(after.sessions, before.sessions)
  assert.equal(after.traffic, before.traffic)
})

// 4.4 #9, the two-part tag of `session` / `lane` ("<stamp>:<version>"): the face compares the stamp part alone; a stamp that moved
// is relayed with the caller's version part, and the worker answers 304 while this session's version holds.
test('4.4 #9 two-part: another session grows → 304; this one grows → 200 with a new tag; nothing changed → 304 with no worker line', { timeout: 60_000 }, async () => {
  const { serveFace, request, withToken } = await import('../server/face.mjs')
  const { within } = await import('../helpers/bounded.mjs')
  const { bigSession } = await import('./big-session.mjs')
  const home = path.join(tmpDir('trocar-stamp2-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const A = bigSession({ home, id: 'aaaa-0000-4a1b-9c2d-000000000001', segment: '20261020T100000Z', growth: 500, subEvery: 0, seed: 3 })
  const B = bigSession({ home, id: 'bbbb-0000-4a1b-9c2d-000000000002', segment: '20261020T110000Z', growth: 500, subEvery: 0, seed: 5 })
  A.append(150); B.append(4) // A: more calls than one 50 ms slice folds, so its first answers carry `pending`
  const f = await serveFace({ home })
  // an answer still folding (`pending`) has no version part, so no ETag (4.4 §条件 GET): every 200 is checked
  let pendings = 0
  const ask = async (inm) => {
    const r = await request(f.port, `/api/session?id=${A.id}`, { headers: withToken(inm ? { 'if-none-match': inm } : {}) })
    if (r.status === 200 && JSON.parse(r.body).pending) { pendings++; assert.equal(r.headers.etag, undefined, 'a pending answer carries no ETag') }
    return r
  }
  const parts = (etag) => /^"([0-9a-f]+):([^":]+)"$/.exec(etag || '')?.slice(1)
  // ask until the worker has it whole
  const tagged = async (inm) => {
    for (;;) { const r = await ask(inm); assert.equal(r.status, 200); if (r.headers.etag) return r; await new Promise((d) => setTimeout(d, 50)) }
  }
  try {
    const first = await within(tagged(), 30_000, 'a tagged answer')
    const [stamp, version] = parts(first.headers.etag)
    assert.ok(stamp && version, first.headers.etag)

    const n = f.relays.length
    const same = await ask(first.headers.etag)
    assert.equal(same.status, 304)
    assert.equal(same.body, '')
    assert.equal(f.relays.length, n, 'nothing changed: no worker line')

    B.append(2)
    const other = await ask(first.headers.etag)
    assert.equal(other.status, 304, 'another session grew: this one is unchanged')
    assert.equal(other.body, '')
    const [stamp2, version2] = parts(other.headers.etag)
    assert.notEqual(stamp2, stamp, 'the stamp part moved with the disk')
    assert.equal(version2, version, 'the version part did not')

    A.append(2)
    const grown = await within(tagged(other.headers.etag), 30_000, 'the grown session, tagged')
    assert.notEqual(parts(grown.headers.etag)[1], version, 'this session grew: a new version part')
    assert.ok(pendings > 0, 'a fold that outlasts one slice was answered with pending at least once')
  } finally { f.close() }
})
