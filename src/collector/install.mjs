// install.mjs — per-user `asight collector install|uninstall` (RFC 4.6 §安装清单与卸载, §身份与信任「信任注入」,
// D36, D37④; acceptance S10, T10, T11). No sudo: everything lives under the operator's ~/.asight/collector and in
// the agents' own config entries; the machine-wide helper is `asight setup-helper` (arch). Nothing here knows a
// harness or an OS: the descriptors declare their entries (`inject`), the caller passes `scan` / `match` (the
// process table) from daemon.mjs. Install lists every file before touching one; uninstall undoes only what the
// manifest lists, keeps captures unless purgeData, and is safe to run twice or after a crashed install.
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import { collectorHome } from '../paths.mjs'
import { loadOrCreateCa, caPaths, readCa } from './core/tls/ca-store.mjs'
import { checkCa } from './core/tls/ca.mjs'
import { planTrust } from './core/trust/plan.mjs'
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, previewJsonKey, applyTextEntry, previewTextEntry, writeOwnedFile, removeOwnedFile, undoEntry, removeEmptyDirs, manifestPath, sweepTemps, describeEntry } from './core/trust/journal.mjs'
import { EVENT, CODE, UNTIL_TEXT } from './core/codes.mjs'
import { rewriteBundles } from './core/trust/bundle.mjs'
import { controlRequest } from './core/control.mjs'
import { readText, readTextOrError } from './core/config-read.mjs'
import { appendEvent } from './core/events.mjs'
import { lockState, procIdentity } from '../health/read.mjs'

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
// `run` (this run's start time) is on every line one install or uninstall writes, and each run ends with one
// `kind:'result'` note — a failed one too — so the board's "last install / uninstall" is the newest run's lines,
// never an older run's warnings after a clean run (4.6 安装 / 卸载不静默, review D1-5).
async function recorded(dir, where, fn) {
  const run = new Date().toISOString()
  try { return await fn(run) } catch (e) {
    const reason = String((e && e.message) || e)
    try {
      if (fs.existsSync(dir)) {
        appendEvent(dir, { event: 'failure', where, code: (e && e.code) || `${where}-error`, reason, run })
        appendEvent(dir, { event: `${where}-note`, kind: 'result', outcome: 'failed', run, reason: `${where} failed: ${reason}` })
      }
    } catch (w) {
      if (e && typeof e === 'object') e.message += ` (and recording this failure failed: ${String((w && w.message) || w)})` // never mask the original
    }
    throw e
  }
}

export async function installCollector({ home = os.homedir(), ...opts } = {}) {
  refuseRoot('install')
  const dir = collectorHome(path.join(home, '.asight')) // collectorHome takes the asight home
  return recorded(dir, 'install', (run) => install(dir, { home, ...opts, run }))
}

