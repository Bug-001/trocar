// proc.mjs (src/off) — the process table `off` reads for itself, and the identity of one process (RFC 4.6 §安装清单与卸载「撤销顺序」第 2 / 5 步,
// §控制面 `lock`, 1.6 R3). `off` has to know which agents are alive after the daemon is stopped and the entries are undone, with no daemon to ask
// and no collector code (the standalone `asight-off` is made of src/off alone, 0.1 §2): Linux reads /proc, macOS runs two `ps` asks, Windows asks one fixed
// powershell question (4.8 §7) — both through execTool. The /proc readers moved here from src/collector/arch/linux/procinfo.mjs, which re-exports them; procIdentity /
// pidAlive from src/health/read.mjs, which re-exports procIdentity. A table that cannot be read throws: an empty one would read as "nobody is alive" (D38).
// Every reader takes an injectable `root` (default '/proc'), so a test points it at a synthetic tree. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { normalizeName } from './identity.mjs'
import { splitCommandLine } from './winargv.mjs'
import { daemonReader } from './daemon-read.mjs'

/** readlink /proc/<pid>/exe → absolute path, or null (onError(e) is told why). */
export function readExe(pid, { root = '/proc', onError = () => {} } = {}) {
  try { return nodeFs.readlinkSync(path.join(root, String(pid), 'exe')) } catch (e) { onError(e); return null }
}

/** /proc/<pid>/cmdline → argv (NUL-delimited, trailing NUL trimmed), or []. */
export function readArgv(pid, { root = '/proc' } = {}) {
  let buf
  try { buf = nodeFs.readFileSync(path.join(root, String(pid), 'cmdline'), 'utf8') } catch { return [] }
  if (!buf) return []
  const parts = buf.split('\0')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** /proc/<pid>/environ → Map<name,value> (NUL-delimited, split on first '='), or null when it cannot be read (onError(e)
 *  is told why): an unreadable environment is not an empty one (D-20). */
export function readEnviron(pid, { root = '/proc', onError = () => {} } = {}) {
  const m = new Map()
  let buf
  try { buf = nodeFs.readFileSync(path.join(root, String(pid), 'environ'), 'utf8') } catch (e) { onError(e); return null }
  for (const entry of buf.split('\0')) {
    if (!entry) continue
    const i = entry.indexOf('=')
    if (i < 0) m.set(entry, '')
    else m.set(entry.slice(0, i), entry.slice(i + 1))
  }
  return m
}

/** numeric entries under /proc → pid[] */
export function listPids({ root = '/proc' } = {}) {
  let names
  try { names = nodeFs.readdirSync(root) } catch { return [] }
  const pids = []
  for (const n of names) if (/^\d+$/.test(n)) pids.push(Number(n))
  return pids
}

/** /proc/<pid>/status → { ppid, uid (real), name (comm) }, or null. */
export function readStatus(pid, { root = '/proc' } = {}) {
  let text
  try { text = nodeFs.readFileSync(path.join(root, String(pid), 'status'), 'utf8') } catch { return null }
  const ppid = /^PPid:\s*(\d+)/m.exec(text)
  const uid = /^Uid:\s*(\d+)/m.exec(text)
  const name = /^Name:\s*(.*)$/m.exec(text)
  return { ppid: ppid ? Number(ppid[1]) : null, uid: uid ? Number(uid[1]) : null, name: name ? name[1] : null }
}

/** Process start as ms since the epoch: /proc/<pid>/stat field 22 (clock ticks since boot), placed on the wall
 *  clock through /proc/uptime read now (centiseconds, the same clock as file mtimes). /proc/stat btime is whole
 *  seconds and drifts from the wall clock in a VM: on a Linux test machine it put a `claude` started 0.4 s after
 *  `asight collector install` BEFORE the settings write, so a trusted process looked "config-after-start" (Plan 3a,
 *  ). btime remains the fallback when /proc/uptime is unreadable. */
export function readStartTime(pid, { root = '/proc', hz = 100, now = Date.now } = {}) {
  let stat
  try { stat = nodeFs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8') } catch { return null }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/) // field 3 onward; comm may hold ')' or spaces
  const ticks = Number(fields[19])
  if (!Number.isFinite(ticks)) return null
  try {
    const up = Number(nodeFs.readFileSync(path.join(root, 'uptime'), 'utf8').split(/\s+/)[0])
    if (Number.isFinite(up)) return now() - (up - ticks / hz) * 1000
  } catch { /* no /proc/uptime: fall back to btime */ }
  let sys
  try { sys = nodeFs.readFileSync(path.join(root, 'stat'), 'utf8') } catch { return null }
  const btime = /^btime\s+(\d+)/m.exec(sys)
  return btime ? (Number(btime[1]) + ticks / hz) * 1000 : null
}

/** {start_time, boot_id} of a live process (strings), each null when it cannot be read (no /proc, gone, EACCES). On win32 the answer comes
 *  from `winIdentity` (pid + creation time + the machine's boot time, RFC 4.8 §7): the daemon's own lock identity is this function's default,
 *  so the win32 arm here is what puts the Windows identity into the daemon's lock without a daemon.mjs change — an unverified lock (the
 *  /proc shape, nulls) reads a reused pid as "running" and then "starting", which `off` would wait on or mis-stop. */
export function procIdentity(pid, { root = '/proc', fs = nodeFs, platform = null, run = null, env = process.env } = {}) {
  if ((platform || process.platform) === 'win32') return winIdentity(pid, { run, env })
  let start_time = null, boot_id = null
  try {
    const stat = fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/) // field 3 onward: comm may hold ')' or spaces
    if (/^\d+$/.test(f[19] || '')) start_time = f[19]
  } catch { /* gone or no /proc: start_time stays null, and the judge says so */ }
  try { boot_id = fs.readFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim() || null } catch { /* no /proc */ }
  return { start_time, boot_id }
}

