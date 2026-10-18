// install.mjs — per-user `asight on` / `asight collector install` (RFC 4.6 §安装清单与卸载, §身份与信任「信任注入」,
// D36, D37④; acceptance S10, T10, T11). No sudo: everything lives under the operator's ~/.asight/collector and in
// the agents' own config entries; the machine-wide helper is `asight setup-helper` (arch). Nothing here knows a
// harness or an OS: the descriptors declare their entries (`inject`), the caller passes `scan` / `match` (the
// process table) from daemon.mjs. Install lists every file before touching one. The way back — `asight off` and
// `asight uninstall` — is src/off/ (the entries, the daemon stop, the lock) and src/cli/uninstall.mjs (1.6 §1.4, R3).
import { isModelOs } from './model-install.mjs' // macOS / Windows: their on is turnOnModel (src/cli/on-model.mjs); this turnOn is Linux's
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { collectorHome } from '../paths.mjs'
import { loadOrCreateCa, caPaths, readCa } from './core/tls/ca-store.mjs'
import { checkCa } from './core/tls/ca.mjs'
import { bundleRoots } from './core/tls/roots.mjs'
import { planTrust } from './core/trust/plan.mjs'
import { livenessOf } from './core/registry.mjs'
import { readAgentList } from '../off/identity.mjs'
import { patternsOf } from '../off/signature.mjs'
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, previewJsonKey, applyTextEntry, previewTextEntry, writeOwnedFile, manifestPath, describeEntry, judgeEntry, judgeOwned, sha256 } from './core/trust/journal.mjs'
import { EVENT, CODE } from './core/codes.mjs'
import { controlRequest, controlEndpointFor } from './core/control.mjs'
import { readText, readTextOrError } from './core/config-read.mjs'
import { appendEvent } from './core/events.mjs'
import { runEventWriter } from '../off/events.mjs'
import { backupDir, opLockFile, standalonePath } from '../off/paths.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { readStateFile, emptyState, setDesired, writeStateAtomic } from '../off/state.mjs'
import { newReceipt, UNDO_LINE } from '../off/schema.mjs'
import { OFF_VERSION, installComplete } from '../off/manifest.mjs'
import { writeStandalone, checkStandalone } from '../off/standalone.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

// 1.6 R3: a manifest of a version this build does not read is never acted on — "already installed", or entries undone by guessing what its
// fields mean. Plain Error: the caller records it as install-error / uninstall-error.
function refuseUnsupported(dir, m) {
  if (m && m.unsupported) throw new Error(`the install manifest ${manifestPath(dir)} is version ${JSON.stringify(m.version)}, which this build does not read (it reads version 3); nothing was changed. Use the asight that wrote it`)
}

