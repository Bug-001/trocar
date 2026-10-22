// test/query/worker-memory.test.mjs — the query worker never dies of a session's size (RFC 3.5 §内存有界, 验收 11 · 13; 4.4 D66 ③).
//
// The seam the board crosses, crossed the way it does: the real board face (src/server.mjs), the real query service,
// a real fork of src/query/worker.mjs with a SMALL heap (the service's own `fork` seam, as WORKER_MEMORY_MB is passed in production),
// a real loopback socket. One long agent session grows while it is polled the way the replay desk follows it (`sessions`, then
// `session`'s newest page), until its stored bytes are several times the worker's heap — on each wire
// shape a session can have (test/query/big-session.mjs: a whole context per request, or one stitched across records), with subagents
// running side by side whose calls land out of step order. Every answer
// must be a complete JSON document — 200, or a non-2xx JSON error — whole (never `truncated`), with the followed call on the
// newest page, and the worker must never be reported dead (`query-failed`).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { TOKEN, withToken } from '../server/face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { within } from '../helpers/bounded.mjs'
import { heapFlags } from '../../src/query/warm.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const HEAP_MB = 128 // a third of the production worker's: the session below outgrows it several times over
const MB = 1 << 20

// a note (`level`) is about the read that made it (3.5 读不全): a cold fold indexed the segment, a warm one did not
const sansNotes = (d) => { const errors = d.errors.filter((e) => !e.level); return JSON.stringify({ ...d, ok: errors.length === 0, errors }) }

// subagents run side by side and their calls end late (written after calls that started after them), as on a live session
for (const shape of [{ wire: 'http' }, { wire: 'threads', growth: 60_000 }, { wire: 'ws', growth: 60_000 }].map((x) => ({ ...x, subLanes: 4, late: 3 })))
test(`3.5 验收 11: a ${shape.wire} session growing past the worker heap while the board follows it gets a complete answer every time, and no worker dies`, { timeout: 180_000 }, async () => {
  const home = path.join(tmpDir('trocar-wmem-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, ...shape })
  s.growTo(4 * MB)
  const failed = []
  const svc = createQueryService({ home, failure: (where, e) => failed.push(`${e.code}: ${e.message}`),
    fork: (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, ...heapFlags(HEAP_MB)] }) })
  const { server } = createServer({ home, token: TOKEN, query: svc })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  /** → the parsed document of a 2xx, or {status, error} of a non-2xx; anything else (a cut body, a 2xx that is not JSON) throws. */
  const get = async (name, params = {}) => {
    const r = await fetch(`${base}/api/${name}?${new URLSearchParams(params)}`, { headers: withToken() })
    // rejects when the transfer was aborted; the worker's own reason is said with it
    const text = await r.text().catch((e) => { throw new Error(`${name}: ${e.message}; worker: ${failed.join(' / ').slice(0, 1500)}`) })
    const doc = JSON.parse(text) // a complete answer is JSON, whatever its status
    if (r.status >= 200 && r.status < 300) return { doc, text }
    assert.equal(typeof doc.error, 'string', `a ${r.status} says why`)
    return { status: r.status, error: doc.error }
  }
  // The desk's follow: the listing, then the session's newest page
  const follow = async () => {
    const list = await get('sessions')
    assert.ok(list.doc, list.error)
    const listed = list.doc.sessions.find((x) => x.session_id === s.id)
    assert.ok(listed, 'the session is listed')
    return { ...(await get('session', { id: s.id })), listed: listed.calls }
  }
  // a session not yet extracted to its last member answers with `pending` (3.5 后台抽取): followed until it answers without
  const settled = () => within((async () => { for (;;) { const a = await follow(); if (!a.doc || !a.doc.pending) return a; await new Promise((d) => setTimeout(d, 20)) } })(), 60_000, 'the session answered without pending')
  try {
    // the first answer places the page (its anchor lane's last call at the middle); an unchanged session then answers the same bytes
    const quiet = async () => { await settled(); const q = []; for (let i = 0; i < 2; i++) q.push((await follow()).text); return q }
    const q1 = await quiet()
    assert.ok(q1[0] && q1[0] === q1[1], 'an unchanged session answers the same bytes')
    let polls = 0, whole = 0
    for (let stored = 4 * MB; stored < 60 * MB; stored = s.append(shape.growth ? 120 : 12)) {
      const a = await settled()
      polls++
      if (!a.doc) continue // a non-2xx JSON error is a complete answer too
      whole++
      assert.equal(a.doc.truncated, null, 'no session is cut for its size')
      assert.equal(a.doc.lanes.reduce((n, l) => n + l.count, 0), a.listed, 'the lanes count every call of the session')
      const main = a.doc.lanes.find((l) => l.kind === 'main')
      assert.ok(a.doc.calls.some((r) => r.rid === main.last), 'the followed call rides the newest page')
    }
    // the session was followed, not answered with errors: every poll past the first is a whole document
    assert.ok(polls > 1 && whole >= polls - 1, `${whole} of ${polls} polls answered with the session`)
    // grown poll by poll, or folded from scratch in a process that never saw the session: the same bytes
    const q2 = await quiet()
    assert.ok(q2[0] && q2[0] === q2[1])
    const cold = await runQuery('session', { id: s.id }, { home })
    assert.equal(sansNotes(cold), sansNotes(JSON.parse(q2[0])), 'the grown state answers what a reduction from scratch does')
    assert.deepEqual(failed, [], 'no query worker died')
  } finally {
    server.close(); svc.stop()
  }
})
