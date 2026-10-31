// test/web-v2/fidelity-marks.test.mjs — the board's fidelity marks, read the way the board reads the server (2.3 #2 #8 #9 ·
// 1.4 #4 #9 · 2.6 #3). A definition is the lane wire's own (3.5 §会话读): its fidelity in `ff: {faithfulness?, unaddressable?}`,
// its bytes behind a `ref`, or `ref: null` with the reason and the body in `inline`; it enters the desk through applyLane
// (desk-world.mjs deskOf), as every definition does. The axes are generated: each `ff` value with and without a ref in each
// section, an opened body's outcomes, reply parts on and off their resp.raw span, each fact of the call fidelity row. Structure
// by class and data attribute, words only as the labels module has them. The real face (real-face.mjs) for the demo sample, a
// Codex WebSocket session missing a record, and a v0 envelope.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { ctxWindowHtml } from '../../src/web/v2/replay/ctxwin.mjs'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { rawPanelUnits } from '../../src/web/v2/replay/rawpanel.mjs'
import { serialize } from '../../src/web/v2/core/units.mjs'
import { bodyCache, showBody } from '../../src/web/v2/replay/blocks.mjs'
import { loadBodies } from '../../src/web/v2/replay/cell.mjs'
import { stepOf } from '../../src/web/v2/replay/model.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'
import { esc } from '../../src/web/v2/core/fmt.mjs'
import { deskOf, deskFrom } from './desk-world.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { writeSegment } from '../query/raw-home.mjs'
import { bigSession } from '../query/big-session.mjs'

// 3.2's closed set of a block's faithfulness besides verbatim; a value outside it is one the board does not know
const KNOWN = ['metadata', 'opaque', 'summarized', 'omitted', 'truncated']
const FFS = [undefined, {}, { faithfulness: 'verbatim' }, ...KNOWN.map((v) => ({ faithfulness: v })), { faithfulness: 'mystery-q' }]
const SECS = { tools: { role: 'system', kind: 'tool', tag: 'def' }, system: { role: 'system', kind: 'text', tag: 'text' }, messages: { role: 'user', kind: 'text', tag: 'user' } }
const WHY = 'WHY-q no span to cut'
let n = 0
// one request definition as the lane wire sends it (src/query/named/lane.mjs wireDef): with a ref; or ref null, the reason at the
// top and in ff, and the body inline — none for a tool an older capture kept as metadata only (2.3 逐值 metadata: no schema text)
function def(sec, ff, addressed, o = {}) {
  const k = n++, s = SECS[sec], text = `BODY-${k}-q`
  const d = { bid: `B${k}`, sec, role: s.role, kind: s.kind, head: { role: s.role, tag: s.tag, label: `L${k}` }, preview: text, chars: text.length, bytes: text.length,
    r: { as: 'text' }, ...(sec === 'tools' ? { name: `T${k}` } : null), ...o }
  if (addressed) return { ...d, ref: `S/m.ndjson#R:1::${k}-${k + 9}`, ...(ff ? { ff } : null) }
  const inline = o.inline ?? (sec === 'tools' ? (ff && ff.faithfulness === 'metadata' ? {} : { desc: text }) : sec === 'system' ? { text } : { block: { type: 'text', text } })
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
  return { desk, lanes, anchor: anchorLane(lanes), playhead, diffRef: null, navOpen: new Set(), openBlocks: new Set(), turnFold: OPEN_TURNS, turnLanded: new Set(), ctx: {},
    curFlat: [], viewPin: null, meta: {}, ...extra }
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
    if (hd.sec === 'tools') assert.equal(hd.html.includes(w(W.SECTION_SIZE_EST_TIP)), blocks.some((b) => want(b) === 'metadata'), `${why}: an estimated size iff a definition is metadata only`)
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
          if (d.sec === 'tools' && want(d) === 'metadata') assert.ok(visible(r.body).includes(w(W.TOOL_METADATA_ONLY)) && r.body.includes(d.name), `${why} row ${r.bi}: the metadata-only body`)
          else assert.ok(r.body.includes(`BODY-${d.bid.slice(1)}-q`), `${why} row ${r.bi}: the inline body`)
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
      assert.ok(!h.includes(w(W.SECTION_SIZE_EST_TIP)), `${why}: an unproven body is no metadata-only size`)
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
    const root = { querySelector: (sel) => (sel.includes('sec-messages') && sel.includes('cwsecff') && hd.cls.has('v') ? hd : null) }
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
  const WHYS = ['WHY-q one', 'WHY-q two'] // two reasons, each on several blocks
  const none = Object.keys(SECS).flatMap((sec) => FFS.map((ff) => def(sec, ff, false))).map((d, i) => ({ ...d, unaddressable: WHYS[i % 2], ff: { ...d.ff, unaddressable: WHYS[i % 2] } }))
  const mixed = [def('tools', undefined, true), def('system', undefined, false), def('messages', undefined, false)]
  const desk = deskOfSteps([none, mixed])
  const h = ctxWindowHtml(stateOf(desk, 0))
  assert.ok(h.includes('<div class="cwwin"') && visible(h).includes(w(W.WINDOW_LINE)), 'the window line')
  const line = visible(h.slice(h.indexOf('<div class="cwwin"'), h.indexOf('<div class="cwsec"')))
  for (const x of WHYS) assert.equal(count(line, esc(x)), 1, `${x}: each reason once in the line's technical details`)
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
  const s = stateOf(desk)
  steps.forEach(({ parts, row }, p) => {
    s.playhead = p
    const h = ctxWindowHtml(s), rows = rowsOf(h.slice(h.indexOf('<div class="cwreply"')), { reply: true }), why = `reply ${p} ${JSON.stringify(row)}`
    assert.equal(rows.length, parts.length, `${why}: a row per part`)
    rows.forEach((r, i) => { // a row's mark is its own part's; the reply-side fact is the call row's (2.3 §这一步的回复)
      assert.equal(count(r.attrs, 'data-ff="'), 1, `${why} part ${i}: one fidelity value`)
      assertMark(r, expect(parts[i]), `${why} part ${i} ${JSON.stringify(parts[i].ff)} ${parts[i].ref}`)
    })
    // the raw panel's one mark, by the proof rule over the parts: not stored whole → 回复没采全; a part off its span → 解析后的回复
    // (never 逐字 without the spans); every part proven → none
    const panel = serialize(rawPanelUnits(s)), marks = count(panel, 'class="rpmark"'), partial = Object.keys(row).length > 0
    assert.ok(marks <= 1, `${why}: one mark at most`)
    if (partial) assert.ok(marks === 1 && visible(panel).includes(w(W.REPLY_PARTIAL)), `${why}: reply incomplete`)
    else if (!parts.every((d) => SPAN.test(d.ref || ''))) assert.ok(marks === 1 && visible(panel).includes(w(W.REPLY_PARSED)), `${why}: parsed`)
    else if (parts.every((d) => expect(d) === 'verbatim')) assert.equal(marks, 0, `${why}: proven, no mark`)
  })
})

