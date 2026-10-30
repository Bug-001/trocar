// test/web-v2/fidelity-marks.test.mjs — the board's fidelity marks, read the way the board reads the server (2.3 #2 #8 #9 ·
// 1.4 #4 #9 · 2.6 #3). A definition is the lane wire's own (3.5 §会话读): its fidelity in `ff: {faithfulness?, unaddressable?}`,
// its bytes behind a `ref`, or `ref: null` with the reason and the body in `inline`; it enters the desk through applyLane
// (desk-world.mjs deskOf), as every definition does. The axes are generated: each `ff` value with and without a ref in each
// section, an opened body's outcomes, reply parts on and off their resp.raw span, each fact of the call fidelity row. Structure
// by class and data attribute, words only as the labels module has them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { ctxWindowHtml } from '../../src/web/v2/replay/ctxwin.mjs'
import { rawPanelUnits } from '../../src/web/v2/replay/rawpanel.mjs'
import { serialize } from '../../src/web/v2/core/units.mjs'
import { bodyCache, showBody } from '../../src/web/v2/replay/blocks.mjs'
import { loadBodies } from '../../src/web/v2/replay/cell.mjs'
import { stepOf } from '../../src/web/v2/replay/model.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'
import { esc } from '../../src/web/v2/core/fmt.mjs'
import { deskOf } from './desk-world.mjs'

// 3.2's closed set of a block's faithfulness besides verbatim; a value outside it is one the board does not know
const KNOWN = ['metadata', 'opaque', 'summarized', 'omitted', 'truncated']
const FFS = [undefined, {}, { faithfulness: 'verbatim' }, ...KNOWN.map((v) => ({ faithfulness: v })), { faithfulness: 'mystery-q' }]
const SECS = { tools: { role: 'system', kind: 'tool', tag: 'def' }, system: { role: 'system', kind: 'text', tag: 'text' }, messages: { role: 'user', kind: 'text', tag: 'user' } }
const WHY = 'WHY-q no span to cut'
let n = 0
// one request definition as the lane wire sends it (src/query/named/lane.mjs wireDef): with a ref; or ref null, the reason at the
// top and in ff, and the body inline
function def(sec, ff, addressed, o = {}) {
  const k = n++, s = SECS[sec], text = `BODY-${k}-q`
  const d = { bid: `B${k}`, sec, role: s.role, kind: s.kind, head: { role: s.role, tag: s.tag, label: `L${k}` }, preview: text, chars: text.length, bytes: text.length,
    r: { as: 'text' }, ...(sec === 'tools' ? { name: `T${k}` } : null), ...o }
  if (addressed) return { ...d, ref: `S/m.ndjson#R:1::${k}-${k + 9}`, ...(ff ? { ff } : null) }
  const inline = o.inline ?? (sec === 'tools' ? { desc: text } : sec === 'system' ? { text } : { block: { type: 'text', text } })
  return { ...d, ref: null, unaddressable: WHY, ff: { ...ff, unaddressable: WHY }, inline }
}
// the proof rule (2.3 §保真标), as the mark the row must carry: proven, a known value, unknown, or no source location
const want = (d) => {
  const v = d.ff && d.ff.faithfulness
  if (v == null || v === 'verbatim') return d.ref ? 'verbatim' : 'unaddressable'
  return KNOWN.includes(v) ? v : 'unknown'
}

const OPEN_TURNS = { has: () => true, get: () => true } // a fold memory that holds every turn open: every row is drawn
const stateOf = (desk, playhead = 0, extra = {}) => {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead, diffRef: null, navOpen: new Set(), openBlocks: new Set(), turnFold: OPEN_TURNS, turnLanded: new Set(), ctx: {}, ...extra }
}
const deskOfSteps = (steps, { rows = steps.map(() => ({})), replies, details } = {}) => deskOf([{ kind: 'main', rows, blocks: steps, replies, details }])

