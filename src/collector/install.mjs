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
import { livenessOf } from './core/registry.mjs'
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, previewJsonKey, applyTextEntry, previewTextEntry, writeOwnedFile, removeOwnedFile, removeEmptyDirs, manifestPath, sweepTemps, describeEntry, judgeEntry, judgeOwned, sha256 } from './core/trust/journal.mjs'
import { EVENT, CODE, UNTIL_TEXT } from './core/codes.mjs'
import { controlRequest, controlSocketPath } from './core/control.mjs'
import { readText, readTextOrError } from './core/config-read.mjs'
import { appendEvent } from './core/events.mjs'
import { lockState, procIdentity } from '../health/read.mjs'
import { pidAlive } from '../off/proc.mjs'
import { dropBackup } from '../off/backup.mjs'
import { undoHarnesses } from '../off/undo.mjs'
import { undoByHand } from '../off/manifest.mjs'
import { backupDir } from '../off/paths.mjs'
import { readStateFile, emptyState, setDesired, writeStateAtomic } from '../off/state.mjs'
import { newReceipt } from '../off/schema.mjs'

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
  if (m && m.unsupported) throw new Error(`the install manifest ${manifestPath(dir)} is version ${JSON.stringify(m.version)}, which this build does not read (it reads 1 and 2); nothing was changed. Use the asight that wrote it, or run "asight off", which leaves what it does not know`)
}

