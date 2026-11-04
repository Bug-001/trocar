// test/web-v2/replay-packs.test.mjs — the desk fed by pack and tail files (RFC 3.5 §会话读 `lane --pack` / `lane --tail`):
// files loaded in any order give the desk of the session at mark. The reference session is desk-world's (late rows before a
// lane's tip, relanes, gone rows, compactions; `talk` for lists up to 1,400 bids); the renderer below writes its files by the
// spec's line rules (it is the format, not product code): pack n = the members at write positions [P·n, P·(n+1)), main = the
// main lane's, rest = the others; `parent` = the previous step of its lane in the same file; defs once per file before the
// first step using them; `l` lines only in a tail: every head of its part when it is written whole (at its seal), then the heads that
// change (appended at each change); a pack has none. The tail is appended mark by mark: a changed row / step / record is written again, a
// rid that stops being a call of the part gets `g`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDesk, listOf, stepOf, indexOf, ridAt, laneEvents } from '../../web/legacy/replay/model.mjs'
import { parseLines, applyFile, applyHead } from '../../web/legacy/replay/packs.mjs'
import { behindOf } from '../../web/legacy/replay/header.mjs'
import { world } from './desk-world.mjs'

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const text = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const J = JSON.stringify

function rng(seed) {
  let a = (seed * 2654435761) >>> 0 || 1
  return () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return (a >>> 0) / 4294967296 }
}

// greedy copy/add ops (3.5): the longest run of the parent's list at each point is copied, the rest is added
function encode(P, C) {
  const at = new Map()
  P.forEach((b, i) => at.has(b) || at.set(b, i))
  const ops = []
  for (let i = 0; i < C.length;) {
    const s = at.get(C[i])
    let l = 0
    if (s != null) while (s + l < P.length && i + l < C.length && P[s + l] === C[i + l]) l++
    if (l) { ops.push([0, s, l]); i += l; continue }
    const last = ops.at(-1)
    if (last?.[0] === 1) last.push(C[i]); else ops.push([1, C[i]])
    i++
  }
  return ops
}

