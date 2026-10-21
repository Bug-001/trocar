// test/query/real-session.test.mjs — LOCAL ONLY: the largest session of a real trocar home, read cold by the real worker under its
// real heap, answers 200 with a whole document (RFC 3.5 §内存有界; D38). Generated sessions miss what real captures carry (2026-10-21:
// the worker died on the user's own session while every generated one passed), so this runs before every `trocar update` on the
// machine that runs trocar: `TROCAR_REAL_HOME=<a trocar home> npm run test:real`.
//
// The home is only read: the worker runs over a side home in a temp dir whose raw/ is a link to the real one and whose index/ is a
// copy, so whatever the read builds lands in the temp dir. Without TROCAR_REAL_HOME it is skipped and says why.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { serveFace, request, withToken } from '../server/face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { compareStep } from '../../src/view/step-order.mjs'

const REAL = process.env.TROCAR_REAL_HOME
const skip = REAL ? (fs.existsSync(path.join(REAL, 'raw')) ? false : `TROCAR_REAL_HOME has no raw/: ${REAL}`)
  : 'TROCAR_REAL_HOME is not set (a trocar home to read; run it with `TROCAR_REAL_HOME=<home> npm run test:real`)'

test('the largest real session, read cold by the real worker, answers 200 with a whole document', { skip, timeout: 600_000 }, async () => {
  const home = path.join(tmpDir('trocar-real-'), '.trocar')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.symlinkSync(path.join(path.resolve(REAL), 'raw'), path.join(home, 'raw'))
  if (fs.existsSync(path.join(REAL, 'index'))) fs.cpSync(path.join(REAL, 'index'), path.join(home, 'index'), { recursive: true })
  const groups = sessionGroups(await indexRows({ home }))
  let id = null, most = -1
  for (const [k, rows] of groups) { const b = rows.reduce((n, r) => n + (r.stored_bytes || 0), 0); if (b > most) { most = b; id = k } }
  assert.ok(id, 'the home has a session')
  const failed = []
  const cuts = []
  for (let i = 0; i < 2; i++) { // two fresh workers: a cut is where the session's records put it, not where a process happened to be
    const face = await serveFace({ home, failure: (where, e) => failed.push(`${e.code}: ${e.message}`) })
    try {
      const t0 = Date.now()
      const r = await request(face.port, `/api/session?${new URLSearchParams({ id })}`, { headers: withToken() })
      const ms = Date.now() - t0
      const doc = JSON.parse(r.body) // a cut body is not JSON: it throws here
      assert.equal(r.status, 200, `${id}: ${r.body.slice(0, 600)}`)
      const t = doc.truncated, shown = doc.lanes.reduce((n, l) => n + l.count, 0)
      // the skeleton (3.5 §会话读): the newest page of rows in step order, ≤ 1 MB and ≥ 1 row, at the extraction frontier
      assert.ok(doc.calls.length >= 1 && (doc.calls.length === 1 || Buffer.byteLength(JSON.stringify(doc.calls)) <= 1048576), 'a page is 1 row to 1 MB')
      assert.deepEqual([...doc.calls].sort((a, b) => compareStep(a.ts, a.rid, b.ts, b.rid)), doc.calls, 'rows in step order')
      assert.equal(typeof doc.mark, 'string')
      const t1 = Date.now()
      const d = await request(face.port, `/api/session?${new URLSearchParams({ id, since: doc.mark })}`, { headers: withToken() })
      const delta = JSON.parse(d.body)
      assert.equal(delta.base, doc.mark, 'a delta against the mark just answered')
      console.log(`real session ${id}: ${(most / 1048576).toFixed(0)} MB stored, ${shown} calls shown${t ? ` of ${t.total}` : ''}, ${doc.pending ? `pending ${doc.pending.done}/${doc.pending.total}, ` : ''}cold read ${ms} ms, delta ${Date.now() - t1} ms (${delta.calls.length} rows)`)
      if (t) assert.ok(t.shown === shown && t.shown < t.total, 'a cut session says how many calls it shows of how many')
      cuts.push(t && t.total - t.shown) // the calls left out: a live session grows at the tail between the reads
    } finally { face.close() }
  }
  assert.equal(cuts[1], cuts[0], 'a second fresh worker cuts where the first did (the cut moves on a grid of steps, not per call)')
  assert.deepEqual(failed, [], 'no query worker died')
})
