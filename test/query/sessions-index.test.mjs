// test/query/sessions-index.test.mjs — `trocar query sessions` is counted from the SEGMENT INDEX, and must
// still be the board's own answer (RFC 1.6 §4.1 速度目标 ≤ 1 s, 附录 C.5).
//
// The list used to read every record back: 4.5 s on Windows and 7.0 s on macOS over the 1 GB reference
// dataset, against a ≤ 1 s budget (test-machine runs, 2026-10-18). It is now derived from the per-segment index
// rows. What this pins is the thing that can drift: each item of the index-derived list must equal, field
// for field, the `meta` of that session's own document, which is counted from its records (附录 C.5: `meta`
// 同 `sessions` 的一项) — on a dataset the generator made, not on a fixture shaped to agree.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { recordsAt } from '../../src/query/records.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'

// every item of the list is the `meta` its own session document carries
const listIsEachMeta = async (home) => {
  const doc = await runQuery('sessions', { limit: '500' }, { home })
  assert.deepEqual(doc.errors, [])
  assert.ok(doc.sessions.length > 1, `the dataset has sessions to compare (${doc.sessions.length})`)
  for (const item of doc.sessions) assert.deepEqual(item, (await runQuery('session', { id: item.session_id }, { home })).meta)
}

const dataset = (bytes = 4_000_000) => {
  const home = path.join(tmpDir('trocar-sessions-'), '.trocar')
  generate({ home, seed: 1, bytes, segmentBytes: 1 << 20 })
  return home
}

test('each item of the index-built sessions list is that session\'s own record-built meta', async () => {
  const home = dataset()
  await listIsEachMeta(home)
})

test('one session is read back from its own records only — the same membership the list counted', async () => {
  const home = dataset()
  const rows = await indexRows({ home })
  const [id, mine] = [...sessionGroups(rows)].find(([, rs]) => rs.length > 1)
  const recs = recordsAt({ home, rows: mine })
  assert.equal(recs.length, mine.length)
  assert.deepEqual(recs.map((r) => r.id), mine.map((r) => r.id))

  const doc = await runQuery('session', { id }, { home })
  assert.equal(doc.meta.session_id, id)
  assert.deepEqual(doc.errors, [])
})

// Capture keeps a request body it could not decode as req_body null + req_body_b64 (a zstd body, one over the
// decode limit); the board decodes it when it reads. The index must read it the same way, or the body's session
// key (and the synthesized key's hash) is lost from the list while the board still has it (review 2026-10-18).
test('a request body stored compressed names the same session in the list as on the board', async () => {
  const home = dataset(1_000_000)
  for (const f of fs.readdirSync(path.join(home, 'raw')).filter((n) => n.endsWith('.ndjson'))) {
    const file = path.join(home, 'raw', f)
    const out = fs.readFileSync(file, 'utf8').split('\n').map((line) => {
      let e
      try { e = JSON.parse(line) } catch { return line } // the half line stays as it is
      if (typeof e.req_body !== 'string' || !e.req_body) return line
      return JSON.stringify({ ...e, req_body: null, req_body_b64: zlib.gzipSync(e.req_body).toString('base64'), req_content_encoding: 'gzip' })
    })
    fs.writeFileSync(file, out.join('\n'))
  }
  await listIsEachMeta(home)
})

// The resident worker keeps one entry per row list, stamped with the list itself — and a row list cannot move (its
// records were appended once). So a result that carried ERRORS must never be the remembered one: a first read that
// landed in the seal rename window, or hit one EIO, would otherwise pin its incomplete answer until the worker exits,
// which is exactly the 「不答陈旧」 of 3.5 §访问模式 (review of D63, 2026-10-20).
test('a read that failed once is not remembered: the next query in the same process gives the whole answer', async () => {
  const home = dataset(1_000_000)
  const rows = (await indexRows({ home })).slice(0, 5)
  let fail = true
  const flaky = { ...fs, openSync: (...a) => {
    if (fail && String(a[0]).endsWith('.ndjson')) { fail = false; throw Object.assign(new Error('EIO: a transient read error'), { code: 'EIO' }) }
    return fs.openSync(...a)
  } }
  const firstErrors = []
  const first = recordsAt({ home, fs: flaky, rows, errors: firstErrors })
  assert.deepEqual(first, [], 'the segment could not be opened at all')
  assert.equal(firstErrors.length, rows.length)
  const errors = []
  const second = recordsAt({ home, fs: flaky, rows, errors })
  assert.deepEqual(second.map((r) => r.id), rows.map((r) => r.id))
  assert.deepEqual(errors, [])
})

test('a row whose offset no longer lands on its line is read by the scan, never as another record', async () => {
  const home = dataset()
  const rows = (await indexRows({ home })).filter((r) => r.offset != null).slice(0, 20)
  const right = recordsAt({ home, rows }).map((r) => JSON.stringify(r))
  const stale = recordsAt({ home, rows: rows.map((r) => ({ ...r.toJSON(), offset: r.offset + 1 })) }).map((r) => JSON.stringify(r))
  assert.deepEqual(stale, right)
})