function session(seed, opts, P) {
  const w = world(seed, { page: 1e6, ...opts }), { marks } = w
  const defs = new Map(), attr = new Map(), memo = new Map()
  // the document at mark index j: rows, heads, lane rids, and per rid its whole-lane step (reply, detail; attrs per bid)
  const at = (j) => {
    if (memo.has(j)) return memo.get(j)
    const M = marks[j], doc = w.full(M), laneRids = w.laneRidsAt(M), steps = new Map()
    for (const h of doc.lanes) {
      const a = w.lane(h.lane, {}, M)
      for (const d of a.defs) defs.set(d.bid, d)
      for (const s of a.steps) {
        steps.set(s.rid, s)
        let pos = 0
        for (const [op, ...xs] of s.ops) if (op === 0) pos += xs[1]; else for (const b of xs) { if (s.attrs[pos]) attr.set(b, s.attrs[pos]); pos++ }
      }
    }
    const d = { M, rows: new Map(doc.calls.map((r) => [r.rid, r])), heads: new Map(doc.lanes.map((h) => [h.lane, h])), laneRids, steps, doc }
    memo.set(j, d)
    return d
  }
  const partOfHead = (h) => (h.kind === 'main' ? 'main' : 'rest')
  const partOf = (d, rid) => (d.rows.has(rid) && partOfHead(d.heads.get(d.rows.get(rid).lane)) === 'main' ? 'main' : 'rest')
  // a part's rows, steps and records over members `mem` at mark index j
  function render(j, mem, part) {
    const d = at(j), mine = mem.filter((rid) => partOf(d, rid) === part), live = new Set(mine.filter((rid) => d.rows.has(rid)))
    const c = new Map(), s = new Map(), r = new Map()
    for (const rid of mine) {
      const row = d.rows.get(rid)
      r.set(rid, { id: rid, ts_request: row?.ts ?? '', is_llm_call: !!row, response: { status: row?.status ?? 200 } })
      if (!row) continue
      c.set(rid, row)
      const lr = d.laneRids.get(row.lane), i = lr.indexOf(rid)
      let p = i - 1
      while (p >= 0 && !live.has(lr[p])) p--
      const parent = p >= 0 ? lr[p] : null, list = w.list(rid)
      const ops = parent ? encode(w.list(parent), list) : [[1, ...list]], attrs = {}
      let pos = 0
      for (const [op, ...xs] of ops) if (op === 0) pos += xs[1]; else for (const b of xs) { if (attr.has(b)) attrs[pos] = attr.get(b); pos++ }
      const ws = d.steps.get(rid)
      s.set(rid, { rid, lane: row.lane, i, parent, ops, reply: ws.reply, attrs, detail: ws.detail,
        events: w.eventsAt(row.lane, d.M).filter((e) => e.rid === rid) })
    }
    return { c, s, r }
  }
  // lanes whose head changed at a mark in [lo, hi), as they are at hi - 1
  const changedHeads = (lo, hi, part) => {
    const keys = new Set()
    for (let j = lo; j < hi; j++) for (const [k, h] of at(j).heads) if (J(h) !== J(j ? at(j - 1).heads.get(k) : null)) keys.add(k)
    return [...keys].map((k) => at(hi - 1).heads.get(k)).filter((h) => h && partOfHead(h) === part)
  }
  const allHeads = (j, part) => [...at(j).heads.values()].filter((h) => partOfHead(h) === part)
  const docHead = (o) => ({ schema: 2, command: 'lane', ok: true, errors: [], v: 1, id: 'S', ...o })
  // pack n (part) with its rows and steps as at mark index j
  function pack(n, part, j, fail) {
    const lo = P * n, hi = P * (n + 1), mem = marks.slice(lo, hi), R = render(j, mem, part), out = [docHead({ pack: { n, part, s0: lo, s1: hi } })]
    const sent = new Set()
    for (const rid of mem) {
      if (R.c.has(rid)) out.push({ c: R.c.get(rid) })
      const s = R.s.get(rid)
      if (!s) continue
      for (const b of [...w.list(rid), ...s.reply]) if (!sent.has(b)) { sent.add(b); out.push({ d: defs.get(b) }) }
      out.push({ s })
    }
    for (const r of R.r.values()) out.push({ r })
    if (fail && mem.length) out.push({ x: { where: mem[0], code: fail, reason: 'unreadable member' } })
    return out
  }
  // tail n (part) as appended through mark index `upTo`; a ghost (a copy of its first row, `g` once the tail reaches mark) and, at
  // the end, every step again as a keyframe are the tail's overriding lines
  const ghosts = new Set()
  const keyframe = (s) => {
    const list = w.list(s.rid), attrs = {}
    list.forEach((b, i) => attr.has(b) && (attrs[i] = attr.get(b)))
    return { ...s, parent: null, ops: [[1, ...list]], attrs }
  }
  function tail(n, part, upTo) {
    const lo = P * n, out = [docHead({ tail: { n, part, s0: lo } })], last = new Map(), sent = new Set()
    let ghost = null
    if (lo > 0) out.push(...allHeads(lo - 1, part).map((h) => ({ l: h }))) // written whole when the mark sealed pack n - 1
    for (let j = lo; j <= upTo; j++) {
      for (const h of j === 0 ? allHeads(0, part) : changedHeads(j, j + 1, part)) out.push({ l: h })
      const mem = marks.slice(lo, j + 1), R = render(j, mem, part)
      for (const rid of mem) {
        const s = R.s.get(rid)
        if (s) for (const b of [...w.list(rid), ...s.reply]) if (!sent.has(b)) { sent.add(b); out.push({ d: defs.get(b) }) }
        for (const [k, v] of [['c', R.c.get(rid)], ['s', s], ['r', R.r.get(rid)]]) {
          if (v && J(v) !== last.get(k + rid)) { last.set(k + rid, J(v)); out.push({ [k]: v }) }
        }
        if (!R.c.has(rid) && last.has('c' + rid)) { for (const k of 'csr') last.delete(k + rid); out.push({ g: rid }) }
        if (!ghost && R.c.has(rid)) {
          const row = { ...R.c.get(rid), rid: rid + 'g' }, s = { ...keyframe(R.s.get(rid)), rid: row.rid, events: [{ type: 'user', rid: row.rid, lane: row.lane, k: 1 }] }
          ghost = row.rid; ghosts.add(ghost)
          out.push({ c: row }, { s }, { r: { id: ghost, ts_request: row.ts, is_llm_call: true, response: { status: 200 } } }, { c: { ...row, ctx: row.ctx + 1 } })
        }
      }
    }
    for (const [k, v] of last) if (k[0] === 's') out.push({ s: keyframe(JSON.parse(v)) })
    if (ghost && upTo === marks.length - 1) out.push({ g: ghost })
    return out
  }
  return { w, at, pack, tail, keyframe, attr, defs, ghosts, N: Math.floor(marks.length / P), now: marks.length - 1 }
}

