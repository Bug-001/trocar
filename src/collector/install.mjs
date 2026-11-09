// install.mjs — per-user `trocar on` / `trocar collector install` (RFC 4.6 §安装清单与卸载, §身份与信任「信任注入」,
// D36, D37④; acceptance S10, T10, T11). No sudo: everything lives under the operator's ~/.trocar/collector and in
// the agents' own config entries; the machine-wide helper is `trocar setup-helper` (arch). Nothing here knows a
// harness or an OS: the descriptors declare their entries (`inject`), the caller passes `scan` / `match` (the
// process table) from daemon.mjs. Install lists every file before touching one. The way back — `trocar off` and
// `trocar uninstall` — is src/off/ (the entries, the daemon stop, the lock) and src/cli/uninstall.mjs (1.6 §1.4, R3).
import { retriedNote, SETUP_WHY } from '../cli/words.mjs'
import { UNDO_WORDS, setupBlocked, setupError } from '../cli/receipt.mjs'
import { driverSetup, driverCtx, driverForms } from './driver-setup.mjs'
import { uncapturedOf } from './core/proxymode/sources.mjs'
import { takeEarly } from '../cli/on-start.mjs'
import { entryWords, entryState, AUTOSTART_MISSING } from './net-deps.mjs' // the login entry in the platform's own words: status says it the same way (D61)
import { isModelOs, ruleUFiles } from './model-install.mjs' // macOS / Windows: their on is turnOnModel (src/cli/on-model.mjs); this turnOn is Linux's
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
import { readManifest, saveManifest, newManifest, missingDirs, applyJsonKey, previewJsonKey, applyTextEntry, previewTextEntry, writeOwnedFile, notTrocars, manifestPath, describeEntry, judgeEntry, judgeOwned, sha256, replaceable, retireEntry, inheritDirs, MARKED_WITHOUT_RECORD } from './core/trust/journal.mjs'
import { EVENT, CODE } from './core/codes.mjs'
import { RESTART_REASONS } from '../health/codes.mjs'
import { controlRequest, controlEndpointFor } from '../off/control-client.mjs'
import { appendEvent } from './core/events.mjs'
import { readFlows } from '../health/flows.mjs'
import { runEventWriter } from '../off/events.mjs'
import { hideUserinfoIn } from '../off/userinfo.mjs'
import { backupDir, opLockFile, standalonePath, standaloneFiles } from '../off/paths.mjs'
import { replacedNote } from '../off/backup.mjs'
import { readOrNull } from '../off/fsutil.mjs'
import { userCertsIn } from '../off/pem.mjs'
import { acquireOpLock, LOCK_BUSY, tryOpLock } from '../off/lock.mjs'
import { readStateFile, emptyState, setDesired, writeStateAtomic } from '../off/state.mjs'
import { newReceipt, UNDO_LINE } from '../off/schema.mjs'
import { OFF_VERSION, installComplete, daemonMayStart } from '../off/manifest.mjs'
import { writeStandalone, standaloneDue } from '../off/standalone.mjs'
import { codeId, setupHelperCommand } from '../version.mjs'

// 4.11 P4b: a combined bundle that lacks a CA its harness's settings name NOW (the install shell's among them) is rewritten with it; compared by fingerprint,
// so a plan need not compose it (D62①). Additions only: a CA no longer named stays (an install from another shell must not take away what a working agent trusts)
function caDrift(j, f) {
  if (j.action !== 'skip-intact' || f.role !== 'bundle' || !Array.isArray(f.want_fps) || !j.record || !Array.isArray(j.record.user_fps)) return j
  const had = new Set(j.record.user_fps), now = new Set(f.want_fps)
  return [...now].some((x) => !had.has(x)) ? { action: 'rewrite', record: j.record, why: 'it lacks a CA your settings add now', drift: true } : j
}

