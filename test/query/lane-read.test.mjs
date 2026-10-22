// test/query/lane-read.test.mjs — the `lane` query (RFC 3.5 §会话读; 1.6 §4.1 / C.5): every step's list rebuilt from the ops chain is
// the reduction's (#23), a lane held through `since` deltas and `--from` reads is the lane read whole (#26), and the answer's keys
// are the 3.5 closed sets on a session of each harness shape (#28, the lane part).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { SEVEN } from '../helpers/seven-shapes.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { openProjection } from '../../src/query/projection.mjs'
import { listOf } from '../../src/view/reduce.mjs'
import { compareStep } from '../../src/view/step-order.mjs'
import { PAGE_BYTES } from '../../src/query/session-doc.mjs'

const homeOf = (p) => path.join(tmpDir(p), '.trocar')
const q = (name, home, params, ctx = {}) => runQuery(name, params, { home, fs, ...ctx })

// A page's steps rebuilt from their ops on the lists held (rid → list); a keyframe on nothing.
function rebuild(page, held) {
  for (const s of page.steps) {
    const parent = s.parent == null ? [] : held.get(s.parent)
    assert.ok(parent, `${s.rid}: its parent ${s.parent} is held`)
    const out = []
    for (const [op, ...a] of s.ops) out.push(...(op === 0 ? parent.slice(a[0], a[0] + a[1]) : a))
    held.set(s.rid, out)
  }
  return held
}
// What a client holds of a lane besides its lists (3.5 §会话读 `lane`): events by step, resources by key, seen by path.
const holding = () => ({ events: new Map(), res: new Map(), seen: new Map() })
const resKey = (r) => `${r.kind}::${r.label}`
// An answer merged into what is held: the events of each step it covers replaced; its other events (a base:null page's compaction and
// summarize events) merged by (type, rid); resources replaced by key, seen by path; the events of steps no longer held let go.
function absorb(H, p, rids) {
  const covered = new Set(p.steps.map((s) => s.rid)), extra = new Map()
  for (const rid of covered) H.events.set(rid, [])
  for (const e of p.events) {
    if (covered.has(e.rid)) H.events.get(e.rid).push(e)
    else { const k = `${e.type}\u0000${e.rid}`; if (!extra.has(k)) extra.set(k, []); extra.get(k).push(e) }
  }
  for (const list of extra.values()) {
    const { type, rid } = list[0], was = H.events.get(rid) || [], at = was.findIndex((e) => e.type === type)
    const kept = was.filter((e) => e.type !== type)
    kept.splice(at < 0 ? kept.length : at, 0, ...list)
    H.events.set(rid, kept)
  }
  for (const r of p.resources) H.res.set(resKey(r), r)
  for (const f of p.seen) H.seen.set(f.path, f)
  if (rids) { const keep = new Set(rids); for (const rid of H.events.keys()) if (!keep.has(rid)) H.events.delete(rid) }
  return H
}
// The rule, on one answer: its events are its steps', but for a base:null page's compaction and summarize events; a page of more
// than one step ships ≤ PAGE_BYTES of steps, definitions and events.
const CS = (e) => e.type === 'compaction' || e.type === 'summarize'
const bytes = (list) => list.reduce((a, x) => a + Buffer.byteLength(JSON.stringify(x)), 0)
function pageRule(p) {
  const own = new Set(p.steps.map((st) => st.rid))
  for (const e of p.events) assert.ok(own.has(e.rid) || (p.base == null && CS(e)), `${e.type} ${e.rid}: an event of a step of the page`)
  if (p.steps.length > 1) assert.ok(bytes(p.steps) + bytes(p.defs) + bytes(p.events) <= PAGE_BYTES, 'a page of more than one step fits PAGE_BYTES')
}
// a --from answer's resources and seen: each new to the client or differing from the one it holds, when the client holds the ledger
// at the answer's base (it asked from its tip: 3.5 sends what differs from the ledger at `base`, which a client that asked from
// before its tip, or reads a later page of the same delta, does not hold)
function sends(p, H, atTip) {
  pageRule(p)
  if (!atTip) return
  for (const r of p.resources) assert.notDeepEqual(r, H.res.get(resKey(r)), `${resKey(r)}: sent only when new or changed`)
  for (const f of p.seen) assert.notDeepEqual(f, H.seen.get(f.path), `${f.path}: sent only when new or changed`)
}
// The rule, on a lane read whole: every base:null page carries the lane's compaction and summarize events; its user events' k run
// 1..n in step order.
function wholeRule(W) {
  const all = flat(W.H, W.rids).events, key = (e) => `${e.type} ${e.rid}`
  for (const p of W.pages) { pageRule(p); assert.deepEqual(new Set(p.events.filter(CS).map(key)), new Set(all.filter(CS).map(key)), 'a base:null page: the lane\'s compaction and summarize events') }
  assert.deepEqual(all.filter((e) => e.type === 'user').map((e) => e.k), all.filter((e) => e.type === 'user').map((_, i) => i + 1), 'user k: 1..n in step order')
}
// what is held, in the lane's step order
const flat = (H, rids) => ({ events: rids.flatMap((rid) => H.events.get(rid) || []), resources: Object.fromEntries(H.res), seen: Object.fromEntries(H.seen) })
// The lane read whole: the tail page, then each page before it by `--to` → {rids, lists, defs, pages, H (what it holds)}.
async function whole(home, id, lane, ctx) {
  const pages = []
  for (let p = await q('lane', home, { id, lane }, ctx); ; p = await q('lane', home, { id, lane, to: p.prev }, ctx)) {
    pages.unshift(p)
    if (p.prev == null) break
  }
  const held = new Map(), defs = new Map(), H = holding()
  for (const p of pages) { assert.equal(p.base, null); rebuild(p, held); for (const d of p.defs) defs.set(d.bid, d); absorb(H, p) }
  const W = { rids: pages.flatMap((p) => p.steps.map((s) => s.rid)), held, defs, pages, H }
  wholeRule(W)
  return W
}
// Every session read until nothing is pending (the worker's slices), its projection written.
async function settled(home, id) {
  let doc
  for (let i = 0; i < 500; i++) { doc = await q('session', home, { id }, { writer: true }); if (!doc.pending) return doc }
  assert.fail('the session never settled')
}

