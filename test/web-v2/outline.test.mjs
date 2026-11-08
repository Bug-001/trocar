// test/web-v2/outline.test.mjs — the step's entry table the Overview reads (outlineEntries, 2.5) and the jumps: the jump-source
// identity (an entry's jump ↔ the window's data-bi), the lane-wait jump queue and the resource-block landing. The Overview's rows
// themselves are guarded by overview-model.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { outlineEntries, jumpToResourceBlock } from '../../web/legacy/replay/outline.mjs'
import { messageTurns } from '../../web/legacy/replay/analysis.mjs'
import { windowItems } from '../../web/src/screens/replay/window-model.mjs'
import { turnIsOpen } from '../../web/legacy/replay/fold.mjs'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf, createDesk, applySession } from '../../web/legacy/replay/model.mjs'
import { createJumpQueue, anchorJump, blockJump } from '../../web/legacy/replay/jump.mjs'
import { deskOf, world, readLane } from './desk-world.mjs'

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const blk = (o) => ({ sec: 'messages', kind: 'text', role: 'user', bytes: 10, chars: 10, key: 'k' + Math.random(), head: { role: 'user', tag: 'user', label: 'x' }, ...o })
const sys = (o) => ({ sec: 'system', kind: 'system', role: 'system', chars: 1200, key: 's' + Math.random(), label: '环境', head: { role: 'system', tag: 'def', label: '' }, ...o })
const tool = (o) => ({ sec: 'tools', kind: 'def', role: '', name: 'read_file', key: 't' + Math.random(), head: { role: '', tag: 'def', label: '' }, ...o })
// a renderer state over a desk: `lanes` as deskOf takes them, the playhead on the anchor lane's step `playhead`
const deskState = (lanes, { events, playhead = 0, ...extra } = {}) => {
  const desk = deskOf(lanes, { events })
  const ls = buildLanes(desk), anchor = anchorLane(ls)
  return { desk, lanes: ls, anchor, playhead, navOpen: new Set(['tools', 'sys', 'msg']), ...extra }
}
const stateOf = (flat, extra = {}) => deskState([{ kind: 'main', rows: [{}], blocks: [flat] }], extra)

// ── the fold memory (2.5 验收 #2: the window's reveal into a folded turn writes it — Window.test.tsx 2.3 #28) ───────────
test('an explicit fold beats the automatic landing\'s ephemeral set', () => {
  const flat = [sys({ key: 's' }), blk({ query: '第一问', key: 'a1' }), blk({ role: 'assistant', kind: 'text', key: 'a2' }), blk({ query: '第二问', key: 'b1' })]
  const t0 = messageTurns(flat)[0]
  assert.equal(turnIsOpen(new Map([['a1', false]]), flat, t0, 0, 1, new Set(['a1'])), false, 'an explicit fold beats the ephemeral landed set')
})

test('outlineEntries is the one table any narrow-screen dropdown would draw from', () => {
  const flat = [tool(), blk({ query: 'q' })]
  const e = outlineEntries(stateOf(flat))
  assert.deepEqual(e.groups.map((g) => g.key), ['tools', 'sys', 'msg'])
  assert.deepEqual(e.groups[0].kids.map((k) => k.label), ['read_file'])
})

// ── the jump-source identity (2.5 验收 #2: 点条必落对块 — every entry jump ⊆ the window's data-bi) ─────────────────────────
test('jump-source identity: every entry\'s jump names a row the window draws (.cblk[data-bi])', () => {
  const flat = [tool(), tool({ name: 'grep' }), sys(), blk({ query: '第一问' }), blk({ role: 'assistant', kind: 'text', query: null })]
  const s = stateOf(flat, { openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), diffRef: null })
  const inWindow = new Set(windowItems(s).items.filter((it) => it.type === 'row').map((it) => it.bi)) // the rows Window.tsx draws as .cblk[data-bi]
  const jumps = outlineEntries(s).groups.flatMap((g) => g.kids || []).map((k) => k.jump)
  assert.ok(jumps.length, 'the fixture yields jump rows')
  for (const j of jumps) assert.ok(inWindow.has(j), `jump ${j} must be a .cblk[data-bi] the window drew`)
})