// an entry under trocar's name: replaced, never silently (1.6 §3.5 Login)
const isMasked = (unit) => !!(unit && unit.masked && unit.masked())
// the masked unit is the user's link, replaced: a change of a file of theirs (1.6 §3.2), with nothing to back up (a link to /dev/null holds no bytes)
const maskedChange = (unit) => ({ path: unit.path, change: "your link to /dev/null (which masked it) replaced with trocar's unit", backup: null, why_no_backup: 'the link held nothing to keep' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  if (m && m.unsupported) throw new Error(`the install manifest ${manifestPath(dir)} is version ${JSON.stringify(m.version)}, which this build does not read (it reads version 3); nothing was changed. Use the trocar that wrote it`)
}

function refuseRoot(verb, getuid = processUid) {
  if (getuid() === 0) throw new Error(`trocar ${verb === 'on' ? verb : `collector ${verb}`}: run this as your own user, not as root.`)
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
async function recorded(dir, where, fn, result = {}) { // result: what the failed result line carries besides (on's: the harnesses it turned on, none)
  const run = new Date().toISOString()
  try { return await fn(run) } catch (e) {
    const reason = String((e && e.message) || e)
    try {
      if (fs.existsSync(dir)) {
        appendEvent(dir, { event: 'failure', where, code: (e && e.code) || `${where}-error`, reason, run })
        appendEvent(dir, { event: `${where}-note`, kind: 'result', outcome: 'failed', ...result, run, reason: `${where} failed: ${reason}` })
      }
    } catch (w) {
      if (e && typeof e === 'object') e.message += ` (and recording this failure failed: ${String((w && w.message) || w)})` // never mask the original
    }
    throw e
  }
}

// 4.6 §引擎 5: the engine checks an upstream with Node's roots + NODE_EXTRA_CA_CERTS of the daemon's own environment. A daemon
// nothing but a login entry starts has no login shell's exports, so the entry carries this shell's value — an absolute path
// outside trocar's home only; anything else is said, never dropped silently (review 3 #1, D38). A daemon `on` starts directly
// (the fallback when the OS mechanism refuses) is handed exactly the same (ensureDaemonUp → unit.start): without it capture breaks behind a corporate
// MITM relay and nothing says so (review 2026-10-18).
export function daemonEnv(env, dir) {
  const v = env.NODE_EXTRA_CA_CERTS
  if (typeof v !== 'string' || v === '') return { env: {}, note: null }
  const why = !path.isAbsolute(v) ? 'it is a relative path' : v.startsWith(path.dirname(dir) + path.sep) ? "it is trocar's own file" : null
  if (why) return { env: {}, note: `NODE_EXTRA_CA_CERTS of this shell (${v}) is not given to the daemon trocar starts (${why}); that daemon checks a relay's certificate with Node's roots only` }
  return { env: { NODE_EXTRA_CA_CERTS: v }, note: null }
}

// ── `trocar on` (RFC 1.6 §1.6, R6, R9, R12; D39) ────────────────────────────────────────────────────────────────────────────────────────
// `on` is the install: the first one writes the CA, the combined bundles, the entries and the unit; every later one finds what is there and writes
// only what is not. Per planned item the manifest and the disk say which (journal.mjs judgeEntry / judgeOwned): written (new), intact (never
// rewritten — its `installed_at`, inode and mtime stay, or the agents already captured would be judged config-after-start and stop being
// captured), resumed (an intent a crash left), or changed by the user since (reported, left). The order is R9's: what an entry points at (the
// CA, the bundles, plugins, the shim) before the entry, the entries, the unit, and the links last — by the daemon, on `POST /on`.
//   planOn      reads: the plan to print and to judge by (no write, no confirmation)
//   turnOn      the command: plan → confirm → desired state first → write → unit → daemon → receipt
//   installCollector   the install half alone, as the harness and lab tests set an agent up (no state.json, no daemon, no confirmation)

const OP_LOCK_WAIT_MS = 10_000 // 1.6 R12: another state-changing command (an `off`, say) is waited for at most this long
// start failures a relaunch cannot fix (the same Node, the same token): any other one may clear when the OS starts the daemon again, so the wait goes on
const REFUSED_START = new Set(['node-too-old', 'elevated-token', 'root-token', 'root-refused'])
const SLOW_START_MS = 1000 // D62: a start call that blocks longer than this is the OS holding the job back, not trocar working — said in the receipt (D38)
const nodeFs = fs
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const act = (a) => a !== 'skip-intact' && a !== 'skip-user-changed'
const shortLine = (l) => String(l).split(' # ')[0].trim()
const DAEMON_CMD = 'trocar daemon' // 1.6 §2: the autostart unit's ExecStart is this command (units written before the rename run its alias `collector start`)
const UNREADABLE = 'unreadable' // 附录 C.1: an ERROR_CODES receipt code (src/cli/json.mjs), a refusal's, not a D38 record
export { AUTOSTART_MISSING } // 附录 C.1: the code of the refusal below (defined in net-deps.mjs with the entry's words; mirrored by src/cli/json.mjs's ERROR_CODES)
/** D61 / 1.6 §3.3: the login entry is `install`'s and `on` never touches it, so an `on` whose entry is not registered would leave the agents'
 *  rewritten configs pointing at doors that nobody opens after the next login (without it nothing starts after a reboot and no agent can reach a door).
 *  One question per OS, asked of the arch's own autostart unit (`registered()`: launchctl print · schtasks /Query · systemctl --user is-enabled),
 *  so no call site has a platform branch. Anything but a proven `present` — not registered, registered but switched off, or an answer that could not be read — refuses.
 *  → the reason (one English sentence ending in the fix command), or null when the entry is there (or there is no autostart on this platform). */
export function autostartBlock({ unit, osName }) {
  if (!unit) return null
  const q = unit.registered()
  if (q.state === 'present') return null
  // what the next login would undo, in the mode's own terms: the proxy mode points the agents at doors; the driver mode (Linux) writes no agent file, so its agents go direct, uncaptured
  const after = isModelOs(osName) ? 'and the agents trocar points at its doors would all fail to connect' : 'and capture would stop then while trocar still says it is on'
  return `${entryState(osName, unit, q)}: the collector would not start at the next login, ${after}. Nothing was changed. Run: trocar install`
}

// the plan asks only whether the file takes a block; the root's bytes exist once the CA is made (a fresh install), so the preview places a block's shape
const PEM_SHAPE = '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----'

/** What the receipt says an entry did, in one phrase — the same words in the dry run (from the preview) and in the real run (from the entry). */
export function changeText(e, prior = null) {
  if (e.kind === 'text') {
    if (e.format === 'pem-block') return "trocar's certificate block added at the end"
    if (e.vars) return `trocar block added at the top (${Object.keys(e.vars).join(', ')})${prior ? `; your own ${Object.keys(prior).join(', ')} commented out` : ''}`
    return `one line added (${shortLine(e.line)})`
  }
  return prior != null ? `${(e.keys || []).join('.')} set (was ${prior})` : `${(e.keys || []).join('.')} added`
}

// An error that is not a failure of trocar: an `off` asked for while this `on` ran (R12: off wins), or a step that has to stop the run.
const stop = (message, code = null) => Object.assign(new Error(message), { stopsRun: true, ...(code ? { code } : {}) })

/** What `on` would do, read from the disk and the manifest, written nowhere. Refusals come first, so a refused plan writes nothing at all (not even the
 *  manifest): a file that is not JSON, a dangling link, a plugin file already there, a manifest this build cannot read, a CA that cannot be used.
 *  → { first, newPaths, steps, targets, skipped, restart, changed, created, unchanged, manifest, ca, files, owned, entries, unit?, watch, notes,
 *      records, events, _ } — the first fields are what is printed and receipted (`files` / `owned` / `entries` / `unit` only what would be written);
 *  `_` is what the writing needs (the manifest as read, the draft, the roots). `ids`: the harness code ids named, or null for every one found.
 *  The combined bundles' roots are `roots` when given (a test's, an embedder's), else the arch's (tls/roots.mjs bundleRoots: `missing` is said per
 *  bundle by planTrust; a read that fails throws here, before anything is written). */
export async function planOn({ home = os.homedir(), env = process.env, ids = null, osName, harnesses, scan = async () => [], match = () => ({ agent: null }), arch = null, roots = null, unit = null, userFilesFor = null, fs = nodeFs, now = () => new Date(), judge = null, certs = false } = {}) {
  const dir = collectorHome(path.join(home, '.trocar'))
  let prior
  try { prior = readManifest(dir, fs) } catch (e) { // not written over: it is the only list of what trocar changed; `off` has the way back by trocar's own marks (R3)
    throw new Error(`the install manifest cannot be read (${String((e && e.message) || e)}); trocar on does not write over it. Run "trocar off" (it undoes trocar's changes by their marks, after a yes, or at once with --yes); if trocar on still refuses, the file is damaged and nothing else lists what trocar changed: move it aside (mv '${manifestPath(dir)}' '${manifestPath(dir)}.damaged'), then run trocar on`)
  }
  refuseUnsupported(dir, prior)
  if (installComplete(prior)) {
    // installed — but only usable when its CA is (D-4): a CA that cannot be read or used is said, with how to start over
    const c = readCa({ dir: path.join(dir, 'ca'), fs })
    const st = c.error ? { ok: false, which: c.which, reason: c.error } : checkCa(c)
    if (!st.ok) throw Object.assign(new Error(`the collector is installed, but its CA is unusable (${st.which}: ${st.reason}); run "trocar uninstall", then "trocar install", then "trocar on"`), { code: 'ca-invalid' })
  }
  if (prior && prior.pending_bundles) throw new Error(`an earlier uninstall kept combined bundles that running agents still use (${prior.files.filter((f) => f.role === 'bundle' || f.role === 'trust-file').map((f) => f.path).join(', ')}); run "trocar uninstall" again once they exit`)
  if (prior && prior.uninstall_left) throw new Error(`an earlier uninstall could not undo ${prior.uninstall_left.length} item(s) (${prior.uninstall_left.map((l) => l.path).join(', ')}); fix them, run "trocar uninstall" again, then "trocar install", then "trocar on"`)
  // `judge(descs, prior)` → the names held back before anything of theirs is read for writing (on's 1.6 §3.3 ⑪): asked only of a complete install
  const asked = ids ? harnesses.filter((d) => ids.includes(d.name)) : harnesses
  const held = new Set(judge && installComplete(prior) ? judge(asked, prior) : [])
  const kept = asked.filter((d) => !held.has(d.name))
  const ca = caPaths(path.join(dir, 'ca'))
  const facts = await scan()
  const userFiles = userFilesFor ? userFilesFor({ os: osName, home, env: new Map(Object.entries(env).filter(([, v]) => typeof v === 'string')), fs }) : null // rule U's finder (arch/model-backends.mjs), handed in by the caller
  const ctxFor = (d) => ({ ...driverCtx({ os: osName, home, env, fs, running: facts.filter((f) => match(f).agent === d.name).map((f) => f.env || new Map()) }), userFiles }) // the one inject ctx (status and on's setup judgement read the same)
  // only a harness whose own footprint is here gets carriers, and only it joins install.harnesses (4.6 「这个 harness 装好了没有」); one already in the
  // manifest stays a target below, its carriers kept until uninstall
  let descs = kept.filter((d) => driverForms(d, ctxFor(d)).length)
  const R = roots || await bundleRoots(arch)
  let draft = planTrust({ descriptors: descs, ctxFor, caCertPem: null, collectorDir: dir, roots: R })
  // marked text no record lists (1.6 §3.2), over every harness's files BEFORE any harness is dropped below, so the refusal names them all;
  // any other per-file refusal is left to the preview further down, which throws it for the harnesses still planned
  const marked = [...new Set(draft.entries.filter((e) => judgeEntry({ manifest: prior, planned: e, fs }).action === 'write').map((e) => {
    try { if (e.kind === 'text') previewTextEntry({ file: e.path, edit: e, fs }); else previewJsonKey({ file: e.path, keys: e.keys, value: e.value, fs }); return null } catch (err) { return err && err.code === MARKED_WITHOUT_RECORD ? err.path : null }
  }).filter(Boolean))]
  if (marked.length) throw Object.assign(new Error(`${marked.length === 1 ? 'this file holds' : 'these files hold'} trocar's text from an earlier install whose record is gone, so nothing was changed. The line below takes it out by trocar's own marks; then run this command again.`), { code: MARKED_WITHOUT_RECORD, paths: marked })
  // 4.11 P4: an owned file the manifest does not list that would land on someone else's file (notTrocars) skips its harness whole, before
  // anything is written (D38); the plan is made again without it, so nothing of that harness is written, the other harnesses are
  const foreign = draft.owned.filter((o) => judgeOwned({ manifest: prior, file: o.path, fs }).action === 'write').map((o) => ({ harness: o.harness, what: o.path, reason: notTrocars({ dir, file: o.path, fs }) })).filter((x) => x.reason)
  if (foreign.length) {
    descs = descs.filter((d) => !foreign.some((x) => x.harness === d.name))
    draft = planTrust({ descriptors: descs, ctxFor, caCertPem: null, collectorDir: dir, roots: R })
  }
  // `on` (a judge is handed in): a harness one of whose own files cannot take its entry (not JSON, a dangling link) is refused alone, planned again
  // without it, so it stops nothing else (1.6 §3.3 ⑪, D38); `install` keeps the whole-run refusal of the preview below
  const unwritable = []
  if (judge) for (const e of draft.entries) {
    if (unwritable.some((x) => x.harness === e.harness) || judgeEntry({ manifest: prior, planned: e, fs }).action !== 'write') continue
    try { if (e.kind === 'text') previewTextEntry({ file: e.path, edit: e, fs }); else previewJsonKey({ file: e.path, keys: e.keys, value: e.value, fs }) } catch (err) { unwritable.push({ harness: e.harness, what: e.path, reason: String((err && err.message) || err) }) }
  }
  if (unwritable.length) {
    descs = descs.filter((d) => !unwritable.some((x) => x.harness === d.name))
    draft = planTrust({ descriptors: descs, ctxFor, caCertPem: null, collectorDir: dir, roots: R })
  }
  const daemon = unit ? daemonEnv(env, dir) : null
  if (daemon && daemon.note) draft.notes.push(daemon.note)
  // a form trocar cannot capture whose places are here: said for every harness asked, its own footprint here or not, refused or not (4.6 「不采的形态」, D38)
  const unseen = asked.flatMap((d) => uncapturedOf(d, ctxFor(d)).map((u) => ({ harness: d.name, code: CODE.harnessNote, reason: `${d.name}: ${u.why} (${u.paths.join(', ')})` })))
  draft.notes.push(...unseen.map((r) => r.reason)) // not in draft.records: those are the reasons a harness is skipped


  // per item: written, intact, resumed, or changed by the user since (R9)
  const steps = []
  // install (certs) places again a carrier item that is gone or changed (`replaceable`): planned as new, its preview said when it cannot be (D38)
  const previewOf = (e) => (e.kind === 'text' ? previewTextEntry({ file: e.path, edit: e.format === 'pem-block' && !e.pem ? { ...e, pem: PEM_SHAPE } : e, fs }) : previewJsonKey({ file: e.path, keys: e.keys, value: e.value, fs }))
  const entryJ = draft.entries.map((e) => {
    let j = judgeEntry({ manifest: prior, planned: e, fs })
    if (certs && replaceable(j)) { try { previewOf(e); j = { action: 'rewrite', entry: null, why: j.why } } catch (err) { j = { ...j, why: `${j.why}; trocar install cannot place it again (${String((err && err.message) || err)})` } } }
    steps.push({ harness: e.harness, path: e.path, kind: 'entry', action: j.action, ...(j.why ? { why: j.why } : {}) })
    return j
  })
  // every per-file refusal too, for what is to be written (a dangling link, a file that is not JSON, a patch file that is not a list) — before onPlan, before any write
  const preview = draft.entries.map((e, i) => (entryJ[i].action !== 'write' && entryJ[i].action !== 'rewrite' ? null : previewOf(e)))
  const drift = []
  const fileJ = draft.files.map((f) => {
    const j = caDrift(judgeOwned({ manifest: prior, file: f.path, fs }), f)
    if (j.drift) drift.push(`${f.harness}: ${f.path} is written again: ${j.why}`) // said in the plan and the receipt (D38)
    steps.push({ harness: f.harness, path: f.path, kind: f.role, action: j.action, ...(j.why ? { why: j.why } : {}) })
    return j
  })
  const ownedJ = draft.owned.map((o) => {
    const j = judgeOwned({ manifest: prior, file: o.path, fs })
    steps.push({ harness: o.harness, path: o.path, kind: o.role, action: j.action, ...(j.why ? { why: j.why } : {}) })
    return j
  })
  const unitJ = unit ? judgeOwned({ manifest: prior, file: unit.path, planned: sha256(Buffer.from(unit.text(daemon.env))), fs }) : null
  // 4.11 P4: a unit under trocar's fixed name the record does not list is trocar's: replaced, its bytes backed up first (writeOwnedFile)
  const unitWhy = unitJ && unitJ.action === 'write' && fs.existsSync(unit.path) && !isMasked(unit) ? `${unit.path}: ${replacedNote(backupDir(home))}` : unitJ && unitJ.why
  if (unitJ) steps.push({ harness: null, path: unit.path, kind: 'unit', action: unitJ.action, ...(unitWhy ? { why: unitWhy } : {}) })

  // who is on, and who has nothing to do here (no entry, no file, not installed before): said, with the descriptor's own reason
  const installed = new Set([...((prior && prior.entries) || []), ...((prior && prior.files) || [])].map((x) => x.harness).filter(Boolean))
  const withItems = new Set([...draft.entries, ...draft.files, ...draft.owned].map((x) => x.harness))
  const targets = kept.map((d) => d.name).filter((n) => !unwritable.some((x) => x.harness === n) && (withItems.has(n) || installed.has(n)))
  const reasonOf = (name) => draft.records.filter((r) => r.harness === name).map((r) => r.reason.replace(`${name}: `, '')).join('; ') || `no ${name} configuration was found on this machine: nothing to change for it`
  const hint = new Set(certs ? [] : draft.entries.filter((e, i) => replaceable(entryJ[i])).map((e) => e.path))
  const skipped = [
    ...foreign.map((x) => ({ what: x.what, reason: x.reason })),
    ...kept.map((d) => d.name).filter((n) => !targets.includes(n) && !foreign.some((x) => x.harness === n) && !unwritable.some((x) => x.harness === n)).map((n) => ({ what: n, reason: reasonOf(n) })),
    ...steps.filter((s) => s.action === 'skip-user-changed').map((s) => ({ what: s.path, reason: hint.has(s.path) ? `${s.why}; run "trocar install" to place it again` : s.why })), // a certificate item install can place again (replaceable): on never does (D55⑥), so it names the fix
  ]
  // what is written, and what the user has not yet confirmed (1.6 §1.6: the paths beyond the manifest's `confirmed_paths`; an installed one counts as confirmed)
  const known = new Set([...((prior && prior.confirmed_paths) || []), ...((prior && prior.entries) || []).map((x) => x.path), ...((prior && prior.files) || []).filter((x) => x.role !== 'ca-key' && x.role !== 'ca-cert').map((x) => x.path)])
  const first = known.size === 0
  const newPaths = steps.filter((s) => act(s.action) && s.kind !== 'unit' && !known.has(s.path)).map((s) => s.path)
  const writing = steps.some((s) => act(s.action))
  const touched = new Set(steps.filter((s) => act(s.action) && s.harness).map((s) => s.harness))
  const restart = facts.map((f) => ({ f, agent: match(f).agent })).filter((x) => x.agent && touched.has(x.agent)).map((x) => ({ harness: x.agent, pid: x.f.pid })) // what is running now was started before its entry
  const entryRow = (e, i) => ({ harness: e.harness, path: e.path, ...(preview[i] && preview[i].real_path ? { real_path: preview[i].real_path } : entryJ[i].entry && entryJ[i].entry.real_path ? { real_path: entryJ[i].entry.real_path } : {}), ...(e.kind === 'text' ? { what: describeEntry(e) } : { keys: e.keys, value: hideUserinfoIn(e.value) }) }) // a row is shown, never a URL's password (1.6 §1.2); the entry written keeps the value
  const day = now().toISOString().slice(0, 10)
  const caNew = !(fs.existsSync(ca.key) && fs.existsSync(ca.pem))
  const runDir = path.join(dir, 'run', 'trust')
  // D46: the daemon's log files the unit's write makes (a dry run names them too — the receipt lists every file the real run writes, V3); once they exist a later on lists none of them
  const logs = unit && typeof unit.logFiles === 'function' ? unit.logFiles().filter((f) => !fs.existsSync(f.path)).map((f) => f.path) : []
  return {
    first, newPaths, steps, targets, skipped, foreign, unwritable, restart, writing, installed: [...installed],
    changed: [...draft.entries.map((e, i) => ({ e, j: entryJ[i], i })).filter((x) => act(x.j.action)).map((x) => ({ path: x.e.path, change: changeText(x.e, x.j.entry ? x.j.entry.prior_value : preview[x.i].prior), backup: null })), ...(isMasked(unit) ? [maskedChange(unit)] : [])],
    created: [...(prior ? [] : [manifestPath(dir)]), ...(caNew ? [ca.key, ca.pem] : []), ...steps.filter((s) => act(s.action) && s.kind !== 'entry' && !(isMasked(unit) && s.path === unit.path)).map((s) => s.path), ...logs],
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
    ...(unit && act(unitJ.action) ? { unit: { path: unit.path, env: daemon.env, links: unit.links || [], ...(isMasked(unit) ? { masked: true } : {}) } } : {}),
    ...(logs.length ? { logs } : {}), // D46: named in the plan's own listing (every file, R3), written by the unit's write step
    watch: draft.watch,
    notes: [...draft.notes, ...drift],
    uncaptured: unseen.map((r) => r.reason), // said by an install that has nothing to write too
    records: path.join(dir, 'flows'), // install notes are kept here as install-note events (D38)
    events: path.join(dir, 'flows', `${day}.ndjson`), // install-note lines are appended here (D-28)
    _: { dir, prior, ca, descs, ctxFor, R, daemon, draft, unit, unseen, drift },
  }
}

// A fresh liveness record with the `match` patterns of the one already recorded kept — its `identity`, or the `signature` an older trocar wrote (4.6
// 判活快照: united with what is recorded) —: each pattern once (by its JSON text), sorted by it.
export function unitedLiveness(old, fresh) {
  const was = patternsOf(old)
  const prev = was && Array.isArray(was.match) ? was.match : []
  const byText = new Map([...prev, ...fresh.identity.match].map((p) => [JSON.stringify(p), p]))
  const match = [...byText.keys()].sort().map((k) => byText.get(k))
  return { ...fresh, identity: { ...fresh.identity, match } }
}

// The manifest the writing starts from: the one on disk, or — the first time — a new one that lists the directories trocar is about to create and
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
async function writeInstallSteps({ dir, home, plan, m, osName, harnesses, freePort, now, fs, guard = () => {}, confirmed = false, certs = true, keepCode = false }, written) {
  const { ca, descs, ctxFor, R, daemon, draft, unit, unseen, drift } = plan._
  const body = () => JSON.stringify(m)
  let saved = body()
  const save = () => { if (body() !== saved) { saveManifest(dir, m, fs); saved = body() } }
  guard()
  const caThere = fs.existsSync(ca.key) && fs.existsSync(ca.pem)
  if (!certs && !caThere) throw stop('the collector CA is not there; run trocar install (on never makes it, D55⑤)')
  const { certPem } = loadOrCreateCa({ dir: ca.dir, fs })
  written.caCreated = !caThere
  if (m.engine_port == null) m.engine_port = await freePort()
  const final = planTrust({ descriptors: descs, ctxFor, caCertPem: certPem, collectorDir: dir, roots: R })
  if (daemon && daemon.note) { final.notes.push(daemon.note); final.records.push({ code: CODE.unitEnvNotCarried, reason: daemon.note }) }
  for (const r of unseen) { final.notes.push(r.reason); final.records.push(r) }
  final.notes.push(...drift)

  if (JSON.stringify(final.paths) !== JSON.stringify(draft.paths)) throw new Error(`the files to change moved while installing (${draft.paths.join(', ')} → ${final.paths.join(', ')}); only the CA was written; run "trocar uninstall", then "trocar install", then "trocar on"`)
  m.planned = final.paths
  // what `off` needs to judge, from this manifest alone, which live process may hold what trocar wrote for a harness (4.6 撤销顺序): written before any user
  // file changes. `identity` is the name list of now (presets + agents.json) united with the one already recorded: a name that has left the list since
  // may still be running a process that read trocar's file, so it is never dropped (4.6 「判活快照」); `exclude` / `longLived` are the new ones. The key
  // an older trocar wrote, `signature`, goes (a record is rewritten whole). The same inputs give the same bytes: a second `on` saves nothing (D54)
  const named = new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))
  const touched = new Set([...final.entries, ...final.files, ...final.owned].map((x) => x.harness))
  const agentList = readAgentList({ home, fs }).entries
  for (const d of harnesses) if (touched.has(d.name) || named.has(d.name)) m.liveness[d.name] = unitedLiveness(m.liveness[d.name], livenessOf(d, { agentList }))
  const seen = new Set((m.watched || []).map((w) => w.path)) // `existed_before` was recorded when trocar first came: a path an agent wrote since is not "there before"
  m.watched = [...(m.watched || []), ...final.watch.filter((w) => !seen.has(w.path)).map((w) => ({ ...w, existed_before: fs.existsSync(w.path) }))]
  save()
  fs.mkdirSync(path.join(dir, 'run', 'trust'), { recursive: true, mode: 0o700 }) // plugins write their marker here, daemon up or not
  const certItem = (p) => { if (certs) return false; written.needInstall.push(p); return true } // on (certs:false) writes no certificate item: a missing one is install's (D55①)
  for (const f of final.files) {
    const j = caDrift(judgeOwned({ manifest: m, file: f.path, fs }), f)
    if (j.action === 'skip-intact') { written.intact.push(f.path); continue }
    if (certItem(f.path)) continue
    guard()
    // a bundle that gains a CA keeps the ones it already carries (additions only): its recorded user CAs, read back from the bundle itself
    const b = j.drift ? f.compose(userCertsIn(readOrNull(fs, f.path), j.record.user_fps)) : f.role === 'bundle' ? { data: f.data, user_fps: f.user_fps, roots_fp: f.roots_fp } : { data: f.data }
    writeOwnedFile({ dir, manifest: m, harness: f.harness, role: f.role, phase: 'install', file: f.path, data: b.data, sources: f.sources, extra: f.role === 'bundle' ? { user_fps: b.user_fps, roots_fp: b.roots_fp } : {}, now: now(), fs })
    written.files.push(f.path)
  }
  // a plugin or shim exists before the entry that loads it (a dsh patch row naming a missing file only warns, still)
  for (const o of final.owned) {
    const j = judgeOwned({ manifest: m, file: o.path, fs })
    if (j.action === 'skip-intact') { written.intact.push(o.path); continue }
    if (certItem(o.path)) continue
    guard()
    writeOwnedFile({ dir, manifest: m, harness: o.harness, role: o.role, phase: 'install', file: o.path, data: o.data, mode: o.mode, now: now(), fs })
    written.owned.push(o.path)
  }
  const entrySteps = plan.steps.filter((s) => s.kind === 'entry') // planOn pushed one per draft entry, in order; final.paths == draft.paths (checked above)
  for (const [i, e] of final.entries.entries()) {
    const j = judgeEntry({ manifest: m, planned: e, fs })
    if (j.action === 'skip-intact') { written.intact.push(e.path); continue }
    const step = entrySteps[i]
    const again = certs && replaceable(j) && !!step && step.harness === e.harness && step.path === e.path && step.action === 'rewrite' // this very item, as the plan said
    if (!certs && j.unreadable) continue // on writes no certificate item: one it cannot read is setup `unknown` (4.11 P4b), said by the plan's note, not "changed"
    if (j.action === 'skip-user-changed' && !again) { written.userChanged.push({ path: e.path, why: j.why }); continue }
    if (certItem(e.path)) continue
    guard()
    const retired = j.action === 'skip-user-changed' ? retireEntry({ dir, manifest: m, entry: j.entry, now: now(), fs }) : null // placed again as a new entry (planOn planned it so)
    const entry = e.kind === 'text'
      ? applyTextEntry({ dir, manifest: m, harness: e.harness, phase: 'install', file: e.path, edit: e, home, now: now(), fs }) // a backup of the file first (1.6 R2): no backup, no change
      : applyJsonKey({ dir, manifest: m, harness: e.harness, phase: 'install', file: e.path, keys: e.keys, value: e.value, home, now: now(), fs })
    if (entry && retired) inheritDirs({ dir, manifest: m, entry, from: retired, fs })
    if (entry) written.entries.push(entry)
  }
  // the per-user autostart unit (arch: systemd --user on Linux), listed like every other file. The manifest is complete before the unit starts the
  // daemon, which refuses an incomplete one (review 3 #8).
  if (unit) {
    const text = unit.text(daemon.env)
    const j = judgeOwned({ manifest: m, file: unit.path, planned: sha256(Buffer.from(text)), fs })
    if (isMasked(unit)) fs.rmSync(unit.path) // the link, not what it points at
    if (j.action !== 'skip-intact') { guard(); writeOwnedFile({ dir, manifest: m, role: 'unit', phase: 'install', file: unit.path, data: text, mode: 0o644, home, now: now(), fs }); written.unit = j.action }
    // D46: the daemon's own log sinks the unit names — directory 0700, two files 0600, made here at unit-write time and listed in the manifest like
    // every file trocar owns; NEVER rewritten afterwards (a later on only lists what the manifest does not know yet, so no log line is ever truncated)
    if (typeof unit.ensureLogs === 'function') { guard(); unit.ensureLogs() }
    if (typeof unit.logFiles === 'function') for (const lf of unit.logFiles()) {
      if (!(m.files || []).some((x) => x.path === lf.path)) { writeOwnedFile({ dir, manifest: m, role: 'daemon-log', phase: 'install', file: lf.path, data: '', mode: 0o600, now: now(), fs }); written.files.push(lf.path) }
    }
  }
  // D55: install's own record (before P10 the `on` that writes the certificates sets it): kept as it is once complete, so a second `on` saves nothing (D54).
  // `code` is the code that ran install (1.6 §5.5: an npm copy's update finishes until it is this code): install (certs) writes it, `on` keeps install's
  const names = [...new Set([...((m.install && m.install.harnesses) || []), ...descs.map((d) => d.name)])].sort()
  const ran = certs && !keepCode ? codeId() : installComplete(m) ? m.install.code : undefined // keepCode: the board's Set up is not an install run (4.6)
  if (!installComplete(m) || JSON.stringify(names) !== JSON.stringify(m.install.harnesses) || ran !== m.install.code) m.install = { state: 'complete', at: installComplete(m) ? m.install.at : now().toISOString(), pending: [], harnesses: names, ...(ran ? { code: ran } : {}) }
  if (confirmed) m.confirmed_paths = [...new Set([...(m.confirmed_paths || []), ...final.paths, ...(unit ? [unit.path] : [])])] // what the operator was shown and said yes to (1.6 §1.6)
  save()
  return { manifest: m, final, written }
}

