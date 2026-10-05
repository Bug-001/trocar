// install.mjs — per-user `asight collector install|uninstall` (RFC 4.6 §安装清单与卸载, §身份与信任「信任注入」,
// D36, D37④; acceptance S10, T10, T11). No sudo: everything lives under the operator's ~/.asight/collector and in
// the agents' own config entries; the machine-wide helper is `asight setup-helper` (arch). Nothing here knows a
// harness or an OS: the descriptors declare their entries (`inject`), the caller passes `scan` / `match` (the
// process table) from daemon.mjs. Install lists every file before touching one; uninstall undoes only what the
// manifest lists, keeps captures unless purgeData, and is safe to run twice or after a crashed install.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { collectorHome } from '../paths.mjs'
import { loadOrCreateCa, caPaths } from './core/tls/ca-store.mjs'
import { planTrust } from './core/trust/plan.mjs'
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, writeOwnedFile, undoEntry, removeEmptyDirs, manifestPath } from './core/trust/journal.mjs'
import { controlRequest } from './core/control.mjs'
import { readText } from './core/config-read.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const listDir = (d) => { try { return fs.readdirSync(d) } catch { return [] } }

// An engine port that is free on both loopback families now (4.6 OPEN「按实例分配」, gate G3): recorded in the
// manifest, the daemon listens there on every start.
export function freeEnginePort() {
  const bind = (port, host) => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => resolve(s)) })
  return (async () => {
    const v4 = await bind(0, '127.0.0.1')
    const { port } = v4.address()
    const v6 = await bind(port, '::1').catch(() => null)
    await Promise.all([v4, v6].filter(Boolean).map((s) => new Promise((r) => s.close(r))))
    return port
  })()
}

function refuseRoot(verb) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error(`asight collector ${verb}: run it as the user whose agents you capture, not as root (D36)`)
}

export async function installCollector({ home = os.homedir(), env = process.env, osName, harnesses, scan = async () => [], match = () => ({ agent: null }), freePort = freeEnginePort } = {}) {
  refuseRoot('install')
  const dir = collectorHome(path.join(home, '.asight')) // collectorHome takes the asight home
  const prior = readManifest(dir)
  if (prior && prior.complete) return { already: true, manifest: prior, plan: null }
  if (prior) throw new Error(`an earlier install did not finish (${manifestPath(dir)}); run "asight collector uninstall" first`)
  const m = newManifest()
  m.dirs = missingDirs(dir)
  const ca = caPaths(path.join(dir, 'ca'))
  m.dirs.push(...missingDirs(ca.dir).filter((d) => !m.dirs.includes(d)))
  m.files.push({ path: ca.key, role: 'ca-key' }, { path: ca.pem, role: 'ca-cert' })
  saveManifest(dir, m) // creates dir 0700; the CA is listed before it is minted
  const { certPem } = loadOrCreateCa({ dir: ca.dir })
  m.engine_port = await freePort()

  const facts = await scan()
  const envMap = new Map(Object.entries(env).filter(([, v]) => typeof v === 'string'))
  const ctxFor = (d) => ({
    os: osName, home, env: envMap, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()),
    readText: (f) => readText(f), listDir, collectorDir: dir, caPem: ca.pem,
  })
  const plan = planTrust({ descriptors: harnesses, ctxFor, caCertPem: certPem, collectorDir: dir })
  m.planned = plan.paths
  saveManifest(dir, m)
  for (const f of plan.files) writeOwnedFile({ dir, manifest: m, harness: f.harness, role: 'trust-file', file: f.path, data: f.data, sources: f.sources })
  for (const e of plan.entries) applyJsonKey({ dir, manifest: m, harness: e.harness, file: e.path, keys: e.keys, value: e.value })
  m.complete = true
  saveManifest(dir, m)
  return { already: false, manifest: m, plan }
}

// 4.6 §安装清单与卸载 step 1: stop this user's daemon and wait until it AND its helper are gone (the helper's
// links are unpinned and go with it). A lock nobody answers for is stale: never kill by it.
export async function stopDaemon({ socketPath, lockFile, request = controlRequest, alive = pidAlive, kill = process.kill.bind(process), timeoutMs = 5000 }) {
  let lock = null
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch { /* no daemon ever ran */ }
  if (!socketPath) return 'none'
  try { await request({ socketPath, method: 'GET', path: '/status', timeoutMs: 2000 }) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') return 'none'
    throw e
  }
  if (!lock || !lock.pid) throw new Error('a collector daemon answers but left no lock file; stop it by hand, nothing was removed')
  kill(lock.pid, 'SIGTERM')
  const pids = [lock.pid, lock.helper_pid].filter(Boolean)
  for (const end = Date.now() + timeoutMs; pids.some(alive);) {
    if (Date.now() > end) throw new Error(`the collector daemon (pid ${pids.join(', ')}) is still running; nothing was removed`)
    await sleep(25)
  }
  return 'stopped'
}

export async function uninstallCollector({ home = os.homedir(), env = process.env, purgeData = false, scan = async () => [], match = () => ({ agent: null }), stop = null } = {}) {
  refuseRoot('uninstall')
  const dir = collectorHome(path.join(home, '.asight')) // collectorHome takes the asight home
  const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'asight') : null
  const report = { daemon: null, entries: [], removed: [], still_trusting: [], kept_captures: !purgeData, notes: [] }
  report.daemon = await (stop || (() => stopDaemon({ socketPath: runtime && path.join(runtime, 'collector.sock'), lockFile: path.join(dir, 'lock') })))()
  const m = readManifest(dir)
  const rm = (p) => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); report.removed.push(p) } }
  if (!m) report.notes.push('nothing is installed for this user')
  else {
    // trust entries, newest first (4.6 撤销顺序 step 1), then the append-semantics trust files (step 3)
    for (const e of [...m.entries].reverse()) report.entries.push(undoEntry(e))
    for (const f of m.files.filter((x) => x.role === 'trust-file' || x.role === 'ca-cert')) rm(f.path)
    // step 5: report, never restart — append-semantics entries are read at start, so these still trust asight
    for (const f of await scan()) { const a = match(f).agent; if (a && m.entries.some((e) => e.harness === a)) report.still_trusting.push({ pid: f.pid, agent: a, until: 'restart' }) }
    // the CA private key and the runtime state last
    for (const f of m.files.filter((x) => x.role === 'ca-key')) rm(f.path)
    for (const p of [path.join(dir, 'run'), path.join(dir, 'lock'), path.join(dir, 'state.json'), runtime]) if (p) rm(p)
  }
  // then the data the operator asked to drop — also after an earlier plain uninstall left the captures behind
  if (purgeData) {
    for (const n of listDir(dir)) if (/^capture-.*\.ndjson$/.test(n)) rm(path.join(dir, n))
    for (const sub of ['flows', 'audit', 'replays']) rm(path.join(dir, sub))
  }
  if (m) {
    removeEmptyDirs(m.dirs.filter((d) => d !== dir)) // e.g. ca/
    fs.rmSync(manifestPath(dir), { force: true }) // the manifest goes last: a second run still finds what the first left
    removeEmptyDirs(m.dirs)
  } else if (purgeData) removeEmptyDirs([dir])
  return report
}
