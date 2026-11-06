// test/web-v2/fidelity-marks.test.mjs — the board's fidelity marks, read the way the board reads the server (2.3 #2 #8 #9 ·
// 1.4 #4 #9 · 2.6 #3). A definition is the lane wire's own (3.5 §会话读): its fidelity in `ff: {faithfulness?, unaddressable?}`,
// its bytes behind a `ref`, or `ref: null` with the reason and the body in `inline`; it enters the desk through applyLane
// (desk-world.mjs deskOf), as every definition does. The axes are generated: each `ff` value with and without a ref in each
// section, an opened body's outcomes, reply parts on and off their resp.raw span, each fact of the call fidelity row. The window
// is read as its items (window-model.mjs windowItems), the ones Window.tsx draws (its DOM mapping: Window.test.tsx 2.3 #2); the
// call drawer as detailHtml draws it. Words only as the labels module has them. The real face (real-face.mjs) for the demo sample, a
// Codex WebSocket session missing a record, and a v0 envelope.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { windowItems } from '../../web/src/screens/replay/window-model.mjs'
import { stepHeadModel } from '../../web/src/screens/replay/models.mjs'
import { detailHtml } from '../../web/legacy/replay/detail.mjs'
import { bodyCache } from '../../web/legacy/replay/blocks.mjs'
import { loadBodies, setDeskMode } from '../../web/legacy/replay/cell.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'
import { esc } from '../../web/legacy/core/fmt.mjs'
import { deskOf, deskFrom } from './desk-world.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { writeSegment } from '../query/raw-home.mjs'
import { bigSession } from '../query/big-session.mjs'

setDeskMode('raw', { storage: null }) // 以下逐字 is a claim of the Raw desk

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
// the call drawer's body for the step at the playhead (2.6 §B: the reply with its one mark)
const drawerOf = (s) => detailHtml(s, s.anchor, s.playhead).body
const deskOfSteps = (steps, { rows = steps.map(() => ({})), replies, details } = {}) => deskOf([{ kind: 'main', rows, blocks: steps, replies, details }])

const visible = (h) => h.replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, ' ')
const count = (h, word) => h.split(word).length - 1
// a word as the page carries it; a word the labels module lacks fails here, never matches vacuously
const word = (x) => { assert.ok(typeof x === 'string' && x.length > 0, `a word the labels have: ${x}`); return x }
const w = (x) => esc(word(x))
// the window as the live desk draws it: windowItems(s), each item one element of Window.tsx (its DOM mapping: Window.test.tsx 2.3 #2)
const itemsOf = (s) => windowItems(s).items
// the request rows {ff, badge, sr, bi}; the reply rows in order (a reply row draws its badge unless it is proven, and the
// proven word for a screen reader then)
const rowsOf = (items) => items.filter((x) => x.type === 'row').map((x) => ({ ff: x.marks.ff, badge: x.marks.badge, sr: x.marks.sr, bi: x.bi }))
const replyRowsOf = (items) => ((items.find((x) => x.type === 'reply') || {}).rows || []).map((r) => ({ ff: r.mark, badge: r.mark !== 'verbatim', sr: r.mark === 'verbatim' ? r.sr : null }))
const headersOf = (items) => items.filter((x) => x.type === 'sec').map((x) => ({ sec: x.sec, claims: x.claim === 'verbatim', half: x.claim === 'half', est: x.est }))
const winOf = (items) => items.find((x) => x.type === 'win') || null

// one row's mark against the code it must carry: a proven row has no visible mark and tells a screen reader 逐字; any other row
// has its one visible mark (2.3 §保真标). Under the window line 不能回源 is not repeated, the screen-reader word is.
function assertMark(row, code, why, { windowLine = false } = {}) {
  assert.equal(row.ff, code, `${why}: data-ff`)
  const quiet = code === 'verbatim' || (windowLine && code === 'unaddressable')
  assert.equal(row.badge, !quiet, `${why}: a visible mark iff not proven`)
  if (quiet) assert.equal(row.sr, code, `${why}: the screen-reader word`)
  else assert.notEqual(row.sr, 'verbatim', `${why}: never 逐字 to a screen reader`)
}
// every section header against its blocks: 以下逐字 iff each of its blocks is proven; under the window line just ◐
function assertHeaders(items, flat, why, { windowLine = false } = {}) {
  const hs = headersOf(items)
  assert.ok(hs.length > 0, `${why}: section headers`)
  for (const hd of hs) {
    const blocks = flat.filter((b) => b.sec === hd.sec)
    assert.equal(hd.claims, !windowLine && blocks.every((b) => want(b) === 'verbatim'), `${why}: ${hd.sec} claims 以下逐字 iff every block is proven`)
    assert.equal(hd.half, windowLine, `${why}: ${hd.sec} carries ◐ iff the window line`)
    if (hd.sec === 'tools') assert.equal(hd.est, blocks.some((b) => want(b) === 'metadata'), `${why}: an estimated size iff a definition is metadata only`)
  }
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
      const items = itemsOf(s), flat = steps[p], rows = rowsOf(items), why = `${opened ? 'open' : 'closed'} step ${p} ${JSON.stringify(cases[p] ? { sec: cases[p].sec, ff: cases[p].ff, ref: !!cases[p].ref } : 'all proven')}`
      assert.equal(winOf(items), null, `${why}: some block has a ref, so no window line`)
      assert.equal(rows.length, flat.length, `${why}: every row drawn`)
      for (const r of rows) assertMark(r, want(flat[r.bi]), `${why} row ${r.bi}`)
      assertHeaders(items, flat, why)
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
      const items = itemsOf(s), why = `${name} in ${sec}`
      for (const r of rowsOf(items)) assertMark(r, flat[r.bi] === target ? o.code : 'verbatim', `${why} row ${r.bi}`)
      for (const hd of headersOf(items)) assert.equal(hd.claims, hd.sec !== sec || o.code === 'verbatim', `${why}: the ${hd.sec} header`)
      assert.equal(count(factsOf(items) || '', word(W.reqEncodingFact('gzip'))), o.row ? 1 : 0, `${why}: the call row says the decoding once, not the block`)
      assert.ok(headersOf(items).every((hd) => !hd.est), `${why}: an unproven body is no metadata-only size`)
    }
  }
  bodyCache.clear()
})

