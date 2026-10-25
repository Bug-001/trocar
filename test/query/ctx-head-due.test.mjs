// test/query/ctx-head-due.test.mjs — when the worker writes ctx/<k>/head.json.gz (RFC 3.5 §谁执行它「答案文件」, 验收 #36): at the end of
// a request or slice only once HEAD_MS passed since its last write or when the file is absent; the idle sidecar save writes a head
// that lags the session's state. In process with ctx.writer:true; HEAD_MS is raised through TROCAR_HEAD_MS (read once, at load) so
// the in-window slice does not depend on how busy the machine is.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

process.env.TROCAR_HEAD_MS = '600000'
const { runQuery } = await import('../../src/query/named/index.mjs')
const { extendSession, saveIndexes } = await import('../../src/query/named/session.mjs')
const { sessionDir } = await import('../../src/query/projection.mjs')
delete process.env.TROCAR_HEAD_MS

test('3.5 #36: a slice inside HEAD_MS leaves the head as it was; the idle save writes the local path\'s head at the same mark; a removed head is written by the next request', { timeout: 120_000 }, async () => {
  const home = path.join(tmpDir('trocar-headdue-'), '.trocar')
  const s = bigSession({ home, id: 'eeee-0000-4a1b-9c2d-000000000005', subLanes: 2, subEvery: 4 })
  s.append(40)
  const ctx = { home, writer: true }, file = path.join(sessionDir(home, s.id), 'head.json.gz')
  const onDisk = () => gunzipSync(fs.readFileSync(file)).toString('utf8')
  while (await extendSession(ctx, s.id, Infinity));
  const m1 = JSON.parse(onDisk()).mark
  assert.ok(m1, 'the first slice wrote a tier-1 head')
  s.append(12)
  while (await extendSession(ctx, s.id, Infinity));
  assert.equal(JSON.parse(onDisk()).mark, m1, 'a slice at the frontier inside HEAD_MS did not write the head')
  saveIndexes()
  const local = JSON.stringify(await runQuery('session', { id: s.id, head: true }, { home }))
  assert.notEqual(JSON.parse(local).mark, m1)
  assert.equal(onDisk(), local, 'the idle save wrote the head of the session\'s state: the local path\'s bytes')
  fs.unlinkSync(file)
  const answer = JSON.stringify(await runQuery('session', { id: s.id, head: true }, ctx))
  assert.equal(onDisk(), answer, 'the request wrote the missing head, its own bytes')
})
