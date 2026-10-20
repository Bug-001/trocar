// test/query/disk-links.test.mjs — the disk total follows a top-level folder of the home that is a symbolic link
// (spec 4.2 §保真边界): a user who moved raw/ to another disk is not told the home is empty. Axis = what the link
// points at: a directory outside the home / the home itself or a folder already counted / nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { diskUsage } from '../../src/query/disk.mjs'
import { runQuery } from '../../src/query/named/index.mjs'

// a directory outside the home holding one plaintext segment and one sealed file
function outside() {
  const dir = tmpDir('trocar-disk-out-')
  const records = path.join(dir, '20261017T090000Z.ndjson'), sealed = path.join(dir, '20261016T090000Z.sealed')
  fs.writeFileSync(records, '{"a":1}\n{"b":2}\n')
  fs.writeFileSync(sealed, Buffer.alloc(37, 7))
  return { dir, records: fs.statSync(records).size, sealed: fs.statSync(sealed).size }
}

test('E1 raw/ is a link to a directory elsewhere: its files count as records and sealed', async () => {
  const home = tmpDir('trocar-disk-home-'), out = outside()
  fs.symlinkSync(out.dir, path.join(home, 'raw'))
  for (const fsArg of [undefined, fs.promises]) {
    const du = await diskUsage({ home, ...(fsArg ? { fs: fsArg } : {}) })
    assert.equal(du.groups.records.bytes, out.records)
    assert.equal(du.groups.sealed.bytes, out.sealed)
    assert.ok(du.total_bytes >= out.records + out.sealed)
    assert.deepEqual(du.unreadable, [])
  }
})

test('E2 a link back to the home and a second link to the same folder: every file counted once', async () => {
  const home = tmpDir('trocar-disk-home-'), out = outside()
  fs.symlinkSync(out.dir, path.join(home, 'raw'))
  fs.symlinkSync(out.dir, path.join(home, 'raw-again'))
  fs.symlinkSync(home, path.join(home, 'loop'))
  const du = await diskUsage({ home })
  assert.equal(du.total_bytes, out.records + out.sealed)
  assert.deepEqual(du.unreadable, [])
})

test('E3 a dangling top-level link is named in unreadable and in the classes errors', async () => {
  const home = tmpDir('trocar-disk-home-')
  const link = path.join(home, 'raw')
  fs.symlinkSync(path.join(home, 'gone'), link)
  const du = await diskUsage({ home })
  assert.ok(du.unreadable.some((u) => u.path === link))
  const doc = await runQuery('classes', {}, { home, now: () => Date.parse('2026-10-21T00:00:00Z') })
  assert.ok(doc.errors.some((e) => e.where === link))
})
