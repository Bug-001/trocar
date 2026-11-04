import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markCompaction, compactionVerdict, compactionBaseline, hasCompactionPreamble } from '../../src/identity/session-identity.mjs'
import { query, homeWith } from '../helpers/session-doc.mjs'
import { laneOf, fateOf, lanes, failLanes, sent, landedOf, LANDS_WITHIN, READ, SID } from '../helpers/compaction-lane.mjs'

test('markCompaction: a sharp message-count drop flags compaction with from/to', () => {
  assert.deepEqual(markCompaction(42, 6), { compaction: true, compaction_from: 42, compaction_to: 6 })
  assert.deepEqual(markCompaction(55, 4), { compaction: true, compaction_from: 55, compaction_to: 4 }, 'the real CC compaction')
})

test('markCompaction: growth (normal turn) is NOT compaction', () => {
  assert.deepEqual(markCompaction(6, 8), { compaction: false, compaction_from: null, compaction_to: null })
})

test('markCompaction: equal count (retry, same length) is NOT compaction', () => {
  assert.deepEqual(markCompaction(10, 10), { compaction: false, compaction_from: null, compaction_to: null })
})

test('compactionVerdict: hint first, a marker on its rising edge only, else the drop; no predecessor → from NULL', () => {
  const v = (prev, cur) => { const { compaction, compaction_from, compaction_to, basis } = compactionVerdict(prev, cur); return [compaction, compaction_from, compaction_to, basis] }
  assert.deepEqual(v(null, { hint: true, msgCount: 3 }), [true, null, 3, 'hint'], 'a hint on a lane\'s first call: compaction, from unknown')
  assert.deepEqual(v({ msgCount: 3, marker: false }, { hint: true, msgCount: 5 }), [true, 3, 5, 'hint'], 'a hint needs no drop')
  assert.deepEqual(v(null, { marker: true, msgCount: 4 }), [false, null, null, null], 'no predecessor, no rising edge')
  assert.deepEqual(v({ msgCount: 4, marker: false }, { marker: true, msgCount: 5 }), [true, 4, 5, 'marker'])
  assert.deepEqual(v({ msgCount: 5, marker: true }, { marker: true, msgCount: 6 }), [false, null, null, null], 'the marker stays in the history')
  assert.deepEqual(v({ msgCount: 9, marker: false }, { msgCount: 2 }), [true, 9, 2, 'msg-count-drop'], 'a sharp drop')
  assert.deepEqual(v({ msgCount: 9, marker: false }, { msgCount: 8 }), [false, null, null, null], 'a small one is no evidence')
  assert.deepEqual(v(null, { msgCount: 2 }), [false, null, null, null])
})

// 3.4 「骤降」: without a harness marker or request only a SHARP drop counts — at least 6 fewer AND
// under 70% of the lane's count — one rule for the ETL and the board. On a real CC session the main lane goes 58 → 55
// (not a compaction) before the real 55 → 4.
test('markCompaction: a small drop is not a compaction, a sharp one is; the edges of "sharp"', () => {
  const is = (from, to, cur) => markCompaction(from, to, cur).compaction
  assert.equal(is(58, 55), false, 'the real CC 58 → 55')
  assert.equal(is(55, 4), true, 'the real CC 55 → 4')
  assert.equal(is(10, 5), false, 'exactly 5 fewer is not enough')
  assert.equal(is(10, 4), true, '6 fewer and under 70%')
  assert.equal(is(100, 71), false, '29 fewer but 71% is not under 70%')
  assert.equal(is(100, 69), true)
  assert.equal(is(3, 2), false, 'a drop of one is never sharp')
  assert.deepEqual(markCompaction(58, 55), { compaction: false, compaction_from: null, compaction_to: null }, 'no evidence: from / to stay NULL')
})

