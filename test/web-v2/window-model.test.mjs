// test/web-v2/window-model.test.mjs — the window model (2.3 §读与画「长对话的窗口」 · 1.4 ①–⑨): item order, turns and keys, the
// section claim, the landing, a body's arrival. Expected values come from the list, the head or the fold store; inputs are desks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import { setDeskMode, loadBodies, bodyCache } from '../../web/legacy/replay/cell.mjs'
import { arrived, windowItems, landed, landingFor } from '../../web/src/screens/replay/window-model.mjs'
import { refPending, QUIET_CAUSES } from '../../web/legacy/replay/analysis.mjs'
import { cacheBreak } from '../../src/view/analyze.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'
import { deskOf, world, deskFrom } from './desk-world.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

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
const desk1 = (blocks, rows = blocks.map(() => ({})), extra = {}) => deskOf([{ kind: 'main', rows: rows.map((r) => ({ rec: { request: { model: 'm' } }, ...r })), blocks: extra.held === false ? undefined : blocks, replies: extra.replies, details: extra.details }])
const flatOf = (s) => stepOf(s.desk, s.anchor.calls[s.playhead].rid).flat
const ALL_OPEN = { has: () => true, get: () => true } // a fold memory that holds every turn open
// every step of the generated desks, as a state at its playhead
async function* generated() {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const desk = await deskFrom(world(seed).get(), 'S')
    for (const lane of buildLanes(desk)) for (let p = 0; p < lane.calls.length; p++) yield stateOf(desk, p, { anchor: lane })
  }
}

// 1.4 ①–⑪ by item type; ⑥–⑧ stand in for ③④⑨, ⑩⑪ follow ⑨ or ⑥ and are not drawn with ⑦⑧
const SLOT = { fid: 1, win: 2, sec: 3, foldall: 3, row: 3, card: 3, chline: 3, removed: 3, unparsed: 6, noreq: 7, frames: 8, reply: 9, impact: 10, details: 11 }
function whitelist(items, why) {
  const slots = items.map((it) => { assert.ok(SLOT[it.type], `${why}: ${it.type} is not in the whitelist`); return SLOT[it.type] })
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i] >= slots[i - 1], `${why}: whitelist order ${slots}`)
  if (slots.some((x) => x >= 6 && x <= 8)) assert.ok(!items.some((it) => it.type === 'sec' || it.type === 'chline' || it.type === 'reply'), `${why}: a stand-in replaces ③④⑨`)
  if (slots.some((x) => x === 7 || x === 8)) assert.ok(!slots.some((x) => x >= 10), `${why}: no ⑩⑪ with ⑦⑧`)
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

