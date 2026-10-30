// test/query/real-session.test.mjs — LOCAL ONLY: the largest session of a real trocar home, built from nothing by the real worker
// under its real heap in its background slices, answers its first paint whole (RFC 3.5 §后台抽取与归约 · §内存有界 · 验收; 4.3 验收
// 8; D38). Generated sessions miss what real captures carry (2026-10-21: the worker died on the user's own session while every
// generated one passed), so this runs before every `trocar update` on the machine that runs trocar:
// `TROCAR_REAL_HOME=<a trocar home> npm run test:real`. No timing is asserted: the numbers are measured and logged.
//
// The home is only read: the worker runs over a side home in a temp dir whose raw/ is a link to the real one and whose index/ is a
// copy of its segment index without the context projections (index/ctx), so the session is extracted and folded from scratch and
// whatever that writes lands in the temp dir. Without TROCAR_REAL_HOME it is skipped and says why.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { serveFace, request, withToken } from '../server/face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'

const REAL = process.env.TROCAR_REAL_HOME
const skip = REAL ? (fs.existsSync(path.join(REAL, 'raw')) ? false : `TROCAR_REAL_HOME has no raw/: ${REAL}`)
  : 'TROCAR_REAL_HOME is not set (a trocar home to read; run it with `TROCAR_REAL_HOME=<home> npm run test:real`)'
// The board's cadence for an open session's tail (4.4 §看板 v2 读什么), and a bound on the whole first build: a first build that never
// clears its pending is a failure, not a wait.
const POLL_MS = 1500, BUILD_MS = 20 * 60_000

test('the largest real session, built from scratch by the real worker, answers its session page and main lane page whole', { skip, timeout: BUILD_MS + 120_000 }, async () => {
  const home = path.join(tmpDir('trocar-real-'), '.trocar')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.symlinkSync(path.join(path.resolve(REAL), 'raw'), path.join(home, 'raw'))
  const index = path.join(REAL, 'index')
  if (fs.existsSync(index)) fs.cpSync(index, path.join(home, 'index'), { recursive: true, filter: (p) => path.relative(index, p).split(path.sep)[0] !== 'ctx' })
  const groups = sessionGroups(await indexRows({ home }))
  let id = null, most = -1
  for (const [k, rows] of groups) { const b = rows.reduce((n, r) => n + (r.stored_bytes || 0), 0); if (b > most) { most = b; id = k } }
  assert.ok(id, 'the home has a session')
  const failed = []
  const face = await serveFace({ home, failure: (where, e) => failed.push({ where, code: e.code }) })
  try {
    const get = async (q) => {
      const r = await request(face.port, `/api/${q}`, { headers: withToken() })
      assert.equal(r.status, 200, `${q}: ${r.body.slice(0, 300)}`)
      return JSON.parse(r.body) // a cut body is not JSON: it throws here
    }
    const ask = () => get(`session?${new URLSearchParams({ id })}`)
    let doc = await ask()
    for (const t0 = Date.now(); doc.pending; doc = await ask()) {
      assert.ok(Date.now() - t0 < BUILD_MS, `pending ${JSON.stringify(doc.pending)} after ${BUILD_MS / 60_000} min`)
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    assert.equal(doc.truncated, null, 'the session is not cut')
    assert.equal(typeof doc.mark, 'string')
    assert.ok(doc.calls.length >= 1, 'the newest page has a call')
    const main = doc.lanes.find((l) => l.kind === 'main')
    assert.ok(main, 'the session has a main lane')
    const lane = await get(`lane?${new URLSearchParams({ id, lane: main.lane })}`)
    assert.equal(lane.base, null)
    assert.ok(lane.steps.length >= 1, 'the tail page has a step')
  } finally { face.close() }
  assert.deepEqual(failed, [], 'no query failed and no worker died')
})