function refuseRoot(verb, getuid = processUid) {
  if (getuid() === 0) throw new Error(`asight ${verb === 'on' ? verb : `collector ${verb}`}: run this as your own user, not as root.`)
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

// 4.6 §引擎 5: the engine checks an upstream with Node's roots + NODE_EXTRA_CA_CERTS of the daemon's own environment. A daemon
// nothing but a login entry starts has no login shell's exports, so the entry carries this shell's value — an absolute path
// outside asight's home only; anything else is said, never dropped silently (review 3 #1, D38). A daemon `on` starts directly
// (the fallback when the OS mechanism refuses) is handed exactly the same (ensureDaemonUp → unit.start): without it capture breaks behind a corporate
// MITM relay and nothing says so (review 2026-10-18).
export function daemonEnv(env, dir) {
  const v = env.NODE_EXTRA_CA_CERTS
  if (typeof v !== 'string' || v === '') return { env: {}, note: null }
  const why = !path.isAbsolute(v) ? 'it is a relative path' : v.startsWith(path.dirname(dir) + path.sep) ? "it is asight's own file" : null
  if (why) return { env: {}, note: `NODE_EXTRA_CA_CERTS of this shell (${v}) is not given to the daemon asight starts (${why}); that daemon checks a relay's certificate with Node's roots only` }
  return { env: { NODE_EXTRA_CA_CERTS: v }, note: null }
}

// ── `asight on` (RFC 1.6 §1.6, R6, R9, R12; D39) ────────────────────────────────────────────────────────────────────────────────────────
// `on` is the install: the first one writes the CA, the combined bundles, the entries and the unit; every later one finds what is there and writes
// only what is not. Per planned item the manifest and the disk say which (journal.mjs judgeEntry / judgeOwned): written (new), intact (never
// rewritten — its `installed_at`, inode and mtime stay, or the agents already captured would be judged config-after-start and stop being
// captured), resumed (an intent a crash left), or changed by the user since (reported, left). The order is R9's: what an entry points at (the
// CA, the bundles, plugins, the shim) before the entry, the entries, the unit, and the links last — by the daemon, on `POST /on`.
//   planOn      reads: the plan to print and to judge by (no write, no confirmation)
//   turnOn      the command: plan → confirm → desired state first → write → unit → daemon → receipt
//   installCollector   the install half alone, as the harness and lab tests set an agent up (no state.json, no daemon, no confirmation)

const OP_LOCK_WAIT_MS = 10_000 // 1.6 R12: another state-changing command (an `off`, say) is waited for at most this long
const nodeFs = fs
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const act = (a) => a !== 'skip-intact' && a !== 'skip-user-changed'
const shortLine = (l) => String(l).split(' # ')[0].trim()
const RESTART_REASONS = new Set(['config-after-start', 'env-frozen', 'start-time-unknown', 'no-marker', 'kimi-not-via-shim']) // 「重启后才会被采集」(1.6 §1.1)
const DAEMON_CMD = 'asight daemon' // 1.6 §2: the autostart unit's ExecStart is this command (units written before the rename run its alias `collector start`)
/** The login entry in the platform's own words (a Windows user told to run `systemctl` has been handed nothing; tested on Windows 2026-10-11 and macOS 2026-10-18). */
const entryWords = (osName, unit) => (osName === 'win32' ? 'the scheduled task \\asight\\collector' : osName === 'darwin' ? `the LaunchAgent ${(unit && unit.name) || 'com.asight.collector'}` : 'the systemd user unit asight-collector.service')

/** What the receipt says an entry did, in one phrase — the same words in the dry run (from the preview) and in the real run (from the entry). */
export function changeText(e, prior = null) {
  if (e.kind === 'text') {
    if (e.vars) return `asight block added at the top (${Object.keys(e.vars).join(', ')})${prior ? `; your own ${Object.keys(prior).join(', ')} commented out` : ''}`
    return `one line added (${shortLine(e.line)})`
  }
  return prior != null ? `${(e.keys || []).join('.')} set (was ${prior})` : `${(e.keys || []).join('.')} added`
}

// An error that is not a failure of asight: an `off` asked for while this `on` ran (R12: off wins), or a step that has to stop the run.
const stop = (message) => Object.assign(new Error(message), { stopsRun: true })

/** What `on` would do, read from the disk and the manifest, written nowhere. Refusals come first, so a refused plan writes nothing at all (not even the
 *  manifest): a file that is not JSON, a dangling link, a plugin file already there, a manifest this build cannot read, a CA that cannot be used.
 *  → { first, newPaths, steps, targets, skipped, restart, changed, created, unchanged, manifest, ca, files, owned, entries, unit?, watch, notes,
 *      records, events, _ } — the first fields are what is printed and receipted (`files` / `owned` / `entries` / `unit` only what would be written);
 *  `_` is what the writing needs (the manifest as read, the draft, the roots). `ids`: the harness code ids named, or null for every one found.
 *  The combined bundles' roots are `roots` when given (a test's, an embedder's), else the arch's (tls/roots.mjs bundleRoots: `missing` is said per
 *  bundle by planTrust; a read that fails throws here, before anything is written). */
export async function planOn({ home = os.homedir(), env = process.env, ids = null, osName, harnesses, scan = async () => [], match = () => ({ agent: null }), arch = null, roots = null, unit = null, fs = nodeFs, now = () => new Date() } = {}) {
  const dir = collectorHome(path.join(home, '.asight'))
  let prior
  try { prior = readManifest(dir, fs) } catch (e) { // not written over: it is the only list of what asight changed; `off` has the way back by asight's own marks (R3)
    throw new Error(`the install manifest cannot be read (${String((e && e.message) || e)}); asight on does not write over it. Run "asight off" (it undoes asight's changes by their marks, after a yes, or at once with --yes); if asight on still refuses, the file is damaged and nothing else lists what asight changed: move it aside (mv '${manifestPath(dir)}' '${manifestPath(dir)}.damaged'), then run asight on`)
  }
  refuseUnsupported(dir, prior)
  if (installComplete(prior)) {
    // installed — but only usable when its CA is (D-4): a CA that cannot be read or used is said, with how to start over
    const c = readCa({ dir: path.join(dir, 'ca'), fs })
    const st = c.error ? { ok: false, which: c.which, reason: c.error } : checkCa(c)
    if (!st.ok) throw Object.assign(new Error(`the collector is installed, but its CA is unusable (${st.which}: ${st.reason}); run "asight uninstall", then "asight on"`), { code: 'ca-invalid' })
  }
  if (prior && prior.pending_bundles) throw new Error(`an earlier uninstall kept combined bundles that running agents still use (${prior.files.filter((f) => f.role === 'bundle' || f.role === 'trust-file').map((f) => f.path).join(', ')}); run "asight uninstall" again once they exit`)
  if (prior && prior.uninstall_left) throw new Error(`an earlier uninstall could not undo ${prior.uninstall_left.length} item(s) (${prior.uninstall_left.map((l) => l.path).join(', ')}); fix them, run "asight uninstall" again, then "asight on"`)
  const descs = ids ? harnesses.filter((d) => ids.includes(d.name)) : harnesses
  const ca = caPaths(path.join(dir, 'ca'))
  const facts = await scan()
  const envMap = new Map(Object.entries(env).filter(([, v]) => typeof v === 'string'))
  const ctxFor = (d) => ({
    os: osName, home, env: envMap, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()),
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir, collectorDir: dir, caPem: ca.pem,
  })
  const R = roots || await bundleRoots(arch)
  const draft = planTrust({ descriptors: descs, ctxFor, caCertPem: null, collectorDir: dir, roots: R })
  const daemon = unit ? daemonEnv(env, dir) : null
  if (daemon && daemon.note) draft.notes.push(daemon.note)

  // per item: written, intact, resumed, or changed by the user since (R9)
  const steps = []
  const entryJ = draft.entries.map((e) => {
    const j = judgeEntry({ manifest: prior, planned: e, fs })
    steps.push({ harness: e.harness, path: e.path, kind: 'entry', action: j.action, ...(j.why ? { why: j.why } : {}) })
    return j
  })
  // every per-file refusal too, for what is to be written (a dangling link, a file that is not JSON, a patch file that is not a list) — before onPlan, before any write
  const preview = draft.entries.map((e, i) => (entryJ[i].action !== 'write' ? null : e.kind === 'text' ? previewTextEntry({ file: e.path, edit: e, fs }) : previewJsonKey({ file: e.path, keys: e.keys, value: e.value, fs })))
  const fileJ = draft.files.map((f) => {
    const j = judgeOwned({ manifest: prior, file: f.path, fs })
    steps.push({ harness: f.harness, path: f.path, kind: f.role, action: j.action, ...(j.why ? { why: j.why } : {}) })
    return j
  })
  const ownedJ = draft.owned.map((o) => {
    const j = judgeOwned({ manifest: prior, file: o.path, fs })
    if (j.action === 'write' && fs.existsSync(o.path)) throw new Error(`${o.harness}: ${o.path} already exists; asight will not write over it (left by an earlier install whose manifest is gone? remove it, then install again)`)
    steps.push({ harness: o.harness, path: o.path, kind: o.role, action: j.action, ...(j.why ? { why: j.why } : {}) })
    return j
  })
  const unitJ = unit ? judgeOwned({ manifest: prior, file: unit.path, planned: sha256(Buffer.from(unit.text(daemon.env))), fs }) : null
  if (unitJ && unitJ.action === 'write' && fs.existsSync(unit.path)) throw new Error(`${unit.path} already exists; asight will not write over it (left by an earlier install whose manifest is gone? remove it, then install again)`) // before anything is written (review 4 #7)
  if (unitJ) steps.push({ harness: null, path: unit.path, kind: 'unit', action: unitJ.action, ...(unitJ.why ? { why: unitJ.why } : {}) })

  // who is on, and who has nothing to do here (no entry, no file, not installed before): said, with the descriptor's own reason
  const installed = new Set([...((prior && prior.entries) || []), ...((prior && prior.files) || [])].map((x) => x.harness).filter(Boolean))
  const withItems = new Set([...draft.entries, ...draft.files, ...draft.owned].map((x) => x.harness))
  const targets = descs.map((d) => d.name).filter((n) => withItems.has(n) || installed.has(n))
  const reasonOf = (name) => draft.records.filter((r) => r.harness === name).map((r) => r.reason.replace(`${name}: `, '')).join('; ') || `no ${name} configuration was found on this machine: nothing to change for it`
  const skipped = [
    ...descs.map((d) => d.name).filter((n) => !targets.includes(n)).map((n) => ({ what: n, reason: reasonOf(n) })),
    ...steps.filter((s) => s.action === 'skip-user-changed').map((s) => ({ what: s.path, reason: `${s.why}; run "asight off", then ${isModelOs(osName) ? '"asight on"' : '"asight install" and "asight on"'}, to write it again` })), // D55⑥: off then install writes a certificate item again; on never does (macOS / Windows: turnOnModel)
  ]
  // what is written, and what the user has not yet confirmed (1.6 §1.6: the paths beyond the manifest's `confirmed_paths`; an installed one counts as confirmed)
  const known = new Set([...((prior && prior.confirmed_paths) || []), ...((prior && prior.entries) || []).map((x) => x.path), ...((prior && prior.files) || []).filter((x) => x.role !== 'ca-key' && x.role !== 'ca-cert').map((x) => x.path)])
  const first = known.size === 0
  const newPaths = steps.filter((s) => act(s.action) && s.kind !== 'unit' && !known.has(s.path)).map((s) => s.path)
  const writing = steps.some((s) => act(s.action))
  const touched = new Set(steps.filter((s) => act(s.action) && s.harness).map((s) => s.harness))
  const restart = facts.map((f) => ({ f, agent: match(f).agent })).filter((x) => x.agent && touched.has(x.agent)).map((x) => ({ harness: x.agent, pid: x.f.pid })) // what is running now was started before its entry
  const entryRow = (e, i) => ({ harness: e.harness, path: e.path, ...(preview[i] && preview[i].real_path ? { real_path: preview[i].real_path } : entryJ[i].entry && entryJ[i].entry.real_path ? { real_path: entryJ[i].entry.real_path } : {}), ...(e.kind === 'text' ? { what: describeEntry(e) } : { keys: e.keys, value: e.value }) })
  const day = now().toISOString().slice(0, 10)
  const caNew = !(fs.existsSync(ca.key) && fs.existsSync(ca.pem))
  const runDir = path.join(dir, 'run', 'trust')
  // D46: the daemon's log files the unit's write makes (a dry run names them too — the receipt lists every file the real run writes, V3); once they exist a later on lists none of them
  const logs = unit && typeof unit.logFiles === 'function' ? unit.logFiles().filter((f) => !fs.existsSync(f.path)).map((f) => f.path) : []
  return {
    first, newPaths, steps, targets, skipped, restart, writing, installed: [...installed],
    changed: draft.entries.map((e, i) => ({ e, j: entryJ[i], i })).filter((x) => act(x.j.action)).map((x) => ({ path: x.e.path, change: changeText(x.e, x.j.entry ? x.j.entry.prior_value : preview[x.i].prior), backup: null })),
    created: [...(prior ? [] : [manifestPath(dir)]), ...(caNew ? [ca.key, ca.pem] : []), ...steps.filter((s) => act(s.action) && s.kind !== 'entry').map((s) => s.path), ...logs],
    unchanged: steps.filter((s) => s.action === 'skip-intact').map((s) => s.path),
    // what onPlan prints (formatPlan): every file this run would write or change, and nothing it would leave alone — the manifest only when it is
    // written (the first on, or an on that writes something), the CA only when it is not there yet, the runtime directory only when it is made, the backup
    // directory when a user file is to be changed (R2); turnOn adds `state` (state.json, when it writes it)
    manifest: !prior || writing ? manifestPath(dir) : null,
    ca: caNew ? [ca.key, ca.pem] : [],
    run: fs.existsSync(runDir) || !writing ? null : runDir,
    backups: draft.entries.some((e, i) => act(entryJ[i].action)) ? backupDir(home) : null,
    files: draft.files.filter((f, i) => act(fileJ[i].action)).map((f) => ({ harness: f.harness, path: f.path, sources: f.sources })),
    owned: draft.owned.filter((o, i) => act(ownedJ[i].action)).map((o) => ({ harness: o.harness, path: o.path, role: o.role })),
    entries: draft.entries.map((e, i) => [e, i]).filter(([, i]) => act(entryJ[i].action)).map(([e, i]) => entryRow(e, i)),
    ...(unit && act(unitJ.action) ? { unit: { path: unit.path, env: daemon.env, links: unit.links || [] } } : {}),
    ...(logs.length ? { logs } : {}), // D46: named in the plan's own listing (every file, R3), written by the unit's write step
    watch: draft.watch,
    notes: draft.notes,
    records: path.join(dir, 'flows'), // install notes are kept here as install-note events (D38)
    events: path.join(dir, 'flows', `${day}.ndjson`), // install-note lines are appended here (D-28)
    _: { dir, prior, ca, descs, ctxFor, R, daemon, draft, unit },
  }
}

