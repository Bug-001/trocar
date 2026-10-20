// traffic.test.mjs — 流量 (1.10 §流量表), acceptance #1–#11 (1.10:244-268 numbering). The documents come from the real face (real
// server, real query worker on a temp HOME); a shape the generated store does not hold is constructed from a real answer. The screen
// itself mounts over the board's own api with fetch logged (traffic-world.mjs). Contract only: rows, links, routes, requests, marks.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as traffic from '../../src/web/v2/traffic/traffic.mjs'
import * as hostPage from '../../src/web/v2/traffic/host.mjs'
import { tableModel, tableHtml, rowHtml, recvParts, queryOf } from '../../src/web/v2/traffic/traffic.mjs'
import { harnessKey, ALIASES } from '../../src/web/v2/core/chips.mjs'
import { CLASS_IDS } from '../../src/web/v2/core/classes.mjs'
import { parseHash } from '../../src/web/v2/core/router.mjs'
import { bytes } from '../../src/web/v2/core/fmt.mjs'
import * as W from '../../src/web/v2/labels/traffic.mjs'
import { trafficWorld } from './traffic-world.mjs'

const world = (async () => {
  const w = await trafficWorld()
  const T = (await w.face.get('traffic', { limit: 500 })).doc
  assert.ok(T.hosts.length > 3 && new Set(T.hosts.map((h) => h.harness)).size > 2, 'several agents, several hosts')
  return { w, T }
})()
test.after(async () => { (await world).w.close() })