// ── the call fidelity row (2.3 #8 · 1.4 #9; 必拒隐瞒) ─────────────────────────────────────────────────────────────────────
const FIELDS = [['reqIncomplete', 'req', ['truncated', 'partial'], W.REQ_FACT], ['wsIncomplete', 'ws', ['partial', 'truncated', 'undecoded', 'nonVerbatim'], W.WS_FACT],
  ['respIncomplete', 'resp', ['undecoded', 'binary', 'notJson', 'empty', 'unparsed', 'truncated'], W.RESP_FACT]] // 2.3's table
// each fact of 2.3 §调用保真行 → the words the row says once, the server's own text its technical details hold, words it must not say
const FACTS = [
  { why: 'partial + contextMissing', row: { wire: { contextState: 'partial', contextMissing: 'MISSING-q' } }, words: [W.CTX_FACT.partial, 'MISSING-q'] },
  { why: 'partial, cause unknown', row: { wire: { contextState: 'partial' } }, words: [W.CTX_FACT.partialBare, W.CTX_FACT.unknownWhy] },
  // a partial context without contextMissing is said by the request's or the messages' fact, not as cause unknown
  ...[['reqIncomplete', W.REQ_FACT], ['wsIncomplete', W.WS_FACT]].map(([field, table]) => ({ why: `partial, said by ${field}`,
    row: { wire: { contextState: 'partial' }, [field]: { partial: true } }, words: [table.partial], absent: [W.CTX_FACT.partialBare, W.CTX_FACT.unknownWhy] })),
  { why: 'reconstructed', row: { wire: { contextState: 'reconstructed' } }, words: [W.CTX_FACT.reconstructed] },
  { why: 'server_edited', row: { wire: { contextState: 'server_edited' } }, words: [W.CTX_FACT.server_edited] },
  ...FIELDS.flatMap(([field, , flags, table]) => flags.map((f) => ({ why: `${field}.${f}`, row: { [field]: { [f]: true, text: `TEXT-${f}-q` } }, words: [table[f]], tech: [`TEXT-${f}-q`] }))),
  // a flag outside the closed set: 「<请求/消息/回复>没采全」, the flag's name in the technical details
  ...FIELDS.map(([field, word]) => ({ why: `${field} unknown flag`, row: { [field]: { newFlag_q: true, bodyBytes: 7 } }, words: [W.INCOMPLETE_WORD[word], W.INCOMPLETE_UNKNOWN], tech: ['newFlag_q'] })),
  { why: 'a capture label', row: { wire: { labels: [{ id: 'label-q', label: 'LABEL-q says so' }] } }, words: ['LABEL-q says so'] },
  { why: 'reqEncoding', row: { wire: { reqEncoding: 'gzip' } }, words: [W.reqEncodingFact('gzip')] },
]
const ROUTING = { id: 'capture-routing', label: 'ROUTE-q' }
const factsOf = (h) => { const m = /<div class="cwfline">[\s\S]*?<span class="cwffacts">([^<]*)<\/span>/.exec(h); return m ? m[1] : null }
// the row with its technical details: up to the window's first section
const lineOf = (h) => h.slice(h.indexOf('<div class="cwfline">'), h.indexOf('<div class="cwsec"'))
const headLit = (s) => stepBarHtml(s).includes('class="sb-fid"')

