// test/query/traffic.test.mjs — `asight query traffic` (RFC 1.6 §4.1 · 附录 C.5 `traffic`; 3.5 §访问模式; 1.10).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment } from './raw-home.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z'
const at = (i) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + i * 1000).toISOString()

// the index the daemon keeps (4.2 §段索引), so the reader has it on disk
const homeWith = async (lines) => {
  const home = rawHome()
  writeSegment(home, SEG, lines)
  await segmentIndex({ home, segment: SEG, owner: true })
  return home
}
const all = async (home, p = {}) => {
  const out = []
  for (let after; ;) {
    const doc = await runQuery('traffic', { ...p, ...(after ? { after } : {}) }, { home })
    out.push(...doc.hosts)
    if (!doc.next) return out
    after = doc.next
  }
}

test('3.5 §访问模式: traffic opens no record body (stat is allowed)', async () => {
  const home = await homeWith(Array.from({ length: 6 }, (_, i) => ({ ts: at(i), host: i % 2 ? 'a.example' : 'b.example' })))
  let opened = 0
  const body = (p) => typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)
    ? /[\\/]raw[\\/][^\\/]+\.(ndjson|sealed)$/.test(String(p)) : false
  const count = (fn) => function (p, ...a) { if (body(p)) opened++; return fn.call(this, p, ...a) }
  const f = { ...fs, openSync: count(fs.openSync), readFileSync: count(fs.readFileSync), createReadStream: count(fs.createReadStream),
    open: count(fs.open), readFile: count(fs.readFile),
    promises: { ...fs.promises, open: count(fs.promises.open), readFile: count(fs.promises.readFile) } }
  const doc = await runQuery('traffic', {}, { home, fs: f })
  assert.deepEqual(doc.errors, [])
  assert.equal(doc.hosts.reduce((s, h) => s + h.requests, 0), 6)
  assert.equal(opened, 0)
})

test('C.5: first_seen and harness_since come from the whole index, not the window', async () => {
  const home = await homeWith([0, 1, 2].map((i) => ({ ts: at(i), host: 'a.example' })))
  const doc = await runQuery('traffic', { since: at(1) }, { home })
  assert.equal(doc.hosts.length, 1)
  const [h] = doc.hosts
  assert.equal(h.requests, 2)
  assert.equal(h.first_seen, at(0))
  assert.equal(h.last_seen, at(2))
  assert.equal(doc.harness_since[h.harness], at(0))
})

test('C.5: received_bytes is the sum of what was recorded, null when nothing was — never 0', async () => {
  const home = await homeWith([
    { ts: at(0), host: 'a.example', wireResp: null }, { ts: at(1), host: 'a.example', wireResp: 20 },
    { ts: at(2), host: 'b.example', noWire: true }, { ts: at(3), host: 'b.example', wireResp: null },
  ])
  const by = Object.fromEntries((await runQuery('traffic', {}, { home })).hosts.map((h) => [h.host, h]))
  assert.deepEqual([by['a.example'].received_bytes, by['a.example'].received_unrecorded], [20, 1])
  assert.deepEqual([by['b.example'].received_bytes, by['b.example'].received_unrecorded], [null, 2])
  assert.equal(by['b.example'].sent_bytes, 10) // one row recorded what it sent
})

test('C.5: totals are a floor and count every row in the window', async () => {
  const home = await homeWith([0, 1, 2, 3].map((i) => ({ ts: at(i), host: `h${i % 3}.example`, wireResp: i ? 20 : null })))
  const doc = await runQuery('traffic', {}, { home })
  assert.equal(doc.totals.is_floor, true)
  assert.equal(doc.totals.requests, doc.hosts.reduce((s, h) => s + h.requests, 0))
  assert.equal(doc.totals.received_bytes, doc.hosts.reduce((s, h) => s + (h.received_bytes ?? 0), 0))
  const paged = await runQuery('traffic', { limit: '1' }, { home })
  assert.deepEqual(paged.totals, doc.totals) // the page does not shrink the totals
})

test('3.5 Edge cases: an empty home is an empty list, not an error', async () => {
  const doc = await runQuery('traffic', {}, { home: rawHome() })
  assert.deepEqual([doc.hosts, doc.next, doc.has_more, doc.as_of, doc.errors], [[], null, false, null, []])
})

test('1.6 §4.1 paging: following next with --limit 1 gives every group once, as the unpaged list', async () => {
  const home = await homeWith([0, 1, 2, 3, 4].map((i) => ({ ts: at(i), host: `h${i % 3}.example` })))
  const whole = (await runQuery('traffic', { limit: '500' }, { home })).hosts
  const paged = await all(home, { limit: '1' })
  assert.equal(whole.length, 3)
  assert.equal(new Set(paged.map((h) => h.host)).size, 3)
  assert.deepEqual(paged, whole)
})
