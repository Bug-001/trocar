// host-model.test.mjs — the host page (1.10 §host 页) and the request detail (2.6 §C) MUSTs on the framework-free models
// HostScreen.tsx and RequestView.tsx render. The documents come from the real face (real server, real query worker on a temp
// HOME) over a store that also holds one seeded record with live credential values; a shape the generated store does not hold
// is built from a real record. Data fields only: expected values come from the documents and the labels.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { callsParams, mergePages, hostRowView, crumbsOf, emptyText } from '../../web/src/screens/traffic/host-model.mjs'
import { detailModel, requestView } from '../../web/src/screens/traffic/request-model.mjs'
import { harnessKey } from '../../web/legacy/core/chips.mjs'
import { CLASS_IDS } from '../../web/legacy/core/classes.mjs'
import { parseHash } from '../../web/legacy/core/router.mjs'
import { bytes } from '../../web/legacy/core/fmt.mjs'
import * as W from '../../web/legacy/labels/traffic.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { writeSegment } from '../query/raw-home.mjs'

const SECRET = 'sk-test-0123456789abcdef', OTHER = 'sk-other-fedcba9876543210'
// the generated store holds no live credential value: one seed record (a copy of a generated request, its own id) carries two
const seeded = () => {
  const h = boardHome({ bytes: 2e6 })
  const raw = path.join(h.home, 'raw')
  const line = fs.readdirSync(raw).sort().flatMap((f) => fs.readFileSync(path.join(raw, f), 'utf8').split('\n')).find((l) => l.includes('"dst"'))
  const rec = JSON.parse(line)
  rec.id = 'ds_seed_credentials'
  rec.req_headers = { ...rec.req_headers, authorization: `Bearer ${SECRET}`, 'x-api-key': OTHER }
  writeSegment(h.home, '20260719T235959Z', [JSON.stringify(rec)])
  return h
}
const world = (async () => {
  const f = await serveBoard(seeded())
  const T = (await f.get('traffic', { limit: 500 })).doc
  const hosts = T.hosts.filter((r) => r.host)
  const recs = []
  for (const h of hosts) for (const r of (await f.get('calls', { harness: h.harness, host: h.host, limit: 500 })).doc.records) {
    recs.push({ h, row: r, doc: (await f.get('calls', { ref: r.ref })).doc })
  }
  return { f, T, hosts, recs }
})()
test.after(async () => { (await world).f.close() })

test('#14 retention marks: log links to its storage cell, legacy-meta carries the length-only tip, full has none', async () => {
  const { recs } = await world
  for (const { h, row } of recs.slice(0, 3)) for (const cls of [row.class, ...CLASS_IDS]) {
    const opts = { harness: h.harness, host: h.host, window: '24h', now: Date.now() }
    const log = hostRowView({ ...row, class: cls, retention: 'log' }, opts).retention
    assert.equal(log.kind, 'log')
    const r = parseHash(log.href)
    assert.equal(r.screen, 'settings-storage')
    assert.deepEqual(r.params, { h: harnessKey(h.harness), class: cls })
    const legacy = hostRowView({ ...row, class: cls, retention: 'legacy-meta' }, opts).retention
    assert.equal(legacy.kind, 'legacy-meta')
    assert.equal(legacy.tip, W.RETENTION_MARK['legacy-meta'].tip)
    assert.equal(hostRowView({ ...row, class: cls, retention: 'full' }, opts).retention, null)
  }
})

test('#15 received bytes not recorded read as not recorded, never 0; the failed mark follows error', async () => {
  const { recs } = await world
  const { h, row } = recs[0]
  for (const recv of [null, 0, 120]) for (const error of [true, false, null]) {
    const v = hostRowView({ ...row, received_bytes: recv, error }, { harness: h.harness, host: h.host, window: '24h' })
    assert.equal(v.recv, recv == null ? W.UNRECORDED : bytes(recv))
    assert.equal(v.failed, !!error)
  }
})

test('#16 the class filter drives `calls {host}` class=; an empty answer names that class', async () => {
  const { f, hosts } = await world
  const h = hosts[0]
  for (const cls of CLASS_IDS) {
    const p = callsParams({ harness: h.harness, host: h.host, cls, window: 'all', after: null, limit: 500 })
    assert.equal(p.class, cls)
    for (const v of Object.values(p)) assert.ok(v != null)
    const doc = (await f.get('calls', p)).doc
    assert.equal(doc.class, cls)
    const m = mergePages([doc])
    assert.equal(m.state, 'table')
    assert.deepEqual(m.rows.map((r) => r.class), doc.records.map(() => cls))
    assert.ok(emptyText(cls).includes(W.classWord(cls)), cls)
  }
})

