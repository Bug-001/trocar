// test/query/disk-groups.test.mjs — what counts as records (1.6 C.5 `records_bytes`: the plaintext segments in raw/): the
// segment index under index/ holds .ndjson files of its own (context projections, fold logs), and they are the index, not records.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { diskUsage, groupOf } from '../../src/query/disk.mjs'

test('an .ndjson or .sealed file under index/ is the index; raw/ segments are records and sealed', async () => {
  for (const rel of ['index/ctx/x/open.0.ndjson', 'index/ctx/x/extract.0.ndjson', 'index/x.sealed']) assert.equal(groupOf(rel), 'index', rel)
  assert.equal(groupOf('raw/20261017T090000Z.ndjson'), 'records')
  assert.equal(groupOf('raw/20261016T090000Z.sealed'), 'sealed')

  const home = tmpDir('trocar-disk-groups-')
  const put = (rel, bytes) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes, 0x61)) }
  put('raw/20261017T090000Z.ndjson', 11)
  put('index/ctx/k/open.0.ndjson', 1000)
  const du = await diskUsage({ home })
  assert.equal(du.groups.records.bytes, 11)
  assert.equal(du.groups.index.bytes, 1000)
})
