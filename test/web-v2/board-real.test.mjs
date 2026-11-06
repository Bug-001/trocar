// test/web-v2/board-real.test.mjs — LOCAL ONLY: the board's rules over real captured sessions (the T1 gate the board's spec units name).
// `TROCAR_BOARD_REAL=<a trocar home>`; without it every case is skipped and says why, so a fresh clone stays green. The home is only read
// (test/helpers/real-home.mjs). Only shapes and counts are asserted; no real content reaches an assertion message.
//   2.2 #18: on the main lane of 8 real sessions, every cache break is one of rows 4–7; failed and no-usage steps are never breaks; a step
//   whose cause is not quiet is row 6 below LOW_HIT and row 6′ (not a break) at or above it — usage wins (3.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { serveFace, request, withToken } from '../server/face.mjs'
import { sideHome } from '../helpers/real-home.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { cacheState, isBreak, refOf, hitRatio, usageOf, QUIET_CAUSES, LOW_HIT } from '../../web/legacy/core/metrics.mjs'

const REAL = process.env.TROCAR_BOARD_REAL
const skip = REAL ? (fs.existsSync(path.join(REAL, 'raw')) ? false : `TROCAR_BOARD_REAL has no raw/: ${REAL}`)
  : 'TROCAR_BOARD_REAL is not set (a trocar home to read)'
const SESSIONS = 8, POLL_MS = 1500, BUILD_MS = 10 * 60_000
// the sessions read: the most calls first, among those small enough to build within BUILD_MS (one bound for a local run)
const MAX_BYTES = 64 * 2 ** 20
const BREAK_ROWS = new Set(['ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit'])

test('2.2 #18 · T1: real main-lane breaks are rows 4–7 only; failed and no-usage are never breaks; a changed prefix is row 6 below LOW_HIT, 6′ at or above it', { skip, timeout: SESSIONS * BUILD_MS }, async () => {
  const home = sideHome(REAL)
  const groups = [...sessionGroups(await indexRows({ home }))]
    .map(([id, rows]) => ({ id, n: rows.length, bytes: rows.reduce((s, r) => s + (r.stored_bytes || 0), 0) }))
    .filter((g) => g.bytes <= MAX_BYTES).sort((a, b) => b.n - a.n).slice(0, SESSIONS)
  assert.equal(groups.length, SESSIONS, `the home has ${SESSIONS} sessions of at most ${MAX_BYTES} bytes`)
  const failed = []
  const face = await serveFace({ home, failure: (where, e) => failed.push({ where, code: e.code }) })
  const seen = { steps: 0, breaks: 0, changed: 0, changedHit: 0, failed: 0, noUsage: 0 }
  try {
    const get = async (q) => {
      const r = await request(face.port, `/api/${q}`, { headers: withToken() })
      assert.equal(r.status, 200, `${q.split('?')[0]}: status ${r.status}`)
      return JSON.parse(r.body)
    }
    for (const [k, g] of groups.entries()) {
      const ask = () => get(`session?${new URLSearchParams({ id: g.id })}`)
      let doc = await ask()
      for (const t0 = Date.now(); doc.pending; doc = await ask()) {
        assert.ok(Date.now() - t0 < BUILD_MS, `session ${k + 1}: still pending after ${BUILD_MS / 60_000} min`)
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
      const main = doc.lanes.find((l) => l.kind === 'main')
      if (!main) continue
      // the whole session: the newest page, then each earlier page (3.5 §会话读 `before`) in front of it
      let rows = doc.calls
      for (let more = doc.more; more && rows.length;) {
        const page = await get(`session?${new URLSearchParams({ id: g.id, before: rows[0].rid })}`)
        rows = [...page.calls, ...rows]; more = page.more && page.calls.length > 0
      }
      const calls = rows.filter((c) => c.lane === main.lane)
      calls.forEach((c, i) => {
        const st = cacheState(c, refOf(calls, i)), where = `session ${k + 1} main step ${i + 1}`
        seen.steps++
        if (isBreak(c, refOf(calls, i))) { seen.breaks++; assert.ok(BREAK_ROWS.has(st.state), `${where}: a break in state ${st.state}`) }
        if (st.state === 'failed') { seen.failed++; assert.equal(st.isBreak, false, `${where}: failed`) }
        if (st.state === 'no-usage') { seen.noUsage++; assert.equal(st.isBreak, false, `${where}: no usage`) }
        const cause = c.cacheBreak && c.cacheBreak.cause, u = usageOf(c), hit = u ? hitRatio(u) : null
        if (!['failed', 'no-usage', 'first', 'ttl-rebuild', 'provider-contradiction', 'unjudged'].includes(st.state) && cause && !QUIET_CAUSES.has(cause)) {
          assert.equal(st.state, hit < LOW_HIT ? 'changed' : 'changed-hit', `${where}: hit ${hit}`)
          if (st.state === 'changed') seen.changed++; else { seen.changedHit++; assert.equal(st.isBreak, false, `${where}: 6′ is no break`) }
        }
      })
    }
  } finally { face.close() }
  console.log(`# T1 2.2 #18 over ${groups.length} sessions: ${JSON.stringify(seen)}`)
  assert.ok(seen.steps > 0, 'the sessions have main-lane steps')
  assert.ok(seen.changedHit > 0, 'no step of row 6′ in these sessions: the case would guard nothing')
  assert.deepEqual(failed, [], 'no query failed and no worker died')
})