// ── 2.5 #2 (lane-wait half): a jump to a step whose lane is not held waits for the lane, runs once, and a reader move drops it
test('jump waits for the target lane: not held → wait; held → run once; a reader move in between → dropped', async () => {
  for (const seed of [3, 11, 29]) {
    const w = world(seed), get = w.get(), desk = createDesk()
    applySession(desk, await get('session', { id: 'S' })) // the skeleton only: no lane held
    const [key, rids] = [...desk.laneRids].find(([, r]) => r.length > 1)
    let playhead = rids.at(-1)
    const done = []
    const q = createJumpQueue({ getPlayhead: () => playhead, getCall: () => desk.rows.get(playhead), getHeld: () => stepOf(desk, playhead).held, perform: (j) => done.push(j) })
    q.queue(playhead, anchorJump('cachebrk'))
    assert.equal(done.length, 0, 'the lane is not held: the jump waits')
    assert.ok(q.pending(), 'and is kept')
    await readLane(get, 'S', desk, { lane: key })
    q.settle(); q.settle()
    assert.deepEqual(done, [{ kind: 'anchor', id: 'cachebrk' }], 'held: it runs exactly once')
    // a reader move before the next lane lands drops the waiting jump
    const other = [...desk.laneRids.keys()].find((k) => k !== key)
    if (!other) continue
    playhead = desk.laneRids.get(other).at(-1)
    q.queue(playhead, anchorJump('cachebrk'))
    playhead = rids[0] // the reader moved
    await readLane(get, 'S', desk, { lane: other })
    q.settle()
    assert.equal(done.length, 1, 'dropped: the playhead left its step')
    assert.equal(q.pending(), null)
  }
})

test('jump: a block jump its own step can never land is reported; one the reader moved away from is not', () => {
  for (const [call, dropped] of [[{ unparsed: true, rec: true }, 1], [{ rec: false }, 1], [null, 1]]) {
    let playhead = 2, heard = 0
    const q = createJumpQueue({ getPlayhead: () => playhead, getCall: () => call, getHeld: () => false, perform: () => assert.fail('nothing to run'), dropped: () => { heard++ } })
    q.queue(2, blockJump('r'))
    assert.equal(heard, dropped)
    q.queue(3, blockJump('r'))
    assert.equal(heard, dropped, 'the playhead left its step')
    playhead = 3
  }
})

// ── 2.5: an entry table is read for a named step, the playhead stays where it is
test('outlineEntries(s, at) reads step `at`, the same table as with the playhead on it', async () => {
  for (const seed of [3, 11]) {
    const w = world(seed), get = w.get(), desk = createDesk()
    applySession(desk, await get('session', { id: 'S' }))
    const [key, rids] = [...desk.laneRids].find(([, r]) => r.length > 1)
    await readLane(get, 'S', desk, { lane: key })
    const calls = rids.map((rid) => desk.rows.get(rid)), anchor = { id: key, kind: 'main', calls, ridLocal: new Map(rids.map((r, i) => [r, i])) }
    const s = (playhead) => ({ desk, anchor, playhead, lanes: [anchor] })
    for (const at of [0, rids.length - 1]) assert.deepEqual(outlineEntries(s(rids.length - 1 - at), at), outlineEntries(s(at)), `seed ${seed} step ${at}`)
  }
})

test('2.4 #13: a block reading several files is the landing for any of its resKeys', () => {
  const keys = ['file::/a', 'file::/b', 'file::/c']
  const curFlat = [{ resKey: 'file::/z' }, { resKey: keys[0], resKeys: keys }]
  for (const k of keys) {
    const hits = []
    jumpToResourceBlock({ curFlat, reveal: (t) => hits.push(t.fi) }, k)
    assert.deepEqual(hits, [1], k)
  }
})