const CASES = [
  ...Array.from({ length: 50 }, (_, i) => ({ seed: i + 1, opts: { calls: 30 + (i % 5) * 12 } })),
  ...[1, 2, 3].map((s) => ({ seed: 100 + s, opts: { calls: 80, talk: { pre: 6, len: 1400, every: 9, tail: 30 } } })),
]

test('3.5 §会话读 pack / tail: packs and the tail in any order give the session at mark', () => {
  for (const { seed, opts } of CASES) {
    const r = rng(seed), int = (a, b) => a + Math.floor(r() * (b - a + 1)), P = opts.talk ? int(33, 40) : int(3, 9)
    const S = session(seed, opts, P), { w, N, now } = S, seal = (n) => P * (n + 1) - 1
    const fails = new Set()
    // every pack's two parts as they are at mark (a `fail` on every third pack's main), and the version written at its seal
    const finals = [], stale = []
    for (let n = 0; n < N; n++) for (const part of ['main', 'rest']) {
      const fail = n % 3 === 0 && part === 'main' ? 'record-unreadable' : null
      const f = { file: { kind: 'pack', n, part }, lines: S.pack(n, part, now, fail) }
      for (const l of f.lines) if (l.x) fails.add(J(l.x))
      finals.push(f)
      const old = S.pack(n, part, seal(n), fail && 'stale-failure')
      if (J(old) !== J(f.lines)) stale.push({ file: f.file, lines: old })
    }
    // the open tail of each part read in chunks at random byte cuts (each from where the last read used up); the tail before it
    // as the board last read it before it sealed
    const chunks = [], tails = { main: S.tail(N, 'main', now), rest: S.tail(N, 'rest', now) }
    // a rid that moves from the main part to the rest part while the tail is open: its lines then `g` in main; in rest it is first
    // in another lane, with an event, then in its own
    const src = tails.main.find((l) => l.s)?.s
    let moved = null
    if (src) {
      const rid = src.rid + 'm', row0 = { ...S.at(now).rows.get(src.rid), rid }, row = { ...row0, lane: rid }, list = w.list(src.rid)
      const head = { lane: rid, kind: 'subagent', icon: 'agent', label: 'Agent m', task: '', count: 1, first: rid, last: rid, peakCtx: row.ctx,
        spawnRid: null, parent: null, flagged: false }
      const step = (lane, i) => ({ ...S.keyframe(src), rid, lane, i, events: [] }), rec = { r: { id: rid, ts_request: row.ts, is_llm_call: true, response: { status: 200 } } }
      tails.main.splice(tails.main.findIndex((l) => l.s) + 1, 0, { c: row0 }, { s: step(row0.lane, src.i) }, rec)
      tails.main.push({ g: rid })
      const sent = new Set(tails.rest.filter((l) => l.d).map((l) => l.d.bid))
      const X = [...S.at(now).heads.values()].find((h) => h.kind !== 'main')?.lane
      const before = X ? [{ c: { ...row, lane: X } }, { s: { ...step(X, 1e4), events: [{ type: 'user', rid, lane: X, k: 1 }] } }] : []
      tails.rest.push({ l: head }, ...[...new Set([...list, ...src.reply])].filter((b) => !sent.has(b)).map((b) => ({ d: S.defs.get(b) })), ...before,
        { c: row }, { s: step(rid, 0) }, rec)
      moved = { rid, row, head, list }
    }
    for (const part of ['main', 'rest']) {
      const bytes = new TextEncoder().encode(text(tails[part]))
      let from = 0, first = true
      for (const cut of [...Array.from({ length: int(0, 2) }, () => int(0, bytes.length)).sort((a, b) => a - b), bytes.length]) {
        if (cut < from) continue
        const p = parseLines(bytes.subarray(from, cut), { head: first })
        if (first && !p.head) continue
        chunks.push({ file: { kind: 'tail', n: N, part }, lines: p.lines, head: p.head })
        from += p.used; first = false
      }
      if (N > 0) chunks.unshift({ file: { kind: 'tail', n: N - 1, part }, lines: S.tail(N - 1, part, int(P * (N - 1), seal(N - 1))).slice(1) })
    }
    // any order: finals shuffled with some loaded twice; a pack's sealed version before either final of its n; tail chunks in
    // their own order at random places among them
    const order = [...finals, ...finals.filter(() => r() < 0.2)].sort(() => r() - 0.5)
    for (const s of stale) {
      const first = order.findIndex((f) => f.file.kind === 'pack' && f.file.n === s.file.n)
      order.splice(int(0, first), 0, s)
    }
    const k = { main: 0, rest: 0 }
    for (const c of chunks) {
      const at = int(c.file.n < N ? 0 : k[c.file.part], order.length)
      order.splice(at, 0, c)
      for (const p in k) if (k[p] > at) k[p]++
      if (c.file.n === N) k[c.file.part] = at + 1
    }
    // the board reads the desk between loads (memoised steps, step numbers)
    const desk = createDesk(), load = (dk, f) => applyFile(dk, f.file, { head: f.head ?? null, lines: f.lines[0]?.schema ? f.lines.slice(1) : f.lines })
    for (const f of order) {
      load(desk, f)
      if (r() < 0.3) for (const [key, h] of desk.held) { ridAt(desk, key, 0); for (const rid of [...h.steps.keys()].slice(-3)) stepOf(desk, rid) }
    }
    // every other pack only: its steps keep their numbers in a lane held with gaps
    const gaps = createDesk(), some = finals.filter((f) => f.file.n % 2 === 0)
    for (const f of some) load(gaps, f)
    for (const { s } of some.flatMap((f) => f.lines).filter((l) => l.s)) {
      assert.equal(indexOf(gaps, s.lane, s.rid), s.i, `seed ${seed} gaps ${s.rid}`)
      assert.equal(ridAt(gaps, s.lane, s.i), s.rid, `seed ${seed} gaps ${s.lane} ${s.i}`)
      assert.deepEqual(listOf(gaps, s.rid), w.list(s.rid), `seed ${seed} gaps list ${s.rid}`)
    }

    const d = S.at(now), msg = `seed ${seed} P ${P}`
    assert.equal(desk.rows.size, d.rows.size + !!moved, msg)
    if (moved) {
      assert.deepEqual(desk.rows.get(moved.rid), moved.row, `${msg} moved row`)
      assert.deepEqual(desk.lanes.get(moved.rid), moved.head, `${msg} moved head`)
      assert.deepEqual(listOf(desk, moved.rid), moved.list, `${msg} moved list`)
      assert.equal(indexOf(desk, moved.rid, moved.rid), 0, `${msg} moved step`)
      assert.equal(desk.events.has(moved.rid), false, `${msg} moved events`)
    }
    for (const [rid, row] of d.rows) {
      assert.deepEqual(desk.rows.get(rid), row, `${msg} row ${rid}`)
      assert.deepEqual(desk.events.get(rid) ?? [], d.doc.events.filter((e) => e.rid === rid), `${msg} events ${rid}`)
    }
    for (const [key, rids] of d.laneRids) {
      assert.deepEqual(desk.lanes.get(key), d.heads.get(key), `${msg} head ${key}`)
      assert.deepEqual(laneEvents(desk, key), w.eventsAt(key, d.M), `${msg} lane events ${key}`)
      rids.forEach((rid, i) => {
        const list = w.list(rid)
        assert.deepEqual(listOf(desk, rid), list, `${msg} list ${rid}`)
        assert.deepEqual(stepOf(desk, rid).attrs, list.map((b) => S.attr.get(b) ?? null), `${msg} attrs ${rid}`)
        assert.equal(indexOf(desk, key, rid), i, `${msg} indexOf ${rid}`)
        assert.equal(ridAt(desk, key, i), rid, `${msg} ridAt ${key} ${i}`)
        for (const b of list) assert.ok(desk.defs.has(b), `${msg} def ${b}`)
      })
    }
    for (const rid of w.marks) assert.equal(desk.records.get(rid)?.is_llm_call, d.rows.has(rid), `${msg} record ${rid}`)
    assert.equal(desk.records.size, w.marks.length + !!moved, msg)
    for (const g of S.ghosts) assert.equal(listOf(desk, g), null, `${msg} gone ${g}`)
    assert.deepEqual(new Set(desk.errors.map(J)), fails, msg)
  }
})

