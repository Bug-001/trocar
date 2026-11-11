// test/ci/file-id.test.mjs — "is it still the same file?" is asked of a bigint stat, through src/file-id.mjs: a number stat's ino loses its
// low bits past 2^53 and an NTFS file id reaches 2^64, so a file and the one that replaced it can read as one number. A new `.ino` read
// anywhere else goes red here; the one other file reads it from a bigint stat already.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findIn } from '../helpers/code-text.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mjs') ? [path.join(d, e.name).split(path.sep).join('/')] : [])
// src/server.mjs: the tail's ETag is `"<ino>-<birthtimeNs>"` of a bigint fstat (4.4 §尾的代标签)
const READS_INO = new Set(['src/file-id.mjs', 'src/server.mjs'])

test('file identity: no file of src/ reads a stat\'s ino but src/file-id.mjs (and the tail ETag, a bigint fstat)', () => {
  const found = walk('src').filter((f) => !READS_INO.has(f)).flatMap((f) =>
    findIn(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\.ino\b/g).map((m) => `${f}:${m.line}`))
  assert.deepEqual(found, [], 'take the stat with { bigint: true } and its id from src/file-id.mjs')
})
