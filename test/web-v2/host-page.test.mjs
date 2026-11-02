// host-page.test.mjs — the host page (1.10 §host 页), acceptance #14–#20 and I22 (1.10:244-268 numbering). The `calls` documents
// come from the real face on a temp HOME; a shape the generated store does not hold is constructed from a real row. The page mounts
// over the board's own api with fetch logged (traffic-world.mjs). Contract only: links, routes, requests, marks, placement.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as hostPage from '../../web/legacy/traffic/host.mjs'
import { rowHtml } from '../../web/legacy/traffic/host.mjs'
import { harnessKey } from '../../web/legacy/core/chips.mjs'
import { CLASS_IDS } from '../../web/legacy/core/classes.mjs'
import { parseHash, documentTitle } from '../../web/legacy/core/router.mjs'
import { bytes } from '../../web/legacy/core/fmt.mjs'
import * as W from '../../web/legacy/labels/traffic.mjs'
import { trafficWorld } from './traffic-world.mjs'

const world = (async () => {
  const w = await trafficWorld()
  const T = (await w.face.get('traffic', { limit: 500 })).doc
  const h = T.hosts.filter((r) => r.host && !/\d/.test(r.host)).reduce((a, b) => (b.requests > a.requests ? b : a))
  const calls = (await w.face.get('calls', { harness: h.harness, host: h.host, limit: 500 })).doc
  return { w, T, h, calls, page: `#/traffic/host/${encodeURIComponent(h.harness)}/${encodeURIComponent(h.host)}` }
})()
test.after(async () => { (await world).w.close() })
const unamp = (s) => s.replace(/&amp;/g, '&')
const cellsOf = (html) => [...html.matchAll(/<span class="cell num">([^<]*)<\/span>/g)].map((m) => m[1])

