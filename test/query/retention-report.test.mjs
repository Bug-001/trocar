// test/query/retention-report.test.mjs — the parts of 「保存什么」 that come from FILES, and the report that joins them (RFC 4.6 K6, 3.5
// §「保存什么」, 4.4 #15): the disk total is the sum of the file sizes, the seal ratio is what the sealed files say, a number that cannot
// be had says why instead of reading as 0, and the report is metadata only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runEtl } from '../../src/etl/orchestrator.mjs'
import { diskUsage, sealStats, groupOf, DISK_GROUPS } from '../../src/query/disk.mjs'
import { retentionReport, readChanges } from '../../src/query/retention.mjs'
import { setRetention } from '../../src/capture/retention.mjs'
import { sealUnchecked } from '../../src/raw/seal.mjs'
import { freshConn } from '../etl/helpers.mjs'
import { tmpDir, writeShard, toLine, envelope, listFiles } from '../raw/helpers.mjs'
import { full, logged, preD40, sized } from '../fixtures/d40-records.mjs'

const put = (file, n) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(n, 'a')) }

test('K6 — the disk total is the sum of the file sizes, grouped by what the file is; a symbolic link counts as the link', async () => {
  const home = tmpDir('asight-disk-')
  const sizes = { 'claude-capture.ndjson': 1000, 'collector/capture-2026-10-06.ndjson': 2000, 'control/calls.ndjson': 300, 'collector/flows/2026-10-06.ndjson': 40, 'logs/retention.ndjson': 5,
    'raw/journal.jsonl': 6, 'sessions/k1/calls.ndjson': 700, 'sessions/k1/calls.0001.sealed': 80, 'collector/capture-2026-10-05.0001.sealed': 90, 'db/a.duckdb': 4000, 'db/a.duckdb.wal': 7,
    'retention.json': 11, 'collector/ca/asight-ca.pem': 13 }
  for (const [rel, n] of Object.entries(sizes)) put(path.join(home, rel), n)
  fs.symlinkSync(path.join(home, 'claude-capture.ndjson'), path.join(home, 'link.ndjson'))
  const d = await diskUsage({ home })
  const linkSize = fs.lstatSync(path.join(home, 'link.ndjson')).size
  assert.equal(d.total_bytes, Object.values(sizes).reduce((a, b) => a + b, 0) + linkSize, 'a file\'s size once, the link\'s own size for the link — not the size of what it points at')
  assert.equal(d.files, Object.keys(sizes).length + 1)
  assert.deepEqual(Object.fromEntries(DISK_GROUPS.map((g) => [g, d.groups[g].bytes])), {
    captures: 1000 + 2000 + 300 + linkSize, sealed: 80 + 90, sessions: 700, duckdb: 4000 + 7, logs: 40 + 5 + 6, other: 11 + 13 })
  assert.deepEqual(d.unreadable, [])
  assert.equal(d.source, 'lstat')
  assert.deepEqual(d.sealed_paths.map((s) => path.relative(home, s.path)).sort(), ['collector/capture-2026-10-05.0001.sealed', 'sessions/k1/calls.0001.sealed'])
})

test('groupOf: where a file lies and what it is called decide its group, the sealed name first', () => {
  const cases = { 'a.ndjson': 'captures', 'sessions/x/other.ndjson': 'sessions', 'sessions/x/other.0002.sealed': 'sealed', 'x/db.duckdb': 'duckdb', 'logs/y.log': 'logs', 'collector/flows/z.ndjson': 'logs', 'collector/lock': 'other' }
  for (const [rel, g] of Object.entries(cases)) assert.equal(groupOf(rel), g, rel)
})

test('a directory that cannot be read is listed, and the total says nothing it cannot know: the caller sees `unreadable`, not a smaller number passed off as complete', async () => {
  const home = tmpDir('asight-disk-')
  put(path.join(home, 'a.ndjson'), 10)
  put(path.join(home, 'locked', 'b.ndjson'), 99)
  fs.chmodSync(path.join(home, 'locked'), 0o000)
  try {
    const d = await diskUsage({ home })
    assert.equal(d.total_bytes, 10)
    assert.equal(d.unreadable.length, 1)
    assert.match(d.unreadable[0].path, /locked$/)
    assert.match(d.unreadable[0].error, /EACCES|permission/i)
  } finally { fs.chmodSync(path.join(home, 'locked'), 0o755) }
})