test('3.5 契约样例: the lane_pack and lane_tail samples land their rows and steps in the desk', () => {
  const desk = createDesk()
  for (const [name, file] of [['lane_pack', { kind: 'pack', n: 0, part: 'main' }], ['lane_tail', { kind: 'tail', part: 'main' }]]) {
    assert.equal(applyFile(desk, file, parseLines(text(fx[name]))), true, name)
  }
  const lines = [...fx.lane_pack, ...fx.lane_tail], gone = new Set(lines.filter((l) => l.g).map((l) => l.g))
  for (const { c } of lines.filter((l) => l.c && !gone.has(l.c.rid))) assert.deepEqual(desk.rows.get(c.rid), c)
  for (const rid of gone) assert.equal(desk.rows.has(rid), false, rid)
  for (const { s } of lines.filter((l) => l.s)) {
    const list = listOf(desk, s.rid)
    assert.ok(list?.length, s.rid)
    for (const b of list) assert.ok(desk.defs.has(b), `${s.rid} ${b}`)
    assert.equal(indexOf(desk, s.lane, s.rid), s.i)
    assert.equal(ridAt(desk, s.lane, s.i), s.rid)
  }
  assert.deepEqual(desk.lanes.get(fx.lane_tail[1].l.lane), fx.lane_tail[1].l)
})

