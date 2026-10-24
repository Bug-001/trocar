// test/query/ctx-layout.test.mjs — 4.3 §4 迁移 (acceptance 4.3 #9, the layout half): a home whose ctx/ holds a session's projection,
// fold log and their sidecars in the flat layout (`<k>.ndjson`, `<k>.idx`, `<k>.fold.ndjson`, `<k>.fold.idx`) has them renamed into
// `ctx/<k>/` on the session's first read, under the names of the directory layout, and answers byte for byte what it answered before.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { saveIndexes, extendSession } from '../../src/query/named/session.mjs'
import { sessionDir } from '../../src/query/projection.mjs'

const q = (name, home, params) => runQuery(name, params, { home, fs, writer: true })
async function answers(home, id) {
  for (let i = 0; i < 500 && await extendSession({ home, fs, writer: true }, id, Infinity); i++);
  const doc = await q('session', home, { id })
  assert.equal(doc.pending, undefined, 'settled')
  const lanes = []
  for (const l of doc.lanes) lanes.push(await q('lane', home, { id, lane: l.lane }))
  return JSON.stringify({ doc, lanes })
}
const FLAT = { 'extract.0.ndjson': '.ndjson', 'extract.idx': '.idx', 'fold.0.ndjson': '.fold.ndjson', 'fold.idx': '.fold.idx' }

test('4.3 #9: the flat layout is renamed into ctx/<k>/ on the first read; the answers are the same bytes', { timeout: 300_000 }, async () => {
  for (const wire of ['http', 'threads']) {
    const home = path.join(tmpDir('trocar-layout-'), '.trocar')
    const s = bigSession({ home, wire, growth: 200, subEvery: 3 })
    s.append(8)
    await answers(home, s.id)
    saveIndexes()
    // copies at new paths: a store of their own in this process, opened cold
    const [kept, flat] = ['kept', 'flat'].map((t) => { const to = path.join(tmpDir(`trocar-layout-${t}-`), '.trocar'); fs.cpSync(home, to, { recursive: true }); return to })
    const before = await answers(kept, s.id)
    const dir = sessionDir(flat, s.id), inode = {}
    assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(FLAT).sort(), `${wire}: the directory layout is what was built`)
    for (const [n, ext] of Object.entries(FLAT)) { fs.renameSync(path.join(dir, n), dir + ext); inode[n] = fs.statSync(dir + ext).ino }
    fs.rmdirSync(dir)
    const after = await answers(flat, s.id)
    assert.equal(after, before, `${wire}: the answers after the move`)
    const ctx = path.dirname(dir)
    assert.deepEqual(fs.readdirSync(ctx).filter((n) => n.startsWith(path.basename(dir))), [path.basename(dir)], `${wire}: no flat file is left`)
    for (const n of Object.keys(FLAT)) assert.equal(fs.statSync(path.join(dir, n)).ino, inode[n], `${wire}: ${n} is the flat file renamed, not a copy`)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  }
})
