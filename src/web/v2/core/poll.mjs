// core/poll.mjs — the board's one poll engine (1.5 K-29, 4.4 §live-poll): every timer read of every screen goes through it, so
// no screen can poll faster than 4.4's table, keep reading while hidden, or hammer a failing read. Pure but for the timer and the
// document's visibility, both injectable.

// the periods of 4.4 §live-poll's table, by query name (one fact, one place)
export const INTERVAL = Object.freeze({ status: 5000, sessions: 15000, session: 1500, other: 30000 })

// ── the poll loop: one read in flight, back-off after a failure (1.5 K-29) ──────────────────────────────────────────────
export const BACKOFF_MAX_MS = 30000
// the performance mark a round the timer began sets as it starts (detail: {base}), so a timer's read can be told from one a reader's
// action caused (1.4 §D64: a step change sends none); dropped from the timeline at once, so a board left open holds none of them
export const TIMER_ROUND = 'poll-timer'
const markTimerRound = (base) => {
  if (typeof performance === 'undefined' || !performance.mark) return
  performance.mark(TIMER_ROUND, { detail: { base } }); performance.clearMarks(TIMER_ROUND)
}
// the wait after `n` (≥ 1) failures in a row: the poll interval doubled n times, at most BACKOFF_MAX_MS
export const backoffMs = (n, base) => Math.min(base * 2 ** n, BACKOFF_MAX_MS)

// createPoller({run, now, base, alive, idle}) → {poll(byReader)}. `run()` reads once and resolves {ok:false} on a failure,
// {pending:…} when extraction has not caught up (4.4 live-poll, 3.5 §抽取前沿), anything else on success.
//   · a timer tick (byReader false) does nothing while idle() holds (a hidden tab, a session that is not listed), nor before the
//     next read is due; a reader's own action (byReader true) always reads
//   · due (4.4 live-poll): after a failure, the back-off; after a success that answered `pending` or ended a back-off, at
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
      let go = true, reader = byReader
      while (go && alive()) {
        if (!reader) markTimerRound(base)
        again = false; readerAgain = false
        const t0 = now()
        const r = await run()
        reader = readerAgain
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

// startPoll({run, base, soon, now, doc}) → {poll(byReader), stop()}: a createPoller driven by a timer every `base` ms, idle while `doc` is
// hidden, one read at once on start (when visible) and the moment `doc` is visible again. A reader's read and a visible-again read
// restart the timer, so no timer read comes less than `base` after them (4.4: never faster than the table). A read that throws
// counts as a failure. After stop() nothing reads and the listener is gone. With `soon`, a read that answered `pending` brings the
// next timer read in `soon` ms after it instead of `base` (4.4 live-poll: a stored answer is followed by the fresh one).
export function startPoll({ run, base, soon, now = () => Date.now(), doc = globalThis.document }) {
  let stopped = false, timer = 0
  const safe = async () => {
    let r
    try { r = await run() } catch { r = { ok: false } }
    if (soon && r && r.pending && !stopped) { clearTimeout(timer); timer = setTimeout(tick, soon) }
    return r
  }
  const p = createPoller({ run: safe, base, now, alive: () => !stopped, idle: () => !!(doc && doc.hidden) })
  const tick = () => { if (stopped) return; timer = setTimeout(tick, base); p.poll(false) }
  const byReader = () => { if (stopped) return; clearTimeout(timer); timer = setTimeout(tick, base); return p.poll(true) }
  const onVis = () => { if (doc && !doc.hidden) byReader() }
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis)
  timer = setTimeout(tick, base)
  if (!(doc && doc.hidden)) p.poll(true)
  return {
    poll: (reader = true) => (reader ? byReader() : p.poll(false)),
    stop() {
      stopped = true; clearTimeout(timer)
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis)
    },
  }
}
