// test/helpers/model-io.mjs — the OS as the model daemon's door parts read it, faked for one agent process (model-capture-e2e and the stop
// barrier e2e share it): agentOf (the process facts), darwinExec (the socktable / lsof / ps / procenv runner), win32Io (the fake helper over a
// fixture it rereads, and the powershell table), through (one agent connection through a door: CONNECT with credentials, TLS, one request), flowsOf, and statusDoc
// (`status --json` against the live daemon).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { within, onceWithin } from './bounded.mjs'
import { tmpDir } from './tmp.mjs'
import { NATIVE } from '../../src/collector/arch/darwin/native.mjs'
import { statusRun } from '../../src/cli/status.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'
import { gatherWin32Facts } from '../../src/collector/arch/win32/netfacts.mjs'

const FAKE_HELPER = fileURLToPath(new URL('../collector/arch/win32/fixtures/fake-helper.mjs', import.meta.url))
export const PID = 2_000_001 // the agent's pid as the fake readers answer it: never this process (the doors exclude their own pid) nor a real one
export const BODY = '{"model":"e2e","input":"trocar-model-e2e"}'
export const reqOf = (host) => `POST /v1/responses HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`
export const REPLY = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\npong'
export const doorOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })
const ok = (stdout) => ({ status: 0, stdout, stderr: '' })
const no = (why) => ({ status: 1, stdout: '', stderr: why })
const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n) => String(n).padStart(2, '0')
/** ps's lstart in the C locale, local time: "Mon Oct  8 17:00:00 2026". */
const lstart = (ms) => { const d = new Date(ms); return `${W[d.getDay()]} ${M[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}` }

/** A process start the OS readers report as later than every moment so far: the second after the next whole one (ps's lstart counts whole
 *  seconds). The door decrypts only a process that started after its carrier was installed (4.11 P11 rule 3). */
export const startAfterNow = () => Math.ceil(Date.now() / 1000) * 1000 + 1000

/** The agent as the OS readers see it: { pid, exe, start, uid, env, cwd, ports (its sockets' local ports), alive }. Its start is after now: a
 *  test whose install runs later (a daemon child installs as it starts) gives it `startAfterNow()` again once that install is done. */
export function agentOf({ w, name, env }) {
  return { pid: PID, name, exe: path.join(w.home, 'bin', name), start: startAfterNow(), uid: process.getuid(), env, cwd: w.home, ports: new Set(), alive: true }
}

/** darwin: the spawnSync-shaped runner of the socktable helper / lsof / ps / procenv (socktable, procinfo, the process table, scutil) answering for `a` only. */
export const darwinExec = (a) => (file, args) => {
  const mine = (i) => args[i] === String(a.pid) && a.alive
  if (path.basename(file) === NATIVE.socktable) return ok(a.alive ? [...a.ports].map((p) => `${a.pid} ESTABLISHED 127.0.0.1 ${p} 127.0.0.1 1`).join('\n') : '') // one row per socket `a` holds
  if (file === 'lsof') {
    if (args.includes('cwd')) return mine(2) ? ok(`p${a.pid}\nfcwd\nn${a.cwd}\n`) : no('')
    if (args[0] === '-p') return mine(1) ? ok(`p${a.pid}\nftxt\nn${a.exe}\n`) : no('')
    if (args.includes('txt')) return a.alive ? ok(`p${a.pid}\nftxt\nn${a.exe}\n`) : ok('') // the table's executables
  }
  if (file === 'ps') {
    if (args[0] === '-Axo') return ok(a.alive ? `${a.pid} 1 ${a.uid} ${lstart(a.start)} ${a.exe}\n` : '')
    if (args[0] === '-p' && args[3].startsWith('pid=')) return mine(1) ? ok(`${a.pid} 1 ${a.uid} ${a.name} ${lstart(a.start)} ${a.exe}\n`) : no('')
    return no('')
  }
  if (path.basename(file) === NATIVE.procenv) return mine(0) ? ok(args.slice(1).filter((n) => a.env[n] != null).map((n) => `${n}=${a.env[n]}`).join('\0')) : no('')
  return no(`not faked: ${file}`) // scutil: no system proxy readable
}

/** win32: the fake helper over a fixture file it reads again per request (its `reread`), and the powershell process table. `fx`: that file's path,
 *  when a daemon in another process reads the one this process writes. */
