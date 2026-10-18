// test/collector/seal-upgrade.test.mjs — the upgrade rename (RFC 4.2 §自动封存 「升级」· 验收 6).
// A HOME from an older version: a dated capture file, the close marker that version left, and an old root. After the
// daemon's start step the capture is a segment in raw/, byte for byte, the marker is gone, ~/.atrace is untouched —
// and the segment is then sealed like any other.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { upgradeCaptures, startSealing } from '../../src/collector/seal-queue.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'
import { openSealed } from '../../src/raw/reader.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const CAPTURE = Buffer.concat([
  Buffer.from(JSON.stringify({ id: 'req_old_1', ts: '2026-10-17T08:00:00.000Z', req_body: 'y'.repeat(80) }) + '\n'),
  Buffer.from('{"id":"req_old_2","ts":"2026-10-17T09:00:00.000Z","torn'), // a half line a crash left: kept as it is
])

function oldHome() {
  const home = tmpDir('asight-upgrade-'), collector = path.join(home, 'collector'), raw = path.join(home, 'raw')
  fs.mkdirSync(collector, { recursive: true, mode: 0o700 })
  const capture = path.join(collector, 'capture-2026-10-17.ndjson')
  fs.writeFileSync(capture, CAPTURE, { mode: 0o600 })
  fs.writeFileSync(`${capture}.closed`, '', { mode: 0o600 })
  fs.writeFileSync(path.join(collector, 'lock'), JSON.stringify({ pid: process.pid, segment: null }) + '\n')
  const atrace = path.join(home, '.atrace', 'asight')
  fs.mkdirSync(atrace, { recursive: true })
  fs.writeFileSync(path.join(atrace, 'calls.ndjson'), 'the old root, never read and never touched\n')
  return { home, collector, raw, capture, atrace, lock: path.join(collector, 'lock') }
}

test('6: a dated capture file becomes raw/<YYYYMMDD>T000000Z.ndjson, byte for byte; the marker goes, the old root does not', async () => {
  const b = oldHome()
  const made = upgradeCaptures({ collectorDir: b.collector, raw: b.raw })
  const segment = path.join(b.raw, '20261017T000000Z.ndjson')
  assert.deepEqual(made, [segment])
  assert.deepEqual(fs.readFileSync(segment), CAPTURE, 'a same-device rename: the bytes are untouched (invariant 2)')
  assert.equal(fs.existsSync(b.capture), false)
  assert.equal(fs.existsSync(`${b.capture}.closed`), false, "the older version's close marker is gone")
  assert.deepEqual(fs.readdirSync(b.atrace), ['calls.ndjson'], 'nothing older is read or touched')
  assert.equal(fs.readFileSync(path.join(b.atrace, 'calls.ndjson'), 'utf8'), 'the old root, never read and never touched\n')

  // from here it is an ordinary closed segment
  const res = await sealSegment(segment, { lockFile: b.lock, journal: null })
  const f = openSealed(res.sealed)
  try { assert.deepEqual(Buffer.concat([...f.lines()].map((x) => x.line)), CAPTURE) } finally { f.close() }
  assert.equal(fs.existsSync(segment), false)
})

test('6: a name another segment already holds takes -2; the upgrade runs before the first segment opens and is then sealed', async () => {
  const b = oldHome()
  fs.mkdirSync(b.raw, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(b.raw, '20261017T000000Z.ndjson'), '{"id":"already here"}\n', { mode: 0o600 })
  fs.writeFileSync(path.join(b.raw, '20261017T000000Z-2.sealed'), 'a sealed segment of an earlier upgrade', { mode: 0o600 })
  assert.deepEqual(upgradeCaptures({ collectorDir: b.collector, raw: b.raw }), [path.join(b.raw, '20261017T000000Z-3.ndjson')])

  // the daemon's start step: upgrade, then scan — a store that has not opened a segment yet
  const b2 = oldHome()
  const store = { currentSegment: null, onSegmentClosed() {} }
  const q = startSealing({ store, raw: b2.raw, collectorDir: b2.collector, lockFile: b2.lock, journal: null, failure: (where, e) => assert.fail(`${where}: ${e.message}`) })
  await q.idle()
  assert.deepEqual(fs.readdirSync(b2.raw), ['20261017T000000Z.sealed'], 'the upgraded capture was sealed by the start scan')
})

test('6: a rename the filesystem refuses (EXDEV) is ONE failure, the capture stays where it is, and the capture goes on', async () => {
  const b = oldHome()
  const failures = []
  const hooked = { ...fs, renameSync(from, to) { if (String(from).includes('capture-')) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); return fs.renameSync(from, to) } }
  assert.deepEqual(upgradeCaptures({ collectorDir: b.collector, raw: b.raw, fs: hooked, failure: (where, e, extra) => failures.push({ where, code: e.code, reason: e.message, ...extra }) }), [])
  assert.equal(failures.length, 1)
  assert.deepEqual([failures[0].where, failures[0].code, failures[0].file], ['raw', 'upgrade-failed', b.capture])
  assert.match(failures[0].reason, /cross-device link/)
  assert.deepEqual(fs.readFileSync(b.capture), CAPTURE, 'the capture is left where it is, byte for byte')
  // the start goes on: a segment this run closes is still sealed (sealing MUST NOT stop the capture)
  const closed = path.join(b.raw, '20261017T100000Z.ndjson')
  fs.mkdirSync(b.raw, { recursive: true, mode: 0o700 })
  fs.writeFileSync(closed, CAPTURE, { mode: 0o600 })
  const store = { currentSegment: null, onSegmentClosed() {} }
  const q = startSealing({ store, raw: b.raw, collectorDir: b.collector, lockFile: b.lock, journal: null, fs: hooked, failure: (where, e) => failures.push({ where, code: e.code }) })
  await q.idle()
  assert.equal(fs.existsSync(closed), false, 'the closed segment was sealed anyway')
  assert.deepEqual(failures.map((f) => f.code), ['upgrade-failed', 'upgrade-failed'], 'one failure per start, and no seal failure')
})