test('a home that does not exist is an empty home, not an error: nothing to add up', async () => {
  const d = await diskUsage({ home: path.join(tmpDir('asight-disk-'), 'nope') })
  assert.deepEqual([d.total_bytes, d.files, d.unreadable], [0, 0, []])
})

test('the seal ratio is what the sealed files say: sealed bytes over the bytes of the lines before sealing; an unreadable one is listed and left out', async () => {
  const root = tmpDir('asight-ratio-')
  const recs = Array.from({ length: 30 }, (_, i) => envelope({ id: `r${String(i).padStart(3, '0')}`, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'lorem ipsum '.repeat(40) + i }] }), llm: true }))
  const shard = writeShard(path.join(root, 'collector', 'capture-2026-10-05.ndjson'), recs.map((r) => toLine(r)))
  const original = fs.statSync(shard).size
  await sealUnchecked(shard, { split: false, deleteOriginal: false })
  const [sealed] = listFiles(root)
  fs.writeFileSync(path.join(root, 'collector', 'broken.0001.sealed'), 'not a sealed file at all, only text that is long enough to look like one for a while')
  const d = await diskUsage({ home: root })
  const s = await sealStats(d.sealed_paths)
  assert.equal(s.files, 1)
  assert.equal(s.original_bytes, original, 'the sum of the lines\' lengths in the index is the file the sealer read')
  assert.equal(s.sealed_bytes, fs.statSync(sealed).size)
  assert.equal(s.ratio, fs.statSync(sealed).size / original)
  assert.ok(s.ratio < 1, 'a conversation-shaped file compresses')
  assert.deepEqual(s.unreadable.map((u) => path.basename(u.path)), ['broken.0001.sealed'])
  assert.match(s.unreadable[0].error, /not a sealed file/)
  assert.deepEqual(await sealStats([]), { files: 0, original_bytes: 0, sealed_bytes: 0, ratio: null, unreadable: [] }, 'no sealed file: no ratio (never 0 or 1)')
})

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
async function homeWithStore() {
  const home = tmpDir('asight-rep-')
  const conn = await freshConn()
  await runEtl([sized(full({ id: 'a', at: '2026-10-07T11:00:00.000Z', reqBody: 'x', wire: [1000, 50] }), 1500), sized(logged({ id: 'b', at: '2026-10-07T10:00:00.000Z', wire: [9000, 21] }), 700),
    sized(preD40({ id: 'c', at: '2026-10-07T09:00:00.000Z', rawChars: 321 }), 400)], conn)
  return { home, conn }
}

test('4.4 #15 — no analytics store: the sizes are null with the reason 「需要先跑 asight etl」, never 0; the settings and the disk are still there', async () => {
  const home = tmpDir('asight-rep-')
  put(path.join(home, 'x.ndjson'), 123)
  const r = await retentionReport({ home, conn: null, now: NOW })
  assert.equal(r.sizes, null)
  assert.equal(r.totals, null)
  assert.match(r.sizes_reason, /需要先跑 asight etl/)
  assert.equal(r.disk.total_bytes, 123)
  assert.deepEqual([r.control, r.settings.ok, r.settings.missing], [false, true, true])
  assert.deepEqual(r.classes, ['llm', 'token-count', 'session-sync', 'telemetry', 'files', 'account', 'other'])
  const broken = await retentionReport({ home, conn: null, dbError: 'analytics store unreadable (/x): locked', now: NOW })
  assert.match(broken.sizes_reason, /unreadable.*locked/, 'a store that is there and cannot be read says so')
})