const LATE = [{ late: 0, subLanes: 1 }, { late: 8, subLanes: 4 }]
for (const wire of ['http', 'chat', 'ws']) for (const arrival of LATE) {
  test(`3.5 #23: ${wire} late ${arrival.late} × ${arrival.subLanes} — every step's list from the ops chain is the reduction's; a --from not in the lane resets`, async () => {
    const home = homeOf('trocar-lane-')
    const s = bigSession({ home, wire, growth: 200, subEvery: 2, compactAt: 1_500, ...arrival })
    s.append(30)
    const doc = await settled(home, s.id)
    const store = openProjection({ home, fs, key: s.id, write: false, errors: [] })
    try {
      assert.ok(doc.lanes.length > 1)
      for (const { lane } of doc.lanes) {
        const W = await whole(home, s.id, lane, { writer: true })
        assert.deepEqual(W.rids, doc.calls.filter((r) => r.lane === lane).map((r) => r.rid), `${lane}: the lane's steps in step order`)
        for (const rid of W.rids) assert.deepEqual(W.held.get(rid), listOf(store, rid).bids, `${lane} ${rid}: the tail pages' lists`)
        // from every step: the steps after it, on the lists the client holds up to it
        for (const from of W.rids) {
          const p = await q('lane', home, { id: s.id, lane, from }, { writer: true })
          assert.equal(p.base, from)
          const held = new Map(W.rids.slice(0, W.rids.indexOf(from) + 1).map((r) => [r, W.held.get(r)]))
          rebuild(p, held)
          for (const st of p.steps) assert.deepEqual(held.get(st.rid), listOf(store, st.rid).bids, `${lane} --from ${from}: ${st.rid}`)
        }
        const tail = await q('lane', home, { id: s.id, lane }, { writer: true })
        for (const from of ['20990101T000000Z:1', doc.calls.find((r) => r.lane !== lane).rid]) {
          const reset = await q('lane', home, { id: s.id, lane, from }, { writer: true })
          assert.equal(reset.base, null, `--from ${from}`)
          assert.deepEqual(reset, tail, `--from ${from} not in the lane: the tail page`)
        }
      }
    } finally { store.close() }
  })
}

