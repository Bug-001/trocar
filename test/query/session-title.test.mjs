// test/query/session-title.test.mjs — a session's title is its main lane's first prompt, taken from the captured request (RFC 4.4
// §人类标题的来源): `sessions` reads it from the usage sidecar (4.2 §用量旁注 `ask`), so it is null until a sidecar covers a main call,
// and the list's stamp follows the sidecar (4.4 §条件 GET); `session` says the same title from its own fold.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, firstAskOf } from './big-session.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { fillUsage } from '../../src/query/usage.mjs'
import { runQuery, stampOf } from '../../src/query/named/index.mjs'

const SEG = '20261020T164737Z'
const titles = (doc) => doc.sessions.map((m) => [m.session_id, m.title, m.title_source])

for (const wire of ['http', 'chat', 'threads', 'ws']) {
  test(`${wire}: no sidecar → no title; filled → the main lane's task, from the wire; the sessions stamp moved; session says the same`, async () => {
    const home = path.join(tmpDir('trocar-title-'), '.trocar')
    const s = bigSession({ home, wire, growth: 600, subEvery: 3, segment: SEG })
    s.append(9)
    await segmentIndex({ home, segment: SEG, owner: true })
    const ctx = { home, now: () => Date.parse('2026-10-21T00:00:00Z'), env: {} }
    assert.deepEqual(titles(await runQuery('sessions', {}, ctx)), [[s.id, null, null]])
    const stamp = stampOf('sessions', {}, ctx)

    // the query worker's `later`: the list schedules the fill the way `overview` does
    let queued = null
    await runQuery('sessions', {}, { ...ctx, later: (fn) => { queued = fn } })
    assert.equal(typeof queued, 'function', 'a segment without a sidecar is queued for a fill')
    await queued()
    await fillUsage({ home, segments: [] }) // the fill chain has drained

    const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const one = await runQuery('session', { id: s.id, limit: 500 }, ctx)
    const main = one.analyzed.lanes.find((l) => l.kind === 'main')
    const want = firstAskOf(recs[Number(String(main.calls[0].id).split(':').pop()) - 1], recs)
    assert.ok(want, 'the generator wrote a prompt')
    assert.equal(main.task, want)
    assert.deepEqual(titles(await runQuery('sessions', {}, ctx)), [[s.id, want, 'wire']])
    assert.notEqual(stampOf('sessions', {}, ctx), stamp, 'writing the sidecar changed the sessions ETag')
    assert.deepEqual([one.meta.title, one.meta.title_source], [want, 'wire'])
  })
}