const visible = (h) => h.replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, ' ')
const srOf = (h) => [...h.matchAll(/<span class="sr-only">([^<]*)<\/span>/g)].map((m) => m[1]).join(' ')
const badgesOf = (head) => [...head.matchAll(/<span class="ffbadge[^"]*" data-ff="([^"]*)"/g)].map((m) => m[1])
// the window's rows: {ff, head, body} by list position (request rows) or in order (reply rows); a row runs to the next row,
// section header, turn or the reply
function rowsOf(h, { reply = false } = {}) {
  const re = reply ? /<div class="cblk[^"]*"[^>]*data-rp="[^"]*"[^>]*>/g : /<div class="cblk[^"]*"[^>]*data-bi="\d+"[^>]*>/g
  const starts = [...h.matchAll(re)], out = []
  starts.forEach((m, j) => {
    let end = j + 1 < starts.length ? starts[j + 1].index : h.length
    for (const stop of ['<div class="cwsec"', '<div class="cwturn', '<div class="cwreply"']) { const i = h.indexOf(stop, m.index + 1); if (i > 0 && i < end) end = i }
    const row = h.slice(m.index, end), at = row.indexOf('<div class="cbh"'), close = row.indexOf('</div>', at)
    out.push({ attrs: m[0], ff: /data-ff="([^"]*)"/.exec(m[0])[1], bi: Number((/data-bi="(\d+)"/.exec(m[0]) || [])[1]), head: row.slice(at, close), body: row.slice(close) })
  })
  return out
}
const headersOf = (h) => [...h.matchAll(/<div class="cwsec" id="sec-([^"]+)">([\s\S]*?)<\/div>/g)].map((m) => ({ sec: m[1], html: m[2], claims: /class="cwsecff v"/.test(m[2]) }))
const count = (h, word) => h.split(word).length - 1
// a word as the page carries it; a word the labels module lacks fails here, never matches vacuously
const w = (x) => { assert.ok(typeof x === 'string' && x.length > 0, `a word the labels have: ${x}`); return esc(x) }

// one row's mark against the code it must carry: a proven row has no visible mark and tells a screen reader 逐字; any other row
// has exactly one visible mark with its word (2.3 §保真标). Under the window line 不能回源 is not repeated, the screen-reader word is.
function assertMark(row, code, why, { windowLine = false } = {}) {
  assert.equal(row.ff, code, `${why}: data-ff`)
  const quiet = code === 'verbatim' || (windowLine && code === 'unaddressable')
  if (quiet) {
    assert.deepEqual(badgesOf(row.head), [], `${why}: no visible mark`)
    assert.ok(srOf(row.head).includes(w(W.FF_WORD[code])), `${why}: the screen-reader word`)
  } else {
    assert.deepEqual(badgesOf(row.head), [code], `${why}: one visible mark`)
    assert.ok(visible(row.head).includes(w(W.FF_WORD[code])), `${why}: its word`)
  }
  if (code !== 'verbatim') assert.ok(!srOf(row.head).includes(w(W.FF_WORD.verbatim)), `${why}: never 逐字 to a screen reader`)
}
// every section header against its blocks: 以下逐字 once iff each of its blocks is proven; under the window line just ◐
function assertHeaders(h, flat, why, { windowLine = false } = {}) {
  const hs = headersOf(h)
  assert.ok(hs.length > 0, `${why}: section headers`)
  for (const hd of hs) {
    const blocks = flat.filter((b) => b.sec === hd.sec)
    const claims = !windowLine && blocks.every((b) => want(b) === 'verbatim')
    assert.equal(hd.claims, claims, `${why}: ${hd.sec} claims 以下逐字 iff every block is proven`)
    assert.equal(count(visible(hd.html), w(W.SECTION_VERBATIM)), claims ? 1 : 0, `${why}: ${hd.sec} says it once or not at all`)
    if (windowLine) assert.ok(hd.html.includes(W.HALF_MARK), `${why}: ${hd.sec} carries ◐`)
  }
  assert.equal(count(visible(h), w(W.SECTION_VERBATIM)), hs.filter((x) => x.claims).length, `${why}: 以下逐字 only on a claiming header`)
}

// a `block` read double: each ref's item as the server sends it (3.5 §会话读 block), by `answer(ref)`
const OK = (ref, bytes = `BYTES of ${ref}`) => ({ ref, bytes, encoding: 'identity', fidelity: { verbatim: true }, truncated: null })
const OUTCOMES = {
  verbatim: { code: 'verbatim', item: (ref) => OK(ref) },
  // the wire carried the request compressed: exact decompressed bytes (block.mjs NOTE.decoded), said once by the call row
  decoded: { code: 'verbatim', row: { wire: { reqEncoding: 'gzip' } }, item: (ref) => ({ ...OK(ref), encoding: 'gzip', fidelity: { verbatim: true, note: 'decoded-q' } }) },
  reserialized: { code: 'reserialized', item: (ref) => ({ ...OK(ref), fidelity: { verbatim: false, note: 'reserialized-q' } }) },
  missing: { code: 'notfetched', item: (ref) => ({ ref, bytes: null, encoding: null, fidelity: null, truncated: null }) },
}
const blockApi = (item) => ({ get: async (name, { ref }) => {
  assert.equal(name, 'block')
  const blocks = ref.map((r) => item(r))
  return { ok: true, data: { blocks, errors: blocks.filter((b) => b.bytes == null).map((b) => ({ where: b.ref, code: 'record-missing', reason: 'REASON-q' })) } }
} })

