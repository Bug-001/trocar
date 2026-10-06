import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readExe, readArgv, readEnviron, readComm, listPids, countDirectConnections, directConnections,
} from '../../../../src/collector/arch/linux/procinfo.mjs'

// Build a synthetic /proc tree in a tmp dir so these run everywhere with no root.
function makeProc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-proc-'))
  const mk = (pid, { exe, cmdline, environ, comm, fds = [] }) => {
    const d = path.join(root, String(pid))
    fs.mkdirSync(path.join(d, 'fd'), { recursive: true })
    if (exe) fs.symlinkSync(exe, path.join(d, 'exe'))
    if (cmdline != null) fs.writeFileSync(path.join(d, 'cmdline'), cmdline)
    if (environ != null) fs.writeFileSync(path.join(d, 'environ'), environ)
    if (comm != null) fs.writeFileSync(path.join(d, 'comm'), comm)
    for (const [fd, target] of fds) fs.symlinkSync(target, path.join(d, 'fd', String(fd)))
  }
  // pid 100: a node-hosted harness; argv carries the real script path; NUL-delimited cmdline/environ.
  mk(100, {
    exe: '/usr/local/bin/node',
    cmdline: 'node\0/usr/local/bin/dsh\0--profile\0headless\0',
    environ: 'PATH=/usr/bin\0DEEPSEEK_BASE_URL=http://127.0.0.1:59999\0',
    comm: 'node\n',
    fds: [[3, 'socket:[1001]'], [4, 'socket:[1002]'], [5, '/dev/null']],
  })
  mk(101, { exe: '/home/x/.opencode/bin/opencode', cmdline: 'opencode\0run\0', environ: 'HOME=/home/x\0', comm: 'opencode\n' })
  // /proc/net/tcp: inode 1001 -> foreign 203.0.113.9:443 ESTABLISHED; inode 1002 -> engine 127.0.0.1:8443 ESTABLISHED.
  // local_address/rem_address are little-endian hex IP : hex port; st 01 = ESTABLISHED.
  // 203.0.113.9 -> bytes 203,0,113,9 -> LE hex 0971 00CB -> "0971.."? compute carefully below.
  fs.mkdirSync(path.join(root, 'net'), { recursive: true })
  const hdr = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
  const row = (sl, remHex, remPort, st, inode) =>
    `${String(sl).padStart(4)}: 0100007F:C000 ${remHex}:${remPort} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 10 0 0 0 0\n`
  // 203.0.113.9 little-endian = 09 71 00 CB -> "0971 00CB"? IP bytes a.b.c.d store as d c b a in /proc: d=9,c=113(0x71),b=0,a=203(0xCB) => "0971 00CB" reversed string = "0971" + "00CB"? Build explicitly:
  const ipLE = (ip) => ip.split('.').map((n) => Number(n).toString(16).padStart(2, '0')).reverse().join('').toUpperCase()
  const foreign = ipLE('203.0.113.9') // -> CB710009 reversed bytes -> "0971.." : our ipLE reverses octets then hex
  const engine = ipLE('127.0.0.1')
  fs.writeFileSync(path.join(root, 'net', 'tcp'),
    hdr +
    row(0, foreign, '01BB', '01', 1001) + // :443 ESTABLISHED, foreign
    row(1, engine, '20FB', '01', 1002)) // :8443 ESTABLISHED, engine (127.0.0.1:8443)
  fs.writeFileSync(path.join(root, 'net', 'tcp6'),
    '  sl  local_address                         remote_address                        st ... inode\n')
  return { root, ipLE }
}

test('readExe/readArgv/readEnviron/readComm parse the synthetic tree', () => {
  const { root } = makeProc()
  assert.equal(readExe(100, { root }), '/usr/local/bin/node')
  assert.deepEqual(readArgv(100, { root }), ['node', '/usr/local/bin/dsh', '--profile', 'headless'])
  const env = readEnviron(100, { root })
  assert.equal(env.get('DEEPSEEK_BASE_URL'), 'http://127.0.0.1:59999')
  assert.equal(readComm(100, { root }), 'node')
  assert.equal(readExe(101, { root }), '/home/x/.opencode/bin/opencode')
})

test('listPids returns only numeric entries', () => {
  const { root } = makeProc()
  const pids = listPids({ root }).sort((a, b) => a - b)
  assert.deepEqual(pids, [100, 101])
})

test('countDirectConnections counts non-engine ESTABLISHED sockets and excludes the engine socket', () => {
  const { root } = makeProc()
  // pid 100 has one foreign ESTABLISHED (inode 1001) and one engine-port socket (inode 1002, 127.0.0.1:8443).
  assert.equal(countDirectConnections(100, { root, enginePort: 8443 }), 1)
  // If we (wrongly) call the engine port 443, then NO socket is the engine, so both count.
  assert.equal(countDirectConnections(100, { root, enginePort: 1 }), 2)
})

// D-17 / review D1-3 (4.6 §开关语义): the count comes from /proc/<pid>/fd against /proc/net/tcp*; when a table that is
// there cannot be read (EACCES, e.g. an LSM policy) the count is unknown with the errno — never 0. An absent tcp6 (IPv6
// off) is not an error.
test('directConnections: an unreadable /proc/net/tcp* is "unknown" with the errno, never 0; an absent tcp6 is fine (D1-3)', { skip: process.getuid && process.getuid() === 0 ? 'root reads a 0000 file' : false }, () => {
  const { root } = makeProc()
  assert.deepEqual(directConnections(100, { root, enginePort: 8443 }), { count: 1, error: null })
  fs.rmSync(path.join(root, 'net', 'tcp6'))
  assert.deepEqual(directConnections(100, { root, enginePort: 8443 }), { count: 1, error: null }, 'no tcp6 with IPv6 off')
  fs.chmodSync(path.join(root, 'net', 'tcp'), 0)
  try { assert.deepEqual(directConnections(100, { root, enginePort: 8443 }), { count: null, error: 'EACCES' }) } finally { fs.chmodSync(path.join(root, 'net', 'tcp'), 0o600) }
  fs.rmSync(path.join(root, 'net', 'tcp'))
  assert.deepEqual(directConnections(100, { root, enginePort: 8443 }), { count: null, error: 'ENOENT' }, 'no table at all: unknown')
})

test('missing pid yields null/0/[]', () => {
  const { root } = makeProc()
  assert.equal(readExe(99999, { root }), null)
  assert.deepEqual(readArgv(99999, { root }), [])
  assert.equal(readComm(99999, { root }), null)
  assert.equal(readEnviron(99999, { root }), null, 'an unreadable environment is not an empty one (D-20)')
  assert.equal(countDirectConnections(99999, { root, enginePort: 8443 }), 0)
})