// Review (3.4): the stated rule is "only a sharp drop"; CC's preamble is a refinement on top
// of it, and the preamble stays in the first messages of EVERY later call of a compacted lane. Counted on every call it
// carries, any one-message dip after a compaction (30 → 27 on a lane that already holds 30) would be a compaction too. So
// it counts on its rising edge only, like the text marker: the call that brings it in, not the calls that carry it.
test('compactionVerdict: CC\'s preamble lets a small drop count on its rising edge only; carried in the history it is no evidence', () => {
  const v = (prev, cur) => { const { compaction, compaction_from, compaction_to, basis } = compactionVerdict(prev, cur); return [compaction, compaction_from, compaction_to, basis] }
  const none = [false, null, null, null]
  assert.deepEqual(v({ msgCount: 58, marker: false, preamble: false }, { msgCount: 55, preamble: true }), [true, 58, 55, 'msg-count-drop'], 'the call that brings the preamble in: a small drop counts')
  assert.deepEqual(v({ msgCount: 58, marker: false }, { msgCount: 55, preamble: true }), [true, 58, 55, 'msg-count-drop'], 'a predecessor that says nothing about a preamble had none')
  assert.deepEqual(v({ msgCount: 30, marker: false, preamble: true }, { msgCount: 27, preamble: true }), none, 'carried: 30 → 27 long after a compaction is no compaction')
  assert.deepEqual(v({ msgCount: 8, marker: false, preamble: true }, { msgCount: 7, preamble: true }), none, 'carried: a single message fewer')
  assert.deepEqual(v({ msgCount: 8, marker: false, preamble: true }, { msgCount: 6 }), none, 'a drop that takes the preamble away is no evidence either')
  assert.deepEqual(v({ msgCount: 30, marker: false, preamble: true }, { msgCount: 4, preamble: true }), [true, 30, 4, 'msg-count-drop'], 'a second compaction is a sharp drop and needs no preamble')
  assert.deepEqual(v({ msgCount: 30, marker: false, preamble: true }, { hint: true, msgCount: 27, preamble: true }), [true, 30, 27, 'hint'], 'a harness hint is judged first, whatever the preamble does')
})

test('markCompaction: any drop that carries CC\'s own preamble counts; growth never does', () => {
  assert.equal(markCompaction(8, 6, { preamble: true }).compaction, true)
  assert.equal(markCompaction(8, 6, { preamble: false }).compaction, false)
  assert.equal(markCompaction(6, 6, { preamble: true }).compaction, false, 'a preamble with no drop is not a compaction')
  assert.equal(markCompaction(6, 8, { preamble: true }).compaction, false)
})

test('hasCompactionPreamble: CC\'s "continued from a previous conversation" in the first four messages, text or blocks', () => {
  const P = 'This session is being continued from a previous conversation that ran out of context.'
  assert.equal(hasCompactionPreamble([{ role: 'user', content: P }]), true)
  assert.equal(hasCompactionPreamble([{ role: 'user', content: [{ type: 'text', text: 'x' }] }, { role: 'assistant', content: [{ type: 'text', text: P }] }]), true)
  assert.equal(hasCompactionPreamble([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }, { role: 'user', content: 'd' }, { role: 'user', content: P }]), false, 'only the first four')
  assert.equal(hasCompactionPreamble([{ role: 'user', content: [{ type: 'tool_result', content: P }] }]), false, 'a block that is not text')
  assert.equal(hasCompactionPreamble(undefined), false)
  assert.equal(hasCompactionPreamble([null, {}]), false)
})