test('2.3 #2: a new trace\'s opened tool definition is proven; an old trace\'s is metadata only', async () => {
  bodyCache.clear()
  const schema = JSON.stringify({ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path_q: { type: 'string' } }, required: ['file_path_q'] } })
  const fresh = def('tools', {}, true), oldRef = def('tools', { faithfulness: 'metadata' }, true), oldInline = def('tools', { faithfulness: 'metadata' }, false, { inline: {} })
  const flat = [fresh, oldRef, oldInline, def('system', undefined, true), def('messages', undefined, true)]
  const desk = deskOfSteps([flat]), s = stateOf(desk)
  for (const b of [fresh, oldRef, oldInline]) s.openBlocks.add(`${b.bid}#0`)
  await loadBodies(blockApi((ref) => OK(ref, ref === fresh.ref ? schema : '{"name":"Read","input_schema_props":["file_path_q"],"description_chars":11}')), [fresh.ref, oldRef.ref])
  const items = itemsOf(s), rows = rowsOf(items) // the opened bodies: Cell.test.tsx 2.3 #1 (the bytes) · 2.3 #40 (metadata only)
  assertMark(rows[0], 'verbatim', 'new trace')
  for (const r of rows.slice(1, 3)) assertMark(r, 'metadata', `old trace row ${r.bi}`)
  assert.ok(!headersOf(items).find((x) => x.sec === 'tools').claims, 'the tools section is not 逐字')
  bodyCache.clear()
})

test('2.3 #9: no block with a ref draws the window line, ◐ on each header, 不能回源 not repeated; one ref draws none', () => {
  const WHYS = ['WHY-q one', 'WHY-q two'] // two reasons, each on several blocks
  const none = Object.keys(SECS).flatMap((sec) => FFS.map((ff) => def(sec, ff, false))).map((d, i) => ({ ...d, unaddressable: WHYS[i % 2], ff: { ...d.ff, unaddressable: WHYS[i % 2] } }))
  const mixed = [def('tools', undefined, true), def('system', undefined, false), def('messages', undefined, false)]
  const desk = deskOfSteps([none, mixed])
  const items = itemsOf(stateOf(desk, 0)), line = winOf(items)
  assert.ok(line, 'the window line')
  for (const x of WHYS) assert.equal(line.reasons.filter((r) => r === x).length, 1, `${x}: each reason once in the line's technical details`)
  for (const r of rowsOf(items)) assertMark(r, want(none[r.bi]), `row ${r.bi}`, { windowLine: true })
  assertHeaders(items, none, 'window line', { windowLine: true })
  const m = itemsOf(stateOf(desk, 1))
  assert.equal(winOf(m), null, 'a step with one addressed block has no window line')
  for (const r of rowsOf(m)) assertMark(r, want(mixed[r.bi]), `mixed row ${r.bi}`)
})

