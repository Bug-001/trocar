// settings.test.mjs — 1.11 §验收 for the three settings pages, over the REAL face (real server, real worker, a temp HOME): the storage
// page's seven level controls and their one write (POST /control/classes, plan then confirm), its captions, receipts and links; the
// price page's read-only table, unpriced models and paste template; the appearance page's store. Expected values come from the
// documents the face serves and the bytes of <home>/classes.json, never from this page's own output.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as storage from '../../web/legacy/settings/storage.mjs'
import * as prices from '../../web/legacy/settings/prices.mjs'
import * as appearance from '../../web/legacy/settings/appearance.mjs'
import { setTheme } from '../../web/legacy/settings/appearance.mjs'
import { THEME_KEY } from '../../web/legacy/core/ui.mjs'
import { SOURCE_WORD } from '../../web/legacy/labels/settings.mjs'
import { CLASS_IDS, CLASS_DESC, FALLBACK_CLASS } from '../../web/legacy/core/classes.mjs'
import { esc } from '../../web/legacy/core/fmt.mjs'
import { edit } from '../../src/classes/table.mjs'
import { writeSegment } from '../query/raw-home.mjs'
import { boardHome } from './real-face.mjs'
import { trafficWorld } from './traffic-world.mjs'

const STORAGE = '#/settings/storage'
const nonGet = (log) => log.filter((r) => r.method !== 'GET')

// the body rows of the 保存什么 table: class, whether it carries a level control, the pressed level, the numbers, the cells
function rows(html) {
  const body = (/<tbody>([\s\S]*?)<\/tbody>/.exec(html.slice(html.indexOf('ctable'))) || [])[1] || ''
  return [...body.matchAll(/<tr id="class-[^"]*" data-class="([^"]*)"([^>]*)>([\s\S]*?)<\/tr>/g)].map(([, cls, attrs, inner]) => ({
    cls, hl: /data-hl="true"/.test(attrs), inner,
    control: /data-lvl=/.test(inner),
    on: (/data-keep="(\w+)" class="on"/.exec(inner) || [])[1] || null,
    calls: (/data-n="calls">([^<]*)</.exec(inner) || [])[1],
    bytes: (/data-n="bytes" data-bytes="([^"]*)"/.exec(inner) || [])[1],
    receipt: (/data-receipt="([^"]+)"/.exec(inner) || [])[1] || null,
  }))
}
const notes = (html) => [...html.matchAll(/data-note="([^"]+)"/g)].map((m) => m[1])

async function withWorld(fn, { home = null } = {}) {
  const w = await trafficWorld({ home: home || boardHome({ bytes: 2e5 }) })
  try { return await fn(w) } finally { await w.close() }
}
const doc = async (w, name) => (await w.face.get(name)).doc

test('#13 a segment name and reason in the read problems are escaped', async () => {
  const h = boardHome()
  writeSegment(h.home, '20260719T100000Z', ['{"<script>x</script>'])
  await withWorld(async (w) => {
    const m = await w.mount(storage, STORAGE)
    assert.doesNotMatch(m.html(), /<script>/)
  }, { home: h })
})

test('#14 the last change line carries last_change\'s source word (cli / board / file); none → the no-change state', async () => {
  await withWorld(async (w) => {
    const m = await w.mount(storage, STORAGE)
    assert.match(m.html(), /class="cap lastchg" data-empty="no-change"/)
  })
  for (const source of Object.keys(SOURCE_WORD)) {
    const h = boardHome()
    edit({ kind: 'set', class: 'telemetry', keep: 'log', source }, { home: h.home })
    await withWorld(async (w) => {
      const d = await doc(w, 'classes')
      assert.equal(d.last_change.source, source)
      const m = await w.mount(storage, STORAGE)
      const line = (/<p class="cap lastchg"[^>]*>[\s\S]*?<\/p>/.exec(m.html()) || [])[0]
      assert.match(line, new RegExp(`data-source="${source}"`))
      assert.ok(line.includes(SOURCE_WORD[source]))
      assert.ok(line.includes(`datetime="${d.last_change.ts}"`))
    }, { home: h })
  }
})