test('compactionVerdict is one rule: the same prev and cur give the same answer for the ETL and the board (no second drop rule to pass)', () => {
  const prev = { msgCount: 58, marker: false }
  assert.equal(compactionVerdict.length, 2, 'two parameters: prev, cur — the drop rule is not injectable')
  assert.equal(compactionVerdict(prev, { msgCount: 55 }).compaction, false, 'a small drop alone is not enough')
  assert.equal(compactionVerdict(prev, { msgCount: 55, preamble: true }).compaction, true, 'unless CC says it continued a conversation')
  assert.deepEqual(compactionVerdict({ msgCount: 55, marker: false }, { msgCount: 4 }), { compaction: true, compaction_from: 55, compaction_to: 4, basis: 'msg-count-drop' })
  assert.equal(compactionVerdict(prev, { hint: true, msgCount: 60 }).basis, 'hint', 'a hint never consults the drop rule')
  assert.equal(compactionVerdict({ msgCount: 4, marker: false }, { marker: true, msgCount: 5 }).basis, 'marker', 'a marker on its rising edge needs no drop')
})

// 3.4 「一次压缩只算一次」: the evidence each predecessor leaves a call, and what it becomes after a harness's own request.
test('compactionVerdict: right after a marked request the evidence lands the same compaction; a hint stays a compaction; from / to as ever', () => {
  const PREV = { none: null, plain: { msgCount: 20, marker: false }, hinted: { msgCount: 20, marker: false, hinted: true }, marker: { msgCount: 20, marker: true } }
  const CUR = { hint: { hint: true, msgCount: 22 }, rising: { marker: true, msgCount: 21 }, drop: { msgCount: 3 }, small: { msgCount: 18, preamble: true }, nothing: { msgCount: 21 } }
  const seen = { hint: 'hint', rising: 'marker', drop: 'msg-count-drop', small: 'msg-count-drop', nothing: null }
  for (const [p, prev] of Object.entries(PREV)) for (const [c, cur] of Object.entries(CUR)) {
    const fired = c === 'hint' ? 'hint' : p === 'none' || (p === 'marker' && c === 'rising') ? null : seen[c]
    const lands = p === 'hinted' && fired != null && fired !== 'hint'
    const v = compactionVerdict(prev, cur), why = `${p} → ${c}`
    assert.equal(v.basis, fired, why)
    assert.equal(v.compaction, fired != null && !lands, why)
    assert.equal(!!v.lands, lands, why)
    assert.equal(v.compaction_from, fired != null && prev ? prev.msgCount : null, why)
    assert.equal(v.compaction_to, fired != null ? cur.msgCount : null, why)
  }
})

