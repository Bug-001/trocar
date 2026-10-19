// procinfo.mjs — the per-pid process facts of the macOS collector, asked TARGETED at accept time (RFC 4.9 §5.3, D47).
//
// The ps-scan watcher is gone (D47 deleted it with its whole machinery: the 2 s poll, the exec/exit-by-difference, the demand poll, the
// unreadable table). What identity needs now is ONE process — the one that owns the socket the engine just accepted — and the one command
// that answers it is `ps -p <pid> -o pid=,ppid=,uid=,comm=,lstart=,args=`: three integers, the accounting name, the five words of lstart
// and the whole command line, exactly the row shape the old table read (the parsing constants are the same, so a format change is still
// one parser's to notice). The EXE cannot come from that row: `ps` repeats the command as invoked — a bare argv[0] for a PATH-launched
// agent, a path CUT at its first space for a binary under `Claude Helper.app` (measured on a macOS machine, 2026-10-12) — so the executable
// and the working directory come from the native `procenv` helper's one read of this pid (`:exe` / `:cwd`, native/procenv.c: the path the
// kernel exec'd, resolved, and the vnode path of the cwd; ~3 ms, measured). Until 2026-10-18 that was `lsof -p <pid> -Fn`'s first txt
// record and `lsof -a -p <pid> -d cwd -Fn`, which walk every process's file table for two facts of one process (~15 ms each, and 310 ms
// for the whole-machine ask of src/off/proc.mjs): no lsof is run on macOS any more. The helper reads the same user's processes only (as
// KERN_PROCARGS2 does); for another user's, the fallback is `ps -p <pid> -o comm=` — argv[0] WHOLE (`comm` as the last column is not cut
// at 16 characters nor at a space, measured), the path as the process was started, never a guess. Two asks per process LIFE (the caller
// caches by pid + startedAt, and the helper's answer is cached by pid + start time for the cwd its reader asks for later), never a sweep
// of the machine.
//
// ProcFacts = the Linux contract (core/redirector.mjs) as far as the two answers have the fields: { os:'darwin', pid, ppid, name, exe,
// argv, cmdline, env:null (envError 'env-unreadable': another process's environment is never read on macOS — no privilege to, and `ps`
// has no such column) with envRead:false — the OS's rule, not a failure, so the tracker judges by the entry files (4.8 §5.4) —, cwd:null,
// startedAt (ms since the epoch, or null), startTicks (startedAt as a string), sessionId (null), integrity (null), tokenDenied (false),
// elevated (uid===0), elevationInferred (false), cmdlineState, source:'accept' }. `name` is `comm`, at most 16 characters (MAXCOMLEN);
// `cmdline` is the raw command line and `argv` is it split on white space — `ps` joins the arguments with spaces, so the argument
// boundaries are lost (the same documented loss as src/off/proc.mjs's table, same command family, one splitter: psArgv) — except argv[0] when the line
// starts with the real exe (a bundle path with spaces stays whole); `argvSplit: true` says so to the name list (src/off/identity.mjs entryOf). `cmdline` may hold secrets: callers
// keep it in memory and never write it to a record.
//
// The commands and the shape of their answers (measured on the darwin kernels this collector runs on, macOS 26.6.2 arm64; ps from the C
// locale, set below, is what keeps the words English):
//   ps -p <pid> -o pid=,ppid=,uid=,comm=,lstart=,args=
//     42177     1   501 /opt/homebrew/Ce Tue Oct  6 17:58:06 2026     /opt/homebrew/Cellar/python@3.14/.../Python -I ...
//   procenv <pid> :exe :cwd  → `:exe=<path>` `:cwd=<path>`, each followed by one NUL; a fact it cannot read is absent (never guessed).
//   ps -p <pid> -o comm=     → argv[0] whole, the fallback when the helper cannot read that process (another user's).
// `lstart` is five words in exactly this format: "Mon Oct  8 17:00:00 2026" — weekday and month as three letters, the day one or two
// digits (a one-digit day is preceded by TWO spaces), the time hh:mm:ss, a four-digit year; local time, to the second. The `=` on every
// column name asks `ps` for no header line; the command column is LAST so this kernel's `ps` does not cap the line at 128 columns and cut
// the command line mid-word (measured) — and `comm` is asked ALONE for the same reason, as any other column after it cuts it to 16
// characters. Everything that touches the machine is injected: `exec` (the runner, spawnSync-shaped —
// execTool's `run`; a test injects one and nothing real runs), `env` (LC_ALL=C is added here: `ps` prints dates in the user's language,
// and under LC_ALL=zh_CN.UTF-8 the five words of lstart are no longer "Mon Oct  8 17:00:00 2026"; the helper prints path bytes as they
// are, so no locale touches it).
import { execTool } from '../../../off/exec.mjs'
import { psArgv } from '../../../off/proc.mjs'
import { NATIVE, nativePath } from './native.mjs'