// ── this step's reply (2.3 §这一步的回复 · 2.6 #3) ─────────────────────────────────────────────────────────────────────
test('2.3 #2 · 2.6 #3: a reply part is proven only on its own span (resp.raw or resp.messages.<j>), else parsed; the drawer\'s one mark never says 逐字 without the spans', () => {
  const SPAN = /::resp\.(raw|messages\.\d+)::\d+-\d+$/
  const part = (where, ff) => {
    const k = n++, d = { bid: `P${k}`, kind: 'text', head: { role: 'assistant', tag: 'say', label: 'say' }, preview: `say ${k}`, chars: 4, bytes: 4, r: { as: 'text' }, ...(ff ? { ff } : null) }
    if (where === 'span') return { ...d, ref: `S/m.ndjson#R:1::resp.raw::${k}-${k + 4}` }
    if (where === 'ws') return { ...d, ref: `S/m.ndjson#R:1::resp.messages.${k % 3}::${k}-${k + 4}` }
    if (where === 'req') return { ...d, ref: `S/m.ndjson#R:1::${k}-${k + 4}` }
    return { ...d, ref: null, unaddressable: WHY, ff: { ...ff, unaddressable: WHY }, inline: { block: { type: 'text', text: `say ${k}` } } }
  }
  const expect = (d) => {
    const v = d.ff && d.ff.faithfulness
    if (v != null && v !== 'verbatim') return KNOWN.includes(v) ? v : 'unknown'
    return SPAN.test(d.ref || '') ? 'verbatim' : 'parsed'
  }
  const replies = ['span', 'ws', 'req', 'none'].map((where) => FFS.map((ff) => part(where, ff)))
  for (const where of ['span', 'ws']) replies.push(FFS.slice(0, 3).map((ff) => part(where, ff))) // a reply whose every part is on its span
  // each reply with no reply-side fact, and with each that says the reply was not stored whole (2.6 §A 「◐ 回复没采全」)
  const facts = [{}, { respIncomplete: { truncated: true } }, ...['resp-truncated', 'resp-undecoded'].map((id) => ({ wire: { labels: [{ id, label: 'RESP-LABEL-q' }] } }))]
  const steps = replies.flatMap((parts) => facts.map((row) => ({ parts, row })))
  const desk = deskOfSteps(steps.map(() => [def('system', undefined, true)]), { rows: steps.map((x) => x.row), replies: steps.map((x) => x.parts), details: steps.map(() => ({ norm: { stop_reason: 'end' } })) })
  const s = stateOf(desk)
  steps.forEach(({ parts, row }, p) => {
    s.playhead = p
    const rows = replyRowsOf(itemsOf(s)), why = `reply ${p} ${JSON.stringify(row)}`
    assert.equal(rows.length, parts.length, `${why}: a row per part`)
    rows.forEach((r, i) => { // a row's mark is its own part's; the reply-side fact is the call row's (2.3 §这一步的回复)
      assertMark(r, expect(parts[i]), `${why} part ${i} ${JSON.stringify(parts[i].ff)} ${parts[i].ref}`)
    })
    // the call drawer's one mark (replyOf over the parts): not stored whole → 回复没采全; a part off its span → 解析后的回复
    // (never 逐字 without the spans); every part proven → none
    const panel = drawerOf(s), marks = count(panel, 'class="rpmark"'), partial = Object.keys(row).length > 0
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
const fidOf = (items) => items.find((x) => x.type === 'fid') || null
// the row's words as Window.tsx joins them; its technical details
const factsOf = (items) => { const f = fidOf(items); return f ? f.facts.join(' · ') : null }
const techOf = (items) => JSON.stringify((fidOf(items) || {}).tech ?? null)
const headLit = (s) => !!stepHeadModel({ ...s, playRid: s.anchor.calls[s.playhead].rid }).half // the step head's ◐ (StepHead.tsx draws .sb-fid iff half)

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
    const items = itemsOf(s), facts = factsOf(items)
    assert.equal(facts != null, !!words, `${why}: the row exists iff there is a fact`)
    assert.equal(headLit(s), !!words, `${why}: the step head's ◐ iff the row`)
    if (!words) return
    assert.equal(items[0].type, 'fid', `${why}: at the top of the window`)
    for (const x of words) assert.equal(count(facts, word(x)), 1, `${why}: says ${JSON.stringify(x)} once`)
    for (const x of absent) assert.ok(!facts.includes(word(x)), `${why}: not ${JSON.stringify(x)}`)
    for (const t of tech) assert.ok(techOf(items).includes(t) && !facts.includes(t), `${why}: ${t} in the technical details, not the row's words`)
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
      const items = itemsOf(s), why = `${call.rid}`
      for (const r of rowsOf(items)) assertMark(r, 'verbatim', `${why} row ${r.bi}`)
      assertHeaders(items, st.flat, why)
      assert.ok(headersOf(items).every((x) => x.claims), `${why}: every section claims`)
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
      const facts = factsOf(itemsOf(s)), why = call.rid
      assert.ok(call.wire.contextMissing, `${why}: the server names the missing record`)
      assert.ok(facts && facts.includes(word(W.CTX_FACT.partial)) && facts.includes(call.wire.contextMissing), `${why}: the row says it, with contextMissing`)
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
      const items = itemsOf(s), why = call.rid
      assert.ok(winOf(items), `${why}: the window line`)
      for (const r of rowsOf(items)) assertMark(r, want(st.flat[r.bi]), `${why} row ${r.bi}`, { windowLine: true })
      assertHeaders(items, st.flat, why, { windowLine: true })
      for (const r of replyRowsOf(items)) assert.notEqual(r.ff, 'verbatim', `${why}: a v0 reply is parsed`)
      // 2.6 §A v0 记录: no request key to read back, and the reply's one mark says it was parsed
      assert.deepEqual(st.detail.nonBlockKeys, [], `${why}: no non-block keys`)
      const panel = drawerOf(s)
      if (st.reply.length) assert.ok(count(panel, 'class="rpmark"') === 1 && visible(panel).includes(w(W.REPLY_PARSED)), `${why}: the drawer's reply is parsed`)
      steps++
    })
    assert.ok(steps > 1, 'every step of the session')
  } finally { await face.close() }
})
