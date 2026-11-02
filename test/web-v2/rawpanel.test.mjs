// test/web-v2/rawpanel.test.mjs — the raw panel (2.6 §A) over the desk: the reply's parts as cells (text, tool calls, thinking),
// the stop reason, the unheld step's busy rows, the resolvable params as data-nbk rows, the wire facts
// and ids inside the collapsed tech block, the capture's effect on the client, and the pin reset. String level over
// constructed calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderRawPanel, renderResourceView, wireRawPanel } from '../../web/legacy/replay/rawpanel.mjs'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import { deskOf, deskFrom } from './desk-world.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'
import { esc, kf } from '../../web/legacy/core/fmt.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const el = () => ({ _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null })
const stateOf = (desk, extra = {}) => { const lanes = buildLanes(desk); return { desk, lanes, anchor: anchorLane(lanes), playhead: 0, curFlat: [], viewPin: null, meta: { project_path: '/w' }, ctx: {}, ...extra } }
// one main step: its skeleton row, its reply definitions and its lane detail; `held:false` leaves the lane not held
const deskWith = ({ row = {}, reply = [], detail = {}, held = true } = {}) => deskOf([{ kind: 'main', rows: [{ rec: { request: { model: 'm1' }, id: 'rec-1' }, wire: {}, ...row }],
  blocks: held ? [[{ sec: 'system', role: 'system', kind: 'text', ref: 's/x#1::0-5', head: { role: 'system', tag: 'text', label: 's' } }]] : undefined,
  replies: [reply], details: [{ norm: { stop_reason: null }, respRefs: [], nonBlockKeys: [], extraMessages: [], ...detail }] }])
const draw = (o, extra) => { const e = el(); renderRawPanel(e, stateOf(deskWith(o), extra)); return e.innerHTML }
const rp = (kind, o = {}) => ({ kind, head: { role: 'assistant', tag: kind, label: kind }, preview: `preview-${kind}`, chars: 9, ref: `s/x#1::resp.raw::0-9`, ...o })
const techAt = (h) => h.indexOf('id="rptech-b"') // the collapsed tech block's body begins here

test('the reply passes its parts, the tool name and the stop reason through, each part a cell', () => {
  const h = draw({ reply: [rp('text'), rp('tool_use', { name: 'run_checks' })], detail: { norm: { stop_reason: 'end_turn' } } })
  assert.match(h, /preview-text/)
  assert.match(h, /\brun_checks\b/)
  assert.match(h, /end_turn/) // the provider's own value, untranslated
  assert.equal((h.match(/class="rpbody" data-rpb=/g) || []).length, 2, 'one cell slot per part')
  assert.ok(!/class="rawpre"/.test(h), 'no stringified reply path')
})

test('a thinking part renders as its own row with a cell', () => {
  const h = draw({ reply: [rp('thinking'), rp('text')] })
  assert.match(h, /class="rpk rpthink"[\s\S]*?data-rpb=/)
})

test('a resolvable request key is a data-nbk row carrying its ref and key name, in the list form and the object form', () => {
  for (const nonBlockKeys of [[{ key: 'temperature', chars: 4, ref: 'r2' }, { key: 'metadata', chars: 20, ref: null }], { temperature: 'r2' }]) {
    assert.match(draw({ detail: { nonBlockKeys } }), /data-nbk="r2"[^>]*>temperature/)
  }
})

test('format, vendor and the call id sit inside the collapsed tech block, not in the visible body', () => {
  const h = draw({ row: { wire: { format: 'anthropic', vendor: 'vnd-x', transport: 'http' } } })
  const open = techAt(h)
  assert.ok(open > -1, 'the tech disclosure exists')
  assert.ok(h.indexOf('anthropic') > open && h.indexOf('vnd-x') > open && h.indexOf('rec-1') > open)
  assert.ok(!/anthropic|vnd-x/.test(h.slice(0, open)), 'not in the always-visible panel body')
})