// 3.5:67 — which `from` a client asks after a `since` delta, for one lane it holds ({rids, lists, ts}); null: read the lane whole.
function fromFor(held, key, d, rowTs) {
  const heldSet = new Set(held.rids)
  const affected = [...d.calls.filter((r) => r.lane === key || heldSet.has(r.rid)).map((r) => r.rid), ...d.gone.filter((r) => heldSet.has(r))]
  if (!affected.length) return { from: held.rids.at(-1), keep: held.rids.length }
  const tip = held.rids.at(-1), after = (rid) => compareStep(rowTs.get(rid), rid, rowTs.get(tip), tip) > 0
  if (affected.every((rid) => !heldSet.has(rid) && after(rid))) return { from: tip, keep: held.rids.length }
  // the earliest affected place among the held steps: the first held step at or after the earliest affected row
  const first = affected.reduce((a, b) => (compareStep(rowTs.get(a), a, rowTs.get(b), b) <= 0 ? a : b))
  const at = held.rids.findIndex((rid) => rid === first || compareStep(rowTs.get(rid), rid, rowTs.get(first), first) > 0)
  const keep = at < 0 ? held.rids.length : at
  return keep === 0 ? { from: null, keep: 0 } : { from: held.rids[keep - 1], keep }
}

// http: a new subagent every few calls whose first call is late (its lane's key changes: lanes_gone, the held rows relaned); chat:
// subagents told apart by order only, late calls sorting before a held tip. No generator drops a row (`gone`): fromFor handles it.
for (const [wire, axes] of [['http', { late: 8, subLanes: 1, subLen: 6, paths: 4 }], ['chat', { late: 8, subLanes: 3 }]]) {
  test(`3.5 #26: ${wire} — lanes held through since deltas and --from reads (late rows before the tip, relanes): lists, events (k), resources and seen equal the lanes read whole`, async () => {
    const home = homeOf('trocar-lane-hold-')
    const s = bigSession({ home, wire, growth: 150, subEvery: 2, compactAt: 1_200, ...axes })
    s.append(3)
    let doc = await q('session', home, { id: s.id })
    const rowTs = new Map(doc.calls.map((r) => [r.rid, r.ts]))
    const tally = { atTip: 0, cs: 0, user: 0, res: 0, seen: 0 }
    const lanes = new Map() // key → {rids, lists, H}
    const fetch = async (key, from, keep, held) => {
      const lists = new Map(held ? held.rids.slice(0, keep).map((r) => [r, held.lists.get(r)]) : [])
      const rids = held ? held.rids.slice(0, keep) : []
      if (from == null) { const W = await whole(home, s.id, key); return { rids: W.rids, lists: W.held, H: W.H } }
      const H = held.H
      for (let f = from; ;) {
        const p = await q('lane', home, { id: s.id, lane: key, from: f })
        assert.equal(p.base, f, `${key}: --from ${f} is a step the client holds`)
        rebuild(p, lists)
        rids.push(...p.steps.map((st) => st.rid))
        if (f === from && keep === held.rids.length) { tally.atTip++; sends(p, H, true) } else sends(p, H, false)
        absorb(H, p, rids)
        if (p.next == null) return { rids, lists, H }
        f = p.next
      }
    }
    for (const l of doc.lanes) lanes.set(l.lane, await fetch(l.lane, null))
    let late = 0, relaned = 0
    for (let k = 0; k < 40; k++) {
      s.append(1)
      const d = await q('session', home, { id: s.id, since: doc.mark })
      const was = new Map(doc.calls.map((r) => [r.rid, r.lane]))
      relaned += d.calls.filter((r) => was.has(r.rid) && was.get(r.rid) !== r.lane).length
      for (const r of d.calls) rowTs.set(r.rid, r.ts)
      for (const key of d.lanes_gone) lanes.delete(key)
      for (const [key, held] of lanes) {
        const { from, keep } = fromFor(held, key, d, rowTs)
        if (from != null && keep < held.rids.length) late++
        lanes.set(key, await fetch(key, from, keep, held))
      }
      for (const l of d.lanes) if (!lanes.has(l.lane)) lanes.set(l.lane, await fetch(l.lane, null))
      doc = await q('session', home, { id: s.id })
      assert.deepEqual([...lanes.keys()].sort(), doc.lanes.map((l) => l.lane).sort(), `after ${k + 1}: the lanes held`)
      for (const [key, held] of lanes) {
        const W = await whole(home, s.id, key)
        assert.deepEqual(held.rids, W.rids, `after ${k + 1}: ${key} steps`)
        for (const rid of W.rids) assert.deepEqual(held.lists.get(rid), W.held.get(rid), `after ${k + 1}: ${key} ${rid}`)
        const F = flat(held.H, held.rids)
        assert.deepEqual(F, flat(W.H, W.rids), `after ${k + 1}: ${key} events, resources and seen`)
        tally.cs += F.events.filter(CS).length; tally.user += F.events.filter((e) => e.type === 'user').length
        tally.res += Object.keys(F.resources).length; tally.seen += Object.keys(F.seen).length
      }
    }
    assert.ok(late > 0, 'a late row sorted before a held tip at least once')
    if (wire === 'http') assert.ok(relaned > 0, 'a held row changed lanes at least once')
    // the chat wire's fold has compaction events only: no user events, resources or seen paths
    for (const k of wire === 'http' ? Object.keys(tally) : ['atTip', 'cs']) assert.ok(tally[k] > 0, `${k}: met at least once`)
  })
}

