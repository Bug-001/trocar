// src/collector/core/loop-late.mjs — the daemon's event loop came back late (4.6 §记录, MA20): the direct evidence of a stall, read off the 1 s lock timer the
// daemon already runs, so it adds no wakeup (D62④). monitorEventLoopDelay would arm a native 10 ms timer, ~100 wakeups a second, past that line and out of
// reach of the idle test; and a stall that matters here is ≥ 2 s, which always crosses a 1 s tick. A state event, never a failure: health does not count it.

export const LOOP_LATE_MS = 1000

/** → { tick() }, to be called from a timer of period everyMs; write gets one record per tick that came lateMs or more after its due time. */
export function createLoopWatch({ everyMs, write, lateMs = LOOP_LATE_MS, now = () => performance.now() }) {
  let last = now()
  return {
    tick() {
      const t = now()
      const late = t - last - everyMs
      last = t
      if (late >= lateMs) write({ event: 'loop-late', where: 'daemon', code: 'loop-late', level: 'note', late_ms: Math.round(late), reason: `the daemon's event loop ran ${Math.round(late)} ms late; a sleeping machine or a frozen process counts too` })
    },
  }
}
