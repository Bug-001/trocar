// replay/follow.mjs — the replay desk's live-follow and polling policy, pure so it can be tested without a DOM: when the timer may
// read, where the playhead lands after a fetch (and whether the URL's `step` has to follow it),
// how the poll loop backs off after a failed read, and when a step's own reads (its lane, its open rows' bodies) go out.
import { loadBodies } from './cell.mjs'

// Where the playhead lands after a fetch that left the anchor lane with N (≥ 1) calls. `initialStep` is the 1-based step the URL
// named when the screen opened (null otherwise): start there, clamped into range. Otherwise a playhead that follows the live end
// moves to the last call as the session grows, and any playhead is clamped if the lane shrank.
// → { playhead, follow, syncUrl } — `syncUrl` is true when the URL's `step` may no longer name the playhead: the URL step was out of
// range, or the playhead moved by itself (following growth, or a clamp). The caller then rewrites the step with `replace`, so a
// reload lands where the board is and growth leaves no history entry per call.
export function landPlayhead({ N, playhead, follow, initialStep }) {
  const last = N - 1
  if (initialStep != null) {
    const ph = Math.max(0, Math.min(last, initialStep - 1))
    return { playhead: ph, follow: ph === last, syncUrl: ph !== initialStep - 1 }
  }
  const ph = Math.min(follow ? last : playhead, last)
  return { playhead: ph, follow, syncUrl: ph !== playhead }
}

// Where a page sits around call `gi`: `{after, limit}` with it at the middle. The desk no longer pages (D69); this stays only
// while test/query/worker-memory.test.mjs (lane Q, which drops it) imports it — D8 deletes it with that merge.
export const pagePlace = (gi, limit) => {
  const h = Math.floor(limit / 2), g = Math.max(0, gi | 0)
  return g >= h ? { after: g - h, limit } : { after: 0, limit: 2 * g + 1 }
}

// ── the poll loop: one read in flight, back-off after a failure (1.5 K-29) ──────────────────────────────────────────────
export const BACKOFF_MAX_MS = 30000
// the wait after `n` (≥ 1) failures in a row: the poll interval doubled n times, at most BACKOFF_MAX_MS
export const backoffMs = (n, base) => Math.min(base * 2 ** n, BACKOFF_MAX_MS)

// createPoller({run, now, base, alive, idle}) → {poll(byReader)}. `run()` reads once and resolves {ok:false} on a failure,
// {pending:…} when extraction has not caught up (4.4 live-poll, 3.5 §抽取前沿), anything else on success.
//   · a timer tick (byReader false) does nothing while idle() holds (a hidden tab, a session that is not listed), nor before the
//     next read is due; a reader's own action (byReader true) always reads
//   · due (C2, 4.4 live-poll): after a failure, the back-off; after a success that answered `pending` or ended a back-off, at
//     once (the timer's own interval is the gap); after any other success that took D ms, 3·D from its start when 3·D > base
//     (a slow worker gets at most a third of the time from the timer), else at once
//   · a call while a read is in flight asks for one more read after it; after a success that read runs when a reader asked or it
//     is due, after a failure only a reader's request does — a failure never re-reads by itself, so one failing read cannot loop
export function createPoller({ run, now = Date.now, base, alive = () => true, idle = () => false }) {
  let busy = false, again = false, readerAgain = false, fails = 0, nextAt = 0
  async function poll(byReader = false) {
    if (!alive()) return
    if (!byReader && (idle() || now() < nextAt)) return
    if (busy) { again = true; readerAgain = readerAgain || byReader; return }
    busy = true
    try {
      let go = true
      while (go && alive()) {
        again = false; readerAgain = false
        const t0 = now()
        const r = await run()
        if (r && r.ok === false) { fails++; nextAt = now() + backoffMs(fails, base); go = readerAgain }
        else {
          const d = now() - t0, plain = !fails && !(r && r.pending)
          fails = 0; nextAt = plain && 3 * d > base ? t0 + 3 * d : 0
          go = readerAgain || (again && !idle() && now() >= nextAt)
        }
      }
    } finally { busy = false }
  }
  return { poll }
}

// ── a step's own reads (2.3 §读与画 快速拖动; 4.4 live-poll, C3) ───────────────────────────────────────────────────────────
// createStepReads({get, setTimer, clearTimer, need, onLane, onBodies, restMs}) → {target(rid), prefetch(key)}. Injected, no DOM.
//   · target(rid): the playhead's call. Once it has rested `restMs` with no newer target, need(rid) → {lane: {lane, from?, to?} |
//     null, refs: string[]} says what that step still lacks; at most one `lane` and one `block` read are in flight at a time
//   · a newer target aborts at once the reads asked for any other step (a prefetch too); an aborted read is not a failure and
//     calls back nothing
//   · onLane(rid, answer) hears a lane read's envelope (rid null for a prefetch); after a successful one the step is asked again
//     (its rows' refs may now be known), but never for the same lane query twice per target; onBodies(rid, got[]) hears the bodies
//   · prefetch(key) reads lane `key` only when nothing is in flight and no target is resting
export function createStepReads({ get, setTimer = setTimeout, clearTimer = clearTimeout, need, onLane, onBodies, restMs = 100 }) {
  let want = null, timer = null, lastLane = null
  const out = { lane: null, block: null } // the read in flight of each kind: {rid, ac}
  const api = { get }
  function start(kind, rid, what) {
    const ac = new AbortController(), f = { rid, ac }
    out[kind] = f
    const p = kind === 'lane' ? get('lane', what, { signal: ac.signal }) : loadBodies(api, what, { signal: ac.signal })
    p.then((r) => {
      out[kind] = null
      if (ac.signal.aborted) { if (timer == null && want != null) go(); return }
      if (kind === 'block') { onBodies(rid, r); return }
      onLane(rid, r)
      if (r && r.ok && rid != null && rid === want) go()
    })
  }
  function go() {
    const rid = want, n = need(rid) || {}
    if (n.lane && !out.lane) {
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
      if (out.lane || out.block || timer != null) return
      start('lane', null, { lane: key })
    },
  }
}
