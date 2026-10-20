// wires-overview.test.mjs — the overview (1.7) reads the C.5 documents as they are: every stats number from `overview` alone
// (D24), the cost and hit marks from `usage` (D14 · invariant 4), the disk footer from `classes.disk.asight_bytes`, O9 from
// `traffic`, the recent list from `sessions`. The documents come from the real face (real server, real query worker).
import test from 'node:test'
import assert from 'node:assert/strict'
import { overviewStats, overviewItems, recentRows, renderBody, diskBytes } from '../../src/web/v2/overview/overview.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const docs = (async () => {
  const face = await serveBoard(boardHome({ bytes: 2e6 }))
  try {
    const out = {}
    for (const n of ['overview', 'sessions', 'classes', 'pricing', 'traffic', 'status']) {
      const r = await face.get(n)
      assert.equal(r.status, 200, n)
      out[n] = r.doc
    }
    return out
  } finally { await face.close() }
})()
const copy = (x) => structuredClone(x)
const ok = (data) => ({ data, ok: true, err: null })
const stateOf = (D, now, over = {}) => ({
  w: 'all', readAt: now, caph: { data: D.status, okAt: now, err: null, ok: true },
  sessions: ok(D.sessions), classes: ok(D.classes), pricing: ok(D.pricing), stats: ok(D.overview), usageAll: ok(D.overview), traffic: ok(D.traffic), ...over,
})

test('(1) the stats are the overview document\'s numbers; a session the index has not caught up with changes the recent list, not the stats (D24)', async () => {
  const D = await docs, now = Date.now()
  const m = overviewStats(D.overview, D.pricing)
  assert.ok(D.overview.sessions.total > 0 && D.overview.calls.llm > 0, 'the fixture has sessions and calls')
  assert.equal(m.sessions, D.overview.sessions.total)
  assert.equal(m.calls, D.overview.calls.llm)
  const more = copy(D.sessions)
  more.sessions.push({ ...more.sessions[0], session_id: 'extra-session', last_ts: new Date(now).toISOString() })
  const a = renderBody(stateOf(D, now), now), b = renderBody(stateOf(D, now, { sessions: ok(more) }), now)
  assert.equal(b.stats, a.stats)
  assert.deepEqual(overviewStats(D.overview, D.pricing), m)
  assert.equal(recentRows(more)[0].id, 'extra-session')
})

test('(2) usage that did not cover the window marks the cost partial; a main row without a cache write marks the hit uncertain; unknown is never 0', async () => {
  const D = await docs
  const ov = copy(D.overview)
  const cov = ov.usage.coverage
  assert.equal(overviewStats(ov, D.pricing).partial, cov.sessions_read < cov.sessions_in_window)
  cov.sessions_read = cov.sessions_in_window - 1; cov.reason = 'byte-budget'
  const p = overviewStats(ov, D.pricing)
  assert.equal(p.partial, true)
  assert.notEqual(p.cost, 0)
  const main = ov.usage.rows.filter((r) => r.lane === 'main')
  assert.ok(main.length > 1, 'the fixture has main-lane rows')
  for (const r of main) { r.cache_write = 0; r.cache_known = true }
  assert.equal(overviewStats(ov, D.pricing).hitUncertain, false)
  main[0].cache_write = null
  assert.equal(overviewStats(ov, D.pricing).hitUncertain, true)
  const none = copy(D.overview)
  Object.assign(none.usage, { coverage: { ...none.usage.coverage, sessions_read: 0, capped_at: 1, reason: 'byte-budget' }, rows: [] })
  const z = overviewStats(none, D.pricing)
  assert.equal(z.partial, true); assert.equal(z.cost, null); assert.equal(z.hit, null)
})

test('(3) the disk footer is classes.disk.asight_bytes; a failed classes read draws no footer', async () => {
  const D = await docs
  assert.equal(typeof D.classes.disk.asight_bytes, 'number')
  assert.equal(diskBytes(ok(D.classes)), D.classes.disk.asight_bytes)
  assert.equal(diskBytes({ data: D.classes, ok: false, err: 'HTTP 500' }), null)
})

test('(4) O9: one item per host first seen in the last 24 h of a harness seen before that; none when the harness itself is new', async () => {
  const D = await docs, now = Date.now(), H = 3600e3
  const iso = (ago) => new Date(now - ago).toISOString()
  const harnesses = Object.keys(D.traffic.harness_since)
  assert.ok(harnesses.length > 1)
  for (const sinceAgo of [48 * H, 2 * H]) {
    const hosts = harnesses.flatMap((h, i) => [1 * H, 30 * H].map((fs, j) => ({
      harness: h, harness_inferred: false, host: `h${i}-${j}.example`, first_seen: iso(fs), last_seen: iso(0), requests: 1, sent_bytes: 1, received_bytes: 1, received_unrecorded: 0, classes: {},
    })))
    const traffic = { ...D.traffic, hosts, harness_since: Object.fromEntries(harnesses.map((h) => [h, iso(sinceAgo)])) }
    const want = sinceAgo > 24 * H ? hosts.filter((r) => now - Date.parse(r.first_seen) < 24 * H) : []
    const items = overviewItems(stateOf(D, now, { traffic: ok(traffic) }), now)
    const o9 = items.rows.filter((r) => r.cls === 'O9').length + (items.more.O9 || 0)
    assert.equal(o9, want.length, `harness_since ${sinceAgo / H} h ago`)
  }
})

test('(5) the recent sessions are the five newest of the sessions document by last_ts', async () => {
  const D = await docs
  assert.ok(D.sessions.sessions.length > 5)
  const want = [...D.sessions.sessions].sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts)).slice(0, 5).map((s) => s.session_id)
  assert.deepEqual(recentRows(D.sessions).map((r) => r.id), want)
})
