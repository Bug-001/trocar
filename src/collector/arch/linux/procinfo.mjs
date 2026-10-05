// Linux /proc readers for the collector (spec 4.6 §身份与信任, §开关语义:
// "状态里给出每个 agent 进程仍在直连、因此没被采集 的连接数").
//
// Userspace resolves process identity (exe path + argv) because the connect/sock_create BPF
// hooks cannot read the executable path (no bpf_probe_read_user there; comm is 15 chars and
// spoofable — research finding b/cross-cutting). Every reader takes an injectable `root`
// (default '/proc') so tests point at a synthetic tree, and every reader tolerates a vanished
// or unreadable process (ESRCH/EACCES) by returning null/0/[] rather than throwing — a process
// can exit between the exec event and the read. Node built-ins only (D18).

import fs from 'node:fs'
import path from 'node:path'

/** readlink /proc/<pid>/exe → absolute path, or null. */
export function readExe(pid, { root = '/proc' } = {}) {
  try { return fs.readlinkSync(path.join(root, String(pid), 'exe')) } catch { return null }
}

/** /proc/<pid>/cmdline → argv (NUL-delimited, trailing NUL trimmed), or []. */
export function readArgv(pid, { root = '/proc' } = {}) {
  let buf
  try { buf = fs.readFileSync(path.join(root, String(pid), 'cmdline'), 'utf8') } catch { return [] }
  if (!buf) return []
  const parts = buf.split('\0')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** /proc/<pid>/environ → Map<name,value> (NUL-delimited, split on first '='), or empty Map. */
export function readEnviron(pid, { root = '/proc' } = {}) {
  const m = new Map()
  let buf
  try { buf = fs.readFileSync(path.join(root, String(pid), 'environ'), 'utf8') } catch { return m }
  for (const entry of buf.split('\0')) {
    if (!entry) continue
    const i = entry.indexOf('=')
    if (i < 0) m.set(entry, '')
    else m.set(entry.slice(0, i), entry.slice(i + 1))
  }
  return m
}

/** /proc/<pid>/comm → thread-group leader name (trimmed), or null. */
export function readComm(pid, { root = '/proc' } = {}) {
  try { return fs.readFileSync(path.join(root, String(pid), 'comm'), 'utf8').trim() } catch { return null }
}

/** numeric entries under /proc → pid[] */
export function listPids({ root = '/proc' } = {}) {
  let names
  try { names = fs.readdirSync(root) } catch { return [] }
  const pids = []
  for (const n of names) if (/^\d+$/.test(n)) pids.push(Number(n))
  return pids
}

// --- /proc/net/tcp{,6} parsing (little-endian hex IP : hex port ; st 01 = ESTABLISHED) ---
const TCP_ESTABLISHED = 0x01

function hexIpToStr(hex) {
  if (hex.length === 8) {
    // IPv4, little-endian byte order in the file.
    const b = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
    return b.map((h) => parseInt(h, 16)).join('.')
  }
  if (hex.length === 32) {
    // IPv6: four little-endian 32-bit words; reverse bytes within each word, emit 8 hextets.
    const bytes = []
    for (let w = 0; w < 4; w++) {
      const word = hex.slice(w * 8, w * 8 + 8)
      for (let i = 3; i >= 0; i--) bytes.push(word.slice(i * 2, i * 2 + 2))
    }
    const hextets = []
    for (let i = 0; i < 16; i += 2) hextets.push((parseInt(bytes[i], 16) * 256 + parseInt(bytes[i + 1], 16)).toString(16))
    return hextets.join(':')
  }
  return null
}

// Map socket inode -> {remAddr, remPort, state} for ESTABLISHED rows across tcp + tcp6.
function parseNetTcp(root) {
  const byInode = new Map()
  for (const file of ['tcp', 'tcp6']) {
    let text
    try { text = fs.readFileSync(path.join(root, 'net', file), 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].trim().split(/\s+/)
      if (cols.length < 10) continue
      const rem = cols[2]
      const st = parseInt(cols[3], 16)
      const inode = cols[9]
      const ci = rem.indexOf(':')
      if (ci < 0) continue
      const remAddr = hexIpToStr(rem.slice(0, ci))
      const remPort = parseInt(rem.slice(ci + 1), 16)
      byInode.set(inode, { remAddr, remPort, state: st })
    }
  }
  return byInode
}

function socketInodesOf(pid, root) {
  let fds
  try { fds = fs.readdirSync(path.join(root, String(pid), 'fd')) } catch { return [] }
  const inodes = []
  for (const fd of fds) {
    let target
    try { target = fs.readlinkSync(path.join(root, String(pid), 'fd', fd)) } catch { continue }
    const m = /^socket:\[(\d+)\]$/.exec(target)
    if (m) inodes.push(m[1])
  }
  return inodes
}

/**
 * Count the pid's ESTABLISHED TCP connections whose peer is NOT the local engine
 * (127.0.0.1/::1 : enginePort) — i.e. connections still going direct, therefore not captured.
 * Returns 0 if the process is gone or has no such sockets.
 */
export function countDirectConnections(pid, { root = '/proc', enginePort } = {}) {
  const inodes = socketInodesOf(pid, root)
  if (inodes.length === 0) return 0
  const byInode = parseNetTcp(root)
  let n = 0
  for (const inode of inodes) {
    const row = byInode.get(inode)
    if (!row || row.state !== TCP_ESTABLISHED) continue
    const isLoopback = row.remAddr === '127.0.0.1' || row.remAddr === '0:0:0:0:0:0:0:1' || row.remAddr === '::1'
    const isEngine = enginePort != null && isLoopback && row.remPort === enginePort
    if (!isEngine) n++
  }
  return n
}