// 3.5:61-66 the rule, on a main lane of several pages with compactions: every page (whole, and a --from chain from its first step)
// ships its own steps' events, the base:null ones the lane's compaction and summarize events too, within PAGE_BYTES; user k 1..n.
test('3.5 lane: events are the page\'s steps\', base:null adds the lane\'s compactions, user k runs 1..n, a page fits PAGE_BYTES', async () => {
  const home = homeOf('trocar-lane-rule-')
  const s = bigSession({ home, growth: 300, subEvery: 0, compactAt: 40_000, paths: 4 })
  s.append(600)
  const doc = await settled(home, s.id), lane = doc.lanes.find((l) => l.kind === 'main').lane
  const W = await whole(home, s.id, lane, { writer: true })
  assert.ok(W.pages.length > 1 && W.pages.some((p) => p.steps.length > 1), 'the lane spans pages')
  assert.ok(flat(W.H, W.rids).events.some(CS), 'the lane has compactions')
  for (let f = W.rids[0], n = 0; ; n++) {
    const p = await q('lane', home, { id: s.id, lane, from: f }, { writer: true })
    pageRule(p)
    if (p.next == null) { assert.ok(n > 0, 'the --from chain spans pages'); break }
    f = p.next
  }
})

// 3.5:63 no cap: a lane whose tool results name more than 200 distinct paths ships every one at base:null.
test('3.5 lane: seen is the ledger\'s entries uncapped — more than 200 paths seen, more than 200 sent', async () => {
  const home = homeOf('trocar-lane-seen-')
  const s = bigSession({ home, growth: 300, subEvery: 0, paths: 300 })
  s.append(3)
  const doc = await q('session', home, { id: s.id }), lane = doc.lanes.find((l) => l.kind === 'main').lane
  const p = await q('lane', home, { id: s.id, lane })
  assert.equal(p.base, null)
  assert.ok(new Set(p.seen.map((f) => f.path)).size > 200, 'every seen path is sent')
})

