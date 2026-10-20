// settings.test.mjs — 1.11 §验收 for the three settings pages, over the REAL face (real server, real worker, a temp HOME): the storage
// page's seven level controls and their one write (POST /control/classes, plan then confirm), its captions, receipts and links; the
// price page's read-only table, unpriced models and paste template; the appearance page's store. Expected values come from the
// documents the face serves and the bytes of <home>/classes.json, never from this page's own output.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as storage from '../../src/web/v2/settings/storage.mjs'
import * as prices from '../../src/web/v2/settings/prices.mjs'
import * as appearance from '../../src/web/v2/settings/appearance.mjs'
import { templateText, unpricedModels } from '../../src/web/v2/settings/prices.mjs'
import { setTheme } from '../../src/web/v2/settings/appearance.mjs'
import { THEME_KEY } from '../../src/web/v2/core/ui.mjs'
import { priceMatch } from '../../src/web/v2/core/metrics.mjs'
import { COMMANDS } from '../../src/web/v2/labels/capture.mjs'
import { SOURCE_WORD } from '../../src/web/v2/labels/settings.mjs'
import { CLASS_IDS, CLASS_DESC, FALLBACK_CLASS } from '../../src/web/v2/core/classes.mjs'
import { esc } from '../../src/web/v2/core/fmt.mjs'
import { loadPricing } from '../../src/view/pricing.mjs'
import { edit, readTable } from '../../src/classes/table.mjs'
import { classesFile } from '../../src/paths.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { HARNESSES } from '../../src/dissect/harnesses.mjs'
import { writeSegment } from '../query/raw-home.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { boardHome } from './real-face.mjs'
import { trafficWorld } from './traffic-world.mjs'

const STORAGE = '#/settings/storage'
const bytesOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null)
const nonGet = (log) => log.filter((r) => r.method !== 'GET')
const confirms = (log) => log.filter((r) => r.method === 'POST' && r.body && 'confirm' in r.body)
const keepIn = (home) => Object.fromEntries(readTable({ home }).classes.map((c) => [c.class, c.keep]))

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
const total = (html) => {
  const t = (/<tr data-total="true">([\s\S]*?)<\/tr>/.exec(html) || [])[1] || ''
  return { calls: (/data-n="calls">([^<]*)</.exec(t) || [])[1], bytes: (/data-bytes="([^"]*)"/.exec(t) || [])[1] }
}
const notes = (html) => [...html.matchAll(/data-note="([^"]+)"/g)].map((m) => m[1])
const inTable = (doc) => doc.classes.filter((c) => c.in_table !== false && c.class != null)

// a document stand-in for core/ui.mjs confirmDialog: records the dialog's markup and focus, answers it with 'ok' | 'cancel' | 'esc'
function fakeDialogDoc() {
  const st = { html: null, open: false, focused: null, keys: [], click: null }
  const back = {
    remove() { st.open = false }, addEventListener(t, fn) { st.click = fn },
    querySelector: (s) => (s === '[data-confirm="cancel"]' ? { focus() { st.focused = 'cancel' } } : null),
  }
  const doc = {
    body: { appendChild() { st.open = true } },
    createElement: () => ({ set innerHTML(v) { st.html = v }, get firstElementChild() { return back } }),
    addEventListener(t, fn) { if (t === 'keydown') st.keys.push(fn) },
    removeEventListener(t, fn) { st.keys = st.keys.filter((f) => f !== fn) },
  }
  const answer = (a) => (a === 'esc'
    ? st.keys.forEach((f) => f({ key: 'Escape', stopPropagation() {} }))
    : st.click({ target: { closest: () => ({ dataset: { confirm: a } }) } }))
  return { doc, st, answer }
}

async function withWorld(fn, { home = null } = {}) {
  const w = await trafficWorld({ home: home || boardHome({ bytes: 2e5 }) })
  try { return await fn(w) } finally { await w.close() }
}
const doc = async (w, name) => (await w.face.get(name)).doc

