// replay/follow.mjs — the replay desk's live-follow and polling policy, pure so it can be tested without a DOM: when the timer may
// poll, where the playhead lands after a fetch (and whether the URL's `step` has to follow it), where the next page sits, and
// how the poll loop backs off after a failed read.

// The timer's tick: poll only while the live checkbox is on. Unchecking freezes the view (nothing is fetched, repainted or moved);
// checking it again resumes. Fetches the reader asks for (paging to a call, a retry) do not go through here.
export const pollWhenLive = (isLive, poll) => () => { if (isLive()) poll() }

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
// The cursor that puts call `gi` at the middle of a `limit`-call page: the server keeps bodies around the window's middle, so a
// call there always rides the page. One rule for the follow window and for re-aiming at a step (replay.mjs ensurePage).
export const centerCursor = (gi, limit) => Math.max(0, (gi | 0) - Math.floor(limit / 2))

// After an answer: the cursor the NEXT read of this session should use. While following, the page is placed by THIS answer —
// the followed step (the anchor lane's last call, `tailGi`; absent → the answer's last call, page.total - 1) at its middle —
// never by an earlier answer's total. An answer whose window held no call at all (returned 0 of a non-empty session) is placed
// the same way. Otherwise the reader's window stays. It returns a number only: a fetch never turns following off.
export function followCursor({ follow, page, pageCur, limit, tailGi }) {
  if (!page || typeof page.total !== 'number' || page.total <= 0) return pageCur
  if (!follow && page.returned !== 0) return pageCur
  const t = tailGi != null && tailGi >= 0 ? Math.min(tailGi, page.total - 1) : page.total - 1
  return centerCursor(t, limit)
}

// ── the poll loop: one read in flight, back-off after a failure (1.5 K-29) ──────────────────────────────────────────────
export const BACKOFF_MAX_MS = 30000
// the wait after `n` (≥ 1) failures in a row: the poll interval doubled n times, at most BACKOFF_MAX_MS
export const backoffMs = (n, base) => Math.min(base * 2 ** n, BACKOFF_MAX_MS)

// createPoller({run, now, base, alive}) → {poll(byReader), reset()}. `run()` reads once and resolves {ok:false} on a failure,
// {again:true} when the answer asks for one more read before drawing (a re-aimed page), anything else on success.
//   · a timer tick (byReader false) before the back-off is due does nothing; a reader's own action (byReader true) always reads
//   · a call while a read is in flight asks for one more read after it; after a success that read runs, after a failure only a
//     reader's request does — a failure never re-reads by itself, so one failing read cannot become a loop
//   · a success clears the back-off; reset() clears it too (another session)
export function createPoller({ run, now = Date.now, base, alive = () => true }) {
  let busy = false, again = false, readerAgain = false, fails = 0, nextAt = 0
  async function poll(byReader = false) {
    if (!alive()) return
    if (!byReader && now() < nextAt) return
    if (busy) { again = true; readerAgain = readerAgain || byReader; return }
    busy = true
    try {
      let go = true
      while (go && alive()) {
        again = false; readerAgain = false
        const r = await run()
        if (r && r.ok === false) { fails++; nextAt = now() + backoffMs(fails, base); go = readerAgain }
        else { fails = 0; nextAt = 0; go = again || !!(r && r.again) }
      }
    } finally { busy = false }
  }
  return { poll, reset() { fails = 0; nextAt = 0 } }
}
