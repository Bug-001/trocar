// test/query/file-id.test.mjs — a file renamed over another is another file, even where the two inodes read as one number: an NTFS
// file id passes 2^53 and a number stat rounds its low bits away, so "is it the file I read?" compares a bigint stat's id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { readIndex } from '../../src/query/index-build.mjs'

// fs whose inodes sit past 2^60 in the order it first sees them: a bigint stat tells them apart, a number one cannot (its ulp there is 256)
function bigInodes(real = fs) {
  const order = new Map()
  const inoOf = (st) => { const k = `${st.dev}:${st.ino}`; if (!order.has(k)) order.set(k, order.size); return 2n ** 60n + BigInt(order.get(k)) }
  const wrap = (fn) => (p, o) => {
    const big = fn(p, { bigint: true }), ino = inoOf(big)
    if (o && o.bigint) return Object.assign(big, { ino })
    return Object.assign(fn(p), { ino: Number(ino) })
  }
  return { ...real, statSync: wrap(real.statSync), fstatSync: wrap(real.fstatSync) }
}

test('the fake: two files a rename apart read as one number and as two bigints', () => {
  const dir = tmpDir(), a = path.join(dir, 'a'), b = path.join(dir, 'b'), f = bigInodes()
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b')
  assert.equal(f.statSync(a).ino, f.statSync(b).ino)
  assert.notEqual(f.statSync(a, { bigint: true }).ino, f.statSync(b, { bigint: true }).ino)
})

test('readIndex: an index renamed over the one a read stopped in is read whole, though its inode reads as the same number', () => {
  const dir = tmpDir(), file = path.join(dir, 'i.json'), f = bigInodes(), V = 7
  const index = (k) => `${JSON.stringify({ id: 'a', k })}\n${JSON.stringify({ m: { n: 1 }, v: V })}\n`
  fs.writeFileSync(file, index('1'))
  const first = readIndex(f, file, V)
  assert.equal(first.records[0].k, '1')
  // a whole rewrite: temp file + rename, the same length and the same mark at the same offset
  fs.writeFileSync(`${file}.tmp`, index('2')); fs.renameSync(`${file}.tmp`, file)
  assert.equal(readIndex(f, file, V, first).records[0].k, '2')
})