test('parseLines: a read cut at any byte takes whole lines only, and `used` is where the next read starts', () => {
  const lines = [{ schema: 2, tail: { n: 0 } }, { c: { rid: 'a', preview: 'naïve → ok' } }, { g: 'a' }]
  const bytes = new TextEncoder().encode(text(lines))
  const ends = [], enc = new TextEncoder()
  for (let i = 0, at = 0; i < lines.length; i++) ends.push(at += enc.encode(J(lines[i]) + '\n').length)
  for (let k = 0; k <= bytes.length; k++) {
    const p = parseLines(bytes.subarray(0, k)), whole = ends.filter((e) => e <= k).length
    assert.equal(p.used, whole ? ends[whole - 1] : 0, `cut ${k}`)
    assert.deepEqual([p.head, ...p.lines].filter(Boolean), lines.slice(0, whole), `cut ${k}`)
    const rest = parseLines(bytes.subarray(p.used), { head: false })
    assert.deepEqual([...[p.head].filter(Boolean), ...p.lines, ...rest.lines], lines, `cut ${k} then the rest`)
  }
})

// 3.5 §会话读 `{l}`: the worker writes the head only when a part only it carries changed and the board reads it before the tails, so a
// lane header from a held tail (the highest n) wins over the head's; a pack holds none, so once pack n replaced tail n the head's is used until tail n+1 has one.
test('3.5 §会话读 {l}: a held tail\'s lane header wins over the head\'s, the head\'s stands once its tail is sealed into a pack', () => {
  const desk = createDesk(), head = (count) => ({ mark: 'S:1', lanes: [{ lane: 'A', count }] })
  const tail = (n, count) => parseLines(text([{ tail: { n, part: 'main', s0: 0 } }, { l: { lane: 'A', count } }]))
  applyHead(desk, head(3))
  applyFile(desk, { kind: 'tail', part: 'main' }, tail(0, 5))
  assert.equal(desk.lanes.get('A').count, 5, 'the tail\'s header over the head\'s')
  applyHead(desk, head(3))
  assert.equal(desk.lanes.get('A').count, 5, 'a head read again does not take the lane back')
  applyFile(desk, { kind: 'pack', part: 'main' }, parseLines(text([{ pack: { n: 0, part: 'main', s0: 0, s1: 1 } }])))
  assert.equal(desk.lanes.get('A').count, 3, 'tail 0 sealed: the head\'s header')
  applyFile(desk, { kind: 'tail', part: 'main' }, tail(1, 7))
  assert.equal(desk.lanes.get('A').count, 7, 'tail 1\'s header')
})

