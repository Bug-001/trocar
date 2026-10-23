// src/web/v2/replay/model.mjs — the replay desk's data model over the three session reads (RFC 3.5 §会话读; 2.3 #22).
//
// Pure: no DOM, fetch, timers or module state. The desk holds the session's skeleton rows by rid in step order, the lane
// headers by key (the lane's first rid), held lanes as steps with ops, and block definitions by bid. A step's bid list is
// materialised from the nearest keyframe by its ops; one keyframe is cached every 32 steps of a walk. The playhead is a rid,
// step numbers are derived (indexOf / ridAt).
//
//   applySession(desk, answer[, {before}]) → {reset, touched}   a full answer, a --since delta, or a --before page
//   laneAsk(desk, key, touched) → {lane, from?}                  3.5's from-rule for a held lane the delta touched
//   readTouched(desk, touched, read[, stale]) → {ok, error?, done} | null   those lanes read on; a failed one waits in desk.lagging
//   applyLane(desk, answer) → {reset}                            a tail / reset page, an older (--to) page, a --from page
//   listOf(desk, rid) → bid[] | null    stepOf(desk, rid) → {row, lane, held, flat, reply, attrs, detail}
//   laneEvents(desk, key) → event[]      askOrdinal(desk, key, rid) → k | 0 | null (2.2 K, E1)
//   applyLedger / ledgerAsk / ledgerDone / readLedger   the `ledger_next` chain (3.5 `resources` 与 `seen`)
//   seenFiles(desk, key) → [{path, firstRid, count}] | null   seen minus the lane's opened files (2.4:148, E6)
// A whole-lane read answers the tail page only; older steps come back by `prev` (`to`) pages.

import { compareStep } from '../../../view/step-order.mjs'

const KF_EVERY = 32

export function createDesk() {
  return {
    mark: null, pending: null, firstPending: true, truncated: null, meta: null, stats: null, logged: 0, probes: 0,
    unknown: null, errors: [], more: false, lagging: new Map(),
    rows: new Map(), order: [], lanes: new Map(), laneRids: new Map(), events: new Map(), held: new Map(), defs: new Map(),
  }
}

const tsOf = (desk, rid) => desk.rows.get(rid)?.ts ?? ''

// where rid stands (or would stand) in an array kept in step order: a binary search (the row must be in desk.rows)
function slotOf(desk, arr, rid) {
  const ts = tsOf(desk, rid)
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (compareStep(tsOf(desk, arr[m]), arr[m], ts, rid) < 0) lo = m + 1; else hi = m }
  return lo
}
const place = (desk, arr, rid) => arr.splice(slotOf(desk, arr, rid), 0, rid)
function unplace(desk, arr, rid) {
  const j = slotOf(desk, arr, rid), i = arr[j] === rid ? j : arr.lastIndexOf(rid)
  if (i >= 0) arr.splice(i, 1)
}

function addRow(desk, row) {
  desk.rows.set(row.rid, row)
  place(desk, desk.order, row.rid)
  if (!desk.laneRids.has(row.lane)) desk.laneRids.set(row.lane, [])
  place(desk, desk.laneRids.get(row.lane), row.rid)
}
function removeRow(desk, row) {
  unplace(desk, desk.order, row.rid)
  const l = desk.laneRids.get(row.lane)
  if (l) { unplace(desk, l, row.rid); if (!l.length) desk.laneRids.delete(row.lane) }
  desk.rows.delete(row.rid)
}

function scalars(desk, a) {
  for (const k of ['truncated', 'meta', 'stats', 'logged', 'probes']) if (k in a) desk[k] = a[k]
  desk.pending = a.pending ?? null
  if (!a.pending) desk.firstPending = false
  if (a.base == null || 'unknown' in a) desk.unknown = a.unknown ?? null // a delta carries `unknown` only where it changed (3.5 §会话读)
  desk.errors = a.errors ?? []
}

function setEvents(desk, rids, events) {
  for (const rid of rids) desk.events.delete(rid)
  for (const e of events || []) { if (!desk.events.has(e.rid)) desk.events.set(e.rid, []); desk.events.get(e.rid).push(e) }
}