// The one fixed question of a process's identity on Windows (4.8 §7): its creation time and the machine's boot time, both as Unix
// milliseconds — boot_id is the system start time, start_time the process's own, so a reused pid and a reboot are told apart exactly
// as /proc's pair is. One Get-CimInstance for the pid and one for the OS per call; the calls are rare (a daemon start, an off's checks).
let winBoot = null // the boot time the last Windows table ask printed (`identityOfRow` reads it off the memo's table)
/** The boot-time line off the head of a Windows table answer → `{ boot, json }`; an answer without one keeps `boot` null, and then no
 *  identity is answered from the table. */
function splitWinTable(out) {
  const m = /^boot (\d+)\s*(?:\r?\n|$)/.exec(out)
  return m ? { boot: m[1], json: out.slice(m[0].length).trim() } : { boot: null, json: out }
}

const WIN_IDENTITY_SCRIPT = (pid) => `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if (-not $p) { 'gone' } else { $o = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ s = [DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); b = [DateTimeOffset]::new($o.LastBootUpTime.ToUniversalTime()).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`
/** {start_time, boot_id} of one live process on Windows (strings of Unix ms), each null when it cannot be read — the same contract as the
 *  /proc reader: never a throw, never a guess (a dead powershell, or an answer that is neither 'gone' nor the JSON object, is "not known").
 *  `run` is the injected runner (execTool's). Inside a memo scope (memoProcQuestions) the answer comes from the process table this command
 *  already read, when it has one: that table's one question carries the same two numbers from the same CIM expressions (D62 task E — on the
 *  a Windows test machine each PowerShell start costs ~450 ms, and `status` asked this question twice). */
export function winIdentity(pid, { run = null, env = process.env } = {}) {
  const m = memo
  if (!m) return winIdentityAsk(pid, { run, env })
  const key = `w:${pid}`
  if (m.identity.has(key)) return m.identity.get(key)
  const fromTable = m.table && m.table.value && m.table.value.boot != null ? identityOfRow(m.table.value, pid) : null
  const v = fromTable || winIdentityAsk(pid, { run, env })
  m.identity.set(key, v)
  return v
}
/** The pid's row of a table already read (`{ rows, boot }`) as the identity: a pid the table does not list is gone, which is the two nulls
 *  `winIdentity` answers for it. A row without a creation time is not an answer — the direct question is asked for that one. */