// a temp home whose raw/ holds the generated traffic of the first n harnesses only
function homeWith(n) {
  const src = tmpDir('trocar-gen-')
  generate({ home: src, bytes: 3e5 })
  const ids = new Set(HARNESSES.slice(0, n).map((h) => h.id))
  const userHome = tmpDir('trocar-board-'), home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  for (const f of fs.readdirSync(path.join(src, 'raw')).filter((x) => x.endsWith('.ndjson'))) {
    const lines = fs.readFileSync(path.join(src, 'raw', f), 'utf8').split('\n').filter((l) => {
      if (!l) return false
      try { const a = JSON.parse(l).proc; return !a || ids.has(a.agent) } catch { return false }
    })
    writeSegment(home, f.replace(/\.ndjson$/, ''), lines)
  }
  return { userHome, home }
}

test('#1 / M2 / P9 seven rows, one control per class whatever the harness count; numbers are counts.<window>; the total is the sum; a window switch changes numbers, not levels; the later-only note in every state', async () => {
  for (const n of [1, 3, HARNESSES.length]) {
    await withWorld(async (w) => {
      const d = await doc(w, 'classes')
      const m = await w.mount(storage, STORAGE)
      const r0 = rows(m.html())
      assert.equal(r0.length, d.classes.length, `${n} harnesses`)
      assert.equal(r0.filter((r) => r.control).length, inTable(d).length, `${n} harnesses: one control per class`)
      for (const [win, key] of [['24h', 'h24'], ['7d', 'd7'], ['all', 'all']]) {
        m.inst.update({ ...m.route(), params: { window: win } })
        const html = m.html(), rs = rows(html)
        for (const c of d.classes) {
          const r = rs.find((x) => x.cls === String(c.class ?? ''))
          assert.equal(r.calls, String(c.counts[key].calls), `${c.class} ${win}`)
          assert.equal(Number(r.bytes), c.counts[key].bytes)
          assert.equal(r.on, r0.find((x) => x.cls === r.cls).on, 'the level does not follow the window')
        }
        const t = total(html)
        assert.equal(Number(t.calls), d.classes.reduce((s, c) => s + c.counts[key].calls, 0))
        assert.equal(Number(t.bytes), d.classes.reduce((s, c) => s + c.counts[key].bytes, 0))
        assert.ok(notes(html).includes('later'))
      }
    }, { home: homeWith(n) })
  }
  // the bad-file and partial-read states carry the note too
  for (const prep of [({ home }) => fs.writeFileSync(classesFile(home), '{ broken'), ({ home }) => writeSegment(home, '20260719T100000Z', ['{"not json'])]) {
    const h = boardHome(); prep(h)
    await withWorld(async (w) => { const m = await w.mount(storage, STORAGE); assert.ok(notes(m.html()).includes('later')) }, { home: h })
  }
})

test('R23 rows are ordered by counts.<window>.bytes, descending', async () => {
  await withWorld(async (w) => {
    const d = await doc(w, 'classes')
    for (const [win, key] of [['24h', 'h24'], ['7d', 'd7'], ['all', 'all']]) {
      const m = await w.mount(storage, `${STORAGE}?window=${win}`)
      const got = rows(m.html()).map((r) => Number(r.bytes))
      assert.deepEqual(got, [...d.classes.map((c) => c.counts[key].bytes)].sort((a, b) => b - a), win)
    }
  })
})

test('#5 the row popover holds no control; 「see this traffic」 is #/traffic?class=<c>&window=<w>', async () => {
  await withWorld(async (w) => {
    const d = await doc(w, 'classes')
    const m = await w.mount(storage, `${STORAGE}?window=7d`)
    for (const c of inTable(d)) {
      const r = rows(m.html()).find((x) => x.cls === c.class)
      const pop = (/<div class="pop"[\s\S]*$/.exec(r.inner) || [])[0]
      assert.ok(pop, c.class)
      assert.doesNotMatch(pop, /<(button|input|select)\b/)
      const href = (/<a href="([^"]+)"/.exec(pop) || [])[1].replace(/&amp;/g, '&')
      const u = new URL(href.slice(1), 'http://x')
      assert.equal(u.pathname, '/traffic')
      assert.deepEqual([u.searchParams.get('class'), u.searchParams.get('window')], [c.class, '7d'])
    }
  })
})

