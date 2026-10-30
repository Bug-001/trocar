// test/web-v2/rawpanel.test.mjs — the raw panel (2.6 §A): the reply's fields passed through (text, tool calls with their
// arguments as JSON, stop reason), the display clip of a long reply, the resolvable params as data-nbk rows, the wire facts
// and ids inside the collapsed tech block, the capture's effect on the client, and the pin reset. String level over
// constructed calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderRawPanel, renderResourceView, wireRawPanel } from '../../src/web/v2/replay/rawpanel.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { normResp } from '../../src/view/analyze.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const el = () => ({ _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null })
const stateOf = (call, extra = {}) => ({ anchor: { kind: 'main', calls: [call], giLocal: new Map([[0, 0]]) }, lanes: [], playhead: 0, curFlat: call.flat || [], viewPin: null, meta: { project_path: '/w' }, ctx: {}, ...extra })
const draw = (call, extra) => { const e = el(); renderRawPanel(e, stateOf(call, extra)); return e.innerHTML }
const base = (o = {}) => ({ gi: 0, ts: ts(0), ctx: 10, usage: { read: 1, create: 1, fresh: 1, out: 1 }, rec: { request: { model: 'm1' }, id: 'rec-1' }, norm: {}, flat: [], wire: {}, ...o })
const techAt = (h) => h.indexOf('id="rptech-b"') // the collapsed tech block's body begins here

test('the reply passes its text, tool name and stop reason through', () => {
  const h = draw(base({ norm: { text: 'reply text here', stop_reason: 'end_turn', tools: [{ id: 't1', name: 'run', input: { a: 1 } }] }, respRefs: [{ label: 'body', ref: 'r1', chars: 12 }] }))
  assert.match(h, /reply text here/)
  assert.match(h, /\brun\b/)
  assert.match(h, /end_turn/) // the provider's own value, untranslated
})

test('a tool call renders its arguments as JSON, verbatim; the id rides in the tech block, not the row', () => {
  const h = draw(base({ norm: { tools: [{ id: 'toolu_01', name: 'run_checks', input: { a: 1, b: 'x' } }] }, respRefs: [{ label: 'body', ref: 'r1', chars: 5 }] }))
  const row = h.split('class="rpk').find((r) => r.includes('run_checks'))
  assert.ok(row, 'the tool row exists')
  assert.match(row, /<pre class="rawpre">\{\n  &quot;a&quot;: 1,\n  &quot;b&quot;: &quot;x&quot;\n\}<\/pre>/)
  assert.ok(!/toolu_01/.test(row), 'the tool id is not in the visible row')
  assert.ok(!/nbk/.test(row), 'no dead click surface on the tool row: the server\'s norm.tools never carries a ref')
  assert.ok(h.slice(techAt(h)).includes('toolu_01'))
})

test('a reply over the display cap shows the 20 000-char prefix and the full length', () => {
  const h = draw(base({ norm: { text: 'x'.repeat(25000) }, respRefs: [{ label: 'body', ref: 'r1', chars: 1 }] }))
  assert.match(h, /<pre class="rawpre">x{20000}<\/pre>/)
  assert.match(h, /\b25000\b/)
})

test('a resolvable request key is a data-nbk row carrying its ref and key name', () => {
  const h = draw(base({ nonBlockKeys: [{ key: 'temperature', chars: 4, ref: 'r2' }, { key: 'metadata', chars: 20, ref: null }] }))
  assert.match(h, /data-nbk="r2"[^>]*>temperature/)
})

test('format, vendor and the call id sit inside the collapsed tech block, not in the visible body', () => {
  const h = draw(base({ wire: { format: 'anthropic', vendor: 'vnd-x', transport: 'http' } }))
  const open = techAt(h)
  assert.ok(open > -1, 'the tech disclosure exists')
  assert.ok(h.indexOf('anthropic') > open && h.indexOf('vnd-x') > open && h.indexOf('rec-1') > open)
  assert.ok(!/anthropic|vnd-x/.test(h.slice(0, open)), 'not in the always-visible panel body')
})