function identityOfRow({ rows, boot }, pid) {
  const row = rows.find((p) => p.pid === pid)
  if (!row) return { start_time: null, boot_id: null }
  return row.startedAt == null ? null : { start_time: String(row.startedAt), boot_id: String(boot) }
}
function winIdentityAsk(pid, { run = null, env = process.env } = {}) {
  return then(execTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_IDENTITY_SCRIPT(pid)], { run, env }), (r) => {
    if (r.code !== 0 || r.out === 'gone') return { start_time: null, boot_id: null }
    try { const o = JSON.parse(r.out); return { start_time: Number.isFinite(o.s) ? String(o.s) : null, boot_id: Number.isFinite(o.b) ? String(o.b) : null } } catch { return { start_time: null, boot_id: null } }
  })
}
/** f(r) now, or once r resolves: the identity readers answer in the runner's own time — at once with spawnSync, as a promise with an async
 *  runner (runAsync), which the daemon passes so a PowerShell does not stop its event loop on its way to answering `on` (a Windows test machine 2026-10-17). */
const then = (r, f) => (r && typeof r.then === 'function' ? r.then(f) : f(r))

// What one question about the whole process table may print (spawnSync's own default is 1 MiB): the command lines of a working Mac's ~430 processes
// are a few hundred kilobytes, and a cut answer reads as a table whose newest processes — the highest pids, the ones started after `on` — are missing.
// An answer longer than this is not read at all (code null), never read in part.
const TABLE_MAX_BUFFER = 64 * 1024 * 1024

// `ps` prints dates in the user's language: under LC_ALL=zh_CN.UTF-8 or ja_JP.UTF-8 the five words of `lstart` are no longer "Wed Oct  7 04:27:00 2026" and every row
// failed to parse — no error, just an empty table, which `off` read as "nobody is alive" (audit rule-b 2). The C locale gives the same words on every machine.
const psEnv = (env = process.env) => ({ ...env, LC_ALL: 'C' })

/** {start_time, boot_id} of a live process where there is no /proc (macOS): `ps -o lstart= -p <pid>` in the C locale, the blanks collapsed ("Wed Oct 7 04:27:00 2026"),
 *  and the seconds of `sysctl -n kern.boottime` as the boot id (lstart has a one-second grain, the boot time tells a reboot apart); both null when `ps`
 *  does not know the pid, boot_id null when sysctl does not answer. `exec` is the injected runner (execTool). */
export function psIdentity(pid, { exec = null, env = process.env } = {}) {
  const m = memo, key = `p:${pid}`
  if (m && m.identity.has(key)) return m.identity.get(key)
  const v = psIdentityAsk(pid, { exec, env })
  if (m) m.identity.set(key, v)
  return v
}
function psIdentityAsk(pid, { exec = null, env = process.env } = {}) {
  return then(execTool('ps', ['-o', 'lstart=', '-p', String(pid)], { run: exec, env: psEnv(env) }), (r) => {
    if (!(r.code === 0 && /\S/.test(r.out))) return { start_time: null, boot_id: null }
    return then(execTool('sysctl', ['-n', 'kern.boottime'], { run: exec, env: psEnv(env) }), (b) => {
      const sec = b.code === 0 && /\bsec\s*=\s*(\d+)/.exec(b.out)
      return { start_time: r.out.replace(/\s+/g, ' ').trim(), boot_id: sec ? sec[1] : null }
    })
  })
}

/** The reader of a process's identity for a platform: /proc on Linux, `ps` on macOS, one Get-CimInstance question on Windows. Without one a
 *  lock can only say "its pid is alive", and a pid that another process has taken since (a crash, a reboot) then reads as a command still
 *  running — which blocked `asight off`, the way out, for as long as that other process lived (audit rule-b 3). */