// 4.6 安装 / 卸载不静默 (D-28): everything the command prints is also an install-note in flows/, for the board, where status finds it; a line that cannot
// be written is added to the printed notes, never dropped, and never fails the run. → the `put` the caller writes more with.
function noteRun({ dir, run, final, written, notes, fs, log = null }) {
  const put = runEventWriter({ dir, base: { run }, notes, fs, ...(log ? { log } : {}) }) // a line that cannot be written: stderr first, the receipt's notes, then a `log-gap` when one can again (R11)
  for (const e of written.entries.filter((x) => x.prior_value)) {
    const prior = e.keys ? `${e.path} ${e.keys.join('.')} was ${e.prior_value}; it now points at ${e.value}` : `${e.path} held ${Object.entries(e.prior_value).map(([k, v]) => `${k}=${v}`).join(', ')}; trocar commented it out (uninstall restores it)`
    put({ event: EVENT.installNote, where: 'install', kind: 'prior-value', harness: e.harness, path: e.path, reason: prior })
  }
  for (const r of final.records) put({ event: EVENT.installNote, where: 'install', kind: 'note', ...r })
  return put
}

// The legacy shape of the install half: what the harness tests, the test rigs and `collector install` (before `on`) call. Never a confirmation, never state.json;
// `already` says every file item was in place (no onPlan, nothing written). A unit is enabled with `unit.enable()` (enable --now) on EVERY run, `already` or not:
// a login entry switched off or never registered since (no systemd --user at the first install) is what a second install puts back — the fix line of `on`'s
// autostart-missing (1.6 §3.2 补装, §3.3) — and a registration that fails is a problem of the run (`daemon.problems`, exit 1), never only a note.
// 4.11 P4: the carriers left off someone else's file, each with a failure line in flows/ (D38) → the receipt's `skipped` rows
function foreignRows(plan, put) {
  for (const x of plan.foreign) put({ event: EVENT.failure, where: 'install', code: CODE.notTrocarsFile, harness: x.harness, path: x.what, reason: x.reason })
  return plan.foreign.map((x) => ({ what: x.what, reason: x.reason }))
}

