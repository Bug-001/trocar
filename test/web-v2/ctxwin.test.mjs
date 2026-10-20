// test/web-v2/ctxwin.test.mjs — one fact, one place on a cache-break step (1.4 §一件事只说一处): the break's cause is said on the
// step head's verdict and on the change line in the window, nowhere else in the middle column or the raw panel; the step's content
// bytes are stated once. Real blocks from the real face's demo session; only the step's cacheBreak is set to a content change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { boardHome, serveBoard } from './real-face.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { ctxWindowHtml } from '../../src/web/v2/replay/ctxwin.mjs'
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