test('#6 / I25 the rules column renders rules[] read-only, each cell carrying the whole list in title', async () => {
  await withWorld(async (w) => {
    const d = await doc(w, 'classes')
    const m = await w.mount(storage, STORAGE)
    for (const c of inTable(d)) {
      const cell = (/<td class="rules">([\s\S]*?)<\/td>/.exec(rows(m.html()).find((x) => x.cls === c.class).inner) || [])[1]
      assert.doesNotMatch(cell, /<(button|input|select)\b/)
      const title = (/title="([^"]*)"/.exec(cell) || [])[1]
      for (const rule of c.rules) {
        assert.ok(cell.includes(rule.host.replace(/&/g, '&amp;')), `${c.class}: ${rule.host}`)
        assert.ok(title.includes(rule.host.replace(/&/g, '&amp;')))
      }
    }
  })
})

test('#7 / K-25 root, control false or control unreadable → no segmented control, no disabled button, the level as text, the set command in technical details', async () => {
  const answers = [{ control: false, user: 'u', root: true, harnesses: [] }, { control: false, user: 'u', root: false, harnesses: [] }, { status: 503, body: { error: 'down' } }]
  for (const a of answers) {
    await withWorld(async (w) => {
      w.tamper((url, d) => (url.startsWith('/control/status') ? a : d))
      const cls = await doc(w, 'classes')
      const m = await w.mount(storage, STORAGE)
      const html = m.html()
      assert.doesNotMatch(html, /data-keep=|data-lvl=|\bdisabled\b/, JSON.stringify(a))
      for (const c of inTable(cls)) {
        assert.ok(/class="lvtext"/.test(rows(html).find((r) => r.cls === c.class).inner))
        const other = (c.keep || 'full') === 'log' ? COMMANDS.setFull : COMMANDS.setLog
        assert.ok(html.includes(other.replace('<class>', c.class).replace(/</g, '&lt;')), c.class)
      }
      if (a.root) assert.ok(notes(html).includes('read-only'))
    })
  }
})

test('#8 telemetry → log on the real face: one plan POST then one confirm POST {kind:set, class:telemetry, keep:log}; only telemetry changes in classes.json; busy without disabled, a second click sends nothing; the re-read row reads log; again → already', async () => {
  await withWorld(async (w) => {
    const before = keepIn(w.home.home)
    let release
    const held = new Promise((r) => { release = r })
    w.tamper(async (url, d, init) => { if (url.startsWith('/control/classes') && !JSON.parse(init.body).confirm) await held; return d })
    const m = await w.mount(storage, STORAGE)
    w.log.length = 0
    await m.click('[data-keep]', { class: 'telemetry', keep: 'log' }, { wait: false })
    const busy = rows(m.html()).find((r) => r.cls === 'telemetry').inner
    assert.match(busy, /aria-busy="true"/)
    assert.doesNotMatch(busy, /\bdisabled\b/)
    await m.click('[data-keep]', { class: 'telemetry', keep: 'log' }, { wait: false })
    release()
    await w.settle()
    w.tamper(null)
    const posts = nonGet(w.log)
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[0].body, { kind: 'set', class: 'telemetry', keep: 'log' })
    assert.equal(confirms(w.log).length, 1)
    const { confirm, ...body } = confirms(w.log)[0].body
    assert.deepEqual(body, { kind: 'set', class: 'telemetry', keep: 'log' })
    assert.equal(typeof confirm, 'string')
    const after = keepIn(w.home.home)
    assert.deepEqual(after, { ...before, telemetry: 'log' })
    const at = (i) => w.log.findIndex((r, j) => j > i && r.method === 'GET' && r.url.startsWith('/api/classes'))
    assert.ok(at(w.log.indexOf(confirms(w.log)[0])) > 0, 'classes is re-read after the answer')
    const row = rows(m.html()).find((r) => r.cls === 'telemetry')
    assert.equal(row.on, 'log')
    assert.equal(row.receipt, 'changed')
    await m.click('[data-keep]', { class: 'telemetry', keep: 'log' })
    assert.equal(rows(m.html()).find((r) => r.cls === 'telemetry').receipt, 'already')
  })
})