test('#14 retention marks: log links to its storage cell, legacy-meta carries the length-only mark, full has none', async () => {
  const { h, calls } = await world
  for (const real of calls.records.slice(0, 3)) for (const cls of [real.class, 'telemetry', 'llm']) {
    const opts = { harness: h.harness, window: '24h' }
    const log = rowHtml({ ...real, class: cls, retention: 'log', error: false, _host: h.host }, opts)
    const a = /<a class="rmark"[^>]*data-mark="log"[^>]*href="([^"]*)"|<a class="rmark"[^>]*href="([^"]*)"[^>]*data-mark="log"/.exec(log)
    assert.ok(a, 'log is a link')
    const r = parseHash(unamp(a[1] || a[2]))
    assert.equal(r.screen, 'settings-storage')
    assert.deepEqual(r.params, { h: harnessKey(h.harness), class: cls })
    const legacy = rowHtml({ ...real, class: cls, retention: 'legacy-meta', error: false, _host: h.host }, opts)
    assert.deepEqual([...legacy.matchAll(/data-mark="([^"]*)"/g)].map((m) => m[1]), ['legacy-meta'])
    assert.ok(legacy.includes(`title="${W.RETENTION_MARK['legacy-meta'].tip}"`))
    const full = rowHtml({ ...real, class: cls, retention: 'full', error: false, _host: h.host }, opts)
    assert.ok(!full.includes('data-mark='), 'full: no mark')
  }
})

test('#15 a request whose received bytes were not recorded says not recorded, never 0; a failed one carries the failed mark', async () => {
  const { h, calls } = await world
  const real = calls.records[0]
  for (const recv of [null, 0, 120]) for (const error of [true, false]) {
    const html = rowHtml({ ...real, received_bytes: recv, error, retention: 'full', _host: h.host }, { harness: h.harness, window: '24h' })
    const [, got] = cellsOf(html)
    assert.equal(got, recv == null ? W.UNRECORDED : bytes(recv))
    assert.equal(html.includes('data-mark="failed"'), error)
  }
})

test('#16 the class filter drives `calls {host}` class=; an empty answer carries that class id', async () => {
  const { w, h, page } = await world
  const absent = CLASS_IDS.find((c) => !(h.classes || {})[c])
  const present = Object.keys(h.classes)[0]
  for (const cls of [present, absent]) {
    const from = w.log.length
    const s = await w.mount(hostPage, `${page}?window=all&class=${cls}`)
    const html = s.html(); s.inst.unmount()
    const reads = w.log.slice(from).filter((x) => x.url.startsWith('/api/calls'))
    assert.ok(reads.length >= 1)
    for (const x of reads) assert.equal(new URL(x.url, 'http://x').searchParams.get('class'), cls)
    if (cls === absent) assert.match(html, new RegExp(`data-empty[^>]*data-class="${cls}"|data-class="${cls}"[^>]*data-empty`))
    else assert.ok(!html.includes('data-empty'), cls)
  }
})

test('#18 the breadcrumb: three parts, the first two links back to traffic and to the agent\'s rows; the title has no number', async () => {
  const { w, h, page } = await world
  const s = await w.mount(hostPage, `${page}?window=7d`)
  const html = s.html(); s.inst.unmount()
  const nav = /<nav class="crumbs"[^>]*>(.*?)<\/nav>/.exec(html)[1]
  const links = [...nav.matchAll(/<a href="([^"]*)"/g)].map((m) => parseHash(unamp(m[1])))
  assert.equal(links.length, 2)
  assert.equal(nav.split('<span class="sep"').length, 3, 'three parts')
  assert.deepEqual([links[0].screen, links[0].params], ['traffic', { window: '7d' }])
  assert.deepEqual([links[1].screen, links[1].params], ['traffic', { window: '7d', h: harnessKey(h.harness) }])
  assert.ok(/<span aria-current="page">/.test(nav))
  assert.ok(!/\d/.test(documentTitle(parseHash(page))), documentTitle(parseHash(page)))
})

test('I22 the host page head links carry window and class', async () => {
  const { w, page } = await world
  const s = await w.mount(hostPage, `${page}?window=1h&class=telemetry`)
  const head = /<header class="pagehead">(.*?)<\/header>/.exec(s.html())[1]; s.inst.unmount()
  const links = [...head.matchAll(/<a href="([^"]*)"/g)].map((m) => parseHash(unamp(m[1])))
  assert.ok(links.length >= 5, 'two crumbs and the window options')
  for (const r of links) assert.equal(r.params.class, 'telemetry', JSON.stringify(r))
  for (const r of links) assert.ok(['1h', '24h', '7d', 'all'].includes(r.params.window), JSON.stringify(r))
})

test('#19 a failed `calls {host}` or `calls {ref}` read says why and offers retry, never an empty body', async () => {
  const { w, calls, page } = await world
  const ref = calls.records[0].ref
  for (const which of ['host', 'ref']) {
    w.tamper((url, doc) => {
      const q = new URL(url, 'http://x').searchParams
      return url.startsWith('/api/calls') && (which === 'ref' ? q.has('ref') : q.has('host')) ? { status: 500, body: { error: `cause-${which}` } } : doc
    })
    try {
      const s = await w.mount(hostPage, `${page}?ref=${encodeURIComponent(ref)}`)
      const html = s.html()
      assert.ok(html.includes(`cause-${which}`), which)
      assert.ok(html.includes(which === 'ref' ? 'data-act="retry-detail"' : 'data-act="retry"'), which)
      if (which === 'host') assert.ok(!html.includes('id="hlist"'))
      else assert.ok(!html.includes('class="rqd"'))
      const from = w.log.length
      await s.click(which === 'ref' ? '[data-act="retry-detail"]' : '[data-act="retry"]')
      assert.ok(w.log.slice(from).some((x) => x.url.startsWith('/api/calls')), 'retry reads again')
      s.inst.unmount()
    } finally { w.tamper(null) }
  }
})

test('#20 detail placement follows the media query (a column at ≥ 1440 px, a bottom sheet below); Esc drops ref from the route', async () => {
  const { w, calls, page } = await world
  const ref = calls.records[0].ref
  for (const width of [1920, 1440, 1439, 1280, 1024]) {
    const s = await w.mount(hostPage, `${page}?ref=${encodeURIComponent(ref)}`, { width })
    assert.match(s.html(), new RegExp(`class="thost ${width >= 1440 ? 'column' : 'drawer'}"`), String(width))
    assert.ok(s.html().includes('class="hdetail open"'))
    await s.key('Escape')
    assert.equal(s.route().params.ref, undefined)
    assert.ok(!s.html().includes('class="hdetail open"'), 'closed')
    s.inst.unmount()
  }
})

const asideOf = (html) => { const m = /<aside class="hdetail[^"]*" id="hdetail"[^>]*>([\s\S]*?)<\/aside>/.exec(html); return m ? m[1] : null }

test('#23 the latest selection wins: a slower earlier `calls {ref}` answer never paints over the newer one', async () => {
  const { w, calls, page } = await world
  const fresh = async (r) => { const s = await w.mount(hostPage, `${page}?ref=${encodeURIComponent(r)}`); const a = asideOf(s.html()); s.inst.unmount(); return a }
  const recs = calls.records.filter((r) => r.ref)
  let A = null, B = null, asideA = null, asideB = null
  for (const b of recs.slice(1, 12)) { const x = await fresh(recs[0].ref), y = await fresh(b.ref); if (x !== y) { A = recs[0].ref; B = b.ref; asideA = x; asideB = y; break } }
  assert.ok(A && B, 'two records whose details differ')
  let release = null
  const held = new Promise((r) => { release = r })
  w.tamper(async (url, doc) => (new URL(url, 'http://x').searchParams.get('ref') === A ? held.then(() => doc) : doc))
  try {
    const s = await w.mount(hostPage, page)
    s.inst.update({ ...s.route(), params: { ...s.route().params, ref: A } })
    s.inst.update({ ...s.route(), params: { ...s.route().params, ref: B } })
    await w.settle()
    release()
    await w.settle()
    const got = asideOf(s.html())
    assert.equal(got, asideB, 'the detail is B\'s')
    assert.notEqual(got, asideA)
    s.inst.unmount()
  } finally { w.tamper(null) }
})

test('#24 after unmount, crossing the 1440 px breakpoint paints nothing into the shared screen element', async () => {
  const { w, calls, page } = await world
  for (const width of [1920, 1024]) {
    const s = await w.mount(hostPage, `${page}?ref=${encodeURIComponent(calls.records[0].ref)}`, { width })
    s.inst.unmount()
    assert.equal(s.el.innerHTML, '')
    s.media(width < 1440)
    await w.settle()
    assert.equal(s.el.innerHTML, '', String(width))
  }
})
