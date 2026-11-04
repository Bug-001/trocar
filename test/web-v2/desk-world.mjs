// test/web-v2/desk-world.mjs — a generated session world and a reference server over it (RFC 3.5 §会话读), exports only.
//
// world(seed[, {calls, cut, page, spage, files, talk, compact, heads}]): 2-5 lanes (main + sub-agents), calls written in arrival order whose ts sometimes sorts before rows already
// written (late rows), relanes and gone rows carried by later members, and per-step bid lists drawn by appends, mid-list
// inserts, replacements and compactions. Each call draws lane events (user · tool · compaction on a compacted list ·
// summarize), opened resources and raw `seen` paths (opened ones, their absolute spelling, the same name in another dir).
// The server answers `session` (full / --since) and `lane` (tail / --from / --to / --ledger) at any member mark with the key
// sets of test/fixtures/session-read-contract.json, by 3.5 §会话读's rules: pages bounded by `room` units (a step or a ledger
// entry is one), the ledger in key order filling what the steps leave and named on by `ledger_next`, `k` on user events,
// defs against the base step; ops are a greedy copy/add encoding.
// `compact` (≤ 0.35, default 0.15): the share of a lane's later calls whose list is compacted.
// `spage` (opt-in): the session's skeleton comes in pages of that many rows, newest first — `session` answers the newest, `--before R`
// the ones before R in step order — with `more` as it is; without it a `session` answer holds every row.
// `talk: {pre, len, every, tail}` (opt-in; without it the world is the same for every seed): a long main conversation. Most calls
// are the main lane's (the last one always); its lists start from `pre` system/tools blocks and grow by appends only, evenly, to
// `len` blocks at its last step (no compaction, no late rows, no relane or gone); a human prompt (attr `query`) opens a turn every
// `every` message blocks, and the last `tail` message blocks are one turn. The other lanes are drawn as without it.
// `heads` (opt-in; without it every head is `text`, labelled `text`): each block's head drawn from a stream of its own (the world is
// otherwise the same) — a tag of the closed set, no, a short or a long label (its preview too), a declared cache mark on some and a
// fidelity that is not verbatim on some, so rows carry marks or none and labels of any length.
// deskFrom(get, id) reads `session`, every lane's tail and then its older pages, then the lane's ledger chain.
import { createHash } from 'node:crypto'
import { createDesk, applySession, applyLane, readLedger } from '../../web/legacy/replay/model.mjs'

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

