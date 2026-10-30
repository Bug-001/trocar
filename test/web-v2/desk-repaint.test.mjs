// test/web-v2/desk-repaint.test.mjs — the replay desk repaints the playhead's panels only when what they draw changed (spec 1.4
// D64: each panel has its own render signature, an unchanged one is not repainted), and an unknown session links back to the list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { playheadSig, notListedHtml } from '../../src/web/v2/replay/replay.mjs'

const call = (gi, over = {}) => ({ gi, id: 'r' + gi, ts: new Date(gi * 1000).toISOString(), paged_out: false,
  flat: [{ sec: 'system' }, { sec: 'messages' }], norm: { text: 'reply ' + gi, stop_reason: 'end_turn', tools: [] }, ...over })
function desk() {
  const main = { id: 'main', kind: 'main', calls: [call(0), call(1), call(2)] }
  const sub = { id: 'sub-1', kind: 'sub', calls: [call(3)] }
  return { lanes: [main, sub], anchor: main, playhead: 2, diffRef: null, openBlocks: new Set(), navOpen: new Set(['sys']),
    viewPin: null, pricing: null, pricingErr: null, pageLoading: null, pageMissed: null }
}
// the anchor stays the object inside lanes after a clone (two answers of the same step)
const clone = (s) => { const c = structuredClone(s); c.anchor = c.lanes[0]; return c }

test('playheadSig: equal for two answers of the same step; it moves with what the playhead panels draw', () => {
  const a = desk()
  assert.equal(playheadSig(clone(a)), playheadSig(clone(a)), 'the same step answered twice')
  const changes = {
    'paged_out flips': (s) => { s.anchor.calls[2].paged_out = true },
    'the reply grows': (s) => { s.anchor.calls[2].norm.text += ' more' },
    'the compare step changes': (s) => { s.diffRef = 0 },
    'a block opens': (s) => { s.openBlocks.add('messages:1') },
    'the playhead moves': (s) => { s.playhead = 1 },
  }
  for (const [what, f] of Object.entries(changes)) { const b = clone(a); f(b); assert.notEqual(playheadSig(b), playheadSig(a), what) }
  const g = clone(a); g.lanes[1].calls.push(call(4), call(5))
  assert.equal(playheadSig(g), playheadSig(a), 'a sub-agent lane gaining calls does not repaint the window')
})

test('notListedHtml: a real link back to the session list', () => {
  const tags = notListedHtml().match(/<a\b[^>]*>/g) || []
  const hrefs = tags.map((t) => (t.match(/\shref\s*=\s*"([^"]*)"/) || [])[1])
  assert.ok(hrefs.includes('#/sessions'), JSON.stringify(tags))
})
