// replay/header.mjs — the session head's model functions the React desk and the controller use (1.2 §会话头 · §会话保真行):
// the 采集缺口 judgement, the info popover's totals, how far the head is behind the capture. The head itself is
// web/src/screens/replay/DeskHead.tsx over models.mjs sessionHeadModel().
import { harnessKey } from '../core/chips.mjs'
import { sessionTotals, priceMatch } from '../core/metrics.mjs'
import { placeOf, after } from './packs.mjs'

// ── the 采集缺口 (1.2 §会话保真行): judged, never asserted away ───────────────────────────────────────────────────────
// `doc` is the C.3 `status` document. A failure group counts only when (a) the session's time overlaps the groups' window
// ([failures.since, now]), (b) the group's own [first_ts, last_ts] overlaps the session's [first step, last step], and (c) the
// group's `harness` (via harnessKey) is this session's or absent. No status answer, or no readable window, → null: no
// judgement — and never the words 「没有缺口」. → the matching groups, or null.
export function captureGap(doc, range, harness, now = Date.now()) {
  const f = doc && doc.failures
  if (!f || !range || range.start == null || range.end == null) return null
  const since = Date.parse(f.since || '')
  if (isNaN(since) || range.end < since || range.start > now) return null // outside the window: not judged, not said
  const mine = harness != null ? harnessKey(harness) : null
  const hit = (f.groups || []).filter((g) => {
    const lo = Date.parse(g && g.first_ts), hi = Date.parse(g && g.last_ts)
    if (isNaN(lo) || isNaN(hi) || hi < range.start || lo > range.end) return false // did not touch this session's time
    return g.harness == null || mine == null || harnessKey(g.harness) === mine
  })
  return hit.length ? hit : null
}

// the info popover's numbers: the one computation (core/metrics.mjs), with the desk's price table
export function totalsOf(s) {
  return sessionTotals(s.lanes, (m) => (s.pricing ? priceMatch(s.pricing, m) : null))
}

// behindOf(tip, mark) → {n, more} | null (1.5 K-32): of the tip ids (`x-trocar-tip`, the newest model calls, oldest first) the ones that
// come after `mark` (the newest member the desk holds: packs.mjs desk.newest) in record order; `more` when none of them is at or before
// it — more may lie beyond the list. null when there is no tip or nothing after the mark.
export function behindOf(tip, mark) {
  const ids = String(tip || '').split(' ').filter(Boolean)
  if (!ids.length || mark == null) return null
  const m = placeOf(mark), n = ids.filter((id) => after(placeOf(id), m)).length
  return n ? { n, more: n === ids.length } : null
}