// ── 3.5 #28 (the lane part): the closed sets, on a session of each harness shape ─────────────────────────────────────────────────
const TOP = ['schema', 'command', 'ok', 'errors', 'lane', 'base', 'mark', 'steps', 'defs', 'resources', 'seen', 'events', 'prev', 'next']
const STEP = ['rid', 'parent', 'ops', 'reply', 'attrs', 'detail']
const DETAIL = ['norm', 'respRefs', 'nonBlockKeys', 'extraMessages', 'wire']
const NORM = ['stop_reason', 'usage']
const DEF = ['bid', 'fh', 'ref', 'sec', 'role', 'kind', 'label', 'name', 'mcp', 'cc', 'ff', 'head', 'preview', 'chars', 'bytes', 'resKey', 'r', 'unaddressable', 'inline']
const HEAD = ['role', 'tag', 'label']
const R = ['as', 'tone', 'title', 'f']
const ATTR = ['query', 'volatile']
const SEEN = ['path', 'firstRid', 'count']
const contract = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const subset = (o, closed, what) => { for (const k of Object.keys(o)) assert.ok(closed.includes(k), `${what}: ${k} is not in the 3.5 closed set`) }
const covers = (o, sample, what) => { for (const k of Object.keys(sample)) assert.ok(k in o, `${what}: ${k} (the contract's) is missing`) }
function closedSets(p, sample) {
  subset(p, TOP, 'answer'); covers(p, sample, 'answer')
  for (const st of p.steps) {
    subset(st, STEP, 'step'); covers(st, sample.steps[0], 'step')
    subset(st.detail, DETAIL, 'detail'); covers(st.detail, sample.steps[0].detail, 'detail')
    subset(st.detail.norm, NORM, 'detail.norm'); covers(st.detail.norm, sample.steps[0].detail.norm, 'detail.norm')
    for (const a of Object.values(st.attrs)) subset(a, ATTR, 'attrs')
  }
  const must = Object.keys(sample.defs[0]).filter((k) => DEF.includes(k) && !['label', 'name', 'mcp', 'cc', 'resKey'].includes(k))
  for (const d of p.defs) {
    subset(d, DEF, 'def'); for (const k of must) assert.ok(k in d, `def: ${k} is missing`)
    subset(d.head, HEAD, 'def.head'); subset(d.r, R, 'def.r')
    assert.match(d.bid, /^[A-Za-z0-9_-]{22}$/); assert.match(d.fh, /^[A-Za-z0-9_-]{22}$/)
    assert.equal(d.ref === null, 'unaddressable' in d, `${d.bid}: an unaddressable block has ref null and says why`)
  }
  for (const r of p.resources) {
    for (const g of r.segments || []) subset(g, ['enter', 'evict'], 'resource segment')
    for (const l of r.loads || []) subset(l, ['rid', 'range', 'via'], 'resource load')
  }
  for (const s of p.seen) subset(s, SEEN, 'seen')
  for (const e of p.events) { assert.ok('rid' in e && 'lane' in e && !('step' in e) && !('streamId' in e), 'event: rid and lane, no step / streamId') }
  const user = (sample.events || []).find((e) => e.type === 'user')
  for (const e of p.events.filter((x) => x.type === 'user')) { if (user) covers(e, user, 'user event'); assert.ok(Number.isInteger(e.k) && e.k >= 1, 'a user event carries k') }
}

