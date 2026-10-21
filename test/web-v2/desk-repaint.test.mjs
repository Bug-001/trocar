// test/web-v2/desk-repaint.test.mjs — the replay desk repaints the playhead's panels only when what they draw changed (spec 1.4
// D64: each panel has its own render signature, an unchanged one is not repainted), the URL's step is clamped and written back
// (1.2 §路由), and an unknown session links back to the list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { playheadSig, notListedHtml, stepParam } from '../../src/web/v2/replay/replay.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { deskOf } from './desk-world.mjs'

const blk = (k) => ({ sec: 'messages', role: 'user', kind: 'text', key: 'k' + k, ref: 'r' + k, chars: 4 })
function deskWith({ held = true, reply = 'hi', usage = 80, subRows = 1 } = {}) {
  const main = { kind: 'main', rows: [{}, {}, { usage: { input: 10, output: usage } }] }
  if (held) Object.assign(main, { blocks: [[blk(0)], [blk(0), blk(1)], [blk(0), blk(1), blk(2)]], replies: [[], [], [{ kind: 'text', preview: reply }]] })
  return deskOf([main, { kind: 'subagent', rows: Array.from({ length: subRows }, () => ({})) }])
}
function state(desk, over = {}) {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead: 2, diffRef: null, openBlocks: new Set(), navOpen: new Set(['sys']),
    viewPin: null, pricing: null, pricingErr: null, ...over }
}

test('playheadSig: equal for two answers of the same step; it moves with what the playhead panels draw', () => {
  const a = state(deskWith())
  assert.equal(playheadSig(state(deskWith())), playheadSig(a), 'the same step answered twice')
  const changes = {
    'the reply changes': state(deskWith({ reply: 'hi there' })),
    'its row changes': state(deskWith({ usage: 90 })),
    'its lane is not held': state(deskWith({ held: false })),
    'the compare step changes': state(deskWith(), { diffRef: 0 }),
    'a block opens': state(deskWith(), { openBlocks: new Set(['x#0']) }),
    'the playhead moves': state(deskWith(), { playhead: 1 }),
  }
  for (const [what, b] of Object.entries(changes)) assert.notEqual(playheadSig(b), playheadSig(a), what)
  assert.notEqual(playheadSig(a, 'busy'), playheadSig(a, 'rows'), 'the frame (2.3 §车道未到手) is part of what is drawn')
  assert.equal(playheadSig(state(deskWith({ subRows: 3 }))), playheadSig(a), 'a sub-agent lane gaining calls does not repaint the window')
})

test('A16 (1.2:91 · I-url-replay-4/-6): the step parameter clamps to 1..M and says when the URL must be written back', () => {
  const M = 7
  const raws = ['abc', '-3', '0', '1', '4', '7', '8', '999', '2.5', ' 3', '1e1', 'NaN', '-0']
  for (let n = -4; n <= M + 4; n++) raws.push(String(n))
  for (const raw of raws) {
    const { step, rewrite } = stepParam(raw, M), n = Number(raw)
    assert.ok(Number.isInteger(step) && step >= 1 && step <= M, `${raw} → ${step}`)
    const valid = /^[1-9]\d*$/.test(raw) && n <= M
    assert.equal(rewrite, !valid, `${raw}: rewrite`)
    if (valid) assert.equal(step, n, raw)
    if (Number.isFinite(n) && n > M) assert.equal(step, M, raw)
    if (!Number.isFinite(n) || n < 1) assert.equal(step, 1, raw)
  }
  // the lane's count not known yet: only the lower end clamps
  assert.deepEqual(stepParam('999', 0), { step: 999, rewrite: false })
  assert.deepEqual(stepParam('-3', 0), { step: 1, rewrite: true })
})

test('notListedHtml: a real link back to the session list', () => {
  const tags = notListedHtml().match(/<a\b[^>]*>/g) || []
  const hrefs = tags.map((t) => (t.match(/\shref\s*=\s*"([^"]*)"/) || [])[1])
  assert.ok(hrefs.includes('#/sessions'), JSON.stringify(tags))
})
