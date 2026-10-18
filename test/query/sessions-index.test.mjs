// test/query/sessions-index.test.mjs — `asight query sessions` is counted from the SEGMENT INDEX, and must
// still be the board's own answer (RFC 1.6 §4.1 速度目标 ≤ 1 s, 附录 C.5).
//
// The list used to read every record back: 4.5 s on Windows and 7.0 s on macOS over the 1 GB reference
// dataset, against a ≤ 1 s budget (test-machine runs, 2026-10-18). It is now derived from the per-segment index
// rows. What this pins is the thing that can drift: the index-derived document must equal, field for
// field, what the board derives from the records themselves — on a dataset the generator made, not on a
// fixture shaped to agree.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { sessionMetasOf } from '../../src/view/board.mjs'
import { allRecords, recordsAt } from '../../src/query/records.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'

const dataset = (bytes = 4_000_000) => {
  const home = path.join(tmpDir('asight-sessions-'), '.asight')
  generate({ home, seed: 1, bytes, segmentBytes: 1 << 20 })
  return home
}

test('the sessions document is the board\'s own grouping over the records, derived from the index instead', async () => {
  const home = dataset()
  const want = sessionMetasOf(await allRecords({ home }))
    .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)))
    .slice(0, 500)
  const doc = await runQuery('sessions', { limit: '500' }, { home })
  assert.ok(want.length > 10, `the dataset has sessions to compare (${want.length})`)
  assert.deepEqual(doc.sessions, want)
  assert.deepEqual(doc.errors, [])
})

test('one session is read back from its own records only — the same membership the list counted', async () => {
  const home = dataset()
  const rows = await indexRows({ home })
  const [id, mine] = [...sessionGroups(rows)].find(([, rs]) => rs.length > 1)
  const recs = recordsAt({ home, rows: mine })
  assert.equal(recs.length, mine.length)
  assert.deepEqual(recs.map((r) => r.id), mine.map((r) => r.id))
  // the same records the whole-corpus read would have put in this session, byte-identical envelopes
  const all = await allRecords({ home })
  const theirs = all.filter((r) => mine.some((m) => m.id === r.id))
  assert.deepEqual(recs.map((r) => JSON.stringify(r)), theirs.map((r) => JSON.stringify(r)))

  const doc = await runQuery('session', { id }, { home })
  assert.equal(doc.meta.session_id, id)
  assert.deepEqual(doc.errors, [])
})
