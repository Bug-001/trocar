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
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, previewJsonKey, writeOwnedFile, undoEntry, removeEmptyDirs, manifestPath, sweepTemps } from './core/trust/journal.mjs'
import { controlRequest } from './core/control.mjs'
import { readText } from './core/config-read.mjs'
import { appendEvent } from './core/events.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const listDir = (d) => { try { return fs.readdirSync(d) } catch { return [] } }

// An engine port that is free on both loopback families now (4.6 OPEN「按实例分配」, gate G3): recorded in the
// manifest, the daemon listens there on every start. A port whose [::1] side is taken is skipped (the daemon would
// refuse to attach there, M8); a machine without IPv6 keeps the 127.0.0.1 port.
const bindOnce = (port, host) => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => resolve(s)) })
const closeServer = (s) => new Promise((r) => s.close(r))
export async function freeEnginePort({ tries = 20, listen = bindOnce } = {}) {
  for (let i = 0; i < tries; i++) {
    const v4 = await listen(0, '127.0.0.1')
    const { port } = v4.address()
    let v6 = null
    try { v6 = await listen(port, '::1') } catch (e) { if (e.code === 'EADDRINUSE') { await closeServer(v4); continue } }
    await Promise.all([v4, v6].filter(Boolean).map(closeServer))
    return port
  }
  throw new Error(`no port was free on both 127.0.0.1 and [::1] in ${tries} tries`)
}

function refuseRoot(verb) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error(`asight collector ${verb}: run it as the user whose agents you capture, not as root (D36)`)
}

// onPlan(list) is called once with every file install will write or change, BEFORE anything is written (4.6, user
// 2026-10-06: 安装 MUST 先列出要改的每个文件,再动手). A first plan without the CA's certificate has the same paths
// (the certificate only fills the trust files' contents) and runs every refusal first, so a refused plan writes
// nothing at all, not even the manifest.
// A failed install or uninstall step is recorded where status finds it (D38) — when the collector directory exists;
// otherwise (nothing installed, or refused as root) the command's own output is the only report.
async function recorded(dir, where, fn) {
  try { return await fn() } catch (e) {
    try { if (fs.existsSync(dir)) appendEvent(dir, { event: 'failure', where, reason: String((e && e.message) || e) }) } catch (w) {
      if (e && typeof e === 'object') e.message += ` (and recording this failure failed: ${String((w && w.message) || w)})` // never mask the original
    }
    throw e
  }
}

export async function installCollector({ home = os.homedir(), ...opts } = {}) {
  refuseRoot('install')
  const dir = collectorHome(path.join(home, '.asight')) // collectorHome takes the asight home
  return recorded(dir, 'install', () => install(dir, { home, ...opts }))
}

async function install(dir, { home, env = process.env, osName, harnesses, scan = async () => [], match = () => ({ agent: null }), freePort = freeEnginePort, onPlan = () => {} }) {
  const prior = readManifest(dir)
  if (prior && prior.complete) return { already: true, manifest: prior, plan: null }
  if (prior) throw new Error(`an earlier install did not finish (${manifestPath(dir)}); run "asight collector uninstall" first`)
  const ca = caPaths(path.join(dir, 'ca'))
  const facts = await scan()
  const envMap = new Map(Object.entries(env).filter(([, v]) => typeof v === 'string'))
  const ctxFor = (d) => ({
    os: osName, home, env: envMap, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()),
    readText: (f) => readText(f), listDir, collectorDir: dir, caPem: ca.pem,
  })
  const draft = planTrust({ descriptors: harnesses, ctxFor, caCertPem: null, collectorDir: dir })
  // every per-file refusal too (a dangling link, a file that is not JSON) — before onPlan, before any write
  const preview = draft.entries.map((e) => previewJsonKey({ file: e.path, keys: e.keys, value: e.value }))
  onPlan({
    manifest: manifestPath(dir),
    ca: [ca.key, ca.pem],
    files: draft.files.map((f) => ({ harness: f.harness, path: f.path, sources: f.sources })),
    entries: draft.entries.map((e, i) => ({ harness: e.harness, path: e.path, ...(preview[i].real_path ? { real_path: preview[i].real_path } : {}), keys: e.keys, value: e.value })),
    notes: draft.notes,
  })

  const m = newManifest()
  m.dirs = missingDirs(dir)
  m.dirs.push(...missingDirs(ca.dir).filter((d) => !m.dirs.includes(d)))
  m.files.push({ path: ca.key, role: 'ca-key' }, { path: ca.pem, role: 'ca-cert' })
  saveManifest(dir, m) // creates dir 0700; the CA is listed before it is minted
  const { certPem } = loadOrCreateCa({ dir: ca.dir })
  m.engine_port = await freePort()
  const plan = planTrust({ descriptors: harnesses, ctxFor, caCertPem: certPem, collectorDir: dir })
  if (JSON.stringify(plan.paths) !== JSON.stringify(draft.paths)) throw new Error(`the files to change moved while installing (${draft.paths.join(', ')} → ${plan.paths.join(', ')}); only the CA was written; run "asight collector uninstall", then install again`)
  m.planned = plan.paths
  saveManifest(dir, m)
  for (const f of plan.files) writeOwnedFile({ dir, manifest: m, harness: f.harness, role: 'trust-file', file: f.path, data: f.data, sources: f.sources })
  for (const e of plan.entries) applyJsonKey({ dir, manifest: m, harness: e.harness, file: e.path, keys: e.keys, value: e.value })
  m.complete = true
  saveManifest(dir, m)
  return { already: false, manifest: m, plan }
}