// A fresh liveness record with the `match` patterns of the one already recorded kept — its `identity`, or the `signature` an older asight wrote (4.6
// 判活快照: united with what is recorded) —: each pattern once (by its JSON text), sorted by it.
export function unitedLiveness(old, fresh) {
  const was = patternsOf(old)
  const prev = was && Array.isArray(was.match) ? was.match : []
  const byText = new Map([...prev, ...fresh.identity.match].map((p) => [JSON.stringify(p), p]))
  const match = [...byText.keys()].sort().map((k) => byText.get(k))
  return { ...fresh, identity: { ...fresh.identity, match } }
}

// The manifest the writing starts from: the one on disk, or — the first time — a new one that lists the directories asight is about to create and
// the CA files before the CA is minted, and is saved at once (so a crash before the first user file leaves a manifest `uninstall` can use).
function openManifest({ dir, plan, now, fs }) {
  const { prior, ca } = plan._
  if (prior) return prior
  const m = newManifest(now())
  m.dirs = missingDirs(dir, fs)
  m.dirs.push(...missingDirs(ca.dir, fs).filter((d) => !m.dirs.includes(d)))
  m.files.push({ path: ca.key, role: 'ca-key', phase: 'install' }, { path: ca.pem, role: 'ca-cert', phase: 'install' })
  saveManifest(dir, m, fs)
  return m
}