test('2.3 #8 · 1.4 #9: each call fidelity fact is said once in the row, with the step head\'s ◐; no fact (capture routing included), no row', () => {
  const cases = [...FACTS,
    { why: 'no fact', row: {} }, { why: 'complete', row: { wire: { contextState: 'complete' } } },
    // capture routing is how the call reached trocar, not a fidelity fact (2.3 §调用保真行): never the row, never ◐
    { why: 'routing only', row: { wire: { labels: [ROUTING] } } },
    { why: 'routing beside a fact', row: { wire: { contextState: 'reconstructed', labels: [ROUTING] } }, words: [W.CTX_FACT.reconstructed], absent: ['ROUTE-q'] },
    // one thing said once: a partial context naming the missing record swallows the connection's partial messages; a label the
    // reply's or the messages' flag already says is not said again
    { why: 'partial swallows ws partial', row: { wire: { contextState: 'partial', contextMissing: 'MISSING-q' }, wsIncomplete: { partial: true } }, words: [W.CTX_FACT.partial], absent: [W.WS_FACT.partial] },
    { why: '…and not the others', row: { wire: { contextState: 'partial', contextMissing: 'MISSING-q' }, wsIncomplete: { partial: true, truncated: true } }, words: [W.CTX_FACT.partial, W.WS_FACT.truncated], absent: [W.WS_FACT.partial] },
    ...[['resp-truncated', 'respIncomplete', 'truncated', W.RESP_FACT], ['resp-undecoded', 'respIncomplete', 'undecoded', W.RESP_FACT], ['ws-truncated', 'wsIncomplete', 'truncated', W.WS_FACT]]
      .map(([id, field, flag, table]) => ({ why: `${id} said by the flag`, row: { [field]: { [flag]: true }, wire: { labels: [{ id, label: 'DUP-q' }] } }, words: [table[flag]], absent: ['DUP-q'] })),
  ]
  const desk = deskOfSteps(cases.map(() => [def('system', undefined, true)]), { rows: cases.map((c) => c.row) })
  const s = stateOf(desk)
  cases.forEach(({ why, words, tech = [], absent = [] }, p) => {
    s.playhead = p
    const h = ctxWindowHtml(s), facts = factsOf(h)
    assert.equal(facts != null, !!words, `${why}: the row exists iff there is a fact`)
    assert.equal(headLit(s), !!words, `${why}: the step head's ◐ iff the row`)
    if (!words) return
    assert.ok(h.indexOf('<div class="cwfline">') < h.indexOf('<div class="cwsec"'), `${why}: at the top of the window`)
    for (const x of words) assert.equal(count(facts, w(x)), 1, `${why}: says ${JSON.stringify(x)} once`)
    for (const x of absent) assert.ok(!facts.includes(w(x)), `${why}: not ${JSON.stringify(x)}`)
    for (const t of tech) assert.ok(lineOf(h).includes(t) && !facts.includes(t), `${why}: ${t} in the technical details, not the row's words`)
  })
})

// ── the real face ───────────────────────────────────────────────────────────────────────────────────────────────────────
const deskOfFace = async (face) => {
  const id = (await face.get('sessions')).doc.sessions[0].session_id
  return deskFrom((name, p) => face.get(name, p).then((r) => r.doc), id)
}
const eachStep = (desk, fn) => { for (const lane of buildLanes(desk)) for (let p = 0; p < lane.calls.length; p++) fn(stateOf(desk, p, { anchor: lane }), lane.calls[p]) }