test('2.3 #2 · 1.4 #4: each ff value with and without a ref, in each section, gets the proof rule\'s mark; 以下逐字 only over a proven section', async () => {
  bodyCache.clear()
  // each case among proven blocks of every section, so a section header's claim turns on that case alone and no window line hides it
  const proven = () => ['tools', 'system', 'messages'].map((sec) => def(sec, undefined, true))
  const steps = [], cases = []
  for (const sec of Object.keys(SECS)) for (const ff of FFS) for (const addressed of [true, false]) {
    const x = def(sec, ff, addressed), list = proven()
    list.splice(list.findIndex((b) => b.sec === sec) + 1, 0, x)
    steps.push(list); cases.push(x)
  }
  steps.push(proven()) // a step whose every section is proven
  const desk = deskOfSteps(steps)
  for (const opened of [false, true]) {
    const s = stateOf(desk)
    if (opened) { // every row open, every addressed body back as the wire's bytes: nothing is withdrawn
      const flats = steps.map((_, p) => stepOf(desk, s.anchor.calls[p].rid).flat)
      await loadBodies(blockApi(OK), flats.flat().filter((b) => b.text_ref).map((b) => b.text_ref))
      for (const f of flats) for (const b of f) s.openBlocks.add(`${b.bid}#0`)
    }
    for (let p = 0; p < steps.length; p++) {
      s.playhead = p
      const h = ctxWindowHtml(s), flat = steps[p], rows = rowsOf(h), why = `${opened ? 'open' : 'closed'} step ${p} ${JSON.stringify(cases[p] ? { sec: cases[p].sec, ff: cases[p].ff, ref: !!cases[p].ref } : 'all proven')}`
      assert.ok(!h.includes('<div class="cwwin"'), `${why}: some block has a ref, so no window line`)
      assert.equal(rows.length, flat.length, `${why}: every row drawn`)
      for (const r of rows) assertMark(r, want(flat[r.bi]), `${why} row ${r.bi}`)
      assertHeaders(h, flat, why)
      if (!opened) continue
      for (const r of rows) {
        const d = flat[r.bi]
        if (d.ref) assert.ok(r.body.includes(esc(`BYTES of ${d.ref}`)), `${why} row ${r.bi}: the opened body is the bytes`)
        else { // 2.3 §没有 def.ref: the body the definition brings, under the line saying it came inline
          assert.ok(visible(r.body).includes(w(W.INLINE_NOTE)), `${why} row ${r.bi}: the inline note`)
          assert.ok(r.body.includes(`BODY-${d.bid.slice(1)}-q`), `${why} row ${r.bi}: the inline body`)
        }
      }
    }
  }
  bodyCache.clear()
})

test('2.3 #2 · 1.4 #4: an opened body that comes back unproven marks its row and withdraws 以下逐字 on every repaint; decoded and verbatim do not', async () => {
  bodyCache.clear()
  for (const [name, o] of Object.entries(OUTCOMES)) {
    for (const sec of Object.keys(SECS)) {
      const flat = ['tools', 'system', 'messages'].map((x) => def(x, undefined, true)), target = flat.find((b) => b.sec === sec)
      const desk = deskOfSteps([flat], { rows: [o.row || {}] }), s = stateOf(desk)
      s.openBlocks.add(`${target.bid}#0`)
      await loadBodies(blockApi(o.item), [target.ref])
      const h = ctxWindowHtml(s), why = `${name} in ${sec}`
      for (const r of rowsOf(h)) assertMark(r, flat[r.bi] === target ? o.code : 'verbatim', `${why} row ${r.bi}`)
      for (const hd of headersOf(h)) assert.equal(hd.claims, hd.sec !== sec || o.code === 'verbatim', `${why}: the ${hd.sec} header`)
      assert.equal(h.includes(w(W.reqEncodingFact('gzip'))), !!o.row, `${why}: the call row says the decoding once, not the block`)
    }
  }
  bodyCache.clear()
})