export async function installCollector({ home = os.homedir(), ...opts } = {}) {
  refuseRoot('install')
  const dir = collectorHome(path.join(home, '.trocar'))
  return recorded(dir, 'install', async (run) => {
    const fs = opts.fs || nodeFs
    const now = opts.now || (() => new Date())
    const plan = await planOn({ home, ...opts, certs: true }) // install's plan places a gone or changed certificate item again (replaceable)
    // D61: the login registration and the daemon, through the one seam every command uses — so Linux's install probes before it starts too
    // (拉起不是重启, R8: a daemon someone started by hand is never started a second time), and no `--now` is issued blind.
    const register = (put, reload) => (opts.unit ? ensureDaemonUp({ osName: opts.osName, dir, env: opts.env || process.env, fs, unit: opts.unit, register: true, reload, put, ...(opts.request ? { request: opts.request } : {}), ...(opts.socketPath ? { socketPath: opts.socketPath } : {}), ...(opts.sleep ? { pause: opts.sleep } : {}) }) : null)
    if (installComplete(plan._.prior) && !plan.writing) {
      const entryBefore = opts.unit && typeof opts.unit.registered === 'function' ? opts.unit.registered().state : null // the receipt's head: "nothing was changed" only if the entry was there
      const put = runEventWriter({ dir, base: { run }, notes: [], fs })
      for (const r of plan._.unseen) put({ event: EVENT.installNote, where: 'install', kind: 'note', ...r }) // every install records it (4.6 「不采的形态」)
      const dmn = await register(put, false)
      // a run that put the entry back or started the daemon changed something: its result is on record like any install's (1.6 §1.2)
      if (dmn && (dmn.started || (entryBefore && entryBefore !== 'present'))) put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome: dmn.problems.length ? 'partial' : 'installed', reason: `the certificates were in place; the login entry was ${entryBefore}${dmn.started ? ' and the collector was started' : ''}${dmn.problems.length ? `; not done: ${dmn.problems.join('; ')}` : ''}` })
      // nothing to write but the record of which code ran install, when that is another code (1.6 §5.5): an npm copy's update finishes until it says this one
      if (!opts.keepCode && plan._.prior.install.code !== codeId()) { plan._.prior.install = { ...plan._.prior.install, code: codeId() }; saveManifest(dir, plan._.prior, fs) }
      return { already: true, entryBefore, manifest: plan._.prior, plan: null, daemon: dmn, skipped: foreignRows(plan, put) }
    }
    const onPlan = opts.onPlan || (() => {})
    onPlan(plan)
    const m = openManifest({ dir, plan, now, fs })
    const { manifest, final, written } = await writeInstall({ dir, home, plan, m, osName: opts.osName, harnesses: opts.harnesses, freePort: opts.freePort || freeEnginePort, now, fs, keepCode: !!opts.keepCode })
    const put = noteRun({ dir, run, final, written, notes: final.notes, fs })
    const skipped = foreignRows(plan, put)
    const dmn = await register(put, written.unit === 'rewrite')
    if (dmn) for (const n of dmn.notes) if (!final.notes.includes(n) && !dmn.problems.includes(n)) final.notes.push(n) // a problem is said once, as a problem (附录 C.1)
    const counts = { entries: manifest.entries.length, files: manifest.files.filter((f) => f.role === 'trust-file').length, notes: final.notes.length }
    put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome: dmn && dmn.problems.length ? 'partial' : 'installed', counts, reason: `installed: ${counts.entries} trust entr${counts.entries === 1 ? 'y' : 'ies'} and ${counts.files} trust file(s) written, ${counts.notes} note(s)${dmn && dmn.problems.length ? `; not done: ${dmn.problems.join('; ')}` : ''}` })
    return { already: false, manifest, plan: final, daemon: dmn, skipped }
  })
}

