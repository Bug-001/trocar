// replay/jump.mjs — a jump that has to wait for its lane. The break navigation (◂ ▸), the drawer's 「第 N 步」 links and a resource card
// all move the playhead and then scroll to something INSIDE that step's context window (the cache-break marker, a resource's block).
// When the target step's lane is not held yet (3.5 §会话读: the `lane` read has not landed) its blocks are not on screen, so the element
// they look for does not exist. The jump is kept (`pending`), run ONCE after the lane has landed and the window has repainted, and
// cleared by the next reader move. Pure (the DOM work is the caller's `perform`), so it is testable.

export const anchorJump = (id) => ({ kind: 'anchor', id })     // scroll to the element with this id
export const blockJump = (resKey) => ({ kind: 'block', resKey }) // open and highlight the block of this resource

// what to do with the pending jump `p` ({ ...jump, step }) now: 'none' (nothing pending) · 'wait' (the target step's lane is not held)
// · 'run' · 'drop' (the playhead is no longer on its step, or the step has no blocks that could ever land: unparsed, no request)
export function jumpDecision(p, { playhead, call, held }) {
  if (!p) return 'none'
  if (p.step !== playhead || !call || call.unparsed || !call.rec) return 'drop'
  return held ? 'run' : 'wait'
}

// getPlayhead / getCall / getHeld read the desk's live state (getHeld: is the playhead step's lane held); perform(jump) scrolls.
export function createJumpQueue({ getPlayhead, getCall, getHeld, perform }) {
  let pending = null
  const q = {
    // aim a jump at `step` and try it right away (a step whose lane is held needs no waiting)
    queue(step, jump) { pending = jump ? { ...jump, step } : null; q.settle() },
    // the desk repainted (a lane landed, the playhead moved by itself): run, keep or drop the pending jump. It runs once.
    settle() {
      const d = jumpDecision(pending, { playhead: getPlayhead(), call: getCall(), held: getHeld() })
      if (d === 'wait' || d === 'none') return
      const { step, ...jump } = pending
      pending = null
      if (d === 'run') perform(jump)
    },
    clear() { pending = null },
    pending() { return pending },
  }
  return q
}