for (const wire of ['anthropic', 'flat']) {
  test(`${wire}: one compaction is counted once over generated lanes; the landing step rewrites the context and counts nothing`, async () => {
    for (const steps of lanes(wire)) {
      const records = laneOf(wire, steps), home = homeWith(records), fate = fateOf(steps), why = steps.join(' ')
      const doc = await query(home, 'session', { id: SID })
      assert.equal(doc.calls.length, steps.length, why)
      const lane = await query(home, 'lane', { id: SID, lane: doc.calls[0].lane })
      assert.equal(doc.stats.compactions, doc.calls.filter((r) => r.compaction).length, why)
      const landed = Object.fromEntries(lane.events.filter((e) => e.type === 'compaction-landed').map((e) => [doc.calls.findIndex((r) => r.rid === e.rid), { from: e.from, to: e.to }]))
      assert.deepEqual(landed, landedOf(steps, records), why)
      const compacted = new Set(lane.events.filter((e) => e.type === 'compaction').map((e) => e.rid))
      doc.calls.forEach((r, i) => {
        const at = `${why} @${i}`
        assert.equal(!!r.compaction, fate[i] === 'marked' || fate[i] === 'inferred', at)
        assert.equal(!!r.compactionInferred, fate[i] === 'inferred', at)
        assert.equal(compacted.has(r.rid), !!r.compaction, at)
        assert.ok(!('lands' in r), at)
        if (fate[i] === 'lands') assert.equal(r.cacheBreak.cause, 'compaction', at)
      })
      if (wire !== 'anthropic') continue
      // each context rewrite ends the segments open before it: a landing as a counted compaction does
      const rewrites = doc.calls.filter((r, i) => fate[i] === 'inferred' || fate[i] === 'marked' || fate[i] === 'lands').map((r) => r.rid)
      const file = lane.resources.find((r) => r.label === READ)
      assert.ok(file, why)
      for (const s of file.segments) if (s.evict != null) assert.ok(rewrites.includes(s.evict), `${why}: evicted at ${s.evict}`)
      const lands = doc.calls.filter((r, i) => fate[i] === 'lands').map((r) => r.rid)
      assert.ok(lands.every((rid) => file.segments.some((s) => s.evict === rid)), why)
    }
  })

  // 3.4 「失败的 call」: a failed call says nothing and changes nothing, so a failed request and its retry are one compaction and all failing none
  test(`${wire}: failed calls give no verdict over failed requests, retries and the calls between`, async () => {
    for (const steps of failLanes()) {
      const home = homeWith(laneOf(wire, steps)), fate = fateOf(steps), why = steps.join(' ')
      const doc = await query(home, 'session', { id: SID })
      const head = JSON.parse(JSON.stringify(await query(home, 'session', { id: SID, head: true })))
      assert.equal(doc.stats.compactions, fate.filter((x) => x === 'marked' || x === 'inferred').length, why)
      assert.deepEqual(doc.calls.map((r) => !!r.compaction), fate.map((x) => x === 'marked' || x === 'inferred'), why)
      assert.ok(head.chapters.every((c) => c.s1 - c.s0 > 1), `${why}: a chapter of one step`)
      if (wire !== 'anthropic') continue
      const rewrites = new Set(doc.calls.filter((r, i) => fate[i] != null).map((r) => r.rid))
      const { resources } = await query(home, 'lane', { id: SID, lane: doc.calls[0].lane })
      for (const s of resources.find((r) => r.label === READ).segments) if (s.evict != null) assert.ok(rewrites.has(s.evict), `${why}: evicted at ${s.evict}`)
    }
  })
}

// 3.4 「一次压缩只算一次」, 「失败的 call」: the verdict and the baseline it leaves, walked along the same lists; the two together are what both readers run.
const walk = (wire, steps) => {
  let prev = null
  return laneOf(wire, steps).map((rec, i) => {
    const op = steps[i], cur = { hint: op.endsWith('mark'), failed: op.startsWith('fail'), msgCount: sent(rec) }
    const v = compactionVerdict(prev, cur)
    prev = compactionBaseline(prev, cur, v)
    return v
  })
}
const fateIn = (v) => (v.lands ? 'lands' : !v.compaction ? null : v.basis === 'hint' ? 'marked' : 'inferred')

test('compactionVerdict + compactionBaseline: a failed call changes nothing, and the fates of the lanes follow 3.4', () => {
  for (const steps of [...failLanes(), ...failLanes().map((s) => ['failmark', 'faildrop', ...s.slice(2)])])
    assert.deepEqual(walk('flat', steps).map(fateIn), fateOf(steps), steps.join(' '))
  const failed = { failed: true, msgCount: 3, hint: true, marker: true }
  for (const prev of [null, { msgCount: 40, marker: false, preamble: false, hinted: 2 }]) {
    const v = compactionVerdict(prev, failed)
    assert.deepEqual([v.compaction, !!v.lands, v.compaction_from, v.compaction_to, v.basis], [false, false, null, null, null])
    assert.equal(compactionBaseline(prev, failed, v), prev)
  }
})

test('compactionVerdict + compactionBaseline: three calls between a request and the drop still land it, four leave an inferred compaction of its own', () => {
  for (let between = 0; between <= LANDS_WITHIN + 2; between++) {
    const steps = ['grow', 'grow', 'mark', ...Array(between).fill('grow'), 'drop', 'grow']
    const v = walk('flat', steps)[3 + between]
    assert.equal(!!v.lands, between < LANDS_WITHIN, `${between} between`)
    assert.equal(v.compaction, between >= LANDS_WITHIN, `${between} between`)
  }
})
