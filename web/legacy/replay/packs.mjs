// web/legacy/replay/packs.mjs — the replay desk fed by pack and tail files (RFC 3.5 §会话读 `lane --pack` / `lane --tail`).
//
// Pure: no DOM, fetch or timers. A file is NDJSON whose first line is the doc head; every other line has one top-level key:
// c (a skeleton row) · s (a step: `i` its index in its lane, `parent` the previous step of its lane in the same file, null = a
// keyframe) · d (a definition) · l (a lane head) · r (a record summary) · x (a failure) · g (a tail only: the rid is no longer a call).
// A rid belongs to one file, so the desk keeps per file the rids it brought and replaces by file: a pack replaces everything it
// owned before (and the tail of the same n and part, which it seals); a tail applies its lines in order, the later line for a
// rid wins. Files may arrive in any order: a tail never takes a rid a pack holds, and a tail keeps its latest lines per rid so
// a rid that one tail lets go (g, or the tail sealed) comes back from another tail that still has it.
//
//   parseLines(text | bytes[, {head}]) → {head, lines, used}   only whole lines; `used` = bytes through the last newline
//   lineSlices(text | bytes[, {head}]) → a generator yielding after each line, returning parseLines' answer
//   applyFile(desk, {kind:'pack', n, part} | {kind:'tail', n?, part, whole?}, parsed) → false when the file is already sealed;
//     `whole` = the tail's bytes from 0 (a rewritten tail): what it held before is let go first
//   applyHead(desk, head) → the `session --head` answer as the desk's head: its scalars and its lane heads
// Lane heads: a held tail's (the highest n) over desk.head's (the `session --head` answer); packs hold none. The worker writes the
// head only when a part only it carries changes and a poll round reads it before the tails, so a held tail's header is never older
// than the head's.
// desk.newest = the newest member the desk holds in record order (placeOf / after): the head's mark or a held `{r}` id (1.5 K-32).

import { changed, addRow, removeRow, newHeld, boardDef } from './model.mjs'

const enc = new TextEncoder(), dec = new TextDecoder()

// lineSlices: the same parse, resumable: a generator that yields after each line and returns parseLines' answer (the caller decides
// when to give the thread back, 2.3 §归约前沿 分片解析)
export function* lineSlices(src, { head = true } = {}) {
  let text, used
  if (typeof src === 'string') { text = src.slice(0, src.lastIndexOf('\n') + 1); used = enc.encode(text).length } else { used = src.lastIndexOf(10) + 1; text = dec.decode(src.subarray(0, used)) }
  const lines = []
  for (let at = 0, j; (j = text.indexOf('\n', at)) >= 0; at = j + 1) {
    const l = text.slice(at, j)
    if (l.trim()) lines.push(JSON.parse(l))
    yield
  }
  return { head: head ? lines.shift() ?? null : null, lines, used }
}
export function parseLines(src, opts) {
  for (const g = lineSlices(src, opts); ;) { const x = g.next(); if (x.done) return x.value }
}

const rank = (e) => (e.kind === 'pack' ? e.n : e.n + 0.5)
// a member id `<segment>:<line>` in record order: segment, then line
export const placeOf = (id) => { const j = String(id).lastIndexOf(':'); return [String(id).slice(0, j), Number(String(id).slice(j + 1))] }
export const after = ([sa, la], [sb, lb]) => sa > sb || (sa === sb && la > lb)
const held = (desk, id) => { if (id != null && (desk.newest == null || after(placeOf(id), placeOf(desk.newest)))) desk.newest = String(id) }

// held steps fed by files are found by rid (desk.stepLane: rid → the lane holding its step) and numbered by `i`; the page
// model's step list (h.rids) is not kept
function unstep(desk, rid) {
  const h = desk.held.get(desk.stepLane.get(rid))
  desk.stepLane.delete(rid)
  if (!h) return
  h.steps.delete(rid); h.events.delete(rid); h.kf.clear(); h.byI = null
}

// a dropped rid's row stays in place, marked leaving, until the apply ends (settle): a row that comes back in the same apply (a
// pack claiming it, a tail taking it back, a tail writing it again) replaces it in place when its lane and ts are unchanged, so
// desk.order and the lane's rids are not spliced twice per row
function dropRid(desk, rid) {
  unstep(desk, rid)
  if (desk.rows.has(rid)) desk.leaving.add(rid)
  desk.events.delete(rid); desk.records.delete(rid)
}

function putRow(desk, row) {
  const old = desk.rows.get(row.rid)
  desk.leaving.delete(row.rid)
  if (old && old.lane === row.lane && old.ts === row.ts) { desk.rows.set(row.rid, row); return }
  if (old) removeRow(desk, old)
  addRow(desk, row)
}

function settle(desk) {
  for (const rid of desk.leaving) removeRow(desk, desk.rows.get(rid))
  desk.leaving.clear()
}

// desk.linesBy: rid → the tails keeping lines for it, so a released rid finds its next holder without scanning the files
function keep(desk, e, rid, k, x) {
  let kept = e.lines.get(rid)
  if (!kept) {
    e.lines.set(rid, kept = {})
    if (!desk.linesBy.has(rid)) desk.linesBy.set(rid, new Set())
    desk.linesBy.get(rid).add(e)
  }
  kept[k] = x
}
function unkeep(desk, e, rid) {
  if (!e.lines?.delete(rid)) return
  const by = desk.linesBy.get(rid)
  by.delete(e)
  if (!by.size) desk.linesBy.delete(rid)
}