function refuseRoot(verb, getuid = processUid) {
  if (getuid() === 0) throw new Error(`asight ${verb === 'on' ? verb : `collector ${verb}`}: run it as the user whose agents you capture, not as root (D36); 用你自己的账号跑`)
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

// ── `asight on` (RFC 1.6 §1.6, R6, R9, R12; D39) ────────────────────────────────────────────────────────────────────────────────────────
// `on` is the install: the first one writes the CA, the combined bundles, the entries and the unit; every later one finds what is there and writes
// only what is not. Per planned item the manifest and the disk say which (journal.mjs judgeEntry / judgeOwned): written (new), intact (never
// rewritten — its `installed_at`, inode and mtime stay, or the agents already captured would be judged config-after-start and stop being
// captured), resumed (an intent a crash left), or changed by the user since (reported, left). The order is R9's: what an entry points at (the
// CA, the bundles, plugins, the shim) before the entry, the entries, the unit, and the links last — by the daemon, on `POST /on`.
//   planOn      reads: the plan to print and to judge by (no write, no confirmation)
//   turnOn      the command: plan → confirm → desired state first → write → unit → daemon → receipt
//   installCollector   the install half alone, as the harness and lab tests set an agent up (no state.json, no daemon, no confirmation)

const nodeFs = fs
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const act = (a) => a !== 'skip-intact' && a !== 'skip-user-changed'
const shortLine = (l) => String(l).split(' # ')[0].trim()
const RESTART_REASONS = new Set(['config-after-start', 'env-frozen', 'start-time-unknown', 'no-marker', 'kimi-not-via-shim']) // 「重启后才会被采集」(1.6 §1.1)
const DAEMON_CMD = 'asight collector start' // 1.6 §2 renames it `asight daemon`; the autostart unit's ExecStart is this command until then

/** What the receipt says an entry did, in one phrase — the same words in the dry run (from the preview) and in the real run (from the entry). */
export function changeText(e, prior = null) {
  if (e.kind === 'text') {
    if (e.vars) return `顶部加 asight 哨兵块(${Object.keys(e.vars).join(', ')})${prior ? `;注释掉你原有的 ${Object.keys(prior).join(', ')}` : ''}`
    return `加一行(${shortLine(e.line)})`
  }
  return prior != null ? `改 ${(e.keys || []).join('.')}(原值 ${prior})` : `加 ${(e.keys || []).join('.')}`
}

// An error that is not a failure of asight: an `off` asked for while this `on` ran (R12: off wins), or a step that has to stop the run.
const stop = (message) => Object.assign(new Error(message), { stopsRun: true })

/** What `on` would do, read from the disk and the manifest, written nowhere. Refusals come first, so a refused plan writes nothing at all (not even the
 *  manifest): a file that is not JSON, a dangling link, a plugin file already there, a manifest this build cannot read, a CA that cannot be used.
 *  → { first, newPaths, steps, targets, skipped, restart, changed, created, unchanged, manifest, ca, files, owned, entries, unit?, watch, notes,
 *      records, events, _ } — the first fields are what is printed and receipted (`files` / `owned` / `entries` / `unit` only what would be written);
 *  `_` is what the writing needs (the manifest as read, the draft, the roots). `ids`: the harness code ids named, or null for every one found. */
export async function planOn({ home = os.homedir(), env = process.env, ids = null, osName, harnesses, scan = async () => [], match = () => ({ agent: null }), osRootsFile = null, roots = null, unit = null, fs = nodeFs, now = () => new Date() } = {}) {
  const dir = collectorHome(path.join(home, '.asight'))
  const prior = readManifest(dir, fs)
  refuseUnsupported(dir, prior)
  if (prior && prior.complete) {
    // installed — but only usable when its CA is (D-4): a CA that cannot be read or used is said, with how to start over
    const c = readCa({ dir: path.join(dir, 'ca'), fs })
    const st = c.error ? { ok: false, which: c.which, reason: c.error } : checkCa(c)
    if (!st.ok) throw Object.assign(new Error(`the collector is installed, but its CA is unusable (${st.which}: ${st.reason}); run "asight collector uninstall", then "asight collector install"`), { code: 'ca-invalid' })
  }
  if (prior && prior.pending_bundles) throw new Error(`an earlier uninstall kept combined bundles that running agents still use (${prior.files.filter((f) => f.role === 'bundle' || f.role === 'trust-file').map((f) => f.path).join(', ')}); run "asight collector uninstall" again once they exit`)
  if (prior && prior.uninstall_left) throw new Error(`an earlier uninstall could not undo ${prior.uninstall_left.length} item(s) (${prior.uninstall_left.map((l) => l.path).join(', ')}); fix them, run "asight collector uninstall" again, then install`)
  const descs = ids ? harnesses.filter((d) => ids.includes(d.name)) : harnesses
  const ca = caPaths(path.join(dir, 'ca'))
  const facts = await scan()
  const envMap = new Map(Object.entries(env).filter(([, v]) => typeof v === 'string'))
  const ctxFor = (d) => ({
    os: osName, home, env: envMap, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()),
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir, collectorDir: dir, caPem: ca.pem,
  })
  const R = roots || readRoots(osRootsFile)
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
    ...steps.filter((s) => s.action === 'skip-user-changed').map((s) => ({ what: s.path, reason: `${s.why}; run "asight off", then "asight on", to write it again` })),
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
  return {
    first, newPaths, steps, targets, skipped, restart, writing,
    changed: draft.entries.map((e, i) => ({ e, j: entryJ[i], i })).filter((x) => act(x.j.action)).map((x) => ({ path: x.e.path, change: changeText(x.e, x.j.entry ? x.j.entry.prior_value : preview[x.i].prior), backup: null })),
    created: [...(prior ? [] : [manifestPath(dir)]), ...(fs.existsSync(ca.key) && fs.existsSync(ca.pem) ? [] : [ca.key, ca.pem]), ...steps.filter((s) => act(s.action) && s.kind !== 'entry').map((s) => s.path)],
    unchanged: steps.filter((s) => s.action === 'skip-intact').map((s) => s.path),
    // what onPlan prints (formatPlan): the files this run would write or change
    manifest: manifestPath(dir),
    ca: [ca.key, ca.pem],
    files: draft.files.filter((f, i) => act(fileJ[i].action)).map((f) => ({ harness: f.harness, path: f.path, sources: f.sources })),
    owned: draft.owned.filter((o, i) => act(ownedJ[i].action)).map((o) => ({ harness: o.harness, path: o.path, role: o.role })),
    entries: draft.entries.map((e, i) => [e, i]).filter(([, i]) => act(entryJ[i].action)).map(([e, i]) => entryRow(e, i)),
    ...(unit && act(unitJ.action) ? { unit: { path: unit.path, env: daemon.env, links: unit.links || [] } } : {}),
    watch: draft.watch,
    notes: draft.notes,
    records: path.join(dir, 'flows'), // install notes are kept here as install-note events (D38)
    events: path.join(dir, 'flows', `${day}.ndjson`), // install-note lines are appended here (D-28)
    _: { dir, prior, ca, descs, ctxFor, R, daemon, draft, unit },
  }
}

