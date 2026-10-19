// replay/follow.mjs — the replay desk's live-follow policy, pure so it can be tested without a DOM: when the timer may poll, and
// where the playhead lands after a fetch (and whether the URL's `step` has to follow it).

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