function putStep(desk, { events = [], ...s }) {
  if (desk.stepLane.get(s.rid) !== s.lane) unstep(desk, s.rid)
  desk.stepLane.set(s.rid, s.lane)
  const h = desk.held.get(s.lane) ?? desk.held.set(s.lane, newHeld()).get(s.lane)
  h.steps.set(s.rid, { ...s, ts: desk.leaving.has(s.rid) ? undefined : desk.rows.get(s.rid)?.ts })
  h.kf.clear(); h.byI = null
  if (events.length) {
    h.events.set(s.rid, events)
    desk.events.set(s.rid, events.map((e) => ({ type: e.type, rid: e.rid, lane: e.lane })))
  } else { h.events.delete(s.rid); desk.events.delete(s.rid) }
}

const put = { c: putRow, s: putStep, r: (desk, x) => { desk.records.set(x.id, x); held(desk, x.id) } }

// take rid for file e; a tail never takes it from a pack
function claim(desk, e, rid) {
  const o = desk.owner.get(rid)
  if (o === e) return true
  if (o) {
    if (o.kind === 'pack' && e.kind === 'tail') return false
    o.rids.delete(rid); dropRid(desk, rid)
  }
  desk.owner.set(rid, e); e.rids.add(rid)
  return true
}

// e lets rid go; another tail still holding lines for it takes it back
function release(desk, e, rid) {
  if (desk.owner.get(rid) !== e) return
  e.rids.delete(rid); desk.owner.delete(rid); dropRid(desk, rid)
  for (const o of desk.linesBy.get(rid) ?? []) {
    const kept = o !== e && o.lines.get(rid)
    if (kept && claim(desk, o, rid)) { for (const k of ['c', 's', 'r']) if (kept[k]) put[k](desk, kept[k]); return }
  }
}

function dropFile(desk, key, touched) {
  const e = desk.files.get(key)
  if (!e) return
  desk.files.delete(key)
  for (const rid of [...e.rids]) release(desk, e, rid)
  for (const rid of e.lines?.keys() ?? []) unkeep(desk, e, rid)
  for (const b of e.bids) {
    const n = desk.defRefs.get(b) - 1
    if (n) desk.defRefs.set(b, n); else { desk.defRefs.delete(b); desk.defs.delete(b) }
  }
  for (const k of e.heads.keys()) touched.add(k)
}

export function applyFile(desk, file, { head, lines }) {
  const tail = file.kind === 'tail', n = file.n ?? head?.[file.kind]?.n, part = file.part
  if (tail && desk.files.has(`p${n}.${part}`)) return false
  changed(desk)
  const key = `${tail ? 't' : 'p'}${n}.${part}`, touched = new Set()
  if (!tail || file.whole) dropFile(desk, key, touched)
  if (!tail) dropFile(desk, `t${n}.${part}`, touched)
  let e = desk.files.get(key)
  if (!e) desk.files.set(key, e = { kind: file.kind, n, rids: new Set(), heads: new Map(), fails: new Map(), bids: new Set(), lines: tail ? new Map() : null })
  for (const line of lines) {
    const [k] = Object.keys(line), x = line[k]
    if (k in put) {
      const rid = k === 'r' ? x.id : x.rid
      if (tail) keep(desk, e, rid, k, x)
      if (claim(desk, e, rid)) put[k](desk, x)
    } else if (k === 'd') {
      desk.defs.set(x.bid, boardDef(x))
      if (!e.bids.has(x.bid)) { e.bids.add(x.bid); desk.defRefs.set(x.bid, (desk.defRefs.get(x.bid) ?? 0) + 1) }
    } else if (k === 'l') { e.heads.set(x.lane, x); touched.add(x.lane) }
    else if (k === 'x') e.fails.set(`${x.where} ${x.code}`, x)
    else if (k === 'g' && tail) { unkeep(desk, e, x); release(desk, e, x) }
  }
  settle(desk)
  mergeHeads(desk, touched)
  const fails = [...desk.files.values()].flatMap((o) => [...o.fails.values()])
  desk.errors = [...desk.errors.filter((x) => !FAILS.has(x)), ...fails]
  for (const x of fails) FAILS.add(x)
  return true
}
function mergeHeads(desk, touched) {
  for (const lane of touched) {
    let best = null, r = -1
    for (const o of desk.files.values()) { const h = o.heads.get(lane); if (h && rank(o) > r) { best = h; r = rank(o) } }
    best ??= desk.head?.lanes?.find((h) => h.lane === lane)
    if (best) desk.lanes.set(lane, best); else desk.lanes.delete(lane)
  }
}

const SCALARS = ['mark', 'pending', 'truncated', 'meta', 'stats', 'logged', 'probes', 'unknown']
export function applyHead(desk, head) {
  changed(desk)
  const touched = new Set([...(desk.head?.lanes || []), ...(head.lanes || [])].map((h) => h.lane))
  desk.head = head
  held(desk, head.mark)
  for (const k of SCALARS) desk[k] = head[k] ?? null
  desk.logged = head.logged ?? 0; desk.probes = head.probes ?? 0
  if (!head.pending) desk.firstPending = false
  desk.errors = [...(head.errors || []), ...desk.errors.filter((x) => FAILS.has(x))]
  mergeHeads(desk, touched)
}
const FAILS = new WeakSet() // the errors entries that came from files (replaced on every apply)
