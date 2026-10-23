// test/query/answer-cache.test.mjs — the worker's answer cache (RFC 3.5 §谁执行它 答案缓存, 验收 #18).
//
// A session that did not grow is answered with the bytes it was answered with before, without reading one of its records; another
// session's capture does not move it; a session that grew is answered byte for byte as another process (its own fs object, so
// nothing warm is shared: src/query/warm.mjs fsTag) answers it; an unknown name is still the caller's mistake.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { answer } from '../../src/query/answers.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { extendSession } from '../../src/query/named/session.mjs'

// An fs that says which raw segment files were opened or read (a record read back, or the live segment indexed again).
function counting() {
  const touched = []
  const note = (p) => { if (typeof p === 'string' && /[\\/]raw[\\/][^\\/]+\.(ndjson|sealed)$/.test(p)) touched.push(path.basename(p)) }
  const wrap = (name) => (p, ...a) => { note(p); return fs[name](p, ...a) }
  const fds = new Map()
  return {
    touched,
    fs: {
      ...fs,
      readFileSync: wrap('readFileSync'),
      createReadStream: wrap('createReadStream'),
      openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); fds.set(fd, p); return fd },
      readSync: (fd, ...a) => { note(fds.get(fd)); return fs.readSync(fd, ...a) },
      closeSync: (fd) => { fds.delete(fd); return fs.closeSync(fd) },
    },
  }
}

for (const wire of ['http', 'threads', 'ws']) {
  test(`a ${wire} session that did not grow is answered from the cache; another session's capture leaves it there; one that grew is a fresh answer`, async () => {
    const home = path.join(tmpDir('trocar-answers-'), '.trocar')
    const A = bigSession({ home, wire, id: 'aaaa-0000-4a1b-9c2d-000000000001', segment: '20261020T100000Z', growth: 3_000, subEvery: 3, seed: 3 })
    const B = bigSession({ home, wire, id: 'bbbb-0000-4a1b-9c2d-000000000002', segment: '20261020T110000Z', growth: 1_000, subEvery: 0, seed: 5 })
    A.append(30); B.append(10)
    const segA = '20261020T100000Z.ndjson'
    const c = counting(), ctx = { home, fs: c.fs }
    for (const req of [{ name: 'session', params: { id: A.id }, indent: 0 }, { name: 'session', params: { id: A.id, limit: '4' }, indent: 2, gzip: true }]) {
      const first = await answer(req, ctx)
      assert.equal(first.status, 200)
      c.touched.length = 0
      const again = await answer(req, ctx)
      assert.deepEqual([again.status, again.enc], [first.status, first.enc])
      assert.ok(again.bytes.equals(first.bytes), 'the same bytes')
      assert.deepEqual(c.touched.filter((f) => f === segA), [], 'no record of the session read again')

      B.append(2) // capture of another session, in another segment
      c.touched.length = 0
      const other = await answer(req, ctx)
      assert.ok(other.bytes.equals(first.bytes), 'another session grew: the same bytes')
      assert.deepEqual(c.touched.filter((f) => f === segA), [], 'and still no record of this session read')
    }

    A.append(3)
    const req = { name: 'session', params: { id: A.id }, indent: 0 }
    const grew = await answer(req, ctx)
    const fresh = await answer(req, { home, fs: { ...fs } })
    assert.equal(grew.status, 200)
    const doc = JSON.parse(grew.bytes)
    assert.equal(doc.mark, JSON.parse(fresh.bytes).mark)
    // a note (`level`) is about the read that made it (3.5 读不全): the other process indexed cold, this one did not
    const sansNotes = (d) => { const errors = d.errors.filter((e) => !e.level); return JSON.stringify({ ...d, ok: errors.length === 0, errors }) }
    assert.equal(sansNotes(doc), sansNotes(JSON.parse(fresh.bytes)), 'the session grew: answered as another process answers it')
  })
}

test('a session answered with pending is answered again, once the worker\'s slices folded every member, with no pending and the local path\'s bytes', async () => {
  const home = path.join(tmpDir('trocar-answers-'), '.trocar')
  const A = bigSession({ home, id: 'cccc-0000-4a1b-9c2d-000000000003', growth: 4_000, subEvery: 3, compactAt: 40_000, subLanes: 3, late: 2 })
  A.append(160)
  const ctx = { home, fs, writer: true }, req = { name: 'session', params: { id: A.id }, indent: 0 }
  // an answer with `pending` has no version part (4.4 §条件 GET #9): its tag is `-`; a whole one's is the version's digest
  const TAG = /^[0-9a-f]{20}$/
  const tagged = (got) => {
    const doc = JSON.parse(got.bytes)
    if (doc.pending) assert.equal(got.tag, '-', 'an answer with pending carries no tag')
    else assert.match(got.tag, TAG)
    return doc
  }
  const first = tagged(await answer(req, ctx))
  assert.ok(first.pending, 'the worker\'s 50 ms slice left members above the mark')
  while (await extendSession(ctx, A.id, Infinity));
  const done = await answer(req, ctx)
  assert.equal(tagged(done).pending, undefined)
  assert.ok(done.bytes.equals((await answer(req, { home, fs: { ...fs } })).bytes), 'the local path\'s bytes')
  // a worker that starts again (its own fs: nothing warm shared) over a session that grew answers from the fold log at its frontier,
  // the new members above it: the same version on every ask until a slice folds them, and still no tag while `pending` says so
  A.append(20)
  const again = { home, fs: { ...fs }, writer: true }
  let pendings = 0
  for (let i = 0; i < 3; i++) if (tagged(await answer(req, again)).pending) pendings++
  assert.ok(pendings > 0, 'the new members were answered with pending')
  while (await extendSession(again, A.id, Infinity));
  assert.equal(tagged(await answer(req, again)).pending, undefined)
})

test('an unknown query name is still the caller\'s mistake', async () => {
  const home = path.join(tmpDir('trocar-answers-'), '.trocar')
  for (const gzip of [false, true]) {
    const got = await answer({ name: 'no-such-query', params: {}, gzip }, { home, fs })
    assert.equal(got.status, 400)
    assert.equal(got.enc, gzip ? 'gzip' : '-')
    const body = gzip ? (await import('node:zlib')).gunzipSync(got.bytes) : got.bytes
    assert.equal(typeof JSON.parse(body).error, 'string')
  }
})
