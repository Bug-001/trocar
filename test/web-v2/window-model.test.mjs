// test/web-v2/window-model.test.mjs — the window model (2.3 §读与画「长对话的窗口」 · 1.4 ①–⑨): item order, turns and keys, the
// section claim, the landing, a body's arrival. Expected values come from the list, the head or the fold store; inputs are desks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import { setDeskMode, loadBodies } from '../../web/legacy/replay/cell.mjs'
import { windowItems, landed, landingFor } from '../../web/src/screens/replay/window-model.mjs'
import { refPending } from '../../web/legacy/replay/analysis.mjs'
import { deskOf, world, deskFrom } from './desk-world.mjs'

let rn = 0
const blk = (o = {}) => ({ sec: 'messages', role: 'user', kind: 'text', head: { role: 'user', tag: 'user', label: 'b' }, preview: 'p', chars: 5, bytes: 5, ref: `s/m#R::${rn++}-9`, ...o })
const say = (o) => blk({ role: 'assistant', head: { role: 'assistant', tag: 'say', label: 'a' }, ...o })
const sys = (o) => blk({ sec: 'system', role: 'system', head: { role: 'system', tag: 'text', label: 's' }, ...o })
const tool = (o) => blk({ sec: 'tools', role: 'system', head: { role: 'system', tag: 'def', label: 't' }, ...o })
const rp = (kind, o = {}) => ({ kind, head: { role: 'assistant', tag: kind, label: kind }, preview: kind, chars: 4, bytes: 4, ref: `s/m#R::resp.raw::${rn++}-9`, ...o })
const stateOf = (desk, playhead = 0, extra = {}) => {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead, diffRef: null, navOpen: new Set(['cwremoved']), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), ctx: {}, ...extra }
}
const desk1 = (blocks, rows = blocks.map(() => ({})), extra = {}) => deskOf([{ kind: 'main', rows: rows.map((r) => ({ rec: { request: { model: 'm' } }, ...r })), blocks: extra.held === false ? undefined : blocks, replies: extra.replies }])
const flatOf = (s) => stepOf(s.desk, s.anchor.calls[s.playhead].rid).flat
const ALL_OPEN = { has: () => true, get: () => true } // a fold memory that holds every turn open
// every step of the generated desks, as a state at its playhead
async function* generated() {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const desk = await deskFrom(world(seed).get(), 'S')
    for (const lane of buildLanes(desk)) for (let p = 0; p < lane.calls.length; p++) yield stateOf(desk, p, { anchor: lane })
  }
}

// 1.4 ①–⑨ by item type; ⑥–⑧ stand in for ③④⑨
const SLOT = { fid: 1, win: 2, sec: 3, foldall: 3, row: 3, card: 3, chline: 3, removed: 3, unparsed: 6, noreq: 7, frames: 8, reply: 9 }
function whitelist(items, why) {
  const slots = items.map((it) => { assert.ok(SLOT[it.type], `${why}: ${it.type} is not in the whitelist`); return SLOT[it.type] })
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i] >= slots[i - 1], `${why}: whitelist order ${slots}`)
  if (slots.some((x) => x >= 6 && x <= 8)) assert.ok(!items.some((it) => it.type === 'sec' || it.type === 'chline' || it.type === 'reply'), `${why}: a stand-in replaces ③④⑨`)
}

test('1.4 #1 · #8: the item types of every generated step and of the constructed stand-ins come in whitelist order', async () => {
  let n = 0
  for await (const s of generated()) { whitelist(windowItems(s).items, s.anchor.calls[s.playhead].rid); n++ }
  assert.ok(n > 30)
  const flat = [tool(), sys(), blk()]
  const rows = [{}, { unparsed: true, errMsg: 'E' }, { rec: null }, { wire: { contextState: 'partial', contextMissing: 2 } }, { cacheBreak: { cause: 'compaction', idx: 2, firstCall: false } }]
  const desk = desk1(rows.map(() => flat), rows)
  for (let p = 0; p < rows.length; p++) whitelist(windowItems(stateOf(desk, p)).items, `row ${p}`)
  for (const s of [stateOf(desk1([flat], [{ comp: { tools: 9000 } }], { held: false })), stateOf(desk1([flat.map((b) => ({ ...b, ref: undefined, unaddressable: 'x' }))]))]) whitelist(windowItems(s).items, 'edge')
})

