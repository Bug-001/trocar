// replay/pace.mjs — the reader first (2.3 §归约前沿 读者优先): when the desk's background work runs against a reader's input. A step change
// counts until it is painted, and a chain of short tasks keeps the frame waiting as surely as one long task, so the work gives way
// around an input instead of only being cut small. Injected, no DOM.
//   createPace({now, sleep, frame, urgent}) → {input(), press(on), hover(on), slice(), calm(), hold(), redraw(), drew()}. urgent(): the reader is
//     waiting for what the work brings (nothing of this step is drawn yet), so it gives way to nothing but a pointer that is down
//   · input(): a key or a press just now. press(on): the pointer went down / came up. hover(on): the pointer moved over the overlay
//     rows (on) or elsewhere (off)
//   · slice(): a background slice's turn: undefined at once, or, within WAY_MS of an input, a promise of the time after the next paint
//   · calm(): until the reader has stopped, at most HOLD_MS; while a pointer is down until it comes up, at most PRESS_MS
//   · hold(): calm, then while the pointer is on the overlay rows: until it leaves them, rests HOVER_MS, or HOVER_MS have passed
//   · redraw(): a redraw's turn: REDRAW_MS after the last one (drew()), calm, and while the pointer is on the overlay rows until it
//     leaves them, rests HOVER_MS or HOVER_MS have passed (a mark stays where the reader aims until the press), urgent or not
export const WAY_MS = 100, HOLD_MS = 500, PRESS_MS = 5000, REDRAW_MS = 100, HOVER_MS = 1000
const PAINT_MS = 50 // no frame comes in a hidden tab: a timer stands in

export function createPace({ now, sleep, frame, urgent = () => false }) {
  let inputAt = -Infinity, down = false, downAt = 0, drewAt = -Infinity, over = false, movedAt = 0
  const acting = () => now() - inputAt < WAY_MS
  const pressed = () => down && now() - downAt < PRESS_MS
  const hovered = () => over && now() - movedAt < HOVER_MS
  const painted = () => new Promise((go) => { frame(() => sleep(0).then(go)); sleep(PAINT_MS).then(go) })
  // a redraw's own wait: calm, then the pointer on the overlay rows, urgent or not, as a press (the rows exist only once a step is
  // drawn): until it leaves them or rests HOVER_MS, and never more than HOVER_MS in all, so a pointer that keeps moving there does not
  // hold the reads behind the redraw
  async function hold() {
    await calm()
    for (const t0 = now(); hovered() && now() - t0 < HOVER_MS;) await painted()
  }
  async function calm() {
    for (const t0 = now(); pressed() || (acting() && now() - t0 < HOLD_MS && !urgent());) await painted()
  }
  return {
    input() { inputAt = now() },
    press(on) { down = on; if (on) inputAt = downAt = now() },
    hover(on) { over = on; if (on) movedAt = now() },
    slice: () => (acting() && !urgent() ? painted() : undefined),
    calm,
    hold,
    async redraw() {
      for (let due = drewAt + REDRAW_MS; !urgent() && now() < due;) await sleep(due - now())
      await hold()
    },
    drew() { drewAt = now() },
  }
}
