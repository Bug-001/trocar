// procinfo.mjs — the per-pid process facts of the macOS collector, asked TARGETED at accept time (RFC 4.9 §5.3, D47).
//
// The ps-scan watcher is gone (D47 deleted it with its whole machinery: the 2 s poll, the exec/exit-by-difference, the demand poll, the
// unreadable table). What identity needs now is ONE process — the one that owns the socket the engine just accepted — and the one command
// that answers it is `ps -p <pid> -o pid=,ppid=,uid=,comm=,lstart=,args=`: three integers, the accounting name, the five words of lstart
// and the whole command line, exactly the row shape the old table read (the parsing constants are the same, so a format change is still
// one parser's to notice). The EXE cannot come from that row: `ps` repeats the command as invoked — a bare argv[0] for a PATH-launched
// agent, a path CUT at its first space for a binary under `Claude Helper.app` (measured on a macOS machine, 2026-10-12) — so the executable
// is `lsof -p <pid> -Fn`'s first txt record, the one source that answers it (~15 ms, measured). Two asks per process LIFE (the caller
// caches by pid + startedAt), never a sweep of the machine.
//
// ProcFacts = the Linux contract (core/redirector.mjs) as far as the two answers have the fields: { os:'darwin', pid, ppid, name, exe,
// argv, cmdline, env:null (envError 'env-unreadable': another process's environment is never read on macOS — no privilege to, and `ps`
// has no such column) with envRead:false — the OS's rule, not a failure, so the tracker judges by the entry files (4.8 §5.4) —, cwd:null,
// startedAt (ms since the epoch, or null), startTicks (startedAt as a string), sessionId (null), integrity (null), tokenDenied (false),
// elevated (uid===0), elevationInferred (false), cmdlineState, source:'accept' }. `name` is `comm`, at most 16 characters (MAXCOMLEN);
// `cmdline` is the raw command line and `argv` is it split on white space — `ps` joins the arguments with spaces, so the argument
// boundaries are lost (the same documented loss as src/off/proc.mjs's table, same command family). `cmdline` may hold secrets: callers
// keep it in memory and never write it to a record.
//
// The commands and the shape of their answers (measured on the darwin kernels this collector runs on, macOS 26.6.2 arm64; ps from the C
// locale, set below, is what keeps the words English):
//   ps -p <pid> -o pid=,ppid=,uid=,comm=,lstart=,args=
//     42177     1   501 /opt/homebrew/Ce Tue Oct  6 17:58:06 2026     /opt/homebrew/Cellar/python@3.14/.../Python -I ...
//   lsof -p <pid> -Fn        → `p<pid>` `c<command>` `f<fd>` `n<name>` records; the first `ftxt`'s `n` that is a path is the executable.
// `lstart` is five words in exactly this format: "Mon Oct  8 17:00:00 2026" — weekday and month as three letters, the day one or two
// digits (a one-digit day is preceded by TWO spaces), the time hh:mm:ss, a four-digit year; local time, to the second. The `=` on every
// column name asks `ps` for no header line; the command column is LAST so this kernel's `ps` does not cap the line at 128 columns and cut
// the command line mid-word (measured). Everything that touches the machine is injected: `exec` (the runner, spawnSync-shaped —
// execTool's `run`; a test injects one and nothing real runs), `env` (LC_ALL=C is added here: `ps` prints dates in the user's language,
// and under LC_ALL=zh_CN.UTF-8 the five words of lstart are no longer "Mon Oct  8 17:00:00 2026").
import { execTool } from '../../../off/exec.mjs'

/** How long one targeted ask waits: a single-pid read is a small question on any machine — a `ps`/`lsof` that exceeds it is killed by
 *  execTool's timeout and the answer is null (fail-safe: no facts, no form, the connection is spliced untracked), never a guess. */
export const PS_TIMEOUT_MS = 2000

/** A ps row: three integers, the accounting name (any characters — it is bounded by lstart's fixed shape to its right), the five words of
 *  lstart, and the command line to the end of the line. The same shape the old table read. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/
// `ps` prints dates in the user's language: the C locale gives the same five words on every machine (see the file header).
const psEnv = (env) => ({ ...env, LC_ALL: 'C' })

/** The command line split into arguments the way `ps` left it: on white space (the argument boundaries were lost when `ps` joined them;
 *  a path with a space in it splits — the documented loss of this data source). Nothing (null, empty) is no arguments. */