export function identityFor({ platform = process.platform, exec = null, env = process.env, root = '/proc', fs = nodeFs } = {}) {
  if (platform === 'win32') return (pid) => winIdentity(pid, { run: exec, env })
  return platform === 'darwin' ? (pid) => psIdentity(pid, { exec, env }) : (pid) => procIdentity(pid, { root, fs, platform })
}

/** Is the pid a process (signal 0): EPERM is a process of another user. */
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function procsOfLinux({ uid, root }) {
  let names
  try { names = nodeFs.readdirSync(root) } catch (e) { throw new Error(`the process table ${root} cannot be read (${e.code || e.message}), so which agents are alive is not known`) }
  const out = []
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const pid = Number(n)
    const st = readStatus(pid, { root })
    if (!st || (uid != null && st.uid !== uid)) continue // gone since the listing, or another user's
    let env
    out.push({ pid, ppid: st.ppid, uid: st.uid, startedAt: readStartTime(pid, { root }), exe: readExe(pid, { root }), argv: readArgv(pid, { root }), env: () => (env !== undefined ? env : (env = readEnviron(pid, { root }))) })
  }
  return out
}

// `ps -Axo pid=,ppid=,uid=,lstart=,command=`: lstart is five words ("Wed Oct  7 04:27:00 2026", local time), the command line joined by spaces — its
// argument boundaries are lost, so argv is that line split on whitespace (a path with a space in it splits; `cmdline` keeps the line as it came), and the
// environment of another process cannot be read on macOS at all (`env` null, `envRead: false`: the OS's rule, not a failed read — 4.6 「判活快照」).
// Run in the C locale (psEnv). A table with lines in it of which not one parses is an error, not an empty table: it would read as "nobody is alive" (D38;
// the same failure as a localized `ps`, whatever else changes the format).
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S.*)$/
// The executable of each process is not in that line: `ps` repeats the command as invoked — a bare word for an agent started through PATH, a path cut at its
// first space under `ZCode Helper.app` — and the descriptors' process names (D51, the `processes` of src/collector/harness/<name>.mjs) are measured against the whole
// one, which is `comm` asked as the LAST (here: the only) column: it is then neither cut to 16 characters nor at a space (measured on a macOS machine,
// 2026-10-18, on a VPN client's system-extension path whose vendor name is not reproduced here; `ps -Axo pid=,comm=` prints
// `/Library/<Vendor>/<Vendor> System Extension.app/Contents/MacOS/<Vendor>Extension` whole). It is argv[0] as the
// process was started — a bare word stays a bare word, where the `lsof -d txt` ask this replaced resolved the file — so the name list reads the same name
// and no path is invented; the collector's targeted ask, which has one process to spend a read on, resolves it with the native helper
// (arch/darwin/procinfo.mjs realExeOf). One `ps -Axo pid=,comm=` answers the whole machine in ~32 ms, where lsof's whole-user txt ask cost 310 ms (measured,
// same Mac) — no lsof is run on macOS any more. It runs AFTER the first `ps`, so a pid it does not name is a process that ended between the two (its
// command line's first word is kept). A `ps` that did not finish (code null: killed by its timeout, more output than TABLE_MAX_BUFFER, or never started —
// what it printed is cut short) or that names no process while the first listed some cannot be read: the table is not known (4.6 「判活快照」).
/** psArgv(cmdline, exe) — the argv of a `ps` command line (darwin): the line split on white space, the argument boundaries being lost — except argv[0],
 *  which the executable (`comm`'s, or the collector's resolved one — `exe`) lets us keep whole: a line that begins with that path, or whose first words (as many as the exe's file name
 *  names) name the same program (src/off/identity.mjs normalizeName: a symlink of that name, the version-named file's directory). So a bundle path with spaces (`…/Claude Helper (Renderer)`) is never cut
 *  into a fragment that names another program. The facts it goes into carry `argvSplit: true` (src/off/identity.mjs entryOf reads it). */
