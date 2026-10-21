// test/web-v2/desk-world.mjs — a generated session world and a reference server over it (RFC 3.5 §会话读), exports only.
//
// world(seed): 2-5 lanes (main + sub-agents), calls written in arrival order whose ts sometimes sorts before rows already
// written (late rows), relanes and gone rows carried by later members, and per-step bid lists drawn by appends, mid-list
// inserts, replacements and compactions. The server answers `session` (full / --since) and `lane` (--from / --to) at any
// member mark with the key sets of test/fixtures/session-read-contract.json; ops are a greedy copy/add encoding.
// deskFrom(get, id) reads `session` and then every lane page by page through the desk model.
import { createHash } from 'node:crypto'
import { QUERIES } from '../../src/query/named/index.mjs'
import { createDesk, applySession, applyLane } from '../../src/web/v2/replay/model.mjs'

/** Lane Q's routes are merged when the named-query table has `lane` (D8 deletes this and the skips that read it). */
export const ROUTES_READY = Object.hasOwn(QUERIES, 'lane')

// the server's step order (3.5: ts_request, then id), written here independently of the model
const stepCmp = (a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.rid).localeCompare(String(b.rid))

function rng(seed) {
  let a = (seed >>> 0) || 1
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Greedy ops (3.5): the longest run of the parent's list at each point is copied, anything else is added. */
function encode(P, C) {
  const where = new Map()
  P.forEach((b, i) => (where.get(b) || where.set(b, []).get(b)).push(i))
  const ops = []
  for (let i = 0; i < C.length;) {
    let len = 0, at = -1
    for (const s of where.get(C[i]) || []) {
      let l = 0
      while (s + l < P.length && i + l < C.length && P[s + l] === C[i + l]) l++
      if (l > len) { len = l; at = s }
    }
    if (len) { ops.push([0, at, len]); i += len; continue }
    const last = ops.at(-1)
    if (last && last[0] === 1) last.push(C[i]); else ops.push([1, C[i]])
    i++
  }
  return ops
}

export function world(seed, { calls: count } = {}) {
  const r = rng(seed), int = (a, b) => a + Math.floor(r() * (b - a + 1))
  const nLanes = int(2, 5), n = count ?? int(18, 40), page = int(3, 7)
  const T0 = Date.parse('2026-10-21T10:00:00.000Z')
  let bn = 0
  const defs = new Map(), attrsOf = new Map()
  const bid = (sec, role) => {
    const b = createHash('sha256').update(`${seed}:${bn++}`).digest('base64url').slice(0, 22)
    const fh = createHash('sha256').update(`fh:${b}`).digest('base64url').slice(0, 22)
    defs.set(b, { bid: b, fh, ref: `s/x#b${bn}::0-10`, sec, role, kind: 'text', ff: 'text', head: { role, tag: 'text', label: 'text' },
      preview: b.slice(0, 8), chars: 8, bytes: 10, r: { as: 'markdown' } })
    const x = r()
    if (x < 0.15) attrsOf.set(b, { query: true }); else if (x < 0.25) attrsOf.set(b, { volatile: true })
    return b
  }
  const shared = [bid('system', 'system'), bid('tools', 'system')]
  const last = []  // the list of the previous ARRIVED call of each lane
  const calls = []
  for (let i = 0; i < n; i++) {
    const lane = i < nLanes ? i : int(0, nLanes - 1)
    let list = last[lane] ? [...last[lane]] : [...shared, bid('messages', 'user')]
    if (last[lane]) {
      const kind = r()
      if (kind < 0.45) for (let k = int(1, 3); k; k--) list.push(bid('messages', k % 2 ? 'assistant' : 'user'))
      else if (kind < 0.65) list.splice(int(1, list.length), 0, bid('messages', 'user'))
      else if (kind < 0.85) list[int(0, list.length - 1)] = bid('messages', 'user')
      else list = [...list.slice(0, int(1, 2)), bid('messages', 'user')]
    }
    last[lane] = list
    const late = i > 2 && r() < 0.3
    const ts = new Date(T0 + (late ? (i - int(1, 6)) * 1000 + int(0, 999) : i * 1000)).toISOString()
    const effects = []
    if (i > 3 && r() < 0.15) effects.push({ kind: 'relane', at: int(0, i - 1), lane: int(0, nLanes - 1) })
    if (i > 3 && r() < 0.1) effects.push({ kind: 'gone', at: int(0, i - 1) })
    calls.push({ rid: `20261021T101500Z:${1000 + i}`, lane, ts, list, reply: Array.from({ length: int(0, 2) }, () => bid('reply', 'assistant')),
      status: r() < 0.1 ? 529 : 200, event: r() < 0.3 ? (r() < 0.5 ? 'user' : 'tool') : null, res: r() < 0.2 ? `file:f${i}.mjs` : null, effects })
  }
  const marks = calls.map((c) => c.rid)
  const byRid = new Map(calls.map((c) => [c.rid, c]))
  const now = marks.at(-1)

  // the document at mark M: the reduction over members with pos <= M
  function docAt(M) {
    const k = marks.indexOf(M) + 1, laneOf = new Map(), gone = new Set()
    for (const c of calls.slice(0, k)) {
      laneOf.set(c.rid, c.lane)
      for (const e of c.effects) {
        const t = calls[e.at]
        if (gone.has(t.rid)) continue
        if (e.kind === 'gone') gone.add(t.rid); else laneOf.set(t.rid, e.lane)
      }
    }
    const live = calls.slice(0, k).filter((c) => !gone.has(c.rid)).sort(stepCmp)
    const members = new Map()  // lane index -> calls in step order
    for (const c of live) (members.get(laneOf.get(c.rid)) || members.set(laneOf.get(c.rid), []).get(laneOf.get(c.rid))).push(c)
    const keyOf = new Map([...members].map(([l, cs]) => [l, cs[0].rid]))
    const mainKey = keyOf.get(0) ?? null
    const rows = new Map(), events = [], lanes = new Map(), laneCalls = new Map()
    for (const c of live) {
      const lane = keyOf.get(laneOf.get(c.rid)), ctx = 1000 + c.list.length * 100
      const row = { rid: c.rid, lane, ts: c.ts, ctx, comp: { system: 250, user: ctx - 250 }, usage: c.status === 200 ? { input: ctx, output: 80, cache_read: 0, cache_write: 0 } : null,
        tools: 0, status: c.status, rec: { id: c.rid, request: { model: 'm' } },
        wire: { cacheSemanticsKnown: true, contextState: 'complete', contextMissing: 0, reqEncoding: 'identity', labels: [] } }
      if (c.status !== 200) Object.assign(row, { error: 'overloaded_error', errMsg: 'Overloaded' })
      if (lane === c.rid) row.cacheBreak = { cause: 'first', attribution: 'none', idx: 0, refRid: null, gt: null, firstCall: true }
      rows.set(c.rid, row)
      if (c.event) events.push({ type: c.event, rid: c.rid, lane })
    }
    for (const [l, cs] of members) {
      const key = keyOf.get(l)
      laneCalls.set(key, cs)
      lanes.set(key, { lane: key, kind: l ? 'subagent' : 'main', icon: l ? 'agent' : 'main', label: l ? `Agent ${l}` : 'Main', task: '', count: cs.length,
        first: cs[0].rid, last: cs.at(-1).rid, peakCtx: Math.max(...cs.map((c) => rows.get(c.rid).ctx)), spawnRid: null,
        parent: l && mainKey !== key ? mainKey : null, flagged: false })
    }
    return { mark: M, rows, events, lanes, laneCalls }
  }

  const head = (d) => ({ schema: 2, command: 'session', ok: true, errors: [], truncated: null, meta: { session_id: 'S', harness: 'claude-code', title: 'World' },
    stats: { calls: d.rows.size, lanes: d.lanes.size }, logged: 0, probes: 0 })
  const recordsOf = (d, rids) => rids.map((rid) => ({ id: rid, ts_request: d.rows.get(rid).ts, is_llm_call: true, response: { status: d.rows.get(rid).status } }))

  function full(M = now) {
    const d = docAt(M), calls = [...d.rows.values()]
    return { ...head(d), base: null, mark: M, more: false, lanes: [...d.lanes.values()], calls, events: d.events,
      records: recordsOf(d, calls.map((c) => c.rid)) }
  }

  function since(M, at = now) {
    if (!marks.includes(M) || marks.indexOf(M) > marks.indexOf(at)) return full(at)
    const o = docAt(M), d = docAt(at), same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const calls = [...d.rows.values()].filter((row) => !same(o.rows.get(row.rid), row)), rids = new Set(calls.map((c) => c.rid))
    return { ...head(d), base: M, mark: at, calls, gone: [...o.rows.keys()].filter((rid) => !d.rows.has(rid)),
      lanes: [...d.lanes.values()].filter((h) => !same(o.lanes.get(h.lane), h)), lanes_gone: [...o.lanes.keys()].filter((k) => !d.lanes.has(k)),
      events: d.events.filter((e) => rids.has(e.rid)), records: recordsOf(d, calls.map((c) => c.rid)) }
  }

  function lane(key, { from, to } = {}, at = now) {
    const d = docAt(at), cs = d.laneCalls.get(key) || [], idx = (rid) => cs.findIndex((c) => c.rid === rid)
    let lo, hi, base = null
    if (from != null && idx(from) >= 0) { base = from; lo = idx(from) + 1; hi = Math.min(cs.length, lo + page) }
    else if (from == null && to != null && idx(to) >= 0) { hi = idx(to); lo = Math.max(0, hi - page) }
    else { hi = cs.length; lo = Math.max(0, hi - page) }
    const steps = cs.slice(lo, hi).map((c, j) => {
      const p = cs[lo + j - 1], key0 = j === 0 && base === null
      const ops = key0 ? [[1, ...c.list]] : encode(p.list, c.list), attrs = {}
      let pos = 0
      for (const op of ops) {
        if (op[0] === 0) { pos += op[2]; continue }
        for (const b of op.slice(1)) { if (attrsOf.has(b)) attrs[pos] = attrsOf.get(b); pos++ }
      }
      return { rid: c.rid, parent: p ? p.rid : null, ops, reply: c.reply, attrs,
        detail: { norm: { stop_reason: 'end_turn', usage: null }, respRefs: [], nonBlockKeys: {}, extraMessages: [], wire: { reqEncoding: 'identity' } } }
    })
    const page_ = cs.slice(lo, hi), refs = (c) => [...c.list, ...c.reply]
    const before = new Set(base === null ? [] : cs.slice(0, lo).flatMap(refs))
    const used = [...new Set(page_.flatMap(refs))].filter((b) => !before.has(b))
    const rids = new Set(page_.map((c) => c.rid))
    return { schema: 2, command: 'lane', ok: true, errors: [], lane: key, base, mark: at, steps, defs: used.map((b) => defs.get(b)),
      resources: page_.filter((c) => c.res).map((c) => ({ key: c.res, segments: [{ enter: c.rid, evict: null }], loads: [{ rid: c.rid, range: null, via: 'Read' }] })),
      seen: page_.filter((c) => c.res).map((c) => ({ path: c.res.slice(5), firstRid: c.rid, count: 1 })),
      events: d.events.filter((e) => rids.has(e.rid)),
      prev: lo > 0 && hi > lo ? cs[lo].rid : null, next: hi < cs.length && hi > lo ? cs[hi - 1].rid : null }
  }

  /** get(name, params) as the board's api would answer it, at mark `at`. */
  const get = (at = now) => async (name, p = {}) => name === 'session'
    ? (p.since != null ? since(p.since, at) : full(at))
    : lane(p.lane, { from: p.from, to: p.to }, at)

  return { seed, marks, now, page, full, since, lane, get,
    list: (rid) => byRid.get(rid).list,
    laneRidsAt: (at = now) => new Map([...docAt(at).laneCalls].map(([k, cs]) => [k, cs.map((c) => c.rid)])) }
}

/** Read lane `q` ({lane, from?, to?}) to its end: a page with a base goes on by `next`, one without by `prev`. */
export async function readLane(get, id, desk, q) {
  let p = await get('lane', { id, ...q })
  applyLane(desk, p)
  const forward = p.base !== null
  while (forward ? p.next : p.prev) {
    p = await get('lane', forward ? { id, lane: q.lane, from: p.next } : { id, lane: q.lane, to: p.prev })
    applyLane(desk, p)
  }
  return desk
}

/** A desk as the board builds it: `session` (older pages while `more`), then every lane, page by page. */
export async function deskFrom(get, id) {
  const desk = createDesk()
  let a = await get('session', { id })
  applySession(desk, a)
  while (a.more) { a = await get('session', { id, before: desk.order[0] }); applySession(desk, a, { before: true }) }
  for (const key of desk.lanes.keys()) await readLane(get, id, desk, { lane: key })
  return desk
}

/**
 * A desk from hand-made lanes, for renderer tests: `lanes` = [{kind, head?, rows: [row fields], blocks?: [[block] per row]
 * (absent = the lane is not held), resources?, seen?, events?}]. Rows get rids `R<lane>-<i>` and increasing ts in the order
 * given; a block's `query` / `volatile` travel as position attrs and `key` as its content key `fh` (3.5 §会话读).
 */
export function deskOf(lanes, { events = [], ...answer } = {}) {
  const T0 = Date.parse('2026-10-07T00:00:00.000Z')
  let t = 0, bn = 0
  const heads = [], calls = [], reads = []
  lanes.forEach((l, li) => {
    const rids = l.rows.map((_, i) => `R${li}-${i}`), key = rids[0]
    const rows = l.rows.map((r, i) => ({ rid: rids[i], lane: key, ts: new Date(T0 + (t++) * 5000).toISOString(), ctx: 100, tools: 0, status: 200, rec: { request: { model: 'm' } }, ...r }))
    calls.push(...rows)
    heads.push({ lane: key, kind: l.kind, icon: '', label: l.kind, task: '', count: rows.length, first: key, last: rids.at(-1), peakCtx: 100, spawnRid: null, parent: null, flagged: false, ...l.head })
    if (!l.blocks) return
    const defs = [], steps = l.blocks.map((bs, i) => {
      const ids = [], attrs = {}
      bs.forEach(({ query, volatile, key: fh, ...d }, p) => {
        const bid = `b${bn++}`
        defs.push({ ...d, bid, fh: fh ?? bid })
        ids.push(bid)
        if (query != null || volatile != null) attrs[p] = { query, volatile }
      })
      return { rid: rids[i], parent: null, ops: [[1, ...ids]], reply: [], attrs, detail: null }
    })
    reads.push({ lane: key, base: null, steps, defs, resources: l.resources || [], seen: l.seen || [], events: l.events || [], prev: null, next: null })
  })
  const desk = createDesk()
  applySession(desk, { base: null, mark: calls.at(-1)?.rid ?? null, more: false, meta: { session_id: 'S' }, lanes: heads, calls, events, errors: [], ...answer })
  for (const a of reads) applyLane(desk, a)
  return desk
}