/** `trocar on` (1.6 §1.1, §1.6, R1, R6, R9, R12): plan → confirm → desired state first → write → unit → daemon → receipt. Library form of the command: `runOnCli`
 *  (src/cli/on.mjs) parses the arguments and prints; everything the world gives is injected (`fs`, `request`, `now`, `getuid`, `helperState`, `linger` / `lingerRead`,
 *  `sleep`), so a test runs it in a sandbox HOME. Refuses root by throwing (R7); everything else is a receipt: `exit` 0 done · 1 not done or a problem ·
 *  2 not in a terminal without a yes (the plan is in the receipt, nothing was written).
 *    ids        harness code ids, or null for every one found   confirm(plan) → true | false | null (null: nobody can be asked)   onPlan(plan): print it
 *    unit       the autostart unit (arch/linux/unit.mjs userUnit), or null (no autostart on this platform); `on` never writes or enables it (D61: it is install's) — it is handed in only to start the daemon when none answers
 *    request    the control socket's client (default: controlRequest at $XDG_RUNTIME_DIR/trocar/collector.sock, or `socketPath`)
 *    arch       the arch, asked for the combined bundles' OS roots (planOn)   roots  overrides them
 *  → { receipt, manifest, plan, exit }. */
export async function turnOn(opts = {}) {
  const { home = os.homedir(), env = process.env, ids = null, osName, harnesses, scan, match, arch = null, roots = null, unit = null, userFilesFor = null, freePort = freeEnginePort, onPlan = () => {}, confirm = null, dryRun = false, networkEdited = null, request = null, now = () => new Date(), fs = nodeFs, getuid, helperState = null, linger = null, lingerRead = null, socketPath = null, sleep: pause = sleep, user = null, lockWaitMs = OP_LOCK_WAIT_MS } = opts
  refuseRoot('on', getuid)
  const dir = collectorHome(path.join(home, '.trocar'))
  const stateF = path.join(dir, 'state.json')
  const username = (() => { try { return user || os.userInfo().username } catch { return String(env.USER || '') } })()
  const fresh = () => ({ ...newReceipt('on'), refused: [], user: username, relayed: { closing: 0, waiting: 0, cut: 0 }, undo: UNDO_LINE.on, standalone: standalonePath(home), commands: ['trocar on', 'trocar off', 'trocar status', 'trocar uninstall'], log: path.join(dir, 'flows') }) // on relays nothing: zeros on purpose; `undo` is the ONE line that undoes an on (C.1), and the four commands are what V29 asks the first receipt to carry
  // A receipt of a run that wrote nothing and could not go on: no change, no file made, and no way to undo or log to point at — what is not there (R1: the receipt is what was done).
  // `commands` (the four a user types) stay: they are true whether or not this run wrote anything.
  const unwritten = (r) => { const { standalone: _unwritten, ...rest } = r; return { ...rest, changed: [], created: [], undo: null, log: null } }
  // The helper (D36) is what the real `on` needs and the plan does not: a missing one stops the real run before anything is written, but `--dry-run` still shows the plan — it is what
  // a user reads before deciding to `sudo trocar setup-helper` — and exits 0 (R6, V7) with the stop said in the receipt (`blocked`).
  // C.1 blocked[].command: the sudo line is the stop's own command, printed whole on its own line under the note (1.6 §1.1⑥)
  let helperBlock = null, helperStop = null
  if (helperState) {
    const h = await helperState()
    if (h && h.ok === false) {
      helperBlock = `the capability helper is missing or not the right version (${h.reason || 'not usable'})`
      helperStop = { what: 'trocar on', reason: `${helperBlock}; nothing was changed. Install it with the line below, then run trocar on again`, command: setupHelperCommand() }
    }
  }
  if (helperBlock && !dryRun) return { receipt: unwritten({ ...fresh(), ok: false, notes: [helperStop.reason], blocked: [helperStop] }), manifest: null, plan: null, exit: 1 }
  // D61 / 1.6 §3.3: the login entry is `install`'s, so an `on` with none would open doors that nobody opens after the next login
  // (without the login registration, a reboot after `on` leaves every agent unusable). Asked here, before the first write; a `--dry-run` goes on and carries it in `blocked`.
  const autostartBlk = dryRun ? null : autostartBlock({ unit, osName })
  if (autostartBlk) return { receipt: unwritten({ ...fresh(), ok: false, notes: [autostartBlk], blocked: [{ what: 'trocar on', reason: autostartBlk }], error: { code: AUTOSTART_MISSING, message: autostartBlk } }), manifest: null, plan: null, exit: 2 }
  // D62 ①: the daemon is asked for now, and its start asked when nothing answers, so it comes up while the plan below is read; ensureDaemonUp
  // takes this answer and reports the start as before. A run that stops before then leaves that daemon with what state.json already had on:
  // the daemon a login starts (no harness on: no helper, nothing steered, 4.6 「助手还没装」)
  // only a daemon that will run (its own gate, 1.6 §5.2): without an install record it refuses, and on refuses below with cert-not-installed
  const mayStart = (() => { try { return daemonMayStart(readManifest(dir, fs)) } catch { return false } })()
  const early = dryRun || !mayStart ? null : await kickDaemon({ osName, dir, env, fs, unit, socketPath, request, pause })
  // `lingerRead()` → { state, error? } (src/collector/arch/linux/redirector.mjs) says why when it cannot be read; `linger()` → true | false | null is the older form
  const lingerNow = () => { try {
    if (lingerRead) { const r = lingerRead(); return r.state === true || r.state === false ? { linger: r.state } : { linger: 'unknown', linger_reason: r.error || 'the linger state could not be read' } }
    const v = linger ? linger() : undefined
    return v === true || v === false ? { linger: v } : { linger: 'unknown', linger_reason: linger ? 'the linger state could not be read (/var/lib/systemd/linger)' : 'nothing reads it here' }
  } catch (e) { return { linger: 'unknown', linger_reason: String((e && e.message) || e) } } }
  return recorded(dir, 'install', async (run) => {
    // 1.6 §3.3 前提 ⑪ (D65④, 4.6「这个 harness 装好了没有」): a harness whose setup is needed is refused alone, judged before planOn reads its files, so
    // not one byte is planned or written for it (no desired on, not in POST /on) and nothing of its own stops the others; the judgement reads the manifest
    // planOn read, as `status` does (V91). `unknown` goes on with a note. macOS / Windows judge it in turnOnModel.
    const refused = [], setupNotes = []
    const judge = isModelOs(osName) ? null : (descs, prior) => descs.filter((d) => {
      const s = driverSetup(d, { os: osName, home, env, manifest: prior, fs })
      if (s.state === 'unknown') setupNotes.push(`whether ${d.name} is set up could not be told (${s.reason})`)
      if (s.state !== 'needed') return false
      refused.push({ harness: d.name, reason: CODE.setupNeeded, why: [...new Set(s.missing.map((x) => SETUP_WHY[x.what]))].join('; '), command: 'trocar install' })
      return true
    }).map((d) => d.name)
    const plan = await planOn({ home, env, ids, osName, harnesses, scan, match, arch, roots, unit: null, userFilesFor, fs, now, judge }) // D61: the login entry is `install`'s and `on` never writes it, so the writing side is handed no unit at all
    for (const x of plan.unwritable || []) refused.push({ harness: x.harness, reason: CODE.configUnreadable, why: x.reason }) // its own file cannot take the entry: refused alone
    // D55⑥ / override #15: `on` never writes a certificate, so it never installs silently — no install record, no on (macOS / Windows: turnOnModel)
    // 附录 C.1: the refusal's code lives in `error`, the one place a client looks (never a top-level `code`)
    if (!isModelOs(osName) && !installComplete(plan._.prior)) { const message = 'certificates are not installed. Run: trocar install'; return { receipt: unwritten({ ...fresh(), ok: false, error: { code: CODE.certNotInstalled, message }, notes: [message] }), manifest: plan._.prior, plan, exit: 1 } }
    const setupBlk = setupBlocked({ refused })
    // 附录 C.1: the setup refusal's error when there is one; a harness refused only for its own file is that file's error, never "run install"
    const refusedError = () => (setupBlk.length ? setupError(setupBlk) : { code: UNREADABLE, message: refused.map((x) => `${x.harness}: ${x.why}`).join('; ') })
    if (refused.length && !plan.targets.length) { // nothing left to turn on: a real run still leaves its result line (1.6 §1); a dry run changes nothing
      const r0 = unwritten({ ...fresh(), ok: !!dryRun, harnesses: [], refused, blocked: setupBlk, skipped: plan.skipped, notes: [...plan.uncaptured, ...setupNotes], ...(dryRun ? { dry_run: true } : { error: refusedError() }) })
      if (dryRun) return { receipt: r0, manifest: plan._.prior, plan, exit: 0 }
      const put = noteRun({ dir, run, final: { records: plan._.unseen }, written: { entries: [] }, notes: r0.notes, fs, log: opts.log })
      put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome: 'failed', harnesses: [], refused: refused.map((x) => x.harness), reason: `on did not finish: ${r0.error.message}` })
      return { receipt: { ...r0, log: path.join(dir, 'flows') }, manifest: plan._.prior, plan, exit: 1 }
    }
    // the copy of the undo side that needs no source tree (R3) is one more file trocar writes: listed in the plan and the dry run when it is missing or not what src/off generates now
    let due
    try { due = standaloneDue({ home, version: OFF_VERSION, platform: osName, fs }) } catch { due = standaloneFiles(home, osName) } // a copy that cannot be read is said by the write below
    if (due.length) { plan.created = [...plan.created, ...due]; plan.standalone = due } // every file of it (standaloneFiles), each a plan row
    // A version 1 file (what `collector on|off` wrote before D39) is read for the harnesses installed before and the ones this run turns on, the same set
    // the guard below reads it for — and is written back as version 2 here, before the first guard: the guard must never see a file the daemon's reader
    // and this one read differently (1.6 §1.5, R12)
    const known = [...new Set([...plan.installed, ...plan.targets])]
    const readState = () => readStateFile(stateF, { fs, installed: known, now: now() })
    const stateRead = (() => { try { return { ...readState(), error: null } } catch (e) { return { state: emptyState(), from: null, error: e } } })()
    const need = plan.targets.filter((id) => !(stateRead.state.harnesses[id] && stateRead.state.harnesses[id].desired === 'on'))
    const stateWrite = need.length > 0 || stateRead.from === 1 // an unreadable file is `need` too: every target is not on
    const r = { ...fresh(), ...(osName === 'win32' || osName === 'darwin' ? {} : lingerNow()), harnesses: plan.targets, refused, changed: plan.changed, created: [...plan.created, ...(stateWrite ? [stateF] : [])], skipped: [...plan.skipped], restart: plan.restart, unchanged: plan.unchanged, notes: [...plan.notes, ...setupNotes] }
    if (stateRead.error) r.notes.push(`${stateF} could not be read (${String(stateRead.error.message || stateRead.error)}); it is written again`)
    if (!plan.targets.length) {
      // 4.11 P4: a harness left off a file that is not trocar's is not "no agent": `skipped` names the file, and the run is on record (D38)
      if (plan.foreign.length) foreignRows(plan, noteRun({ dir, run, final: { records: [] }, written: { entries: [] }, notes: r.notes, fs, log: opts.log }))
      const why = plan.foreign.length ? `nothing was changed: ${plan.foreign.map((x) => x.reason).join('; ')}` : 'no agent trocar can capture was found: nothing was changed. Install one, then run trocar on again'
      return { receipt: unwritten({ ...r, ok: false, notes: [...r.notes, why] }), manifest: plan._.prior, plan, exit: 1 }
    }
    const named = !!ids && plan.skipped.some((s) => ids.includes(s.what)) // a harness asked for by name that has nothing to install: not done
    // the proxy fields the user edited since the last `on` (1.6 §9.5): asked about like an extra file (R6); a routing that owns none has none
    const edited = networkEdited && plan.targets.length ? await networkEdited(plan.targets) : []
    if (edited.length) r.notes.push(...edited.map((e) => `you changed the proxy setting of ${e.harness}: ${e.where || 'the proxy field'} is now ${e.now ?? 'empty'} (trocar left ${e.was ?? 'empty'} there); on takes that as the upstream and points the setting back at trocar`))
    if (dryRun) {
      const blk = autostartBlock({ unit, osName })
      return { receipt: { ...r, dry_run: true, ok: !named, ...(blk || helperBlock || setupBlk.length ? { blocked: [...(blk ? [{ what: 'trocar on', reason: blk }] : []), ...(helperBlock ? [helperStop] : []), ...setupBlk], notes: [...r.notes, ...(blk ? [`${blk} (a real trocar on stops there)`] : []), ...(helperBlock ? [`${helperBlock} (a real trocar on stops there). Install it with the line below, then run trocar on again`] : [])] } : {}) }, manifest: plan._.prior, plan, exit: named ? 1 : 0 }
    }
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
    try { standalone = writeStandalone({ home, version: OFF_VERSION, platform: osName, fs }) } catch (e) {
      throw Object.assign(new Error(`${standalonePath(home)}, ${UNDO_WORDS}, could not be written (${String((e && e.message) || e)}); no file of the agents' was changed — put that right, then run trocar on again`), { code: e && e.code })
    }
    const guard = () => {
      let st
      try { st = readState().state } catch (e) { throw stop(`${stateF} cannot be read (${String((e && e.message) || e)}), so it is not known whether an off was asked; stopped (1.6 R12)`) }
      const off = plan.targets.filter((id) => !(st.harnesses[id] && st.harnesses[id].desired === 'on'))
      if (off.length) throw stop(`${off.join(', ')} was turned off while this on ran (${stateF}); stopped, the off wins (1.6 R12). What was written is a resumable install: trocar on finishes it`, CODE.stoppedByOff)
    }
    const notes = r.notes
    const problems = []
    let written = null, final = null, halt = false, offCame = null // offCame: the off's stop, whose code is the receipt's error (1.6 §3.1)
    try { ({ final, written } = await writeInstall({ dir, home, plan, m, osName, harnesses, freePort, now, fs, guard, confirmed: true, certs: isModelOs(osName) })) } catch (e) {
      if (!e.stopsRun) throw e
      written = e.written; halt = true; if (e.code === CODE.stoppedByOff) offCame = e
      problems.push(e.message)
    }
    if (written && written.needInstall.length) problems.push(`these certificate items are not in place and on does not write them: ${written.needInstall.join(', ')}; run trocar install`)
    const put = noteRun({ dir, run, final: final || { records: [] }, written: written || { entries: [] }, notes, fs, log: opts.log })
    foreignRows(plan, put)
    const receipt = {
      ...r,
      changed: (written ? written.entries : []).map((e) => ({ path: e.path, change: changeText(e, e.prior_value), backup: e.backup ?? null })),
      created: [...(plan._.prior ? [] : [manifestPath(dir)]), ...(stateWrite ? [stateF] : []), ...standalone.files, ...(written && written.caCreated ? plan._.ca ? [plan._.ca.key, plan._.ca.pem] : [] : []), ...(written ? [...written.files, ...written.owned] : [])],
      unchanged: written ? written.intact : [],
    }
    // the result line is the one proxy mode writes (1.6 §1): `harnesses` = the ones this run turned on (the daemon up and the run not halted), `refused` = the
    // ones refused for setup (1.6 §3.3), which make the run not done (exit 1) while the others went on
    if (refused.length) Object.assign(receipt, { blocked: setupBlk, error: refusedError() })
    const finish = (outcome, reason, on = []) => {
      receipt.ok = !problems.length && !named && !refused.length && !plan.foreign.length && !(written && written.userChanged.length) // an entry the user changed is left, and not in effect: not "done"; a carrier left off someone else's file neither
      const counts = { entries: m.entries.length, changed: receipt.changed.length, notes: notes.length + problems.length }
      put({ event: EVENT.installNote, where: 'install', kind: 'result', outcome, harnesses: on, refused: refused.map((x) => x.harness), counts, reason }) // before the notes are taken: a result line that cannot be written adds its own "not recorded" (R11)
      receipt.notes = [...notes, ...problems]
      if (offCame) receipt.error = { code: offCame.code, message: offCame.message }
      receipt.problems = problems // the renderer labels exactly these 问题: — a failed run's SUCCESS notes (the kernel's "downloaded and both digests
      // verified") must not wear the problem label, which is what a whole-receipt ok===false test did (seen on a macOS test machine, 2026-10-11)
      return { receipt, manifest: m, plan, exit: receipt.ok ? 0 : 1 }
    }
    if (halt) { put({ event: EVENT.failure, where: 'install', code: 'install-error', reason: problems[0] }); return finish('stopped', `on stopped: ${problems[0]}`) }

    // ── the unit and the daemon: started when nothing answers, never started a second time (拉起不是重启, R8) ──
    const checked = (fn) => { try { fn() } catch (e) { if (!e.stopsRun) throw e; problems.push(e.message); halt = true; if (e.code === CODE.stoppedByOff) offCame = e } }
    const d = await ensureDaemonUp({ osName, dir, env, fs, unit, socketPath, request, pause, put, early, halted: () => { checked(() => guard()); return halt } })
    const { sock, ask, started, unitFailed } = d
    const up = d.up
    notes.push(...d.notes); problems.push(...d.problems); if (d.halt) halt = true
    const pid = readLockPid(dir, fs)
    receipt.daemon = { state: d.state, started, ...(pid ? { pid } : {}) }
    // the links last: the daemon attaches on this request, and answers with the state it reached
    if (up && !halt) checked(() => guard())
    let reached = false // V104: the result line lists the targets only when the daemon took the request and reached on
    if (up && !halt) {
      let status = null
      try { status = await ask({ socketPath: sock, method: 'POST', path: '/on', body: { harnesses: plan.targets } }) } catch (e) {
        const why = `the daemon did not take the on request (${String((e && e.message) || e)})`
        problems.push(why); put({ event: EVENT.failure, where: 'control', code: 'control-error', reason: why })
      }
      if (status) {
        for (const x of Array.isArray(status.retried) ? status.retried : []) notes.push(`${x.harness}: ${retriedNote(x.harness, x.hosts)}`) // the paused hosts trocar tries again now (D54②)
        receipt.restart = (status.agents || []).filter((a) => a && !a.trusted && !a.off && RESTART_REASONS.includes(a.reason) && plan.targets.includes(a.agent)).map((a) => ({ harness: a.agent, pid: a.pid, reason: a.reason }))
        receipt.capture = { desired: status.desired ?? null, actual: status.actual ?? null }
        reached = status.actual === 'on'
        if (!reached) {
          const why = status.degraded ? `the helper is down (${status.degraded.reason}); nothing is steered, agents connect directly` // first: a helper that is not up has no protocol to name
            : status.helper && status.helper.ok === false ? `the capability helper speaks protocol ${status.helper.proto}, this daemon expects ${status.helper.expected_proto}; run \`${setupHelperCommand()}\``
              : status.ca && status.ca.ok === false ? `the collector CA is unusable (${status.ca.which}: ${status.ca.reason}); nothing is steered` : `the daemon did not reach on (actual: ${status.actual}); nothing is steered, agents connect directly`
          problems.push(why); put({ event: EVENT.failure, where: 'switch', code: 'state-mismatch', reason: why })
        }
      }
    }
    const wrote = written.entries.length || written.files.length || written.owned.length || written.unit
    return finish(wrote ? 'installed' : 'on', problems.length ? `on did not finish: ${problems[0]}` : `on: ${plan.targets.join(', ')}`, reached && !halt ? plan.targets : [])
    } finally { lock.release() }
  }, { harnesses: [], refused: [] })
}

