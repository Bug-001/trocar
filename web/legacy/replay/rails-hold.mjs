// replay/rails-hold.mjs — 2.3 读者优先 for the overlay rows: an answer's paint of the rows waits while the pointer is on them, so the tick a
// reader aims at stays where it is. Only the paint waits (the caller has already updated the model), at most HOLD_RAILS_MS from the first
// paint held, or until the pointer comes up when it is down then (a press whose node is rewritten sends no click); leaving the rows draws
// it. A draw the reader causes is at once and ends the wait; drop() ends it without drawing (the page drew the rows its own way). The first answer
// after a reader's draw paints at once: that draw can come in the middle of an answer's redraw (a click on the rows lands there), and shows the
// lanes before their window is placed, which is not a paint to keep under the pointer. Injected, no DOM.
//   createRailsHold({setTimer, clearTimer, draw}) → { over(on), press(on), answer(), reader(), drop() }
export const HOLD_RAILS_MS = 1000

export function createRailsHold({ setTimer, clearTimer, draw }) {
  let on = false, down = false, timer = null, due = false, met = false // due: the time is up, waiting for the pointer to come up; met: a reader's draw since the last answer
  const drop = () => { if (timer) { clearTimer(timer); timer = null } due = false }
  const flush = () => { drop(); draw() }
  return {
    over(v) { on = v; if (!v && (timer || due) && !down) flush() },
    press(v) { down = v; if (!v && (due || (timer && !on))) flush() },
    answer() {
      if (!down && (met || !on)) { met = false; return flush() }
      if (!timer && !due) timer = setTimer(() => { timer = null; if (down) due = true; else draw() }, HOLD_RAILS_MS)
    },
    reader() { met = true; flush() },
    drop,
  }
}