// Every write of an `on`, in R9's order. `guard()` runs before each one (R12: it throws when an `off` asked for one of the harnesses in the meantime).
// The manifest is saved only when it changed, so a second `on` on a complete install rewrites nothing. → { manifest, final, written }.
async function writeInstall(args) {
  const written = { entries: [], files: [], owned: [], unit: null, caCreated: false, intact: [], userChanged: [], needInstall: [] }
  try { return await writeInstallSteps(args, written) } catch (e) { if (e && e.stopsRun) e.written = written; throw e } // what was done before the stop is said
}
async function writeInstallSteps({ dir, home, plan, m, osName, harnesses, freePort, now, fs, guard = () => {}, confirmed = false, certs = true }, written) {
  const { ca, descs, ctxFor, R, daemon, draft, unit } = plan._
  const body = () => JSON.stringify(m)
  let saved = body()
  const save = () => { if (body() !== saved) { saveManifest(dir, m, fs); saved = body() } }
  guard()
  const caThere = fs.existsSync(ca.key) && fs.existsSync(ca.pem)
  if (!certs && !caThere) throw stop('the collector CA is not there; run asight install (on never makes it, D55⑤)')
  const { certPem } = loadOrCreateCa({ dir: ca.dir, fs })
  written.caCreated = !caThere
  if (m.engine_port == null) m.engine_port = await freePort()
  const final = planTrust({ descriptors: descs, ctxFor, caCertPem: certPem, collectorDir: dir, roots: R })
  if (daemon && daemon.note) { final.notes.push(daemon.note); final.records.push({ code: CODE.unitEnvNotCarried, reason: daemon.note }) }
  if (JSON.stringify(final.paths) !== JSON.stringify(draft.paths)) throw new Error(`the files to change moved while installing (${draft.paths.join(', ')} → ${final.paths.join(', ')}); only the CA was written; run "asight uninstall", then "asight on"`)
  m.planned = final.paths
  // what `off` needs to judge, from this manifest alone, which live process may hold what asight wrote for a harness (4.6 撤销顺序): written before any user
  // file changes. `identity` is the name list of now (presets + agents.json) united with the one already recorded: a name that has left the list since
  // may still be running a process that read asight's file, so it is never dropped (4.6 「判活快照」); `exclude` / `longLived` are the new ones. The key
  // an older asight wrote, `signature`, goes (a record is rewritten whole). The same inputs give the same bytes: a second `on` saves nothing (D54)
  const named = new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))
  const touched = new Set([...final.entries, ...final.files, ...final.owned].map((x) => x.harness))
  const agentList = readAgentList({ home, fs }).entries
  for (const d of harnesses) if (touched.has(d.name) || named.has(d.name)) m.liveness[d.name] = unitedLiveness(m.liveness[d.name], livenessOf(d, { agentList }))
  const seen = new Set((m.watched || []).map((w) => w.path)) // `existed_before` was recorded when asight first came: a path an agent wrote since is not "there before"
  m.watched = [...(m.watched || []), ...final.watch.filter((w) => !seen.has(w.path)).map((w) => ({ ...w, existed_before: fs.existsSync(w.path) }))]
  save()
  fs.mkdirSync(path.join(dir, 'run', 'trust'), { recursive: true, mode: 0o700 }) // plugins write their marker here, daemon up or not
  const certItem = (p) => { if (certs) return false; written.needInstall.push(p); return true } // on (certs:false) writes no certificate item: a missing one is install's (D55①)
  for (const f of final.files) {
    if (judgeOwned({ manifest: m, file: f.path, fs }).action === 'skip-intact') { written.intact.push(f.path); continue }
    if (certItem(f.path)) continue
    guard()
    writeOwnedFile({ dir, manifest: m, harness: f.harness, role: f.role, phase: 'install', file: f.path, data: f.data, sources: f.sources, extra: f.role === 'bundle' ? { user_fps: f.user_fps, roots_fp: f.roots_fp } : {}, now: now(), fs })
    written.files.push(f.path)
  }
  // a plugin or shim exists before the entry that loads it (a dsh patch row naming a missing file only warns, still)
  for (const o of final.owned) {
    const j = judgeOwned({ manifest: m, file: o.path, fs })
    if (j.action === 'skip-intact') { written.intact.push(o.path); continue }
    if (certItem(o.path)) continue
    guard()
    writeOwnedFile({ dir, manifest: m, harness: o.harness, role: o.role, phase: 'install', file: o.path, data: o.data, mode: o.mode, exclusive: j.action === 'write', now: now(), fs })
    written.owned.push(o.path)
  }
  for (const e of final.entries) {
    const j = judgeEntry({ manifest: m, planned: e, fs })
    if (j.action === 'skip-intact') { written.intact.push(e.path); continue }
    if (j.action === 'skip-user-changed') { written.userChanged.push({ path: e.path, why: j.why }); continue }
    if (certItem(e.path)) continue
    guard()
    const entry = e.kind === 'text'
      ? applyTextEntry({ dir, manifest: m, harness: e.harness, phase: 'install', file: e.path, edit: e, home, now: now(), fs }) // a backup of the file first (1.6 R2): no backup, no change
      : applyJsonKey({ dir, manifest: m, harness: e.harness, phase: 'install', file: e.path, keys: e.keys, value: e.value, home, now: now(), fs })
    if (entry) written.entries.push(entry)
  }
  // the per-user autostart unit (arch: systemd --user on Linux), listed like every other file. The manifest is complete before the unit starts the
  // daemon, which refuses an incomplete one (review 3 #8).
  if (unit) {
    const text = unit.text(daemon.env)
    const j = judgeOwned({ manifest: m, file: unit.path, planned: sha256(Buffer.from(text)), fs })
    if (j.action !== 'skip-intact') { guard(); writeOwnedFile({ dir, manifest: m, role: 'unit', phase: 'install', file: unit.path, data: text, mode: 0o644, exclusive: j.action === 'write', now: now(), fs }); written.unit = j.action }
    // D46: the daemon's own log sinks the unit names — directory 0700, two files 0600, made here at unit-write time and listed in the manifest like
    // every file asight owns; NEVER rewritten afterwards (a later on only lists what the manifest does not know yet, so no log line is ever truncated)
    if (typeof unit.ensureLogs === 'function') { guard(); unit.ensureLogs() }
    if (typeof unit.logFiles === 'function') for (const lf of unit.logFiles()) {
      if (!(m.files || []).some((x) => x.path === lf.path)) { writeOwnedFile({ dir, manifest: m, role: 'daemon-log', phase: 'install', file: lf.path, data: '', mode: 0o600, now: now(), fs }); written.files.push(lf.path) }
    }
  }
  // D55: install's own record (before P10 the `on` that writes the certificates sets it): kept as it is once complete, so a second `on` saves nothing (D54)
  const names = [...new Set([...((m.install && m.install.harnesses) || []), ...descs.map((d) => d.name)])].sort()
  if (!installComplete(m) || JSON.stringify(names) !== JSON.stringify(m.install.harnesses)) m.install = { state: 'complete', at: installComplete(m) ? m.install.at : now().toISOString(), pending: [], harnesses: names }
  if (confirmed) m.confirmed_paths = [...new Set([...(m.confirmed_paths || []), ...final.paths, ...(unit ? [unit.path] : [])])] // what the operator was shown and said yes to (1.6 §1.6)
  save()
  return { manifest: m, final, written }
}

