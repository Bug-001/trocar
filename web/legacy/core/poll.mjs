// core/poll.mjs — the board's one poll engine (1.5 K-29, 4.4 §live-poll): every timer read of every screen goes through it, so
// no screen can poll faster than 4.4's table, keep reading while hidden, or hammer a failing read. Pure but for the timer and the
// document's visibility, both injectable.

// the periods of 4.4 §live-poll's table, by query name (one fact, one place)
export const INTERVAL = Object.freeze({ status: 5000, sessions: 15000, session: 1500, other: 30000 })

// ── the poll loop: one read in flight, back-off after a failure (1.5 K-29) ──────────────────────────────────────────────
export const BACKOFF_MAX_MS = 30000
// the wait after `n` (≥ 1) failures in a row: the poll interval doubled n times, at most BACKOFF_MAX_MS
export const backoffMs = (n, base) => Math.min(base * 2 ** n, BACKOFF_MAX_MS)

// createPoller({run, now, base, soon, alive, idle}) → {poll(byReader), start(), stop()}. `run()` reads once and resolves {ok:false} on a
// failure, {pending:…} when extraction has not caught up (4.4 live-poll, 3.5 §抽取前沿), anything else on success.
//   · one schedule: start() arms a timer for the next due round and every round re-arms it when it ends, so the gap between two timer
//     rounds is the due time, whatever phase a reader's or a chained round started at; stop() disarms it
//   · due (4.4 live-poll), from the start t0 of the last round that took D ms: after a failure, the back-off from its end; after a success
//     that answered `pending`, t0 + soon (default base: 「head 带 pending 时下一轮仍在 1.5 s 后」); after one that ended a back-off,
//     t0 + base; after any other success, t0 + max(base, 3·D) (a slow worker gets at most a third of the time from the timer)
//   · a timer tick (byReader false) does nothing while idle() holds (a hidden tab, a session that is not listed), nor before the next
//     round is due; a reader's own action (byReader true) always reads
//   · one round in flight: a tick that finds one running is dropped (the round re-arms the timer when it ends); a reader's call asks for
//     one more round right after it, also after a failure — a failure never re-reads by itself, so one failing read cannot loop
export function createPoller({ run, now = Date.now, base, soon = base, alive = () => true, idle = () => false }) {
  let busy = false, readerAgain = false, fails = 0, nextAt = 0, timer = 0, on = false
  const arm = (at) => { clearTimeout(timer); timer = on ? setTimeout(tick, Math.max(0, at - now())) : 0 }
  function tick() { timer = 0; if (alive()) poll(false) }
  async function poll(byReader = false) {
    if (!alive()) return
    if (busy) { readerAgain = readerAgain || byReader; return }
    if (!byReader && (idle() || now() < nextAt)) { if (!timer) arm(Math.max(nextAt, now() + (idle() ? base : 0))); return }
    busy = true; clearTimeout(timer); timer = 0
    try {
      do {
        readerAgain = false
        const t0 = now()
        const r = await run()
        if (r && r.ok === false) { fails++; nextAt = now() + backoffMs(fails, base) }
        else {
          const wait = r && r.pending ? soon : fails ? base : Math.max(base, 3 * (now() - t0))
          fails = 0; nextAt = t0 + wait
        }
      } while (readerAgain && alive())
    } finally { busy = false; if (alive()) arm(nextAt) }
  }
  return {
    poll,
    start() { on = true; if (!busy) arm(nextAt) },
    stop() { on = false; clearTimeout(timer); timer = 0 },
  }
}

// startPoll({run, base, soon, now, doc}) → {poll(byReader), stop()}: a started createPoller, idle while `doc` is hidden, one read at once
// on start (when visible) and the moment `doc` is visible again. A read that throws counts as a failure. After stop() nothing reads and
// the listener is gone. With `soon`, a read that answered `pending` brings the next timer read `soon` ms after its start instead of
// `base` (4.4 live-poll: a stored answer is followed by the fresh one).
export function startPoll({ run, base, soon, now = () => Date.now(), doc = globalThis.document }) {
  let stopped = false
  const safe = async () => { try { return await run() } catch { return { ok: false } } }
  const p = createPoller({ run: safe, base, soon, now, alive: () => !stopped, idle: () => !!(doc && doc.hidden) })
  const onVis = () => { if (doc && !doc.hidden) p.poll(true) }
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis)
  p.start()
  if (!(doc && doc.hidden)) p.poll(true)
  return {
    poll: (reader = true) => p.poll(reader),
    stop() {
      stopped = true; p.stop()
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis)
    },
  }
}
