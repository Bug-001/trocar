// procinfo.mjs — the per-pid process facts of the Windows collector, asked TARGETED at accept time (RFC 4.9 §5.3, D47; the win32 twin of the darwin procinfo,
// the facts backend the shared door core asks).
//
// The ps-scan watcher is gone (it went with the kernel: the 2 s poll, the exec/exit-by-difference, the demand poll, the unreadable table). What identity
// needs now is ONE process — the one that owns the socket the engine just accepted — and the one question that answers it is the resident helper's `ps`
// verb: a Toolhelp32 snapshot of this session with the image path, start time, session and token integrity through PROCESS_QUERY_LIMITED_INFORMATION
// (which opens across integrity levels) and the command line from CIM (cached per pid:start inside the helper, at most three tries when the answer is
// empty, a 30 s back-off after a CIM failure — E6's rules, all of it in helper.ps1). The row of that pid is the answer; a pid nobody lists is gone (not an
// error). The door shares one ask between the lookups of a pid in flight, never a sweep anyone reads.
//
// ProcFacts = the Linux contract (core/redirector.mjs) as far as the answer has the fields: { os:'win32', pid, ppid, name, exe, argv, cmdline, env:null
// (envError 'env-unreadable': another process's environment is never read, 4.8 §10.1) with envRead:false — the OS's rule, not a failure to read, so the
// tracker judges by the entry files instead of vetoing (4.8 §5.4) —, cwd:null, startedAt (ms since the epoch, or null), startTicks (startedAt as a string),
// sessionId, sameUser (the helper's row says the process runs as this user), integrity, tokenDenied, elevated, elevationInferred, cmdlineState, source:'accept' }. `cmdline` is the raw command line (the one lossless
// form on Windows; `argv` is it split like CommandLineToArgvW). It may hold secrets: callers keep it in memory and never write it to a record. `cmdline:
// null` is two different things, told by `cmdlineState`: not known YET (`pending`, `cim-backoff`) or not there (`empty`, `not-asked`) — and on the
// accept-time seam there is no "later" to wait for: a form that needs the command line and does not have it simply does not match this ask (the fail-safe
// answer, never a wrong one). The helper's snapshot holds this session's processes and the user's own in every other session (`sameUser`:
// an agent started over ssh or in another RDP session is still the user's agent); another user's process in another session is not listed.

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
    sessionId: row.sessionId ?? null, sameUser: row.sameUser ?? null, integrity: row.integrity ?? null, tokenDenied: !!row.tokenDenied, elevated, elevationInferred: inferred, source, cmdlineState: cmdStateOf(row),
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

// ---- the environment, cwd and parent of a pid (RFC 4.11 P7's proc readers; the upstream chain asks them) --------------------------
// One helper `proc-env` read answers all three (W2: one PEB read gives the environment entries asked for, the current directory and the
// parent that created it). Cached by pid + start time for the life of the process: a busy agent costs one read, not one per connection
// (the single helper channel). A caller that does not know the start time gets no caching (a pid alone can be reused); an answer of
// another life than the one asked about is no answer. Only the named variables are asked for, returned and cached (4.9 §5.2).

/** How long one proc-env read may take once the helper is on it: a PEB read is a few reads of another process's memory. */
export const PROC_ENV_TIMEOUT_MS = 2000
const CACHE_MAX = 4096
const upper = (n) => String(n).toUpperCase()

/** parseProcEnv(data) → { startedAt, cwd, env: Map(UPPER name → [name, value]), ppid, parent: { ppid, startedAt } | null } | null: the
 *  helper's proc-env answer, its environment entries decoded from UTF-16LE. A row the helper could not read (access-denied, gone,
 *  other-user, …) is null. The first entry of a name wins, as GetEnvironmentVariable reads the block. */
export function parseProcEnv(data) {
  if (!data || data.ok !== true) return null
  const env = new Map()
  for (const entry of Buffer.from(String(data.envB64 || ''), 'base64').toString('utf16le').split('\0')) {
    const eq = entry.indexOf('=', 1) // a name is not empty; the hidden per-drive entries (=C:=C:\x) start with '=' and are no variable
    if (eq > 0 && entry[0] !== '=' && !env.has(upper(entry.slice(0, eq)))) env.set(upper(entry.slice(0, eq)), [entry.slice(0, eq), entry.slice(eq + 1)])
  }
  const parent = data.parent && Number.isInteger(data.parent.pid) ? { ppid: data.parent.pid, startedAt: data.parent.startedAt ?? null } : null
  return { startedAt: data.startedAt ?? null, cwd: data.cwd ?? null, env, ppid: data.ppid ?? null, parent }
}

/** procReaders({ helper, timeoutMs, cacheMax }) → { envOf(pid, names, { startedAt }), cwdOf(pid, { startedAt }), parentOf(pid, { startedAt }) },
 *  each async and null when the process cannot be read. envOf → { <asked name>: value } for the names set (compared case-insensitively:
 *  Windows names are); cwdOf → the current directory; parentOf → { ppid, startedAt } of the PARENT that created it (its start time keys
 *  the next step up the chain), null when the parent is gone or its pid now holds a younger process. */
export function procReaders({ helper, timeoutMs = PROC_ENV_TIMEOUT_MS, cacheMax = CACHE_MAX } = {}) {
  if (!helper || typeof helper.call !== 'function') throw new TypeError('procReaders needs the helper client (helper.mjs)')
  const cache = new Map() // `${pid}:${startedAt}` → { names: Set(UPPER), answer: Promise<parsed | null> }
  const ask = async (pid, names) => {
    let data
    try { data = await helper.call('proc-env', { pid, names: [...names] }, { timeoutMs }) } catch { return null }
    return parseProcEnv(data)
  }
  async function read(pid, startedAt, names = []) {
    if (!Number.isInteger(pid) || pid <= 0) return null
    const want = new Set(names.map(upper))
    const check = (r) => (r && (startedAt == null || r.startedAt === startedAt) ? r : null) // another life of the pid is not the process asked about
    if (startedAt == null) return check(await ask(pid, want))
    const key = `${pid}:${startedAt}`
    const held = cache.get(key)
    if (held && [...want].every((n) => held.names.has(n))) {
      const r = check(await held.answer)
      if (r) return r
    }
    const all = new Set([...(held ? held.names : []), ...want])
    const answer = ask(pid, all)
    const entry = { names: all, answer }
    cache.set(key, entry)
    if (cache.size > cacheMax) cache.delete(cache.keys().next().value)
    const r = check(await answer)
    if (!r && cache.get(key) === entry) cache.delete(key) // a failed read is asked again next time
    return r
  }
  return {
    async envOf(pid, names, { startedAt = null } = {}) {
      const want = [...new Set(names)]
      if (!want.length) return {}
      const r = await read(pid, startedAt, want)
      if (!r) return null
      const o = {}
      for (const n of want) { const hit = r.env.get(upper(n)); if (hit) o[n] = hit[1] }
      return o
    },
    async cwdOf(pid, { startedAt = null } = {}) { const r = await read(pid, startedAt); return r ? r.cwd : null },
    async parentOf(pid, { startedAt = null } = {}) { const r = await read(pid, startedAt); return r ? r.parent : null },
  }
}
