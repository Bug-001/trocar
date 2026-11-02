// traffic-model.test.mjs — 流量 (1.10 §流量表) MUSTs on the framework-free table model TrafficScreen.tsx renders. The documents come
// from the real face (real server, real query worker on a temp HOME); a shape the generated store does not hold is constructed from
// a real answer. Data fields only: expected values come from the documents, the labels and fmt.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableModel, recvParts, queryOf, sinceOf, isNewHost, coverOf, failOf } from '../../web/src/screens/traffic/model.mjs'
import { harnessKey, ALIASES } from '../../web/legacy/core/chips.mjs'
import { CLASS_IDS } from '../../web/legacy/core/classes.mjs'
import { parseHash } from '../../web/legacy/core/router.mjs'
import { bytes } from '../../web/legacy/core/fmt.mjs'
import { READ_FAIL } from '../../web/legacy/labels/common.mjs'
import * as W from '../../web/legacy/labels/traffic.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const world = (async () => {
  const face = await serveBoard(boardHome({ bytes: 2e6 }))
  const T = (await face.get('traffic', { limit: 500 })).doc
  assert.ok(T.hosts.length > 3 && new Set(T.hosts.map((h) => h.harness)).size > 2, 'several agents, several hosts')
  return { face, T }
})()
test.after(async () => { await (await world).face.close() })

const H = 3600e3
const keyOf = (r) => `${harnessKey(r.harness) || 'unknown'}|${r.host ?? ''}`

test('#1 table rows are the `traffic` hosts, grouped by agent, the agent only on a group\'s first row; unfiltered, the total is `totals`', async () => {
  const { T } = await world
  const m = tableModel(T, { now: Date.parse(T.as_of) })
  assert.equal(m.state, 'table')
  assert.deepEqual(m.flat.map((r) => r.key).sort(), T.hosts.map(keyOf).sort())
  m.flat.forEach((r, i) => assert.equal(r.first, i === 0 || m.flat[i - 1].hkey !== r.hkey, `row ${i}`))
  const runs = m.flat.filter((r) => r.first).map((r) => r.hkey)
  assert.equal(runs.length, new Set(runs).size, 'one run per agent')
  assert.deepEqual(m.groups.map((g) => g.rows[0]), m.flat.filter((r) => r.first))
  assert.equal(m.total.requests, T.totals.requests)
  assert.ok(m.total.sent.main.includes(bytes(T.totals.sent_bytes)))
  assert.ok(m.total.recv.main.includes(bytes(T.totals.received_bytes)))
  assert.equal(m.total.filtered, false)
})

test('#2 收回: unrecorded is never 0; a partial sum is a floor with its count; all unrecorded is no value', async () => {
  const { T } = await world
  const base = T.hosts.find((h) => h.requests >= 3 && h.received_bytes > 0)
  for (const [un, recv] of [[0, base.received_bytes], [1, base.received_bytes], [base.requests - 1, base.received_bytes], [base.requests, base.received_bytes], [base.requests + 2, base.received_bytes], [0, null], [1, null]]) {
    const row = { ...base, received_unrecorded: un, received_bytes: recv }
    const p = recvParts(row)
    const drawn = tableModel({ ...T, hosts: [row] }).flat[0].recv
    if (recv == null || un >= row.requests) { assert.equal(p.value, null, `${un}/${recv}`); assert.equal(p.main, W.UNRECORDED) }
    else if (un === 0) { assert.equal(p.value, recv); assert.equal(p.main, bytes(recv)) }
    else { assert.equal(p.value, recv); assert.equal(p.un, un); assert.ok(p.main.startsWith('≥')); assert.ok(drawn.note.includes(String(un))) }
    assert.notEqual(drawn.main, bytes(0), 'never a 0')
  }
})

