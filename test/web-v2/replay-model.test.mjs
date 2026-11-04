// test/web-v2/replay-model.test.mjs — the desk model (replay/model.mjs) against the session-read contract (RFC 3.5 §会话读,
// 2.3 #22): lane pages materialise to their lists, deltas rebuild the full document, and 3.5:67's from-rule keeps held lanes
// whole. Expected values come from the contract fixture and from the generated world's own draws (test/web-v2/desk-world.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDesk, applySession, applyLane, listOf, stepOf, laneEvents, askOrdinal, applyLedger, ledgerAsk, ledgerDone,
  readLedger, seenFiles, compactionNumbers } from '../../web/legacy/replay/model.mjs'
import { world, readLane, deskFrom } from './desk-world.mjs'

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)

test('2.3 #22: lane pages materialise to lists whose every bid is defined and whose copies stay in the parent', async () => {
  const desk = createDesk()
  applySession(desk, fx.session_full)
  for (const page of [fx.lane_keyframe, fx.lane_ops, fx.lane_reset]) applyLane(desk, page)
  for (const page of [fx.lane_keyframe, fx.lane_ops, fx.lane_reset]) for (const s of page.steps) {
    const list = listOf(desk, s.rid)
    // a copy inside its parent yields exactly `len` ids, so the list is as long as the ops say
    assert.equal(list.length, s.ops.reduce((n, [op, ...a]) => n + (op === 0 ? a[1] : a.length), 0), s.rid)
    for (const b of [...list, ...s.reply]) assert.ok(desk.defs.has(b), `${s.rid}: ${b} is defined`)
    const st = stepOf(desk, s.rid)
    assert.deepEqual(st.flat.map((f) => f.bid), list)
    assert.deepEqual(st.reply.map((d) => d.bid), s.reply)
  }
  // long worlds: lanes read from their first step on chain past the 32-step keyframe cache
  for (const w of [...SEEDS.map((s) => world(s)), ...[1, 2, 3, 4].map((s) => world(s, { calls: 160 }))]) {
    const { seed } = w, get = w.get(), lanes = w.laneRidsAt()
    const whole = await deskFrom(get, 'S')
    for (const [key, rids] of lanes) {
      assert.deepEqual(whole.held.get(key).rids, rids, `seed ${seed} lane ${key}: every step held`)
      for (const rid of rids) assert.deepEqual(listOf(whole, rid), w.list(rid), `seed ${seed} ${rid}`)
      if (rids.length < 2) continue
      // two pages: the one ending before a step (`to`), then on from its `next`
      const mid = rids[seed % 2 ? 1 : rids.length >> 1], two = createDesk()
      applySession(two, w.full())
      const first = await get('lane', { lane: key, to: mid })
      applyLane(two, first)
      if (first.next) await readLane(get, 'S', two, { lane: key, from: first.next })
      for (const rid of [...two.held.get(key).rids].reverse()) assert.deepEqual(listOf(two, rid), w.list(rid), `seed ${seed} ${rid} (two pages)`)
      assert.equal(two.held.get(key).rids.at(-1), rids.at(-1), `seed ${seed} lane ${key}: the second page reaches the tip`)
    }
  }
})

const VIEW = (d) => ({ rows: d.rows, order: d.order, lanes: d.lanes, laneRids: d.laneRids, events: d.events, unknown: d.unknown })