const H = 3600e3
// the drawn table rows in order: {h, named (the agent's name is drawn), inferred, html}
const rowsOf = (html) => html.split(/(?=<(?:a|div) class="trow)/).filter((s) => /^<(?:a|div) class="trow(?: nolink)?"/.test(s) && / data-h="/.test(s))
  .map((s) => ({ h: /data-h="([^"]*)"/.exec(s)[1], named: s.includes('class="nmname"'), inferred: s.includes('data-mark="inferred"'), isNew: s.includes('data-mark="new"'), html: s }))

test('#1 table rows are the `traffic` hosts, grouped by agent, the agent only on a group\'s first row; unfiltered, the total is `totals`', async () => {
  const { T } = await world
  const m = tableModel(T, { now: Date.parse(T.as_of) })
  const rows = rowsOf(tableHtml(m))
  assert.equal(rows.length, T.hosts.length)
  rows.forEach((r, i) => assert.equal(r.named, i === 0 || rows[i - 1].h !== r.h, `row ${i}`))
  const runs = rows.filter((r, i) => i === 0 || rows[i - 1].h !== r.h).map((r) => r.h)
  assert.equal(runs.length, new Set(runs).size, 'one run per agent')
  assert.equal(m.total.requests, T.totals.requests)
  const total = tableHtml(m).split('trow ttotal')[1]
  for (const n of [T.totals.sent_bytes, T.totals.received_bytes]) assert.ok(total.includes(bytes(n)), `${n} in the total row`)
})

test('#2 收回: unrecorded is never 0; a partial sum is a floor with its count; all unrecorded reads not recorded', async () => {
  const { T } = await world
  const base = T.hosts.find((h) => h.requests >= 3 && h.received_bytes > 0)
  for (const [un, recv] of [[1, base.received_bytes], [base.requests - 1, base.received_bytes], [base.requests, base.received_bytes], [base.requests + 2, base.received_bytes], [0, null], [1, null]]) {
    const row = { ...base, received_unrecorded: un, received_bytes: recv }
    const p = recvParts(row)
    const drawn = rowsOf(rowHtml({ ...row, recv: p }, tableModel({ ...T, hosts: [row] }), true))[0].html
    if (recv == null || un >= row.requests) assert.equal(p.value, null, `${un}/${recv}`)
    else { assert.equal(p.value, recv); assert.equal(p.un, un); assert.ok(p.main.startsWith('≥')); assert.ok(drawn.includes(String(un))) }
    assert.ok(!drawn.includes(`>${bytes(0)}<`), 'never a 0')
  }
})

test('#4 新 follows the first-contact rule whatever the window; a fresh store has none', async () => {
  const { T } = await world
  const N = Date.parse(T.as_of), base = T.hosts[0]
  const iso = (t) => new Date(N + t).toISOString()
  for (const first of [-1 * H, -23 * H, -25 * H, -240 * H, 2 * H]) for (const since of [-2 * H, -23 * H, -25 * H, -720 * H, null]) for (const window of ['1h', '24h', '7d', 'all']) {
    const row = { ...base, first_seen: iso(first) }
    const doc = { ...T, hosts: [row], harness_since: since == null ? {} : { [base.harness]: iso(since) } }
    const want = first > -24 * H && first <= 0 && since != null && since < -24 * H
    assert.equal(rowsOf(tableHtml(tableModel(doc, { now: N, window })))[0].isNew, want, `first ${first / H}h since ${since && since / H}h ${window}`)
  }
  const fresh = { ...T, harness_since: Object.fromEntries(Object.keys(T.harness_since).map((k) => [k, iso(-H)])) }
  assert.equal(rowsOf(tableHtml(tableModel(fresh, { now: N }))).filter((r) => r.isNew).length, 0)
})

test('I20 the 新 badge sits only in the first-seen cell', async () => {
  const { T } = await world
  const rows = rowsOf(tableHtml(tableModel(T, { now: Date.parse(T.as_of) }))).filter((r) => r.isNew)
  assert.ok(rows.length > 0, 'the generated store has a new host at its own as_of')
  for (const r of rows) {
    const at = r.html.indexOf('data-mark="new"')
    assert.equal(r.html.split('data-mark="new"').length, 2)
    assert.ok(at > r.html.indexOf('class="cell-first"') && at < r.html.indexOf('class="cell num"'), 'inside the first-seen cell')
  }
})

test('#5 window and filters: the route drives the `traffic` query and the rows kept', async () => {
  const { w, T } = await world
  for (const [win, since] of [['1h', '1h'], ['24h', '24h'], ['7d', '7d'], ['all', null], ['junk', '24h'], [undefined, '24h']]) {
    const from = w.log.length
    const s = await w.mount(traffic, win === undefined ? '#/traffic' : `#/traffic?window=${win}`)
    s.inst.unmount()
    const reads = w.log.slice(from).filter((x) => x.url.startsWith('/api/traffic'))
    assert.equal(reads.length, 1, String(win))
    assert.equal(new URL(reads[0].url, 'http://x').searchParams.get('since'), since, String(win))
  }
  const h = T.hosts[0].harness
  for (const id of [h, Object.keys(ALIASES).find((k) => ALIASES[k] === h)].filter(Boolean)) {
    const q = queryOf({ h: id })
    assert.deepEqual(tableModel(T, q).flat.map((r) => r.harness).sort(), T.hosts.filter((r) => harnessKey(r.harness) === harnessKey(id)).map((r) => r.harness).sort())
  }
  for (const cls of CLASS_IDS) {
    const kept = tableModel(T, queryOf({ class: cls })).flat
    assert.equal(kept.length, T.hosts.filter((r) => (r.classes || {})[cls] > 0).length, cls)
    assert.ok(kept.every((r) => r.classes[cls] > 0))
  }
})

test('#7 the caption row carries as_of and names the agents `sessions` has that the rows lack (through harnessKey)', async () => {
  const { w, T } = await world
  const drop = T.hosts[T.hosts.length - 1].harness
  const keep = T.hosts.find((r) => r.harness !== drop).harness
  const alias = Object.keys(ALIASES).find((k) => ALIASES[k] === keep) || keep
  w.tamper((url, doc) => {
    if (url.startsWith('/api/traffic')) return { ...doc, hosts: doc.hosts.filter((r) => r.harness !== drop) }
    if (url.startsWith('/api/sessions')) return { ...doc, sessions: [{ ...doc.sessions[0], harness: alias }, { ...doc.sessions[0], harness: drop }] }
    return doc
  })
  try {
    const s = await w.mount(traffic, '#/traffic?window=all')
    const html = s.html(); s.inst.unmount()
    assert.ok(html.includes(`datetime="${T.as_of}"`), 'as_of')
    assert.deepEqual([...html.matchAll(/class="cap-agent" data-h="([^"]*)"/g)].map((m) => m[1]), [harnessKey(drop)])
    w.tamper((url, doc) => (url.startsWith('/api/sessions') ? { status: 500, body: { error: 'down' } } : doc))
    const t = await w.mount(traffic, '#/traffic')
    assert.ok(!t.html().includes('class="cap-agent"'), 'unreadable sessions: no coverage note')
    t.inst.unmount()
  } finally { w.tamper(null) }
})

test('#8 agent inference: the caption note while rows carry no harness_inferred, a per-row mark once they do', async () => {
  const { T } = await world
  const bare = { ...T, hosts: T.hosts.map(({ harness_inferred, ...r }) => r) }
  const a = tableHtml(tableModel(bare))
  assert.ok(a.includes('data-note="agent-source"'))
  assert.equal(rowsOf(a).filter((r) => r.inferred).length, 0)
  const mixed = { ...T, hosts: T.hosts.map((r, i) => ({ ...r, harness_inferred: i % 2 === 0 })) }
  const b = tableHtml(tableModel(mixed))
  assert.ok(!b.includes('data-note="agent-source"'))
  const byKey = new Map(mixed.hosts.map((r) => [`${harnessKey(r.harness) || 'unknown'}|${r.host}`, r.harness_inferred]))
  for (const r of rowsOf(b).filter((x) => x.html.includes('href='))) {
    const host = parseHash(/href="([^"]*)"/.exec(r.html)[1].replace(/&amp;/g, '&')).host
    assert.equal(r.inferred, byKey.get(`${r.h}|${host}`), host)
  }
})

test('#9 a row opens its host page; agent and host round-trip through the route; no host is no link', async () => {
  const { T } = await world
  const base = T.hosts[0]
  for (const harness of [base.harness, 'claude-code', null, 'some-new-agent']) for (const host of ['api.example.test', 'a b/c?d#e%f&g=h', 'xn--bcher-kva.example:8443', '[::1]:443']) for (const cls of [null, 'telemetry']) {
    const row = { ...base, harness, host }
    const m = tableModel({ ...T, hosts: [row] }, { window: '7d', cls })
    const href = /href="([^"]*)"/.exec(rowHtml(m.flat[0], m, true))[1].replace(/&amp;/g, '&')
    const r = parseHash(href)
    assert.equal(r.screen, 'traffic-host')
    assert.equal(r.harness, harnessKey(harness) || 'unknown')
    assert.equal(r.host, host)
    assert.deepEqual(r.params, cls ? { window: '7d', class: cls } : { window: '7d' })
  }
  for (const host of [null, '']) {
    const m = tableModel({ ...T, hosts: [{ ...base, host }] })
    assert.ok(!rowHtml(m.flat[0], m, true).includes('href='), `host ${JSON.stringify(host)}`)
  }
})