// 4.6 安装 / 卸载不静默 (D-28): everything the command prints is also an install-note in flows/, for the board, where status finds it; a line that cannot
// be written is added to the printed notes, never dropped, and never fails the run. → the `put` the caller writes more with.
function noteRun({ dir, run, final, written, notes, fs, log = null }) {
  const put = runEventWriter({ dir, base: { run }, notes, fs, ...(log ? { log } : {}) }) // a line that cannot be written: stderr first, the receipt's notes, then a `log-gap` when one can again (R11)
  for (const e of written.entries.filter((x) => x.prior_value)) {
    const prior = e.keys ? `${e.path} ${e.keys.join('.')} was ${e.prior_value}; it now points at ${e.value}` : `${e.path} held ${Object.entries(e.prior_value).map(([k, v]) => `${k}=${v}`).join(', ')}; asight commented it out (uninstall restores it)`
    put({ event: EVENT.installNote, where: 'install', kind: 'prior-value', harness: e.harness, path: e.path, reason: prior })
  }
  for (const r of final.records) put({ event: EVENT.installNote, where: 'install', kind: 'note', ...r })
  return put
}

// The legacy shape of the install half: what the harness tests, the test rigs and `collector install` (before `on`) call. Never a confirmation, never state.json
// or a daemon; `already` says every item was in place (no onPlan, nothing written, no event). A unit is enabled with `unit.enable()` (enable --now).
export async function installCollector({ home = os.homedir(), ...opts } = {}) {
  refuseRoot('install')
  const dir = collectorHome(path.join(home, '.asight'))
  return recorded(dir, 'install', async (run) => {
    const fs = opts.fs || nodeFs
    const now = opts.now || (() => new Date())
    const plan = await planOn({ home, ...opts })
    if (installComplete(plan._.prior) && !plan.writing) return { already: true, manifest: plan._.prior, plan: null }
    const onPlan = opts.onPlan || (() => {})
    onPlan(plan)
    const m = openManifest({ dir, plan, now, fs })
    const { manifest, final, written } = await writeInstall({ dir, home, plan, m, osName: opts.osName, harnesses: opts.harnesses, freePort: opts.freePort || freeEnginePort, now, fs })
    let unitFailed = null, unitEvent = null
    if (opts.unit) {
      if (written.unit === 'rewrite' && typeof opts.unit.reload === 'function') opts.unit.reload() // a unit file rewritten under a loaded unit
      const r = opts.unit.enable()
      if (r.code === 0 && r.warn) final.notes.push(r.warn) // enable's own `warn` reaches the receipt (4.8 §7: what it could not do is the caller's to say)
      if (r.code !== 0) {
        // the flip checklist ③ (4.9 §4 末): an arch whose enable() carries its own failure record (the darwin LaunchAgent: `launchd-register-failed`, launchctl wording —
        // launchd is the only autostart there, 4.9 §11) has THAT recorded verbatim, not the systemd-shaped remediation below replacing it.
        if (r.event) { unitEvent = r.event; unitFailed = r.event.reason }
        else unitFailed = `${opts.unit.path} is written but "systemctl --user enable --now" failed (${r.err || `exit ${r.code}`}); start the daemon with "${DAEMON_CMD}", or enable the unit once systemd --user runs`
      }
    }
    const put = noteRun({ dir, run, final, written, notes: final.notes, fs })
    if (unitFailed) { final.notes.push(unitFailed); put(unitEvent || { event: EVENT.failure, where: 'install', code: CODE.unitNotEnabled, reason: unitFailed }) }
    const counts = { entries: manifest.entries.length, files: manifest.files.filter((f) => f.role === 'trust-file').length, notes: final.notes.length }
    put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome: 'installed', counts, reason: `installed: ${counts.entries} trust entr${counts.entries === 1 ? 'y' : 'ies'} and ${counts.files} trust file(s) written, ${counts.notes} note(s)` })
    return { already: false, manifest, plan: final }
  })
}

/** `asight on` (1.6 §1.1, §1.6, R1, R6, R9, R12): plan → confirm → desired state first → write → unit → daemon → receipt. Library form of the command: `runOnCli`
 *  (src/cli/on.mjs) parses the arguments and prints; everything the world gives is injected (`fs`, `request`, `now`, `getuid`, `helperState`, `linger` / `lingerRead`,
 *  `sleep`), so a test runs it in a sandbox HOME. Refuses root by throwing (R7); everything else is a receipt: `exit` 0 done · 1 not done or a problem ·
 *  2 not in a terminal without a yes (the plan is in the receipt, nothing was written).
 *    ids        harness code ids, or null for every one found   confirm(plan) → true | false | null (null: nobody can be asked)   onPlan(plan): print it
 *    unit       the autostart unit (arch/linux/unit.mjs userUnit), or null (no autostart on this platform); `on` never writes or enables it (D61: it is install's) — it is handed in only to start the daemon when none answers
 *    request    the control socket's client (default: controlRequest at $XDG_RUNTIME_DIR/asight/collector.sock, or `socketPath`)
 *    arch       the arch, asked for the combined bundles' OS roots (planOn)   roots  overrides them
 *  → { receipt, manifest, plan, exit }. */
