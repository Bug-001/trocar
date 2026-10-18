// scripts/perf-capture.mjs — the D62 line 「采集一次请求的 CPU ≤ 5 ms」, measured on a sandbox daemon in a temp HOME.
//
// WHY A CHILD: the only honest way to read the DAEMON's CPU is to have nothing else in its process. So this parent is
// asight and only asight (modelWorld install → the real `asight on` → the real daemon of test/helpers/model-daemon.mjs,
// whose door parts are the arch's own and whose OS readers are the e2e test's stand-ins), and the forked child holds
// everything that is not asight: the mock upstream with a CA of its own, and the agent-side TLS client loop. The
// parent's own work during the measured window is one IPC message, so `process.cpuUsage()` deltas around the loop are
// the daemon's.
//
// WHAT IT PRINTS: per request size, the CPU the daemon spent per captured request (user + system), split by phase —
// the index keeper's share is measured by its own cpuUsage deltas (`ASIGHT_PERF_HOOK`), the rest is the engine's.
// `--prof` adds a V8 CPU profile of the parent (`--cpu-prof` style, written next to the results) for attribution.
//
// NEVER THE REAL HOME: the HOME is a tmpDir and the process table is a fake; nothing here reads or writes ~/.asight.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(import.meta.url)
const CHILD = path.join(path.dirname(HERE), 'perf-capture-peer.mjs')
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1] }
const N = Number(arg('n', 60))
const GAP = Number(arg('gap', 0)) // ms between requests; > DEBOUNCE_MS gives the worst arrival shape (one keeper pass per record)
const SIZES = String(arg('sizes', '2048,51200,512000')).split(',').map(Number)
const PORT_BASE = Number(arg('port-base', 41700))

if (process.argv.includes('--peer')) { await (await import(CHILD)).peer(); process.exit(0) }

const { modelWorld } = await import('../test/helpers/model-world.mjs')
const { liveUnit } = await import('../test/helpers/model-daemon.mjs')
const { renderWrapper } = await import('../src/collector/arch/darwin/wrapper.mjs')
const { NATIVE } = await import('../src/collector/arch/darwin/native.mjs')
const { runOnCli } = await import('../src/cli/on.mjs')

const ok = (stdout) => ({ status: 0, stdout, stderr: '' })
const no = (why) => ({ status: 1, stdout: '', stderr: why })
const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n) => String(n).padStart(2, '0')
const lstart = (ms) => { const d = new Date(ms); return `${W[d.getDay()]} ${M[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}` }

const PID = 2_000_001
const darwinExec = (a) => (file, args) => {
  const mine = (i) => args[i] === String(a.pid)
  if (file === 'netstat') {
    const rows = [...a.ports].map((p) => `tcp4 0 0 127.0.0.1.${p} 127.0.0.1.1 ESTABLISHED 1 1 1 1 ${a.name}:${a.pid} 00102`)
    return ok(['Proto Recv-Q Send-Q Local Address Foreign Address (state) rxbytes txbytes rhiwat shiwat process:pid state', ...rows].join('\n'))
  }
  if (file === 'lsof') {
    if (args.includes('cwd')) return mine(2) ? ok(`p${a.pid}\nfcwd\nn${a.cwd}\n`) : no('')
    if (args[0] === '-p') return mine(1) ? ok(`p${a.pid}\nftxt\nn${a.exe}\n`) : no('')
    if (args.includes('txt')) return ok(`p${a.pid}\nftxt\nn${a.exe}\n`)
  }
  if (file === 'ps') {
    if (args[0] === '-Axo') return ok(`${a.pid} 1 ${a.uid} ${lstart(a.start)} ${a.exe}\n`)
    if (args[0] === '-p' && args[3].startsWith('pid=')) return mine(1) ? ok(`${a.pid} 1 ${a.uid} ${a.name} ${lstart(a.start)} ${a.exe}\n`) : no('')
    return no('')
  }
  if (path.basename(file) === NATIVE.procenv) return mine(0) ? ok(args.slice(1).filter((n) => a.env[n] != null).map((n) => `${n}=${a.env[n]}`).join('\0')) : no('')
  return no(`not faked: ${file}`)
}

const us = (c) => (c.user + c.system) / 1000 // → ms
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
if ((await w.install({ wrapperKit: { renderWrapper } })).exit !== 0) throw new Error('install failed')
fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true })
fs.writeFileSync(path.join(w.home, '.codex', '.env'), '# own\n')
const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'asight-ca.pem'), 'utf8')

