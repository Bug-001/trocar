// test/view/extract-hash.test.mjs — extraction hashes each wire block once (RFC 4.3 §3「每条记录抽取一次」, D71②): it takes a block's
// `bid` first and builds a definition (fh, vh, preview, render spec, facts) only for a block the session has no definition for. So the
// bytes sha256 reads while a session is extracted stay within twice the session's wire bytes (once for every bid, and fh / vh only for
// the blocks that are new); hashing fh and vh of every block of every call is about three times them.
//
// Wire bytes of a session = Σ over its records of the request body's bytes + the bytes of the response text its reply blocks are cut
// from (resp.raw, the SSE stream, when it is a string; else the response body's JSON).
//
// Generated sessions (test/query/big-session.mjs) on the two Claude Code wires: 'http' re-sends the whole context each call, 'threads'
// sends a delta and is stitched across records; both carry Claude Code's tool definitions (`cc`) and cache markers.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordsAt } from '../../src/query/records.mjs'
import { openProjection } from '../../src/query/projection.mjs'
import { extractMembers } from '../../src/view/extract.mjs'

const bytesOf = (d, enc) => (typeof d === 'string' ? Buffer.byteLength(d, enc || 'utf8') : d.byteLength)
const wireBytes = (rec) => bytesOf(rec.req_body || '')
  + bytesOf(typeof rec.resp?.raw === 'string' ? rec.resp.raw : JSON.stringify(rec.resp?.body ?? ''))

for (const wire of ['http', 'threads']) {
  test(`extracting a ${wire} session hashes at most twice its wire bytes`, async () => {
    const home = path.join(tmpDir('trocar-extract-hash-'), '.trocar')
    const s = bigSession({ home, wire, cc: 16, growth: 2_000, subEvery: 4, subLen: 20 })
    s.append(120)
    const errors = [], members = sessionGroups(await indexRows({ home, errors })).get(s.id)
    const recs = recordsAt({ home, rows: members, errors, remember: false })
    assert.equal(recs.filter(Boolean).length, members.length)
    const byId = new Map(recs.map((r) => [String(r.id), r]))
    const wireSum = recs.reduce((n, r) => n + wireBytes(r), 0)

    const proto = Object.getPrototypeOf(createHash('sha256')), update = proto.update
    let hashed = 0, r
    proto.update = function (data, enc) { hashed += bytesOf(data, enc); return update.call(this, data, enc) }
    try {
      r = extractMembers({ store: openProjection({ home, key: s.id, write: false }), members, recordsAt: (rows) => rows.map((m) => byId.get(String(m.id))), sessionId: s.id })
    } finally { proto.update = update }
    assert.equal(r.done, r.total)
    assert.ok(hashed <= 2 * wireSum, `${wire}: hashed ${hashed} bytes for ${wireSum} wire bytes`)
  })
}