export async function turnOn(opts = {}) {
  const { home = os.homedir(), env = process.env, ids = null, osName, harnesses, scan, match, arch = null, roots = null, unit = null, freePort = freeEnginePort, onPlan = () => {}, confirm = null, dryRun = false, networkEdited = null, request = null, now = () => new Date(), fs = nodeFs, getuid, helperState = null, linger = null, lingerRead = null, socketPath = null, sleep: pause = sleep, user = null, lockWaitMs = OP_LOCK_WAIT_MS } = opts
  refuseRoot('on', getuid)
  // D61: the login entry is `install`'s and `on` never writes it, so the writing side is handed no unit at all
  const unitFile = null
  const dir = collectorHome(path.join(home, '.asight'))
  const stateF = path.join(dir, 'state.json')
  const username = (() => { try { return user || os.userInfo().username } catch { return String(env.USER || '') } })()
  const fresh = () => ({ ...newReceipt('on'), user: username, relayed: { closing: 0, waiting: 0, cut: 0 }, undo: UNDO_LINE.on, standalone: standalonePath(home), commands: ['asight on', 'asight off', 'asight status', 'asight uninstall'], log: path.join(dir, 'flows') }) // on relays nothing: zeros on purpose; `undo` is the ONE line that undoes an on (C.1), and the four commands are what V29 asks the first receipt to carry
  // A receipt of a run that wrote nothing and could not go on: no change, no file made, and no way to undo or log to point at — what is not there (R1: the receipt is what was done).
  // `commands` (the four a user types) stay: they are true whether or not this run wrote anything.
  const unwritten = (r) => { const { standalone: _unwritten, ...rest } = r; return { ...rest, changed: [], created: [], undo: null, log: null } }
  // The helper (D36) is what the real `on` needs and the plan does not: a missing one stops the real run before anything is written, but `--dry-run` still shows the plan — it is what
  // a user reads before deciding to `sudo asight setup-helper` — and exits 0 (R6, V7) with the stop said in the receipt (`blocked`).
  let helperBlock = null
  if (helperState) {
    const h = await helperState()
    if (h && h.ok === false) helperBlock = `the capability helper is missing or not the right version (${h.reason || 'not usable'}); nothing was changed. Run: sudo asight setup-helper`
  }
  if (helperBlock && !dryRun) return { receipt: unwritten({ ...fresh(), ok: false, notes: [helperBlock] }), manifest: null, plan: null, exit: 1 }
  // `lingerRead()` → { state, error? } (src/collector/arch/linux/redirector.mjs) says why when it cannot be read; `linger()` → true | false | null is the older form
  const lingerNow = () => { try {
    if (lingerRead) { const r = lingerRead(); return r.state === true || r.state === false ? { linger: r.state } : { linger: 'unknown', linger_reason: r.error || 'the linger state could not be read' } }
    const v = linger ? linger() : undefined
    return v === true || v === false ? { linger: v } : { linger: 'unknown', linger_reason: linger ? 'the linger state could not be read (/var/lib/systemd/linger)' : 'nothing reads it here' }
  } catch (e) { return { linger: 'unknown', linger_reason: String((e && e.message) || e) } } }
  return recorded(dir, 'install', async (run) => {
    const plan = await planOn({ home, env, ids, osName, harnesses, scan, match, arch, roots, unit: unitFile, fs, now })
    // D55⑥ / override #15: `on` never writes a certificate, so it never installs silently — no install record, no on (macOS / Windows: turnOnModel)
    // 附录 C.1: the refusal's code lives in `error`, the one place a client looks (never a top-level `code`)
    if (!isModelOs(osName) && !installComplete(plan._.prior)) { const message = 'certificates are not installed. Run: asight install'; return { receipt: unwritten({ ...fresh(), ok: false, error: { code: CODE.certNotInstalled, message }, notes: [message] }), manifest: plan._.prior, plan, exit: 1 } }
    // the copy of the undo side that needs no source tree (R3) is one more file asight writes: listed in the plan and the dry run when it is missing or not what src/off generates now
    const standaloneCheck = checkStandalone({ home, version: OFF_VERSION, platform: osName, fs })
    if (!standaloneCheck.ok) { plan.created = [...plan.created, standaloneCheck.path]; plan.standalone = standaloneCheck.path }
    // A version 1 file (what `collector on|off` wrote before D39) is read for the harnesses installed before and the ones this run turns on, the same set
    // the guard below reads it for — and is written back as version 2 here, before the first guard: the guard must never see a file the daemon's reader
    // and this one read differently (1.6 §1.5, R12)
    const known = [...new Set([...plan.installed, ...plan.targets])]
    const readState = () => readStateFile(stateF, { fs, installed: known, now: now() })
    const stateRead = (() => { try { return { ...readState(), error: null } } catch (e) { return { state: emptyState(), from: null, error: e } } })()
    const need = plan.targets.filter((id) => !(stateRead.state.harnesses[id] && stateRead.state.harnesses[id].desired === 'on'))
    const stateWrite = need.length > 0 || stateRead.from === 1 // an unreadable file is `need` too: every target is not on
    const r = { ...fresh(), ...(osName === 'win32' || osName === 'darwin' ? {} : lingerNow()), harnesses: plan.targets, changed: plan.changed, created: [...plan.created, ...(stateWrite ? [stateF] : [])], skipped: [...plan.skipped], restart: plan.restart, unchanged: plan.unchanged, notes: [...plan.notes] }
    if (stateRead.error) r.notes.push(`${stateF} could not be read (${String(stateRead.error.message || stateRead.error)}); it is written again`)
    if (!plan.targets.length) return { receipt: unwritten({ ...r, ok: false, notes: [...r.notes, 'no agent asight can capture was found: nothing was changed. Install one, then run asight on again'] }), manifest: plan._.prior, plan, exit: 1 }
    const named = !!ids && plan.skipped.some((s) => ids.includes(s.what)) // a harness asked for by name that has nothing to install: not done
    // the proxy fields the user edited since the last `on` (1.6 §9.5): asked about like an extra file (R6); a routing that owns none has none
    const edited = networkEdited && plan.targets.length ? await networkEdited(plan.targets) : []
    if (edited.length) r.notes.push(...edited.map((e) => `you changed the proxy setting of ${e.harness}: ${e.where || 'the proxy field'} is now ${e.now ?? 'empty'} (asight left ${e.was ?? 'empty'} there); on takes that as the upstream and points the setting back at asight`))
    if (dryRun) return { receipt: { ...r, dry_run: true, ok: !named, ...(helperBlock ? { blocked: helperBlock, notes: [...r.notes, `${helperBlock.replace('nothing was changed. ', '')} (a real asight on stops there)`] } : {}) }, manifest: plan._.prior, plan, exit: named ? 1 : 0 }
    if (plan.writing || stateWrite || edited.length) onPlan({ ...plan, state: stateWrite ? stateF : null, edited })
    if (plan.first || plan.newPaths.length || edited.length) {
      const verdict = confirm ? await confirm(plan) : null
      if (verdict == null) return { receipt: { ...r, ok: false, planned: true, needs_yes: true, notes: [...r.notes, 'Nothing was changed. Read the plan above, then run it again with --yes'] }, manifest: plan._.prior, plan, exit: 2 }
      if (verdict === false) return { receipt: { ...r, ok: false, planned: true, declined: true, notes: [...r.notes, 'You said no: nothing was changed'] }, manifest: plan._.prior, plan, exit: 1 }
    }

    // ── confirmed: from here on, writes — one state-changing command at a time (R12): the lock is held to the end of this callback (the try below), and
    // the desired state is read again under it, so what an `off` that has just finished left is the base of what is written, not the read of a minute ago
    let lock
    try { lock = await acquireOpLock({ file: opLockFile(home), waitMs: lockWaitMs, fs }) } catch (e) {
      if (e && e.code === LOCK_BUSY) return { receipt: unwritten({ ...r, ok: false, notes: [...r.notes, String((e && e.message) || e)] }), manifest: plan._.prior, plan, exit: 1 }
      throw e
    }
    try {
    const m = openManifest({ dir, plan, now, fs })
    // the desired state goes first (R9, R12): an `off` that lands meanwhile writes the same file, and every write below reads it again
    const locked = (() => { try { return readState() } catch { return stateRead } })()
    const needNow = plan.targets.filter((id) => !(locked.state.harnesses[id] && locked.state.harnesses[id].desired === 'on'))
    if (needNow.length) writeStateAtomic(stateF, setDesired(locked.state, needNow, 'on', now()), { fs })
    else if (stateWrite) writeStateAtomic(stateF, locked.state, { fs }) // version 1 → 2, nothing turned on: "on since" stays where it was
    // the undo that needs no source tree is in place before the first thing it undoes (R3): written on every `on`, nothing when it already is what src/off generates. A copy that
    // cannot be written stops the run here, before one file of the agents' is touched — the way back first, like the backup of a file (R2) — and `recorded` writes the failure (R11)
    let standalone
    try { standalone = writeStandalone({ home, version: OFF_VERSION, fs }) } catch (e) {
      throw Object.assign(new Error(`${standalonePath(home)}, the undo that works without the source tree, could not be written (${String((e && e.message) || e)}); no file of the agents' was changed — put that right, then run asight on again`), { code: e && e.code })
    }
    const guard = () => {
      let st
      try { st = readState().state } catch (e) { throw stop(`${stateF} cannot be read (${String((e && e.message) || e)}), so it is not known whether an off was asked; stopped (1.6 R12)`) }
      const off = plan.targets.filter((id) => !(st.harnesses[id] && st.harnesses[id].desired === 'on'))
      if (off.length) throw stop(`${off.join(', ')} was turned off while this on ran (${stateF}); stopped, the off wins (1.6 R12). What was written is a resumable install: asight on finishes it`)
    }
    const notes = r.notes
    const problems = []
    let written = null, final = null, halt = false
    try { ({ final, written } = await writeInstall({ dir, home, plan, m, osName, harnesses, freePort, now, fs, guard, confirmed: true, certs: isModelOs(osName) })) } catch (e) {
      if (!e.stopsRun) throw e
      written = e.written; halt = true
      problems.push(e.message)
    }
    if (written && written.needInstall.length) problems.push(`these certificate items are not in place and on does not write them: ${written.needInstall.join(', ')}; run asight install (D55①)`)
    const put = noteRun({ dir, run, final: final || { records: [] }, written: written || { entries: [] }, notes, fs, log: opts.log })
    const receipt = {
      ...r,
      changed: (written ? written.entries : []).map((e) => ({ path: e.path, change: changeText(e, e.prior_value), backup: e.backup ?? null })),
      created: [...(plan._.prior ? [] : [manifestPath(dir)]), ...(stateWrite ? [stateF] : []), ...(standalone.written ? [standalone.path] : []), ...(written && written.caCreated ? plan._.ca ? [plan._.ca.key, plan._.ca.pem] : [] : []), ...(written ? [...written.files, ...written.owned, ...(written.unit && unitFile ? [unitFile.path] : [])] : [])],
      unchanged: written ? written.intact : [],
    }
    const finish = (outcome, reason) => {
      receipt.ok = !problems.length && !named && !(written && written.userChanged.length) // an entry the user changed is left, and not in effect: not "done"
      const counts = { entries: m.entries.length, changed: receipt.changed.length, notes: notes.length + problems.length }
      put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome, counts, reason }) // before the notes are taken: a result line that cannot be written adds its own "not recorded" (R11)
      receipt.notes = [...notes, ...problems]
      receipt.problems = problems // the renderer labels exactly these 问题: — a failed run's SUCCESS notes (the kernel's "downloaded and both digests
      // verified") must not wear the problem label, which is what a whole-receipt ok===false test did (seen on a macOS test machine, 2026-10-11)
      return { receipt, manifest: m, plan, exit: receipt.ok ? 0 : 1 }
    }
    if (halt) { put({ event: EVENT.failure, where: 'install', code: 'install-error', reason: problems[0] }); return finish('stopped', `on stopped: ${problems[0]}`) }

    // ── the unit and the daemon: started when nothing answers, never started a second time (拉起不是重启, R8) ──
    const checked = (fn) => { try { fn() } catch (e) { if (!e.stopsRun) throw e; problems.push(e.message); halt = true } }
    const d = await ensureDaemonUp({ osName, dir, env, fs, unit, socketPath, request, pause, put, halted: () => { checked(() => guard()); return halt } })
    const { sock, ask, started, unitFailed } = d
    const up = d.up
    notes.push(...d.notes); problems.push(...d.problems); if (d.halt) halt = true
    const pid = readLockPid(dir, fs)
    receipt.daemon = { state: up ? 'running' : 'not-running', started, ...(pid ? { pid } : {}) }
    // the links last: the daemon attaches on this request, and answers with the state it reached
    if (up && !halt) checked(() => guard())
    if (up && !halt) {
      let status = null
      try { status = await ask({ socketPath: sock, method: 'POST', path: '/on', body: { harnesses: plan.targets } }) } catch (e) {
        const why = `the daemon did not take the on request (${String((e && e.message) || e)})`
        problems.push(why); put({ event: EVENT.failure, where: 'control', code: 'control-error', reason: why })
      }
      if (status) {
        receipt.restart = (status.agents || []).filter((a) => a && !a.trusted && !a.off && RESTART_REASONS.has(a.reason) && plan.targets.includes(a.agent)).map((a) => ({ harness: a.agent, pid: a.pid, reason: a.reason }))
        receipt.capture = { desired: status.desired ?? null, actual: status.actual ?? null }
        if (status.actual !== 'on') {
          const why = status.helper && status.helper.ok === false ? `the capability helper speaks protocol ${status.helper.proto}, this daemon expects ${status.helper.expected_proto}; run: sudo asight setup-helper`
            : status.degraded ? `the helper is down (${status.degraded.reason}); nothing is steered, agents connect directly`
              : status.ca && status.ca.ok === false ? `the collector CA is unusable (${status.ca.which}: ${status.ca.reason}); nothing is steered` : `the daemon did not reach on (actual: ${status.actual}); nothing is steered, agents connect directly`
          problems.push(why); put({ event: EVENT.failure, where: 'switch', code: 'state-mismatch', reason: why })
        }
      }
    }
    const wrote = written.entries.length || written.files.length || written.owned.length || written.unit
    return finish(wrote ? 'installed' : 'on', problems.length ? `on did not finish: ${problems[0]}` : `on: ${plan.targets.join(', ')}`)
    } finally { lock.release() }
  })
}