test('2.3 #28: a folded turn has its head and no rows; every turn open draws one row per list position in order; a row keeps its key when a row is added before it', async () => {
  for await (const s of generated()) {
    const flat = flatOf(s)
    if (!flat) continue
    const anchors = [...new Set(flat.filter((b) => b.sec === 'messages').map((b) => b.key))]
    s.turnFold = new Map(anchors.map((a, i) => [a, i % 2 === 0])) // the fold store: every other turn shut
    const items = windowItems(s).items
    for (const t of items.filter((it) => it.type === 'card')) {
      assert.equal(t.open, s.turnFold.has(t.anchor) ? s.turnFold.get(t.anchor) : t.open, 'a turn follows the fold store')
      if (!t.open) assert.ok(!items.some((it) => it.type === 'row' && it.turn === t.anchor), `${t.anchor}: a folded turn has no rows`)
    }
    const rows = windowItems({ ...s, turnFold: ALL_OPEN }).items.filter((it) => it.type === 'row')
    assert.equal(rows.length, flat.length, 'every turn open: one row per list position')
    assert.ok(rows.every((r, i) => !i || r.bi > rows[i - 1].bi), 'bi strictly increases')
    assert.ok(rows.every((r) => r.b.bid === flat[r.bi].bid), 'a row is the list block at its bi')
  }
  const a = [sys({ bid: 's1' }), blk({ bid: 'q1', key: 'q1' }), say({ bid: 'a1' }), say({ bid: 'a2' })]
  const b = [a[0], blk({ bid: 'n1', key: 'n1' }), ...a.slice(1)]
  const keys = (p) => new Map(windowItems(stateOf(desk1([a, b]), p, { turnFold: ALL_OPEN })).items.filter((it) => it.type === 'row').map((r) => [r.b.bid, r.key]))
  const k0 = keys(0), k1 = keys(1)
  for (const bid of ['s1', 'q1', 'a1', 'a2']) assert.equal(k1.get(bid), k0.get(bid), `${bid} keeps its key`)
})

// the proof rule (2.3 §保真标): a ref, and ff absent or verbatim
const proven = (b) => !!b.text_ref && (b.faithfulness == null || b.faithfulness === 'verbatim')

test('2.3 #14: a section claims Readable view iff the desk default is Readable; otherwise 以下逐字 exactly when the proof rule proves every block', async () => {
  const ff = (f) => ({ ff: { faithfulness: f } })
  const desk = desk1([[tool(), tool(ff('metadata')), sys(), blk(ff('opaque')), say()]])
  try {
    for (const mode of ['raw', 'read']) {
      setDeskMode(mode, { storage: null })
      const states = [stateOf(desk)]
      for await (const s of generated()) states.push(s)
      for (const s of states) {
        const flat = flatOf(s)
        if (!flat) continue
        for (const h of windowItems(s).items.filter((it) => it.type === 'sec')) {
          if (mode === 'read') { assert.equal(h.claim, 'readable'); continue }
          assert.notEqual(h.claim, 'readable')
          assert.equal(h.claim === 'verbatim', flat.filter((b) => b.sec === h.sec).every(proven), `${h.sec}: verbatim iff every block proves`)
        }
      }
    }
  } finally { setDeskMode('raw', { storage: null }) }
})

test('1.4 #10: landingFor names the reply on a follow-landed step, else the change line, else the first 「新」 row, else nothing; it leaves the state as it was', () => {
  const ref = [sys({ key: 's' }), blk({ key: 'x' }), say({ key: 'y' })]
  const cur = [sys({ key: 's' }), blk({ key: 'x' }), say({ key: 'y' }), say({ key: 'v', volatile: true }), say({ key: 'z' })]
  const brk = { cause: 'content-changed', idx: 2, firstCall: false, refRid: 'R0-0' }
  const lined = desk1([ref, cur], [{}, { cacheBreak: brk }]), plain = desk1([ref, cur])
  const freeze = (s) => ({ keys: Object.keys(s).sort(), landedFor: s.landedFor, turnLanded: [...s.turnLanded], turnFold: [...s.turnFold], openBlocks: [...s.openBlocks], playhead: s.playhead })
  const at = (p, extra, desk = lined) => { const s = stateOf(desk, p, extra), before = freeze(s), r = landingFor(s); assert.deepEqual(freeze(s), before, 'no side effect'); return r }
  assert.deepEqual(at(1, { followLanding: true }).t, { reply: true })
  const line = at(1)
  assert.equal(line.t.anchor, 'cachebrk'); assert.equal(line.fi, brk.idx)
  // no line: the first non-volatile row whose content key is not in the reference list (the previous step here)
  const nw = at(1, {}, plain), want = cur.findIndex((b) => !b.volatile && !ref.some((r) => r.key === b.key))
  assert.equal(nw.fi, want); assert.equal(nw.t.bi, want)
  assert.equal(at(0).t, null, 'the first step: nothing to land on')
  // a target inside a folded turn names that turn (the caller opens it); a step already landed has no landing due
  const folded = at(1, { turnFold: new Map([['x', false]]) })
  assert.equal(folded.turn, 'x')
  assert.equal(at(1, { landedFor: 'R0-1' }), null)
})