test('1.4 #10: a wait ends with its visit: back on the step, a box the steps between moved is not a reader who moved it', () => {
  const ref = [sys({ key: 's' }), blk({ key: 'x' })], cur = [...ref, say({ key: 'z' })]
  const waiting = desk1([ref, cur]), h = waiting.held.get('R0-0')
  h.steps.delete('R0-0'); h.kf.clear(); h.byI = null
  let top = 120
  const box = () => top, s = stateOf(waiting, 1)
  landed(s, landingFor(s, box), box)
  arrived(s, 'R0-1') // a redraw on the same step: still this visit
  assert.deepEqual(s.landWait, { rid: 'R0-1', top: 120 })
  arrived(s, 'R0-2'); top = 40 // left; the next step's landing moved the box
  arrived(s, 'R0-1') // back, its comparison step here by now
  const back = stateOf(desk1([ref, cur]), 1, { landWait: s.landWait })
  assert.equal(landingFor(back, box).fi, 2)
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

test('2.3 #13: a reply row says what its definition\'s head says, a server-side tool call among them', () => {
  const head = (tag) => ({ head: { role: 'assistant', tag, label: '' } })
  const parts = [rp('thinking', head('thinking')), rp('text', head('say')), rp('server_tool_use', head('action · web_search'))]
  const reply = windowItems(stateOf(desk1([[sys(), blk()]], undefined, { replies: [parts] }))).items.find((it) => it.type === 'reply')
  assert.deepEqual(reply.rows.map((r) => r.tag), parts.map((d) => d.head.tag))
})

// ── the window's items over constructed steps (1.4 #3 #5 #11 · 2.2 #1 · 2.3 #3 #6 #7 #13) ─────────────────────────────────
const open = (s) => windowItems({ ...s, turnFold: ALL_OPEN }).items
const ofType = (items, t) => items.filter((it) => it.type === t)
// a lane of two steps: step 1's list against step 0 as its 缓存对比步; `cause` on step 1
const pair = (a, b, cause = 'content-changed', idx = 1, row1 = {}) => desk1([a, b], [{}, { cacheBreak: { cause, idx, firstCall: false, refRid: 'R0-0' }, ...row1 }])
// the item after the change line (its removed list between) is the request row at `idx`
const afterLine = (items) => { const i = items.findIndex((it) => it.type === 'chline'); return i < 0 ? null : items.slice(i + 1).find((it) => it.type !== 'removed') }

test('1.4 #11: no request → ⑦ alone; unparsed → ⑥ with errMsg as a technical detail (its own item, Call details\' tech rows) and on no other item', () => {
  const desk = desk1([[blk()], [blk()]], [{ rec: null }, { unparsed: true, errMsg: 'ERR-unparse-zz' }])
  const none = windowItems(stateOf(desk, 0))
  assert.equal(none.state, 'noreq'); assert.deepEqual(none.items.filter((it) => it.type !== 'fid').map((it) => it.type), ['noreq'])
  const bad = windowItems(stateOf(desk, 1))
  assert.equal(bad.state, 'unparsed'); assert.equal(ofType(bad.items, 'unparsed')[0].errMsg, 'ERR-unparse-zz')
  assert.ok(ofType(bad.items, 'details')[0].tech.some(([k, v]) => k === 'errMsg' && v === 'ERR-unparse-zz'), 'Call details\' tech rows carry errMsg (2.6 §A)')
  for (const it of bad.items.filter((x) => x.type !== 'unparsed')) assert.ok(!JSON.stringify(it.type === 'details' ? { ...it, tech: [] } : it).includes('ERR-unparse-zz'), `${it.type} carries the reason`)
})

test('2.3 #7 · 1.4 #3 #11: the change line iff the cause is not quiet, right before row cacheBreak.idx, naming the reference step, no byte offset; the structural hint iff no block declares cc', () => {
  const a = [sys({ key: 's' }), blk({ key: 'm1' })], b = [sys({ key: 's' }), blk({ key: 'm2' }), blk({ key: 'm3' })]
  for (const cause of ['first-call', 'append', 'volatile-nonce-only', 'compaction', 'tool-array-reorder', 'json-key-reorder', 'content-changed']) {
    const items = open(stateOf(pair(a, b, cause), 1)), line = ofType(items, 'chline')
    assert.equal(line.length, QUIET_CAUSES.has(cause) ? 0 : 1, cause)
    if (!line.length) continue
    assert.equal(afterLine(items).type, 'row'); assert.equal(afterLine(items).bi, 1, `${cause}: before block idx`)
    assert.equal(line[0].k, 1, `${cause}: the reference step R0-0 is step 1`)
    assert.equal(line[0].cause, cause); assert.equal(line[0].compaction, cause === 'compaction')
    assert.ok(!('byteOffset' in line[0]) && !('byteContext' in line[0]), 'no byte offset on the line')
    assert.equal(line[0].auto, true, 'no cc: the structural hint')
  }
  assert.equal(ofType(open(stateOf(pair(a, [b[0], { ...b[1], cc: { type: 'ephemeral' } }, b[2]]), 1)), 'chline')[0].auto, false, 'cc: no hint')
  assert.equal(ofType(open(stateOf(pair(a, b, 'content-changed', 1, { error: 'boom', status: 500 }), 1)), 'chline').length, 1, 'a failed step keeps its line')
})

test('1.4 #3 · 2.3 #3: two steps differing in a volatile block alone reduce to volatile-nonce-only: no change line, the volatile row has its mark and no 「新」; cc → the cache mark', () => {
  const a = [sys({ key: 's', cc: { type: 'ephemeral' } }), blk({ key: 'v1', volatile: true }), blk({ key: 'q' })]
  const b = [a[0], blk({ key: 'v2', volatile: true }), a[2]]
  const brk = cacheBreak(a, b)
  assert.equal(brk.cause, 'volatile-nonce-only')
  const items = open(stateOf(desk1([a, b], [{}, { cacheBreak: { ...brk, refRid: 'R0-0' } }]), 1)), rows = ofType(items, 'row')
  assert.deepEqual(ofType(items, 'chline'), [])
  for (const r of rows) {
    assert.equal(!!r.marks.cacheMark, !!r.b.cc, `bi ${r.bi}: the cache mark iff cc`)
    assert.equal(r.marks.volatile, !!r.b.volatile)
    if (r.b.volatile) assert.equal(r.marks.isNew, false, 'a volatile row is never 「新」')
  }
  assert.ok(rows.some((r) => r.marks.volatile) && rows.some((r) => r.marks.cacheMark))
})

test('2.3 #6: 「新」 = fh not in the reference list; the removed list = the reference fh not here; a pinned step moves them; quiet or unheld reference: none', () => {
  const ref = [sys({ key: 's' }), blk({ key: 'x' }), blk({ key: 'gone' })], cur = [sys({ key: 's' }), blk({ key: 'x' }), blk({ key: 'added' })]
  const items = open(stateOf(pair(ref, cur, 'content-changed', 2), 1))
  const newBis = (its) => ofType(its, 'row').filter((r) => r.marks.isNew).map((r) => r.bi)
  assert.deepEqual(newBis(items), [2])
  assert.deepEqual(ofType(items, 'removed').flatMap((r) => r.blocks.map((b) => b.key)), ['gone'])
  // a step that is not the previous one, pinned: the marks follow it; the default is the 缓存对比步 (refRid)
  const d3 = desk1([[blk({ key: 'only0' })], ref, cur], [{}, {}, { cacheBreak: { cause: 'content-changed', idx: 0, firstCall: false, refRid: 'R0-1' } }])
  assert.deepEqual(newBis(open(stateOf(d3, 2, { diffRef: 0 }))), [0, 1, 2])
  assert.deepEqual(newBis(open(stateOf(d3, 2))), [2])
  // no change line → no removed list; a quiet step still marks its new block
  const q = open(stateOf(pair(ref, cur, 'append', 2), 1))
  assert.deepEqual(ofType(q, 'removed'), []); assert.deepEqual(newBis(q), [2])
  // the reference step's lane not held: no 「新」, no removed list
  const split = deskOf([{ kind: 'main', rows: [{ rec: {} }, { rec: {}, cacheBreak: { cause: 'content-changed', idx: 0, firstCall: false, refRid: 'R1-0' } }], blocks: [cur, cur] }, { kind: 'subagent', rows: [{ rec: {} }] }])
  const s = stateOf(split, 1)
  s.anchor = { ...s.anchor, calls: [split.rows.get('R1-0'), split.rows.get('R0-1')], ridLocal: new Map([['R1-0', 0], ['R0-1', 1]]) }
  const u = open(s)
  assert.deepEqual(newBis(u), []); assert.deepEqual(ofType(u, 'removed'), [])
  // only where cache_control sits differs (the bids differ, the fh are equal): no 「新」, no removed list
  const ca = [sys({ key: 's' }), blk({ key: 'm', cc: { type: 'ephemeral' } }), blk({ key: 'n' })], cb = [sys({ key: 's' }), blk({ key: 'm' }), blk({ key: 'n', cc: { type: 'ephemeral' } })]
  const cdesk = pair(ca, cb, 'content-changed', 1)
  assert.notDeepEqual(stepOf(cdesk, 'R0-0').flat.map((x) => x.bid), stepOf(cdesk, 'R0-1').flat.map((x) => x.bid))
  const c = open(stateOf(cdesk, 1))
  assert.deepEqual(newBis(c), []); assert.deepEqual(ofType(c, 'removed'), [])
})

test('1.4 #5: a compaction step\'s change line stands before the first conversation block, or at cacheBreak.idx when the first prompt stays; never in tools or system; its removed list; one lane', () => {
  const before = [tool({ key: 't' }), sys({ key: 's' }), blk({ key: 'q1', query: 'first' }), say({ key: 'a1' }), blk({ key: 'q2', query: 'second' }), say({ key: 'a2' })]
  const rewritten = [before[0], before[1], blk({ key: 'sum' }), blk({ key: 'q3', query: 'third' })]
  const kept = [before[0], before[1], before[2], blk({ key: 'sum' }), blk({ key: 'q3', query: 'third' })]
  for (const [cur, idx] of [[rewritten, 2], [kept, 3]]) {
    const desk = pair(before, cur, 'compaction', idx), items = open(stateOf(desk, 1)), at = items.findIndex((it) => it.type === 'chline')
    assert.equal(items[at].compaction, true)
    assert.equal(afterLine(items).bi, idx); assert.equal(afterLine(items).b.sec, 'messages')
    assert.ok(!items.slice(at).some((it) => it.type === 'row' && it.b.sec !== 'messages'), 'tools and system rows come before the line')
    assert.ok(ofType(items, 'removed')[0].blocks.length > 0, 'the rewritten history is in the removed list')
    assert.equal(buildLanes(desk).length, 1, 'no fork')
  }
})

test('2.2 #1: a card head carries its preview (≤ 90, a prefix of the prompt), its action summary iff it has actions, its block count, and no prompt when it continues the previous one', () => {
  const long = 'a  prompt\nthat runs on '.repeat(12)
  const flat = [sys(), say({ key: 'c' }), blk({ key: 'q', query: long }), say({ kind: 'tool_use' }), say({ kind: 'tool_use' }), say({ kind: 'thinking' }), blk({ kind: 'tool_result' }), blk({ key: 'q2', query: 'just this' })]
  const cards = ofType(open(stateOf(desk1([flat]))), 'card')
  assert.deepEqual(cards.map((c) => c.query), [false, true, true], 'the first card continues the previous prompt')
  assert.deepEqual(cards.map((c) => c.n), [1, 5, 1], 'each card counts its blocks')
  const folded = long.replace(/\s+/g, ' ').trim()
  assert.ok(cards[1].label.length <= 90 && folded.startsWith(cards[1].label) && cards[1].label.length < folded.length)
  assert.equal(cards[2].label, 'just this')
  assert.ok(cards[1].acts, 'tool calls, thinking and a tool result: an action summary'); assert.equal(cards[2].acts, '', 'a lone prompt: none')
})

const replyDesk = (replies, rows) => desk1(replies.map(() => [sys({ key: 's' }), blk({ key: 'q', query: 'q' })]), rows || replies.map(() => ({})),
  { replies, details: replies.map(() => ({ norm: { stop_reason: 'STOP-q' } })) })
const replyOfS = (s) => ofType(windowItems(s).items, 'reply')[0]

test('2.3 #13: the reply item — a row per definition with its own mark, the stop reason on the reply and the last row; parsed without a span; partial changes no row; no parts; unproven body; opaque closed; assembled; failed', () => {
  const parts = [rp('thinking'), rp('text', { ref: 's/m#R::10-20' }), rp('tool_use'), rp('thinking', { ff: { faithfulness: 'opaque' } })]
  const r = replyOfS(stateOf(replyDesk([parts])))
  assert.equal(r.rows.length, parts.length); assert.equal(r.stop, 'STOP-q')
  assert.deepEqual(r.rows.map((x) => x.last), parts.map((_, i) => i === parts.length - 1))
  assert.deepEqual(r.rows.map((x) => x.mark), ['verbatim', 'parsed', 'verbatim', 'opaque'], 'on its resp span: proven; no span: parsed; a known value: that value')
  assert.deepEqual(r.rows.map((x) => x.open), [true, true, true, false], 'every row opens but a no-plaintext one')
  assert.equal(r.rows[3].hideChars, true); assert.ok(r.rows.slice(0, 3).every((x) => !x.hideChars))
  assert.ok(r.rows.every((x) => x.key.startsWith('rp:') && !('bi' in x)))
  // a reader's flip is its key in openBlocks
  const s = stateOf(replyDesk([[rp('text'), rp('tool_use')]]))
  s.openBlocks.add(replyOfS(s).rows[1].key)
  assert.deepEqual(replyOfS(s).rows.map((x) => x.open), [true, false])
  // partial bytes: no row changes its mark; no parts: rows [] with the stop, empty only when the bytes are whole
  assert.deepEqual(replyOfS(stateOf(replyDesk([[rp('text')]], [{ respIncomplete: { truncated: true } }]))).rows.map((x) => x.mark), ['verbatim'])
  const none = replyOfS(stateOf(replyDesk([[]])))
  assert.deepEqual([none.rows, none.stop, none.empty], [[], 'STOP-q', 'empty'])
  assert.equal(replyOfS(stateOf(replyDesk([[]], [{ respIncomplete: { undecoded: true } }]))).empty, 'unread')
  // a failed step: no rows, its reason on the item
  const failed = replyOfS(stateOf(replyDesk([[rp('text')]], [{ error: 'ERR-boom-q', status: 500 }])))
  assert.deepEqual([failed.rows, failed.failed.reason], [[], 'ERR-boom-q'])
  // an opened row whose body came back unproven keeps that mark on every call
  const ref = 's/m#R::resp.raw::9001-9', u = stateOf(replyDesk([[rp('text', { ref })]]))
  bodyCache.set(ref, { status: 'absent' })
  try { for (let k = 0; k < 2; k++) assert.equal(replyOfS(u).rows[0].mark, 'notfetched') } finally { bodyCache.delete(ref) }
  // assembled from the stream: only while an open row reads stream events in Readable
  const aref = 's/m#R::resp.raw::9100-9', view = { r: { as: 'text', f: { body: ['text'] } }, body: { text: 'text' } }
  const assembled = () => replyOfS(stateOf(replyDesk([[rp('text', { ref: aref }), rp('tool_use')]]))).assembled
  try {
    setDeskMode('read', { storage: null })
    bodyCache.set(aref, { status: 'ok', text: 'text', view })
    assert.equal(assembled(), false, 'no events')
    bodyCache.set(aref, { status: 'ok', text: 'text', view: { ...view, events: 3 } })
    assert.equal(assembled(), true)
    setDeskMode('raw', { storage: null })
    assert.equal(assembled(), false, 'Raw shows the bytes')
  } finally { bodyCache.delete(aref); setDeskMode('raw', { storage: null }) }
})

// the real face: the demo session through the real server
async function demoDesk(fn) {
  const face = await serveBoard(boardHome())
  try {
    const id = (await face.get('sessions')).doc.sessions[0].session_id
    await fn(await deskFrom((n, p) => face.get(n, p).then((r) => r.doc), id))
  } finally { await face.close() }
}

test('1.4 #1 · 2.3 #13 the real face: every main step of the demo session keeps whitelist order, one reply row per reply definition', () => demoDesk((desk) => {
  const s = stateOf(desk)
  for (let p = 0; p < s.anchor.calls.length; p++) {
    s.playhead = p
    const items = windowItems(s).items, st = stepOf(desk, s.anchor.calls[p].rid)
    whitelist(items, `step ${p + 1}`)
    if (st.held && !s.anchor.calls[p].error) assert.equal(ofType(items, 'reply')[0].rows.length, st.reply.length)
  }
}))

// 2.3 §保真标 证明规则 over the real wire: a definition says its fidelity in `ff.faithfulness` (3.5 §会话读)
test('2.3 #2 the real face: each request row\'s fidelity is what its definition sends, never unknown for a known value', () => demoDesk((desk) => {
  const s = stateOf(desk, 0, { turnFold: ALL_OPEN }), KNOWN = new Set(Object.keys(W.FF_WORD))
  let seen = 0
  for (let p = 0; p < s.anchor.calls.length; p++) {
    s.playhead = p
    const st = stepOf(desk, s.anchor.calls[p].rid)
    if (!st.held) continue
    for (const r of ofType(windowItems(s).items, 'row')) {
      const d = st.flat[r.bi], v = d.ff && d.ff.faithfulness
      seen++
      assert.equal(r.marks.ff === 'unknown', v != null && !KNOWN.has(v), `step ${p + 1} row ${r.bi}: ff ${JSON.stringify(d.ff)} gave ${r.marks.ff}`)
      if (d.ref && (v == null || v === 'verbatim')) assert.equal(r.marks.ff, 'verbatim', `step ${p + 1} row ${r.bi} (${d.sec})`)
    }
  }
  assert.ok(seen > 0)
}))