test('#15 ?class= highlights only that row (none for an unknown class, no error); window round-trips; the pointer goes to #/capture', async () => {
  await withWorld(async (w) => {
    let m = await w.mount(storage, `${STORAGE}?class=telemetry`)
    assert.deepEqual(rows(m.html()).filter((r) => r.hl).map((r) => r.cls), ['telemetry'])
    m = await w.mount(storage, `${STORAGE}?class=nosuch`)
    assert.deepEqual(rows(m.html()).filter((r) => r.hl), [])
    assert.doesNotMatch(m.html(), /class="err"/)
    assert.match(m.html(), /href="#\/capture"/)
    const d = await doc(w, 'classes')
    for (const [win, key] of [['7d', 'd7'], ['all', 'all'], ['nosuch', 'h24']]) {
      m = await w.mount(storage, `${STORAGE}?window=${win}&class=telemetry`)
      const r = rows(m.html()).find((x) => x.cls === 'telemetry')
      assert.equal(Number(r.bytes), d.classes.find((c) => c.class === 'telemetry').counts[key].bytes, win)
    }
  })
})

test('#16 / I26 / R25 the price page states it is read-only and names pricing.source; prices and appearance send no non-GET request', async () => {
  const h = boardHome()
  fs.writeFileSync(path.join(h.home, 'pricing.json'), JSON.stringify({ 'zz-model': [1, 2, 3, 4] }))
  await withWorld(async (w) => {
    const p = await doc(w, 'pricing')
    let m = await w.mount(prices, '#/settings/prices')
    assert.ok(notes(m.html()).includes('read-only'))
    assert.ok(m.html().includes(p.source))
    await m.click('[data-copy]', { copy: 'x' })
    m = await w.mount(appearance, '#/settings/appearance')
    await m.click('[data-theme-choice]', { themeChoice: 'dark' })
    assert.deepEqual(nonGet(w.log), [])
  }, { home: h })
})

test('#17 no overview → no unpriced card', async () => {
  await withWorld(async (w) => {
    w.tamper((url, d) => (url.startsWith('/api/overview') ? { status: 404, body: { error: 'no' } } : d))
    const m = await w.mount(prices, '#/settings/prices')
    assert.doesNotMatch(m.html(), /class="umodel"|data-unpriced/)
    assert.ok(!m.html().includes((await import('../../web/legacy/labels/settings.mjs')).CARD_UNPRICED))
  })
})

test('#19 setTheme light / dark / system sets or removes data-theme and the key; a throwing store still sets data-theme and says it is not stored', () => {
  const attrs = {}, store = {}
  const html = { setAttribute: (k, v) => { attrs[k] = v }, removeAttribute: (k) => { delete attrs[k] } }
  const doc = { documentElement: html, localStorage: { setItem: (k, v) => { store[k] = v }, removeItem: (k) => { delete store[k] } } }
  for (const t of ['light', 'dark']) {
    assert.deepEqual(setTheme(t, doc), { stored: true })
    assert.equal(attrs['data-theme'], t); assert.equal(store[THEME_KEY], t)
  }
  setTheme('system', doc)
  assert.equal('data-theme' in attrs, false); assert.equal(THEME_KEY in store, false)
  const broken = { documentElement: html, localStorage: { setItem() { throw new Error('quota') }, removeItem() { throw new Error('quota') } } }
  assert.deepEqual(setTheme('dark', broken), { stored: false })
  assert.equal(attrs['data-theme'], 'dark')
})

test('#21 across the storage, price and appearance pages the only non-GET request is POST /control/classes', async () => {
  await withWorld(async (w) => {
    let m = await w.mount(storage, STORAGE)
    await m.click('[data-keep]', { class: 'telemetry', keep: 'log' })
    await m.click('[data-keep]', { class: 'telemetry', keep: 'full' })
    m.inst.update({ ...m.route(), params: { window: '7d' } })
    m = await w.mount(prices, '#/settings/prices')
    m = await w.mount(appearance, '#/settings/appearance')
    await m.click('[data-theme-choice]', { themeChoice: 'light' })
    const posts = nonGet(w.log)
    assert.ok(posts.length > 0)
    assert.deepEqual([...new Set(posts.map((r) => `${r.method} ${r.url}`))], ['POST /control/classes'])
  })
})

// last: a 403 latches the board shut for the whole process (core/http.mjs K-30)
test('#10 a 403 to the change: no receipt, and nothing more is sent (the K-30 page takes over)', async () => {
  await withWorld(async (w) => {
    const m = await w.mount(storage, STORAGE)
    w.tamper((url, d) => (url.startsWith('/control/classes') ? { status: 403, body: { error: 'forbidden' } } : d))
    const n = w.log.length
    await m.click('[data-keep]', { class: 'telemetry', keep: 'log' })
    assert.equal(w.log.length, n + 1, 'only the refused plan request')
    assert.equal(rows(m.html()).find((r) => r.cls === 'telemetry').receipt, null)
  })
})

