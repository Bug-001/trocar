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
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, previewJsonKey, applyTextEntry, previewTextEntry, writeOwnedFile, removeOwnedFile, undoEntry, removeEmptyDirs, manifestPath, sweepTemps, describeEntry } from './core/trust/journal.mjs'
import { EVENT, CODE } from './core/codes.mjs'
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
  if (prior && prior.uninstall_left) throw new Error(`an earlier uninstall left entries it could not undo (${manifestPath(dir)}); fix what it reported, then run "asight collector uninstall" again`)
  if (prior) throw new Error(`an earlier install did not finish (${manifestPath(dir)}); run "asight collector uninstall" first`)
  const ca = caPaths(path.join(dir, 'ca'))
  const facts = await scan()
  const envMap = new Map(Object.entries(env).filter(([, v]) => typeof v === 'string'))
  const ctxFor = (d) => ({
    os: osName, home, env: envMap, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()),
    readText: (f) => readText(f), listDir, collectorDir: dir, caPem: ca.pem,
  })
  const draft = planTrust({ descriptors: harnesses, ctxFor, caCertPem: null, collectorDir: dir })
  // every per-file refusal too (a dangling link, a file that is not JSON, a patch file that is not a list, a plugin
  // file already there) — before onPlan, before any write
  const preview = draft.entries.map((e) => (e.kind === 'text' ? previewTextEntry({ file: e.path, edit: e }) : previewJsonKey({ file: e.path, keys: e.keys, value: e.value })))
  for (const o of draft.owned) if (fs.existsSync(o.path)) throw new Error(`${o.harness}: ${o.path} already exists; asight will not write over it (left by an earlier install whose manifest is gone? remove it, then install again)`)
  onPlan({
    manifest: manifestPath(dir),
    ca: [ca.key, ca.pem],
    files: draft.files.map((f) => ({ harness: f.harness, path: f.path, sources: f.sources })),
    owned: draft.owned.map((o) => ({ harness: o.harness, path: o.path, role: o.role })),
    entries: draft.entries.map((e, i) => ({ harness: e.harness, path: e.path, ...(preview[i].real_path ? { real_path: preview[i].real_path } : {}), ...(e.kind === 'text' ? { what: describeEntry(e) } : { keys: e.keys, value: e.value }) })),
    watch: draft.watch,
    notes: draft.notes,
    records: path.join(dir, 'flows'), // install notes are kept here as install-note events (D38)
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
  m.watched = plan.watch.map((w) => ({ ...w, existed_before: fs.existsSync(w.path) })) // before anything of the plan is written
  saveManifest(dir, m)
  fs.mkdirSync(path.join(dir, 'run', 'trust'), { recursive: true, mode: 0o700 }) // plugins write their marker here, daemon up or not
  for (const f of plan.files) writeOwnedFile({ dir, manifest: m, harness: f.harness, role: 'trust-file', file: f.path, data: f.data, sources: f.sources })
  // a plugin or shim exists before the entry that loads it (a dsh patch row naming a missing file only warns, still)
  for (const o of plan.owned) writeOwnedFile({ dir, manifest: m, harness: o.harness, role: o.role, file: o.path, data: o.data, mode: o.mode, exclusive: true })
  for (const e of plan.entries) {
    if (e.kind === 'text') applyTextEntry({ dir, manifest: m, harness: e.harness, file: e.path, edit: e })
    else applyJsonKey({ dir, manifest: m, harness: e.harness, file: e.path, keys: e.keys, value: e.value })
  }
  m.complete = true
  saveManifest(dir, m)
  for (const r of plan.records) appendEvent(dir, { event: EVENT.installNote, where: 'install', ...r }) // D38: what install said, kept where status finds it
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

// 4.6 撤销顺序: (1) the config entries (JSON keys, dotenv blocks) → (2) combined bundles → (3) asight-ca.pem and the
// append trust files → (4) launch shims, rc lines, dsh patch rows, plugins (each loading line before the file it
// loads); files an agent wrote because of asight's plugin are reported, never deleted → (5) report running agents,
// restart none. The manifest goes only when everything it lists is undone: an entry uninstall could not undo stays
// in it (D38: recorded, and `asight collector uninstall` exits non-zero) so the next run finds it again.
const stepOf = (e) => (e.kind === 'text' && e.format !== 'dotenv-block' ? 4 : 1)
const NOT_UNDONE = new Set(['left-unparsable', 'left-link', 'error'])

async function uninstall(dir, { env = process.env, purgeData = false, scan = async () => [], match = () => ({ agent: null }), stop = null }) {
  const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'asight') : null
  const report = { daemon: null, entries: [], removed: [], residue: [], still_trusting: [], kept_captures: !purgeData, notes: [], left: 0 }
  const failed = [] // failure events, written after any purge so they survive it
  const noted = [] // uninstall-note events (kept captures only: --purge-data asked for flows/ to go)
  report.daemon = await (stop || (() => stopDaemon({ socketPath: runtime && path.join(runtime, 'collector.sock'), lockFile: path.join(dir, 'lock') })))()
  const m = readManifest(dir)
  const rm = (p) => { sweepTemps(p); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); report.removed.push(p) } }
  const left = { entries: [], files: [] }
  if (!m) report.notes.push('nothing is installed for this user')
  else {
    const undo = (e) => {
      let r
      try { r = undoEntry(e) } catch (err) { r = { path: e.path, harness: e.harness, result: 'error', reason: String((err && err.message) || err) } }
      report.entries.push(r)
      if (NOT_UNDONE.has(r.result)) {
        left.entries.push(e)
        const why = r.result === 'left-unparsable' ? `${e.path} is no longer valid JSON; asight's ${describeEntry(e)} may still be in it` : r.reason
        failed.push({ code: CODE.entryNotUndone, harness: e.harness, path: e.path, reason: why })
      }
      if (r.result === 'reverted-not-identical') noted.push({ code: CODE.notIdentical, harness: e.harness, path: e.path, reason: `${e.path} was edited after install: only asight's ${describeEntry(e)} was taken out${r.deleted ? ' and the file, holding nothing else, removed' : ''}; the rest is as the user left it` })
    }
    for (const e of [...m.entries].reverse()) if (stepOf(e) === 1) undo(e)
    for (const f of m.files.filter((x) => x.role === 'trust-file' || x.role === 'ca-cert')) rm(f.path)
    for (const e of [...m.entries].reverse()) if (stepOf(e) === 4) undo(e)
    for (const f of [...m.files].reverse().filter((x) => x.role === 'plugin' || x.role === 'shim')) {
      try {
        const r = removeOwnedFile(f)
        if (r.result === 'removed') report.removed.push(f.path)
        if (r.changed) noted.push({ code: CODE.harnessNote, harness: f.harness, path: f.path, reason: `${f.path}, asight's ${f.role}, had been changed since install; it was removed all the same` })
      } catch (err) {
        left.files.push(f)
        failed.push({ code: CODE.entryNotUndone, harness: f.harness, path: f.path, reason: `${f.path}, asight's ${f.role}, could not be removed: ${String((err && err.message) || err)}` })
      }
    }
    for (const w of m.watched || []) {
      if (w.existed_before || !fs.existsSync(w.path)) continue
      report.residue.push(w.path)
      noted.push({ code: CODE.residue, harness: w.harness, path: w.path, reason: `${w.path} appeared after install (${w.why}); it may serve the user's own plugins too, so asight did not remove it` })
    }
    // step 5: report, never restart — append-semantics entries are read at start, so these still trust asight
    const injected = new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))
    for (const f of await scan()) { const a = match(f).agent; if (a && injected.has(a)) report.still_trusting.push({ pid: f.pid, agent: a, until: 'restart' }) }
    // the CA private key and the runtime state (with the trust markers) last
    for (const f of m.files.filter((x) => x.role === 'ca-key')) rm(f.path)
    for (const p of [path.join(dir, 'run'), path.join(dir, 'lock'), path.join(dir, 'state.json'), runtime]) if (p) rm(p)
  }
  for (const n of noted) {
    report.notes.push(n.reason)
    if (!purgeData) { try { appendEvent(dir, { event: EVENT.uninstallNote, where: 'uninstall', ...n }) } catch (w) { report.notes.push(`not recorded (${String((w && w.message) || w)}): ${n.reason}`) } }
  }
  // then the data the operator asked to drop — also after an earlier plain uninstall left the captures behind
  if (purgeData) {
    for (const n of listDir(dir)) if (/^capture-.*\.ndjson$/.test(n)) rm(path.join(dir, n))
    for (const sub of ['flows', 'audit', 'replays']) rm(path.join(dir, sub))
  }
  for (const f of failed) { // after the purge, so --purge-data never deletes what this run could not undo
    try { appendEvent(dir, { event: EVENT.failure, where: 'uninstall', ...f }) } catch (w) { report.notes.push(`not recorded (${String((w && w.message) || w)}): ${f.reason}`) }
  }
  if (m) {
    report.left = left.entries.length + left.files.length
    if (report.left) { // keep exactly what is left; the next uninstall finds it (4.6: the manifest goes last)
      saveManifest(dir, { ...m, complete: false, uninstall_left: true, planned: [], watched: [], entries: left.entries, files: left.files })
      return report
    }
    removeEmptyDirs(m.dirs.filter((d) => d !== dir)) // e.g. ca/
    fs.rmSync(manifestPath(dir), { force: true }) // the manifest goes last: a second run still finds what the first left
    sweepTemps(manifestPath(dir))
    removeEmptyDirs(m.dirs)
  } else if (purgeData) removeEmptyDirs([dir])
  return report
}
