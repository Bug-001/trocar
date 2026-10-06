// test/query/keep-sizes.test.mjs — `asight keep` shows the sizes (RFC 4.6 验收 K6, 3.5 §「保存什么」): the real CLI over a throwaway HOME and a
// store built from D40 records, against values worked out by hand — the same report the board's endpoint serves. Windows count back from the
// real clock here (the CLI has no injected `now`), so the records are placed relative to it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from '../../src/db.mjs'
import { applyDDL } from '../../src/model/schema.mjs'
import { runEtl } from '../../src/etl/orchestrator.mjs'
import { retentionReportFromStore } from '../../src/query/retention.mjs'
import { formatKeepSizes, fmtBytes } from '../../src/capture/keep.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { full, logged, preD40, sized } from '../fixtures/d40-records.mjs'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/asight.mjs')
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString()

async function rig({ withStore = true } = {}) {
  const home = tmpDir('asight-keepsz-')
  const dbPath = path.join(home, 'a.duckdb')
  if (withStore) {
    const db = await openDb(dbPath)
    try {
      await applyDDL(db.connection)
      await runEtl([
        sized(full({ id: 'a', at: ago(2), cls: 'telemetry', reqBody: 'x', wire: [1000, 50] }), 1500),   // 24 h
        sized(full({ id: 'b', at: ago(72), cls: 'telemetry', reqBody: 'x', wire: [2000, 70] }), 2500),  // 7 d, not 24 h
        sized(full({ id: 'c', at: ago(24 * 30), cls: 'telemetry', reqBody: 'x', wire: [4000, 90] }), 4500), // all only
        sized(logged({ id: 'd', at: ago(3), cls: 'telemetry', wire: [9000, 21] }), 700),
        sized(preD40({ id: 'e', at: ago(4), rawChars: 321 }), 400),
      ], db.connection)
    } finally { await db.close() }
  }
  const run = (...argv) => spawnSync(process.execPath, [BIN, 'keep', ...argv], { env: { ...process.env, HOME: home, ASIGHT_DB: '' }, encoding: 'utf8' })
  return { home, dbPath, run }
}

test('K6 — `asight keep --json` over a real store: the sizes per (harness, class, kept) over 24 h / 7 d / all match the hand-computed values, and are the board\'s report', async () => {
  const k = await rig()
  const p = k.run('--db', k.dbPath, '--json')
  assert.equal(p.status, 0, p.stderr)
  const rep = JSON.parse(p.stdout)
  const cell = (cls, kept, win) => rep.sizes.rows.find((r) => r.harness === 'cc' && r.class === cls && r.retention === kept).windows[win]
  assert.deepEqual(cell('telemetry', 'full', '24h'), { calls: 1, request_bytes: 1000, response_bytes: 50, response_unrecorded: 0, stored_bytes: 1500, stored_unrecorded: 0 })
  assert.deepEqual(cell('telemetry', 'full', '7d'), { calls: 2, request_bytes: 3000, response_bytes: 120, response_unrecorded: 0, stored_bytes: 4000, stored_unrecorded: 0 })
  assert.deepEqual(cell('telemetry', 'full', 'all'), { calls: 3, request_bytes: 7000, response_bytes: 210, response_unrecorded: 0, stored_bytes: 8500, stored_unrecorded: 0 })
  assert.deepEqual(cell('telemetry', 'log', '24h'), { calls: 1, request_bytes: 9000, response_bytes: 21, response_unrecorded: 0, stored_bytes: 700, stored_unrecorded: 0 })
  assert.deepEqual(cell('telemetry', 'legacy-meta', 'all'), { calls: 1, request_bytes: 321, response_bytes: 0, response_unrecorded: 1, stored_bytes: 400, stored_unrecorded: 0 })
  // the same function the endpoint calls: nothing the CLI says differs from what the board is shown
  const direct = await retentionReportFromStore({ dbPath: k.dbPath, home: path.join(k.home, '.asight') })
  assert.deepEqual(rep.sizes.rows, direct.sizes.rows)
})

test('`asight keep` (no arguments): the level table, then the sizes per window; a response size never recorded is said so, a log call says its kind, and the disk total is there', async () => {
  const k = await rig()
  const p = k.run('--db', k.dbPath)
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /what is kept of each call/)
  assert.match(p.stdout, /sizes · from the analytics store as of .* \(the last asight etl\) — not live/)
  assert.match(p.stdout, /last 24 h[\s\S]*cc · telemetry\s+full\s+1\s+1\.0 KiB\s+1\.5 KiB/, 'the 24 h block: one call, 1000 + 50 = 1050 B on the wire, 1500 B stored')
  assert.match(p.stdout, /cc · telemetry\s+log\s+1\s+8\.8 KiB/, 'a log call: its wire bytes (9021) are counted, the body is not stored')
  assert.match(p.stdout, /before D40 \(length only\)\s+1\s+321 B \+ 响应未记录 ×1/, 'a pre-D40 record: the length it kept, and its response size is 未记录, not 0')
  assert.match(p.stdout, /~\/\.asight on disk \(lstat sizes, live\)/)
  assert.match(p.stdout, /once sealed: no readable sealed file to estimate from/)
})

test('`asight keep` with no analytics store says 「需要先跑 asight etl」 where the sizes would be — never a table of zeros — and still exits 0', async () => {
  const k = await rig({ withStore: false })
  const p = k.run('--db', path.join(k.home, 'none.duckdb'))
  assert.equal(p.status, 0)
  assert.match(p.stdout, /sizes: 需要先跑 asight etl/)
  assert.doesNotMatch(p.stdout, /last 24 h/)
})

test('setting still works beside the new flags, and the set mode prints no sizes (it does not open a store)', async () => {
  const k = await rig({ withStore: false })
  const p = k.run('cc', 'telemetry', 'log')
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /cc · telemetry: full → log/)
  assert.doesNotMatch(p.stdout, /sizes/)
  assert.equal(k.run('cc', 'nope', 'log').status, 2)
})

test('formatKeepSizes / fmtBytes are pure over a report: a store that predates D40 says what to run; units are 1024-based', () => {
  assert.deepEqual([fmtBytes(0), fmtBytes(1023), fmtBytes(1024), fmtBytes(1536), fmtBytes(5 * 1024 ** 2), fmtBytes(3 * 1024 ** 3)], ['0 B', '1023 B', '1.0 KiB', '1.5 KiB', '5.0 MiB', '3.00 GiB'])
  const lines = formatKeepSizes({ sizes: null, sizes_reason: '需要重建 · the analytics store predates D40 (no harness on calls): run asight etl <source> --rebuild', disk: null })
  assert.match(lines.join('\n'), /sizes: 需要重建 .* --rebuild/)
})
