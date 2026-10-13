// proc.mjs (src/off) — the process table `off` reads for itself, and the identity of one process (RFC 4.6 §安装清单与卸载「撤销顺序」第 2 / 5 步,
// §控制面 `lock`, 1.6 R3). `off` has to know which agents are alive after the daemon is stopped and the entries are undone, with no daemon to ask
// and no collector code (the standalone `asight-off` is made of src/off alone, 0.1 §2): Linux reads /proc, macOS runs `ps`, Windows asks one fixed
// powershell question (4.8 §7) — both through execTool. The /proc readers moved here from src/collector/arch/linux/procinfo.mjs, which re-exports them; procIdentity /
// pidAlive from src/health/read.mjs, which re-exports procIdentity. A table that cannot be read throws: an empty one would read as "nobody is alive" (D38).
// Every reader takes an injectable `root` (default '/proc'), so a test points it at a synthetic tree. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { normalizeName } from './identity.mjs'

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
const WIN_IDENTITY_SCRIPT = (pid) => `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if (-not $p) { 'gone' } else { $o = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ s = [DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); b = [DateTimeOffset]::new($o.LastBootUpTime.ToUniversalTime()).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`
/** {start_time, boot_id} of one live process on Windows (strings of Unix ms), each null when it cannot be read — the same contract as the
 *  /proc reader: never a throw, never a guess (a dead powershell, or an answer that is neither 'gone' nor the JSON object, is "not known").
 *  `run` is the injected runner (execTool's). */
export function winIdentity(pid, { run = null, env = process.env } = {}) {
  const r = execTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_IDENTITY_SCRIPT(pid)], { run, env })
  if (r.code !== 0 || r.out === 'gone') return { start_time: null, boot_id: null }
  try { const o = JSON.parse(r.out); return { start_time: Number.isFinite(o.s) ? String(o.s) : null, boot_id: Number.isFinite(o.b) ? String(o.b) : null } } catch { return { start_time: null, boot_id: null } }
}

// What one question about the whole process table may print (spawnSync's own default is 1 MiB): `lsof`'s txt records of one user's processes on a
// working Mac are 1.6 MB (every mapped library is a txt record), and a cut answer reads as a table whose newest processes — the highest pids, the
// ones started after `on` — have no executable. An answer longer than this is not read at all (code null), never read in part.
const TABLE_MAX_BUFFER = 64 * 1024 * 1024

// `ps` prints dates in the user's language: under LC_ALL=zh_CN.UTF-8 or ja_JP.UTF-8 the five words of `lstart` are no longer "Wed Oct  7 04:27:00 2026" and every row
// failed to parse — no error, just an empty table, which `off` read as "nobody is alive" (audit rule-b 2). The C locale gives the same words on every machine.
const psEnv = (env = process.env) => ({ ...env, LC_ALL: 'C' })
/** The environment `lsof` runs in, here and in the collector's targeted ask (arch/darwin/procinfo.mjs realExeOf): under the C locale lsof prints every
 *  byte outside ASCII as `\xNN`, so a path under `测 试/` came back as `\xe6\xb5\x8b \xe8\xaf\x95/` — not the file (measured on macOS with the real
 *  lsof 4.91, 2026-10-14; guard test/collector/arch/darwin/identity-real.test.mjs). `UTF-8` is the ctype-only locale: the names print as they are, every
 *  other category stays C. */
export const lsofEnv = (env = process.env) => ({ ...env, LC_ALL: 'UTF-8' })

/** {start_time, boot_id} of a live process where there is no /proc (macOS): `ps -o lstart= -p <pid>` in the C locale, the blanks collapsed ("Wed Oct 7 04:27:00 2026");
 *  null when `ps` does not know the pid. No boot id: the start time of a pid that is reused after a reboot differs all the same. `exec` is the injected runner (execTool). */
export function psIdentity(pid, { exec = null, env = process.env } = {}) {
  const r = execTool('ps', ['-o', 'lstart=', '-p', String(pid)], { run: exec, env: psEnv(env) })
  return { start_time: r.code === 0 && /\S/.test(r.out) ? r.out.replace(/\s+/g, ' ').trim() : null, boot_id: null }
}

/** The reader of a process's identity for a platform: /proc on Linux, `ps` on macOS, one Get-CimInstance question on Windows. Without one a
 *  lock can only say "its pid is alive", and a pid that another process has taken since (a crash, a reboot) then reads as a command still
 *  running — which blocked `asight off`, the way out, for as long as that other process lived (audit rule-b 3). */