/**
 * A full answer (`base: null`) replaces rows, lanes and events; with `{before: true}` it is an older page whose rows are
 * merged instead. A delta (`base` = desk.mark) upserts `calls` at their step-order place, removes `gone`, upserts / removes
 * lane headers and replaces each listed rid's events. A delta on another base is stale and changes nothing.
 * `touched`: per held lane, the earliest affected step `{earliest, ts}`; `{earliest: null}` = read the whole lane again.
 */
export function applySession(desk, a, { before = false } = {}) {
  const touched = new Map()
  if (a.base != null && a.base !== desk.mark) return { reset: false, touched }
  scalars(desk, a)
  if (a.base == null) {
    desk.lanes = new Map((a.lanes || []).map((h) => [h.lane, h]))
    desk.more = !!a.more
    if (before) {
      for (const row of a.calls) { const old = desk.rows.get(row.rid); if (old) removeRow(desk, old); addRow(desk, row) }
      setEvents(desk, a.calls.map((r) => r.rid), a.events)
      return { reset: false, touched }
    }
    desk.mark = a.mark
    desk.rows = new Map(a.calls.map((r) => [r.rid, r]))
    desk.order = a.calls.map((r) => r.rid).sort((x, y) => compareStep(tsOf(desk, x), x, tsOf(desk, y), y))
    desk.laneRids = new Map()
    for (const rid of desk.order) {
      const lane = desk.rows.get(rid).lane
      if (!desk.laneRids.has(lane)) desk.laneRids.set(lane, [])
      desk.laneRids.get(lane).push(rid)
    }
    desk.events = new Map()
    setEvents(desk, [], a.events)
    for (const key of [...desk.held.keys()]) if (desk.lanes.has(key)) touched.set(key, { earliest: null }); else desk.held.delete(key)
    return { reset: true, touched }
  }
  desk.mark = a.mark
  const hit = (key, rid, ts) => {
    if (!desk.held.has(key)) return
    const t = touched.get(key)
    if (!t || compareStep(ts, rid, t.ts, t.earliest) < 0) touched.set(key, { earliest: rid, ts })
  }
  for (const rid of a.gone || []) {
    const old = desk.rows.get(rid)
    if (!old) continue
    hit(old.lane, rid, old.ts)
    removeRow(desk, old)
    desk.events.delete(rid)
  }
  for (const row of a.calls || []) {
    const old = desk.rows.get(row.rid)
    if (old) { if (old.lane !== row.lane) hit(old.lane, row.rid, old.ts); removeRow(desk, old) }
    hit(row.lane, row.rid, row.ts)
    addRow(desk, row)
  }
  setEvents(desk, (a.calls || []).map((r) => r.rid), a.events)
  for (const key of a.lanes_gone || []) { desk.lanes.delete(key); desk.held.delete(key); desk.laneRids.delete(key); touched.delete(key) }
  for (const h of a.lanes || []) desk.lanes.set(h.lane, h)
  return { reset: false, touched }
}

// held lane: steps by rid in step order (`rids`), lane events per rid (several per rid), the ledger by resource key / path, and
// the `ledger_next` cursors still to read
const newHeld = () => ({ steps: new Map(), rids: [], prev: null, next: null, resources: new Map(), seen: new Map(), events: new Map(), kf: new Map(), cursors: new Set() })

// drop held steps from index i on, with their cached keyframes and lane events
function cut(h, i) {
  for (const rid of h.rids.splice(i)) { h.steps.delete(rid); h.kf.delete(rid); h.events.delete(rid) }
}

/**
 * 3.5's from-rule: every affected row after the held tip → `from = tip`; otherwise `from` = the held step before the earliest
 * affected one, or the whole lane when there is none. Nothing is dropped here: the held steps stay drawn until the answer
 * arrives, and applyLane cuts after its `base` (or replaces the lane) then — a failed read leaves the desk as it was.
 */
