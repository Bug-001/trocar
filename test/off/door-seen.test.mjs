// test/off/door-seen.test.mjs — the door's durable record (4.11 P12 「门的持久记录」): a missing file is no row, an unreadable one is "not known"
// (rows null), the write is whole-file, 0600 and bounded to the newest rows, and a row is evidence only while its group's door value is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { readDoorSeen, writeDoorSeen, validRow, DOOR_SEEN_FILE, DOOR_SEEN_MAX } from '../../src/off/door-seen.mjs'

const T = Date.parse('2026-10-22T10:00:00Z'), iso = (ms) => new Date(ms).toISOString()
const row = (i, extra = {}) => ({ harness: 'agentx', group: 'agentx:cli', pid: 100 + i, start: T - 1000, kind: 'accept', at: iso(T + i * 1000), n: 1, decrypt: true, ...extra })

test('no file → no row; a file that is not JSON, has no rows list, or cannot be read → rows null with a reason', () => {
  const dir = tmpDir('door-seen-read')
  assert.deepEqual(readDoorSeen({ dir }), { rows: [], error: null })
  for (const body of ['{"version":1,"rows":[', '{"version":1}', 'null']) {
    fs.writeFileSync(path.join(dir, DOOR_SEEN_FILE), body)
    const r = readDoorSeen({ dir })
    assert.equal(r.rows, null); assert.equal(typeof r.error, 'string')
  }
  fs.rmSync(path.join(dir, DOOR_SEEN_FILE)); fs.mkdirSync(path.join(dir, DOOR_SEEN_FILE)) // EISDIR: unreadable
  assert.equal(readDoorSeen({ dir }).rows, null)
})

test('write → read gives the rows back; the file is replaced whole, 0600, keeping the newest DOOR_SEEN_MAX by `at`', () => {
  const dir = tmpDir('door-seen-write')
  const rows = Array.from({ length: DOOR_SEEN_MAX + 7 }, (_, i) => row(i)).reverse()
  writeDoorSeen({ dir, rows })
  const back = readDoorSeen({ dir })
  assert.equal(back.error, null)
  assert.deepEqual(new Set(back.rows.map((r) => r.pid)), new Set(rows.slice(0, DOOR_SEEN_MAX).map((r) => r.pid)))
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, DOOR_SEEN_FILE)).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir), [DOOR_SEEN_FILE], 'no temp file left')
  writeDoorSeen({ dir, rows: [row(1)] })
  assert.deepEqual(readDoorSeen({ dir }).rows, [row(1)])
})

// validity over the axes: `at` against door_since[group] and since, each before / at / after / absent
const AX = { before: -1, at: 0, after: 1 }
for (const [dl, d] of [...Object.entries(AX), ['absent', null]]) for (const [sl, s] of [...Object.entries(AX), ['absent', null]]) {
  test(`validRow: at ${dl === 'absent' ? 'with no door_since' : `${dl} door_since[group]`}, ${sl === 'absent' ? 'no since' : `${sl} since`}`, () => {
    const r = row(0), at = Date.parse(r.at)
    const l = { ...(d == null ? {} : { door_since: { [r.group]: iso(at - d), 'agentx:other': iso(at + 5000) } }), ...(s == null ? {} : { since: iso(at - s) }) }
    assert.equal(validRow(r, { agentx: l }), (d == null || d >= 0) && (s == null || s >= 0))
  })
}
