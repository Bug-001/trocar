// request-view.test.mjs — the request detail widget (2.6 §C; 1.10 acceptance #21). Real `calls {ref}` documents from the real face on
// a temp HOME; a shape the generated store does not hold is constructed from a real record. Contract only: which bytes sit in which
// side's section, the marks per side, masking, and that「Show」re-reads `calls {ref, reveal}` for exactly the one value (2.6 §C).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as hostPage from '../../src/web/v2/traffic/host.mjs'
import { requestDetailHtml, detailModel } from '../../src/web/v2/traffic/request-view.mjs'
import { esc } from '../../src/web/v2/core/fmt.mjs'
import * as W from '../../src/web/v2/labels/traffic.mjs'
import { trafficWorld } from './traffic-world.mjs'
import { boardHome } from './real-face.mjs'
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
  const w = await trafficWorld({ home: seeded() })
  const T = (await w.face.get('traffic', { limit: 500 })).doc
  const recs = []
  for (const h of T.hosts.filter((r) => r.host)) for (const r of (await w.face.get('calls', { harness: h.harness, host: h.host, limit: 500 })).doc.records) {
    recs.push({ h, doc: (await w.face.get('calls', { ref: r.ref })).doc })
  }
  return { w, recs }
})()
test.after(async () => { (await world).w.close() })
const side = (html, s) => { const at = html.indexOf(`data-side="${s}"`); assert.ok(at > 0, s); return html.slice(at, html.indexOf('</section>', at)) }

test('#21a the body is the record\'s bytes, in its own side\'s section', async () => {
  const { recs } = await world
  let seen = 0
  for (const { doc } of recs) {
    const rec = doc.records[0], html = requestDetailHtml(detailModel(doc))
    for (const s of ['req', 'resp']) {
      const b = rec.ctl[s]
      if (!b || !['text', 'sse', 'ws'].includes(b.kind) || !b.text) continue
      seen++
      assert.ok(side(html, `${s}-body`).includes(esc(b.text)), `${rec.ref} ${s}`)
    }
  }
  assert.ok(seen > 0, 'the generated store holds text bodies')
})

test('#21b each side carries its own fidelity mark, never one sentence over both', async () => {
  const { recs } = await world
  const doc = structuredClone(recs[0].doc), rec = doc.records[0]
  rec.ctl = { ...rec.ctl, retention: 'full', labels: [{ id: 'resp-json-reserialized', label: 'x' }], req: { kind: 'length-only', bytes: 812 }, resp: { kind: 'json', chars: 2 } }
  const html = requestDetailHtml(detailModel(doc))
  const req = side(html, 'req-body'), resp = side(html, 'resp-body')
  assert.ok(req.includes(esc(W.REQ_LEGACY)) && !req.includes(esc(W.RESP_RESERIALIZED)))
  assert.ok(resp.includes(esc(W.RESP_RESERIALIZED)) && !resp.includes(esc(W.REQ_LEGACY)))
  for (const [k, other] of [['truncated', 'partial'], ['partial', 'truncated']]) {
    rec.ctl = { ...rec.ctl, labels: [], req: { kind: 'text', text: 'abc', bytes: 9, [k]: true }, resp: { kind: 'text', text: 'ok', bytes: 2 } }
    const h2 = requestDetailHtml(detailModel(doc))
    assert.ok(side(h2, 'req-body').includes('class="rqd-mark"'), k)
    assert.ok(!side(h2, 'resp-body').includes('class="rqd-mark"'), `${k}: the response side is not marked (${other})`)
  }
})

test('#21c credential headers are masked by default, with the note that masking is display only', async () => {
  const { recs } = await world
  for (const name of ['authorization', 'Authorization', 'x-api-key', 'cookie', 'proxy-authorization']) {
    const doc = structuredClone(recs[0].doc)
    doc.records[0].req_headers = { ...doc.records[0].req_headers, [name]: SECRET }
    const html = requestDetailHtml(detailModel(doc))
    assert.ok(!html.includes(SECRET), name)
    assert.ok(side(html, 'req-headers').includes(`data-reveal="${name}"`), name)
    assert.ok(side(html, 'req-headers').includes('class="rqd-masknote"'), name)
  }
})

const refReads = (w) => w.log.filter((x) => x.url.startsWith('/api/calls') && new URL(x.url, 'http://x').searchParams.has('ref'))
const credentialed = async () => {
  const { w, recs } = await world
  const hit = recs.find(({ doc }) => (doc.records[0].ctl.masked || []).includes('authorization'))
  assert.ok(hit, 'the seeded record is served with its authorization value blanked')
  const ref = hit.doc.records[0].ref
  const hash = `#/traffic/host/${encodeURIComponent(hit.h.harness)}/${encodeURIComponent(hit.h.host)}?ref=${encodeURIComponent(ref)}`
  return { w, ref, mount: () => w.mount(hostPage, hash) }
}

test('「Show」re-reads calls {ref, reveal} once: that value appears, every other credential stays masked', async () => {
  const { w, ref, mount } = await credentialed()
  const s = await mount()
  assert.ok(s.html().includes('data-reveal="authorization"') && !s.html().includes(SECRET) && !s.html().includes(OTHER))
  const before = refReads(w).length
  await s.click('[data-reveal]', { reveal: 'authorization' })
  const added = refReads(w).slice(before)
  assert.equal(added.length, 1)
  const q = new URL(added[0].url, 'http://x').searchParams
  assert.equal(added[0].method, 'GET'); assert.equal(q.get('ref'), ref); assert.equal(q.get('reveal'), 'authorization')
  assert.ok(s.html().includes(SECRET))
  assert.ok(!s.html().includes(OTHER) && s.html().includes('data-reveal="x-api-key"'))
  s.inst.unmount()
})

test('a failed reveal read keeps the detail and the value masked', async () => {
  const { w, mount } = await credentialed()
  w.tamper((url, d) => (new URL(url, 'http://x').searchParams.has('reveal') ? { status: 500, body: {} } : d))
  try {
    const s = await mount()
    await s.click('[data-reveal]', { reveal: 'authorization' })
    assert.ok(s.html().includes('data-reveal="authorization"'), 'the detail is still shown')
    assert.ok(!s.html().includes(SECRET))
    s.inst.unmount()
  } finally { w.tamper(null) }
})