// 1.5 K-32: the calls behind are the tip ids after the newest member the desk holds — the head's mark, or a held `{r}` id past it.
test('1.5 K-32: a call a held tail brought is not counted behind; one past it is', () => {
  const desk = createDesk(), r = (id) => ({ r: { id, ts_request: null, is_llm_call: true, response: { status: 200 } } })
  applyHead(desk, { mark: 'S:9', lanes: [] })
  applyFile(desk, { kind: 'tail', part: 'rest' }, parseLines(text([{ tail: { n: 0, part: 'rest', s0: 0 } }, r('S:12')])))
  applyFile(desk, { kind: 'tail', part: 'main' }, parseLines(text([{ tail: { n: 0, part: 'main', s0: 0 } }, r('S:10')])))
  assert.equal(behindOf('S:9 S:10 S:12', desk.newest), null, 'the newest held member is S:12, over both tails')
  assert.deepEqual(behindOf('S:10 S:12 T:3', desk.newest), { n: 1, more: false })
})

// 3.5 §谁执行它「答案文件」 head / 1.5 K-32: a head left behind by the open span (written at an earlier mark of it) with the packs and
// tails gives the desk the head at the tails' mark gives — the same rows, lane heads and newest member. The files are the worker's,
// written for a generated session (src/query/ctx-files.mjs); the newer head is the local path's at the same mark.
test('3.5 答案文件 head: an older head of the open span with the same packs and tails gives the desk the newer head gives', { timeout: 120_000 }, async () => {
  const { gunzipSync } = await import('node:zlib'), path = await import('node:path')
  const { tmpDir } = await import('../helpers/tmp.mjs'), { bigSession } = await import('../query/big-session.mjs')
  const { runQuery } = await import('../../src/query/named/index.mjs'), { extendSession } = await import('../../src/query/named/session.mjs')
  const { sessionDir } = await import('../../src/query/projection.mjs')
  const home = path.join(tmpDir('trocar-oldhead-'), '.trocar')
  const s = bigSession({ home, id: 'eeee-0000-4a1b-9c2d-000000000006', growth: 300, subEvery: 4, subLanes: 2, subLen: 1e9 })
  const ctx = { home, writer: true }, dir = sessionDir(home, s.id), read = (f) => fs.readFileSync(path.join(dir, f))
  const fold = async () => { while (await extendSession(ctx, s.id, Infinity)); }
  s.append(520) // pack 0 sealed, the open span begun
  await fold()
  const older = JSON.parse(gunzipSync(read('head.json.gz')).toString('utf8'))
  s.append(12)
  await fold()
  const newer = JSON.parse(J(await runQuery('session', { id: s.id, head: true }, { home })))
  assert.ok(older.mark !== newer.mark && older.open.n === newer.open.n && J(older.packs) === J(newer.packs) && J(older.lanes) !== J(newer.lanes),
    'the older head is of the same packs, at an earlier mark, its lane heads behind')
  const files = [...older.packs.flatMap(({ n }) => ['main', 'rest'].map((part) => [{ kind: 'pack', n, part }, parseLines(gunzipSync(read(`p${n}.${part}.ndjson.gz`)))])),
    ...['main', 'rest'].map((part) => [{ kind: 'tail', n: older.open.n, part, whole: true }, parseLines(read(`open.${part}.ndjson`))])]
  const deskOf = (head) => { const d = createDesk(); applyHead(d, head); for (const [f, p] of files) applyFile(d, f, p); return d }
  const a = deskOf(older), b = deskOf(newer)
  assert.ok(b.rows.size > 0)
  assert.deepEqual([...a.rows].sort(), [...b.rows].sort(), 'the same rows')
  assert.deepEqual(new Map([...a.lanes].sort()), new Map([...b.lanes].sort()), 'the same lane heads')
  assert.equal(a.newest, b.newest, 'the same newest member')
})