export function psArgv(cmdline, exe = null) {
  const line = typeof cmdline === 'string' ? cmdline.trim() : ''
  if (line === '') return []
  const words = line.split(/\s+/)
  if (typeof exe !== 'string' || exe === '') return words
  if (line === exe || line.startsWith(`${exe} `)) {
    const rest = line.slice(exe.length).trim()
    return [exe, ...(rest === '' ? [] : rest.split(/\s+/))]
  }
  const name = normalizeName(exe)
  const k = name ? name.split(/\s+/).length : 1
  const head = words.slice(0, k).join(' ')
  return k > 1 && normalizeName(head) === name ? [head, ...words.slice(k)] : words
}

function exesOfPs({ exec, env, rows }) {
  const r = execTool('ps', ['-Axo', 'pid=,comm='], { run: exec, env: psEnv(env), maxBuffer: TABLE_MAX_BUFFER })
  const how = r.code === null ? `did not finish (${r.err || 'no reason given'})` : `failed (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''})`
  if (r.code !== 0) throw new Error(`the executables ask \`ps -Axo pid=,comm=\` ${how}, so the executables of the ${rows} process(es) the table listed are not known, nor which agents are alive`)
  const exes = new Map()
  for (const line of String(r.out || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line) // the pid, then `comm` to the end of the line: a path with spaces in it is one word here
    if (m) exes.set(Number(m[1]), m[2].trimEnd())
  }
  if (exes.size === 0 && rows > 0) throw new Error(`\`ps -Axo pid=,comm=\` named no process (exit ${r.code}), so the executables of the ${rows} process(es) the table listed are not known, nor which agents are alive`)
  return exes
}
function procsOfPs({ uid, exec, env }) {
  const r = execTool('ps', ['-Axo', 'pid=,ppid=,uid=,lstart=,command='], { run: exec, env: psEnv(env), maxBuffer: TABLE_MAX_BUFFER })
  if (r.code !== 0) throw new Error(`ps failed (${r.code === null ? r.err : `exit ${r.code}: ${r.err}`}), so which agents are alive is not known`)
  const out = []
  let rows = 0, parsed = 0
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue
    rows++
    const m = PS_ROW.exec(line)
    if (!m) continue
    parsed++
    if (uid != null && Number(m[3]) !== uid) continue
    const cmdline = m[5].trim()
    const argv = psArgv(cmdline)
    const at = new Date(m[4].replace(/\s+/g, ' ')).getTime()
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), startedAt: Number.isFinite(at) ? at : null, exe: argv[0], argv, argvSplit: true, cmdline, env: () => null, envRead: false })
  }
  if (rows > 0 && parsed === 0) throw new Error(`ps printed ${rows} line(s) and none could be read (the first: ${JSON.stringify(r.out.split('\n').find((l) => l.trim()).slice(0, 80))}), so which agents are alive is not known`)
  if (!out.length) return out // nobody of this user: nothing to name
  const exes = exesOfPs({ exec, env, rows: out.length })
  for (const p of out) if (exes.get(p.pid)) { p.exe = exes.get(p.pid); p.argv = psArgv(p.cmdline, p.exe) }
  return out
}

/** The live processes of one user: `[{ pid, ppid, uid, startedAt: ms | null, exe, argv, env: () => Map | null }]` — `env` is read when asked for; macOS and
 *  Windows rows add `cmdline` (the command line as it came, or null) and `envRead: false` (no other process's environment is readable there: `env` is null by the
 *  OS's rule, not because a read failed). `uid` null lists everyone's. Linux reads `root` (/proc); macOS runs two `ps` asks (the table, then the executables),
 *  Windows one
 *  fixed Get-CimInstance question, all through `exec`
 *  (a spawnSync-like runner a test injects; execTool refuses a real one under npm test). Another platform, or a table that cannot be read, rejects. */
