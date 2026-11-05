// src/identity/session-identity.mjs
// The compaction verdict (RFC 3.4 「骤降」): PURE functions, no I/O. One rule shared by `trocar query` and the board
// (src/view/{analyze,extract,reduce}.mjs read it); the harness hints and markers it weighs come from the one
// harness table (src/dissect/harnesses.mjs) through those readers. Compaction is not a fork (3.4 关键区分).

// Compaction = a *shrink* of the messages array between consecutive same-session calls (换血),
// NOT a fork. This is the one drop rule of the verdict (compactionVerdict, step 3), shared by query and the board
// (3.4 「骤降」): only a SHARP drop counts — at least 6 messages fewer AND under 70% of what the lane
// had. A small drop alone is not enough: on a real CC session the main lane goes 58 → 55 (no compaction) before the
// real 55 → 4. One exception (3.4): a drop that brings Claude Code's
// own "continued from a previous conversation" preamble in (`cur.preamble`, hasCompactionPreamble) counts whatever its
// size. compactionVerdict passes `preamble` true only on the preamble's RISING edge — once a compaction has put it in
// the history every later call of the lane carries it, and a carried preamble says nothing about a later small dip.
// It fills calls.compaction / compaction_from / compaction_to and MUST NOT touch sessions.fork_of; it is explicitly NOT
// the "message[0] changed" heuristic (3.3).
export function markCompaction(prevMsgCount, curMsgCount, cur = {}) {
  const from = prevMsgCount | 0
  const to = curMsgCount | 0
  const drop = to < from
  const sharp = drop && to < from - 5 && to < from * 0.7
  if (sharp || (drop && cur.preamble)) return { compaction: true, compaction_from: from, compaction_to: to }
  return { compaction: false, compaction_from: null, compaction_to: null }
}

// Claude Code's own summary preamble in the first messages of a compacted context ("This session is being continued
// from a previous conversation …"). One test, read by the board (view/analyze.mjs).
export function hasCompactionPreamble(messages) {
  const textOf = (m) => (typeof (m && m.content) === 'string' ? m.content
    : Array.isArray(m && m.content) ? m.content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n') : '')
  return Array.isArray(messages) && messages.slice(0, 4).some((m) => /continued from a previous conversation/i.test(textOf(m)))
}

// The compaction verdict of ONE call against its in-lane predecessor (3.4), one rule for query and the board.
// prev = what compactionBaseline left, { msgCount, marker, preamble, hinted } (hinted: the calls a harness's request still waits for its landing), or
// null when the lane has none; cur = { hint, marker, msgCount, preamble, failed }. A failed call replaced nothing: no verdict, whatever its evidence.
// Else, in order:
//   1. a harness header / request-kind hint (high) — compaction even on a lane's first call;
//   2. a harness text marker (medium) on its RISING edge only: the marker stays in the history afterwards, and a
//      lane's first call has no edge (the capture may have started after the compaction, or a new synthesized
//      session may still carry an old marker);
//   3. only a sharp message-count drop (medium, markCompaction) — no other evidence, no verdict. CC's own preamble
//      lets a smaller drop count, on its RISING edge only, like the marker: the preamble stays in the first messages of
//      every later call, so a carried one is no evidence (a 30 → 27 dip long after a compaction is no compaction).
// A harness's own request still carries the whole history; the summary replaces it once it has come back, so step 2 or 3 within
// LANDS_WITHIN calls of a hint is that same compaction landing, not another: {compaction: false, lands: true}, with its from / to and basis.
// compaction_from is the predecessor's message count, NULL when the lane has none — never an invented 0
// (invariant 4). `basis` names the evidence that fired, so a reader can say how sure it is.
export function compactionVerdict(prev, cur) {
  const NONE = { compaction: false, compaction_from: null, compaction_to: null, basis: null }
  const from = prev ? prev.msgCount | 0 : null
  const to = cur.msgCount | 0
  if (cur.failed) return NONE
  if (cur.hint) return { compaction: true, compaction_from: from, compaction_to: to, basis: 'hint' }
  const fired = (compaction_from, compaction_to, basis) => (prev && prev.hinted ? { compaction: false, lands: true, compaction_from, compaction_to, basis } : { compaction: true, compaction_from, compaction_to, basis })
  if (cur.marker && prev && !prev.marker) return fired(from, to, 'marker')
  if (!prev) return NONE
  const m = markCompaction(prev.msgCount | 0, to, { preamble: !!cur.preamble && !prev.preamble })
  return m.compaction ? fired(m.compaction_from, m.compaction_to, 'msg-count-drop') : NONE
}

// How many calls with a verdict a harness's request waits for its landing (3.4); past them a drop is a compaction of its own.
const LANDS_WITHIN = 4

// The next call's prev after `cur` got `verdict` (3.4): a failed call leaves prev as it was, so a retry sees the same edges and the same
// drop, and it uses none of the wait. A successful hint starts the wait, a landing ends it, any other call uses one of it.
export function compactionBaseline(prev, cur, verdict) {
  if (cur.failed) return prev
  const hinted = verdict.basis === 'hint' && verdict.compaction ? LANDS_WITHIN : verdict.lands || !prev ? 0 : Math.max(0, (prev.hinted | 0) - 1)
  return { msgCount: cur.msgCount | 0, marker: !!cur.marker, preamble: !!cur.preamble, hinted }
}