test('#4 新 follows the first-contact rule whatever the window; a fresh store has none', async () => {
  const { T } = await world
  const N = Date.parse(T.as_of), base = T.hosts[0]
  const iso = (t) => new Date(N + t).toISOString()
  for (const first of [-1 * H, -23 * H, -25 * H, -240 * H, 2 * H]) for (const since of [-2 * H, -23 * H, -25 * H, -720 * H, null]) for (const window of ['1h', '24h', '7d', 'all']) {
    const row = { ...base, first_seen: iso(first) }
    const hs = since == null ? {} : { [base.harness]: iso(since) }
    const want = first > -24 * H && first <= 0 && since != null && since < -24 * H
    assert.equal(isNewHost(row, hs, N), want, `first ${first / H}h since ${since && since / H}h`)
    assert.equal(tableModel({ ...T, hosts: [row], harness_since: hs }, { now: N, window }).flat[0].isNew, want, `${window}`)
  }
  const fresh = { ...T, harness_since: Object.fromEntries(Object.keys(T.harness_since).map((k) => [k, iso(-H)])) }
  assert.equal(tableModel(fresh, { now: N }).flat.filter((r) => r.isNew).length, 0)
})

test('#5 window and filters: the route maps to the query window and the rows kept', async () => {
  const { T } = await world
  for (const [win, since] of [['1h', '1h'], ['24h', '24h'], ['7d', '7d'], ['all', undefined], ['junk', '24h'], [undefined, '24h']]) {
    const q = queryOf(win === undefined ? {} : { window: win })
    assert.equal(sinceOf(q.window), since, String(win))
  }
  const h = T.hosts[0].harness
  for (const id of [h, Object.keys(ALIASES).find((k) => ALIASES[k] === h)].filter(Boolean)) {
    const q = queryOf({ h: id })
    assert.deepEqual(tableModel(T, q).flat.map((r) => r.harness).sort(), T.hosts.filter((r) => harnessKey(r.harness) === harnessKey(id)).map((r) => r.harness).sort())
  }
  for (const cls of CLASS_IDS) {
    const m = tableModel(T, queryOf({ class: cls }))
    const want = T.hosts.filter((r) => (r.classes || {})[cls] > 0)
    assert.deepEqual(m.flat.map((r) => r.key).sort(), want.map(keyOf).sort(), cls)
    assert.equal(m.total.filtered, true)
    assert.equal(m.total.requests, want.reduce((a, r) => a + r.requests, 0))
  }
})

test('#7 coverage: the agents a fresh `sessions` answer has that the rows lack (through harnessKey); none from a stored or failed answer', async () => {
  const { T } = await world
  const drop = T.hosts[T.hosts.length - 1].harness
  const keep = T.hosts.find((r) => r.harness !== drop).harness
  const alias = Object.keys(ALIASES).find((k) => ALIASES[k] === keep) || keep
  const hosts = T.hosts.filter((r) => r.harness !== drop)
  const sessions = [{ harness: alias }, { harness: drop }, { harness: null }]
  assert.deepEqual(coverOf(hosts, { ok: true, data: { sessions } }), [harnessKey(drop)])
  assert.deepEqual(coverOf(hosts, { ok: true, data: { sessions, stored: { at: T.as_of } } }), [])
  assert.deepEqual(coverOf(hosts, { ok: false, status: 500, error: 'down' }), [])
  assert.deepEqual(coverOf(T.hosts, { ok: true, data: { sessions } }), [])
})

test('#8 agent inference: the source note while rows carry no harness_inferred, a per-row flag once they do', async () => {
  const { T } = await world
  const bare = tableModel({ ...T, hosts: T.hosts.map(({ harness_inferred, ...r }) => r) })
  assert.equal(bare.sourceNote, true)
  assert.equal(bare.flat.filter((r) => r.inferred).length, 0)
  const mixed = { ...T, hosts: T.hosts.map((r, i) => ({ ...r, harness_inferred: i % 2 === 0 })) }
  const m = tableModel(mixed)
  assert.equal(m.sourceNote, false)
  const byKey = new Map(mixed.hosts.map((r) => [keyOf(r), r.harness_inferred]))
  for (const r of m.flat) assert.equal(r.inferred, byKey.get(r.key), r.key)
  assert.equal(tableModel({ ...T, hosts: [] }).sourceNote, false)
})

