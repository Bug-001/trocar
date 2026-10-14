// procinfo.mjs — the per-pid process facts of the Windows collector, asked TARGETED at accept time (RFC 4.9 §5.3, D47; the win32 twin of the darwin procinfo,
// the facts backend the shared door core asks).
//
// The ps-scan watcher is gone (it went with the kernel: the 2 s poll, the exec/exit-by-difference, the demand poll, the unreadable table). What identity
// needs now is ONE process — the one that owns the socket the engine just accepted — and the one question that answers it is the resident helper's `ps`
// verb: a Toolhelp32 snapshot of this session with the image path, start time, session and token integrity through PROCESS_QUERY_LIMITED_INFORMATION
// (which opens across integrity levels) and the command line from CIM (cached per pid:start inside the helper, at most three tries when the answer is
// empty, a 30 s back-off after a CIM failure — E6's rules, all of it in helper.ps1). The row of that pid is the answer; a pid nobody lists is gone (not an
// error). One ask per process LIFE (the caller caches by pid + startedAt), never a sweep anyone reads.
//
// ProcFacts = the Linux contract (core/redirector.mjs) as far as the answer has the fields: { os:'win32', pid, ppid, name, exe, argv, cmdline, env:null
// (envError 'env-unreadable': another process's environment is never read, 4.8 §10.1) with envRead:false — the OS's rule, not a failure to read, so the
// tracker judges by the entry files instead of vetoing (4.8 §5.4) —, cwd:null, startedAt (ms since the epoch, or null), startTicks (startedAt as a string),
// sessionId, integrity, tokenDenied, elevated, elevationInferred, cmdlineState, source:'accept' }. `cmdline` is the raw command line (the one lossless
// form on Windows; `argv` is it split like CommandLineToArgvW). It may hold secrets: callers keep it in memory and never write it to a record. `cmdline:
// null` is two different things, told by `cmdlineState`: not known YET (`pending`, `cim-backoff`) or not there (`empty`, `not-asked`) — and on the
// accept-time seam there is no "later" to wait for: a form that needs the command line and does not have it simply does not match this ask (the fail-safe
// answer, never a wrong one). Only this session's processes are in the helper's snapshot: a process of another session is not this user's agent.

import { splitCommandLine } from '../../../off/winargv.mjs'

/** How long one targeted ask waits: the first `ps` after the helper starts has an empty command-line cache, so more than 40 processes take a full
 *  Win32_Process enumeration through CIM (plus the module load), which on a cold or busy machine is more than the 2 s a table read gets. */
export const PS_TIMEOUT_MS = 10000
/** What a ps row's `cmdlineState` can say (helper.ps1 decides; a test keeps the two lists equal): `ok` the command line is there · `pending` asked, no
 *  answer yet · `cim-backoff` CIM failed, not asked again for 30 s · `empty` asked three times and CIM has none (a process without one, or one CIM does
 *  not show) · `not-asked` the caller said `cmdline:false`. `pending` and `cim-backoff` are NOT "no command line": it may still come — on the accept-time
 *  seam nothing waits for it. */
export const CMDLINE_STATES = Object.freeze(['ok', 'pending', 'cim-backoff', 'empty', 'not-asked'])
/** The state of a row's command line; a helper that does not say (an older one, a fixture): a command line is `ok`, none is `empty` (final: nothing will come). */
const cmdStateOf = (row) => (typeof row.cmdlineState === 'string' ? row.cmdlineState : row.cmdline != null ? 'ok' : 'empty')

const ELEVATED = new Set(['high', 'system', 'protected'])

/** Is the process elevated? { elevated: true | false | null, inferred }. Integrity High or above is elevated. A token that cannot be opened while the
 *  image path can (PROCESS_QUERY_LIMITED_INFORMATION opens across integrity levels, the token does not) is judged elevated and marked inferred
 *  (4.8 §10.1). With neither the answer is null: not known. */
export function elevationOf(row) {
  if (row.integrity != null) return { elevated: ELEVATED.has(row.integrity), inferred: false }
  if (row.tokenDenied && row.exe != null) return { elevated: true, inferred: true }
  return { elevated: null, inferred: false }
}

/** splitCommandLine(cmdline) → argv, the CommandLineToArgvW rules: one function for the collector and `off` / `status` (src/off/winargv.mjs), so both
 *  sides hand the name list the same argv for the same process (4.6 §识别进程, 4.8 W76). Re-exported here for the win32 callers. */
export { splitCommandLine }

/** One helper `ps` row as ProcFacts. `source` is the ask's own ('accept' on this seam). */
export function factsOfRow(row, source = 'accept') {
  const { elevated, inferred } = elevationOf(row)
  const facts = {
    os: 'win32', pid: row.pid, ppid: row.ppid ?? null, name: row.name ?? null, exe: row.exe, argv: splitCommandLine(row.cmdline), cmdline: row.cmdline ?? null,
    env: null, envRead: false, cwd: null, startedAt: row.startedAt ?? null, startTicks: row.startedAt != null ? String(row.startedAt) : null,
    sessionId: row.sessionId ?? null, integrity: row.integrity ?? null, tokenDenied: !!row.tokenDenied, elevated, elevationInferred: inferred, source, cmdlineState: cmdStateOf(row),
  }
  Object.defineProperty(facts, 'envError', { enumerable: false, value: 'env-unreadable' })
  return facts
}

/** factsOfPid(pid, { helper, psTimeoutMs }) → ProcFacts | null — the facts of ONE process, asked targeted through the resident helper's `ps` verb (the
 *  row of that pid in the session snapshot; the snapshot is the helper's own, its command lines cached in it). null = the pid is gone or the helper did
 *  not answer (a dead process between the accept and the ask is the common case, not an error; a helper that is down or times out leaves the connection
 *  judged untracked, never guessed — the ask never throws into the lookup). The caller caches by pid + startedAt: a wrapped pid (another life, another
 *  start time) is asked again, a living one is asked once. */
export async function factsOfPid(pid, { helper, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pid)) throw new TypeError('factsOfPid needs the pid (an integer)')
  if (!helper || typeof helper.call !== 'function') throw new TypeError('factsOfPid needs the helper client (helper.mjs)')
  let r
  try { r = await helper.call('ps', {}, { timeoutMs: psTimeoutMs }) } catch { return null } // helper down / timed out / refused: no facts, the fail-safe answer
  if (!r || !Array.isArray(r.procs)) return null
  const row = r.procs.find((x) => x && x.pid === pid)
  return row ? factsOfRow(row, 'accept') : null
}