// The runner may be execTool's spawnSync shape (a test's, the CLI's) or src/off/exec.mjs runAsync (the daemon's accept path, a helper must not
// stop the event loop that serves the other doors). `then` applies the next step at once to a plain answer and after it to a promise: the same code, sync in, sync out.
const then = (x, f) => (x && typeof x.then === 'function' ? x.then(f) : f(x))

/** How long one targeted ask waits: a single-pid read is a small question on any machine — a `ps`/`procenv` that exceeds it is killed by
 *  execTool's timeout and the answer is null (fail-safe: no facts, no form, the connection is spliced untracked), never a guess. */
export const PS_TIMEOUT_MS = 2000

/** A ps row: three integers, the accounting name (any characters — it is bounded by lstart's fixed shape to its right), the five words of
 *  lstart, and the command line to the end of the line. The same shape the old table read. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/
// `ps` prints dates in the user's language: the C locale gives the same five words on every machine (see the file header).
const psEnv = (env) => ({ ...env, LC_ALL: 'C' })

/** The REAL executable of a process — the one source that answers it: `ps` repeats the command as invoked (a bare argv[0] for a
 *  PATH-launched agent, a path cut at its first space under `Claude Helper.app`), and a form whose patterns live in the path can never
 *  match such a word. The native helper's `:exe` is the path the kernel exec'd, resolved (so a symlink and a bare word both name the
 *  file); when it cannot read the process (another user's) the fallback is `ps -p <pid> -o comm=`, argv[0] whole. → the path, or null when
 *  neither answered (the process can be gone between the accept and this ask: that is not an error — the caller keeps ps's word, and a
 *  word that matches no pattern is the fail-safe answer, never a wrong one). */
export function realExeOf(pid, opts = {}) {
  return then(metaOf(pid, opts), (m) => (m.exe != null ? m.exe : psComm(pid, opts)))
}
function psComm(pid, { exec = null, env = process.env, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  // `comm` ALONE: any column after it cuts it to 16 characters (the file header); a path with spaces in it stays whole, as one line.
  return then(execTool('ps', ['-p', String(pid), '-o', 'comm='], { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs }), (r) => {
    const line = r.code === 0 ? String(r.out).split('\n')[0].trim() : ''
    return line !== '' ? line : null
  })
}

/** Is the process elevated? Root is uid 0 — the one question darwin's `ps` answers with its `uid` column. Never inferred; with no uid
 *  read the answer is null: not known. */
export function elevationOf(row) {
  if (row.uid != null) return { elevated: row.uid === 0, inferred: false }
  return { elevated: null, inferred: false }
}

/** factsOfPid(pid, { exec, env, psTimeoutMs }) → ProcFacts | null — the facts of ONE process, asked targeted (the two asks of the file
 *  header: the `ps` row, then the native helper for the real executable; ps's word stands when neither it nor the `comm` fallback has one
 *  — fail-safe, it matches no path pattern, never a wrong one). null = the pid is gone or `ps` failed (a dead process between the accept
 *  and the ask is the common case, not an error). The caller caches by pid + startedAt: a wrapped pid (another life, another start time)
 *  is asked again, a living one is asked once; the helper's answer is cached here too, so the cwd its reader asks for later is free. */
export function factsOfPid(pid, { exec = null, env = process.env, psTimeoutMs = PS_TIMEOUT_MS, procenvPath = nativePath(NATIVE.procenv), cache = procCache } = {}) {
  if (!Number.isInteger(pid)) throw new TypeError('factsOfPid needs the pid (an integer)')
  return then(execTool('ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,comm=,lstart=,args='], { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs }), (r) => {
    if (r.code !== 0) return null // a dead pid among them; the caller's null is the honest answer
    const line = String(r.out).split('\n').find((l) => l.trim() !== '')
    if (!line) return null
    const m = PS_ROW.exec(line)
    if (!m) return null // a localized lstart or a changed format: no facts, never a guess
    const cmdline = m[6].trim() !== '' ? m[6].trim() : null
    const words = psArgv(cmdline)
    const at = new Date(m[5].replace(/\s+/g, ' ')).getTime()
    const startedAt = Number.isFinite(at) ? at : null
    const row = { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), name: m[4] !== '' ? m[4] : null, exe: words.length > 0 ? words[0] : null, cmdline, startedAt, cmdlineState: cmdline != null ? 'ok' : 'empty' }
    return then(realExeOf(pid, { exec, env, psTimeoutMs, procenvPath, cache, startedAt }), (real) => {
      if (real != null) row.exe = real // the helper's `:exe` is THE executable; ps's word is the fallback
      const argv = psArgv(cmdline, real) // split on white space, except a line that starts with the real exe keeps it whole (src/off/proc.mjs psArgv)
      const { elevated, inferred } = elevationOf(row)
      const facts = {
        os: 'darwin', pid: row.pid, ppid: row.ppid, uid: Number.isInteger(row.uid) ? row.uid : null, name: row.name, exe: row.exe, argv, argvSplit: true, cmdline,
        env: null, envRead: false, cwd: null, startedAt, startTicks: startedAt != null ? String(startedAt) : null,
        sessionId: null, integrity: null, tokenDenied: false, elevated, elevationInferred: inferred, source: 'accept', cmdlineState: row.cmdlineState,
      }
      Object.defineProperty(facts, 'envError', { enumerable: false, value: 'env-unreadable' })
      return facts
    })
  })
}