test('the capture\'s effect on the client shows its description and its ids (D37)', () => {
  const h = draw(base({ wire: { transport: 'http', observerEffect: [{ id: 'gzip-off', cause: 'cert-installed', what: 'request body not compressed' }] } }))
  assert.match(h, /request body not compressed/)
  assert.match(h, /gzip-off[\s\S]*cert-installed/)
})

test('a failed call passes its error through; no anchor call draws nothing', () => {
  assert.match(draw(base({ error: 'overloaded', respRefs: [{ label: 'body', ref: 'r1', chars: 3 }] })), /overloaded/)
  assert.equal(draw(base(), { anchor: { kind: 'main', calls: [], giLocal: new Map() } }), '')
})

test('an unparsed step whose response did parse still renders the reply; errMsg rides in the tech block only', () => {
  const h = draw(base({ unparsed: true, error: true, errMsg: 'unparse: req_body is not JSON', norm: { text: 'reply body parsed' }, nonBlockKeys: [] }))
  assert.match(h, /reply body parsed/)
  assert.ok(h.includes('unparse: req_body is not JSON'))
  assert.ok(!/unparse/.test(h.slice(0, h.indexOf('id="rptech"'))), 'and it is not in the visible rows')
})

test('the #rpx click through wireRawPanel clears the pin', () => {
  const pin = { resKey: 'file::/w/a.mjs', label: '/w/a.mjs' }
  const flat = [{ sec: 'messages', kind: 'tool_result', resKey: 'file::/w/a.mjs', text_ref: 'r9', chars: 5 }]
  let handler = null
  const e = { _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null, addEventListener: (t, f) => { handler = f } }
  const s = stateOf(base({ flat }), { viewPin: pin, curFlat: flat })
  renderResourceView(e, s)
  wireRawPanel(e, s)
  handler({ target: { closest: (sel) => (sel === '#rpx' ? {} : null) } })
  assert.equal(s.viewPin, null)
})

test('the reply row states its character count once (one fact, one place — 1.4)', () => {
  for (const transport of ['http', 'ws']) {
    const h = draw(base({ norm: { text: 'r' }, wire: { transport }, respRefs: [{ label: 'body', ref: 'r1', chars: 937 }] }))
    const row = h.split('class="rpk').find((r) => r.includes('data-nbk="r1"'))
    assert.ok(row, `${transport}: the raw reply row exists`)
    assert.equal(row.match(/\b937\b/g).length, 1, `${transport}: the count appears once`)
  }
})

// 2.6 §A / :236: the reply's tool calls come from the server's own answer (a real face over the demo session, whose replies
// carry tool_use blocks), never a hand-made shape — so the server and the board cannot disagree on the field's name
test('a real server answer: every in-page step\'s reply tool names render in the panel', async () => {
  const face = await serveBoard(boardHome())
  try {
    const id = (await face.get('sessions')).doc.sessions[0].session_id
    const doc = (await face.get('session', { id })).doc
    const anchor = anchorLane(buildLanes(doc.analyzed, doc.probes))
    let seen = 0
    anchor.calls.forEach((c, i) => {
      if (c.paged_out || !c.rec) return
      const e = el(); renderRawPanel(e, { ...stateOf(c), anchor, playhead: i })
      for (const t of c.norm.tools) { assert.ok(e.innerHTML.includes(t.name), `step ${i + 1}: ${t.name}`); seen++ }
    })
    assert.ok(seen > 0, 'the answer carries reply tool calls')
  } finally { await face.close() }
})

test('the reply\'s thinking renders (the server normalizer\'s own output for a reply with a thinking block)', () => {
  const norm = normResp({ resp: { status: 200, kind: 'json', body: { content: [{ type: 'thinking', thinking: 'weighing the options' }, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} } } })
  const h = draw(base({ norm }))
  assert.match(h, /weighing the options/); assert.match(h, /done/)
})