// The roots a combined bundle starts from (4.6 「合并包」): Node's own, and the OS bundle the arch names.
export function readRoots(osRootsFile, { nodeRoots = tls.rootCertificates } = {}) {
  let osText = ''
  if (osRootsFile) { try { osText = fs.readFileSync(osRootsFile, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } }
  return { node: [...nodeRoots], osText }
}

// 4.6 §引擎 5: the engine checks an upstream with Node's roots + NODE_EXTRA_CA_CERTS of the daemon's own environment. A
// daemon the autostart unit starts has no login shell's exports, so the unit carries this shell's value — an absolute
// path outside asight's home only; anything else is said, never dropped silently (review 3 #1, D38).
export function daemonEnv(env, dir) {
  const v = env.NODE_EXTRA_CA_CERTS
  if (typeof v !== 'string' || v === '') return { env: {}, note: null }
  const why = !path.isAbsolute(v) ? 'it is a relative path' : v.startsWith(path.dirname(dir) + path.sep) ? "it is asight's own file" : null
  if (why) return { env: {}, note: `NODE_EXTRA_CA_CERTS of this shell (${v}) is not given to the autostart unit (${why}); a daemon the unit starts checks a relay's certificate with Node's roots only` }
  return { env: { NODE_EXTRA_CA_CERTS: v }, note: null }
}

// unit: the arch's per-user autostart unit as { path, links, text(env), enable, disable, stop, removeWants } (null: none /
// --no-unit); links = what enabling it creates.
async function install(dir, { home, env = process.env, osName, harnesses, scan = async () => [], match = () => ({ agent: null }), freePort = freeEnginePort, onPlan = () => {}, osRootsFile = null, roots = null, unit = null, run = null }) {
  const prior = readManifest(dir)
  if (prior && prior.complete) {
    // installed — but "already installed" only when its CA is usable (D-4): a CA that cannot be read or used is said
    const c = readCa({ dir: path.join(dir, 'ca') })
    const st = c.error ? { ok: false, which: c.which, reason: c.error } : checkCa(c)
    if (!st.ok) throw Object.assign(new Error(`the collector is installed, but its CA is unusable (${st.which}: ${st.reason}); run "asight collector uninstall", then "asight collector install"`), { code: 'ca-invalid' })
    return { already: true, manifest: prior, plan: null }
  }
  if (prior && prior.pending_bundles) throw new Error(`an earlier uninstall kept combined bundles that running agents still use (${prior.files.filter((f) => f.role === 'bundle').map((f) => f.path).join(', ')}); run "asight collector uninstall" again once they exit`)
  if (prior && prior.uninstall_left) throw new Error(`an earlier uninstall could not undo ${prior.uninstall_left.length} item(s) (${prior.uninstall_left.map((l) => l.path).join(', ')}); fix them, run "asight collector uninstall" again, then install`)
  if (prior) throw new Error(`an earlier install did not finish (${manifestPath(dir)}); run "asight collector uninstall" first`)
  const ca = caPaths(path.join(dir, 'ca'))
  const facts = await scan()
  const envMap = new Map(Object.entries(env).filter(([, v]) => typeof v === 'string'))
  const ctxFor = (d) => ({
    os: osName, home, env: envMap, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()),
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir, collectorDir: dir, caPem: ca.pem,
  })
  const R = roots || readRoots(osRootsFile)
  const draft = planTrust({ descriptors: harnesses, ctxFor, caCertPem: null, collectorDir: dir, roots: R })
  // every per-file refusal too (a dangling link, a file that is not JSON, a patch file that is not a list, a plugin
  // file already there) — before onPlan, before any write
  const daemon = unit ? daemonEnv(env, dir) : null
  if (daemon && daemon.note) draft.notes.push(daemon.note)
  const preview = draft.entries.map((e) => (e.kind === 'text' ? previewTextEntry({ file: e.path, edit: e }) : previewJsonKey({ file: e.path, keys: e.keys, value: e.value })))
  for (const o of draft.owned) if (fs.existsSync(o.path)) throw new Error(`${o.harness}: ${o.path} already exists; asight will not write over it (left by an earlier install whose manifest is gone? remove it, then install again)`)
  if (unit && fs.existsSync(unit.path)) throw new Error(`${unit.path} already exists; asight will not write over it (left by an earlier install whose manifest is gone? remove it, then install again)`) // before anything is written (review 4 #7)
  onPlan({
    manifest: manifestPath(dir),
    ca: [ca.key, ca.pem],
    files: draft.files.map((f) => ({ harness: f.harness, path: f.path, sources: f.sources })),
    owned: draft.owned.map((o) => ({ harness: o.harness, path: o.path, role: o.role })),
    entries: draft.entries.map((e, i) => ({ harness: e.harness, path: e.path, ...(preview[i].real_path ? { real_path: preview[i].real_path } : {}), ...(e.kind === 'text' ? { what: describeEntry(e) } : { keys: e.keys, value: e.value }) })),
    ...(unit ? { unit: { path: unit.path, env: daemon.env, links: unit.links || [] } } : {}),
    watch: draft.watch,
    notes: draft.notes,
    records: path.join(dir, 'flows'), // install notes are kept here as install-note events (D38)
    events: path.join(dir, 'flows', `${new Date().toISOString().slice(0, 10)}.ndjson`), // install-note lines are appended here (D-28)
  })

  const m = newManifest()
  m.dirs = missingDirs(dir)
  m.dirs.push(...missingDirs(ca.dir).filter((d) => !m.dirs.includes(d)))
  m.files.push({ path: ca.key, role: 'ca-key' }, { path: ca.pem, role: 'ca-cert' })
  saveManifest(dir, m) // creates dir 0700; the CA is listed before it is minted
  const { certPem } = loadOrCreateCa({ dir: ca.dir })
  m.engine_port = await freePort()
  const plan = planTrust({ descriptors: harnesses, ctxFor, caCertPem: certPem, collectorDir: dir, roots: R })
  if (daemon && daemon.note) { plan.notes.push(daemon.note); plan.records.push({ code: CODE.unitEnvNotCarried, reason: daemon.note }) }
  if (JSON.stringify(plan.paths) !== JSON.stringify(draft.paths)) throw new Error(`the files to change moved while installing (${draft.paths.join(', ')} → ${plan.paths.join(', ')}); only the CA was written; run "asight collector uninstall", then install again`)
  m.planned = plan.paths
  m.watched = plan.watch.map((w) => ({ ...w, existed_before: fs.existsSync(w.path) })) // before anything of the plan is written
  saveManifest(dir, m)
  fs.mkdirSync(path.join(dir, 'run', 'trust'), { recursive: true, mode: 0o700 }) // plugins write their marker here, daemon up or not
  for (const f of plan.files) writeOwnedFile({ dir, manifest: m, harness: f.harness, role: f.role, file: f.path, data: f.data, sources: f.sources, extra: f.role === 'bundle' ? { user_fps: f.user_fps, roots_fp: f.roots_fp } : {} })
  // a plugin or shim exists before the entry that loads it (a dsh patch row naming a missing file only warns, still)
  for (const o of plan.owned) writeOwnedFile({ dir, manifest: m, harness: o.harness, role: o.role, file: o.path, data: o.data, mode: o.mode, exclusive: true })
  for (const e of plan.entries) {
    if (e.kind === 'text') applyTextEntry({ dir, manifest: m, harness: e.harness, file: e.path, edit: e })
    else applyJsonKey({ dir, manifest: m, harness: e.harness, file: e.path, keys: e.keys, value: e.value })
  }
  // the per-user autostart unit (arch: systemd --user on Linux), listed like every other file, then enabled --now; a
  // refused enable is recorded (D38), the daemon can still be started by hand
  // The manifest is complete before the unit starts the daemon, which refuses an incomplete one (review 3 #8).
  if (unit) writeOwnedFile({ dir, manifest: m, role: 'unit', file: unit.path, data: unit.text(daemon.env), mode: 0o644, exclusive: true })
  m.complete = true
  saveManifest(dir, m)
  let unitFailed = null
  if (unit) {
    const r = unit.enable()
    if (r.code !== 0) unitFailed = `${unit.path} is written but "systemctl --user enable --now" failed (${r.err || `exit ${r.code}`}); start the daemon with "asight collector start", or enable the unit once systemd --user runs`
  }
  // 4.6 安装 / 卸载不静默 (D-28): everything the command prints is also an install-note in flows/, for the board, where
  // status finds it; a line that cannot be written is added to the printed notes, never dropped, and never fails the install
  const put = (rec) => { try { appendEvent(dir, { ...rec, run }) } catch (w) { plan.notes.push(`not recorded (${String((w && w.message) || w)}): ${rec.reason}`) } }
  for (const e of m.entries.filter((x) => x.prior_value)) {
    const prior = e.keys ? `${e.path} ${e.keys.join('.')} was ${e.prior_value}; it now points at ${e.value}` : `${e.path} held ${Object.entries(e.prior_value).map(([k, v]) => `${k}=${v}`).join(', ')}; asight commented it out (uninstall restores it)`
    put({ event: EVENT.installNote, where: 'install', kind: 'prior-value', harness: e.harness, path: e.path, reason: prior })
  }
  for (const r of plan.records) put({ event: EVENT.installNote, where: 'install', kind: 'note', ...r })
  if (unitFailed) { plan.notes.push(unitFailed); put({ event: EVENT.failure, where: 'install', code: CODE.unitNotEnabled, reason: unitFailed }) }
  const counts = { entries: m.entries.length, files: m.files.filter((f) => f.role === 'trust-file').length, notes: plan.notes.length }
  put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome: 'installed', counts, reason: `installed: ${counts.entries} trust entr${counts.entries === 1 ? 'y' : 'ies'} and ${counts.files} trust file(s) written, ${counts.notes} note(s)` })
  return { already: false, manifest: m, plan }
}

