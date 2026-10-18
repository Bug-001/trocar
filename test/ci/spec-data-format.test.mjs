// test/ci/spec-data-format.test.mjs — D59 · D60: the data-format units state the current design only.
// A unit that still presents DuckDB tables, the ETL pipeline or a `.closed` marker as a premise would send implementers back to the
// retired design; these checks turn red on that, and on the facts the write / read / seal sides must be able to look up in one place.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPEC = fileURLToPath(new URL('../../spec/01-asight-rfc/', import.meta.url))
const read = (f) => fs.readFileSync(path.join(SPEC, f), 'utf8')
// The units D59 / D60 rewrote: the capture envelope, the raw layer, the read side, the dashboard shell and the models they feed.
const UNITS = ['0.0-overview.md', '2.6-detail-panel.md', '3.2-normalized-model.md', '3.3-cache-model.md', '3.4-session-identity.md',
  '3.5-query-layer.md', '4.1-capture-sources.md', '4.2-storage-etl.md', '4.4-server.md', '4.6-process-collector.md']
const RETIRED = [/DuckDB/, /@duckdb/, /\bETL\b/, /src\/etl\//, /\.closed\b/, /asight etl\b/, /asight keep\b/, /retention\.json/]

test('D59 · D60: no data-format unit presents DuckDB, the ETL pipeline, `asight keep` or a `.closed` marker', () => {
  const hits = []
  for (const unit of UNITS) {
    read(unit).split('\n').forEach((line, i) => {
      if (/^\| D(59|60) \|/.test(line)) return // the two decision rows say what was removed; everywhere else states the current design only
      for (const re of RETIRED) if (re.test(line)) hits.push(`${unit}:${i + 1} ${re.source}`)
    })
  }
  assert.deepEqual(hits, [], 'state the current design: raw segments + segment index + named queries')
})

test('D60①②: 4.2 and 4.6 state where envelopes land, when a segment is closed, and that the daemon publishes its current segment', () => {
  const storage = read('4.2-storage-etl.md'), collector = read('4.6-process-collector.md')
  for (const re of [/~\/\.asight\/raw\/<段>\.ndjson/, /~\/\.asight\/index\//, /128 MB/]) assert.match(storage, re)
  for (const re of [/~\/\.asight\/collector\/lock/, /`segment`/]) assert.match(storage + collector, re)
  // only the daemon seals: no seal lock (one daemon, one queue) and no manual seal command (`asight raw` only prints records)
  for (const re of [/seal\.lock/, /asight raw seal/]) assert.doesNotMatch(storage + collector, re)
})

test('D60②③: `<段>:<行号>` is the ONE ref shape, and the older capture files are not read, moved or touched', () => {
  const capture = read('4.1-capture-sources.md'), storage = read('4.2-storage-etl.md')
  assert.match(capture, /<段>:<行号>/)
  assert.match(capture, /只有这一种 ref 形状|这一种 ref 形状|只有这一种/) // one shape: nothing keeps a second one
  // not backwards compatible : both units name the old path only to say it is left alone
  for (const unit of [capture, storage]) {
    assert.match(unit, /capture-<(YYYY-MM-DD|日期)>\.ndjson/)
    assert.match(unit, /不向后兼容/)
  }
  assert.doesNotMatch(capture + storage, /rename 进 `~\/\.asight\/raw\/`|<YYYYMMDD>T000000Z\.ndjson/)
})

test('附录 D: the reference dataset and measurement scripts live in scripts/', () => {
  const cli = read('1.6-cli.md')
  for (const re of [/scripts\/gen-dataset\.mjs/, /scripts\/perf-query\.mjs/]) assert.match(cli, re)
  assert.doesNotMatch(cli, /test\/lab\/perf\//)
})
