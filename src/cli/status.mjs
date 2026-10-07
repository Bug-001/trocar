// status.mjs — `asight status [harness…] [--json]` (RFC 1.6 §2, V32): for every agent, captured now, or not and why. This file holds the judgement (judgeHarness: pure), the facts it is made from
// (gatherStatus: the daemon when it answers, the disk when it does not) and the command (runStatusCli). Read-only: it asks the daemon `GET /status`, reads files, lists processes.
// Everything is a `deps` entry a test replaces (0.1 §3). Exit codes (R4): 0 every harness that is on is captured and nothing failed in 24 h · 1 one is not, or something failed ·
// 3 something that decides it could not be read (never 0: a read that failed is not a good answer).
import { STATUS_REASONS } from '../health/codes.mjs'

export { STATUS_REASONS }

const at = (t) => (typeof t === 'string' ? Date.parse(t) : t)
const verdict = (captured, reason = null) => ({ captured, reason })

/**
 * The verdict on one harness (V32), pure. Inputs, every one of them `null` / 'unknown' when it could not be read:
 *   desired      'on' | 'off'
 *   entryIntact  true | false | null — the trust entry asight wrote is still there; `entryWhy` says what is wrong with it when false ('entry-missing' | 'entry-changed')
 *   linkAttached true | false | null — the kernel has this instance's link (read back by the daemon); `helper` 'missing' says the capability helper is absent or the wrong version
 *   daemon       'running' | 'not-running' | 'not-responding' | 'unknown'
 *   procs        [{ pid, startedAt (ms or ISO), trusted: true | false | null, reason, negative }] — the harness's processes that send requests. `trusted` is the daemon's verdict when it answered;
 *                null = not judged: then the start time against the entry's `installedAt` decides (a process older than its entry never read it: config-after-start, 4.6 §确认信任)
 * → { captured: true | false | null, rows: [{ pid?, captured, reason }] }; `reason` is one of STATUS_REASONS, null when captured or not known. With no process the one row has no pid and is
 * the harness's own: 「link 已挂且入口完好」(§1.5). The order of the reasons: desired off · the daemon · the helper · the link · (a process: its own verdict, else the entry, then its start time).
 * The harness is captured when every row is, not captured when any row is not, else not known.
 */
export function judgeHarness({ desired, entryIntact = null, entryWhy = 'entry-missing', linkAttached = null, helper = 'ok', daemon = 'unknown', procs = [], installedAt = null }) {
  const world = (() => {
    if (desired === 'off') return verdict(false, 'desired-off')
    if (desired !== 'on') return verdict(null)
    if (daemon === 'not-running') return verdict(false, 'daemon-not-running')
    if (daemon === 'not-responding') return verdict(false, 'daemon-not-responding')
    if (daemon !== 'running') return verdict(null)
    if (helper === 'missing') return verdict(false, 'helper-missing')
    if (linkAttached === false) return verdict(false, 'link-missing')
    if (linkAttached !== true) return verdict(null)
    return null // nothing in the way
  })()
  const entry = entryIntact === true ? null : entryIntact === false ? verdict(false, entryWhy) : verdict(null)
  if (!procs.length) {
    const v = world || entry || verdict(true)
    return { captured: v.captured, rows: [v] }
  }
  const installed = at(installedAt)
  const rows = procs.map((p) => {
    const row = (v) => ({ pid: p.pid, ...v })
    if (world) return row(world)
    if (p.trusted === false) return row(verdict(false, p.reason === 'off' ? 'desired-off' : p.reason ?? null))
    if (p.trusted === true) return row(p.negative ? verdict(false, 'negative-cache') : verdict(true))
    if (entry) return row(entry)
    const started = at(p.startedAt)
    if (started == null || Number.isNaN(started)) return row(verdict(false, 'start-time-unknown'))
    if (installed == null || Number.isNaN(installed)) return row(verdict(null))
    return row(started < installed ? verdict(false, 'config-after-start') : verdict(true))
  })
  const captured = rows.some((r) => r.captured === false) ? false : rows.some((r) => r.captured === null) ? null : true
  return { captured, rows }
}