export async function listProcs(opts = {}) {
  const m = memo, key = `${opts.platform || process.platform}|${'uid' in opts ? opts.uid : 'self'}|${opts.root || '/proc'}`
  if (m && m.tables.has(key)) return m.tables.get(key)
  const p = tableOf(opts)
  if (m) {
    m.tables.set(key, p)
    if (!m.table) { const t = m.table = {}; p.then((rows) => { t.value = { rows, boot: winBoot } }, () => { /* a table that could not be read answers nothing */ }) }
  }
  return p
}
async function tableOf({ uid = typeof process.getuid === 'function' ? process.getuid() : null, root = '/proc', platform = process.platform, exec = null, env = process.env } = {}) {
  if (platform === 'linux') return procsOfLinux({ uid, root })
  if (platform === 'darwin') return procsOfPs({ uid, exec, env })
  if (platform === 'win32') return procsOfWin({ exec, env })
  throw new Error(`there is no process-table reader for ${platform}, so which agents are alive is not known`)
}

// ── one question, one answer, for the life of one read-only command (D62 task E, 1.6 §3.1) ────────────────────────────────────────────
// `status` and `doctor` ask the same two questions of the OS more than once: the whole process table, and the identity of the daemon's pid
// (the lock's judgement, then capture health). Each is one PowerShell start on Windows (~450 ms measured on a Windows test machine 2026-10-19), and
// the answers are a snapshot either way: a read-only command reports one moment. Inside a scope each is asked once, and on Windows the
// identity comes out of the table's own answer. It is OPT-IN — `off` watches processes exit while it works and MUST see every ask fresh —
// and re-entrant (doctor's scope holds status's).
//
// A scope opened with `reader` (src/off/daemon-read.mjs, the CLI's question to the daemon's warm helper) asks the DAEMON for the Windows process
// table first: the daemon keeps one resident read-only PowerShell, so that answer starts no process at all, and its envelope carries the daemon's
// own identity — which is what `status` needed the second question for (4.8 §7). A daemon that does not answer leaves the local PowerShell
// question, and the reason is kept in `procAskNotes()` for the caller to report (D38, never silent). `off` opens its scope without a reader: it is
// about to stop that daemon.
let memo = null, memoDepth = 0
/** Opens a memo scope; call what it returns to close it (try/finally). `reader`: the daemon read client, or null for the OS alone. */
export function memoProcQuestions({ reader = null } = {}) {
  if (memoDepth++ === 0) memo = { tables: new Map(), identity: new Map(), table: null, reader, notes: [] }
  return () => { if (--memoDepth <= 0) { memoDepth = 0; memo = null } }
}
/** The read questions this scope could not put to the daemon and had to put to the OS, each with its reason (`status` reports them). */
export const procAskNotes = () => (memo ? [...memo.notes] : [])
/** The daemon read client a read-only command's scope uses on Windows: null on another platform, or when no endpoint is known. */
export const daemonProcReader = (o = {}) => ((o.platform || process.platform) === 'win32' ? daemonReader(o) : null)

// The one fixed question of the whole process table on Windows (4.8 §7): one Get-CimInstance over Win32_Process, every field this file's
// row shape wants, as JSON — one question for the whole machine, not one per process. Windows has no uid (null: the row says whose it is
// not), argv is the command line split by the one CommandLineToArgvW splitter the collector uses too (./winargv.mjs: a quoted exe path with a space stays
// one word, so the name list reads the same argv here as in the daemon, 4.6 §识别进程 / 4.8 W76; no command line is no argv, as there; `cmdline` is the
// line as it came), and another process's environment cannot be read at all (`env` null,
// `envRead: false`: the OS's rule, 4.8 §10.1). A question that died, or an answer that is not JSON, is an error, never
// an empty table: an empty one would say "nobody holds the bundle" and delete it (D38, the rule of the other two readers).
// Its first line is the machine's boot time (the identity question's own `b`, from the same expression), so one table answers `winIdentity` too.
/** One process of a Windows answer as a row of this file's table: the helper's `ps` row (4.8 §1) and the one Get-CimInstance question below carry the
 *  same facts under different names. `argv` is the command line split by the one CommandLineToArgvW splitter the collector uses too (./winargv.mjs),
 *  `uid` is null (Windows has none) and another process's environment cannot be read at all (4.8 §10.1). */