export function identityFor({ platform = process.platform, exec = null, env = process.env, root = '/proc', fs = nodeFs } = {}) {
  if (platform === 'win32') return (pid) => winIdentity(pid, { run: exec, env })
  return platform === 'darwin' ? (pid) => psIdentity(pid, { exec, env }) : (pid) => procIdentity(pid, { root, fs })
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
// first space under `ZCode Helper.app` — and the macOS form tables (src/collector/harness/darwin/) are measured against the real one, the first `txt` record
// of `lsof` (the collector's own source, arch/darwin/procinfo.mjs realExeOf). One `lsof … -d txt -Fpn` answers it for every process of the user: `p<pid>`,
// then `f<fd>` / `n<name>` pairs; the first txt name that is a path is the executable. It runs AFTER `ps`, so a row it does not name is a process that ended
// between the two (its `ps` word is kept). An lsof that did not finish (code null: killed by its timeout, more output than TABLE_MAX_BUFFER, or never
// started — what it printed is cut short) or that names no process while `ps` listed some cannot be read: the table is not known (4.6 「判活快照」).
/** psArgv(cmdline, exe) — the argv of a `ps` command line (darwin): the line split on white space, the argument boundaries being lost — except argv[0],
 *  which the real executable (lsof's, `exe`) lets us keep whole: a line that begins with that path, or whose first words (as many as the exe's file name
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

function exesOfLsof({ uid, exec, env, rows }) {
  const r = execTool('lsof', [...(uid != null ? ['-a', '-u', String(uid)] : []), '-d', 'txt', '-Fpn'], { run: exec, env: lsofEnv(env), maxBuffer: TABLE_MAX_BUFFER })
  if (r.code === null) throw new Error(`lsof did not finish (${r.err || 'no reason given'}), so the executables of the ${rows} process(es) ps listed are not known, nor which agents are alive`)
  const exes = new Map()
  let pid = null, txt = false
  for (const line of String(r.out || '').split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); txt = false; if (Number.isInteger(pid) && !exes.has(pid)) exes.set(pid, null) }
    else if (line[0] === 'f') txt = line === 'ftxt'
    else if (line[0] === 'n' && txt && pid != null && exes.get(pid) == null && line[1] === '/') exes.set(pid, line.slice(1))
  }
  if (exes.size === 0 && rows > 0) throw new Error(`lsof named no process (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''}), so the executables of the ${rows} process(es) ps listed are not known, nor which agents are alive`)
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
  if (!out.length) return out // nobody of this user: nothing for lsof to name
  const exes = exesOfLsof({ uid, exec, env, rows: out.length })
  for (const p of out) if (exes.get(p.pid)) { p.exe = exes.get(p.pid); p.argv = psArgv(p.cmdline, p.exe) }
  return out
}

/** The live processes of one user: `[{ pid, ppid, uid, startedAt: ms | null, exe, argv, env: () => Map | null }]` — `env` is read when asked for; macOS and
 *  Windows rows add `cmdline` (the command line as it came, or null) and `envRead: false` (no other process's environment is readable there: `env` is null by the
 *  OS's rule, not because a read failed). `uid` null lists everyone's. Linux reads `root` (/proc); macOS runs `ps` then `lsof` (the executables), Windows one
 *  fixed Get-CimInstance question, all through `exec`
 *  (a spawnSync-like runner a test injects; execTool refuses a real one under npm test). Another platform, or a table that cannot be read, rejects. */
export async function listProcs({ uid = typeof process.getuid === 'function' ? process.getuid() : null, root = '/proc', platform = process.platform, exec = null, env = process.env } = {}) {
  if (platform === 'linux') return procsOfLinux({ uid, root })
  if (platform === 'darwin') return procsOfPs({ uid, exec, env })
  if (platform === 'win32') return procsOfWin({ exec, env })
  throw new Error(`there is no process-table reader for ${platform}, so which agents are alive is not known`)
}

// The one fixed question of the whole process table on Windows (4.8 §7): one Get-CimInstance over Win32_Process, every field this file's
// row shape wants, as JSON — one question for the whole machine, not one per process. Windows has no uid (null: the row says whose it is
// not), the command line comes joined by spaces (argv is it split on whitespace, its argument boundaries lost — the same as macOS's `ps`; `cmdline`
// is the line as it came, what the form tables' command-line patterns read), and another process's environment cannot be read at all (`env` null,
// `envRead: false`: the OS's rule, 4.8 §10.1). A question that died, or an answer that is not JSON, is an error, never
// an empty table: an empty one would say "nobody holds the bundle" and delete it (D38, the rule of the other two readers).
const WIN_TABLE_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; x = $_.ExecutablePath; s = $(try { [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { $null }); c = $_.CommandLine } } | ConvertTo-Json -Compress'
function procsOfWin({ exec, env }) {
  const r = execTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_TABLE_SCRIPT], { run: exec, env, maxBuffer: TABLE_MAX_BUFFER })
  const what = `the Windows process table (one Get-CimInstance question) ${r.code === null ? `did not run (${r.err || 'no reason given'})` : `failed (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''})`}, so which agents are alive is not known`
  if (r.code !== 0) throw new Error(what)
  if (r.out === '') return [] // a table that printed nothing is an empty table (the same reading as `ps` printing nothing)
  let rows
  try { rows = JSON.parse(r.out) } catch { throw new Error(what.replace('did not run', 'answered something that is not JSON')) }
  const out = []
  for (const row of Array.isArray(rows) ? rows : [rows]) { // one process on the machine: PowerShell's JSON is an object, not a list
    if (row === null || typeof row !== 'object' || !Number.isFinite(row.p)) continue
    const name = typeof row.n === 'string' && row.n !== '' ? row.n : null
    const cmdline = typeof row.c === 'string' && row.c !== '' ? row.c : null
    out.push({ pid: Number(row.p), ppid: Number.isFinite(row.pp) ? Number(row.pp) : null, uid: null, startedAt: Number.isFinite(row.s) ? Number(row.s) : null, exe: typeof row.x === 'string' && row.x !== '' ? row.x : name, argv: (cmdline || name || '').split(/\s+/).filter((s) => s !== ''), argvSplit: true, cmdline, env: () => null, envRead: false })
  }
  return out
}