// The manifest the writing starts from: the one on disk, or — the first time — a new one that lists the directories asight is about to create and
// the CA files before the CA is minted, and is saved at once (so a crash before the first user file leaves a manifest `uninstall` can use).
function openManifest({ dir, plan, now, fs }) {
  const { prior, ca } = plan._
  if (prior) return prior
  const m = newManifest(now())
  m.dirs = missingDirs(dir, fs)
  m.dirs.push(...missingDirs(ca.dir, fs).filter((d) => !m.dirs.includes(d)))
  m.files.push({ path: ca.key, role: 'ca-key' }, { path: ca.pem, role: 'ca-cert' })
  saveManifest(dir, m, fs)
  return m
}

// Every write of an `on`, in R9's order. `guard()` runs before each one (R12: it throws when an `off` asked for one of the harnesses in the meantime).
// The manifest is saved only when it changed, so a second `on` on a complete install rewrites nothing. → { manifest, final, written }.
async function writeInstall(args) {
  const written = { entries: [], files: [], owned: [], unit: null, caCreated: false, intact: [], userChanged: [] }
  try { return await writeInstallSteps(args, written) } catch (e) { if (e && e.stopsRun) e.written = written; throw e } // what was done before the stop is said
}
async function writeInstallSteps({ dir, home, plan, m, osName, harnesses, freePort, now, fs, guard = () => {}, confirmed = false }, written) {
  const { ca, descs, ctxFor, R, daemon, draft, unit } = plan._
  const body = () => JSON.stringify({ ...m, upgraded_from: undefined })
  let saved = body()
  const save = () => { if (body() !== saved) { saveManifest(dir, m, fs); saved = body() } }
  guard()
  const caThere = fs.existsSync(ca.key) && fs.existsSync(ca.pem)
  const { certPem } = loadOrCreateCa({ dir: ca.dir, fs })
  written.caCreated = !caThere
  if (m.engine_port == null) m.engine_port = await freePort()
  const final = planTrust({ descriptors: descs, ctxFor, caCertPem: certPem, collectorDir: dir, roots: R })
  if (daemon && daemon.note) { final.notes.push(daemon.note); final.records.push({ code: CODE.unitEnvNotCarried, reason: daemon.note }) }
  if (JSON.stringify(final.paths) !== JSON.stringify(draft.paths)) throw new Error(`the files to change moved while installing (${draft.paths.join(', ')} → ${final.paths.join(', ')}); only the CA was written; run "asight collector uninstall", then install again`)
  m.planned = final.paths
  // what `off` needs to judge, from this manifest alone, which live process may hold what asight wrote for a harness (4.6 撤销顺序): written before any user
  // file changes. Only what is missing is added — a manifest an older asight wrote has none for its harnesses, and `on` is how it gets them (4.6 「判活快照」)
  const named = new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))
  const touched = new Set([...final.entries, ...final.files, ...final.owned].map((x) => x.harness))
  for (const d of harnesses) if ((touched.has(d.name) || named.has(d.name)) && !m.liveness[d.name]) m.liveness[d.name] = livenessOf(d, osName)
  const seen = new Set((m.watched || []).map((w) => w.path)) // `existed_before` was recorded when asight first came: a path an agent wrote since is not "there before"
  m.watched = [...(m.watched || []), ...final.watch.filter((w) => !seen.has(w.path)).map((w) => ({ ...w, existed_before: fs.existsSync(w.path) }))]
  save()
  fs.mkdirSync(path.join(dir, 'run', 'trust'), { recursive: true, mode: 0o700 }) // plugins write their marker here, daemon up or not
  for (const f of final.files) {
    if (judgeOwned({ manifest: m, file: f.path, fs }).action === 'skip-intact') { written.intact.push(f.path); continue }
    guard()
    writeOwnedFile({ dir, manifest: m, harness: f.harness, role: f.role, file: f.path, data: f.data, sources: f.sources, extra: f.role === 'bundle' ? { user_fps: f.user_fps, roots_fp: f.roots_fp } : {}, now: now(), fs })
    written.files.push(f.path)
  }
  // a plugin or shim exists before the entry that loads it (a dsh patch row naming a missing file only warns, still)
  for (const o of final.owned) {
    const j = judgeOwned({ manifest: m, file: o.path, fs })
    if (j.action === 'skip-intact') { written.intact.push(o.path); continue }
    guard()
    writeOwnedFile({ dir, manifest: m, harness: o.harness, role: o.role, file: o.path, data: o.data, mode: o.mode, exclusive: j.action === 'write', now: now(), fs })
    written.owned.push(o.path)
  }
  for (const e of final.entries) {
    const j = judgeEntry({ manifest: m, planned: e, fs })
    if (j.action === 'skip-intact') { written.intact.push(e.path); continue }
    if (j.action === 'skip-user-changed') { written.userChanged.push({ path: e.path, why: j.why }); continue }
    guard()
    const entry = e.kind === 'text'
      ? applyTextEntry({ dir, manifest: m, harness: e.harness, file: e.path, edit: e, home, now: now(), fs }) // a backup of the file first (1.6 R2): no backup, no change
      : applyJsonKey({ dir, manifest: m, harness: e.harness, file: e.path, keys: e.keys, value: e.value, home, now: now(), fs })
    if (entry) written.entries.push(entry)
  }
  // the per-user autostart unit (arch: systemd --user on Linux), listed like every other file. The manifest is complete before the unit starts the
  // daemon, which refuses an incomplete one (review 3 #8).
  if (unit) {
    const text = unit.text(daemon.env)
    const j = judgeOwned({ manifest: m, file: unit.path, planned: sha256(Buffer.from(text)), fs })
    if (j.action !== 'skip-intact') { guard(); writeOwnedFile({ dir, manifest: m, role: 'unit', file: unit.path, data: text, mode: 0o644, exclusive: j.action === 'write', now: now(), fs }); written.unit = j.action }
  }
  m.complete = true
  if (confirmed) m.confirmed_paths = [...new Set([...(m.confirmed_paths || []), ...final.paths, ...(unit ? [unit.path] : [])])] // what the operator was shown and said yes to (1.6 §1.6)
  save()
  return { manifest: m, final, written }
}