export function world(seed, { calls: count, cut: cuts = false, page: pageSize, spage, files: fileCount = 5, talk = null, compact = 0.15, heads = false } = {}) {
  const r = rng(seed), int = (a, b) => a + Math.floor(r() * (b - a + 1)), hr = heads && rng(~seed), hpick = (xs) => xs[Math.floor(hr() * xs.length)]
  const nLanes = int(2, 5), n = count ?? int(18, 40), page = pageSize ?? int(3, 7), room = page + int(0, 3), lroom = pageSize ?? int(1, 3)
  const files = Array.from({ length: fileCount }, (_, j) => `src/f${j}.mjs`), pick = (xs) => xs[int(0, xs.length - 1)]
  // a seen path: an opened file as written, its absolute spelling, the same name in another dir, or a name never opened
  const spell = (p) => pick([p, `/w/proj/${p}`, p.replace('src/', 'lib/'), `docs/n${int(0, 3)}.md`])
  const unknown = seed % 3 === 0 ? { records: 1, reason: 'No registered dissector reads this record as a call.', endpoints: ['/v1/x'] } : null
  const T0 = Date.parse('2026-10-21T10:00:00.000Z')
  let bn = 0
  const defs = new Map(), attrsOf = new Map()
  const bid = (sec, role) => {
    const b = createHash('sha256').update(`${seed}:${bn++}`).digest('base64url').slice(0, 22)
    const fh = createHash('sha256').update(`fh:${b}`).digest('base64url').slice(0, 22)
    defs.set(b, { bid: b, fh, ref: `s/x#b${bn}::0-10`, sec, role, kind: 'text', ff: { faithfulness: 'verbatim' }, head: { role, tag: 'text', label: 'text' },
      preview: b.slice(0, 8), chars: 8, bytes: 10, r: { as: 'markdown' } })
    if (hr) {
      const label = hpick(['', 'a short label', `a long label ${'that runs on '.repeat(40)}`])
      Object.assign(defs.get(b), { head: { role, tag: hpick(['text', 'thinking', 'action · Read', 'observation · error']), label }, preview: label },
        hr() < 0.3 ? { cc: { type: 'ephemeral' } } : {}, hr() < 0.3 ? { ff: { faithfulness: hpick(['metadata', 'truncated']) } } : {})
    }
    const x = r()
    if (x < 0.15) attrsOf.set(b, { query: true }); else if (x < 0.25) attrsOf.set(b, { volatile: true })
    return b
  }
  const shared = [bid('system', 'system'), bid('tools', 'system')]
  const T = talk && (() => {
    const lanes = Array.from({ length: n }, (_, i) => (i < nLanes ? i : i === n - 1 || r() < 0.85 ? 0 : int(1, nLanes - 1)))
    const M = lanes.filter((l) => l === 0).length, N = talk.len - talk.pre, q0 = N - (talk.tail || 0)
    const tag = (b, q) => { if (q) attrsOf.set(b, { query: true }); else attrsOf.delete(b); return b }
    const msg = (m) => { const q = m === q0 || (m < q0 && m % talk.every === 0); return tag(bid('messages', q || m % 2 ? 'user' : 'assistant'), q) }
    return { lanes, M, N, msg, j: 0, m: 0, pre: Array.from({ length: talk.pre }, (_, j) => tag(bid(j ? 'tools' : 'system', 'system'), false)) }
  })()
  const last = []  // the list of the previous ARRIVED call of each lane
  const calls = []
  for (let i = 0; i < n; i++) {
    const lane = T ? T.lanes[i] : i < nLanes ? i : int(0, nLanes - 1)
    const talking = T && lane === 0
    let list = talking ? [...(last[0] || T.pre)] : last[lane] ? [...last[lane]] : [...shared, bid('messages', 'user')], compacted = false
    if (talking) for (const c = Math.max(1, Math.floor((T.N * ++T.j) / T.M)); T.m < c;) list.push(T.msg(T.m++))
    else if (last[lane]) {
      const kind = r()
      if (kind < 0.45) for (let k = int(1, 3); k; k--) list.push(bid('messages', k % 2 ? 'assistant' : 'user'))
      else if (kind < 0.65) list.splice(int(1, list.length), 0, bid('messages', 'user'))
      else if (kind < 1 - compact) list[int(0, list.length - 1)] = bid('messages', 'user')
      else { list = [...list.slice(0, int(1, 2)), bid('messages', 'user')]; compacted = true }
    }
    last[lane] = list
    const late = !T && i > 2 && r() < 0.3
    const ts = new Date(T0 + (late ? (i - int(1, 6)) * 1000 + int(0, 999) : i * 1000)).toISOString()
    const effects = []
    if (!T && i > 3 && r() < 0.15) effects.push({ kind: 'relane', at: int(0, i - 1), lane: int(0, nLanes - 1) })
    if (!T && i > 3 && r() < 0.1) effects.push({ kind: 'gone', at: int(0, i - 1) })
    calls.push({ rid: `20261021T101500Z:${1000 + i}`, lane, ts, list, reply: Array.from({ length: int(0, 2) }, () => bid('messages', 'assistant')),
      status: r() < 0.1 ? 529 : 200, effects,
      evs: [...(r() < 0.35 ? ['user'] : []), ...(r() < 0.2 ? ['tool'] : []), ...(compacted ? ['compaction'] : []), ...(r() < 0.08 ? ['summarize'] : [])],
      res: r() < 0.3 ? [{ kind: r() < 0.8 ? 'file' : 'skill', label: pick(files) }] : [],
      seen: r() < 0.4 ? Array.from({ length: int(1, 3) }, () => spell(pick(files))) : [] })
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
      for (const type of c.evs) events.push({ type, rid: c.rid, lane })
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

  // a lane's ledger after steps `cs` (step order), as [list, key, entry] in the wire's key order (3.5: resources by
  // kind::label, then seen by path, code-unit order)
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  function ledgerOf(cs) {
    const res = new Map(), seen = new Map()
    for (const c of cs) {
      for (const x of c.res) {
        const k = `${x.kind}::${x.label}`
        const e = res.get(k) || res.set(k, { kind: x.kind, label: x.label, via: 'Read', hits: 0, segments: [{ enter: c.rid, evict: null }], loads: [] }).get(k)
        e.hits++; e.loads.push({ rid: c.rid, range: null, via: 'Read' })
      }
      for (const p of c.seen) { const e = seen.get(p) || seen.set(p, { path: p, firstRid: c.rid, count: 0 }).get(p); e.count++ }
    }
    return [...[...res].sort((a, b) => cmp(a[0], b[0])).map(([k, e]) => [0, k, e]), ...[...seen].sort((a, b) => cmp(a[0], b[0])).map(([k, e]) => [1, k, e])]
  }
  const LISTS = ['resources', 'seen']
  // the first `n` owed entries; `ledger_next` names the last one shipped when some are left
  function pack(owed, n) {
    const out = owed.slice(0, n), last = out.at(-1)
    return { resources: out.filter((x) => x[0] === 0).map((x) => x[2]), seen: out.filter((x) => x[0] === 1).map((x) => x[2]),
      ledger_next: n < owed.length ? Buffer.from(JSON.stringify(last ? [LISTS[last[0]], last[1]] : ['resources', ''])).toString('base64url') : null }
  }
  // a lane's events at a mark, `k` on user events (its ordinal among the lane's user events in step order, from 1)
  function laneEventsOf(key, cs) {
    let k = 0
    return cs.flatMap((c) => c.evs.map((type) => ({ type, rid: c.rid, lane: key, ...(type === 'user' ? { k: ++k } : null) })))
  }

  const head = (d) => ({ schema: 2, command: 'session', ok: true, errors: [], truncated: null, meta: { session_id: 'S', harness: 'claude-code', title: 'World' },
    stats: { calls: d.rows.size, lanes: d.lanes.size }, logged: 0, probes: 0 })
  const recordsOf = (d, rids) => rids.map((rid) => ({ id: rid, ts_request: d.rows.get(rid).ts, is_llm_call: true, response: { status: d.rows.get(rid).status } }))

  // `unknown` (3.5 §会话读) holds from the middle mark on: a full answer carries it only where it holds; a delta only where it differs from M's
  const unknownAt = (M) => (unknown && marks.indexOf(M) >= marks.length >> 1 ? unknown : null)
  // `cut` (opt-in): from the mark 3/4 in, the session is cut before its third row in step order then; a mark names its cut
  // (`rid@cut`), and a delta across a moved cut is the full document (3.5 §会话读). A cut document leaves out rows before it.
  const cutRid = cuts ? [...docAt(marks[(marks.length * 3) >> 2]).rows.values()].sort(stepCmp)[2].rid : null
  const cutAt = (M) => (cutRid && marks.indexOf(M) >= (marks.length * 3) >> 2 ? cutRid : null)
  const markOf = (M) => (cutAt(M) ? `${M}@${cutAt(M)}` : M)
  function sdoc(M) {
    const d = docAt(M), c = cutAt(M)
    if (!c) return d
    const keep = (rid) => stepCmp(d.rows.get(rid), d.rows.get(c)) >= 0
    return { ...d, rows: new Map([...d.rows].filter(([rid]) => keep(rid))), events: d.events.filter((e) => keep(e.rid)) }
  }
  // the rows before `before` in step order (all of them without it), the last `limit` of them when paged
  function full(M = now, { before = null, limit = spage } = {}) {
    const d = sdoc(M), u = unknownAt(M)
    let rows = [...d.rows.values()]
    if (before != null) { const b = d.rows.get(before); rows = b ? rows.filter((r) => stepCmp(r, b) < 0) : [] }
    const calls = limit ? rows.slice(Math.max(0, rows.length - limit)) : rows, ids = new Set(calls.map((c) => c.rid))
    return { ...head(d), base: null, mark: markOf(M), more: calls.length < rows.length, ...(u ? { unknown: u } : null), lanes: [...d.lanes.values()], calls,
      events: calls.length < d.rows.size ? d.events.filter((e) => ids.has(e.rid)) : d.events, records: recordsOf(d, calls.map((c) => c.rid)) }
  }

  function since(M, at = now) {
    const [m, c = null] = String(M).split('@')
    if (!marks.includes(m) || marks.indexOf(m) > marks.indexOf(at) || c !== cutAt(m) || c !== cutAt(at)) return full(at)
    const o = sdoc(m), d = sdoc(at), same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const calls = [...d.rows.values()].filter((row) => !same(o.rows.get(row.rid), row)), rids = new Set(calls.map((c) => c.rid))
    return { ...head(d), base: M, mark: markOf(at), ...(unknownAt(M) !== unknownAt(at) ? { unknown: unknownAt(at) } : null), calls, gone: [...o.rows.keys()].filter((rid) => !d.rows.has(rid)),
      lanes: [...d.lanes.values()].filter((h) => !same(o.lanes.get(h.lane), h)), lanes_gone: [...o.lanes.keys()].filter((k) => !d.lanes.has(k)),
      events: d.events.filter((e) => rids.has(e.rid)), records: recordsOf(d, calls.map((c) => c.rid)) }
  }

  function lane(key, { from, to, ledger } = {}, at = now) {
    const d = docAt(at), cs = d.laneCalls.get(key) || [], idx = (rid) => cs.findIndex((c) => c.rid === rid), L = ledgerOf(cs)
    const answer = (o) => ({ schema: 2, command: 'lane', ok: true, errors: [], lane: key, base: null, mark: at, steps: [], defs: [], resources: [], seen: [],
      events: [], prev: null, next: null, ledger_next: null, ...o })
    if (ledger != null) {
      const [list, after] = JSON.parse(Buffer.from(ledger, 'base64url').toString('utf8')), j = LISTS.indexOf(list)
      return answer(pack(L.filter(([jj, kk]) => jj > j || (jj === j && kk > after)), lroom))
    }
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
    // defs: what the page's steps use that the base step's list and reply do not hold (a block that left and came back is sent again)
    const before = new Set(base === null ? [] : refs(cs[idx(base)]))
    const used = [...new Set(page_.flatMap(refs))].filter((b) => !before.has(b))
    const rids = new Set(page_.map((c) => c.rid))
    const CS = (e) => e.type === 'compaction' || e.type === 'summarize'
    const events = laneEventsOf(key, cs).filter((e) => rids.has(e.rid) || (base === null && CS(e)))
    // the ledger owed: all of it at base:null; at --from what is new at mark or differs from the ledger replayed to the base step
    const atBase = base === null ? new Map() : new Map(ledgerOf(cs.slice(0, idx(base) + 1)).map(([j, k, e]) => [`${j}:${k}`, JSON.stringify(e)]))
    const owed = base === null ? L : L.filter(([j, k, e]) => atBase.get(`${j}:${k}`) !== JSON.stringify(e))
    return answer({ base, steps, defs: used.map((b) => defs.get(b)), events, ...pack(owed, Math.max(0, room - steps.length)),
      prev: lo > 0 && hi > lo ? cs[lo].rid : null, next: hi < cs.length && hi > lo ? cs[hi - 1].rid : null })
  }

  // ── the answer files at mark `at` (3.5 session --head, lane --pack / --tail): members in arrival order, `P` to a pack; a rid lives in
  // the file of its own arrival span, `main` = the axis (main) lane's lines, `rest` the others; every lane head in the open tail. → {head, pack(n, part) → text, open(part) →
  // [[rid | `l:<lane>`, lines]] (the open span's rendering, one entry per rid and per lane head: serveWorld appends the changed ones to its tail)}
  function answerFiles(at = now, P = 64) {
    const d = docAt(at), k = marks.indexOf(at) + 1, sealed = Math.floor(k / P), arrival = new Map(calls.map((c, j) => [c.rid, j]))
    const axis = [...d.lanes.values()].find((h) => h.kind === 'main')?.lane ?? null, mainCs = d.laneCalls.get(axis) || []
    const evs = new Map(), place = new Map()
    for (const [key, cs] of d.laneCalls) { for (const e of laneEventsOf(key, cs)) (evs.get(e.rid) || evs.set(e.rid, []).get(e.rid)).push(e); cs.forEach((c, i) => place.set(c.rid, [key, i])) }
    const spanOf = (rid) => Math.floor(arrival.get(rid) / P), partOf = (key) => (key === axis ? 'main' : 'rest')
    const fileOf = new Map() // `${n}.${part}` → {rids (step order), heads}
    const into = (n, part) => fileOf.get(`${n}.${part}`) || fileOf.set(`${n}.${part}`, { rids: [], heads: [] }).get(`${n}.${part}`)
    for (const [key, cs] of d.laneCalls) {
      for (const c of cs) into(spanOf(c.rid), partOf(key)).rids.push(c.rid)
      into(sealed, partOf(key)).heads.push(d.lanes.get(key)) // a lane head lives in the open tail only (3.5 `{l}`)
    }
    // the lines of a file: its lane heads, then per rid (step order) its row, the definitions it meets first, its step, its record
    const linesOf = (f) => {
      const out = f.heads.map((h) => [`l:${h.lane}`, [{ l: h }]]), sent = new Set(), prevIn = new Map()
      for (const rid of f.rids) {
        const c = byRid.get(rid), [key, i] = place.get(rid), p = prevIn.get(key) ?? null
        prevIn.set(key, c)
        const ops = p ? encode(p.list, c.list) : [[1, ...c.list]], attrs = {}
        let pos = 0
        for (const op of ops) { if (op[0] === 0) { pos += op[2]; continue } for (const b of op.slice(1)) { if (attrsOf.has(b)) attrs[pos] = attrsOf.get(b); pos++ } }
        const ds = [...c.list, ...c.reply].filter((b) => !sent.has(b) && sent.add(b)).map((b) => ({ d: defs.get(b) }))
        out.push([rid, [{ c: d.rows.get(rid) }, ...ds, { s: { rid, lane: key, i, parent: p ? p.rid : null, ops, reply: c.reply, attrs, events: evs.get(rid) || [],
          detail: { norm: { stop_reason: 'end_turn', usage: null }, respRefs: [], nonBlockKeys: {}, extraMessages: [], wire: { reqEncoding: 'identity' } } } },
        { r: recordsOf(d, [rid])[0] }]])
      }
      return out
    }
    const text = (doc, f) => [doc, ...linesOf(f).flatMap(([, ls]) => ls)].map((x) => JSON.stringify(x) + '\n').join('')
    const docHead = (o) => ({ schema: 2, command: 'lane', ok: true, errors: [], v: 1, id: 'S', ...o })
    const span = (n) => { const is = (fileOf.get(`${n}.main`)?.rids || []).map((rid) => place.get(rid)[1]); return is.length ? [Math.min(...is), Math.max(...is) + 1] : [0, 0] }
    const packs = Array.from({ length: sealed }, (_, n) => {
      const [s0, s1] = span(n), t = ['main', 'rest'].map((part) => text(docHead({ pack: { n, part, s0, s1 } }), fileOf.get(`${n}.${part}`) || { rids: [], heads: [] })).join('')
      return { n, s0, s1, tag: createHash('sha1').update(t).digest('hex').slice(0, 16) }
    })
    const openS0 = Math.min(mainCs.length, ...((fileOf.get(`${sealed}.main`)?.rids || []).map((rid) => place.get(rid)[1])))
    const cuts = mainCs.flatMap((c, i) => (i && c.evs.includes('compaction') ? [i] : [])), ends = [0, ...cuts, mainCs.length]
    const head = { schema: 2, command: 'session', ok: true, errors: [], v: 1, id: 'S', tier: 1, mark: at, markTs: byRid.get(at).ts, pending: null, truncated: null, failed: 0,
      meta: { session_id: 'S', harness: 'claude-code', title: 'World' }, stats: { calls: d.rows.size, lanes: d.lanes.size }, logged: 0, probes: 0,
      ...(unknownAt(at) ? { unknown: unknownAt(at) } : null), axis, steps: mainCs.length, peak: Math.max(0, ...mainCs.map((c) => d.rows.get(c.rid).ctx)), cols: '', bucket: 1,
      chapters: ends.slice(1).map((s1, j) => ({ k: j, s0: ends[j], s1, rid0: mainCs[ends[j]]?.rid ?? null, ts0: mainCs[ends[j]]?.ts ?? null, ts1: mainCs[s1 - 1]?.ts ?? null, inferred: false, peakCtx: 0 })).filter((c) => c.s1 > c.s0),
      packs, open: { n: sealed, s0: openS0 }, lanes: [...d.lanes.values()], lanesMore: 0, last: mainCs.length ? { rid: mainCs.at(-1).rid, n: mainCs.at(-1).list.length } : null }
    return { head, docHead,
      pack: (n, part) => (n < sealed ? text(docHead({ pack: { n, part, s0: packs[n].s0, s1: packs[n].s1 } }), fileOf.get(`${n}.${part}`) || { rids: [], heads: [] }) : null),
      open: (part) => linesOf(fileOf.get(`${sealed}.${part}`) || { rids: [], heads: [] }) }
  }

  /** get(name, params) as the board's api would answer it, at mark `at`. */
  const get = (at = now) => async (name, p = {}) => name === 'session'
    ? (p.since != null ? since(p.since, at) : full(at, { before: p.before ?? null }))
    : lane(p.lane, { from: p.from, to: p.to, ledger: p.ledger }, at)

  return { seed, marks, now, page, full, since, lane, get, files: answerFiles,
    list: (rid) => byRid.get(rid).list,
    /** lane `key`'s whole ledger at mark `at`: {resources, seen} in key order */
    ledgerAt: (key, at = now) => pack(ledgerOf(docAt(at).laneCalls.get(key) || []), Infinity),
    /** lane `key`'s events at mark `at`, in step order, `k` on user events */
    eventsAt: (key, at = now) => laneEventsOf(key, docAt(at).laneCalls.get(key) || []),
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

/** A desk as the board builds it: `session` (older pages while `more`), then every lane's tail and older pages, then its ledger chain. */
export async function deskFrom(get, id) {
  const desk = createDesk()
  let a = await get('session', { id })
  applySession(desk, a)
  // an answer at the reduction frontier (`pending`) is followed by --since its mark until one comes without it, as the board's poll does (3.5:43)
  for (let d = a; d.pending;) { d = await get('session', { id, since: d.mark }); applySession(desk, d) }
  while (a.more) { a = await get('session', { id, before: desk.order[0] }); applySession(desk, a, { before: true }) }
  const read = async (name, p) => ({ ok: true, data: await get(name, { id, ...p }) })
  for (const key of desk.lanes.keys()) { await readLane(get, id, desk, { lane: key }); await readLedger(desk, key, read) }
  return desk
}

/**
 * A desk from hand-made lanes, for renderer tests: `lanes` = [{kind, head?, rows: [row fields], blocks?: [[block] per row]
 * (absent = the lane is not held), replies?: [[reply def] per row], details?: [detail per row], resources?, seen?, events?}]. Rows get rids `R<lane>-<i>` and increasing ts in the order
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
      bs.forEach(({ query, volatile, key: fh, bid: given, ...d }, p) => {
        const bid = given ?? `b${bn++}`
        defs.push({ ...d, bid, fh: fh ?? bid })
        ids.push(bid)
        if (query != null || volatile != null) attrs[p] = { query, volatile }
      })
      const reply = (l.replies?.[i] || []).map((d) => { const bid = d.bid ?? `b${bn++}`; defs.push({ sec: 'messages', role: 'assistant', ...d, bid, fh: d.fh ?? bid }); return bid })
      return { rid: rids[i], parent: null, ops: [[1, ...ids]], reply, attrs, detail: l.details?.[i] ?? null }
    })
    reads.push({ lane: key, base: null, steps, defs, resources: l.resources || [], seen: l.seen || [], events: l.events || [], prev: null, next: null })
  })
  const desk = createDesk()
  applySession(desk, { base: null, mark: calls.at(-1)?.rid ?? null, more: false, meta: { session_id: 'S' }, lanes: heads, calls, events, errors: [], ...answer })
  for (const a of reads) applyLane(desk, a)
  return desk
}
