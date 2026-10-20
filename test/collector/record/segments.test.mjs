// segments.test.mjs — the raw layer is stored in SEGMENTS (D60①, RFC 4.6 §记录, 1.6 §1.7 / §5.1): the daemon appends every
// envelope to ~/.asight/raw/<segment>.ndjson, closes the segment at 128 MB or when it stops, and always opens a NEW
// segment at start (never continues one on disk, so a line is never appended behind a reader's back). The record id
// `<segment>:<line>` (line from 1) is the same before and after sealing (V88, write side), which is why nothing ever
// rewrites a closed segment — a half line left by a crash included.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../helpers/tmp.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'
import { lockKeeper } from '../../../src/collector/daemon.mjs'
import { SEGMENT_BYTES, segmentName, parseSegment, recordId, parseRecordId } from '../../../src/collector/core/record/segments.mjs'

const raw = (home) => path.join(home, 'raw')
const names = (home) => fs.readdirSync(raw(home)).sort()
const lines = (home, n) => fs.readFileSync(path.join(raw(home), n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const store = (home, o = {}) => createRecordStore({ root: path.join(home, 'collector'), onError: (e) => { throw e }, ...o })

test('segments: the name is the opening instant in UTC, a collision takes the next suffix, and both parse back', () => {
  const at = new Date('2026-10-18T07:08:09.456Z')
  assert.equal(segmentName(at), '20261018T070809Z')
  assert.equal(segmentName(at, ['20261018T070809Z']), '20261018T070809Z-2')
  assert.equal(segmentName(at, ['20261018T070809Z', '20261018T070809Z-2']), '20261018T070809Z-3')
  assert.deepEqual(parseSegment('20261018T070809Z.ndjson'), { segment: '20261018T070809Z', sealed: false })
  assert.deepEqual(parseSegment('20261018T070809Z-2.sealed'), { segment: '20261018T070809Z-2', sealed: true })
  for (const n of ['journal.jsonl', 'capture-2026-10-18.ndjson', '20261018T070809Z.ndjson.tmp', 'seal.lock', '2026-10-18.ndjson']) assert.equal(parseSegment(n), null, n)
  assert.equal(recordId('20261018T070809Z-2', 7), '20261018T070809Z-2:7')
  assert.deepEqual(parseRecordId('20261018T070809Z-2:7'), { segment: '20261018T070809Z-2', lineNo: 7 })
  for (const id of ['20261018T070809Z', '20261018T070809Z:0', '20261018T070809Z:x', 'x:1', '20261018T070809Z:1:2']) assert.equal(parseRecordId(id), null, id)
})

test('segments: a written envelope answers with its id, numbered from 1, and the next segment numbers from 1 again', () => {
  const home = tmpDir('asight-seg-')
  let clock = '2026-10-18T07:08:09.000Z'
  const s = store(home, { now: () => new Date(clock), segmentBytes: 20 })
  const a = s.envelope({ id: 'a' })
  assert.equal(s.currentSegment, '20261018T070809Z')
  const b = s.envelope({ id: 'b' })
  assert.deepEqual([a, b], [{ ok: true, id: '20261018T070809Z:1' }, { ok: true, id: '20261018T070809Z:2' }])
  assert.equal(s.currentSegment, null, 'past 20 bytes the segment is closed; the next envelope opens the next one')
  clock = '2026-10-18T07:09:00.000Z'
  const c = s.envelope({ id: 'c' }) // past 20 bytes: b closed the segment, c opens the next one
  assert.deepEqual(c, { ok: true, id: '20261018T070900Z:1' })
  s.close()
  assert.equal(s.currentSegment, null, 'the stop closes the open segment')
  assert.deepEqual(names(home), ['20261018T070809Z.ndjson', '20261018T070900Z.ndjson'])
  assert.deepEqual(lines(home, '20261018T070809Z.ndjson').map((r) => r.id), ['a', 'b'])
  assert.deepEqual(lines(home, '20261018T070900Z.ndjson').map((r) => r.id), ['c'])
  assert.equal(SEGMENT_BYTES, 128 << 20, 'the product rotates at 128 MB (1.6 §5.1)')
})

test('segments: a store that starts always opens a new segment, never appends to one already on disk', () => {
  const home = tmpDir('asight-seg-')
  const clock = () => new Date('2026-10-18T07:08:09.000Z')
  const a = store(home, { now: clock }); a.envelope({ id: 'a' }); a.close()
  const b = store(home, { now: clock }); const r = b.envelope({ id: 'b' }); b.close()
  assert.equal(r.id, '20261018T070809Z-2:1', 'same second, so the name takes a suffix')
  assert.deepEqual(names(home), ['20261018T070809Z-2.ndjson', '20261018T070809Z.ndjson'])
  assert.deepEqual(lines(home, '20261018T070809Z.ndjson').map((x) => x.id), ['a'], 'the earlier segment got no further line')
})

test('segments: a half line left by a crash is neither completed nor rewritten', () => {
  const home = tmpDir('asight-seg-')
  fs.mkdirSync(raw(home), { recursive: true })
  const half = path.join(raw(home), '20261018T000000Z.ndjson')
  fs.writeFileSync(half, '{"id":"old"}\n{"id":"cut' /* no newline: the daemon died mid-write */)
  const s = store(home, { now: () => new Date('2026-10-18T07:08:09.000Z') })
  s.envelope({ id: 'a' }); s.close()
  assert.equal(fs.readFileSync(half, 'utf8'), '{"id":"old"}\n{"id":"cut', 'byte for byte as the crash left it')
})

test('segments: every closed segment reaches onSegmentClosed once, at rollover and at stop (the seal queue hangs here)', () => {
  const home = tmpDir('asight-seg-')
  let clock = '2026-10-18T07:08:09.000Z'
  const closed = []
  const s = store(home, { now: () => new Date(clock), segmentBytes: 1 })
  s.onSegmentClosed((p) => closed.push(path.basename(p)))
  s.envelope({ id: 'a' })
  clock = '2026-10-18T07:08:10.000Z'
  s.envelope({ id: 'b' })
  s.close()
  assert.deepEqual(closed, ['20261018T070809Z.ndjson', '20261018T070810Z.ndjson'])
  s.close()
  assert.deepEqual(closed, ['20261018T070809Z.ndjson', '20261018T070810Z.ndjson'], 'a second stop closes nothing twice')
})

test('segments: the lock names a new segment before that segment\'s file exists, and no longer names it when the seal queue gets it (invariant 2)', () => {
  const home = tmpDir('asight-seg-')
  const lock = path.join(home, 'lock')
  let clock = '2026-10-18T07:08:09.000Z'
  const s = store(home, { now: () => new Date(clock), segmentBytes: 1 })
  const refreshLock = lockKeeper({ file: lock, fields: { pid: 7 }, segmentOf: () => s.currentSegment })
  s.onSegmentChange(refreshLock) // the daemon's wiring
  const seen = [] // what a sealer would have read at the instant the file was about to appear
  s.onSegmentChange((seg) => { if (seg) seen.push({ seg, named: JSON.parse(fs.readFileSync(lock, 'utf8')).segment, onDisk: fs.existsSync(path.join(raw(home), `${seg}.ndjson`)) }) })
  const handed = [] // what the sealer the queue forks at once would read
  s.onSegmentClosed((f) => handed.push({ closed: path.basename(f), named: JSON.parse(fs.readFileSync(lock, 'utf8')).segment }))
  s.envelope({ id: 'a' }) // past 1 byte: this segment is closed at once, so the next envelope rotates
  clock = '2026-10-18T07:08:10.000Z'
  s.envelope({ id: 'b' })
  s.close()
  assert.deepEqual(seen, [
    { seg: '20261018T070809Z', named: '20261018T070809Z', onDisk: false },
    { seg: '20261018T070810Z', named: '20261018T070810Z', onDisk: false },
  ], 'the lock named each segment while its file did not exist yet — not on the next 1 s tick')
  assert.deepEqual(handed, [
    { closed: '20261018T070809Z.ndjson', named: null },
    { closed: '20261018T070810Z.ndjson', named: null },
  ], 'a closed segment reaches the seal queue only once the lock no longer names it — not on the next 1 s tick')
})

test('segments: a name the directory scan missed is never appended to — the exclusive create takes the next suffix', () => {
  const home = tmpDir('asight-seg-')
  fs.mkdirSync(raw(home), { recursive: true })
  const other = path.join(raw(home), '20261018T070809Z.ndjson')
  fs.writeFileSync(other, '{"id":"theirs"}\n') // another writer's segment, appearing after the scan
  const readdir = fs.readdirSync
  fs.readdirSync = (p, o) => (path.resolve(p) === path.resolve(raw(home)) ? [] : readdir(p, o)) // the scan sees nothing
  try {
    const s = store(home, { now: () => new Date('2026-10-18T07:08:09.000Z') })
    assert.equal(s.envelope({ id: 'a' }).id, '20261018T070809Z-2:1')
    s.close()
  } finally { fs.readdirSync = readdir }
  assert.equal(fs.readFileSync(other, 'utf8'), '{"id":"theirs"}\n', 'the other writer\'s file was not appended to')
})

test('segments: a failed write closes the segment — the fd is released and the seal queue gets it (its half line as it is)', () => {
  const home = tmpDir('asight-seg-')
  const errs = [], closed = []
  const s = store(home, { now: () => new Date('2026-10-18T07:08:09.000Z'), onError: (e) => errs.push(e) })
  s.onSegmentClosed((p) => closed.push(path.basename(p)))
  s.envelope({ id: 'a' })
  const write = fs.writeSync
  fs.writeSync = () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) }
  try { assert.deepEqual(s.envelope({ id: 'b' }), { ok: false }) } finally { fs.writeSync = write }
  assert.equal(s.currentSegment, null)
  assert.equal(s.openFiles, 0, 'the fd was released')
  assert.deepEqual(closed, ['20261018T070809Z.ndjson'], 'the half-written segment reached the seal queue')
  assert.equal(errs[0].code, 'ENOSPC')
  assert.deepEqual(lines(home, '20261018T070809Z.ndjson').map((r) => r.id), ['a'])
  s.close()
})

test('segments: the raw directory is 0700 and a segment 0600 — capture data is the owner\'s only (1.6 §1.7)', () => {
  const home = tmpDir('asight-seg-')
  fs.mkdirSync(raw(home), { recursive: true, mode: 0o755 }) // a raw/ from an older version: raw bytes hold credentials verbatim
  const s = store(home, { now: () => new Date('2026-10-18T07:08:09.000Z') })
  s.envelope({ id: 'a' }); s.close()
  assert.equal(fs.statSync(raw(home)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(raw(home), '20261018T070809Z.ndjson')).mode & 0o777, 0o600)
})

test('segments: a failed write says so and never throws into the forwarding path (D38)', () => {
  const home = tmpDir('asight-seg-')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  fs.writeFileSync(raw(home), 'not a directory') // the segment cannot be opened
  const errs = []
  const s = store(home, { now: () => new Date('2026-10-18T07:08:09.000Z'), onError: (e) => errs.push(e) })
  assert.deepEqual(s.envelope({ id: 'a' }), { ok: false })
  assert.equal(s.currentSegment, null)
  assert.equal(errs.length, 1)
  assert.ok(s.lastError, 'the reason is kept for the caller\'s failure record')
  s.close()
})