// One session per HTTP shape (codex's WebSocket wire is generated in #23), four turns; on Claude Code a security-monitor call too.
function sevenHome() {
  const home = homeOf('trocar-lane-seven-')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const lines = []
  let n = 0
  const env = (h, sid, body, resp, ts) => JSON.stringify({ ts, endpoint: h.path.split('?')[0], method: 'POST', req_headers: { host: h.host, ...h.headers(sid) }, req_body: body,
    resp: { status: 200, kind: 'json', body: resp }, id: `req_${++n}`, ts_request: ts, is_llm_call: true, capture: 'transparent', host: h.host, traffic_class: 'llm',
    proc: { pid: 1, exe: `/x/${h.agent}`, agent: h.agent } })
  const reply = (h, t) => (h.wire === 'anthropic'
    ? { id: `msg_${n}`, model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: `a${t}` }], usage: { input_tokens: 10, output_tokens: 5 } }
    : { id: `c_${n}`, model: 'mock-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `a${t}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
  for (const h of SEVEN.filter((x) => x.body)) {
    const sid = `seven-${h.harness}-4a1b-9c2d-000000000001`
    for (let t = 0; t < 4; t++) lines.push(env(h, sid, h.body(sid, t), reply(h, t), `2026-10-22T10:${String(n).padStart(2, '0')}:00.000Z`))
    if (h.harness === 'cc') {
      const body = JSON.stringify({ model: 'mock-model', max_tokens: 64, system: [{ type: 'text', text: 'You are a security monitor for autonomous agents.' }],
        messages: [{ role: 'user', content: 'Review this action: rm -rf build' }] })
      lines.push(env(h, sid, body, { id: 'msg_mon', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '<block>yes</block>' }], usage: { input_tokens: 9, output_tokens: 2 } },
        `2026-10-22T10:${String(n).padStart(2, '0')}:30.000Z`))
    }
  }
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), lines.join('\n') + '\n')
  return home
}

test('3.5 #28 (lane): tail, --from and reset pages of every shape keep the closed sets; ids defined; a monitor lane\'s events carry verdict', async () => {
  const home = sevenHome()
  const { sessions } = await q('sessions', home, {})
  assert.ok(sessions.length >= 6)
  let monitors = 0
  for (const { session_id: id } of sessions) {
    const doc = await q('session', home, { id })
    for (const { lane } of doc.lanes) {
      const tail = await q('lane', home, { id, lane })
      closedSets(tail, contract.lane_keyframe)
      const known = new Set(tail.defs.map((d) => d.bid))
      for (const st of tail.steps) for (const b of [...st.ops.flatMap(([op, ...a]) => (op === 1 ? a : [])), ...st.reply]) assert.ok(known.has(b), `${lane}: ${b} is defined on its page`)
      const reset = await q('lane', home, { id, lane, from: '20990101T000000Z:1' })
      closedSets(reset, contract.lane_reset)
      assert.equal(reset.base, null)
      if (tail.steps.length > 1) {
        const base = tail.steps[0].rid, p = await q('lane', home, { id, lane, from: base })
        closedSets(p, contract.lane_ops)
        assert.equal(p.steps[0].parent, base, 'a --from page\'s first step extends its base')
        const W = await whole(home, id, lane)
        const held = rebuild(p, new Map([[base, W.held.get(base)]]))
        for (const st of p.steps) for (const b of [...held.get(st.rid), ...st.reply]) assert.ok(W.defs.has(b) && (p.defs.some((d) => d.bid === b) || [...W.held.get(base), ...tail.steps[0].reply].includes(b)), `${lane} --from: ${b} is in its defs or its base page's`)
      }
      // a fresh process (its own fs object, no state) over the fold log the writer left answers the warm bytes
      await settled(home, id)
      for (const params of [{ id, lane }, ...(tail.steps.length > 1 ? [{ id, lane, from: tail.steps[0].rid }] : [])]) {
        const warm = await q('lane', home, params, { writer: true }), cold = await q('lane', home, params, { writer: true, fs: { ...fs } })
        assert.equal(JSON.stringify(cold), JSON.stringify(warm), `${lane} ${params.from ?? 'tail'}: a fresh process answers the warm bytes`)
      }
      for (const e of tail.events.filter((x) => x.type === 'monitor')) { monitors++; assert.ok('verdict' in e && 'flagged' in e, 'a monitor event carries verdict and flagged') }
    }
  }
  assert.ok(monitors > 0, 'the security-monitor call is a monitor event of its lane')
})
