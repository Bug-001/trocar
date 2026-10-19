// replay/jump.mjs — a jump that has to wait for its page. The break navigation (◂ ▸), the drawer's 「第 N 步」 links and a resource card
// all move the playhead and then scroll to something INSIDE that step's context window (the cache-break marker, a resource's block).
// When the target step is outside the loaded page its body is not on screen yet — the window shows the paged-out notice — so the element
// they look for does not exist, and the jump used to be dropped silently. Now it is kept (`pending`), run ONCE after the page has landed
// and the window has repainted, and cleared by the next user move. Pure (the DOM work is the caller's `perform`), so it is testable.

export const anchorJump = (id) => ({ kind: 'anchor', id })     // scroll to the element with this id
export const blockJump = (resKey) => ({ kind: 'block', resKey }) // open and highlight the block of this resource

// what to do with the pending jump `p` ({ ...jump, step }) now: 'none' (nothing pending) · 'wait' (the target step's body has not arrived)
// · 'run' · 'drop' (the playhead is no longer on its step, or the step has no blocks to land on)
export function jumpDecision(p, { playhead, call }) {
  if (!p) return 'none'
  if (p.step !== playhead || !call || call.unparsed) return 'drop'
  return call.paged_out ? 'wait' : 'run'
}

// getPlayhead / getCall read the desk's live state; perform(jump) does the scrolling.
export function createJumpQueue({ getPlayhead, getCall, perform }) {
  let pending = null
  const q = {
    // aim a jump at `step` and try it right away (an on-page step needs no waiting)
    queue(step, jump) { pending = jump ? { ...jump, step } : null; q.settle() },
    // the desk repainted (a page landed, the playhead moved by itself): run, keep or drop the pending jump. It runs once.
    settle() {
      const d = jumpDecision(pending, { playhead: getPlayhead(), call: getCall() })
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