// 4.6 安装 / 卸载不静默 (D-28): everything the command prints is also an install-note in flows/, for the board, where status finds it; a line that cannot
// be written is added to the printed notes, never dropped, and never fails the run. → the `put` the caller writes more with.
function noteRun({ dir, run, final, written, notes, fs }) {
  const put = (rec) => { try { appendEvent(dir, { ...rec, run }, { fs }) } catch (w) { notes.push(`not recorded (${String((w && w.message) || w)}): ${rec.reason}`) } }
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
    if (plan._.prior && plan._.prior.complete && !plan.writing) return { already: true, manifest: plan._.prior, plan: null }
    const onPlan = opts.onPlan || (() => {})
    onPlan(plan)
    const m = openManifest({ dir, plan, now, fs })
    const { manifest, final, written } = await writeInstall({ dir, home, plan, m, osName: opts.osName, harnesses: opts.harnesses, freePort: opts.freePort || freeEnginePort, now, fs })
    let unitFailed = null
    if (opts.unit) {
      const r = opts.unit.enable()
      if (r.code !== 0) unitFailed = `${opts.unit.path} is written but "systemctl --user enable --now" failed (${r.err || `exit ${r.code}`}); start the daemon with "asight collector start", or enable the unit once systemd --user runs`
    }
    const put = noteRun({ dir, run, final, written, notes: final.notes, fs })
    if (unitFailed) { final.notes.push(unitFailed); put({ event: EVENT.failure, where: 'install', code: CODE.unitNotEnabled, reason: unitFailed }) }
    const counts = { entries: manifest.entries.length, files: manifest.files.filter((f) => f.role === 'trust-file').length, notes: final.notes.length }
    put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome: 'installed', counts, reason: `installed: ${counts.entries} trust entr${counts.entries === 1 ? 'y' : 'ies'} and ${counts.files} trust file(s) written, ${counts.notes} note(s)` })
    return { already: false, manifest, plan: final }
  })
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

// 4.6 撤销顺序 is src/off/undo.mjs (undoHarnesses, which `asight off` runs too, 1.6 R3): (1) the config entries → (2) combined bundles → (3) extra
// trust files and asight-ca.pem → (4) rc lines, patch rows, plugins and shims → (5) report the running agents that may still trust asight. What
// is left here is what only uninstall does: stop the daemon, the autostart unit, the CA key and the runtime state, the purge, and the notes and
// failure events of this run. The manifest goes only when everything it lists is undone: an entry uninstall could not undo stays in it (D38:
// recorded, and `asight collector uninstall` exits non-zero) so the next run finds it again.