export function win32Io(a, { fx = path.join(tmpDir('trocar-helper-'), 'fixture.json') } = {}) {
  const write = () => fs.writeFileSync(fx, JSON.stringify({ reread: true, verbs: {
    ps: { data: { sessionId: 1, procs: a.alive ? [{ pid: a.pid, ppid: 1, name: a.name, exe: a.exe, cmdline: a.exe, cmdlineState: 'ok', startedAt: a.start, sessionId: 1, sameUser: true, integrity: 'medium', tokenDenied: false }] : [] } },
    'tcp-table': { data: { rows: a.alive ? [...a.ports].map((p) => ({ pid: a.pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: p, remoteAddr: '127.0.0.1', remotePort: 1 })) : [] } },
    'proc-env': { data: { ok: true, envB64: Buffer.from(Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le').toString('base64'), cwd: a.cwd, startedAt: a.start, parent: null } },
    'reg-read': { data: { values: {} } },
  } }))
  write()
  const exec = (file) => (file === 'powershell' ? ok(a.alive ? JSON.stringify([{ p: a.pid, pp: 1, n: a.name, x: a.exe, s: a.start, c: a.exe }]) : '') : no(`not faked: ${file}`))
  return { io: { exec, helper: { exe: process.execPath, args: [FAKE_HELPER, fx], spawn: (exe, args, o) => spawn(exe, args, { ...o, env: { ...o.env, TROCAR_FAKE_HELPER: '1' } }) } }, write }
}

export const flowsOf = (dir) => { const d = path.join(dir, 'flows'); return (fs.existsSync(d) ? fs.readdirSync(d) : []).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) }
export const freePort = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p }

/** One agent connection: from a known local port, CONNECT through the door with its credentials, TLS trusting `ca` only, the request, the whole reply. */
export async function through({ door, auth, target, localPort, ca, req, open }) {
  const raw = net.connect({ port: door, host: '127.0.0.1', localAddress: '127.0.0.1', localPort })
  open.push(raw)
  await onceWithin(raw, 'connect')
  raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
  const head = await within(new Promise((res, rej) => { let b = ''; const on = (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { raw.off('data', on); res(b) } }; raw.on('data', on); raw.once('error', rej) }), 5000, 'the door answered CONNECT')
  assert.match(head, /^HTTP\/1\.[01] 200/, `the door took the CONNECT: ${head}`)
  const c = tls.connect({ socket: raw, servername: target.split(':')[0], ca })
  open.push(c)
  await within(new Promise((res, rej) => { c.once('secureConnect', res); c.once('error', rej) }), 5000, 'the TLS handshake')
  const reply = within(new Promise((res, rej) => { let b = ''; c.on('data', (d) => { b += d.toString('latin1'); if (b.length >= REPLY.length) res(b) }); c.once('error', rej) }), 5000, 'the reply')
  c.write(req)
  const peer = c.getPeerCertificate(true)
  return { reply: await reply, peer, end: () => new Promise((r) => { c.once('close', r); c.end() }) }
}

/** `status --json` over the real daemon: the process table is `all` (pid, startedAt) of `a`'s executable, `live` the pids still in it; the
 *  platform's network facts run with their OS reads faked. */
export async function statusDoc({ w, platform, box, a, all, live }) {
  const exe = a.exe, rows = all.filter((p) => live.includes(p.pid))
  const archFacts = platform === 'win32'
    ? (ctx) => gatherWin32Facts(ctx, { helper: { call: async (verb) => (verb === 'ps' ? { sessionId: 1, procs: rows.map((p) => ({ ...p, ppid: 1, name: a.name, exe, cmdline: exe, cmdlineState: 'ok', sessionId: 1, sameUser: true, integrity: 'medium', tokenDenied: false })) } : verb === 'tcp-table' ? { rows: [] } : Promise.reject(Object.assign(new Error('not faked'), { code: 'not-faked' }))) }, readSystemProxy: async () => ({ ok: false, reason: 'absent' }) })
    : (ctx) => darwinNetFacts(ctx, { exec: () => ({ status: 1, stdout: '', stderr: 'not faked' }) })
  const sio = { t: '', out(s) { this.t += s }, err(s) { this.t += s }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
  const procs = async () => rows.map((p) => ({ ...p, ppid: 1, uid: process.getuid(), exe, argv: [exe], env: () => null, envRead: false }))
  await statusRun(['--json'], { io: sio, env: w.env, home: w.home, platform, deps: { platform, procs, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), alive: () => true, exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: box.parts, lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts }), rootStore: w.store } })
  return JSON.parse(sio.t.slice(sio.t.indexOf('{')))
}