export function laneAsk(desk, key, touched) {
  const h = desk.held.get(key), t = touched?.get(key)
  if (!h || !h.rids.length || t?.earliest === null) return { lane: key }
  // a held step's ts: its row's, or the one it had when it was stored (a gone row has none left)
  const ts = (rid) => desk.rows.get(rid)?.ts ?? h.steps.get(rid)?.ts ?? ''
  const atOrAfter = (rid) => rid === t.earliest || compareStep(ts(rid), rid, t.ts, t.earliest) >= 0
  const tip = h.rids.at(-1)
  if (!t || !atOrAfter(tip)) return { lane: key, from: tip }
  const i = h.rids.findIndex(atOrAfter)
  return i ? { lane: key, from: h.rids[i - 1] } : { lane: key }
}

/** Put `v` for lane `k` into a touched map, keeping the earliest affected step (`earliest: null`, the whole lane, wins). */
export function mergeTouch(map, k, v) {
  const u = map.get(k)
  if (!u || u.earliest === null) { if (!u) map.set(k, v); return }
  if (v.earliest === null || compareStep(v.ts, v.earliest, u.ts, u.earliest) < 0) map.set(k, v)
}

/**
 * Read on each held lane in `touched` and in desk.lagging, forward page by page by the from-rule. `read(name, params)` resolves
 * an envelope {ok, data, error}. The first failed read stops: that lane and every lane not read yet go to desk.lagging with
 * their touched entries (the next call reads them), and their held steps stay as they are.
 * → {ok: true, done} | {ok: false, error, done} (`done`: the lanes read to the end); null when `stale()` turned true.
 */
export async function readTouched(desk, touched, read, stale = () => false) {
  const all = new Map(touched)
  for (const [k, v] of desk.lagging) if (desk.lanes.has(k)) mergeTouch(all, k, v)
  desk.lagging = new Map()
  const done = []
  for (const k of all.keys()) {
    let q = laneAsk(desk, k, all)
    for (let n = 0; q && n < 50; n++) {
      const lr = await read('lane', q)
      if (stale()) return null
      if (!lr || !lr.ok || !lr.data) {
        for (const [j, v] of all) if (!done.includes(j)) desk.lagging.set(j, v)
        return { ok: false, status: lr && lr.status, error: (lr && lr.error) || 'cause not known', done }
      }
      applyLane(desk, lr.data)
      q = lr.data.base != null && lr.data.next ? { lane: k, from: lr.data.next } : null
    }
    done.push(k)
  }
  return { ok: true, done }
}

function merge(map, items, id) { for (const x of items || []) map.set(id(x), x) }

/** A resource's identity (E5): the server's `resKey` / `key`, else `kind::label` (3.5's ledger key). */
export const resKeyOf = (r) => r.resKey || r.key || r.kind + '::' + r.label

function mergeLedger(h, a) {
  merge(h.resources, a.resources, resKeyOf)
  merge(h.seen, a.seen, (x) => x.path)
}

/**
 * A page without a base and without `next` (tail, reset) replaces the lane's held steps; one without a base but with
 * `next` is an older (--to) page put before them; a page with a base extends the held steps after `base`. Never pass a
 * `--ledger` answer here (applyLedger). Definitions merge by bid; resources by resKeyOf and seen by path, the answer's one
 * wins. Events: every step the answer covers gets the answer's events; the others it carries (a base:null answer's
 * compaction / summarize) merge by (type, rid). A tail or reset answer resets the pending ledger cursors to its `ledger_next`;
 * an older page of a held lane leaves them as they are.
 */
export function applyLane(desk, a) {
  merge(desk.defs, a.defs, (d) => d.bid)
  let h = desk.held.get(a.lane)
  const steps = a.steps.map((s) => ({ ...s, ts: desk.rows.get(s.rid)?.ts }))
  let reset = false
  // an older page of a lane already held: its ledger head (3.5: a base:null page sends the whole ledger again) only merges;
  // the tail's chain and the --from deltas keep the ledger current at mark, so its cursors stay as they are
  const olderHeld = a.base == null && a.next != null && !!h
  if (a.base == null && a.next == null) {
    h = newHeld(); desk.held.set(a.lane, h); reset = true
    h.prev = a.prev ?? null
  } else if (a.base == null) {
    if (!h) { h = newHeld(); desk.held.set(a.lane, h); h.next = a.next }
    h.prev = a.prev ?? null
  } else {
    if (!h?.steps.has(a.base)) return { reset: false }
    cut(h, h.rids.indexOf(a.base) + 1)
    h.next = a.next ?? null
  }
  const fresh = steps.filter((s) => !h.steps.has(s.rid))
  for (const s of fresh) h.steps.set(s.rid, s)
  const rids = fresh.map((s) => s.rid)
  h.rids = a.base == null && !reset ? [...rids, ...h.rids] : [...h.rids, ...rids]
  mergeLedger(h, a)
  if (!olderHeld) {
    if (a.base == null) h.cursors = new Set()
    if (a.ledger_next != null) h.cursors.add(a.ledger_next)
  }
  const covered = new Set(a.steps.map((s) => s.rid))
  for (const rid of covered) h.events.delete(rid)
  for (const e of a.events || []) {
    const list = h.events.get(e.rid) || h.events.set(e.rid, []).get(e.rid)
    const i = covered.has(e.rid) ? -1 : list.findIndex((x) => x.type === e.type)
    if (i < 0) list.push(e); else list[i] = e
  }
  return { reset }
}

