// test/query/worker-memory.test.mjs — the query worker never dies of a session's size (RFC 3.5 §内存有界, 验收 11 · 13; 4.4 D66 ③).
//
// The seam the board crosses, crossed the way it does: the real board face (src/server.mjs), the real query service,
// a real fork of src/query/worker.mjs with a SMALL heap (the service's own `fork` seam, as WORKER_MEMORY_MB is passed in production),
// a real loopback socket. One long agent session grows while it is polled the way the replay desk follows it (`sessions`, then
// `session` at the tail), until its stored bytes are several times what the worker's heap could assemble. Every answer must be a
// complete JSON document — 200, or a non-2xx JSON error — and the worker must never be reported dead (`query-failed`).
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

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const HEAP_MB = 128 // a third of the production worker's: the session below outgrows it several times over
const MB = 1 << 20

test('3.5 验收 11: a session growing past the worker heap while the board follows it gets a complete answer every time, and no worker dies', { timeout: 180_000 }, async () => {
  const home = path.join(tmpDir('trocar-wmem-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home })
  s.growTo(4 * MB)
  const failed = []
  const svc = createQueryService({ home, failure: (where, e) => failed.push(`${e.code}: ${e.message}`),
    fork: (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, `--max-old-space-size=${HEAP_MB}`] }) })
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
  // The desk's follow: the tail of the session, anchored on the total its own last answer gave (the board's PAGE_LIMIT).
  let total = null
  const follow = async () => {
    const list = await get('sessions')
    assert.ok(list.doc, list.error)
    const listed = list.doc.sessions.find((x) => x.session_id === s.id)
    assert.ok(listed, 'the session is listed')
    const page = await get('session', { id: s.id, after: String(Math.max(0, (total ?? listed.calls) - 60)), limit: '60' })
    if (!page.doc) return page
    total = page.doc.page.total
    return { ...page, listed: listed.calls }
  }
  try {
    // Whole and quiet: the whole assembly is built only after an answer was written and only once the session stopped growing
    // (3.5 验收 13); the page read from it (the third poll) is the same document, byte for byte, as the window assembled cold.
    const quiet = async () => { const q = []; for (let i = 0; i < 3; i++) q.push((await follow()).text); return q }
    const q1 = await quiet()
    assert.ok(q1[0] && q1[0] === q1[1] && q1[1] === q1[2], 'an unchanged session answers the same bytes, cold or warm')
    assert.equal(JSON.parse(q1[0]).truncated, null)
    const seen = { whole: 0, truncated: 0 }
    for (let stored = 4 * MB; stored < 60 * MB; stored = s.append(12)) {
      const a = await follow()
      if (!a.doc) continue // a non-2xx JSON error is a complete answer too
      const t = a.doc.truncated
      if (t) {
        seen.truncated++
        assert.equal(t.total, a.listed, 'truncated.total counts every call of the session')
        assert.equal(a.doc.page.total, t.shown, 'the page counts the calls it read')
        assert.ok(t.shown >= 1 && t.shown < t.total)
      } else {
        seen.whole++
        assert.equal(a.doc.page.total, a.listed, 'a whole session is paged over every call')
      }
    }
    assert.ok(seen.whole > 0 && seen.truncated > 0, `the session was polled both whole and past the budget (${JSON.stringify(seen)})`)
    const q2 = await quiet()
    assert.ok(q2[0] && q2[0] === q2[1] && q2[1] === q2[2], 'past the budget the tail is read again: the same bytes')
    assert.deepEqual(failed, [], 'no query worker died')
  } finally {
    server.close(); svc.stop()
  }
})