// the DOM path (blocks.mjs showBody → noteBodyFidelity): at once, not at the next repaint (2.3 Risk). The elements are minimal fakes
// of the parts showBody touches: the body, its row (head and its spans as markup) and the window holding the section header.
test('2.3 #2: the withdrawal happens on the spot: the row gets its mark, the section header stops claiming 以下逐字', async () => {
  for (const [name, o] of Object.entries(OUTCOMES)) {
    bodyCache.clear()
    const d = def('messages', undefined, true), b = { ...d, text_ref: d.ref }
    const [got] = await loadBodies(blockApi(o.item), [b.ref])
    const hd = { cls: new Set(['cwsecff', 'v']), textContent: W.SECTION_VERBATIM, title: '', classList: { remove(c) { hd.cls.delete(c) } } }
    const root = { querySelector: (sel) => (sel.startsWith('#sec-messages ') && sel.endsWith('.cwsecff.v') && hd.cls.has('v') ? hd : null) }
    const head = { html: `<span class="cbrole">user</span><span class="sr-only">,${W.FF_WORD.verbatim}</span>`,
      insertAdjacentHTML(_, x) { this.html += x },
      querySelector(sel) { return /sr-only/.test(sel) && this.html.includes('sr-only') ? { remove: () => { this.html = this.html.replace(/<span class="sr-only">[^<]*<\/span>/, '') } } : null } }
    const blk = { classList: {}, isConnected: true, dataset: { ff: 'verbatim', sec: 'messages' }, querySelector: (sel) => (/cbh/.test(sel) ? head : null), closest: (sel) => (sel === '#ctxwin' ? root : null) }
    const bc = { innerHTML: '', dataset: {}, closest: (sel) => (sel === '.cblk' ? blk : null) }
    showBody(bc, b, got)
    const row = { attrs: `data-ff="${blk.dataset.ff}"`, ff: blk.dataset.ff, head: head.html }
    assertMark(row, o.code, name)
    assert.equal(hd.cls.has('v'), o.code === 'verbatim', `${name}: the header's claim`)
    assert.equal(hd.textContent.includes(W.SECTION_VERBATIM), o.code === 'verbatim', `${name}: the header's words`)
  }
  bodyCache.clear()
})

test('2.3 #2: a new trace\'s tool definition is proven and opens on its full schema; an old trace\'s is metadata only', async () => {
  bodyCache.clear()
  const schema = JSON.stringify({ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path_q: { type: 'string' } }, required: ['file_path_q'] } })
  const fresh = def('tools', {}, true), oldRef = def('tools', { faithfulness: 'metadata' }, true), oldInline = def('tools', { faithfulness: 'metadata' }, false, { inline: {} })
  const flat = [fresh, oldRef, oldInline, def('system', undefined, true), def('messages', undefined, true)]
  const desk = deskOfSteps([flat]), s = stateOf(desk)
  for (const b of [fresh, oldRef, oldInline]) s.openBlocks.add(`${b.bid}#0`)
  await loadBodies(blockApi((ref) => OK(ref, ref === fresh.ref ? schema : '{"name":"Read","input_schema_props":["file_path_q"],"description_chars":11}')), [fresh.ref, oldRef.ref])
  const h = ctxWindowHtml(s), rows = rowsOf(h)
  assertMark(rows[0], 'verbatim', 'new trace')
  assert.ok(rows[0].body.includes(esc('"required"')) && rows[0].body.includes('file_path_q'), 'the opened row shows the full input_schema')
  for (const r of rows.slice(1, 3)) assertMark(r, 'metadata', `old trace row ${r.bi}`)
  assert.ok(visible(rows[2].body).includes(w(W.SCHEMA_NOT_KEPT)) && rows[2].body.includes(esc(oldInline.name)), 'the old trace\'s body: the tool and the schema text not kept')
  assert.ok(!headersOf(h).find((x) => x.sec === 'tools').claims, 'the tools section is not 逐字')
  bodyCache.clear()
})

test('2.3 #2: an opaque block opens on a placeholder, never on empty text', () => {
  const block = { type: 'thinking', thinking: '', signature: 'SIG-q' }
  const x = def('messages', { faithfulness: 'opaque' }, false, { role: 'assistant', kind: 'thinking', head: { role: 'assistant', tag: 'thinking', label: 'thinking' }, inline: { block } })
  const flat = [def('system', undefined, true), x], s = stateOf(deskOfSteps([flat]))
  s.openBlocks.add(`${x.bid}#0`)
  const [r] = rowsOf(ctxWindowHtml(s)).filter((y) => flat[y.bi] === x)
  assertMark(r, 'opaque', 'opaque')
  const cell = /<pre class="cellraw"[^>]*>([\s\S]*?)<\/pre>/.exec(r.body)
  assert.ok(cell && cell[1].replace(/<[^>]*>/g, '').trim().length > 0, 'the body is a placeholder, not blank')
})

