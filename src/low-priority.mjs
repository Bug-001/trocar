// src/low-priority.mjs — the nice the daemon's children run at (RFC 1.6 §3.1: nice ≥ 5).
//
// The daemon's own event loop forwards agent traffic, and the work it hands to a child (sealing a closed segment,
// answering a query) is work nobody is waiting on the agent's behalf. So every such child asks the OS to put it
// behind everything else first. One fact in one place (0.1 §2): both children ask for THIS nice, and `asight doctor`
// has one number to compare a running child against.
import nodeOs from 'node:os'

export const NICE = 5

/**
 * lowerPriority({os, say}) → the nice in effect, or null when the OS refused.
 * Best effort and NEVER thrown: a platform or a policy that will not lower a process leaves the child at its
 * parent's priority, which costs CPU share and never an answer. It is said (D38: not silent), on the one channel
 * these children have — their stderr, which the daemon logs.
 */
export function lowerPriority({ os = nodeOs, say = () => {} } = {}) {
  try {
    os.setPriority(0, NICE)
    return os.getPriority(0)
  } catch (e) {
    try { say(`asight: this process could not be put at nice ${NICE} (${String((e && e.message) || e)}); it runs at its parent's priority instead`) } catch { /* no stderr: the parent is gone */ }
    return null
  }
}
