// test/web-v2/ctxwin.test.mjs — one fact, one place on a cache-break step (1.4 §一件事只说一处): the break's cause is said on the
// step head's verdict and on the change line in the window, nowhere else in the middle column or the raw panel; the step's content
// bytes are stated once. Real blocks from the real face's demo session; only the step's cacheBreak is set to a content change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { boardHome, serveBoard } from './real-face.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { ctxWindowHtml, landingTarget, callFidelityHtml } from '../../src/web/v2/replay/ctxwin.mjs'
import { renderRawPanel } from '../../src/web/v2/replay/rawpanel.mjs'
import { outlineHtml } from '../../src/web/v2/replay/outline.mjs'
import { bytes } from '../../src/web/v2/core/fmt.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'

const face = await serveBoard(boardHome())
const id = (await face.get('sessions')).doc.sessions[0].session_id
const doc = (await face.get('session', { id })).doc
await face.close()

const CAUSE = 'content-changed'
// the desk on the last step, turned into a break at its first message block
function breakDesk() {
  const lanes = buildLanes(doc.analyzed, doc.probes)
  const anchor = anchorLane(lanes)
  const playhead = anchor.calls.length - 1
  const call = anchor.calls[playhead]
  const idx = call.flat.findIndex((b) => b.sec === 'messages')
  call.cacheBreak = { ...call.cacheBreak, idx, firstCall: false, cause: CAUSE, attribution: 'harmful' }
  call.usage = { read: 0, create: 1200, fresh: 40, out: 30 }
  const s = { meta: doc.meta, lanes, anchor, playhead, pricing: null, pricingErr: null, diffRef: null, curFlat: [], curRemoved: [],
    navOpen: new Set(['sys', 'tools', 'msg']), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), viewPin: null, ctx: {} }
  const raw = { innerHTML: '', querySelector: () => null }
  const parts = { stepbar: stepBarHtml(s), ctxwin: ctxWindowHtml(s) }
  renderRawPanel(raw, s)
  parts.rawpanel = raw.innerHTML
  parts.outline = outlineHtml(s)
  return { parts, call }
}
const count = (h, needle) => h.split(needle).length - 1

test('a cache break is told on the step head\'s verdict and the window\'s change line only', () => {
  const { parts } = breakDesk()
  const causeW = W.causeWord(CAUSE)
  assert.ok(causeW, 'the cause has its words')
  const all = Object.values(parts).join('')
  assert.equal(count(all, causeW), 2, 'the cause is said twice on the whole desk column + raw panel')
  const verdict = parts.stepbar.match(/<div class="pp-sentence">([\s\S]*?)<\/div>/)
  assert.ok(verdict && verdict[1].includes(causeW), 'once in the step head\'s verdict')
  const line = parts.ctxwin.match(/<div class="chline"[\s\S]*?<\/div>/)
  assert.ok(line && line[0].includes(causeW), 'once on the change line')
  assert.equal(count(parts.rawpanel + parts.outline, causeW), 0, 'not in the raw panel or the outline')
})

test('the step\'s content bytes are stated once (the wire byte count is not on a session step)', () => {
  const { parts, call } = breakDesk()
  const secs = new Set(call.flat.map((b) => b.sec))
  assert.ok(secs.size > 1, 'the real step spans more than one section, so no section size equals the total')
  const total = bytes(call.flat.reduce((a, b) => a + (typeof b.bytes === 'number' ? b.bytes : 0), 0))
  assert.equal(count(Object.values(parts).join(''), total), 1, `the content total ${total} is written once`)
})

test('the outline holds no count the middle column shows, and the compare control carries one label', () => {
  const { parts } = breakDesk()
  assert.ok(parts.outline.includes('data-navtoggle="tools"'), 'the outline is drawn')
  assert.ok(!/class="navct"/.test(parts.outline), 'no count on the outline\'s group heads (R7)')
  const cmp = parts.stepbar.match(/<button[^>]*aria-haspopup="menu"[^>]*>/)
  assert.ok(cmp, 'the compare menu button is drawn')
  assert.ok(!/aria-label=/.test(cmp[0]), 'its visible text is its only label (R10)')
})

// 2.3 §这一步的回复 · 1.4 whitelist ⑨: the window ends with this step's reply as its own segment after the request sections —
// the server's own norm (text, tools), marked by the 2.3 proof rule — and the stand-in states draw no reply segment
const deskAt = (i, over = {}) => {
  const lanes = buildLanes(doc.analyzed, doc.probes)
  const anchor = anchorLane(lanes)
  Object.assign(anchor.calls[i], over)
  return { s: { meta: doc.meta, lanes, anchor, playhead: i, diffRef: null, curFlat: [], curRemoved: [], navOpen: new Set(), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), viewPin: null, ctx: {} }, call: anchor.calls[i] }
}
const replySeg = (h) => { const k = h.lastIndexOf('<div class="cwreply">'); return k < 0 ? null : h.slice(k) }

