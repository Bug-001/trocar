// scripts/deploy-check-daemon.mjs — the deploy check's line on the agent's path (RFC 4.4 #19, D78 ④): does a re-read slow what an agent feels?
// A child of scripts/deploy-check.mjs, run from the code under check with no-real-os.cjs preloaded, so this daemon cannot reach the real machine.
//
// A real daemon (true door, true engine, a mock upstream, as test/collector/model-capture-e2e.test.mjs) on a made-up home whose raw/ is a real
// directory of links to the real sealed segments and whose index/ is a clone of the real one, so new records open a segment of their own there
// ('ax', store.mjs) and nothing reaches the real home. Plain segments are left out: the daemon's start scan would seal them through their links,
// and that work would fall inside the windows. The worker re-reads what a daemon's worker would; between two windows it is stopped (SIGSTOP), which
// gives idle windows on the same home. A window under the re-read in which the worker hardly ran means the re-read is over, and it is not counted.
// argv[2]: JSON {real, windowMs, pairs, probeMs}. Sends {measured, windows}: measured.roundTripP95 / roundTripIdleP95 are one request through
// the door, measured.indexP95 / indexIdleP95 the time from its reply to `index/<segment>.json` growing (a null: one never grew).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { parseSegment } from '../src/collector/core/record/segments.mjs'
import { renderWrapper } from '../src/collector/arch/darwin/wrapper.mjs'
import { createCa, loadCa } from '../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../src/collector/core/tls/leaf.mjs'
import { runOnCli } from '../src/cli/on.mjs'
import { modelWorld } from '../test/helpers/model-world.mjs'
import { liveUnit } from '../test/helpers/model-daemon.mjs'
import { BODY, REPLY, agentOf, darwinExec, freePort, reqOf, through } from '../test/helpers/model-io.mjs'
import { listenLocalhost } from '../test/helpers/localhost.mjs'
import { workerForkIn } from '../test/helpers/worker-fork.mjs'
import { clone, p95, rawList } from './deploy-check-lib.mjs'

const { real, windowMs, pairs, probeMs } = JSON.parse(process.argv[2])
const platform = 'darwin' // a modelled one: nothing here reads the OS it names
const GROW_MS = 5000 // a pass runs a second after the last append (index-keeper.mjs): past this it did not come
const BUSY = 0.1 // of one core, over a window: the least a worker re-reading takes
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const cpuMs = (pid) => { try { return execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(':').reduce((t, x) => t * 60 + Number(x), 0) * 1000 } catch { return 0 } }

const w = await modelWorld({ os: platform, commands: ['codex'] })
assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
const trocar = path.dirname(w.dir), sideRaw = path.join(trocar, 'raw'), sideIndex = path.join(trocar, 'index')
fs.mkdirSync(sideRaw, { recursive: true, mode: 0o700 })
for (const { name } of rawList(path.join(real, 'raw'))) if (parseSegment(name).sealed) fs.symlinkSync(path.join(real, 'raw', name), path.join(sideRaw, name))
assert.ok(!fs.existsSync(sideIndex))
if (fs.existsSync(path.join(real, 'index'))) clone(path.join(real, 'index'), sideIndex)

const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
const upCa = createCa({ commonName: 'deploy check upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => {
  s.on('error', () => {}); let b = Buffer.alloc(0)
  s.on('data', (d) => { b = Buffer.concat([b, d]); if (b.includes(BODY)) { b = Buffer.alloc(0); s.write(REPLY) } })
})
const target = `localhost:${await listenLocalhost(mock)}`, REQ = reqOf(target)
const bundle = path.join(w.home, 'codex-ca.pem')
fs.writeFileSync(bundle, rootPem + upCa.certPem)
const a = agentOf({ w, name: w.harnesses.find((h) => h.name === 'codex').processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
const forkWorker = workerForkIn(w.env)
let worker = null
const box = await liveUnit({ w, platform, io: { exec: darwinExec(a) }, daemon: { fork: (...args) => (worker = forkWorker(...args)), queryIdleMs: 24 * 3600_000 } })
const open = []
try {
  const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
  const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => sleep(Math.min(ms, 25)) }
  assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0)
  const url = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
  const door = Number(url.port), auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
  const once = async () => { a.ports.add(await freePort()); return through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req: REQ, open }) }

  await (await once()).end() // opens the segment
  let segment = null
  while (!segment) { try { segment = JSON.parse(fs.readFileSync(path.join(w.dir, 'lock'), 'utf8')).segment } catch { /* mid-rename */ } await sleep(25) }
  const indexFile = path.join(sideIndex, `${segment}.json`), size = () => { try { return fs.statSync(indexFile).size } catch { return 0 } }
  await sleep(probeMs) // the opening request's pass
  const probe = async () => {
    const was = size(), t = performance.now(), one = await once(), trip = performance.now() - t, replied = performance.now()
    const ended = one.end()
    while (size() <= was && performance.now() - replied < GROW_MS) await sleep(5)
    const grew = size() > was ? performance.now() - replied : Infinity
    await ended
    return { trip, grew }
  }

  const all = { busy: { trip: [], grew: [] }, idle: { trip: [], grew: [] } }, windows = []
  outer: for (let i = 0; i < pairs; i++) for (const state of ['busy', 'idle']) {
    worker.kill(state === 'busy' ? 'SIGCONT' : 'SIGSTOP')
    const cpu = cpuMs(worker.pid), end = Date.now() + windowMs, got = []
    // one probe each probeMs, not as fast as it can: a record is a kick, and the worker takes its next re-read 2 s after one (3.5 §谁执行它)
    while (Date.now() < end) { const t = Date.now(); got.push(await probe()); await sleep(t + probeMs - Date.now()) }
    const load = (cpuMs(worker.pid) - cpu) / windowMs
    windows.push({ state, load: Math.round(load * 100) / 100, probes: got.length })
    if (state === 'busy' && load < BUSY) break outer
    for (const g of got) { all[state].trip.push(g.trip); all[state].grew.push(g.grew) }
  }
  worker.kill('SIGCONT')
  const ms = (v) => (v == null ? null : Math.round(v * 10) / 10)
  process.send({ windows, measured: { roundTripP95: ms(p95(all.busy.trip)), roundTripIdleP95: ms(p95(all.idle.trip)), indexP95: ms(p95(all.busy.grew)), indexIdleP95: ms(p95(all.idle.grew)) } })
} finally {
  worker?.kill('SIGCONT')
  for (const s of open) s.destroy()
  await box.stop()
  await new Promise((ok) => mock.close(ok))
}
process.exit(0)