/** The held lane's events in step order (a rid's own events in the order they came); [] when the lane is not held. */
export function laneEvents(desk, key) {
  const h = desk.held.get(key)
  if (!h) return []
  const ts = (rid) => desk.rows.get(rid)?.ts ?? h.steps.get(rid)?.ts ?? ''
  return [...h.events.keys()].sort((x, y) => compareStep(ts(x), x, ts(y), y)).flatMap((rid) => h.events.get(rid))
}

/**
 * 2.2's K (E1): the `k` of the last `user` event at or before `rid` among the held events; 0 when there is none and the held
 * steps start at the lane's first step; null when the held pages cannot know it (`rid` not held, or its user event lies
 * before the held steps).
 */
export function askOrdinal(desk, key, rid) {
  const h = desk.held.get(key)
  if (!h || !h.steps.has(rid)) return null
  const ts = (r) => desk.rows.get(r)?.ts ?? h.steps.get(r)?.ts ?? ''
  let best = null
  for (const [r, list] of h.events) {
    if (!h.steps.has(r) || compareStep(ts(r), r, ts(rid), rid) > 0) continue
    for (const e of list) if (e.type === 'user' && e.k != null && (!best || compareStep(ts(best.rid), best.rid, ts(r), r) < 0)) best = e
  }
  return best ? best.k : h.prev === null ? 0 : null
}

/** A `--ledger C` answer for held lane `key`: merges only its resources / seen; C is read, its own `ledger_next` is pending. */
export function applyLedger(desk, key, cursor, a) {
  const h = desk.held.get(key)
  if (!h) return
  mergeLedger(h, a)
  h.cursors.delete(cursor)
  if (a.ledger_next != null) h.cursors.add(a.ledger_next)
}

/** The next ledger read of held lane `key`, or null when none is pending. */
export function ledgerAsk(desk, key) {
  const c = desk.held.get(key)?.cursors.values().next().value
  return c == null ? null : { lane: key, ledger: c }
}

/** The lane is held and its ledger chain is read to the end (2.4's group counts are exact). */
export const ledgerDone = (desk, key) => !!desk.held.get(key) && desk.held.get(key).cursors.size === 0

/**
 * Read lane `key`'s ledger chain to the end with `read(name, params)` (envelope {ok, data, error}). A failed read stops and
 * leaves its cursor pending. → {ok: true} | {ok: false, error}; null when `stale()` turned true.
 */
export async function readLedger(desk, key, read, stale = () => false) {
  for (let q = ledgerAsk(desk, key); q; q = ledgerAsk(desk, key)) {
    const r = await read('lane', q)
    if (stale()) return null
    if (!r || !r.ok || !r.data) return { ok: false, status: r && r.status, error: (r && r.error) || 'cause not known' }
    applyLedger(desk, key, q.ledger, r.data)
  }
  return { ok: true }
}

// the same file under two spellings: equal, or one is a path suffix of the other (absolute vs relative). As sets: x names an opened
// file p when x is p or one of p's '/'-suffixes (`tails`), or p is one of x's. Two set lookups per spelling instead of a scan of every
// opened file per seen path (a long lane's thousands of seen paths × hundreds of opened files was 15-23 ms of every repaint).
const tails = (p) => { const out = [p]; for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) out.push(p.slice(i + 1)); return out }