test('the capture\'s effect on the client shows its description and its ids (D37)', () => {
  const h = draw({ detail: { wire: { transport: 'http', observerEffect: [{ id: 'gzip-off', cause: 'cert-installed', what: 'request body not compressed' }] } } })
  assert.match(h, /request body not compressed/)
  assert.match(h, /gzip-off[\s\S]*cert-installed/)
})

test('no anchor call draws nothing; no request says so', () => {
  const e = el(); renderRawPanel(e, { ...stateOf(deskWith()), anchor: { kind: 'main', calls: [] } }); assert.equal(e.innerHTML, '')
  assert.ok(draw({ row: { rec: null } }).includes('class="rpempty"'))
})

test('an unparsed step whose reply parsed still renders the reply; errMsg rides in the tech block only', () => {
  const h = draw({ row: { unparsed: true, error: true, errMsg: 'unparse: req_body is not JSON' }, reply: [rp('text')] })
  assert.match(h, /preview-text/)
  assert.ok(h.includes('unparse: req_body is not JSON'))
  assert.ok(!/unparse/.test(h.slice(0, h.indexOf('id="rptech"'))), 'and it is not in the visible rows')
})

test('2.6 §A: a step whose lane is not held draws the model and sized busy rows — no reply / params sentence, no control', () => {
  const h = draw({ held: false, row: { error: 'boom' } })
  assert.match(h, /aria-busy="true"/)
  for (const w of [W.NO_PARAMS, W.FAILED_NO_REPLY]) assert.ok(!h.includes(w))
  assert.ok(!/<button|data-load-step|role="button"/.test(h))
})

test('the #rpx click through wireRawPanel clears the pin', () => {
  const pin = { resKey: 'file::/w/a.mjs', label: '/w/a.mjs' }
  const flat = [{ sec: 'messages', kind: 'tool_result', resKey: 'file::/w/a.mjs', text_ref: 'r9', chars: 5 }]
  let handler = null
  const e = { _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null, addEventListener: (t, f) => { handler = f } }
  const s = stateOf(deskWith(), { viewPin: pin, curFlat: flat })
  renderResourceView(e, s)
  wireRawPanel(e, s)
  handler({ target: { closest: (sel) => (sel === '#rpx' ? {} : null) } })
  assert.equal(s.viewPin, null)
})

test('the raw reply row states its character count once (one fact, one place — 1.4)', () => {
  for (const transport of ['http', 'ws']) {
    const h = draw({ row: { wire: { transport } }, detail: { respRefs: [{ label: 'body', ref: 'r1', chars: 937 }] } })
    const row = h.split('class="rpk').find((r) => r.includes('data-nbk="r1"'))
    assert.ok(row, `${transport}: the raw reply row exists`)
    assert.equal(row.match(/\b937\b/g).length, 1, `${transport}: the count appears once`)
  }
  assert.match(draw({ detail: { respRefs: ['s/x#1::resp.raw::0-9'] } }), /data-nbk="s\/x#1::resp\.raw::0-9"/, 'a bare locator is its ref')
})

// 2.6 §A: the reply's parts come from the server's own lane answer (the demo session), never a hand-made shape
test('a real server answer: every held step\'s reply tool names render in the panel', async () => {
  const face = await serveBoard(boardHome())
  try {
    const id = (await face.get('sessions')).doc.sessions[0].session_id
    const desk = await deskFrom((n, p) => face.get(n, p).then((r) => r.doc), id)
    const s = stateOf(desk)
    let seen = 0
    s.anchor.calls.forEach((c, i) => {
      const st = stepOf(desk, c.rid)
      if (!st.held || !c.rec) return
      const e = el(); renderRawPanel(e, { ...s, playhead: i })
      for (const d of st.reply) if (d.kind === 'tool_use') { assert.ok(e.innerHTML.includes(d.name), `step ${i + 1}: ${d.name}`); seen++ }
    })
    assert.ok(seen > 0, 'the answer carries reply tool calls')
  } finally { await face.close() }
})

