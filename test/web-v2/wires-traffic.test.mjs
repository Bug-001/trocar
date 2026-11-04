// wires-traffic.test.mjs — the traffic screens (1.10) read the C.5 documents as they are: the table from `traffic`, the host
// list from `calls {harness, host}` paged by `next`, the request detail from `calls {ref}`. The documents come from the real
// face (real server, real query worker); unrecorded bytes stay null (invariant 4), and the views draw only what C.5 has a field for.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tableModel } from '../../web/src/screens/traffic/model.mjs'
import { mergePages, callsParams } from '../../web/src/screens/traffic/host-model.mjs'
import { detailModel, requestView } from '../../web/src/screens/traffic/request-model.mjs'
import { bytes } from '../../web/legacy/core/fmt.mjs'
import * as W from '../../web/legacy/labels/traffic.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const face = (async () => {
  const f = await serveBoard(boardHome({ bytes: 2e6 }))
  const traffic = await f.get('traffic', { limit: 500 })
  assert.equal(traffic.status, 200)
  assert.ok(traffic.doc.hosts.length > 1, 'the fixture has several hosts')
  return { f, T: traffic.doc }
})()
test.after(async () => { (await face).f.close() })
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

test('(2) a host whose received_bytes is null reads as not recorded, never 0', async () => {
  const { T } = await face
  const doc = structuredClone(T)
  const hit = doc.hosts[0]
  hit.received_bytes = null
  const row = tableModel(doc).flat.find((r) => key(r) === key(hit))
  assert.equal(row.recv.main, W.UNRECORDED)
  const other = tableModel(T).flat.find((r) => key(r) === key(hit))
  assert.ok(other.recv.main.includes(bytes(T.hosts[0].received_bytes)))
})

test('(3) the host list follows `next` until null and collects exactly the ids of one unpaged `calls`', async () => {
  const { f, T } = await face
  const h = busiest(T)
  assert.ok(h.requests > 2, 'the busiest host spans several pages of 2')
  const q = { harness: h.harness, host: h.host, limit: 2 }
  const pages = [(await f.get('calls', callsParams(q))).doc]
  let list = mergePages(pages)
  while (list.next != null) { pages.push((await f.get('calls', callsParams({ ...q, after: list.next }))).doc); list = mergePages(pages) }
  assert.ok(pages.length > 1)
  const all = await f.get('calls', { harness: h.harness, host: h.host, limit: 500 })
  assert.equal(all.doc.next, null)
  assert.deepEqual(list.rows.map((r) => r.id), all.doc.records.map((r) => r.id))
  // #12 the caption's count and as-of are the last page's fields, not the rows drawn so far
  assert.equal(typeof all.doc.total, 'number')
  assert.equal(list.total, pages.at(-1).total)
  assert.equal(list.total, all.doc.total)
  assert.equal(list.asOf, pages.at(-1).as_of)
  // a page read twice (the first page re-read) draws its refs once
  assert.deepEqual(mergePages([...pages, pages[0]]).rows.map((r) => r.id), all.doc.records.map((r) => r.id))
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
    assert.doesNotThrow(() => requestView(d))
  }
})
