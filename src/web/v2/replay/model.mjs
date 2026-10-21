// src/web/v2/replay/model.mjs — the replay desk's data model over the three session reads (RFC 3.5 §会话读; 2.3 #22).
//
// Pure: no DOM, fetch, timers or module state. The desk holds the session's skeleton rows by rid in step order, the lane
// headers by key (the lane's first rid), held lanes as steps with ops, and block definitions by bid. A step's bid list is
// materialised from the nearest keyframe by its ops; one keyframe is cached every 32 steps of a walk. The playhead is a rid,
// step numbers are derived (indexOf / ridAt).
//
//   applySession(desk, answer[, {before}]) → {reset, touched}   a full answer, a --since delta, or a --before page
//   laneAsk(desk, key, touched) → {lane, from?}                  3.5's from-rule for a held lane the delta touched
//   applyLane(desk, answer) → {reset}                            a tail / reset page, an older (--to) page, a --from page
//   listOf(desk, rid) → bid[] | null    stepOf(desk, rid) → {row, lane, held, flat, reply, attrs, detail}

// D8 replaces with ../../../view/step-order.mjs
const compareStep = (tsA, idA, tsB, idB) => String(tsA).localeCompare(String(tsB)) || String(idA).localeCompare(String(idB))

const KF_EVERY = 32

export function createDesk() {
  return {
    mark: null, pending: null, firstPending: true, truncated: null, meta: null, stats: null, logged: 0, probes: 0,
    unknown: null, errors: [], more: false,
    rows: new Map(), order: [], lanes: new Map(), laneRids: new Map(), events: new Map(), held: new Map(), defs: new Map(),
  }
}

const tsOf = (desk, rid) => desk.rows.get(rid)?.ts ?? ''

// insert rid into an array kept in step order (the row must already be in desk.rows)
function place(desk, arr, rid) {
  const ts = tsOf(desk, rid)
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (compareStep(tsOf(desk, arr[m]), arr[m], ts, rid) < 0) lo = m + 1; else hi = m }
  arr.splice(lo, 0, rid)
}
function unplace(arr, rid) { const i = arr.lastIndexOf(rid); if (i >= 0) arr.splice(i, 1) }

function addRow(desk, row) {
  desk.rows.set(row.rid, row)
  place(desk, desk.order, row.rid)
  if (!desk.laneRids.has(row.lane)) desk.laneRids.set(row.lane, [])
  place(desk, desk.laneRids.get(row.lane), row.rid)
}
function removeRow(desk, row) {
  unplace(desk.order, row.rid)
  const l = desk.laneRids.get(row.lane)
  if (l) { unplace(l, row.rid); if (!l.length) desk.laneRids.delete(row.lane) }
  desk.rows.delete(row.rid)
}

function scalars(desk, a) {
  for (const k of ['truncated', 'meta', 'stats', 'logged', 'probes']) if (k in a) desk[k] = a[k]
  desk.pending = a.pending ?? null
  if (!a.pending) desk.firstPending = false
  desk.unknown = a.unknown ?? null
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

const newHeld = () => ({ steps: new Map(), rids: [], prev: null, next: null, resources: new Map(), seen: new Map(), events: new Map(), kf: new Map() })

// drop held steps from index i on, with their cached keyframes and lane events
function cut(h, i) {
  const gone = new Set(h.rids.splice(i))
  for (const rid of gone) { h.steps.delete(rid); h.kf.delete(rid) }
  for (const [k, e] of h.events) if (gone.has(e.rid)) h.events.delete(k)
}

/**
 * 3.5's from-rule: every affected row after the held tip → `from = tip`; otherwise drop the held steps from the earliest
 * affected one on and ask `from` = the held step before it, or the whole lane when nothing is left before it.
 */
export function laneAsk(desk, key, touched) {
  const h = desk.held.get(key), t = touched?.get(key)
  if (!h || !h.rids.length || t?.earliest === null) { if (h) cut(h, 0); return { lane: key } }
  // a held step's ts: its row's, or the one it had when it was stored (a gone row has none left)
  const ts = (rid) => desk.rows.get(rid)?.ts ?? h.steps.get(rid)?.ts ?? ''
  const atOrAfter = (rid) => rid === t.earliest || compareStep(ts(rid), rid, t.ts, t.earliest) >= 0
  const tip = h.rids.at(-1)
  if (!t || !atOrAfter(tip)) return { lane: key, from: tip }
  const i = h.rids.findIndex(atOrAfter)
  cut(h, i)
  return i ? { lane: key, from: h.rids[i - 1] } : { lane: key }
}

function merge(map, items, id) { for (const x of items || []) map.set(id(x), x) }

/**
 * A page without a base and without `next` (tail, reset) replaces the lane's held steps; one without a base but with
 * `next` is an older (--to) page put before them; a page with a base extends the held steps after `base`.
 * Definitions merge by bid; resources / seen / events by identity (key, path, type+rid), the answer's one wins.
 */
export function applyLane(desk, a) {
  merge(desk.defs, a.defs, (d) => d.bid)
  let h = desk.held.get(a.lane)
  const steps = a.steps.map((s) => ({ ...s, ts: desk.rows.get(s.rid)?.ts }))
  let reset = false
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
  merge(h.resources, a.resources, (x) => x.key)
  merge(h.seen, a.seen, (x) => x.path)
  merge(h.events, a.events, (x) => `${x.type}\u001f${x.rid}`)
  return { reset }
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