// 4.6 §安装清单与卸载 step 1: stop this user's daemon and wait until it AND its helper are gone (the helper's
// links are unpinned and go with it). The daemon is looked for at the runtime socket and at the socket its lock
// names (XDG_RUNTIME_DIR unset, or logind removed /run/user/<uid>): a daemon that steers must never be orphaned.
// A lock whose daemon is gone (pid dead, or its start time / boot id is another process's: D-25) is stale: never
// kill by it. A live daemon that answers on no socket is not killed either: uninstall stops with nothing removed
// and says what to do.
export async function stopDaemon({ socketPath, lockFile, request = controlRequest, alive = pidAlive, identity = procIdentity, kill = process.kill.bind(process), stopUnit = null, timeoutMs = 5000 }) {
  const ls = lockState({ file: lockFile, alive, identity })
  const lock = ls.lock || null
  const unreadable = ls.state === 'unknown' // a lock cut short by a crash or power loss: whether a daemon runs is unknown
  let answered = false
  for (const sock of [...new Set([socketPath, lock && lock.socket].filter(Boolean))]) {
    try { await request({ socketPath: sock, method: 'GET', path: '/status', timeoutMs: 2000 }); answered = true; break } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') throw e
    }
  }
  if (!answered) {
    if (unreadable) throw new Error(`${lockFile} is unreadable, so whether a collector daemon still runs is unknown; stop any (pgrep -f "asight collector start"), delete ${lockFile}, then run uninstall again; nothing was removed`)
    if (ls.state === 'running' || ls.state === 'unresponsive') throw new Error(`a collector daemon may still be running (pid ${lock.pid} in ${lockFile}${ls.state === 'unresponsive' ? `, lock not refreshed for ${Math.round(ls.age_ms / 1000)} s` : ''}) but answers on no control socket; stop it (kill ${lock.pid}), or delete ${lockFile} if that pid is not an asight collector, then run uninstall again; nothing was removed`)
    return 'none'
  }
  if (!lock || !lock.pid) throw new Error('a collector daemon answers but left no lock file; stop it by hand, nothing was removed')
  if (ls.state === 'stale') throw new Error(`a collector daemon answers, but ${lockFile} names a process that is not it (${ls.why}); stop the daemon by hand (pgrep -f "asight collector start"), nothing was removed`) // never kill a reused pid
  if (stopUnit) stopUnit() // a unit-managed daemon is stopped through systemd, which then knows it is meant to be down
  if (alive(lock.pid)) kill(lock.pid, 'SIGTERM') // no unit, or this daemon was started by hand (`asight collector start`)
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
  return recorded(dir, 'uninstall', (run) => uninstall(dir, { home, ...opts, run }))
}