/**
 * 2.4's 「只见到名字」 (2.4:148): the held lane's `seen` minus every path naming a file the lane opened (same file, above), in the
 * step order of `firstRid`, then `count` descending (E6). Uncapped (SEEN_CAP is the renderer's). null when not held.
 */
export function seenFiles(desk, key) {
  const h = desk.held.get(key)
  if (!h) return null
  const opened = [...h.resources.values()].filter((r) => r.kind === 'file').map((r) => String(r.label))
  const openedTails = new Set(opened.flatMap(tails)), openedSet = new Set(opened)
  const ts = (rid) => desk.rows.get(rid)?.ts ?? h.steps.get(rid)?.ts ?? ''
  return [...h.seen.values()].filter((x) => !openedTails.has(x.path) && !tails(x.path).some((t) => openedSet.has(t)))
    .sort((x, y) => compareStep(ts(x.firstRid), x.firstRid, ts(y.firstRid), y.firstRid) || y.count - x.count)
}

function applyOps(p, s) {
  const ids = [], at = []
  for (const [op, ...args] of s.ops) {
    if (op === 0) { ids.push(...p.ids.slice(args[0], args[0] + args[1])); at.push(...p.at.slice(args[0], args[0] + args[1])) }
    else for (const b of args) { at.push(s.attrs?.[ids.length] ?? null); ids.push(b) }
  }
  return { ids, at }
}

// {ids, at} for a held step: walk parents back to a cached keyframe or a step with no copy op, then apply forward
function materialise(h, rid) {
  const chain = []
  let cur = null
  for (let r = rid; ;) {
    cur = h.kf.get(r)
    if (cur) break
    const s = h.steps.get(r)
    if (!s) return null
    chain.push(s)
    if (!s.ops.some((o) => o[0] === 0)) { cur = { ids: [], at: [] }; break }
    r = s.parent
  }
  for (let j = chain.length - 1; j >= 0; j--) {
    cur = applyOps(cur, chain[j])
    if (j && j % KF_EVERY === 0) h.kf.set(chain[j].rid, cur)
  }
  return cur
}

function heldOf(desk, rid) {
  const row = desk.rows.get(rid)
  if (row) return [row.lane, desk.held.get(row.lane)]
  for (const [key, h] of desk.held) if (h.steps.has(rid)) return [key, h]
  return [null, undefined]
}

/** The bid list of a held step, or null when that step is not held. */
export function listOf(desk, rid) {
  const [, h] = heldOf(desk, rid)
  const m = h && materialise(h, rid)
  return m ? m.ids.slice() : null
}

/** A step as the renderer reads it; `flat` has one block per list position (content key `fh`, identity `bid`). */
export function stepOf(desk, rid) {
  const row = desk.rows.get(rid) ?? null
  const [lane, h] = heldOf(desk, rid)
  const s = h?.steps.get(rid), m = s && materialise(h, rid)
  if (!m) return { row, lane, held: false, flat: null, reply: null, attrs: null, detail: null }
  const def = (b) => desk.defs.get(b) ?? { bid: b }
  const flat = m.ids.map((b, i) => {
    const d = def(b)
    return { ...d, key: d.fh, text_ref: d.ref, faithfulness: d.ff, query: m.at[i]?.query, volatile: m.at[i]?.volatile }
  })
  return { row, lane, held: true, flat, reply: s.reply.map(def), attrs: m.at, detail: s.detail ?? null }
}

// loaded rows are the newest part of the session, so a lane's loaded rids are the last ones of its header's count
const offset = (desk, key) => { const n = desk.laneRids.get(key)?.length ?? 0; return Math.max(0, (desk.lanes.get(key)?.count ?? n) - n) }

/** The step number of `rid` in lane `key` (0-based), or -1. */
export function indexOf(desk, key, rid) {
  const i = desk.laneRids.get(key)?.indexOf(rid) ?? -1
  return i < 0 ? -1 : i + offset(desk, key)
}

/** The rid at step number `n` of lane `key`, or null when that row is not loaded. */
export const ridAt = (desk, key, n) => desk.laneRids.get(key)?.[n - offset(desk, key)] ?? null
