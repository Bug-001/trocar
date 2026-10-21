// test/query/worker-cold-heap.test.mjs — a session shaped like the user's live Claude Code one, read cold by the real worker under
// its real heap, answers with a whole document (RFC 3.5 §内存有界: 工作进程 MUST NOT 因为任何一个会话的大小而退出; D38; invariant 4).
//
// The shape is what made the worker die on a real machine: Message Threads, many sub-agent lanes side by side whose
// calls end late, and every request carrying Claude Code's tool definitions and cache markers (test/query/big-session.mjs `cc`) —
// so what a fold keeps per call can be far more than the plan reckons. The seam is crossed the way the board crosses it: the real
// board face, the real query service, the worker forked as the service forks it (test/helpers/worker-fork.mjs: WORKER_MEMORY_MB),
// a real socket. The answer is 200 and whole JSON; a cut session says so (`truncated`, counted against the listing); no worker dies.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { serveFace, request, withToken } from '../server/face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
const rowsOf = (doc) => doc.lanes.reduce((n, l) => n + l.count, 0)

const CALLS = 1_500 // ~150 MB stored; the fold before the measured bound kept ~300 KB a call of this shape and died near 1 000

test('3.5 §内存有界: a cold read of a large real-shaped session answers 200 with a whole document, cut and said so if it must be', { timeout: 300_000 }, async () => {
  const home = path.join(tmpDir('trocar-coldheap-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, wire: 'threads', growth: 3_000, subEvery: 2, subLanes: 8, subLen: 60, late: 3, compactAt: 300_000, cc: 30 })
  s.append(CALLS)
  const failed = []
  const face = await serveFace({ home, failure: (where, e) => failed.push(`${e.code}: ${e.message}`) })
  try {
    const get = async (name, q) => {
      const r = await request(face.port, `/api/${name}?${new URLSearchParams(q)}`, { headers: withToken() })
      return { status: r.status, doc: JSON.parse(r.body) } // a cut body is not JSON: it throws here
    }
    const list = await get('sessions', {})
    assert.equal(list.status, 200)
    const listed = list.doc.sessions.find((x) => x.session_id === s.id)
    assert.ok(listed, 'the session is listed')
    const reads = []
    for (let i = 0; i < 2; i++) { // cold, then warm: the same answer
      const a = await get('session', { id: s.id, limit: '60' })
      assert.equal(a.status, 200, `read ${i + 1}: ${JSON.stringify(a.doc).slice(0, 600)}`)
      const t = a.doc.truncated
      if (t) {
        assert.ok(t.shown < t.total, 'a cut session shows fewer calls than it has')
        assert.equal(t.total, listed.calls, 'and counts them all')
        assert.equal(rowsOf(a.doc), t.shown, 'the lanes count the calls shown')
      } else assert.equal(rowsOf(a.doc), listed.calls)
      reads.push({ total: rowsOf(a.doc), truncated: t })
    }
    assert.deepEqual(reads[1], reads[0], 'a warm read answers what the cold one did')
    assert.deepEqual(failed, [], 'no query worker died')
  } finally { face.close() }
})