const UNIT_NAME_HINT = 'asight-collector.service'

// ── the daemon up with its endpoint answering (1.6 §1.1「启用自启并拉起守护进程」; 拉起不是重启, R8): the one copy every `on` uses (Linux's turnOn and
// macOS / Windows' runModelOn, 4.9 §4, 4.8 §7) — two copies of this seam is the 2026-10-11 incident's pattern.
// The endpoint is resolved the one way every caller resolves it (4.8 §7 / 4.9 §7: darwin / win32 find the daemon through control.json and every
// request carries its token; Linux through $XDG_RUNTIME_DIR). This was the 2026-10-11 incident's seam: a Linux-only fallback here made every
// `asight on` on a real Mac a false start-failed while the daemon was up.
// Second seam of the same incident (caught on a macOS test machine, 2026-10-11): on darwin / win32 control.json is written by the daemon AT ITS
// FIRST START, so a FIRST install has no endpoint to resolve before the unit runs — resolving once up here kept sock null through the whole
// poll and every first `on` ended "no daemon answers on null", exit 1, while the daemon was up and healthy. The probe re-resolves while
// → { up, started, sock, ask, unitFailed, notes, problems, halt }: `halted()` is asked before the daemon is touched and after each poll (R12: an `off` that
// lands meanwhile stops the run); `put` records each failure. `register` (D61) is `install`'s arm: the login registration is made and the daemon started
// (`unit.enable`, with `--now` only when nothing answers — 拉起不是重启, R8). Without it (`on`'s arm) the registration is NEVER touched: the daemon is
// started through the OS mechanism install registered (`unit.startNow()`), and directly when that refuses (no systemd --user bus, a job that is not loaded).
export async function ensureDaemonUp({ osName, dir, env, fs = nodeFs, unit = null, register = false, reload = false, socketPath = null, request = null, pause = sleep, put = () => {}, halted = () => false }) {
  const resolveEndpoint = () => controlEndpointFor({ platform: osName, dir, env, fs })
  let endpoint = resolveEndpoint()
  let sock = socketPath || endpoint.socketPath
  let ask = request || endpoint.request
  const probe = async () => {
    if (!sock && !socketPath) { endpoint = resolveEndpoint(); sock = endpoint.socketPath; ask = request || endpoint.request }
    if (!sock) return { up: false, why: endpoint.why || 'no control socket to ask' }
    try { await ask({ socketPath: sock, method: 'GET', path: '/status', timeoutMs: 2000 }); return { up: true } } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) return { up: false }
      return { up: false, stuck: String((e && e.message) || e) }
    }
  }
  const notes = [], problems = []
  const was = await probe()
  let up = was.up, started = false, unitFailed = null, halt = false
  if (was.stuck) { problems.push(`a daemon holds the control socket but does not answer (${was.stuck}); run "asight off", then "asight on" (off stops a stuck daemon, 1.6 §1.4)`); halt = true }
  else if (unit) {
    if (halted()) halt = true
    else {
      if (reload && typeof unit.reload === 'function') unit.reload() // a unit file rewritten under a loaded unit
      // `install` registers and starts (enable); `on` only starts, through the OS mechanism, and itself when that refuses — the reason said, never dropped (D38)
      let rr = register ? unit.enable({ now: !was.up }) : (was.up ? null : unit.startNow())
      if (!register && rr && rr.code !== 0 && typeof unit.start === 'function') {
        const direct = unit.start(daemonEnv(env, dir)) // the direct start carries what the login entry's Environment= would carry
        if (direct.code === 0) { notes.push(`the collector could not be started through ${entryWords(osName, unit)} (${rr.err || `exit ${rr.code}`}); asight started it directly this run — the login entry starts it at the next login`); rr = direct }
      }
      started = !was.up
      if (rr && rr.code === 0 && rr.warn) notes.push(rr.warn) // the arch's own `warn` reaches the receipt (4.8 §7: what it could not do is the caller's to say) — the Run-value it could not take out, the daemon it started directly because /Run's SUCCESS was a lie
      if (rr && rr.code !== 0) {
        // the flip checklist ③ (4.9 §4 末): the arch's own failure record, verbatim, when enable() carries one (the darwin LaunchAgent's `launchd-register-failed` —
        // launchd is the only autostart there, 4.9 §11); the wording below is the answer of an arch that has none.
        if (rr.event) { unitFailed = rr.event.reason; put(rr.event) }
        else if (!register) { unitFailed = `the collector could not be started (${rr.err || `exit ${rr.code}`}); start it yourself: ${DAEMON_CMD}`; put({ event: EVENT.failure, where: 'start', code: 'start-failed', reason: unitFailed }) } // `on` touches no registration: there is nothing to enable, only this start
        else {
          // the start question in the platform's own words: win32's unit is a scheduled task (\asight\collector, autostart.mjs), darwin's a LaunchAgent,
          // and the systemd wording is Linux's alone — a Windows user told to run `systemctl --user status` has been handed nothing (tested 2026-10-11)
          const daemonLog = typeof unit.logFiles === 'function' ? (unit.logFiles()[1] || {}).path : null
          const entry = osName === 'win32' ? 'the scheduled task \\asight\\collector' : osName === 'darwin' ? `the LaunchAgent ${unit.path}` : null
          unitFailed = entry // a systemd line is Linux's alone: a Mac or Windows user told to run `systemctl --user` has been handed nothing (tested on Windows 2026-10-11 and macOS 2026-10-18)
            ? `${entry} was not registered or run (${rr.err || `exit ${rr.code}`}); start the daemon with "${DAEMON_CMD}"${daemonLog ? `, and ${daemonLog} says why it did not start` : ''}`
            : `${unit.path} is written but "systemctl --user enable${was.up ? '' : ' --now'}" failed (${rr.err || `exit ${rr.code}`}); start the daemon with "${DAEMON_CMD}", or enable the unit once systemd --user runs`
          put({ event: EVENT.failure, where: 'install', code: CODE.unitNotEnabled, reason: unitFailed })
        }
        notes.push(unitFailed); problems.push(unitFailed)
      } else if (!was.up) {
        for (let i = 0; i < 60 && !up && !halt; i++) { up = (await probe()).up; if (!up) { await pause(250); if (halted()) halt = true } } // an off that lands while the daemon starts is seen within a poll, not after 15 s (R12)
        if (!up && !halt) {
          const where = osName === 'darwin' ? 'launchctl print gui/$(id -u)/com.asight.collector' : osName === 'win32' ? 'schtasks /Query /TN \\asight\\collector (and "asight status" for the daemon)' : `systemctl --user status ${UNIT_NAME_HINT}` // the autostart's own status question, in the platform's words (4.9 §4: the LaunchAgent, not a systemd unit; 4.8 §7: the task, not a unit)
          const why = `the collector was started${sock ? ` but does not answer on ${sock}` : ', but it does not answer yet'}; look at "${where}" and the capture health on the board` // never "answers on null": an endpoint that is not known yet is not named (1.6 §1.1)
          problems.push(why); put({ event: EVENT.failure, where: 'start', code: 'start-failed', reason: why })
        }
      }
    }
  } else if (!up) notes.push(`no login entry and no collector running: start it with ${DAEMON_CMD} (it follows what is turned on)${was.why ? `; ${was.why}` : ''}`)
  return { up, started: started && up, sock, ask, unitFailed, notes, problems, halt }
}
function readLockPid(dir, fs) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')).pid ?? null } catch { return null } }

// `asight install` on macOS and Windows (4.11 §1, plan T20): the model's install lives beside this one; Linux keeps installCollector.
export { runInstall } from './model-install.mjs'
