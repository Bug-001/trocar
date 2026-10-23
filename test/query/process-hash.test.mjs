// test/query/process-hash.test.mjs — RFC 4.3 §4 门槛「哈希按线上字节有界」(D71②): while one session goes from extraction to its first
// answer, every byte node:crypto hashes in the process (extraction, the raw line checks, the projection, the sealed frame index tail:
// the whole process, not extraction alone, which test/view/extract-hash.test.mjs bounds) stays within twice the session's wire bytes.
//
// Wire bytes of a session = Σ over its records of the request body's bytes + the bytes of the response text its reply blocks are cut
// from (resp.raw when it is a string; else the response body's JSON).
//
// The count starts from a cold frame cache (releaseDecoded()): measuring the wire bytes reads every record once, and a warm line cache
// would hide the line checks a worker that opens the session pays.
//
// Generated sessions (test/query/big-session.mjs) on the two Claude Code wires, 'http' (re-sends the whole context) and 'threads'
// (sends a delta, stitched across records), sealed as they grow so every member is read from a sealed segment. The driver is the
// query worker's: fold in slices (extendSession as the writer), then answer `session`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordsAt, releaseDecoded } from '../../src/query/records.mjs'

const bytesOf = (d, enc) => (typeof d === 'string' ? Buffer.byteLength(d, enc || 'utf8') : d.byteLength)
const wireBytes = (rec) => bytesOf(rec.req_body || '')
  + bytesOf(typeof rec.resp?.raw === 'string' ? rec.resp.raw : JSON.stringify(rec.resp?.body ?? ''))

for (const wire of ['http', 'threads']) {
  test(`a ${wire} session from extraction to its answer hashes at most twice its wire bytes, the whole process`,
    { todo: 'whole-process hashing is still over 2x its wire bytes', timeout: 300_000 }, async () => {
      const home = path.join(tmpDir('trocar-process-hash-'), '.trocar')
      const s = bigSession({ home, wire, cc: 16, growth: 2_000, subEvery: 4, subLen: 20, seal: 256 << 10 })
      for (let i = 0; i < 4; i++) { s.append(40); await s.seal() }
      const errors = [], members = sessionGroups(await indexRows({ home, errors })).get(s.id)
      const segs = new Set(members.map((r) => r.segment))
      for (const seg of segs) {
        assert.ok(fs.existsSync(path.join(home, 'raw', `${seg}.sealed`)), `segment ${seg} is sealed`)
        assert.ok(!fs.existsSync(path.join(home, 'raw', `${seg}.ndjson`)), `segment ${seg} has no plaintext left`)
      }
      const recs = recordsAt({ home, rows: members, errors, remember: false })
      assert.equal(recs.filter(Boolean).length, members.length)
      const wireSum = recs.reduce((n, r) => n + wireBytes(r), 0)
      releaseDecoded()

      const { runQuery } = await import('../../src/query/named/index.mjs')
      const { extendSession } = await import('../../src/query/named/session.mjs')
      const proto = Object.getPrototypeOf(createHash('sha256')), update = proto.update
      let hashed = 0, doc
      proto.update = function (data, enc) { hashed += bytesOf(data, enc); return update.call(this, data, enc) }
      try {
        while (await extendSession({ home, writer: true }, s.id, 4)) await new Promise((ok) => setImmediate(ok))
        doc = await runQuery('session', { id: s.id }, { home })
      } finally { proto.update = update }
      assert.equal(doc.pending, undefined, 'the session was folded whole')
      assert.ok(hashed <= 2 * wireSum, `hashed ${hashed} bytes over ${wireSum} wire bytes (${(hashed / wireSum).toFixed(2)}x, gate 2x)`)
    })
}
