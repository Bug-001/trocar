// proc.mjs (src/off) — the process table `off` reads for itself, and the identity of one process (RFC 4.6 §安装清单与卸载「撤销顺序」第 2 / 5 步,
// §控制面 `lock`, 1.6 R3). `off` has to know which agents are alive after the daemon is stopped and the entries are undone, with no daemon to ask
// and no collector code (the standalone `asight-off` is made of src/off alone, 0.1 §2): Linux reads /proc, macOS runs `ps` through execTool.
// The /proc readers moved here from src/collector/arch/linux/procinfo.mjs, which re-exports them; procIdentity / pidAlive from
// src/health/read.mjs, which re-exports procIdentity. A table that cannot be read throws: an empty one would read as "nobody is alive" (D38).
// Every reader takes an injectable `root` (default '/proc'), so a test points it at a synthetic tree. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'

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

/** {start_time, boot_id} of a live process (strings), each null when it cannot be read (no /proc, gone, EACCES). */
export function procIdentity(pid, { root = '/proc', fs = nodeFs } = {}) {
  let start_time = null, boot_id = null
  try {
    const stat = fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/) // field 3 onward: comm may hold ')' or spaces
    if (/^\d+$/.test(f[19] || '')) start_time = f[19]
  } catch { /* gone or no /proc: start_time stays null, and the judge says so */ }
  try { boot_id = fs.readFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim() || null } catch { /* no /proc */ }
  return { start_time, boot_id }
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
    out.push({ pid, uid: st.uid, startedAt: readStartTime(pid, { root }), exe: readExe(pid, { root }), argv: readArgv(pid, { root }), env: () => (env !== undefined ? env : (env = readEnviron(pid, { root }))) })
  }
  return out
}

// `ps -Axo pid=,uid=,lstart=,command=`: lstart is five words ("Wed Oct  7 04:27:00 2026", local time), the command line joined by spaces — its
// argument boundaries are lost, so argv is that line split on whitespace (a path with a space in it splits), and the environment of another
// process cannot be read here at all (null: unknown).
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S.*)$/
function procsOfPs({ uid, exec }) {
  const r = execTool('ps', ['-Axo', 'pid=,uid=,lstart=,command='], { run: exec })
  if (r.code !== 0) throw new Error(`ps failed (${r.code === null ? r.err : `exit ${r.code}: ${r.err}`}), so which agents are alive is not known`)
  const out = []
  for (const line of r.out.split('\n')) {
    const m = PS_ROW.exec(line)
    if (!m || (uid != null && Number(m[2]) !== uid)) continue
    const argv = m[4].trim().split(/\s+/)
    const at = new Date(m[3].replace(/\s+/g, ' ')).getTime()
    out.push({ pid: Number(m[1]), uid: Number(m[2]), startedAt: Number.isFinite(at) ? at : null, exe: argv[0], argv, env: () => null })
  }
  return out
}

/** The live processes of one user: `[{ pid, uid, startedAt: ms | null, exe, argv, env: () => Map | null }]` — `env` is read when asked for.
 *  `uid` null lists everyone's. Linux reads `root` (/proc); macOS runs `ps` through `exec` (a spawnSync-like runner a test injects; execTool
 *  refuses a real one under npm test). Another platform, or a table that cannot be read, rejects. */
export async function listProcs({ uid = typeof process.getuid === 'function' ? process.getuid() : null, root = '/proc', platform = process.platform, exec = null } = {}) {
  if (platform === 'linux') return procsOfLinux({ uid, root })
  if (platform === 'darwin') return procsOfPs({ uid, exec })
  throw new Error(`there is no process-table reader for ${platform}, so which agents are alive is not known`)
}
