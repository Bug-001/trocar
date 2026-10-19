// wires-overview.test.mjs — the overview (1.7) reads the C.5 documents as they are: every stats number from `overview` alone
// (D24), the cost and hit marks from `usage` (D14 · invariant 4), the disk footer from `classes.disk.asight_bytes`, O9 from
// `traffic`, the recent list from `sessions`. The documents come from the real face (real server, real query worker).
import test from 'node:test'
import assert from 'node:assert/strict'
import { overviewItems, recentRows, diskBytes } from '../../src/web/v2/overview/overview.mjs'
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
