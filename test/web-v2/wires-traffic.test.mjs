// wires-traffic.test.mjs — the traffic screens (1.10) read the C.5 documents as they are: the table from `traffic`, the host
// list from `calls {harness, host}` paged by `next`, the request detail from `calls {ref}`. The documents come from the real
// face (real server, real query worker); unrecorded bytes stay null (invariant 4), and what C.5 has no field for is not drawn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tableModel, classWord } from '../../web/legacy/traffic/traffic.mjs'
import { listModel, appendPage, readPage, replayLinkOf, detailLeadHtml } from '../../web/legacy/traffic/host.mjs'
import { detailModel, requestDetailHtml } from '../../web/legacy/traffic/request-view.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const face = (async () => {
  const f = await serveBoard(boardHome({ bytes: 2e6 }))
  const traffic = await f.get('traffic', { limit: 500 })
  assert.equal(traffic.status, 200)
  assert.ok(traffic.doc.hosts.length > 1, 'the fixture has several hosts')
  const classes = await f.get('classes')
  assert.equal(classes.status, 200)
  return { f, T: traffic.doc, C: classes.doc }
})()
test.after(async () => { (await face).f.close() })
// the board's api.get over the real face
const apiOf = (f) => ({ get: async (n, p) => { const r = await f.get(n, Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v != null))); return { ok: r.status === 200, status: r.status, data: r.doc } } })
const busiest = (T) => T.hosts.reduce((a, b) => (b.requests > a.requests ? b : a))
const key = (r) => `${r.harness}\u0000${r.host}`

test('(1) one table row per `traffic.hosts` entry, keyed harness+host; totals.is_floor sets the floor flag', async () => {
  const { T } = await face
  const m = tableModel(T)
  assert.equal(m.flat.length, T.hosts.length)
  assert.deepEqual(new Set(m.flat.map(key)), new Set(T.hosts.map(key)))
  assert.equal(T.totals.is_floor, true)
  assert.equal(m.floor, true)
})

test('(2) a host whose received_bytes is null reads as not recorded (null), never 0', async () => {
  const { T } = await face
  const doc = structuredClone(T)
  const hit = doc.hosts[0]
  hit.received_bytes = null
  const row = tableModel(doc).flat.find((r) => key(r) === key(hit))
  assert.equal(row.recv.value, null)
  const other = tableModel(T).flat.find((r) => key(r) === key(hit))
  assert.equal(other.recv.value, T.hosts[0].received_bytes)
})

test('(3) the host list follows `next` until null and collects exactly the ids of one unpaged `calls`', async () => {
  const { f, T } = await face
  const h = busiest(T), api = apiOf(f)
  assert.ok(h.requests > 2, 'the busiest host spans several pages of 2')
  const q = { harness: h.harness, host: h.host, limit: 2 }
  let list = listModel((await readPage(api, q)).data), pages = 1
  while (list.next != null) { list = appendPage(list, (await readPage(api, { ...q, after: list.next })).data); pages++ }
  assert.ok(pages > 1)
  const all = await f.get('calls', { harness: h.harness, host: h.host, limit: 500 })
  assert.equal(all.doc.next, null)
  assert.deepEqual(list.rows.map((r) => r.id), all.doc.records.map((r) => r.id))
})

test('(4) a real `calls {ref}` record builds the request detail; its byte figures are the record\'s sent_bytes / received_bytes', async () => {
  const { f, T } = await face
  const h = busiest(T)
  const page = await f.get('calls', { harness: h.harness, host: h.host, limit: 500 })
  for (const row of page.doc.records) {
    const one = await f.get('calls', { ref: row.ref })
    assert.equal(one.status, 200)
    assert.equal(one.doc.total, 1)
    const d = detailModel(one.doc)
    assert.equal(d.sent, one.doc.records[0].sent_bytes)
    assert.equal(d.received, one.doc.records[0].received_bytes)
    assert.doesNotThrow(() => requestDetailHtml(d))
  }
})

test('(5) no real row carries 未分类 or a replay link (C.5 has neither field)', async () => {
  const { f, T, C } = await face
  for (const r of tableModel(T).flat) for (const id of Object.keys(r.classes || {})) assert.equal(classWord(id, r.harness, C.unmatched).unclassified, false)
  for (const h of T.hosts) {
    const page = await f.get('calls', { harness: h.harness, host: h.host, limit: 500 })
    for (const row of page.doc.records) {
      assert.equal(replayLinkOf(row), null)
      assert.equal(detailLeadHtml(row), null)
    }
  }
})
