// replay/follow.mjs — the replay desk's live-follow policy, pure so it can be tested without a DOM: where the playhead lands after
// a fetch, and when a step's own reads (its lane, its open rows' bodies) go out. The poll loop itself is core/poll.mjs.
import { loadBodies } from './cell.mjs'

// Where the playhead lands after a fetch that left the anchor lane with N (≥ 1) calls. `initialStep` is the 1-based step the URL
// named when the screen opened (null otherwise): that step pins the playhead, clamped into range, with follow off even on the newest
// step (1.2 §路由). Otherwise a playhead that follows the live end moves to the last call as the session grows, and any playhead is
// clamped if the lane shrank. → { playhead, follow }
export function landPlayhead({ N, playhead, follow, initialStep }) {
  const last = N - 1
  if (initialStep != null) return { playhead: Math.max(0, Math.min(last, initialStep - 1)), follow: false }
  return { playhead: Math.min(follow ? last : playhead, last), follow }
}

// Where a page sits around call `gi`: `{after, limit}` with it at the middle. The desk no longer pages (D69); this stays only
// while test/query/worker-memory.test.mjs (lane Q, which drops it) imports it — D8 deletes it with that merge.
export const pagePlace = (gi, limit) => {
  const h = Math.floor(limit / 2), g = Math.max(0, gi | 0)
  return g >= h ? { after: g - h, limit } : { after: 0, limit: 2 * g + 1 }
}

// ── the loader's order of the sealed packs (2.3 §读与画 加载器, 点名的一步) ─────────────────────────────────────────────
// packOrder(head, at, held) → [{n, pri}] over head.packs not `held(pack)`, in fetch order: pri 1 the pack whose [s0, s1) holds main-axis
// step `at` (none when `at` is null or in the open tail, `at` ≥ open.s0: the poll reads that), 2 its neighbours, 3 the rest of the
// packs of its chapter (head.chapters), 4 the rest, newest first. Each pack is read `main` then `rest`.
export function packOrder(head, at, held = () => false) {
  const packs = (head && head.packs) || [], open = head && head.open
  if (!packs.length) return []
  const tail = at == null || (open != null && at >= open.s0)
  const home = tail ? (open ? open.n : packs.at(-1).n + 1) : (packs.find((p) => at >= p.s0 && at < p.s1) || packs.reduce((a, p) => (Math.abs(p.s0 - at) < Math.abs(a.s0 - at) ? p : a))).n
  const step = tail ? Math.max(0, (head.steps || 1) - 1) : at
  const ch = ((head && head.chapters) || []).find((c) => step >= c.s0 && step < c.s1)
  const pri = (p) => (p.n === home ? 1 : Math.abs(p.n - home) === 1 ? 2 : ch && p.s0 < ch.s1 && p.s1 > ch.s0 ? 3 : 4)
  return packs.filter((p) => !held(p)).map((p) => ({ n: p.n, pri: pri(p) }))
    .sort((a, b) => a.pri - b.pri || (a.pri === 2 ? a.n - b.n : b.n - a.n))
}

// ── a step's own reads (2.3 §读与画 快速拖动; 4.4 live-poll, C3) ───────────────────────────────────────────────────────────
// createStepReads({get, setTimer, clearTimer, need, onLane, onBodies, restMs, loader}) → {target(rid), prefetch(key), laneSlot(fn)}. Injected, no DOM.
//   · with a `loader` (loader.mjs) every read goes through it: a `block` read at pri 0, a `lane` read at pri 1
//   · target(rid): the playhead's call. Once it has rested `restMs` with no newer target, need(rid) → {lane: {lane, from?, to?} |
//     null, refs: string[]} says what that step still lacks; at most one `lane` and one `block` read are in flight at a time
//   · a newer target aborts at once the reads asked for any other step (a prefetch too); an aborted read is not a failure and
//     calls back nothing
//   · onLane(rid, answer, query) hears a lane read's envelope (rid null for a prefetch); after a successful one the step is asked
//     again (its rows' refs may now be known), but never for the same lane query twice per target; onBodies(rid, got[], refs)
//     hears the bodies
//   · prefetch(key) reads lane `key` only when nothing is in flight and no target is resting
//   · laneSlot(fn) runs the caller's own lane reads (the poll's) in the one `lane` slot: it waits for the step's lane read in
//     flight, and the step's next lane read waits for it
export function createStepReads({ get: get0, setTimer = setTimeout, clearTimer = clearTimeout, need, onLane, onBodies, restMs = 100, loader = null }) {
  let want = null, timer = null, lastLane = null, slot = null, waited = false
  const out = { lane: null, block: null } // the read in flight of each kind: {rid, ac, p}
  const join = (a, b) => (a && b ? AbortSignal.any([a, b]) : a || b)
  const get = (name, p, o = {}) => (loader ? loader.run(name === 'block' ? 0 : 1, (sig) => get0(name, p, { ...o, signal: join(o.signal, sig) })) : get0(name, p, o))
  const api = { get }
  function start(kind, rid, what) {
    const ac = new AbortController(), f = { rid, ac }
    out[kind] = f
    // a read that threw is a failure like any other: it reaches onLane / onBodies with its reason, never strands the slot
    const why = (e) => String((e && e.message) || e || 'cause not known')
    const p = kind === 'lane' ? get('lane', what, { signal: ac.signal }).catch((e) => ({ ok: false, error: why(e) }))
      : loadBodies(api, what, { signal: ac.signal }).catch((e) => what.map(() => ({ status: 'error', error: why(e) })))
    f.p = p.then((r) => {
      out[kind] = null
      if (ac.signal.aborted) { if (timer == null && want != null) go(); return }
      if (kind === 'block') { onBodies(rid, r, what); return }
      onLane(rid, r, what)
      if (r && r.ok && rid != null && rid === want) go()
    })
  }
  function go() {
    const rid = want, n = need(rid) || {}
    if (n.lane && slot) waited = true
    else if (n.lane && !out.lane) {
      const k = JSON.stringify(n.lane)
      if (k !== lastLane) { lastLane = k; start('lane', rid, n.lane) }
    }
    if (n.refs && n.refs.length && !out.block) start('block', rid, n.refs)
  }
  return {
    target(rid) {
      want = rid; lastLane = null
      for (const f of Object.values(out)) if (f && f.rid !== rid) f.ac.abort()
      if (timer != null) clearTimer(timer)
      timer = setTimer(() => { timer = null; go() }, restMs)
    },
    prefetch(key) {
      if (out.lane || out.block || slot || timer != null) return
      start('lane', null, { lane: key })
    },
    async laneSlot(fn) {
      while (out.lane || slot) await (out.lane ? out.lane.p.catch(() => {}) : slot)
      let free
      slot = new Promise((r) => { free = r })
      try { return await fn() } finally {
        slot = null; free()
        if (waited && timer == null && want != null) { waited = false; go() }
      }
    },
  }
}