test('#10 traffic sources carry no endpoint path literal', async () => {
  const { w, T } = await world
  const dir = new URL('../../src/web/v2/', import.meta.url)
  const files = ['traffic/traffic.mjs', 'traffic/host.mjs', 'traffic/request-view.mjs', 'labels/traffic.mjs']
  const src = files.map((f) => fs.readFileSync(fileURLToPath(new URL(f, dir)), 'utf8'))
  const endpoints = new Set()
  for (const h of T.hosts.filter((r) => r.host)) for (const r of (await w.face.get('calls', { harness: h.harness, host: h.host, limit: 500 })).doc.records) if (/^\/[^/?]+\/[^?]/.test(r.endpoint || '')) endpoints.add(r.endpoint.split('?')[0])
  assert.ok(endpoints.size > 3)
  src.forEach((text, i) => {
    for (const e of endpoints) assert.ok(!text.includes(e), `${files[i]} names ${e}`)
    assert.deepEqual(text.match(/(['"`])\/[A-Za-z][\w.-]*\/[^'"`\s]*\1/g) || [], [], files[i])
  })
})

test('#11 read only: every request the two pages make is a GET to /api/', async () => {
  const { w, T } = await world
  const h = T.hosts.find((r) => r.host && r.requests > 1)
  const from = w.log.length
  const t = await w.mount(traffic, '#/traffic')
  for (const win of ['1h', '7d', 'all']) { t.inst.update(parseHash(`#/traffic?window=${win}&class=llm`)); await w.settle() }
  t.inst.unmount()
  const ref = (await w.face.get('calls', { harness: h.harness, host: h.host, limit: 1 })).doc.records[0].ref
  const p = await w.mount(hostPage, `#/traffic/host/${encodeURIComponent(h.harness)}/${encodeURIComponent(h.host)}?ref=${encodeURIComponent(ref)}`)
  await p.click('[data-reveal]', { reveal: 'authorization' })
  await p.key('Escape')
  p.inst.update(parseHash(`#/traffic/host/${h.harness}/${encodeURIComponent(h.host)}?window=7d&class=telemetry`)); await w.settle()
  p.inst.unmount()
  const seen = w.log.slice(from)
  assert.ok(seen.some((x) => x.url.startsWith('/api/traffic')) && seen.some((x) => x.url.startsWith('/api/calls')))
  assert.deepEqual(seen.filter((x) => x.method !== 'GET' || !x.url.startsWith('/api/')), [])
})

test('main classes: rows with no recorded class read as the unrecorded word with their count, never "null"', async () => {
  const { T } = await world
  const row = { ...T.hosts[0], classes: { telemetry: 2 }, class_unrecorded: 5 }
  const drawn = rowsOf(rowHtml({ ...row, recv: recvParts(row) }, tableModel({ ...T, hosts: [row] }), true))[0].html
  const cell = drawn.split('class="cell classes"')[1]
  assert.ok(cell.includes(`${W.classWord(null)} 5`), cell)
  assert.ok(!/\bnull\b/.test(cell), cell)
})