test('#18 the breadcrumb: Traffic and the agent link back with window and class kept; the host has no link', async () => {
  const { hosts } = await world
  for (const h of hosts.slice(0, 3)) for (const cls of [null, ...CLASS_IDS]) for (const window of W.WINDOW_LABEL.map((o) => o.value)) {
    const c = crumbsOf({ harness: h.harness, host: h.host, window, cls })
    assert.equal(c.length, 3)
    const kept = cls ? { window, class: cls } : { window }
    const a = parseHash(c[0].href), b = parseHash(c[1].href)
    assert.deepEqual([a.screen, a.params], ['traffic', kept])
    assert.deepEqual([b.screen, b.params], ['traffic', { ...kept, h: harnessKey(h.harness) }])
    assert.equal(c[2].href, undefined)
    assert.equal(c[2].label, h.host)
  }
})

test('#21a a text, SSE or WebSocket body is the record\'s text, in its own side', async () => {
  const { recs } = await world
  let seen = 0
  for (const { doc } of recs) {
    const rec = doc.records[0], v = requestView(detailModel(doc))
    for (const s of ['req', 'resp']) {
      const b = rec.ctl[s]
      if (!b || !['text', 'sse', 'ws'].includes(b.kind)) continue
      seen++
      assert.equal(v[s].body.text, b.text || '', `${rec.ref} ${s}`)
    }
  }
  assert.ok(seen > 0, 'the generated store holds text bodies')
})

test('#21b each side carries its own fidelity mark, never one over both', async () => {
  const { recs } = await world
  const doc = structuredClone(recs[0].doc), rec = doc.records[0]
  const texts = (v, s) => v[s].body.marks.map((m) => m.text)
  rec.ctl = { ...rec.ctl, retention: 'full', labels: [{ id: 'resp-json-reserialized', label: 'x' }], req: { kind: 'length-only', bytes: 812 }, resp: { kind: 'json', chars: 2 } }
  const v = requestView(detailModel(doc))
  assert.ok(texts(v, 'req').includes(W.REQ_LEGACY) && !texts(v, 'req').includes(W.RESP_RESERIALIZED))
  assert.ok(texts(v, 'resp').includes(W.RESP_RESERIALIZED) && !texts(v, 'resp').includes(W.REQ_LEGACY))
  for (const k of ['truncated', 'partial']) {
    rec.ctl = { ...rec.ctl, labels: [], req: { kind: 'text', text: 'abc', bytes: 9, [k]: true }, resp: { kind: 'text', text: 'ok', bytes: 2 } }
    const v2 = requestView(detailModel(doc))
    assert.ok(v2.req.body.marks.length > 0, k)
    assert.deepEqual(v2.resp.body.marks, [], k)
  }
})

// every case spelling of each credential-class name the shared rule names (core/sensitive.mjs)
const spellings = (n) => [...new Set([n, n.toUpperCase(), n.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase()), n.replace(/[a-z]/, (c) => c.toUpperCase())])]
test('#21c credential headers are masked until 「Show」 names exactly one; old placeholders read as old; copies never carry a masked value', async () => {
  const { f, recs } = await world
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'anthropic-api-key'].flatMap(spellings)) {
    const doc = structuredClone(recs[0].doc)
    doc.records[0].req_headers = { ...doc.records[0].req_headers, [name]: SECRET, 'x-old': W.OLD_REDACTED }
    const m = detailModel(doc)
    const v = requestView(m)
    const row = v.req.headers.rows.find((r) => r.name === name)
    assert.equal(row.state, 'masked', name)
    assert.equal(v.req.headers.masked, true)
    assert.equal(v.req.headers.rows.find((r) => r.name === 'x-old').state, 'old')
    assert.ok(!JSON.stringify(v).includes(SECRET), name)
    assert.ok(!JSON.stringify(requestView(m, { revealed: 'cookie-jar' })).includes(SECRET), name)
    const open = requestView(m, { revealed: name.toLowerCase() })
    assert.equal(open.req.headers.rows.find((r) => r.name === name).state, 'open', name)
    assert.ok(open.req.headers.copy.includes(SECRET), name)
  }
  // the seeded record as the server serves it: blanked by default, exactly the one value on a reveal read
  const hit = recs.find((r) => (r.doc.records[0].ctl.masked || []).includes('authorization'))
  assert.ok(hit, 'the seeded record is served with its authorization value blanked')
  const ref = hit.doc.records[0].ref
  const base = (await f.get('calls', { ref })).doc
  assert.ok(!JSON.stringify(requestView(detailModel(base))).includes(SECRET))
  const shown = requestView(detailModel((await f.get('calls', { ref, reveal: 'authorization' })).doc), { revealed: 'authorization' })
  assert.ok(JSON.stringify(shown).includes(SECRET))
  assert.ok(!JSON.stringify(shown).includes(OTHER))
  assert.ok(!shown.req.headers.copy.includes(OTHER))
})