test('2.3 #2 (real face): every section of every demo step is proven', async () => {
  const face = await serveBoard(boardHome())
  try {
    const desk = await deskOfFace(face)
    let steps = 0
    eachStep(desk, (s, call) => {
      const st = stepOf(desk, call.rid)
      if (!st.held) return
      const h = ctxWindowHtml(s), why = `${call.rid}`
      for (const r of rowsOf(h)) assertMark(r, 'verbatim', `${why} row ${r.bi}`)
      assertHeaders(h, st.flat, why)
      assert.ok(headersOf(h).every((x) => x.claims), `${why}: every section claims`)
      steps++
    })
    assert.ok(steps > 0)
  } finally { await face.close() }
})

// the ws session's record that a later one continues (previous_response_id names its response), in file order
function continued(lines) {
  const recs = lines.map((l) => JSON.parse(l)), prevOf = (r) => { try { return JSON.parse(r.req_body).previous_response_id || null } catch { return null } }
  const named = recs.map(prevOf).find(Boolean)
  return recs.findIndex((r, i) => prevOf(r) !== named && new RegExp(`${named}\\b`).test(lines[i]))
}

test('2.3 #8 · 1.4 #9 (real face): a Codex WebSocket call whose earlier record is missing says the context is incomplete and which record', async () => {
  const userHome = tmpDir('trocar-board-'), home = path.join(userHome, '.trocar')
  const ws = bigSession({ home, wire: 'ws', growth: 300, subEvery: 3, subLanes: 1 })
  ws.append(8)
  const lines = fs.readFileSync(ws.file, 'utf8').split('\n').filter(Boolean), gone = continued(lines)
  assert.ok(gone >= 0, 'a record that a later one continues')
  fs.writeFileSync(ws.file, lines.filter((_, i) => i !== gone).map((l) => l + '\n').join(''))
  const face = await serveBoard({ userHome, home })
  try {
    const desk = await deskOfFace(face)
    let partial = 0
    eachStep(desk, (s, call) => {
      if (!(call.wire && call.wire.contextState === 'partial')) return
      partial++
      const facts = factsOf(ctxWindowHtml(s)), why = call.rid
      assert.ok(call.wire.contextMissing, `${why}: the server names the missing record`)
      assert.ok(facts && facts.includes(w(W.CTX_FACT.partial)) && facts.includes(esc(call.wire.contextMissing)), `${why}: the row says it, with contextMissing`)
      assert.ok(headLit(s), `${why}: the step head's ◐`)
    })
    assert.ok(partial > 0, 'the call after the missing record is partial')
  } finally { await face.close() }
})

// a demo record as a v0 envelope: the request stored as a parsed object, no req_body; with or without a capture field (judged
// by the fact, not the label: 2.3 §窗口行)
const v0Of = (line, keepCapture) => {
  const { req_body: body, resp, req_headers: headers, capture, ...rest } = JSON.parse(line)
  return JSON.stringify({ ...rest, ...(keepCapture ? { capture } : null), request_headers: headers, request: JSON.parse(body), response: resp })
}

test('2.3 #9 (real face): a v0 envelope draws the window line, ◐ on each header, no 以下逐字, no per-block 不能回源', async () => {
  const demo = fs.readFileSync(new URL('../../samples/demo-session.ndjson', import.meta.url), 'utf8').split('\n').filter(Boolean)
  const userHome = tmpDir('trocar-board-'), home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  writeSegment(home, '20260719T090000Z', demo.map((l, i) => v0Of(l, i % 2 === 1))) // the whole session: a later call's context runs through the earlier ones
  const face = await serveBoard({ userHome, home })
  try {
    const desk = await deskOfFace(face)
    let steps = 0
    eachStep(desk, (s, call) => {
      const st = stepOf(desk, call.rid)
      if (!st.held || !st.flat.length) return
      const h = ctxWindowHtml(s), why = call.rid
      assert.ok(h.includes('<div class="cwwin"'), `${why}: the window line`)
      for (const r of rowsOf(h)) assertMark(r, want(st.flat[r.bi]), `${why} row ${r.bi}`, { windowLine: true })
      assertHeaders(h, st.flat, why, { windowLine: true })
      for (const r of rowsOf(h.slice(h.indexOf('<div class="cwreply"')), { reply: true })) assert.notEqual(r.ff, 'verbatim', `${why}: a v0 reply is parsed`)
      // 2.6 §A v0 记录: no request key to read back, and the reply's one mark says it was parsed
      assert.deepEqual(st.detail.nonBlockKeys, [], `${why}: no non-block keys`)
      const panel = serialize(rawPanelUnits(s))
      assert.ok(visible(panel).includes(w(W.NO_PARAMS)), `${why}: the panel says there are no request keys`)
      if (st.reply.length) assert.ok(count(panel, 'class="rpmark"') === 1 && visible(panel).includes(w(W.REPLY_PARSED)), `${why}: the panel's reply is parsed`)
      steps++
    })
    assert.ok(steps > 1, 'every step of the session')
  } finally { await face.close() }
})