// 4.6 §安装清单与卸载 step 1: stop this user's daemon and wait until it AND its helper are gone (the helper's
// links are unpinned and go with it). The daemon is looked for at the runtime socket and at the socket its lock
// names (XDG_RUNTIME_DIR unset, or logind removed /run/user/<uid>): a daemon that steers must never be orphaned.
// A lock whose pid is dead is stale: never kill by it. A live pid that answers on no socket is not killed either
// (it may be another program by now): uninstall stops with nothing removed and says what to do.
export async function stopDaemon({ socketPath, lockFile, request = controlRequest, alive = pidAlive, kill = process.kill.bind(process), timeoutMs = 5000 }) {
  let lock = null
  let unreadable = false // a lock cut short by a crash or power loss: whether a daemon runs is unknown
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') unreadable = true }
  let answered = false
  for (const sock of [...new Set([socketPath, lock && lock.socket].filter(Boolean))]) {
    try { await request({ socketPath: sock, method: 'GET', path: '/status', timeoutMs: 2000 }); answered = true; break } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') throw e
    }
  }
  if (!answered) {
    if (unreadable) throw new Error(`${lockFile} is unreadable, so whether a collector daemon still runs is unknown; stop any (pgrep -f "asight collector start"), delete ${lockFile}, then run uninstall again; nothing was removed`)
    if (lock && lock.pid && alive(lock.pid)) throw new Error(`a collector daemon may still be running (pid ${lock.pid} in ${lockFile}) but answers on no control socket; stop it (kill ${lock.pid}), or delete ${lockFile} if that pid is not an asight collector, then run uninstall again; nothing was removed`)
    return 'none'
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

export async function uninstallCollector({ home = os.homedir(), ...opts } = {}) {
  refuseRoot('uninstall')
  const dir = collectorHome(path.join(home, '.asight')) // collectorHome takes the asight home
  return recorded(dir, 'uninstall', () => uninstall(dir, { home, ...opts }))
}

async function uninstall(dir, { env = process.env, purgeData = false, scan = async () => [], match = () => ({ agent: null }), stop = null }) {
  const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'asight') : null
  const report = { daemon: null, entries: [], removed: [], still_trusting: [], kept_captures: !purgeData, notes: [] }
  const failed = []
  report.daemon = await (stop || (() => stopDaemon({ socketPath: runtime && path.join(runtime, 'collector.sock'), lockFile: path.join(dir, 'lock') })))()
  const m = readManifest(dir)
  const rm = (p) => { sweepTemps(p); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); report.removed.push(p) } }
  if (!m) report.notes.push('nothing is installed for this user')
  else {
    // trust entries, newest first (4.6 撤销顺序 step 1), then the append-semantics trust files (step 3)
    for (const e of [...m.entries].reverse()) {
      const r = undoEntry(e)
      report.entries.push(r)
      // asight's key may still be in a file it could not undo: the user has to look (D38); written after any purge
      if (r.result === 'left-unparsable') failed.push(`${e.path} is no longer valid JSON; asight's ${e.keys.join('.')} = ${e.value} may still be in it`)
      if (r.result === 'left-link') failed.push(r.reason)
    }
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
  for (const reason of failed) { // after the purge, so --purge-data never deletes what this run could not undo
    try { appendEvent(dir, { event: 'failure', where: 'uninstall', reason }) } catch (w) { report.notes.push(`not recorded (${String((w && w.message) || w)}): ${reason}`) }
  }
  if (m) {
    removeEmptyDirs(m.dirs.filter((d) => d !== dir)) // e.g. ca/
    fs.rmSync(manifestPath(dir), { force: true }) // the manifest goes last: a second run still finds what the first left
    sweepTemps(manifestPath(dir))
    removeEmptyDirs(m.dirs)
  } else if (purgeData) removeEmptyDirs([dir])
  return report
}