// ---- the launch environment, cwd and parent of a pid (RFC 4.11 P7's proc readers; the upstream chain asks them) ----------------
// Cached by pid + start time for the life of the process: a busy agent costs one read, not one per connection. A caller that does
// not know the start time gets no caching (a pid alone can be reused). The cache is bounded; the oldest entry goes first.
const CACHE_MAX = 4096
const procCache = new Map()
function cached(cache, kind, pid, startedAt, read) {
  if (startedAt == null) return read()
  const key = `${kind}:${pid}:${startedAt}`
  if (cache.has(key)) return cache.get(key)
  return then(read(), (v) => {
    if (v != null) { // a failed read is asked again next time: the process may just have been racing its own exec
      cache.set(key, v)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    }
    return v
  })
}

/** envOf(pid, names, { startedAt, exec, procenvPath, cache }) → { <name>: value } for the `names` set in the process's LAUNCH
 *  environment (procenv: sysctl KERN_PROCARGS2, M2; same user only), or null when it cannot be read. Names compare exactly (macOS
 *  environment names are case-sensitive). Later setenv() calls in the process do not show: launch values only. Only the named
 *  variables are asked for, returned and cached (RFC 4.9 §5.2): the cache key carries the name set, the rest never enters memory. */
export function envOf(pid, names, { startedAt = null, exec = null, env = process.env, procenvPath = nativePath(NATIVE.procenv), cache = procCache, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  const want = [...new Set(names)].sort()
  if (!want.length) return {}
  return cached(cache, `env:${want.join('\0')}`, pid, startedAt, () => {
    return then(execTool(procenvPath, [String(pid), ...want], { run: exec, env, timeoutMs: psTimeoutMs, maxBuffer: 8 << 20 }), (r) => {
    if (r.code !== 0) return null
    const o = {}
    for (const entry of String(r.out).split('\0')) {
      const eq = entry.indexOf('=')
      const n = entry.slice(0, eq)
      if (eq > 0 && want.includes(n) && !Object.hasOwn(o, n)) o[n] = entry.slice(eq + 1) // the first wins, as getenv
    }
    return o
    })
  })
}

/** cwdOf(pid, { startedAt, exec }) → the process's current directory (the native helper's `:cwd`, from
 *  proc_pidinfo(PROC_PIDVNODEPATHINFO) — same user only, as the environment is), or null when it cannot be read. */
export function cwdOf(pid, opts = {}) {
  return then(metaOf(pid, opts), (m) => m.cwd)
}

/** metaOf(pid, { startedAt, exec, procenvPath, cache }) → { exe, cwd } — the two facts of a process that are no environment entry, from
 *  ONE read of the native helper (`:exe` / `:cwd`, native/procenv.c), each null when it did not answer it. Cached with the environment's
 *  reads (by pid + start time), so the door's exe ask and the project-settings cwd ask cost one helper run per process life. */
export function metaOf(pid, opts = {}) {
  return then(envOf(pid, META, opts), (o) => ({ exe: (o && o[':exe']) || null, cwd: (o && o[':cwd']) || null }))
}
const META = Object.freeze([':exe', ':cwd'])

/** parentOf(pid, { startedAt, exec }) → { ppid, startedAt } of the PARENT (its start time keys the next step up the chain), or
 *  null when either is gone. Two `ps` asks per process life: the pid's own row, then its parent's start time. */
export function parentOf(pid, { startedAt = null, exec = null, env = process.env, cache = procCache, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  const row = (p) => then(execTool('ps', ['-p', String(p), '-o', 'ppid=,lstart='], { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs }), (r) => {
    const m = r.code === 0 && /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(String(r.out).split('\n')[0] || '')
    const at = m ? new Date(m[2].replace(/\s+/g, ' ')).getTime() : NaN
    return m && Number.isFinite(at) ? { ppid: Number(m[1]), startedAt: at } : null
  })
  return cached(cache, 'parent', pid, startedAt, () => then(row(pid), (self) => {
    if (!self || self.ppid <= 0) return null
    return then(row(self.ppid), (up) => (up ? { ppid: self.ppid, startedAt: up.startedAt } : null))
  }))
}