// what each undo result other than a plain restore means for the user (4.6 撤销结果)
const UNDO_NOTE = {
  'already-restored': 'already back as it was before install: nothing to undo',
  'reverted-not-identical': 'asight\'s key was removed, but the file is not byte for byte what it was before install (it was edited since)',
  missing: 'the file is gone: nothing of asight\'s is left in it',
  'left-user-value': 'the key now holds a value the user set: left as it is',
}

async function uninstall(dir, { home = path.dirname(path.dirname(dir)), env = process.env, purgeData = false, scan = async () => [], stop = null, osRootsFile = null, roots = null, unit = null, run = null }) {
  const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'asight') : null
  const report = { daemon: null, entries: [], removed: [], residue: [], kept_bundles: [], still_trusting: [], kept_captures: !purgeData, notes: [], left: [], dropped_backups: [] } // left: what could not be undone, {path, harness, result} each (D-18)
  const failed = [] // failure events, written after any purge so they survive it
  const noted = [] // uninstall-note events (kept captures only: --purge-data asked for flows/ to go)
  const m = readManifest(dir)
  refuseUnsupported(dir, m) // before the daemon is stopped or anything is undone
  const unitFile = m && m.files.find((f) => f.role === 'unit')
  report.daemon = await (stop || (() => stopDaemon({ socketPath: runtime && path.join(runtime, 'collector.sock'), lockFile: path.join(dir, 'lock'), stopUnit: unitFile && unit ? () => unit.stop() : null })))()
  const rm = (p) => { sweepTemps(p); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); report.removed.push(p) } }
  let unitLeft = false
  if (!m) report.notes.push('nothing is installed for this user')
  else {
    const out = await undoHarnesses({ dir, home, manifest: m, ids: null, procs: scan, roots: roots || (m.files.some((f) => f.role === 'bundle') ? readRoots(osRootsFile) : null), dropCa: true })
    const failure = (l, code = l.result === 'error' || l.result === 'unknown-kind' ? CODE.entryNotUndone : l.result) => failed.push({ code, harness: l.harness, path: l.path, reason: l.reason }) // left-unparsable / left-link are D38 codes
    report.entries = out.results
    report.removed.push(...out.removed)
    report.kept_bundles = out.kept_bundles
    report.still_trusting = out.still_trusting.map(({ pid, harness, until }) => ({ pid, agent: harness, until }))
    report.left = out.left.map(({ path: p, harness, result }) => ({ path: p, harness, result }))
    for (const l of out.left) failure(l)
    for (const r of out.results) {
      if (r.result === 'reverted-not-identical') noted.push({ code: CODE.notIdentical, harness: r.harness, path: r.path, reason: `${r.path} was edited after install: only asight's ${r.what} was taken out${r.deleted ? ' and the file, holding nothing else, removed' : ''}; the file is not byte for byte what it was before install, the rest is as the user left it` })
      else if (!['restored', 'left-unparsable', 'left-link', 'error'].includes(r.result)) noted.push({ code: r.result, harness: r.harness, path: r.path, reason: UNDO_NOTE[r.result] || r.result }) // already-restored, missing, left-user-value
    }
    for (const k of out.kept_bundles.filter((x) => !x.holds_ca && !x.unjudged && !x.error)) {
      const entry = k.entry_left ? `${k.entry_left.join(', ')}, which could not be undone, still points at it` : null // an agent's next start reads the bundle through it
      const again = `run uninstall again once ${k.pids.length ? 'they exit' : 'that is fixed'}`
      noted.push(k.rebuilt
        ? { code: CODE.harnessNote, harness: k.harness, path: k.path, reason: `${k.path} was gone while ${[...(k.pids.length ? [`a running process may use it (pid ${k.pids.join(', ')})`] : []), ...(entry ? [entry] : [])].join(' and ')}; it was rebuilt without the asight CA${k.lost_fps ? `, but without ${k.lost_fps.length} user CA(s) its source files no longer hold` : ''}; ${again}` }
        : { code: CODE.bundleKept, harness: k.harness, path: k.path, reason: `${k.path} is kept, without the asight CA, ${[...(k.pids.length ? [`for running processes that may have loaded it (pid ${k.pids.join(', ')})`] : []), ...(entry ? [`because ${entry}`] : [])].join(' and ')}; ${again}` })
    }
    for (const c of out.changed) noted.push({ code: CODE.harnessNote, harness: c.harness, path: c.path, reason: `${c.path}, asight's ${c.role}, had been changed since install; it was removed all the same` })
    for (const w of out.residue) { report.residue.push(w.path); noted.push({ code: CODE.residue, harness: w.harness, path: w.path, reason: `${w.path} appeared after install (${w.why}); it may serve the user's own plugins too, so asight did not remove it` }) }
    for (const p of report.still_trusting) noted.push({ code: CODE.stillTrusting, harness: p.agent, pid: p.pid, reason: `pid ${p.pid} (${p.agent}) trusts the asight CA ${UNTIL_TEXT[p.until] || UNTIL_TEXT.restart}` })
    if (out.procs_error) noted.push({ code: CODE.harnessNote, reason: `which agents still trust the asight CA is not known: the process table could not be read (${out.procs_error})` })
    // an entry of a kind uninstall does not undo (a future writer's, or one this build does not know) stays, and is said (1.6 R3)
    for (const e of m.entries.filter((x) => !out.left.some((l) => l.path === x.path && l.harness === (x.harness ?? null)))) {
      report.left.push({ path: e.path, harness: e.harness ?? null, result: 'unknown-kind' })
      failure({ harness: e.harness ?? null, path: e.path, result: 'unknown-kind', reason: `${e.path}: this item is of kind ${JSON.stringify(e.kind ?? null)}, which uninstall does not undo; ${undoByHand(e)}` }, CODE.entryNotUndone)
    }
    // uninstall deletes every backup (zero residue, 1.6 R2): the ones undo dropped (the file is back as it was), and the ones it kept because the
    // user edited the file since (listed by `off`, and here); a backup that cannot be removed is said, never dropped silently
    report.dropped_backups.push(...out.results.filter((r) => r.backup && !r.backup_kept).map((r) => r.backup))
    m.kept_backups = m.kept_backups.filter((k) => {
      try { if (dropBackup(k.backup)) report.dropped_backups.push(k.backup); return false } catch (err) { noted.push({ code: CODE.residue, path: k.backup, reason: `${k.backup}, the backup of ${k.path}, could not be removed (${String((err && err.message) || err)}); remove it by hand` }); return true }
    })
    removeEmptyDirs([backupDir(home)])
    // the autostart unit (4.6 order: after the trust entries, before the CA key): disabled, removed, its wants/ links
    if (unitFile) {
      if (unit) { const r = unit.disable(); if (r && r.code !== 0) failed.push({ code: CODE.unitNotDisabled, path: unitFile.path, reason: `systemctl --user disable failed (${r.err || `exit ${r.code}`}); the unit file is removed all the same, run "systemctl --user daemon-reload" once systemd --user runs` }) }
      try { if (removeOwnedFile(unitFile).result === 'removed') report.removed.push(unitFile.path) } catch (err) { unitLeft = true; report.left.push({ path: unitFile.path, harness: unitFile.harness || null, result: 'error' }); failed.push({ code: CODE.entryNotUndone, path: unitFile.path, reason: `${unitFile.path} could not be removed: ${String((err && err.message) || err)}` }) }
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
    if (report.left.length || report.kept_bundles.length) { // keep exactly what is left; the next uninstall finds it (4.6: the manifest goes last)
      const files = m.files.filter((f) => f.role !== 'ca-key' && f.role !== 'ca-cert' && (f !== unitFile || unitLeft))
      saveManifest(dir, { ...m, complete: false, ...(report.left.length ? { uninstall_left: report.left, uninstalled_at: new Date().toISOString() } : {}), ...(report.kept_bundles.length ? { pending_bundles: true } : {}), planned: [], watched: [], files })
      return report
    }
    removeEmptyDirs(m.dirs.filter((d) => d !== dir)) // e.g. ca/
    fs.rmSync(manifestPath(dir), { force: true }) // the manifest goes last: a second run still finds what the first left
    sweepTemps(manifestPath(dir))
    removeEmptyDirs(m.dirs)
  } else if (purgeData) removeEmptyDirs([dir])
  return report
}
