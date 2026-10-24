// test/view/extract-seed.test.mjs — the extraction context a stored projection is opened with comes from its sidecar (4.3 §4 旁索引:
// each lane hint's last call, each linkable call by its link), and what it answers is what a context that notes every stored row
// answers: a continuation that names a reply from early in the session, before any recent window, is stitched to that reply's call.
//
// A generated Claude Code session on Message Threads (test/query/big-session.mjs 'threads') is extracted and its sidecar saved with
// the context; the home is copied and the copy's sidecar removed. A record shaped like the session's last continuation, naming the
// reply of the session's third call, is extracted over each (a fresh store: a fresh context). Each projection's keyed lines (the
// definitions by bid, the call rows by rid) are byte-identical, and the record's row is stitched (its context is not partial).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordsAt } from '../../src/query/records.mjs'
import { openProjection, projectionFile } from '../../src/query/projection.mjs'
import { sidecarOf } from '../../src/query/line-file.mjs'
import { extractMembers, extractSeed } from '../../src/view/extract.mjs'
import { replyIdOf } from '../../src/dissect/cc-threads.mjs'

const keyed = (file) => {
  const out = new Map()
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue
    const o = JSON.parse(l)
    if (o.d) out.set(`d ${o.d.bid}`, l)
    if (o.c) out.set(`c ${o.c.rid}`, l)
  }
  return out
}

test('a continuation naming an early reply still stitches when the context is seeded from the sidecar', async () => {
  const home = path.join(tmpDir('trocar-extract-seed-'), '.trocar')
  const s = bigSession({ home, wire: 'threads', cc: 4, growth: 1_000, subEvery: 4, subLen: 12 })
  s.append(160)
  const errors = [], members = sessionGroups(await indexRows({ home, errors })).get(s.id)
  const recs = recordsAt({ home, rows: members, errors, remember: false })
  const byId = new Map(recs.map((r) => [String(r.id), r]))
  const store = openProjection({ home, key: s.id })
  assert.equal(extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(String(m.id))), sessionId: s.id }).done, members.length)
  assert.ok(store.saveIndex(extractSeed(store)), 'the sidecar was written')
  store.close()

  // the record: the last continuation's shape, naming the reply of the third call (older than any recent window)
  const early = recs.map(replyIdOf).filter(Boolean)[2]
  const last = recs.filter((r) => JSON.parse(r.req_body).thread?.type === 'continue').at(-1)
  const body = JSON.parse(last.req_body)
  body.thread.previous_message_id = early
  const ts = new Date(Date.parse(last.ts_request) + 1000).toISOString()
  const rec = { ...last, id: 'continues-early', ts, ts_request: ts, ts_response_start: ts, ts_response_end: ts, req_body: JSON.stringify(body) }
  const more = [...members, { ...members.at(-1), id: rec.id, stored_bytes: Buffer.byteLength(JSON.stringify(rec)) }]
  byId.set(rec.id, rec)

  const bare = path.join(tmpDir('trocar-extract-seed-'), '.trocar')
  fs.cpSync(home, bare, { recursive: true })
  fs.rmSync(sidecarOf(projectionFile(bare, s.id)))
  const lines = []
  for (const h of [home, bare]) {
    const st = openProjection({ home: h, key: s.id })
    assert.equal(extractMembers({ store: st, members: more, recordsAt: (rows) => rows.map((m) => byId.get(String(m.id))), sessionId: s.id }).done, more.length)
    const row = st.rows.get(rec.id)
    assert.equal(row.x.facts.continued, true)
    assert.equal(row.x.facts.ctxPartial, false, 'stitched to the early reply')
    st.close()
    lines.push(keyed(projectionFile(h, s.id)))
  }
  assert.deepEqual(lines[0], lines[1])
})