test('#9 a row opens its host page; agent and host round-trip through the route; no host is no link', async () => {
  const { T } = await world
  const base = T.hosts[0]
  for (const harness of [base.harness, 'claude-code', null, 'some-new-agent']) for (const host of ['api.example.test', 'a b/c?d#e%f&g=h', 'xn--bcher-kva.example:8443', '[::1]:443']) for (const cls of [null, 'telemetry']) {
    const m = tableModel({ ...T, hosts: [{ ...base, harness, host }] }, { window: '7d', cls })
    const r = parseHash(m.flat[0].href)
    assert.equal(r.screen, 'traffic-host')
    assert.equal(r.harness, harnessKey(harness) || 'unknown')
    assert.equal(r.host, host)
    assert.deepEqual(r.params, cls ? { window: '7d', class: cls } : { window: '7d' })
  }
  for (const host of [null, '']) assert.equal(tableModel({ ...T, hosts: [{ ...base, host }] }).flat[0].href, null, `host ${JSON.stringify(host)}`)
})

test('#10 traffic sources carry no endpoint path literal', async () => {
  const { face, T } = await world
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []))
  const files = [...walk(fileURLToPath(new URL('../../web/src/screens/traffic/', import.meta.url))), fileURLToPath(new URL('../../web/legacy/labels/traffic.mjs', import.meta.url))]
  const endpoints = new Set()
  for (const h of T.hosts.filter((r) => r.host)) for (const r of (await face.get('calls', { harness: h.harness, host: h.host, limit: 500 })).doc.records) if (/^\/[^/?]+\/[^?]/.test(r.endpoint || '')) endpoints.add(r.endpoint.split('?')[0])
  assert.ok(endpoints.size > 3)
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const e of endpoints) assert.ok(!text.includes(e), `${f} names ${e}`)
    assert.deepEqual(text.match(/(['"`])\/[A-Za-z][\w.-]*\/[^'"`\s]*\1/g) || [], [], f)
  }
})

test('K-29 a failed read: the line is the board\'s words for the status, the reason only in the technical pairs', () => {
  const reasons = ['line one\nline two', '<b>boom</b> & "x"', 'x'.repeat(4000), 'ECONNREFUSED 127.0.0.1:7777']
  for (const why of reasons) for (const status of [0, 404, 500, undefined]) {
    const f = failOf(W.TRAFFIC, status === undefined ? { error: why } : { status, error: why })
    assert.equal(f.line, READ_FAIL(W.TRAFFIC, status === undefined ? null : status))
    assert.ok(!f.line.includes(why), `${status}`)
    assert.ok(f.pairs.some(([, v]) => v.text === why))
    if (status !== undefined) assert.ok(f.pairs.some(([, v]) => v.text === String(status)))
    assert.ok(f.copy.includes(why))
  }
  for (const status of [0, 500]) assert.ok(failOf(W.TRAFFIC, { status, error: '' }).pairs.every(([, v]) => v.text !== ''), 'an empty reason still has a cell')
})

test('main classes: rows with no recorded class read as the unrecorded word with their count, never "null"', async () => {
  const { T } = await world
  const row = { ...T.hosts[0], classes: { telemetry: 2 }, class_unrecorded: 5 }
  const c = tableModel({ ...T, hosts: [row] }).flat[0].classes
  assert.deepEqual(c.shown, [{ word: W.classWord(null), n: 5 }, { word: W.classWord('telemetry'), n: 2 }])
  assert.ok(!/\bnull\b/.test(JSON.stringify(c)))
})