// 3.5 §会话读 / 2.3 §归约前沿: a rid held by more than one file. Packs seal over tails that hold their rids (the pack claims them), a
// tail's rids that its pack lacks go back to the next tail that still holds them (release), a tail lets a rid go by `g`, a tail is
// read again whole. A rid's lines are the same in every file holding it, so the desk after each load equals the desk built from
// the same files at once, packs first: rows, step order, each lane's rids, steps, events, records, lane heads.
test('3.5 §会话读: rids held by several files: after every load the desk equals the same files loaded at once', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed), G = 10, X = 3, line = new Map()
    const rid = (k) => `S:${k}`, lane = (k) => (k % 3 ? 'A' : 'B')
    for (let k = 0; k < 3 * G; k++) {
      const ts = `2026-11-04T00:${String(Math.floor(k / 2 + (r() < 0.2 ? 3 : 0))).padStart(2, '0')}:00Z` // equal ts and late rows
      line.set(k, [{ c: { rid: rid(k), lane: lane(k), ts, ctx: k } },
        { s: { rid: rid(k), lane: lane(k), i: k, parent: null, ops: [[1, `b${k}`]], events: k % 4 ? [] : [{ type: 'user', rid: rid(k), lane: lane(k), k: 1 }] } },
        { r: { id: rid(k), ts_request: ts, is_llm_call: true } }])
    }
    const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i)
    const lines = (ks) => ks.flatMap((k) => line.get(k))
    const heads = (n) => [{ l: { lane: 'A', count: 10 + n } }, { l: { lane: 'B', count: 20 + n } }]
    const gone = 2 * G - 1 // held by tail 1 and pack 1; tail 2 brings it and lets it go
    const files = [
      { file: { kind: 'pack', n: 0, part: 'main' }, lines: lines(range(0, G)) },
      { file: { kind: 'pack', n: 1, part: 'main' }, lines: lines(range(G, 2 * G)) },
      { file: { kind: 'tail', n: 0, part: 'main' }, lines: [...heads(0), ...lines(range(0, G + X))] },
      { file: { kind: 'tail', n: 1, part: 'main' }, lines: [...heads(1), ...lines(range(G - X, 2 * G + X))] },
      { file: { kind: 'tail', n: 2, part: 'main' }, lines: [...heads(2), ...lines([gone, ...range(2 * G - X, 3 * G)]), { g: rid(gone) }] },
    ]
    const order = [...files, ...files.filter(() => r() < 0.3).map((f) => (f.file.kind === 'tail' ? { ...f, file: { ...f.file, whole: true } } : f))]
      .sort(() => r() - 0.5)
    const keyOf = (f) => `${f.file.kind}${f.file.n}`
    const view = (d) => ({
      rows: d.rows, order: d.order, laneRids: d.laneRids, lanes: d.lanes, events: d.events, records: d.records,
      steps: new Map([...d.held].map(([k, h]) => [k, { steps: new Map([...h.steps].map(([x, s]) => [x, s])), events: h.events }]).filter(([, h]) => h.steps.size)),
    })
    const desk = createDesk()
    order.forEach((f, j) => {
      applyFile(desk, f.file, { head: null, lines: f.lines })
      const once = createDesk(), seen = new Map()
      for (const g of order.slice(0, j + 1)) seen.set(keyOf(g), g)
      for (const g of [...seen.values()].sort((a, b) => (a.file.kind === b.file.kind ? a.file.n - b.file.n : a.file.kind === 'pack' ? -1 : 1))) {
        applyFile(once, g.file, { head: null, lines: g.lines })
      }
      assert.deepEqual(view(desk), view(once), `seed ${seed} after ${j}: ${order.slice(0, j + 1).map(keyOf).join(' ')}`)
    })
  }
})