test('2.3 #9: no block with a ref draws the window line, ◐ on each header, 不能回源 not repeated; one ref draws none', () => {
  const none = Object.keys(SECS).flatMap((sec) => FFS.map((ff) => def(sec, ff, false)))
  const mixed = [def('tools', undefined, true), def('system', undefined, false), def('messages', undefined, false)]
  const desk = deskOfSteps([none, mixed])
  const h = ctxWindowHtml(stateOf(desk, 0))
  assert.ok(h.includes('<div class="cwwin"') && visible(h).includes(w(W.WINDOW_LINE)), 'the window line')
  assert.ok(h.includes(esc(WHY)), 'the server\'s reason is in its technical details')
  for (const r of rowsOf(h)) assertMark(r, want(none[r.bi]), `row ${r.bi}`, { windowLine: true })
  assertHeaders(h, none, 'window line', { windowLine: true })
  const m = ctxWindowHtml(stateOf(desk, 1))
  assert.ok(!m.includes('<div class="cwwin"'), 'a step with one addressed block has no window line')
  for (const r of rowsOf(m)) assertMark(r, want(mixed[r.bi]), `mixed row ${r.bi}`)
})

// ── this step's reply (2.3 §这一步的回复 · 2.6 #3) ─────────────────────────────────────────────────────────────────────
test('2.3 #2 · 2.6 #3: a reply part is proven only on its resp.raw span, else parsed; the panel\'s one mark never says 逐字 without the spans', () => {
  const SPAN = /::resp\.raw::\d+-\d+$/
  const part = (where, ff) => {
    const k = n++, d = { bid: `P${k}`, kind: 'text', head: { role: 'assistant', tag: 'say', label: 'say' }, preview: `say ${k}`, chars: 4, bytes: 4, r: { as: 'text' }, ...(ff ? { ff } : null) }
    if (where === 'span') return { ...d, ref: `S/m.ndjson#R:1::resp.raw::${k}-${k + 4}` }
    if (where === 'req') return { ...d, ref: `S/m.ndjson#R:1::${k}-${k + 4}` }
    return { ...d, ref: null, unaddressable: WHY, ff: { ...ff, unaddressable: WHY }, inline: { block: { type: 'text', text: `say ${k}` } } }
  }
  const expect = (d) => {
    const v = d.ff && d.ff.faithfulness
    if (v != null && v !== 'verbatim') return KNOWN.includes(v) ? v : 'unknown'
    return SPAN.test(d.ref || '') ? 'verbatim' : 'parsed'
  }
  const replies = ['span', 'req', 'none'].map((where) => FFS.map((ff) => part(where, ff)))
  replies.push(FFS.slice(0, 3).map((ff) => part('span', ff))) // a reply whose every part is on its span
  // each reply with no reply-side fact, and with each that says the reply was not stored whole (2.6 §A 「◐ 回复没采全」)
  const facts = [{}, { respIncomplete: { truncated: true } }, ...['resp-truncated', 'resp-undecoded'].map((id) => ({ wire: { labels: [{ id, label: 'RESP-LABEL-q' }] } }))]
  const steps = replies.flatMap((parts) => facts.map((row) => ({ parts, row })))
  const desk = deskOfSteps(steps.map(() => [def('system', undefined, true)]), { rows: steps.map((x) => x.row), replies: steps.map((x) => x.parts), details: steps.map(() => ({ norm: { stop_reason: 'end' } })) })
  const s = stateOf(desk, 0, { curFlat: [], viewPin: null, meta: {} })
  steps.forEach(({ parts, row }, p) => {
    s.playhead = p
    const h = ctxWindowHtml(s), rows = rowsOf(h.slice(h.indexOf('<div class="cwreply"')), { reply: true }), why = `reply ${p} ${JSON.stringify(row)}`
    assert.equal(rows.length, parts.length, `${why}: a row per part`)
    rows.forEach((r, i) => { // a row's mark is its own part's; the reply-side fact is the call row's (2.3 §这一步的回复)
      assert.equal(count(r.attrs, 'data-ff="'), 1, `${why} part ${i}: one fidelity value`)
      assertMark(r, expect(parts[i]), `${why} part ${i} ${JSON.stringify(parts[i].ff)} ${parts[i].ref}`)
    })
    // the raw panel's one mark: none only when every part resolves to its span and the reply was stored whole
    const panel = serialize(rawPanelUnits(s)), partial = Object.keys(row).length > 0
    const marked = partial || !parts.every((d) => SPAN.test(d.ref || ''))
    assert.equal(count(panel, 'class="rpmark"'), marked ? 1 : 0, `${why}: the panel's one mark`)
    if (marked) assert.ok(visible(panel).includes(w(partial ? W.REPLY_PARTIAL : W.REPLY_PARSED)), `${why}: its word`)
  })
})
