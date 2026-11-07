// replay/rails-hold.mjs — 2.3 读者优先 for the overlay rows: an answer's paint of the rows waits while the pointer is on them, so the tick a
// reader aims at stays where it is. Only the paint waits (the caller has already updated the model), at most HOLD_RAILS_MS from the first
// paint held, or until the pointer comes up when it is down then (a press whose node is rewritten sends no click); leaving the rows draws
// it. A draw the reader causes is at once and ends the wait; drop() ends it without drawing (the page drew the rows its own way). An answer whose
// redraw (begun with start()) met a draw of the reader's paints at once: that draw showed the model half moved, and is not what to keep. Injected, no DOM.
//   createRailsHold({setTimer, clearTimer, draw}) → { over(on), press(on), start(), answer(), reader(), drop() }
export const HOLD_RAILS_MS = 1000

export function createRailsHold({ setTimer, clearTimer, draw }) {
  let on = false, down = false, timer = null, due = false, met = false // due: the time is up, waiting for the pointer to come up; met: see start()
  const drop = () => { if (timer) { clearTimer(timer); timer = null } due = false }
  const flush = () => { drop(); draw() }
  return {
    over(v) { on = v; if (!v && (timer || due) && !down) flush() },
    press(v) { down = v; if (!v && (due || (timer && !on))) flush() },
    start() { met = false },
    answer() {
      if (!down && (met || !on)) { met = false; return flush() }
      if (!timer && !due) timer = setTimer(() => { timer = null; if (down) due = true; else draw() }, HOLD_RAILS_MS)
    },
    reader() { met = true; flush() },
    drop,
  }
}