test('full(M0) plus the since deltas equals full(now); an unknown mark (base:null) replaces everything', () => {
  const seen = { late: 0, gone: 0, relane: 0, lanesGone: 0 }
  for (const seed of SEEDS) {
    const w = world(seed), m = w.marks
    let M = m[Math.floor(m.length / 4)]
    const desk = createDesk()
    applySession(desk, w.full(M))
    for (let i = m.indexOf(M) + 1; i < m.length; i += 1 + (seed + i) % 3) {
      const next = m[Math.min(i, m.length - 1)], d = w.since(M, next)
      const tip = desk.order.at(-1), tipTs = desk.rows.get(tip).ts
      seen.late += d.calls.some((c) => !desk.rows.has(c.rid) && c.ts < tipTs)
      seen.gone += d.gone.length > 0
      seen.relane += d.calls.some((c) => desk.rows.has(c.rid) && desk.rows.get(c.rid).lane !== c.lane)
      seen.lanesGone += d.lanes_gone.length > 0
      assert.equal(d.base, M)
      applySession(desk, d)
      M = next
    }
    if (M !== w.now) applySession(desk, w.since(M, w.now))
    const ref = createDesk()
    applySession(ref, w.full(w.now))
    assert.deepEqual(VIEW(desk), VIEW(ref), `seed ${seed}`)
    assert.equal(desk.mark, w.now)
    const stale = createDesk()
    applySession(stale, w.full(m[2]))
    const out = applySession(stale, w.since('20261021T101500Z:not-a-member'))
    assert.equal(out.reset, true)
    assert.deepEqual(VIEW(stale), VIEW(ref), `seed ${seed}: unknown mark`)
  }
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `the worlds' deltas include ${k}`)
  // a cut session, followed with --since the previous answer's mark as is: across the moved cut the answer is the full
  // document and the desk is replaced by it; after it the deltas carry the cut mark on
  let crossed = 0, after = 0
  for (const seed of SEEDS) {
    const w = world(seed, { cut: true }), desk = createDesk()
    applySession(desk, w.full(w.marks[0]))
    for (const at of w.marks.slice(1)) {
      const d = w.since(desk.mark, at), out = applySession(desk, d)
      if (d.base == null) { crossed++; assert.equal(out.reset, true, `seed ${seed} at ${at}`) } else if (String(d.base).includes('@')) after++
    }
    const ref = createDesk()
    applySession(ref, w.full())
    assert.deepEqual(VIEW(desk), VIEW(ref), `seed ${seed}: cut`)
    assert.equal(desk.mark, w.full().mark)
  }
  assert.ok(crossed > 0 && after > 0, `a cut moved (${crossed}) and deltas went on under it (${after})`)
})

test('the world answers with the fixture\'s key sets, both ways', async () => {
  const keys = (o) => Object.keys(o).sort()
  const closed = (name, fxItems, items) => {
    const all = new Set(fxItems.flatMap(Object.keys)), must = Object.keys(fxItems[0]).filter((k) => fxItems.every((x) => k in x))
    for (const it of items) {
      for (const k of Object.keys(it)) assert.ok(all.has(k), `${name}: ${k} is not in the fixture`)
      for (const k of must) assert.ok(k in it, `${name}: ${k} is missing`)
    }
  }
  let hasUnknown = false
  for (const seed of SEEDS.slice(0, 10)) {
    const w = world(seed), full = w.full(), since = w.since(w.marks[3]), lanes = [...w.laneRidsAt().keys()]
    // `unknown?` and `pending?` are present only when there is something to say (3.5)
    const bare = (o) => keys(o).filter((k) => k !== 'unknown' && k !== 'pending')
    assert.deepEqual(bare(full), bare(fx.session_full))
    assert.deepEqual(bare(since), bare(fx.session_since))
    hasUnknown ||= 'unknown' in full
    closed('row', [...fx.session_full.calls, ...fx.session_since.calls], [...full.calls, ...since.calls])
    closed('lane header', fx.session_full.lanes, full.lanes)
    closed('event', fx.session_full.events, full.events)
    closed('record', fx.session_full.records, full.records)
    for (const key of lanes) {
      const tail = w.lane(key), mid = w.lane(key, { from: w.laneRidsAt().get(key)[0] })
      const more = tail.ledger_next ? [w.lane(key, { ledger: tail.ledger_next })] : []
      for (const a of [tail, mid, ...more]) {
        assert.deepEqual(keys(a), keys(fx.lane_keyframe))
        closed('step', fx.lane_keyframe.steps, a.steps)
        closed('def', [...fx.lane_keyframe.defs, ...fx.lane_ops.defs, ...fx.lane_reset.defs], a.defs)
        closed('resource', [...fx.lane_keyframe.resources, ...fx.lane_reset.resources, ...fx.lane_ledger.resources], a.resources)
        closed('seen', [...fx.lane_keyframe.seen, ...fx.lane_ledger.seen], a.seen)
        closed('lane event', [...fx.lane_keyframe.events, ...fx.lane_reset.events], a.events)
      }
    }
  }
  assert.ok(hasUnknown, 'some full answer carries unknown')
})