const UNIT_NAME_HINT = 'trocar-collector.service'
// A named pipe whose server has gone: Windows answers EPIPE / ECONNRESET / a socket hang up where a unix socket answers ENOENT.
const GONE_PIPE = /EPIPE|ECONNRESET|socket hang up|ECONNABORTED/i

// ── the daemon up with its endpoint answering (1.6 §1.1「启用自启并拉起守护进程」; 拉起不是重启, R8): the one copy every `on` uses (Linux's turnOn and
// macOS / Windows' runModelOn, 4.9 §4, 4.8 §7) — two copies of this seam is the 2026-10-11 incident's pattern.
// The endpoint is resolved the one way every caller resolves it (4.8 §7 / 4.9 §7: darwin / win32 find the daemon through control.json and every
// request carries its token; Linux through $XDG_RUNTIME_DIR). This was the 2026-10-11 incident's seam: a Linux-only fallback here made every
// `trocar on` on a real Mac a false start-failed while the daemon was up.
// Second seam of the same incident (caught on a macOS test machine, 2026-10-11): on darwin / win32 control.json is written by the daemon AT ITS
// FIRST START, so a FIRST install has no endpoint to resolve before the unit runs — resolving once up here kept sock null through the whole
// poll and every first `on` ended "no daemon answers on null", exit 1, while the daemon was up and healthy. The probe re-resolves while
// → { up, state, started, sock, ask, unitFailed, notes, problems, halt }: `halted()` is asked before the daemon is touched and after each poll (R12: an `off` that
// lands meanwhile stops the run); `put` records each failure. `register` (D61) is `install`'s arm: the login registration is made and the daemon started
// (`unit.enable`, with `--now` only when nothing answers — 拉起不是重启, R8). Without it (`on`'s arm) the registration is NEVER touched: the daemon is
// started through the OS mechanism install registered (`unit.startNow()`), and directly when that refuses (no systemd --user bus, a job that is not loaded).
function daemonProbe({ osName, dir, env, fs, socketPath, request, pause }) {
  const resolveEndpoint = () => controlEndpointFor({ platform: osName, dir, env, fs })
  let endpoint = resolveEndpoint()
  let sock = socketPath || endpoint.socketPath
  let ask = request || endpoint.request
  const probe = async (first = false) => {
    if (!sock && !socketPath) { endpoint = resolveEndpoint(); sock = endpoint.socketPath; ask = request || endpoint.request }
    if (!sock) return { up: false, why: endpoint.why || 'no control socket to ask' }
    try { await ask({ socketPath: sock, method: 'GET', path: '/status', timeoutMs: 2000 }); return { up: true } } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) return { up: false }
      // win32 (tested 2026-10-20, `trocar update`): a named pipe whose server has just gone answers the FIRST probe with EPIPE / ECONNRESET /
      // a socket hang up instead of ENOENT, and reading that as "a daemon holds the pipe and does not answer" halted the run right after the
      // daemon was stopped. Asked once more after a pause; still like that = not up, never stuck.
      if (first && osName === 'win32' && GONE_PIPE.test(String((e && e.code) || '') + ' ' + String((e && e.message) || e))) {
        await pause(250)
        try { await ask({ socketPath: sock, method: 'GET', path: '/status', timeoutMs: 2000 }); return { up: true } } catch (again) {
          // the second ask answers for a gone pipe in any of its ways, ENOENT included (tested 2026-10-20: EPIPE while the server was still
          // going, `connect ENOENT` once it had gone) — each of them is "not up"; only something else is a daemon that does not answer
          if (again && (again.code === 'ENOENT' || again.code === 'ECONNREFUSED')) return { up: false }
          if (GONE_PIPE.test(String((again && again.code) || '') + ' ' + String((again && again.message) || again))) return { up: false }
          return { up: false, stuck: String((again && again.message) || again) }
        }
      }
      return { up: false, stuck: String((e && e.message) || e) }
    }
  }
  return { probe, sock: () => sock, ask: () => ask }
}

