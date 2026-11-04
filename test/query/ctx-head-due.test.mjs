// test/query/ctx-head-due.test.mjs — when the worker writes ctx/<k>/head.json.gz (RFC 3.5 §谁执行它「答案文件」, 验收 #36): at the end of
// a request or slice only when a part only the head carries changed (here: a sealed pack, a new chapter on the axis), when this
// worker wrote none of the session yet, or when the file is absent; a slice that only grows the open span leaves the file as it was,
// whatever time passed. The idle sidecar save writes a head that lags the session's state. In process with ctx.writer:true; one
// call per slice, each slice's packs and chapters taken from the local path's head at the same mark.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { homeWith, SEGMENT } from '../helpers/session-doc.mjs'
import { laneOf, SID } from '../helpers/compaction-lane.mjs'

const J = JSON.stringify, PACK = 512 // 3.5 §会话读 `lane --pack`: pack n = the members at write positions [512n, 512(n+1))

test('3.5 #36: only a slice that seals a pack or starts a chapter rewrites the head; the idle save writes the local path\'s head at the same mark; a removed head is written by the next request', { timeout: 300_000 }, async () => {
  const home = path.join(tmpDir('trocar-headdue-'), '.trocar')
  // subagents that never compact (subLen), so the session's compactions are the main lane's chapters
  const s = bigSession({ home, id: 'eeee-0000-4a1b-9c2d-000000000005', growth: 300, subEvery: 4, subLanes: 2, subLen: 1e9, compactAt: 30_000 })
  const ctx = { home, writer: true }, file = path.join(sessionDir(home, s.id), 'head.json.gz')
  const onDisk = () => gunzipSync(fs.readFileSync(file)).toString('utf8')
  const fold = async () => { while (await extendSession(ctx, s.id, Infinity)); }
  let members = 40
  s.append(members)
  await fold()
  assert.equal(JSON.parse(onDisk()).tier, 1, 'the worker\'s first slice of the session wrote a tier-1 head')
  // per slice: the local path's head at the same mark (the truth of its packs and chapters) and the head file after it
  const shape = (d) => J([d.packs.length, d.open && d.open.n, d.chapters.length])
  let last = onDisk(), sealed = 0, chaptered = 0, quiet = 0
  while (members < PACK + 30) {
    s.append(1); members++
    await fold()
    const text = onDisk(), local = JSON.parse(J(await runQuery('session', { id: s.id, head: true }, { home }))), was = JSON.parse(last)
    if (shape(local) !== shape(was)) {
      sealed += local.packs.length !== was.packs.length; chaptered += local.chapters.length !== was.chapters.length
      assert.equal(text, J(local), `the slice at ${members} members sealed a pack or started a chapter: it wrote the head at its mark`)
      last = text
    } else {
      quiet++
      assert.equal(text, last, `a slice at ${members} members that only grew the open span left the head file as it was`)
    }
  }
  assert.ok(sealed === 1 && chaptered >= 2 && quiet > 100, `the run sealed a pack (${sealed}), started chapters (${chaptered}) and grew the open span (${quiet})`)
  // one more slice that only grows the open span, with no local read after it (in this process the local path's slice of the session
  // lets go of the state a worker slice left behind: the two never share a process otherwise)
  s.append(1)
  await fold()
  const behind = onDisk()
  saveIndexes()
  const local = J(await runQuery('session', { id: s.id, head: true }, { home }))
  assert.notEqual(JSON.parse(behind).mark, JSON.parse(local).mark, 'the last slice left the head behind the session')
  assert.equal(onDisk(), local, 'the idle save wrote the head of the session\'s state: the local path\'s bytes')
  fs.unlinkSync(file)
  const answer = JSON.stringify(await runQuery('session', { id: s.id, head: true }, ctx))
  assert.equal(onDisk(), answer, 'the request wrote the missing head, its own bytes')
})

test('3.5 #36: the slice after a marked compaction writes the head with one more chapter, though it counts no compaction', { timeout: 60_000 }, async () => {
  const recs = laneOf('anthropic', ['grow', 'grow', 'grow', 'mark', 'drop', 'grow'])
  const home = homeWith(recs.slice(0, 3)), ctx = { home, writer: true }, file = path.join(sessionDir(home, SID), 'head.json.gz')
  const onDisk = () => gunzipSync(fs.readFileSync(file)).toString('utf8')
  const slice = async (rec) => {
    fs.appendFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), `${J(rec)}\n`)
    while (await extendSession(ctx, SID, Infinity));
    return JSON.parse(onDisk())
  }
  while (await extendSession(ctx, SID, Infinity));
  const marked = await slice(recs[3])
  assert.equal(marked.chapters.length, 1, 'the marked step closes its chapter; the next one has not come')
  const landed = await slice(recs[4])
  assert.equal(landed.stats.compactions, marked.stats.compactions)
  assert.equal(landed.chapters.length, marked.chapters.length + 1)
  assert.equal(onDisk(), J(await runQuery('session', { id: SID, head: true }, { home })), 'the local path\'s head at that mark')
  const before = onDisk()
  await slice(recs[5])
  assert.equal(onDisk(), before, 'the slice after that only grows the open span')
})