// 4.6 撤销顺序: (1) the config entries (JSON keys, dotenv blocks) → (2) combined bundles → (3) asight-ca.pem and the
// append trust files → (4) launch shims, rc lines, dsh patch rows, plugins (each loading line before the file it
// loads); files an agent wrote because of asight's plugin are reported, never deleted → (5) report running agents,
// restart none. The manifest goes only when everything it lists is undone: an entry uninstall could not undo stays
// in it (D38: recorded, and `asight collector uninstall` exits non-zero) so the next run finds it again.
const stepOf = (e) => (e.kind === 'text' && e.format !== 'dotenv-block' ? 4 : 1)
const NOT_UNDONE = new Set(['left-unparsable', 'left-link', 'error'])

// what each undo result other than a plain restore means for the user (4.6 撤销结果)
const UNDO_NOTE = {
  'already-restored': 'already back as it was before install: nothing to undo',
  'reverted-not-identical': 'asight\'s key was removed, but the file is not byte for byte what it was before install (it was edited since)',
  missing: 'the file is gone: nothing of asight\'s is left in it',
  'left-user-value': 'the key now holds a value the user set: left as it is',
}

// May a live process of `harness` have read asight's entry for it (4.6 撤销顺序 step 2 (a), step 5)? It started after
// that harness's earliest install time (its entries and the files asight owns for it), or the harness re-reads its
// entry while running (`trust.rereadsEntry`: alive is enough), or its start time is unknown.
function mayHaveRead(f, harness, m, byName) {
  const d = byName.get(harness)
  if (d && d.trust && d.trust.rereadsEntry) return true
  const since = Math.min(...[...m.entries, ...m.files].filter((e) => e.harness === harness).map((e) => Date.parse(e.installed_at)).filter(Number.isFinite))
  return f.startedAt == null || !Number.isFinite(since) || f.startedAt >= since
}

