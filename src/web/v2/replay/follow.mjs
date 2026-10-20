// replay/follow.mjs — the replay desk's live-follow and polling policy, pure so it can be tested without a DOM: when the timer may
// read, where the playhead lands after a fetch (and whether the URL's `step` has to follow it), where the next page sits, and
// how the poll loop backs off after a failed read.

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

// ── where the page sits (1.2 §会话头 「跟随最新」) ──────────────────────────────────────────────────────────────────────
// Where a page sits: `{after, limit}` with call `gi` at the server's middle (`after + floor(limit/2)`), where it keeps bodies first
// (3.5 §分页 正文预算), so the asked step always rides the page. Near the start the window narrows instead of clamping, so an early
// step is still the middle. One rule for the follow window and for re-aiming at a step (replay.mjs ensurePage).
export const pagePlace = (gi, limit) => {
  const h = Math.floor(limit / 2), g = Math.max(0, gi | 0)
  return g >= h ? { after: g - h, limit } : { after: 0, limit: 2 * g + 1 }
}

// After an answer: where the NEXT read of this session sits ({after, limit}). While following, the page is placed by THIS answer —
// the followed step (the anchor lane's last call, `tailGi`; absent → the answer's last call, page.total - 1) at its middle —
// never by an earlier answer's total. An answer whose window held no call at all (returned 0 of a non-empty session) is placed
// the same way. Otherwise the reader's window (`pageCur`, `pageLim`) stays. A fetch never turns following off.
export function followCursor({ follow, page, pageCur, pageLim, limit, tailGi }) {
  const keep = { after: pageCur, limit: pageLim }
  if (!page || typeof page.total !== 'number' || page.total <= 0) return keep
  if (!follow && page.returned !== 0) return keep
  const t = tailGi != null && tailGi >= 0 ? Math.min(tailGi, page.total - 1) : page.total - 1
  return pagePlace(t, limit)
}

// The load control of a step whose body is not on the page: 'loading' while a read asked for it is out, 'missed' when that read
// answered and the step still did not ride it, 'idle' otherwise (and for a step that has its body).
export function pageState(s, call) {
  if (!call || !call.paged_out) return 'idle'
  if (s.pageLoading != null && s.pageLoading === call.gi) return 'loading'
  if (s.pageMissed != null && s.pageMissed === call.gi) return 'missed'
  return 'idle'
}

// ── the poll loop: one read in flight, back-off after a failure (1.5 K-29) ──────────────────────────────────────────────
export const BACKOFF_MAX_MS = 30000
// the wait after `n` (≥ 1) failures in a row: the poll interval doubled n times, at most BACKOFF_MAX_MS
export const backoffMs = (n, base) => Math.min(base * 2 ** n, BACKOFF_MAX_MS)

// createPoller({run, now, base, alive, idle}) → {poll(byReader)}. `run()` reads once and resolves {ok:false} on a failure,
// {again:true} when the answer asks for one more read before drawing (a re-aimed page), anything else on success.
//   · a timer tick (byReader false) does nothing while idle() holds (a hidden tab, a session that is not listed), nor before the
//     next read is due; a reader's own action (byReader true) always reads
//   · due: after a failure, the back-off; after a success that took D ms, 3·D from its start when 3·D > base (a slow worker gets
//     at most a third of the time from the timer), else at once (the timer's own interval is the gap)
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
          const d = now() - t0
          fails = 0; nextAt = 3 * d > base ? t0 + 3 * d : 0
          go = readerAgain || !!(r && r.again) || (again && !idle() && now() >= nextAt)
        }
      }
    } finally { busy = false }
  }
  return { poll }
}