/** `on`'s early start (D62 ①): the daemon asked once, before the plan is read; when nothing answers (no socket, or a socket nobody listens on) its start is
 *  asked of the OS mechanism right away, so the daemon comes up while the plan is read. ensureDaemonUp takes this answer and asks neither again: what the
 *  start answered is reported there, as before. A daemon that answers, or holds the socket and does not, is left alone here. → `{ was, rr?, startAt?, startMs? }`.
 *  On Linux the CLI asked the start before its modules loaded (src/cli/on-start.mjs): that answer is this one, and no second start is asked. */
export async function kickDaemon({ osName, dir, env, fs = nodeFs, unit = null, socketPath = null, request = null, pause = sleep, ms = Date.now }) {
  const pre = takeEarly()
  if (pre) return pre
  const was = await daemonProbe({ osName, dir, env, fs, socketPath, request, pause }).probe(true)
  if (was.up || was.stuck || !unit || typeof unit.startNow !== 'function') return { was }
  const startAt = ms()
  const rr = unit.startNow()
  return { was, rr, startAt, startMs: ms() - startAt }
}

export async function ensureDaemonUp({ osName, dir, env, fs = nodeFs, unit = null, register = false, reload = false, socketPath = null, request = null, pause = sleep, put = () => {}, halted = () => false, ms = Date.now, early = null }) {
  const p = daemonProbe({ osName, dir, env, fs, socketPath, request, pause })
  const probe = p.probe
  const notes = [], problems = []
  const was = early ? early.was : await probe(true) // `early`: kickDaemon's answer, the probe (and the start) already asked
  let up = was.up, started = false, unitFailed = null, halt = false, loginEntryName = null
  if (was.stuck) { problems.push(`a daemon holds the control socket but does not answer (${was.stuck}); run "trocar off", then "trocar on" (off stops a daemon that does not answer)`); halt = true }
  else if (unit) {
    if (halted()) halt = true
    else {
      if (reload && typeof unit.reload === 'function') unit.reload() // a unit file rewritten under a loaded unit
      // `install` registers and starts (enable); `on` only starts, through the OS mechanism, and itself when that refuses — the reason said, never dropped (D38)
      const startAt = early && early.rr ? early.startAt : ms()
      const held = register ? loginEntry(dir, fs) : null
      // 4.8 §7: a login entry the arch uses instead of its own is recorded (with the user's prior) before it is written
      const record = (ledger, ours) => recordLoginEntry(dir, fs, { ledger, ours }, ms)
      let rr = early && early.rr ? early.rr : register ? unit.enable({ now: !was.up, prior: held && held.entry ? held.entry.prior ?? null : null, record }) : (was.up ? null : unit.startNow())
      if (!register && rr && rr.code !== 0 && typeof unit.start === 'function') {
        const direct = unit.start(daemonEnv(env, dir)) // the direct start carries what the login entry's Environment= would carry
        if (direct.code === 0) { notes.push(`the collector could not be started through ${entryWords(osName, unit)} (${rr.err || `exit ${rr.code}`}); trocar started it directly this run; the login entry starts it at the next login`); rr = direct }
      }
      started = !was.up
      // D62 / D38: the OS mechanism can hold the spawn back, and that wait is trocar's to SAY, not to hide. `launchctl kickstart` does not return
      // until launchd spawned the job, and launchd spawns one at most once every ThrottleInterval seconds (10 s, launchd's default: trocar writes no
      // ThrottleInterval, D62 ⑥ and darwin/autostart.mjs). An `off` no longer asks the daemon to exit, so `on` normally finds it already up and never
      // gets here; this note is what says so when it does. No "run trocar install" in it: on darwin `install` rewrites the plist and calls
      // enable({now: false}), which does not reload an already loaded job (darwin/autostart.mjs enable); a running daemon on another copy's
      // code is what install replaces (drain, stop, enable({now: true}), 1.6 §3.2 step 5, src/cli/replace-daemon.mjs).
      const startMs = early && early.rr ? early.startMs : ms() - startAt
      if (startMs >= SLOW_START_MS) notes.push(`${entryWords(osName, unit)} held the collector's start for ${startMs} ms; trocar waited on the OS, not on work of its own${osName === 'darwin' ? ' (launchd spawns a job at most once every ThrottleInterval seconds, 10 s by default)' : ''}`)
      // 4.8 §7: a login entry the arch took out (the Run value, once the task is registered) leaves the record
      if (register && rr && ['removed', 'restored'].includes(rr.runKey)) {
        const why = recordLoginEntry(dir, fs, rr, ms)
        if (why) { notes.push(why); problems.push(why) }
      }
      if (rr && rr.code === 0 && rr.ledger) loginEntryName = `${rr.ledger.hive}\\${rr.ledger.key}\\${rr.ledger.name}` // what the receipt names as the login entry (1.6 C.2)
      if (rr && rr.code === 0 && rr.event) { notes.push(rr.event.reason); put(rr.event) } // the fallback worked, and why it was needed is a failure all the same (D38)
      if (rr && rr.code === 0 && rr.warn) notes.push(rr.warn) // the arch's own `warn` reaches the receipt (4.8 §7: what it could not do is the caller's to say) — the Run-value it could not take out, the daemon it started directly because /Run's SUCCESS was a lie
      if (rr && rr.code !== 0) {
        // the flip checklist ③ (4.9 §4 末): the arch's own failure record, verbatim, when enable() carries one (the darwin LaunchAgent's `launchd-register-failed` —
        // launchd is the only autostart there, 4.9 §11); the wording below is the answer of an arch that has none.
        if (rr.event) { unitFailed = rr.event.reason; put(rr.event) }
        else if (!register) { unitFailed = `the collector could not be started (${rr.err || `exit ${rr.code}`}); start it yourself: ${DAEMON_CMD}`; put({ event: EVENT.failure, where: 'start', code: 'start-failed', reason: unitFailed }) } // `on` touches no registration: there is nothing to enable, only this start
        else {
          // the start question in the platform's own words: win32's unit is a scheduled task (\trocar\collector, autostart.mjs), darwin's a LaunchAgent,
          // and the systemd wording is Linux's alone — a Windows user told to run `systemctl --user status` has been handed nothing (tested 2026-10-11)
          const daemonLog = typeof unit.logFiles === 'function' ? (unit.logFiles()[1] || {}).path : null
          const entry = osName === 'win32' ? 'the scheduled task \\trocar\\collector' : osName === 'darwin' ? `the LaunchAgent ${unit.path}` : null
          unitFailed = entry // a systemd line is Linux's alone: a Mac or Windows user told to run `systemctl --user` has been handed nothing (tested on Windows 2026-10-11 and macOS 2026-10-18)
            ? `${entry} was not registered or run (${rr.err || `exit ${rr.code}`}); start the daemon with "${DAEMON_CMD}"${daemonLog ? `, and ${daemonLog} says why it did not start` : ''}`
            : `${unit.path} is written but "systemctl --user enable${was.up ? '' : ' --now'}" failed (${rr.err || `exit ${rr.code}`}); trocar on needs this login entry: put right what systemctl says (with no systemd --user to ask, use a login session that has one), then run trocar install again` // a daemon started by hand is no way round it: `on` asks the entry first (1.6 §3.3)
          put({ event: EVENT.failure, where: 'install', code: CODE.unitNotEnabled, reason: unitFailed })
        }
        notes.push(unitFailed); problems.push(unitFailed)
      } else if (!was.up) {
        // asked every 25 ms for the first 0.5 s (a daemon is often up within it, D62 ①), then every 250 ms: about 15 s in all
        // a daemon that refuses to start (node-too-old, elevated-token, root-token) writes its own {where:'start'} record and exits 0, so nothing will answer:
        // one read of the newest flows tail per poll, and its reason is the problem (D38: the daemon's words, no start-failed on top). Unreadable = keep polling.
        const refusedSince = () => { try { return readFlows({ dir, fs, maxBytes: 64 * 1024 }).records.find((r) => r.event === EVENT.failure && r.where === 'start' && REFUSED_START.has(r.code) && Date.parse(r.ts) >= startAt) || null } catch { return null } }
        let refusal = null
        for (let i = 0; i < 78 && !up && !halt; i++) { up = (await probe()).up; if (!up && (refusal = refusedSince())) break; if (!up) { await pause(i < 20 ? 25 : 250); if (halted()) halt = true } } // an off that lands while the daemon starts is seen within a poll, not after 15 s (R12)
        if (refusal) problems.push(refusal.reason || refusal.code)
        else if (!up && !halt) {
          const where = osName === 'darwin' ? 'launchctl print gui/$(id -u)/com.trocar.collector' : osName === 'win32' ? 'schtasks /Query /TN \\trocar\\collector (and "trocar status" for the daemon)' : `systemctl --user status ${UNIT_NAME_HINT}` // the autostart's own status question, in the platform's words (4.9 §4: the LaunchAgent, not a systemd unit; 4.8 §7: the task, not a unit)
          const sock = p.sock()
          const why = `the collector was started${sock ? ` but does not answer on ${sock}` : ', but it does not answer yet'}; look at "${where}" and the capture health on the board` // never "answers on null": an endpoint that is not known yet is not named (1.6 §1.1)
          problems.push(why); put({ event: EVENT.failure, where: 'start', code: 'start-failed', reason: why })
        }
      }
    }
  } else if (!up) notes.push(`no login entry and no collector running: start it with ${DAEMON_CMD} (it follows what is turned on)${was.why ? `; ${was.why}` : ''}`)
  // 1.6 §3.3 / 附录 C.2: what install says about the login entry is the entry asked again (the question `on` asks before it writes), never
  // "no error was seen": a run the stuck daemon above halted registered nothing
  if (register && unit && !unitFailed) {
    const q = unit.registered()
    if (q.state !== 'present') {
      // a daemon that answered before the run was not started by the entry, and install starts no second one beside it (拉起不是重启, R8)
      unitFailed = `${entryState(osName, unit, q)} after this install, so trocar on will refuse until it is: ${was.up ? 'a collector the login entry did not start is answering, and install does not start a second one; stop that collector, then run trocar install again' : was.stuck ? 'the collector that does not answer (the problem above) has to stop first: run trocar off, then trocar install again' : 'run trocar install again'}`
      put({ event: EVENT.failure, where: 'install', code: CODE.unitNotEnabled, reason: unitFailed })
      notes.push(unitFailed); problems.push(unitFailed)
    }
  }
  // the receipts' `daemon.state` (1.6 C.2), said here once for install, update and on: a daemon that holds the socket and does not answer is
  // not-responding, as `trocar status` says it (C.3), never not-running
  return { up, state: up ? 'running' : was.stuck ? 'not-responding' : 'not-running', started: started && up, sock: p.sock(), ask: p.ask(), unitFailed, notes, problems, halt, entry: loginEntryName }
}
// the install record's login entry of the fallback (kind run-key, the one kind an arch's `enable` ledgers): { m, at, entry } or null when there is no record to read
function loginEntry(dir, fs) {
  let m = null
  try { m = readManifest(dir, fs) } catch { return null }
  if (!m || m.unsupported) return null
  const at = m.entries.findIndex((e) => e.kind === 'run-key')
  return { m, at, entry: at >= 0 ? m.entries[at] : null }
}
// → null, or why the record could not be put right. A value that was trocar's already (`ours`) keeps the prior the record has.
// R12: the read and save hold op.lock, and only they: the OS's start of the collector can outlast the 10 s an off waits for the lock (1.6 R12)
function recordLoginEntry(dir, fs, rr, ms) {
  const what = rr.ledger ? `the login entry ${rr.ledger.hive}\\${rr.ledger.key}\\${rr.ledger.name}` : 'the login entry trocar took out'
  const after = rr.ledger ? 'so it was not written' : 'trocar uninstall still takes it out' // a new entry is recorded before it is written (4.8 §7 W24)
  let got
  try { got = tryOpLock({ file: path.join(dir, path.basename(opLockFile())), fs }) } catch (e) { return `${what} could not be recorded (${(e && e.message) || e}); ${after}` }
  if (!got.lock) return `${what} could not be recorded: another trocar command (pid ${got.holder && got.holder.pid}) is changing the install record; ${after}`
  try { return saveLoginEntry(dir, fs, rr, ms, what, after) } finally { got.lock.release() }
}
function saveLoginEntry(dir, fs, rr, ms, what, after) {
  const held = loginEntry(dir, fs)
  if (!held) return `${what} could not be recorded: the install record could not be read; ${after}`
  const { m, at, entry } = held
  if (rr.ledger) {
    const e = { ...rr.ledger, harness: null, phase: 'install', prior: rr.ours && entry ? entry.prior ?? null : rr.ledger.prior, installed_at: new Date(ms()).toISOString() }
    if (at >= 0) m.entries[at] = e; else m.entries.push(e)
  } else if (at >= 0) m.entries.splice(at, 1)
  else return null
  try { saveManifest(dir, m, fs); return null } catch (err) { return `${what} could not be recorded (${(err && err.message) || err}); ${after}` }
}
function readLockPid(dir, fs) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')).pid ?? null } catch { return null } }

// `trocar install` on macOS and Windows (4.11 §1, plan T20): the model's install lives beside this one; Linux keeps installCollector.
export { runInstall } from './model-install.mjs'

export { MARKED_WITHOUT_RECORD } // the plan's refusal code, for the command that prints it (src/cli/install.mjs)