// constructed C.5 documents for the pure storageHtml: seven classes, `other` without rules; a segment's problems are said in
// segments[].problems[], in both documents' errors[] as `segments/<name>` (the shape src/query/named/{segments,classes}.mjs write)
const SEG = '20260719T100000Z'
const classesDoc = (counts, errors = []) => ({ disk: { trocar_bytes: 1e6 }, as_of: null, file: null, errors,
  classes: CLASS_IDS.map((id, i) => ({ class: id, keep: 'full', builtin: true, rules: id === FALLBACK_CLASS ? [] : [{ host: `h${i}\\.example\\.test` }], counts: { h24: counts(id, i) } })) })
const probDocs = (probs) => {
  const errors = probs.map((p) => ({ where: `segments/${SEG}`, code: p.code, ...(p.level ? { level: p.level } : {}), reason: p.reason })) // problemEntry
  return { segments: { segments: [{ segment: SEG, problems: probs }], errors }, classes: classesDoc((id, i) => ({ calls: i, bytes: i * 100 }), errors) }
}

test('#13 notes: problems that are all level:\'note\' are no read problem (no bad line, no partial note) but the slow line; mixed → the real one counts; no level counts as before', () => {
  const note = (k) => ({ code: 'index-cold', reason: `built the index while reading ${k}`, level: 'note' })
  const real = { code: 'record-unparseable', reason: 'line 3 is not JSON' }
  const allNote = probDocs([note(1), note(2)])
  assert.equal(storage.problemCount(allNote.segments), 0)
  const h = storage.storageHtml(allNote, '24h')
  assert.doesNotMatch(h, /class="dline bad"/)
  assert.ok(!notes(h).includes('partial'))
  assert.ok(notes(h).includes('slow'))
  const mixed = probDocs([note(1), real])
  assert.equal(storage.problemCount(mixed.segments), 1)
  const hm = storage.storageHtml(mixed, '24h')
  assert.match(hm, /class="dline bad"/)
  assert.ok(notes(hm).includes('partial'))
  const plain = probDocs([real, { ...real, reason: 'line 4 is not JSON' }])
  assert.equal(storage.problemCount(plain.segments), 2)
  assert.ok(!notes(storage.storageHtml(plain, '24h')).includes('slow'))
})

test('#13 every segment problem is listed once on the page (the 磁盘 card); the classes card\'s technical keys are unique', () => {
  const probs = [{ code: 'index-cold', reason: 'built while reading', level: 'note' }, { code: 'record-unparseable', reason: 'line 3 is not JSON' }, { code: 'record-unparseable', reason: 'line 9 is not JSON' }]
  const d = probDocs(probs)
  const h = storage.storageHtml(d, '24h').replace(/ data-copy="[^"]*"/g, '') // the copy buffer is not shown
  for (const p of probs) assert.equal(h.split(esc(`segments/${SEG} · ${p.code} · ${p.reason}`)).length - 1, 1, p.reason) // 1.11: 段名 · 原因码 · 原因原文
  const tech = (/id="classtech"[\s\S]*$/.exec(h) || [''])[0]
  const keys = [...tech.matchAll(/<span class="k">([^<]*)<\/span>/g)].map((m) => m[1]).filter(Boolean)
  assert.ok(keys.length >= CLASS_IDS.length)
  assert.equal(new Set(keys).size, keys.length, keys.join(' | '))
})

test('#27 each class row says what the class is (CLASS_DESC, one per D40 class); Stored carries its share of the window total; total 0 → no share; `other` without rules has words in its rules cell', () => {
  assert.deepEqual(Object.keys(CLASS_DESC), CLASS_IDS)
  const d = probDocs([])
  const h = storage.storageHtml(d, '24h'), T = d.classes.classes.reduce((s, c) => s + c.counts.h24.bytes, 0)
  for (const c of d.classes.classes) {
    const r = rows(h).find((x) => x.cls === c.class)
    assert.ok(r.inner.includes(esc(CLASS_DESC[c.class])), c.class)
    const cell = (/data-n="bytes"[^>]*>([^<]*)</.exec(r.inner) || [])[1]
    assert.ok(cell.includes(`${Math.round(c.counts.h24.bytes / T * 100)}%`), `${c.class}: ${cell}`)
  }
  const other = rows(h).find((x) => x.cls === FALLBACK_CLASS)
  assert.ok(((/<td class="rules">([\s\S]*?)<\/td>/.exec(other.inner) || [])[1] || '').replace(/<[^>]*>/g, '').trim().length > 0)
  const zero = classesDoc(() => ({ calls: 0, bytes: 0 }))
  assert.doesNotMatch(storage.storageHtml({ classes: zero, segments: null }, '24h').replace(/<tfoot>[\s\S]*$/, '').replace(/^[\s\S]*<tbody>/, ''), /%/)
})