const winRow = ({ pid, ppid, name, exe, startedAt, cmdline, cmdlineState }) => ({
  pid: Number(pid), ppid: Number.isFinite(ppid) ? Number(ppid) : null, uid: null, startedAt: Number.isFinite(startedAt) ? Number(startedAt) : null,
  exe: typeof exe === 'string' && exe !== '' ? exe : (typeof name === 'string' && name !== '' ? name : null),
  argv: splitCommandLine(typeof cmdline === 'string' && cmdline !== '' ? cmdline : null), cmdline: typeof cmdline === 'string' && cmdline !== '' ? cmdline : null,
  ...(cmdlineState ? { cmdlineState } : {}), env: () => null, envRead: false,
})

/** The helper's `ps` rows (4.8 §1: `{procs:[{pid, ppid, name, exe, cmdline, startedAt, …}]}`) as this file's table, or null when that is no answer
 *  (D38: an answer that is not a list of rows is "not known", never an empty table). One mapper for both sides of the seam — the daemon's own
 *  holder poll reads its helper through it too (arch/model-backends.mjs `procTable`). */
export function tableFromPsRows(procs) {
  if (!Array.isArray(procs)) return null
  return procs.filter((r) => r && typeof r === 'object' && Number.isFinite(r.pid)).map(winRow)
}

const WIN_TABLE_SCRIPT = '$o = Get-CimInstance Win32_OperatingSystem; \'boot \' + [DateTimeOffset]::new($o.LastBootUpTime.ToUniversalTime()).ToUnixTimeMilliseconds(); Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; x = $_.ExecutablePath; s = $(try { [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { $null }); c = $_.CommandLine } } | ConvertTo-Json -Compress'
/** The Windows table: the daemon's warm helper when this scope has a reader and it answers, else the one fixed PowerShell question. */
async function procsOfWin({ exec, env }) {
  const m = memo
  if (m && m.reader) {
    try {
      const data = await m.reader.call('ps', { all: true }, { timeoutMs: WIN_PS_ASK_MS })
      const rows = tableFromPsRows(data && data.procs)
      if (rows) {
        // the daemon's own identity, as it wrote it into its lock: it answered on the token-checked control channel, which is what proves
        // which process the lock names (4.8 §7), so no OS question is put about that pid
        const s = m.reader.self()
        if (s && s.boot_id != null) m.identity.set(`w:${s.pid}`, { start_time: s.start_time == null ? null : String(s.start_time), boot_id: String(s.boot_id) })
        return rows
      }
      m.notes.push('the daemon answered the process snapshot with no rows')
    } catch (e) { m.notes.push(String((e && e.message) || e)) }
  }
  return procsOfWinLocal({ exec, env })
}
/** How long the daemon's `ps` answer is waited for: the helper may have to read command lines through CIM (4.8 §1 gives that verb 10 s), but the
 *  fallback here is one PowerShell start (~450 ms measured), so this question is given a little more than that and no more. */
const WIN_PS_ASK_MS = 2000
function procsOfWinLocal({ exec, env }) {
  const r = execTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_TABLE_SCRIPT], { run: exec, env, maxBuffer: TABLE_MAX_BUFFER })
  const what = `the Windows process table (one Get-CimInstance question) ${r.code === null ? `did not run (${r.err || 'no reason given'})` : `failed (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''})`}, so which agents are alive is not known`
  if (r.code !== 0) throw new Error(what)
  const { boot, json } = splitWinTable(r.out)
  winBoot = boot
  if (json === '') return [] // a table that printed nothing is an empty table (the same reading as `ps` printing nothing)
  let rows
  try { rows = JSON.parse(json) } catch { throw new Error(what.replace('did not run', 'answered something that is not JSON')) }
  const out = []
  for (const row of Array.isArray(rows) ? rows : [rows]) { // one process on the machine: PowerShell's JSON is an object, not a list
    if (row === null || typeof row !== 'object' || !Number.isFinite(row.p)) continue
    out.push(winRow({ pid: row.p, ppid: row.pp, name: row.n, exe: row.x, startedAt: row.s, cmdline: row.c }))
  }
  return out
}