const argvOf = (cmdline) => (typeof cmdline === 'string' && cmdline.trim() !== '' ? cmdline.trim().split(/\s+/) : [])

/** The first `ftxt` record's name of `lsof -p <pid> -Fn` — the REAL executable of the process, the one source that answers it: `ps`
 *  repeats the command as invoked (a bare argv[0] for a PATH-launched agent, a path cut at its first space under `Claude Helper.app`),
 *  and a form whose patterns live in the path can never match such a word. → the path, or null when lsof failed, was killed at its
 *  timeout, or answered no txt record that is a path (the process can be gone between the accept and this ask: that is not an error —
 *  the caller keeps ps's word, and a word that matches no pattern is the fail-safe answer, never a wrong one). */
export function realExeOf(pid, { exec = null, env = process.env, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  const r = execTool('lsof', ['-p', String(pid), '-Fn'], { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs })
  if (r.code !== 0) return null
  let wantName = false
  for (const line of String(r.out).split('\n')) {
    if (line === 'ftxt') { wantName = true; continue }
    if (wantName && line.startsWith('n')) {
      const p = line.slice(1)
      if (p.startsWith('/')) return p
      wantName = false // a txt name that is no path (a deleted file, a device): keep looking
    }
  }
  return null
}

/** Is the process elevated? Root is uid 0 — the one question darwin's `ps` answers with its `uid` column. Never inferred; with no uid
 *  read the answer is null: not known. */
export function elevationOf(row) {
  if (row.uid != null) return { elevated: row.uid === 0, inferred: false }
  return { elevated: null, inferred: false }
}

/** factsOfPid(pid, { exec, env, psTimeoutMs }) → ProcFacts | null — the facts of ONE process, asked targeted (the two asks of the file
 *  header: the `ps` row, then the `lsof` txt record for the real executable; ps's word stands when lsof has none — fail-safe, it matches
 *  no path pattern, never a wrong one). null = the pid is gone or `ps` failed (a dead process between the accept and the ask is the
 *  common case, not an error). The caller caches by pid + startedAt: a wrapped pid (another life, another start time) is asked again,
 *  a living one is asked once. */
export function factsOfPid(pid, { exec = null, env = process.env, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pid)) throw new TypeError('factsOfPid needs the pid (an integer)')
  const r = execTool('ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,comm=,lstart=,args='], { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs })
  if (r.code !== 0) return null // a dead pid among them; the caller's null is the honest answer
  const line = String(r.out).split('\n').find((l) => l.trim() !== '')
  if (!line) return null
  const m = PS_ROW.exec(line)
  if (!m) return null // a localized lstart or a changed format: no facts, never a guess
  const cmdline = m[6].trim() !== '' ? m[6].trim() : null
  const argv = argvOf(cmdline)
  const at = new Date(m[5].replace(/\s+/g, ' ')).getTime()
  const startedAt = Number.isFinite(at) ? at : null
  const row = { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), name: m[4] !== '' ? m[4] : null, exe: argv.length > 0 ? argv[0] : null, cmdline, startedAt, cmdlineState: cmdline != null ? 'ok' : 'empty' }
  const real = realExeOf(pid, { exec, env, psTimeoutMs })
  if (real != null) row.exe = real // lsof's txt record is THE executable; ps's word is the fallback
  const { elevated, inferred } = elevationOf(row)
  const facts = {
    os: 'darwin', pid: row.pid, ppid: row.ppid, uid: Number.isInteger(row.uid) ? row.uid : null, name: row.name, exe: row.exe, argv, cmdline,
    env: null, envRead: false, cwd: null, startedAt, startTicks: startedAt != null ? String(startedAt) : null,
    sessionId: null, integrity: null, tokenDenied: false, elevated, elevationInferred: inferred, source: 'accept', cmdlineState: row.cmdlineState,
  }
  Object.defineProperty(facts, 'envError', { enumerable: false, value: 'env-unreadable' })
  return facts
}