test('capture routing rides the raw panel\'s tech details (2.3 §调用保真行 → 2.6 §A)', () => {
  const h = draw({ row: { wire: { transport: 'http', labels: [{ id: 'capture-routing', label: 'route', text: 'ROUTE-TEXT-x' }] } } })
  const open = techAt(h)
  assert.ok(open > -1 && h.indexOf('ROUTE-TEXT-x') > open)
})

// 2.6 §A params row: a key the server shipped a `value` for shows it as is; a key without one keeps its length
test('a request key shows the value the server shipped; without one, its length', () => {
  const CH = 517
  const cases = [['s', 'v'.repeat(5)], ['empty', ''], ['num', 0.731], ['zero', 0], ['bool', false], ['obj', { a: 1 }], ['absent', undefined]]
  for (const [key, value] of cases) {
    const k = { key, chars: CH, ref: 'r9' }
    if (value !== undefined) k.value = value
    const h = draw({ detail: { nonBlockKeys: [k] } })
    const row = h.slice(h.indexOf(`>${key}</code>`), h.indexOf('class="nbkbody"'))
    const shown = ['string', 'number', 'boolean'].includes(typeof value)
    assert.equal(row.includes('>' + String(value) + '<'), shown, `${key}: value shown`)
    assert.equal(row.includes(String(CH)), !shown, `${key}: length shown`)
  }
})

// 2.6 §A: a failed call's raw reason is a tech detail; the visible reply line carries no server text
test('a failed call\'s reason appears only inside the reply\'s tech details', () => {
  const reason = 'ERR-zq81-upstream-boom'
  for (const o of [{ error: reason }, { error: { message: reason } }, { status: 503, error: true, errMsg: reason }]) {
    const h = draw({ row: o })
    assert.ok(h.includes(reason), 'the reason is kept')
    for (let i = h.indexOf(reason); i > -1; i = h.indexOf(reason, i + 1)) {
      const d = h.lastIndexOf('<div class="disc"', i)
      assert.ok(d > -1 && !h.slice(d, i).includes('</div></div>'), 'occurrence outside a disclosure')
    }
  }
})

// 2.4 §能力的分档: a pinned capability's tier is the 2.3 proof rule over its wire definitions (`ff.faithfulness` · `ref`); each row is
// what the definition carries (name · chars)
test('a pinned capability: the tier by the proof rule over wire-shaped tool definitions, each row its name and characters', () => {
  const tool = (name, o) => ({ sec: 'tools', role: 'system', kind: 'text', name, resKey: 'mcp::X', head: { role: 'system', tag: 'def', label: name }, preview: name, chars: 1234, bytes: 1300, ...o })
  const span = (n) => ({ ref: `s/x#1::${n}-${n + 9}`, ff: { faithfulness: 'verbatim' } })
  const inline = { ref: null, unaddressable: 'inline', ff: { unaddressable: 'inline' }, inline: { desc: 'd' } }
  for (const [defs, tier] of [
    [[tool('T1', span(0)), tool('T2', span(20))], W.CAP_VERBATIM],
    [[tool('T1', { ref: 's/x#1::0-9', ff: { faithfulness: 'metadata' } }), tool('T2', { ref: null, ff: { faithfulness: 'metadata' } })], W.CAP_METADATA],
    [[tool('T1', span(0)), tool('T2', inline)], W.CAP_MIXED],
  ]) {
    const desk = deskOf([{ kind: 'main', rows: [{ rec: { request: { model: 'm1' }, id: 'rec-1' } }], blocks: [defs] }])
    const e = el(), s = stateOf(desk, { viewPin: { resKey: 'mcp::X', label: 'X' } })
    s.curFlat = stepOf(desk, s.anchor.calls[0].rid).flat
    renderResourceView(e, s)
    assert.ok(e.innerHTML.includes(esc(tier)), tier)
    for (const t of defs) assert.ok(e.innerHTML.includes(esc(W.capToolRow(t.name, kf(t.chars)))), t.name)
  }
})