test('1.4 #10: a landing waits for the 内容对比步\'s list, lands when it is there, and not once the reader moved the box', () => {
  const ref = [sys({ key: 's' }), blk({ key: 'x' })], cur = [...ref, say({ key: 'z' })]
  const waiting = desk1([ref, cur]), h = waiting.held.get('R0-0')
  h.steps.delete('R0-0'); h.kf.clear(); h.byI = null // the reference step's pack is still on its way
  let top = 120
  const box = () => top, s = stateOf(waiting, 1), due = landingFor(s, box)
  assert.equal(due.t, null); assert.equal(due.wait, true)
  landed(s, due, box)
  assert.equal(s.landedFor, undefined, 'the landing is still due')
  assert.equal(landingFor(s, box).wait, true)
  const there = stateOf(desk1([ref, cur]), 1, { landWait: s.landWait })
  assert.equal(landingFor(there, box).fi, 2)
  top = 300 // the reader scrolled while it was on its way
  const moved = landingFor(there, box)
  assert.deepEqual([moved.t, moved.wait], [null, false])
  landed(there, moved, box)
  assert.equal(there.landedFor, 'R0-1')
})

test('2.3 内容对比步: the comparison step is on its way when the row the server named is not here, or the walk went over unread steps', () => {
  // generated: held step numbers with gaps, a failed run before a step; the walk's answer is "pending" exactly when a step between is not held
  for (let seed = 1; seed < 200; seed++) {
    let a = seed; const rnd = () => ((a = (a * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const nos = [], calls = []
    for (let n = Math.floor(rnd() * 3); calls.length < 12; n += rnd() < 0.3 ? 2 + Math.floor(rnd() * 4) : 1) { nos.push(n); calls.push({ rid: `r${n}`, error: rnd() < 0.2 ? 'failed' : undefined }) }
    const lane = { calls, ridLocal: new Map(calls.map((c, i) => [c.rid, i])), no: (i) => nos[i] }
    for (let i = 0; i < calls.length; i++) {
      let j = i - 1
      while (j >= 0 && calls[j].error) j--
      const unread = Array.from({ length: nos[i] }, (_, n) => n).some((n) => n > (j >= 0 ? nos[j] : -1) && !nos.includes(n))
      assert.equal(refPending(lane, i), unread, `seed ${seed} step ${nos[i]}`)
    }
  }
  const lane = { calls: [{ rid: 'a' }, { rid: 'b', cacheBreak: { refRid: 'gone' } }, { rid: 'c', cacheBreak: { refRid: 'a' } }, { rid: 'd', cacheBreak: { firstCall: true } }], ridLocal: new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3]]) }
  assert.deepEqual([1, 2, 3].map((i) => refPending(lane, i)), [true, false, false])
})

test('2.3 #2: an open row whose body comes back unproven gets a non-verbatim mark and its section stops claiming 以下逐字 on the next call over the same list', async () => {
  const flat = [sys(), blk({ key: 'q' }), say({ key: 'r' })]
  const s = stateOf(desk1([flat]))
  const rowOf = (items) => items.find((it) => it.type === 'row' && it.bi === 2)
  const secOf = (items) => items.find((it) => it.type === 'sec' && it.sec === 'messages')
  const key = `${flatOf(s)[2].bid}#0`
  s.openBlocks.add(key)
  const before = windowItems(s).items
  assert.equal(rowOf(before).marks.ff, 'verbatim'); assert.equal(secOf(before).claim, 'verbatim')
  assert.equal(rowOf(before).open, true)
  const api = { get: async () => ({ ok: true, data: { bytes: 'x', fidelity: { verbatim: false } } }) }
  await loadBodies(api, [flatOf(s)[2].text_ref])
  const after = windowItems(s).items
  assert.notEqual(rowOf(after).marks.ff, 'verbatim')
  assert.notEqual(secOf(after).claim, 'verbatim')
})
