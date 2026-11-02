// replay/keymap.mjs — the replay desk's keys (1.2 §键盘), pure: which step a key goes to, or which toggle it means.
// keyAction({key, shiftKey}, {at, n, problems, chapters, step}) → {to} (an index clamped into [0, n-1]) | {chapter} (a global step) |
// {follow:true} | {keys:true} | null. `problems` is the ascending step list of timeline.mjs : problemSteps; `chapters` the head's
// chapter table and `step` the global step of `at` (timeline.mjs : chapterHere).
import { chapterJump } from './timeline.mjs'
const clamp = (i, n) => Math.max(0, Math.min(n - 1, i))

export function keyAction(e, { at, n, problems = [], chapters = null, step = at }) {
  const k = e && e.key
  if (k === 'f') return { follow: true }
  if (k === '?') return { keys: true }
  if (!(n > 0)) return null
  const by = e.shiftKey ? 10 : 1
  if (k === 'ArrowLeft') return { to: clamp(at - by, n) }
  if (k === 'ArrowRight') return { to: clamp(at + by, n) }
  if (k === 'Home') return { to: 0 }
  if (k === 'End') return { to: n - 1 }
  if (k === 'n') { const i = problems.find((p) => p > at && p < n); return i == null ? null : { to: i } }
  if ((k === '[' || k === ']') && chapters && chapters.length) { const g = chapterJump(chapters, step, k === '[' ? -1 : 1); return g == null ? null : { chapter: g } }
  if (k === 'p') { const i = problems.findLast((p) => p < at && p >= 0); return i == null ? null : { to: i } }
  return null
}

// the cell keys (RFC 2.3 §两种模式), pure: v flips this cell's mode, Shift+V the desk default, c copies the cell's bytes.
// Any Ctrl / Meta / Alt chord belongs to the browser or the OS. keyAction leaves these keys alone.
export function cellKey(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'V' || (e.key === 'v' && e.shiftKey)) return { flipDesk: true }
  if (e.key === 'v') return { flip: true }
  if (e.key === 'c') return { copy: true }
  return null
}
