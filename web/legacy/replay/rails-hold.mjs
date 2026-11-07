// replay/rails-hold.mjs — 2.3 读者优先 for the overlay rows: an answer's paint of the rows waits while the pointer is on them, so the tick a
// reader aims at stays where it is. Only the paint waits (the caller has already updated the model), at most HOLD_RAILS_MS from the first
// paint held; leaving the rows draws it. A draw the reader causes is at once and ends the wait. Injected, no DOM.
//   createRailsHold({setTimer, clearTimer, draw}) → { over(on), answer(), reader(), held }
export const HOLD_RAILS_MS = 1000

export function createRailsHold({ setTimer, clearTimer, draw }) {
  let on = false, timer = null
  const flush = () => { if (timer) { clearTimer(timer); timer = null } draw() }
  return {
    over(v) { on = v; if (!v && timer) flush() },
    answer() {
      if (!on) return flush()
      if (!timer) timer = setTimer(() => { timer = null; draw() }, HOLD_RAILS_MS)
    },
    reader: flush,
    get held() { return !!timer },
  }
}
