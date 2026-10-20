// src/low-priority.mjs — the nice the daemon's children run at (RFC 1.6 §3.1: nice ≥ 5).
//
// The daemon's own event loop forwards agent traffic, and the work it hands to a child (sealing a closed segment,
// answering a query) is work nobody is waiting on the agent's behalf. So every such child asks the OS to put it
// behind everything else first. One fact in one place (0.1 §2): both children ask for THIS nice, and `trocar doctor`
// has one number to compare a running child against.
//
// WHICH number: node's own name for "below normal", never a literal. `os.setPriority` takes a nice and libuv maps it
// to a Windows priority class in BANDS — BELOW_NORMAL_PRIORITY_CLASS begins at 10, so the plain nice 5 this used to
// ask for landed on NORMAL: the call succeeded, `getPriority` reported success, and nothing was lowered. Measured on
// a Windows test machine (2026-10-19): the seal workers and the query worker all ran at Normal / base 8 while the daemon that
// forked them was BelowNormal — the work nobody waits for preempting the work that forwards agent traffic. One
// constant covers every platform with no per-platform branch: on POSIX it IS nice 10, which is ≥ 5.
import nodeOs from 'node:os'

export const NICE = nodeOs.constants.priority.PRIORITY_BELOW_NORMAL

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
    try { say(`trocar: this process could not be put at nice ${NICE} (${String((e && e.message) || e)}); it runs at its parent's priority instead`) } catch { /* no stderr: the parent is gone */ }
    return null
  }
}