const child = fork(HERE, ['--peer'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
// Every wait has a deadline and every peer failure lands here: a rejected request in the peer used to leave the
// parent waiting on `done` at 0 % CPU forever (diagnosed 2026-10-20).
child.on('message', (m) => { if (m.kind === 'error') { process.stderr.write(`peer failed: ${m.error}\n`); process.exit(3) } })
child.on('exit', (c) => { if (c !== null && c !== 0) { process.stderr.write(`peer exited ${c}\n`); process.exit(3) } })
const fromChild = (kind, ms = 120_000) => new Promise((res, rej) => {
  const t = setTimeout(() => { child.off('message', on); rej(new Error(`the peer never said ${kind} within ${ms} ms`)) }, ms)
  const on = (m) => { if (m.kind === kind) { clearTimeout(t); child.off('message', on); res(m) } }
  child.on('message', on)
})
const hello = (child.send({ kind: 'start', sizes: SIZES, n: N, portBase: PORT_BASE }), await fromChild('up'))

const bundle = path.join(w.home, 'codex-ca.pem')
fs.writeFileSync(bundle, rootPem + hello.caPem)
const desc = w.harnesses.find((h) => h.name === 'codex')
const agent = { pid: PID, name: desc.processes.names[0].name, exe: path.join(w.home, 'bin', desc.processes.names[0].name), start: Math.ceil(Date.now() / 1000) * 1000 + 1000, uid: process.getuid(), env: { SSL_CERT_FILE: bundle }, cwd: w.home }
agent.ports = new Set(Array.from({ length: (N + 8) * SIZES.length + 16 }, (_, i) => PORT_BASE + i))

// the keeper's own CPU, measured where it runs (see ASIGHT_PERF_HOOK in src/collector/index-keeper.mjs)
const keeper = { ms: 0, passes: 0 }
globalThis.__asightPerfHook = (ms) => { keeper.ms += ms; keeper.passes++ }
process.env.ASIGHT_PERF_HOOK = '1'

const box = await liveUnit({ w, platform: 'darwin', io: { exec: darwinExec(agent) } })
const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))) }
if (await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps }) !== 0) throw new Error('on failed')
const url = /^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, '')
const u = new URL(url)

let prof = null
if (process.argv.includes('--prof')) {
  const { Session } = await import('node:inspector')
  prof = new Session(); prof.connect()
  const post = (m, p) => new Promise((res, rej) => prof.post(m, p, (e, r) => (e ? rej(e) : res(r))))
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }); await post('Profiler.start')
  prof.stopAndWrite = async (file) => { const { profile } = await post('Profiler.stop'); fs.writeFileSync(file, JSON.stringify(profile)) }
}

const results = []
const rawDir = path.join(w.home, '.asight', 'raw')
const lines = () => fs.readdirSync(rawDir).reduce((n, f) => n + (f.endsWith('.ndjson') ? fs.readFileSync(path.join(rawDir, f), 'utf8').split('\n').filter(Boolean).length : 0), 0)

for (const [i, size] of SIZES.entries()) {
  child.send({ kind: 'run', size, n: N, gap: GAP, portBase: PORT_BASE, door: Number(u.port), auth: Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'), rootPem, warm: 3 })
  await fromChild('warmed', 60_000)
  const before = lines(), k0 = { ...keeper }, c0 = process.cpuUsage(), t0 = Date.now()
  child.send({ kind: 'go' })
  const done = await fromChild('done', N * (GAP + 3_000) + 60_000)
  const cpu = process.cpuUsage(c0), wall = Date.now() - t0
  await new Promise((r) => setTimeout(r, 1400)) // the keeper's debounce, so its passes land inside the sample
  const kAfter = { ms: keeper.ms, passes: keeper.passes }
  const recs = lines() - before
  // the idle baseline over the SAME wall time, subtracted (the acceptance's method): with gaps most of the window is idle
  const i0 = process.cpuUsage()
  await new Promise((r) => setTimeout(r, Math.min(wall, 6_000)))
  const idle = us(process.cpuUsage(i0)) * (wall / Math.min(wall, 6_000))
  const net_ms = us(cpu) - idle
  results.push({ size, gap_ms: GAP, requests: done.sent, records: recs, wall_ms: wall, cpu_ms: +us(cpu).toFixed(1), idle_ms: +idle.toFixed(1),
    per_request_ms: +(net_ms / Math.max(1, recs)).toFixed(3),
    keeper_ms: +(kAfter.ms - k0.ms).toFixed(1), keeper_passes: kAfter.passes - k0.passes, keeper_per_request_ms: +((kAfter.ms - k0.ms) / Math.max(1, recs)).toFixed(3) })
  say(results.at(-1))
}

if (prof) await prof.stopAndWrite(arg('prof-out', '/tmp/asight-perf-capture.cpuprofile'))
child.send({ kind: 'bye' }); child.kill()
await box.stop()
say({ summary: results })
const out = arg('out', null)
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), node: process.version, n: N, results }, null, 2))
process.exit(0)