// Uninstall step 2 (4.6): has a live process of this uid loaded this bundle? (a) one of the bundle's harness that may
// have read its entry; (b) its environ names the bundle (a child that inherited it). Judged from the manifest and
// the process table only: the daemon is stopped and the entries are undone by now.
function bundleUsers(bundle, m, procs, match, byName) {
  const pids = []
  for (const f of procs) {
    let env = null
    try { env = f.env } catch { /* gone, or not ours to read */ }
    const inherited = env && [...env.values()].some((v) => typeof v === 'string' && v.includes(bundle.path))
    const own = match(f).agent === bundle.harness && mayHaveRead(f, bundle.harness, m, byName)
    if (own || inherited) pids.push(f.pid)
  }
  return pids
}

async function uninstall(dir, { env = process.env, purgeData = false, scan = async () => [], match = () => ({ agent: null }), stop = null, harnesses = [], osRootsFile = null, roots = null, unit = null, run = null }) {
  const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'asight') : null
  const report = { daemon: null, entries: [], removed: [], residue: [], kept_bundles: [], still_trusting: [], kept_captures: !purgeData, notes: [], left: [] } // left: what could not be undone, {path, harness, result} each (D-18)
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const failed = [] // failure events, written after any purge so they survive it
  const noted = [] // uninstall-note events (kept captures only: --purge-data asked for flows/ to go)
  const m = readManifest(dir)
  const unitFile = m && m.files.find((f) => f.role === 'unit')
  report.daemon = await (stop || (() => stopDaemon({ socketPath: runtime && path.join(runtime, 'collector.sock'), lockFile: path.join(dir, 'lock'), stopUnit: unitFile && unit ? () => unit.stop() : null })))()
  const rm = (p) => { sweepTemps(p); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); report.removed.push(p) } }
  const left = { entries: [], files: [], bundles: [] }
  if (!m) report.notes.push('nothing is installed for this user')
  else {
    const undo = (e) => {
      let r
      try { r = undoEntry(e) } catch (err) { r = { path: e.path, harness: e.harness, result: 'error', reason: String((err && err.message) || err) } }
      report.entries.push(r)
      if (NOT_UNDONE.has(r.result)) {
        left.entries.push(e)
        report.left.push({ path: e.path, harness: e.harness, result: r.result })
        const why = r.result === 'left-unparsable' ? `${e.path} is no longer valid JSON; asight's ${describeEntry(e)} may still be in it` : r.reason
        failed.push({ code: r.result === 'error' ? CODE.entryNotUndone : r.result, harness: e.harness, path: e.path, reason: why }) // left-unparsable / left-link are D38 codes
      } else if (r.result === 'reverted-not-identical') noted.push({ code: CODE.notIdentical, harness: e.harness, path: e.path, reason: `${e.path} was edited after install: only asight's ${describeEntry(e)} was taken out${r.deleted ? ' and the file, holding nothing else, removed' : ''}; the file is not byte for byte what it was before install, the rest is as the user left it` })
      else if (r.result !== 'restored') noted.push({ code: r.result, harness: e.harness, path: e.path, reason: UNDO_NOTE[r.result] || r.result }) // already-restored, missing, left-user-value
    }
    for (const e of [...m.entries].reverse()) if (stepOf(e) === 1) undo(e)
    // step 2: every combined bundle becomes the same file without the asight CA, so a process still holding it keeps
    // reaching its own relay; one a live process may have loaded stays (reported), the next uninstall judges again
    const bundles = m.files.filter((x) => x.role === 'bundle')
    const procs = bundles.length ? await scan() : []
    // a bundle that is there but cannot be read (or written) was NOT rewritten: it still holds the asight CA, so when a live
    // process may have loaded it that is an item that could not be undone — a failure, exit non-zero, the manifest kept —
    // never "kept, without the asight CA" (D38; 4.6 安装 / 卸载不静默). One nobody holds is removed all the same.
    const rewrite = { rebuilt: [], failed: [] }
    if (bundles.length) { const R = roots || readRoots(osRootsFile); rewriteBundles({ dir, manifest: m, nodeRoots: R.node, osRootsText: R.osText, withCa: false, report: rewrite }) }
    const notRewritten = new Map(rewrite.failed.map((x) => [x.path, x.error]))
    for (const b of bundles) {
      const pids = bundleUsers(b, m, procs, match, byName)
      if (!pids.length) { rm(b.path); continue }
      left.bundles.push(b)
      const why = notRewritten.has(b.path) ? String((notRewritten.get(b.path) && (notRewritten.get(b.path).code || notRewritten.get(b.path).message)) || notRewritten.get(b.path)) : null
      report.kept_bundles.push({ path: b.path, harness: b.harness, pids, ...(why ? { holds_ca: true, error: why } : {}) })
      if (why) {
        report.left.push({ path: b.path, harness: b.harness, result: 'error' })
        failed.push({ code: CODE.entryNotUndone, harness: b.harness, path: b.path, reason: `${b.path} still holds the asight CA: it could not be rewritten without it (${why}), and a running process may have loaded it (pid ${pids.join(', ')}); it is kept as it is — fix the file, then run uninstall again` })
      } else noted.push({ code: CODE.bundleKept, harness: b.harness, path: b.path, reason: `${b.path} is kept, without the asight CA, for running processes that may have loaded it (pid ${pids.join(', ')}); run uninstall again once they exit` })
    }
    for (const f of m.files.filter((x) => x.role === 'trust-file' || x.role === 'ca-cert')) rm(f.path)
    for (const e of [...m.entries].reverse()) if (stepOf(e) === 4) undo(e)
    for (const f of [...m.files].reverse().filter((x) => x.role === 'plugin' || x.role === 'shim')) {
      try {
        const r = removeOwnedFile(f)
        if (r.result === 'removed') report.removed.push(f.path)
        if (r.changed) noted.push({ code: CODE.harnessNote, harness: f.harness, path: f.path, reason: `${f.path}, asight's ${f.role}, had been changed since install; it was removed all the same` })
      } catch (err) {
        left.files.push(f); report.left.push({ path: f.path, harness: f.harness, result: 'error' })
        failed.push({ code: CODE.entryNotUndone, harness: f.harness, path: f.path, reason: `${f.path}, asight's ${f.role}, could not be removed: ${String((err && err.message) || err)}` })
      }
    }
    for (const w of m.watched || []) {
      if (w.existed_before || !fs.existsSync(w.path)) continue
      report.residue.push(w.path)
      noted.push({ code: CODE.residue, harness: w.harness, path: w.path, reason: `${w.path} appeared after install (${w.why}); it may serve the user's own plugins too, so asight did not remove it` })
    }
    // step 5: report, never restart — only a process that may have read the entry; until: 'restart' (read at start: CC,
    // Kimi shim, plugins), or what the descriptor says of this process (a function of its facts; null: it never read
    // asight's entry, e.g. a kimi not started through the shim); each one is kept as an uninstall-note (review 3 #6)
    const injected = new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))
    for (const f of await scan()) {
      const a = match(f).agent
      if (!a || !injected.has(a) || !mayHaveRead(f, a, m, byName)) continue
      const au = (byName.get(a) || {}).trust?.afterUninstall
      const until = typeof au === 'function' ? au(f, { collectorDir: dir, readText, home: env.HOME || os.homedir() }) : (au || 'restart')
      if (!until) continue
      report.still_trusting.push({ pid: f.pid, agent: a, until })
      noted.push({ code: CODE.stillTrusting, harness: a, pid: f.pid, reason: `pid ${f.pid} (${a}) trusts the asight CA ${UNTIL_TEXT[until] || UNTIL_TEXT.restart}` })
    }
    // the autostart unit (4.6 order: after the trust entries, before the CA key): disabled, removed, its wants/ links
    if (unitFile) {
      if (unit) { const r = unit.disable(); if (r && r.code !== 0) failed.push({ code: CODE.unitNotDisabled, path: unitFile.path, reason: `systemctl --user disable failed (${r.err || `exit ${r.code}`}); the unit file is removed all the same, run "systemctl --user daemon-reload" once systemd --user runs` }) }
      try { if (removeOwnedFile(unitFile).result === 'removed') report.removed.push(unitFile.path) } catch (err) { left.files.push(unitFile); report.left.push({ path: unitFile.path, harness: unitFile.harness || null, result: 'error' }); failed.push({ code: CODE.entryNotUndone, path: unitFile.path, reason: `${unitFile.path} could not be removed: ${String((err && err.message) || err)}` }) }
      if (unit) report.removed.push(...unit.removeWants((p, err) => failed.push({ code: CODE.unitNotDisabled, path: p, reason: `${p}, the autostart link, could not be removed: ${String((err && err.message) || err)}` })))
    }
    // the CA private key and the runtime state (with the trust markers) last
    for (const f of m.files.filter((x) => x.role === 'ca-key')) rm(f.path)
    for (const p of [path.join(dir, 'run'), path.join(dir, 'lock'), path.join(dir, 'state.json'), runtime]) if (p) rm(p)
  }
  for (const n of noted) report.notes.push(n.reason) // the command prints every one of them
  // then the data the operator asked to drop — also after an earlier plain uninstall left the captures behind
  if (purgeData) {
    for (const n of listDir(dir)) if (/^capture-.*\.ndjson$/.test(n)) rm(path.join(dir, n))
    for (const sub of ['flows', 'audit', 'replays']) rm(path.join(dir, sub))
  }
  // after the purge, so --purge-data never deletes what this run could not undo; a line that cannot be written is
  // said in the command's output (and so on stderr's caller), never dropped, and never stops the uninstall
  const put = (rec) => { try { appendEvent(dir, { ...rec, run }) } catch (w) { report.notes.push(`not recorded (${String((w && w.message) || w)}): ${rec.reason}`) } }
  for (const f of failed) put({ event: EVENT.failure, where: 'uninstall', ...f })
  // notes too — except after --purge-data that left nothing: the operator asked for an empty collector directory, and the
  // command's output has every one of them (4.6 安装 / 卸载不静默)
  if (m && !(purgeData && !report.left.length)) {
    for (const n of noted) put({ event: EVENT.uninstallNote, where: 'uninstall', kind: n.code, ...n })
    const counts = { entries: report.entries.length, left: report.left.length, still_trusting: report.still_trusting.length, notes: noted.length }
    put({ event: EVENT.uninstallNote, where: 'uninstall', kind: 'result', outcome: counts.left ? 'left' : 'uninstalled', counts,
      reason: counts.left ? `uninstalled, except ${counts.left} item(s) that could not be undone; the install manifest is kept` : `uninstalled: ${counts.entries} trust entr${counts.entries === 1 ? 'y' : 'ies'} undone, ${counts.notes} note(s)` })
  }
  if (m) {
    if (report.left.length || left.bundles.length) { // keep exactly what is left; the next uninstall finds it (4.6: the manifest goes last)
      saveManifest(dir, { ...m, complete: false, ...(report.left.length ? { uninstall_left: report.left, uninstalled_at: new Date().toISOString() } : {}), ...(left.bundles.length ? { pending_bundles: true } : {}), planned: [], watched: [], entries: left.entries, files: [...left.files, ...left.bundles] })
      return report
    }
    removeEmptyDirs(m.dirs.filter((d) => d !== dir)) // e.g. ca/
    fs.rmSync(manifestPath(dir), { force: true }) // the manifest goes last: a second run still finds what the first left
    sweepTemps(manifestPath(dir))
    removeEmptyDirs(m.dirs)
  } else if (purgeData) removeEmptyDirs([dir])
  return report
}