test('#9 llm → log asks first: Cancel / Esc send no confirm and leave classes.json byte-identical, focus on Cancel; confirm sends one; telemetry → log and llm → full ask nothing', async () => {
  await withWorld(async (w) => {
    const file = classesFile(w.home.home)
    const m = await w.mount(storage, STORAGE)
    const fd = fakeDialogDoc()
    m.el.ownerDocument = fd.doc
    for (const a of ['cancel', 'esc']) {
      const b0 = bytesOf(file), n0 = confirms(w.log).length
      await m.click('[data-keep]', { class: 'llm', keep: 'log' }, { wait: false })
      await w.settle()
      assert.equal(fd.st.open, true, a)
      assert.equal(fd.st.focused, 'cancel')
      fd.st.focused = null
      fd.answer(a)
      await w.settle()
      assert.equal(confirms(w.log).length, n0, a)
      assert.deepEqual(bytesOf(file), b0, a)
    }
    await m.click('[data-keep]', { class: 'llm', keep: 'log' }, { wait: false })
    await w.settle()
    const n0 = confirms(w.log).length
    fd.answer('ok')
    await w.settle()
    assert.equal(confirms(w.log).length, n0 + 1)
    assert.equal(keepIn(w.home.home).llm, 'log')
    for (const [cls, keep] of [['telemetry', 'log'], ['llm', 'full']]) {
      fd.st.open = false
      const n = confirms(w.log).length
      await m.click('[data-keep]', { class: cls, keep })
      assert.equal(fd.st.open, false, `${cls} → ${keep}`)
      assert.equal(confirms(w.log).length, n + 1)
      assert.equal(keepIn(w.home.home)[cls], keep)
    }
  })
})

test('#10 receipts per constructed answer: 400 not changed, 404 / 405 read-only and control re-read, network error offline with retry; server text only escaped in technical details; the level stays the server\'s', async () => {
  const EVIL = '<img src=x onerror=alert(1)>'
  const cases = [[400, 'not-changed'], [404, 'read-only'], [405, 'read-only'], [0, 'offline']]
  for (const [status, kind] of cases) {
    await withWorld(async (w) => {
      const m = await w.mount(storage, STORAGE)
      const on0 = rows(m.html()).find((r) => r.cls === 'telemetry').on
      w.tamper((url, d) => {
        if (!url.startsWith('/control/classes')) return d
        if (status === 0) throw new Error(EVIL)
        return { status, body: { error: EVIL } }
      })
      const ctl0 = w.log.filter((r) => r.url.startsWith('/control/status')).length
      await m.click('[data-keep]', { class: 'telemetry', keep: 'log' })
      const html = m.html(), row = rows(html).find((r) => r.cls === 'telemetry')
      assert.equal(row.receipt, kind, String(status))
      assert.equal(row.on, on0, 'the level shown is the re-read one')
      assert.ok(!html.includes(EVIL), 'never raw')
      const cut = row.inner.indexOf('id="rc-telemetry"'), before = cut < 0 ? row.inner : row.inner.slice(0, cut), tech = cut < 0 ? '' : row.inner.slice(cut)
      if (status === 400 || status === 0) assert.ok(tech.includes('&lt;img'), 'the server text sits in the receipt\'s technical details')
      assert.ok(!before.includes('&lt;img') && !html.replace(row.inner, '').includes('&lt;img'), 'and nowhere else')
      if (kind === 'read-only') assert.ok(w.log.filter((r) => r.url.startsWith('/control/status')).length > ctl0, 'control status is read again')
      if (kind === 'offline') assert.match(row.inner, /class="linkbtn" data-class="telemetry" data-keep="log"/)
    })
  }
})