// a world's lane answers as the board's read envelope, at mark `at`
const reader = (w, at) => async (name, p) => ({ ok: true, data: name === 'lane' ? w.lane(p.lane, p, at) : w.full(at) })
const CS = (e) => e.type === 'compaction' || e.type === 'summarize'
const csOf = (evs) => evs.filter(CS).map((e) => `${e.type} ${e.rid}`).sort()

// every held rid's events = the world's at `at`, and the lane's compaction / summarize events all there; → first mismatch or null
function eventsMatch(w, desk, at) {
  for (const key of desk.held.keys()) {
    const want = w.eventsAt(key, at), got = laneEvents(desk, key)
    for (const rid of desk.held.get(key).rids) {
      const a = got.filter((e) => e.rid === rid), b = want.filter((e) => e.rid === rid)
      if (JSON.stringify(a) !== JSON.stringify(b)) return `${key} ${rid}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
    }
    if (JSON.stringify(csOf(got)) !== JSON.stringify(csOf(want))) return `${key}: compaction / summarize ${csOf(got)} vs ${csOf(want)}`
  }
  return null
}

test('3.5 events: over tail and --to reads each held rid\'s events are the world\'s; compaction / summarize arrive with the tail', async () => {
  let older = 0
  for (const seed of SEEDS) {
    const w = world(seed), m = w.marks
    let M = m[Math.floor(m.length / 3)]
    const desk = createDesk()
    applySession(desk, w.full(M))
    for (const key of desk.lanes.keys()) {
      applyLane(desk, w.lane(key, {}, M))
      const h = desk.held.get(key)
      older += h.prev !== null && csOf(w.eventsAt(key, M)).some((x) => !h.rids.includes(x.split(' ')[1]))
    }
    assert.equal(eventsMatch(w, desk, M), null, `seed ${seed} tail pages`)
    // an older page for every held lane that has one, to the lanes' first steps
    for (let more = true; more;) {
      more = false
      for (const [key, h] of desk.held) if (h.prev) { applyLane(desk, w.lane(key, { to: h.prev }, M)); more = true }
      assert.equal(eventsMatch(w, desk, M), null, `seed ${seed} older pages`)
    }
  }
  assert.ok(older > 0, 'some tail page carries compaction / summarize of steps before it')
})

test('2.2 K: askOrdinal is the world\'s k where the held pages reach the last user event, null where they do not', async () => {
  let midKnown = 0, unknowable = 0
  for (const seed of SEEDS) {
    const w = world(seed, { calls: 60 }), desk = createDesk(), lanes = w.laneRidsAt()
    applySession(desk, w.full())
    for (const [key, rids] of lanes) {
      const evs = w.eventsAt(key)
      for (let a = w.lane(key); ; a = w.lane(key, { to: a.prev })) {
        applyLane(desk, a)
        const h = desk.held.get(key), start = rids.indexOf(h.rids[0])
        for (const rid of h.rids) {
          const at = rids.indexOf(rid), last = evs.filter((e) => e.type === 'user' && rids.indexOf(e.rid) <= at).at(-1)
          const want = last ? (rids.indexOf(last.rid) >= start ? last.k : null) : start === 0 ? 0 : null
          assert.equal(askOrdinal(desk, key, rid), want, `seed ${seed} ${rid} held from ${start}`)
          if (start > 0 && want != null && want > 0) midKnown++
          if (want === null) unknowable++
        }
        if (!a.prev) break
      }
    }
  }
  // pages held from mid-lane where k is known: a count of the held user events would undercount there
  assert.ok(midKnown > 0 && unknowable > 0, `mid-lane known ${midKnown}, not knowable ${unknowable}`)
})

const sameFile = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a)

test('2.4 #1 #9: seenFiles = the lane\'s seen minus the files it opened (any spelling), in step order of firstRid then count', async () => {
  // fixture: test/app.test.mjs is opened and seen → absent; src/app.mjs only seen → present
  const fd = createDesk()
  applySession(fd, fx.session_full)
  assert.equal(seenFiles(fd, fx.lane_keyframe.lane), null, 'not held')
  applyLane(fd, fx.lane_keyframe)
  applyLedger(fd, fx.lane_keyframe.lane, 'C', fx.lane_ledger)
  assert.deepEqual(seenFiles(fd, fx.lane_keyframe.lane).map((x) => x.path), ['src/app.mjs'])
  const saw = { dropped: 0, kept: 0 }
  for (const seed of SEEDS) {
    const w = world(seed), desk = await deskFrom(w.get(), 'S'), lanes = w.laneRidsAt()
    for (const [key, rids] of lanes) {
      const { resources, seen } = w.ledgerAt(key), opened = resources.filter((r) => r.kind === 'file').map((r) => r.label)
      const got = seenFiles(desk, key)
      for (const x of got) assert.ok(!opened.some((p) => sameFile(p, x.path)), `seed ${seed}: ${x.path} is an opened file`)
      const want = seen.filter((x) => !opened.some((p) => sameFile(p, x.path)))
      assert.deepEqual([...got].sort((a, b) => (a.path < b.path ? -1 : 1)), want, `seed ${seed} lane ${key}`)
      for (let i = 1; i < got.length; i++) {
        const a = rids.indexOf(got[i - 1].firstRid), b = rids.indexOf(got[i].firstRid)
        assert.ok(a < b || (a === b && got[i - 1].count >= got[i].count), `seed ${seed}: order at ${i}`)
      }
      saw.dropped += seen.some((x) => x.path.startsWith('/') && opened.some((p) => sameFile(p, x.path)))
      saw.kept += got.some((x) => opened.some((p) => p.split('/').pop() === x.path.split('/').pop()))
    }
  }
  assert.ok(saw.dropped > 0 && saw.kept > 0, `absolute spellings dropped ${saw.dropped}, same name elsewhere kept ${saw.kept}`)
})

test('3.5 ledger_next: the chain gives the whole ledger at mark, ledgerDone turns true only at its end, a ledger page touches no step', async () => {
  let chains = 0, older = 0
  for (const seed of SEEDS) {
    const w = world(seed), desk = createDesk()
    applySession(desk, w.full())
    for (const key of w.laneRidsAt().keys()) {
      const tail = w.lane(key)
      applyLane(desk, tail)
      assert.equal(ledgerDone(desk, key), tail.ledger_next === null, `seed ${seed} ${key}`)
      if (tail.ledger_next) { chains++; assert.deepEqual(ledgerAsk(desk, key), { lane: key, ledger: tail.ledger_next }) }
      // an older page carries the ledger head again (base:null); a cursor the chain still owes survives it, none is added
      const ask = ledgerAsk(desk, key)
      for (let p = tail; p.prev != null;) { p = w.lane(key, { to: p.prev }); older++; applyLane(desk, p); assert.deepEqual(ledgerAsk(desk, key), ask, `seed ${seed} ${key} older page`) }
      assert.deepEqual(await readLedger(desk, key, reader(w, w.now)), { ok: true })
      assert.equal(ledgerDone(desk, key), true)
      for (let p = w.lane(key, { to: desk.held.get(key).rids[0] }); p.steps.length; p = w.lane(key, { to: p.steps[0].rid })) { applyLane(desk, p); assert.equal(ledgerDone(desk, key), true, `seed ${seed} ${key} done stays done`) }
      const h = desk.held.get(key), whole = w.ledgerAt(key)
      const byKey = (xs, k) => [...xs].sort((a, b) => (k(a) < k(b) ? -1 : 1))
      assert.deepEqual(byKey(h.resources.values(), (r) => `${r.kind}::${r.label}`), whole.resources, `seed ${seed} ${key} resources`)
      assert.deepEqual(byKey(h.seen.values(), (x) => x.path), whole.seen, `seed ${seed} ${key} seen`)
    }
  }
  assert.ok(chains > 0 && older > 0, `some ledger overflows its tail page (${chains}), some lane has older pages (${older})`)
  // a failed ledger read stops and keeps its cursor pending
  const desk = createDesk()
  applySession(desk, fx.session_full)
  applyLane(desk, { ...fx.lane_keyframe, ledger_next: 'C' })
  assert.equal((await readLedger(desk, fx.lane_keyframe.lane, async () => ({ ok: false, error: 'down' }))).ok, false)
  assert.equal(ledgerDone(desk, fx.lane_keyframe.lane), false)
  // the fixture's ledger answer changes no step, rid, event or definition of the lane it is applied to
  const snap = (d) => { const h = d.held.get(fx.lane_keyframe.lane); return structuredClone({ rids: h.rids, steps: h.steps, events: h.events, defs: d.defs }) }
  const before = snap(desk)
  applyLedger(desk, fx.lane_keyframe.lane, 'C', fx.lane_ledger)
  assert.deepEqual(snap(desk), before)
  assert.equal(ledgerDone(desk, fx.lane_keyframe.lane), false, 'its own ledger_next is pending')
})

test('3.5 tail page: a reset holds the tail page only, prev pages restore every list, defs one per bid', async () => {
  let resent = 0
  for (const seed of SEEDS) {
    const w = world(seed, { calls: 60 }), desk = await deskFrom(w.get(), 'S'), lanes = w.laneRidsAt()
    for (const key of lanes.keys()) applyLane(desk, w.lane(key)) // a tail page of a held lane resets it
    for (const [key, rids] of lanes) {
      const h = desk.held.get(key)
      assert.deepEqual(h.rids, w.lane(key).steps.map((s) => s.rid), `seed ${seed} ${key}: the tail page only`)
      if (h.prev) await readLane(w.get(), 'S', desk, { lane: key, to: h.prev })
      assert.deepEqual(desk.held.get(key).rids, rids, `seed ${seed} ${key}`)
      for (const rid of rids) {
        assert.deepEqual(listOf(desk, rid), w.list(rid), `seed ${seed} ${rid}`)
        for (const b of [...listOf(desk, rid), ...stepOf(desk, rid).reply.map((d) => d.bid)]) assert.equal(desk.defs.get(b)?.bid, b)
      }
      // a --from answer may resend a definition the desk holds
      for (let i = 0; i + 1 < rids.length; i++) resent += w.lane(key, { from: rids[i] }).defs.some((d) => desk.defs.has(d.bid) && !w.list(rids[i]).includes(d.bid))
    }
    for (const [b, d] of desk.defs) assert.equal(d.bid, b)
  }
  assert.ok(resent > 0, 'some --from answer resends a held definition')
})

// 2.4 压缩行: a harness's request shows the numbers of its landing, an inferred compaction its own, in whatever order the events arrived.
test('2.4 compactionNumbers: marked landed, marked unlanded, inferred, two in a row, shuffled', () => {
  const marked = (step, from) => ({ type: 'compaction', step, from, to: from + 1, inferred: false })
  const inferred = (step, from, to) => ({ type: 'compaction', step, from, to, inferred: true })
  const landed = (step, from, to) => ({ type: 'compaction-landed', step, from, to })
  const others = [{ type: 'summarize', step: 1, out: 9 }, { type: 'user', step: 2 }]
  const m1 = marked(3, 40), m2 = marked(6, 12), m3 = marked(9, 30), i1 = inferred(12, 50, 5), l1 = landed(4, 41, 12), l2 = landed(7, 13, 3), late = landed(13, 5, 2)
  for (const [events, want] of [
    [[m1, l1], [[m1, 41, 12]]],
    [[m1], [[m1, 40, null]]],
    [[i1], [[i1, 50, 5]]],
    [[i1, late], [[i1, 50, 5]]],
    [[m1, m2, l2], [[m1, 40, null], [m2, 13, 3]]],
    [[m1, l1, m2, l2, m3, i1, late], [[m1, 41, 12], [m2, 13, 3], [m3, 30, null], [i1, 50, 5]]],
  ]) for (let turn = 0; turn < events.length; turn++) {
    const list = [...events.slice(turn), ...others, ...events.slice(0, turn)]
    const got = compactionNumbers(list, (e) => e.step)
    assert.deepEqual([...got.keys()].filter((e) => e.type !== 'compaction'), [])
    assert.deepEqual(want.map(([e]) => got.get(e)), want.map(([, from, to]) => ({ from, to })))
    assert.equal(got.size, want.length)
  }
})