test('the window ends with the step\'s reply segment: after every section, carrying the server\'s text and tool calls', () => {
  const n = anchorLane(buildLanes(doc.analyzed, doc.probes)).calls.length
  let tools = 0
  for (let i = 0; i < n; i++) {
    const { s, call } = deskAt(i)
    if (call.paged_out || !call.rec || call.unparsed) continue
    const h = ctxWindowHtml(s)
    const seg = replySeg(h)
    assert.ok(seg, `step ${i + 1} has a reply segment`)
    assert.ok(h.lastIndexOf('class="cwsec"') < h.lastIndexOf('<div class="cwreply">'), 'after the request sections')
    assert.ok(!/class="cblk/.test(seg), 'no block card inside the reply segment')
    for (const t of call.norm.tools || []) { assert.ok(seg.includes(t.name), t.name); tools++ }
    if (call.norm.text) assert.ok(seg.includes(call.norm.text.slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')))
  }
  assert.ok(tools > 0, 'the real answer has replies with tool calls')
})

test('the reply segment\'s mark follows the proof rule: a resolvable respRef → no mark; none → ◐ parsed reply; never "verbatim"', () => {
  const i = anchorLane(buildLanes(doc.analyzed, doc.probes)).calls.findIndex((c) => !c.paged_out && c.rec && !c.unparsed)
  for (const [respRefs, marked] of [[[{ label: 'body', ref: 'r:1', chars: 3 }], false], [[], true], [[{ label: 'body', ref: null, why: 'x' }], true]]) {
    const seg = replySeg(ctxWindowHtml(deskAt(i, { respRefs }).s))
    assert.equal(seg.includes(W.REPLY_PARSED), marked, JSON.stringify(respRefs))
    assert.ok(!seg.includes(W.SECTION_VERBATIM) && !/data-ff="verbatim"/.test(seg))
  }
})

test('stand-in states (not on this page, unparsed, no request) draw no reply segment', () => {
  for (const over of [{ paged_out: true }, { unparsed: true, errMsg: 'x' }, { rec: null }]) assert.equal(replySeg(ctxWindowHtml(deskAt(0, over).s)), null, JSON.stringify(Object.keys(over)))
})

// 2.3 §未下发态: the load control says whether a read for this step is out (busy, not clickable) or answered without it (missed,
// clickable again) — told by attributes, so the words stay the labels' business
test('a paged-out step\'s load control: busy while its read is out, missed after an answer without it, plain otherwise', () => {
  const i = anchorLane(buildLanes(doc.analyzed, doc.probes)).calls.findIndex((c) => c.rec && !c.unparsed)
  const tagOf = (s) => (ctxWindowHtml(s).match(/<button[^>]*id="loadpage"[^>]*>/) || [null])[0]
  for (const [extra, busy, missed] of [[(gi) => ({ pageLoading: gi }), true, false], [(gi) => ({ pageMissed: gi }), false, true], [() => ({}), false, false]]) {
    const { s, call } = deskAt(i, { paged_out: true })
    Object.assign(s, extra(call.gi))
    const tag = tagOf(s)
    assert.ok(tag, 'the load button is drawn')
    assert.equal(/\sdisabled(\s|>|=)/.test(tag), busy, tag)
    assert.equal(/aria-busy="true"/.test(tag), busy, tag)
    assert.equal(/data-state="missed"/.test(ctxWindowHtml(s)), missed, tag)
  }
})

// 1.4 §打开一步时落在哪: a step 跟随最新 brought in lands on ⑨ (the reply); a reader's own move keeps the change line
test('landing: a step reached by following lands on the reply; a reader\'s move lands on the change line', () => {
  const lanes = buildLanes(doc.analyzed, doc.probes)
  const anchor = anchorLane(lanes)
  const playhead = anchor.calls.length - 1
  const call = anchor.calls[playhead]
  call.cacheBreak = { ...call.cacheBreak, idx: call.flat.findIndex((b) => b.sec === 'messages'), firstCall: false, cause: CAUSE, attribution: 'harmful' }
  const s = { meta: doc.meta, lanes, anchor, playhead, diffRef: null, curFlat: [], curRemoved: [], navOpen: new Set(), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), viewPin: null, ctx: {} }
  assert.ok(replySeg(ctxWindowHtml(s)), 'the reply is drawn on this step')
  assert.deepEqual(landingTarget({ ...s, followLanding: true }), { reply: true })
  assert.equal(landingTarget({ ...s, followLanding: false }).anchor, 'cachebrk')
})

// 2.3 §调用保真行 · 2.2 ◐: capture-routing is how the call got here, not a fidelity fact — never in the row, never lights ◐
test('capture routing never makes the fidelity row or the step head\'s ◐; the other facts still do', () => {
  const ROUTE = { id: 'capture-routing', label: 'ROUTE-LABEL-x', text: 'ROUTE-TEXT-x' }
  const TRUNC = { id: 'resp-truncated', label: 'TRUNC-LABEL-x', text: 't' }
  const i = anchorLane(buildLanes(doc.analyzed, doc.probes)).calls.findIndex((c) => !c.paged_out && c.rec && !c.unparsed)
  for (const routing of [true, false]) {
    for (const [extra, ctxState, hasFact] of [[[], 'complete', false], [[], 'reconstructed', true], [[TRUNC], 'complete', true]]) {
      const base = deskAt(i).call
      const labels = [...(routing ? [ROUTE] : []), ...extra]
      const { s, call } = deskAt(i, { wire: { ...base.wire, labels, contextState: ctxState, reqEncoding: undefined }, reqIncomplete: null, wsIncomplete: null, respIncomplete: null })
      const row = callFidelityHtml(call)
      assert.equal(row !== '', hasFact, `routing=${routing} ${ctxState} ${extra.map((l) => l.id)}`)
      assert.ok(!row.includes(ROUTE.label) && !row.includes(ROUTE.text), 'the routing label is not in the row')
      assert.equal(stepBarHtml(s).includes('class="sb-fid"'), row !== '', '◐ iff the row has words')
    }
  }
})