test('the report: sizes with their totals (legacy-meta apart), the estimate marked 估计 when there is a sealed file, harness rows = seen ∪ set', async () => {
  const { home, conn } = await homeWithStore()
  setRetention({ file: path.join(home, 'retention.json'), logFile: path.join(home, 'logs', 'retention.ndjson'), harness: 'codex', class: 'files', level: 'log', source: 'cli', harnesses: ['cc', 'codex', 'unknown'] })
  const r = await retentionReport({ home, conn, control: true, now: NOW })
  assert.equal(r.control, true)
  assert.deepEqual(r.harnesses, ['cc', 'codex'], 'cc was seen in the data; codex only in the settings')
  assert.deepEqual(r.levels, { codex: { files: 'log' } })
  assert.equal(r.sizes.as_of, '2026-10-07 11:00:00')
  assert.deepEqual(r.totals.all.all, { calls: 2, request_bytes: 10000, response_bytes: 71, response_unrecorded: 0, stored_bytes: 2200, stored_unrecorded: 0 }, 'the legacy-meta record is not in the totals')
  assert.deepEqual(r.totals.legacy_meta.all, { calls: 1, request_bytes: 321, response_bytes: 0, response_unrecorded: 1, stored_bytes: 400, stored_unrecorded: 0 })
  assert.deepEqual(r.totals.by_class.telemetry.all.calls, 2)
  assert.equal(r.sizes.estimate.estimate, false, 'no sealed file: no ratio to estimate with — said so, not guessed')
  assert.ok(!('sealed_estimate_bytes' in r.sizes.rows[0].windows.all))
  assert.equal(r.changes.length, 1)
  assert.deepEqual([r.changes[0].harness, r.changes[0].class, r.changes[0].from, r.changes[0].to, r.changes[0].source], ['codex', 'files', 'full', 'log', 'cli'])

  // with a sealed file the estimate appears, marked, as stored bytes × the global ratio
  const recs = Array.from({ length: 20 }, (_, i) => envelope({ id: `r${i}`, body: JSON.stringify({ messages: [{ role: 'user', content: 'lorem '.repeat(200) + i }] }), llm: true }))
  const shard = writeShard(path.join(home, 'collector', 'capture-2026-10-05.ndjson'), recs.map((x) => toLine(x)))
  await sealUnchecked(shard, { split: false, deleteOriginal: true })
  const e = await retentionReport({ home, conn, now: NOW })
  assert.equal(e.sizes.estimate.estimate, true)
  assert.equal(e.sizes.estimate.ratio, e.seal.ratio)
  const cc = e.sizes.rows.find((x) => x.harness === 'cc' && x.class === 'telemetry' && x.retention === 'full').windows.all
  assert.equal(cc.sealed_estimate_bytes, Math.round(cc.stored_bytes * e.seal.ratio))
  assert.equal(e.totals.all.all.sealed_estimate_bytes, Math.round(2200 * e.seal.ratio))
})

test('a settings file that cannot be parsed is in the report with its reason, and every call is kept in full while it is', async () => {
  const home = tmpDir('asight-rep-')
  fs.writeFileSync(path.join(home, 'retention.json'), '{ nope')
  const r = await retentionReport({ home, conn: null, now: NOW })
  assert.equal(r.settings.ok, false)
  assert.match(r.settings.problems[0].reason, /every call is kept in full/)
  assert.deepEqual(r.levels, {})
})

test('the change log: the last N changes, oldest first; a damaged line is skipped; a log that cannot be read is an error, not "no changes"', async () => {
  const home = tmpDir('asight-rep-')
  const log = path.join(home, 'logs', 'retention.ndjson')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const ev = (i) => JSON.stringify({ ts: `2026-10-0${i}T00:00:00.000Z`, event: 'retention-set', harness: 'cc', class: 'telemetry', from: 'full', to: i % 2 ? 'log' : 'full', source: i % 2 ? 'cli' : 'board' })
  fs.writeFileSync(log, [ev(1), 'not json', JSON.stringify({ event: 'something-else' }), ev(2), ev(3), ''].join('\n'))
  const a = await readChanges(log, { limit: 2 })
  assert.deepEqual(a.changes.map((c) => c.ts), ['2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'])
  assert.equal(a.error, null)
  assert.deepEqual(await readChanges(path.join(home, 'none.ndjson')), { changes: [], error: null })
  const bad = await readChanges(home) // a directory is not a log
  assert.deepEqual(bad.changes, [])
  assert.ok(bad.error, 'unreadable → an error string')
})

test('metadata only: nothing of a record\'s bytes is in the report', async () => {
  const home = tmpDir('asight-rep-')
  const conn = await freshConn()
  await runEtl([full({ id: 'a', reqBody: '{"secret":"SECRET-BODY-MARKER"}', headers: { 'user-agent': 'x', host: 'api.anthropic.com', authorization: 'Bearer SECRET-TOKEN-MARKER' } })], conn)
  const text = JSON.stringify(await retentionReport({ home, conn, now: NOW }))
  assert.doesNotMatch(text, /SECRET-BODY-MARKER|SECRET-TOKEN-MARKER/)
})