test('#11 an unparseable classes.json → no controls, the file path in technical details; one bad class value → controls drawn; no file → no problem line', async () => {
  const bad = boardHome()
  fs.writeFileSync(classesFile(bad.home), '{ broken')
  await withWorld(async (w) => {
    const d = await doc(w, 'classes')
    assert.ok(d.errors.some((e) => e.fatal === true))
    const m = await w.mount(storage, STORAGE)
    assert.doesNotMatch(m.html(), /data-keep=/)
    assert.ok(m.html().includes(d.file))
    assert.ok(notes(m.html()).includes('file-bad'))
  }, { home: bad })

  const one = boardHome()
  edit({ kind: 'set', class: 'telemetry', keep: 'log' }, { home: one.home })
  const t = JSON.parse(fs.readFileSync(classesFile(one.home), 'utf8'))
  t.classes.find((c) => c.class === 'files').keep = 'bogus'
  fs.writeFileSync(classesFile(one.home), JSON.stringify(t))
  await withWorld(async (w) => {
    const d = await doc(w, 'classes')
    assert.ok(d.errors.length > 0 && !d.errors.some((e) => e.fatal))
    const m = await w.mount(storage, STORAGE)
    assert.equal(rows(m.html()).filter((r) => r.control).length, inTable(d).length)
    assert.ok(notes(m.html()).includes('file-some'))
  }, { home: one })

  await withWorld(async (w) => {
    const m = await w.mount(storage, STORAGE)
    assert.ok(!notes(m.html()).some((k) => k.startsWith('file-')))
  })
})

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

test('#17 unpriced models: priceMatch null with usable calls; at least N = the max sessions over that model\'s rows; the empty state; no overview → no card', async () => {
  const table = { opus: [1, 2, 3, 4] }
  const got = unpricedModels([
    { model: 'glm-x', calls: 5, failed: 0, no_usage: 0, sessions: 2 },
    { model: 'glm-x', calls: 3, failed: 0, no_usage: 0, sessions: 4 },
    { model: 'zz-dead', calls: 2, failed: 1, no_usage: 1, sessions: 9 },
    { model: 'claude-opus-4', calls: 9, failed: 0, no_usage: 0, sessions: 7 },
  ], table)
  assert.deepEqual(got, [{ model: 'glm-x', sessions: 4 }])
  assert.deepEqual(unpricedModels([{ model: 'claude-opus-4', calls: 1, sessions: 1 }], table), [])
  await withWorld(async (w) => {
    w.tamper((url, d) => (url.startsWith('/api/overview') ? { status: 404, body: { error: 'no' } } : d))
    const m = await w.mount(prices, '#/settings/prices')
    assert.doesNotMatch(m.html(), /class="umodel"|data-unpriced/)
    assert.ok(!m.html().includes((await import('../../src/web/v2/labels/settings.mjs')).CARD_UNPRICED))
  })
})

test('#18 the template: a member of the file when it exists, a whole file when not; pasted verbatim the model stays unpriced (no $0)', () => {
  const model = 'glm-4.6'
  const member = templateText(model, '/somewhere/pricing.json')
  assert.ok(!/,\s*$/.test(member))
  assert.deepEqual(JSON.parse(`{${member}}`), { [model]: [null, null, null, null] })
  const whole = templateText(model, 'default')
  assert.deepEqual(JSON.parse(whole), { [model]: [null, null, null, null] })
  const f = path.join(tmpDir('trocar-price-'), 'pricing.json')
  fs.writeFileSync(f, whole)
  const t = loadPricing(f)
  assert.equal(Object.prototype.hasOwnProperty.call(t, model), false)
  assert.equal(priceMatch(t, model), null)
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
