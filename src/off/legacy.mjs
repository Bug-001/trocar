// legacy.mjs (src/off) — taking the OLD capture out of a machine: what `asight off` does on a platform without the new collector, and what it still finds on Linux (RFC 1.6 §4 「旧采集(过渡期)」,
// §6 「核对生效」, R2 / R3 / R11; D28 only asight's own block, key and line; D29 the VPN software is asked, not trusted; D31 transition). The old capture is: the CC-CLI steer in
// ~/.claude/settings.json (HTTPS_PROXY pointing at the local proxy, the displaced values in a stash), the Clash Verge route (a sentinel block in Script.js, its copy in the runtime config), three
// LaunchAgents (com.asight.mitm, com.asight.monitor, com.asight.env), the CA in the login keychain (macOS) or the user NSS database (Linux), and ~/.asight/legacy-manifest.json — the ledger of
// what `asight on` wrote through it (a thing an old command wrote, `desktop on` and `monitor on`, is not in the ledger: its own mark is its ledger, and it is called 「旧命令装的,无备份」).
// Imports only node:* and src/off (0.1 §2): the standalone ~/.asight/bin/asight-off is made of this directory, so the undo works when the repository is gone.
//   hasNewCollector     the one question that decides which generation `on` / `off` / `status` drive on a platform (1.6 §1.2)
//   clearCliSteer · uninstallCa · caRemoveArgv      the steer and the CA undo, moved from src/capture/onboard.mjs and trust-store.mjs, which call them: there is one undo, not two
//   legacyArtifacts     what of the old capture is there (read only)
//   undoLegacy          the order (§4): the CC steer from its stash → the Clash route stripped, reloaded and READ BACK from the core → the MITM unloaded so launchd sends it SIGTERM, which
//                       it drains for at most 10 s → com.asight.monitor → com.asight.env (and the login environment's CA variable, only when it is asight's) → the CA → the ledger
//   legacyUndoHook      undoLegacy as the `legacyUndo` hook of `asight off` / `asight uninstall` on Linux, in the shape of their receipts
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { sha256, readOrNull } from './fsutil.mjs'
import { asightHome, legacyManifestPath, legacyPendingPath, legacyEventsFile } from './paths.mjs'
import { dropBackup } from './backup.mjs'
import { readManifestAt, saveManifestAt } from './manifest.mjs'
import { listProcs, pidAlive } from './proc.mjs'
import { makeClash, stripBlock, stripRuntime, stripMergeLegacy, SCRIPT_BEGIN, PROXY_NAME } from './clash.mjs'

/** Does this platform have the new per-process collector? Only Linux today (4.6; 1.6 §1.2). One function, used everywhere the branch is taken: where it is false `on` / `off` / `status` /
 *  `uninstall` drive the old capture. */
export const hasNewCollector = (platform = process.platform) => platform === 'linux'

/** The line `on` and `off` print first where they drive the old capture (1.6 §4). */
export const LEGACY_NOTE = '本平台 on / off 驱动旧采集(过渡期)'
/** What the receipt and `status` call a change an old command made: it has no ledger entry and no backup, its own mark is what undoes it (1.6 §4). */
export const LEGACY_OLD_COMMAND = '旧命令装的,无备份'

/** The LaunchAgents of the old capture. */
export const LEGACY_LABELS = Object.freeze({ mitm: 'com.asight.mitm', monitor: 'com.asight.monitor', env: 'com.asight.env' })
/** The CA's subject name: the one a root already in a keychain is found by (a legacy name, not to be renamed). */
export const LEGACY_CA_CN = 'atrace local MITM CA'
/** The NSS nickname the CA has on Linux. */
export const LEGACY_CA_NICKNAME = 'asight-ca'
const LEGACY_ENV_VAR = 'NODE_EXTRA_CA_CERTS'
const CLAUDE_CODE = 'claude-code'
const MITM_STOP_GRACE_MS = 5000 // launchd kills a job ExitTimeOut (15 s) after its SIGTERM: the 10 s drain and this much more
const CODE_NOT_UNDONE = 'entry-not-undone' // a name of the closed set (src/health/codes.mjs): an item that was not undone

const legacyWhy = (e) => String((e && (e.code || e.message)) || e)
const legacyMessage = (e) => String((e && e.message) || e)
const legacyRethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the tool failed" (0.1 §3)

// ── where things are ───────────────────────────────────────────────────────────────────────────────

/** The places the old capture touches for one HOME and platform. Nothing here reads the disk. */
export function legacyPaths({ home = nodeOs.homedir(), platform = process.platform } = {}) {
  const verge = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev')
  return {
    settingsPath: path.join(home, '.claude', 'settings.json'),
    stashPath: path.join(home, '.atrace', 'steer-backup.json'), // a legacy name: the stash of what the steer displaced (not to be renamed)
    vergeDir: verge, scriptPath: path.join(verge, 'profiles', 'Script.js'), runtimePath: path.join(verge, 'clash-verge.yaml'), mergePath: path.join(verge, 'profiles', 'Merge.yaml'),
    plist: (label) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    keychain: path.join(home, 'Library', 'Keychains', 'login.keychain-db'),
    nssdb: path.join(home, '.pki', 'nssdb'),
    platform,
  }
}

// ── the CC-CLI steer (moved from src/capture/onboard.mjs) ─────────────────────────────────────────
// The user's settings.json is THEIR file (model / permissions / mcpServers live here). A read we cannot fully understand MUST NOT become an empty object we then write back — that silently
// destroys everything in it. Only a genuinely absent file means "start from {}"; every other failure (unparseable JSON, EACCES, a directory, …) THROWS so nothing is written.
export function readSettings(p, fs = nodeFs) {
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return {} // no file yet → a fresh {} is the honest starting point
    throw new Error(`asight refused to touch ${p}: cannot read it (${e.code || e.message}). Nothing was written — fix or move the file, then retry.`)
  }
  try { return JSON.parse(raw) } catch (e) {
    throw new Error(`asight refused to overwrite ${p}: it is not strict JSON (${e.message}). Comments/trailing commas are not parseable here, and overwriting would destroy your model/permissions/mcpServers. Nothing was written — make it strict JSON (or move it aside), then retry.`)
  }
}

/** Copies the user's pre-steer settings.json to <path>.asight-bak — ONCE, so repeated on/off cycles keep the ORIGINAL (a per-write backup would just archive an already-steered file). */
export function backupSettingsOnce(p, fs = nodeFs) {
  const bak = p + '.asight-bak'
  try { if (fs.existsSync(p) && !fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(p, 'utf8')) } catch { /* best-effort */ }
}

/** The keys the steer OWNS. Anything pre-existing under these names belongs to the user (a corporate proxy, a VPN) and is DISPLACED, not owned — so `on` stashes it and `off` puts it back. Keys absent
 *  from the stash were introduced by asight and are the only ones `off` may delete (零残留 · 4.1:101). */
export const STEER_KEYS = ['HTTPS_PROXY', 'NO_PROXY']

/** The env the steer displaced, from the stash file: `{}` when it displaced nothing, null when there is no stash (or it cannot be read). */
export function readStash(stashPath, fs = nodeFs) {
  try { return JSON.parse(fs.readFileSync(stashPath, 'utf8')).env || {} } catch { return null }
}

/** `restoreProxy` (explicit) > stash (what `on` displaced) > delete (asight introduced it). The explicit form is how a caller points HTTPS_PROXY back at the upstream VPN / direct (4.1:61).
 *  `backup: false` skips the one-time `.asight-bak` copy next to settings.json (`asight off` lists what it writes; the old `monitor off` keeps it). */
export function clearCliSteer({ settingsPath, stashPath, restoreProxy = '', backup = true, fs = nodeFs }) {
  const s = readSettings(settingsPath, fs)
  const stash = readStash(stashPath, fs)
  if (s.env) {
    for (const k of STEER_KEYS) {
      if (stash?.[k] !== undefined) s.env[k] = stash[k] // user's own value — put it back verbatim
      else delete s.env[k] // asight introduced it — remove it
    }
    if (restoreProxy) s.env.HTTPS_PROXY = restoreProxy // explicit override beats both
  }
  if (backup) backupSettingsOnce(settingsPath, fs)
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  if (stash) { try { fs.rmSync(stashPath, { force: true }) } catch { /* best-effort */ } }
  return s.env || {}
}

// ── the old CA ──────────────────────────────────────────────────────────────────────────────────

/** The command that takes the old CA out of the user-level trust store: macOS the login keychain (`delete-certificate -c <CN>`), Linux the user NSS database (`certutil -D -n asight-ca`). Import-only,
 *  user-level: nothing here is machine-wide. → `{ file, args }`; throws for a platform with no store this code can reach. */
export function caRemoveArgv({ platform, home = nodeOs.homedir(), keychain = null, nssdb = null }) {
  const p = legacyPaths({ home, platform })
  if (platform === 'darwin') return { file: 'security', args: ['delete-certificate', '-c', LEGACY_CA_CN, keychain || p.keychain] }
  if (platform === 'linux') return { file: 'certutil', args: ['-D', '-d', `sql:${nssdb || p.nssdb}`, '-n', LEGACY_CA_NICKNAME] }
  throw new Error(`there is no user-level trust store for ${platform} this code can take the old CA out of`)
}
const caFindArgv = ({ platform, home, keychain = null, nssdb = null }) => {
  const p = legacyPaths({ home, platform })
  return platform === 'darwin' ? { file: 'security', args: ['find-certificate', '-c', LEGACY_CA_CN, keychain || p.keychain] } : { file: 'certutil', args: ['-L', '-d', `sql:${nssdb || p.nssdb}`, '-n', LEGACY_CA_NICKNAME] }
}

/** Takes the CA out of the user trust store: the runner's `{ status, stdout, stderr }` of the delete (the same shape the trust-store installers return). `run` replaces the spawn. */
export function uninstallCa({ platform, home = nodeOs.homedir(), run = null, env = process.env, keychain = null, nssdb = null }) {
  const a = caRemoveArgv({ platform, home, keychain, nssdb })
  const r = execTool(a.file, a.args, { run, env })
  return { status: r.code, stdout: r.out, stderr: r.err }
}

// ── reading what is there ──────────────────────────────────────────────────────────────────────────

function readFileState(fs, file) {
  try { const b = readOrNull(fs, file); return b == null ? { text: null } : { text: b.toString('utf8') } } catch (e) { return { text: null, error: `${file}: ${legacyWhy(e)}` } }
}

// the CA path a com.asight.env plist sets the variable to (its ProgramArguments: launchctl setenv NODE_EXTRA_CA_CERTS <path>)
function envPlistCaPath(text) {
  if (typeof text !== 'string') return null
  const args = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
  const at = args.indexOf(LEGACY_ENV_VAR)
  return at >= 0 && args[at + 1] ? args[at + 1] : null
}

function launchdState({ label, plist, exec, env, fs, platform }) {
  const out = { label, plistPath: plist, installed: false, loaded: null, pid: null }
  try { out.installed = fs.existsSync(plist) } catch { out.installed = null }
  if (platform !== 'darwin') return out
  const r = execTool('launchctl', ['list', label], { run: exec, env })
  out.loaded = r.code === 0 ? true : r.code === null ? null : false // launchctl list <label> exits non-zero for a label that is not loaded
  if (out.loaded === null) out.error = `launchctl list ${label}: ${r.err || 'could not be run'}`
  const m = /"PID"\s*=\s*(\d+)\s*;/.exec(r.out)
  if (m) out.pid = Number(m[1])
  return out
}

/**
 * What of the old capture is on this machine, read only → `{ platform, paths, ccSteer, clashBlock, agents: { mitm, monitor, env }, envValue, oldCa, ledger }`. Every field that could not be read says
 * why (`error`) and is `null`, never `false`: what was not read is not "absent" (R11). `live: true` also asks the Clash core whether the route is in its live proxy list (`status` does; `off` asks
 * after its own strip). `exec` runs launchctl / security / certutil; `fs`, `env`, `mihomo` (the seams of src/off/clash.mjs makeClash) are a test's.
 *   ccSteer    { settingsPath, stashPath, stash: {…displaced env}|null, stashError?, proxy, noProxy, error? } — steered = a stash exists (asight wrote it when it displaced the user's values)
 *   clashBlock { scriptPath, runtimePath, mergePath, verge, script, runtime, merge, live?, error? } — the block in Script.js, the route in the runtime config, the old Merge.yaml leftovers
 *   agents     { installed (the plist is there), loaded (launchd has it), pid (it is running), caPath (com.asight.env only: what it sets the variable to) }
 *   envValue   { value, error? } — the login environment's CA variable now (macOS); oldCa { where, present } — the CA in the trust store
 *   ledger     null (none) | { path, manifest } | { path, error }
 */
export async function legacyArtifacts({ home = nodeOs.homedir(), platform = process.platform, exec = null, fs = nodeFs, env = process.env, mihomo = {}, live = false } = {}) {
  const p = legacyPaths({ home, platform })
  const out = { platform, paths: p }

  // the CC-CLI steer: the stash is the evidence (asight wrote it when it displaced the user's values); the settings are where it landed
  const stash = readStash(p.stashPath, fs)
  const settings = readFileState(fs, p.settingsPath)
  let proxy = null, noProxy = null, settingsError = settings.error || null
  if (settings.text != null) {
    try { const s = JSON.parse(settings.text); proxy = (s && s.env && s.env.HTTPS_PROXY) || null; noProxy = (s && s.env && s.env.NO_PROXY) || null } catch (e) { settingsError = `${p.settingsPath}: not strict JSON (${legacyMessage(e)})` }
  }
  let stashExists = false
  try { stashExists = fs.existsSync(p.stashPath) } catch { /* below: stash stays null */ }
  out.ccSteer = { settingsPath: p.settingsPath, stashPath: p.stashPath, stash: stashExists ? (stash || {}) : null, ...(stashExists && stash === null ? { stashError: `${p.stashPath} could not be read` } : {}), proxy, noProxy, ...(settingsError ? { error: settingsError } : {}) }

  // the Clash route
  const cb = { scriptPath: p.scriptPath, runtimePath: p.runtimePath, mergePath: p.mergePath, verge: false, script: null, runtime: null, merge: null }
  if (platform === 'darwin') {
    const sc = readFileState(fs, p.scriptPath), rt = readFileState(fs, p.runtimePath), mg = readFileState(fs, p.mergePath)
    cb.verge = sc.text != null || rt.text != null || mg.text != null
    cb.script = sc.error ? null : sc.text == null ? false : sc.text.includes(SCRIPT_BEGIN)
    cb.runtime = rt.error ? null : rt.text == null ? false : stripRuntime(rt.text) !== rt.text
    cb.merge = mg.error ? null : mg.text == null ? false : stripBlock(stripMergeLegacy(mg.text)) !== mg.text
    const errs = [sc.error, rt.error, mg.error].filter(Boolean)
    if (errs.length) cb.error = errs.join('; ')
    if (live) {
      const clash = makeClash({ fs, scriptPath: p.scriptPath, runtimePath: p.runtimePath, mergePath: p.mergePath, exec, env, platform, ...mihomo })
      let l = null; try { l = await clash.probeLive() } catch (e) { legacyRethrowSandbox(e) }
      cb.live = l
      const loc = clash.located()
      cb.sock = loc ? loc.sock : null
      cb.tried = loc ? loc.tried : []
    }
  }
  out.clashBlock = cb

  // the LaunchAgents
  const agents = {}
  for (const [k, label] of Object.entries(LEGACY_LABELS)) agents[k] = launchdState({ label, plist: p.plist(label), exec, env, fs, platform })
  if (agents.env.installed) { const t = readFileState(fs, agents.env.plistPath); agents.env.caPath = envPlistCaPath(t.text) }
  out.agents = agents

  // the login environment's CA variable, and the CA in the trust store
  out.envValue = { value: null }
  out.oldCa = { where: platform === 'darwin' ? 'keychain' : platform === 'linux' ? 'nss' : null, present: false }
  if (platform === 'darwin') {
    const g = execTool('launchctl', ['getenv', LEGACY_ENV_VAR], { run: exec, env })
    if (g.code === 0) out.envValue = { value: g.out || null }
    else out.envValue = { value: null, error: `launchctl getenv ${LEGACY_ENV_VAR}: ${g.err || `exit ${g.code}`}` }
    const f = caFindArgv({ platform, home })
    const r = execTool(f.file, f.args, { run: exec, env })
    if (r.code === 0) out.oldCa.present = true
    else if (r.code === 44 || /could not be found|could not find/i.test(`${r.err}${r.out}`)) out.oldCa.present = false
    else out.oldCa = { ...out.oldCa, present: null, error: `security find-certificate: ${r.err || `exit ${r.code}`}` }
  } else if (platform === 'linux') {
    let db = false
    try { db = fs.existsSync(p.nssdb) } catch { /* no database to ask */ }
    if (db) {
      const f = caFindArgv({ platform, home })
      const r = execTool(f.file, f.args, { run: exec, env })
      if (r.code === 0) out.oldCa.present = true
      else if (/could not find cert/i.test(`${r.err}${r.out}`)) out.oldCa.present = false
      else out.oldCa = { ...out.oldCa, present: null, error: `certutil -L: ${r.err || `exit ${r.code}`}` }
    }
  }

  // the ledger
  const lf = legacyManifestPath(home)
  try { const m = readManifestAt(lf, fs); out.ledger = m ? { path: lf, manifest: m } : null } catch (e) { out.ledger = { path: lf, error: legacyMessage(e) } }
  return out
}

// ── the events of the old capture's log ───────────────────────────────────────────────────────────

function appendLegacyLine(home, rec, { fs, now, log }) {
  const file = legacyEventsFile(home)
  const line = { ts: now().toISOString(), ...rec }
  if (rec.event === 'failure') log(`asight ${rec.where}: ${rec.code}: ${rec.reason}`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
    return true
  } catch (e) {
    log(`asight: could not write ${file} (${legacyMessage(e)}) — this event is recorded nowhere else: ${JSON.stringify(line)}`)
    return false
  }
}

/** The last MiB of ~/.asight/logs/mitm-events.ndjson as records (what the MITM said of its own life), `{ recs, error? }`. A missing file is no records, not an error. */
function legacyEventsTail(home, fs) {
  const file = legacyEventsFile(home)
  let text
  try {
    const size = fs.statSync(file).size
    const from = Math.max(0, size - (1 << 20))
    const buf = Buffer.alloc(size - from)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, from) } finally { fs.closeSync(fd) }
    text = buf.toString('utf8')
    if (from > 0) text = text.slice(text.indexOf('\n') + 1) // the first line of a cut part is not whole
  } catch (e) { return e && e.code === 'ENOENT' ? { recs: [] } : { recs: [], error: `${file}: ${legacyWhy(e)}` } }
  const recs = []
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)) } catch { /* a line cut by a crash */ } }
  return { recs }
}

// ── undoing it ────────────────────────────────────────────────────────────────────────────────────

const shaOfFile = (fs, file) => { try { return sha256(readOrNull(fs, file)) } catch { return null } }

// ledger entries of one kind (and role) for a path
const ledgerEntries = (ledger, kind, file) => ((ledger && ledger.manifest && ledger.manifest.entries) || []).filter((e) => e && e.kind === kind && e.path === file)
const ledgerEntry = (ledger, kind, file) => ledgerEntries(ledger, kind, file)[0] || null

function realClock() { return { ms: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } }

/**
 * Takes the old capture out (RFC 1.6 §4). `scope` is 'all' (the only one there is). Everything the world gives is a parameter a test replaces (0.1 §3): `exec` (launchctl, security, certutil, ps),
 * `fs`, `env`, `clock` ({ ms, sleep }: the waits for the MITM are made of it), `now` (a Date), `alive` (is a pid running), `procs` (the process table), `mihomo` (src/off/clash.mjs's seams: sock, psText,
 * knownSocks, mihomoReload, probeLive), `log` (stderr), `drainMs` (how long the MITM may keep its connections open; 0 for `off --now`).
 * Order: marker `~/.asight/legacy-off.pending` → CC settings from the stash → Clash: strip the block and the Merge.yaml leftovers, strip the runtime, hot-reload, READ the live proxy list back (also
 * when the file has no block: the runtime may still hold the route) → only then `launchctl unload com.asight.mitm` (launchd sends SIGTERM; the MITM stops accepting and drains) → com.asight.monitor
 * → com.asight.env and, when the login environment's CA variable is asight's, `launchctl unsetenv` → the CA → the ledger (a backup goes when the file is back to what it was) → the marker goes.
 * When the route cannot be confirmed gone the MITM is NOT unloaded (it would leave Desktop pointed at nothing): `ok` is false and the receipt says why.
 * → { changed, removed, skipped, left, notes, problems, kept_backups, restart, cut: number | 'unknown', cut_reason?, ok, events }
 */
export async function undoLegacy({ home = nodeOs.homedir(), platform = process.platform, exec = null, fs = nodeFs, env = process.env, clock = null, now = null, alive = pidAlive, procs = null, mihomo = {}, log = (m) => { try { process.stderr.write(`${m}\n`) } catch { /* nothing left to tell */ } }, drainMs = 10000, scope = 'all', record = true } = {}) {
  if (scope !== 'all') throw new RangeError(`undoLegacy: scope ${JSON.stringify(scope)} is not one there is (only 'all')`)
  const clk = clock || realClock()
  const nowFn = now || (() => new Date(clk.ms()))
  const res = { changed: [], removed: [], skipped: [], left: [], notes: [], problems: [], kept_backups: [], restart: [], cut: 0, ok: true, events: [] }
  const say = (kind, reason, extra = {}) => { const rec = { event: 'off-note', where: 'off', kind, reason, ...extra }; res.events.push(rec); if (record) appendLegacyLine(home, rec, { fs, now: nowFn, log }) }
  const fail = (code, reason, extra = {}) => {
    res.ok = false; res.problems.push(reason)
    const rec = { event: 'failure', where: 'off', code, reason, ...extra }
    res.events.push(rec); if (record) appendLegacyLine(home, rec, { fs, now: nowFn, log })
  }
  const art = await legacyArtifacts({ home, platform, exec, fs, env, mihomo })
  const p = art.paths
  const ledger = art.ledger && art.ledger.manifest ? art.ledger : null
  if (art.ledger && art.ledger.error) res.notes.push(`the ledger ${art.ledger.path} could not be read (${art.ledger.error}): its backups are not dropped; everything is undone by its own marks`)
  const row = (file, change, result, extra = {}) => res.changed.push({ path: file, change, backup: extra.backup ?? null, result, harness: CLAUDE_CODE, ...extra })

  const onDarwin = platform === 'darwin'
  const cb = art.clashBlock
  // evidence that asight ever put a route into Clash: the block, the runtime copy, the Merge.yaml leftovers, the ledger, or the MITM agent it serves. Without any, a Clash that was never asight's is not reloaded.
  const clashEvidence = onDarwin && cb.verge && (cb.script !== false || cb.runtime !== false || cb.merge !== false || !!ledgerEntry(ledger, 'legacy-clash-block', p.scriptPath) || art.agents.mitm.installed === true)
  const hasAgents = onDarwin && Object.values(art.agents).some((a) => a.installed === true || a.loaded === true)
  const anything = art.ccSteer.stash !== null || clashEvidence || hasAgents || (onDarwin && art.envValue.value && ownCaPaths(art, home).has(art.envValue.value)) || art.oldCa.present === true || !!ledger
  if (!anything) return res

  const marker = legacyPendingPath(home)
  let marked = false
  if (onDarwin && (clashEvidence || art.agents.mitm.installed)) {
    try { fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 }); fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: nowFn().toISOString() }) + '\n', { mode: 0o600 }); marked = true } catch (e) { res.notes.push(`${marker} could not be written (${legacyWhy(e)}): the MITM's steer watch may call the block's going away a failure`) }
  }
  try {
    // 1 · the CC-CLI steer, from its stash (an old command wrote it: no ledger entry, no backup)
    let steerUndone = false
    const steerSince = (() => { try { return fs.statSync(p.stashPath).mtimeMs } catch { return null } })() // when the steer went in: a process started before it never read it
    if (art.ccSteer.stash !== null) {
      try {
        clearCliSteer({ settingsPath: p.settingsPath, stashPath: p.stashPath, backup: false, fs })
        steerUndone = true
        row(p.settingsPath, '去掉 env.HTTPS_PROXY / NO_PROXY(旧 CC-CLI steer,按暂存值还原)', 'old-command', { old_command: true })
        res.removed.push(p.stashPath)
        say('cc-steer', `the CC-CLI steer was taken out of ${p.settingsPath} from its stash`, { file: p.settingsPath })
      } catch (e) {
        res.left.push({ path: p.settingsPath, harness: CLAUDE_CODE, result: 'error', reason: legacyMessage(e) })
        fail(CODE_NOT_UNDONE, `the CC-CLI steer is still in ${p.settingsPath}: ${legacyMessage(e)}`, { file: p.settingsPath })
      }
    }

    // 2 · the Clash route: stripped, reloaded, and read back from the core
    let routeGone = true
    if (onDarwin && (clashEvidence || cb.verge)) {
      const clash = makeClash({ fs, scriptPath: p.scriptPath, runtimePath: p.runtimePath, mergePath: p.mergePath, exec, env, platform, ...mihomo })
      let go = clashEvidence
      if (!go) { // nothing in the files says asight was here: ask the core (read only) — a route it holds is asight's, and is taken out too
        let l = null; try { l = await clash.probeLive() } catch (e) { legacyRethrowSandbox(e) }
        go = l === true
      }
      if (go) {
        const before = { script: shaOfFile(fs, p.scriptPath), merge: shaOfFile(fs, p.mergePath) }
        const r = await clash.off()
        const after = { script: shaOfFile(fs, p.scriptPath), merge: shaOfFile(fs, p.mergePath) }
        // a file `on` changed twice (Verge regenerated Script.js between two `on`s) has an entry for each write, each with its own backup: all are settled, the newest names the receipt's row
        const entriesS = ledgerEntries(ledger, 'legacy-clash-block', p.scriptPath), entriesM = ledgerEntries(ledger, 'legacy-clash-block', p.mergePath)
        const entryS = entriesS[entriesS.length - 1] || null, entryM = entriesM[entriesM.length - 1] || null
        // "verified" is the core's own answer (D29 / 1.6 §6): a proxy list that no longer names the route. No Verge runtime to ask at all is nothing to verify.
        const noCore = !cb.verge || (!fs.existsSync(p.runtimePath) && !(mihomo.sock || env.ASIGHT_MIHOMO_SOCK))
        const live = r.status ? r.status.live : null
        const verified = r.ok && (live === false || (live === null && noCore))
        if (before.script !== after.script) row(p.scriptPath, '去掉 asight 的 Clash 哨兵块', entryS ? 'reverted' : 'old-command', { backup: entryS ? entryS.backup : null, old_command: !entryS })
        if (before.merge !== after.merge) row(p.mergePath, '去掉旧的 prepend-proxies / prepend-rules 残留', entryM ? 'reverted' : 'old-command', { backup: entryM ? entryM.backup : null, old_command: !entryM })
        if (verified) say('clash', `the Clash route is gone: stripped from ${p.scriptPath} and the runtime, mihomo reloaded, ${PROXY_NAME} no longer in its live proxy list`, { file: p.scriptPath })
        else {
          routeGone = false
          // the core did not answer (the reload never reached it, or it cannot be asked afterwards): the route is not known to be gone — 「不知道」, never "gone" (1.6 §6)
          const unknown = (!!r.reload && r.reload.status === 0) || (r.ok && live === null)
          const tried = ((clash.located() || {}).tried || []).join(', ') || 'none'
          const why = unknown
            ? `不知道 · the Clash core did not answer, so whether ${PROXY_NAME} is still routed could not be read back (${(r.reload && r.reload.error) || `no live control socket found (tried: ${tried})`}); is Clash Verge running? Start it and run asight off again`
            : r.reason
          fail(CODE_NOT_UNDONE, `the Clash route was not confirmed gone: ${why}`, { file: p.scriptPath })
          res.left.push({ path: p.scriptPath, harness: CLAUDE_CODE, result: unknown ? 'unknown' : 'error', reason: why })
          res.clash_unknown = unknown
        }
        if (r.mergeCleanup && r.mergeCleanup.ok === false) fail(CODE_NOT_UNDONE, `${r.mergeCleanup.path} could not be cleaned: ${r.mergeCleanup.error}`, { file: r.mergeCleanup.path })
        // the ledger: a backup goes when the file is back to what it was; one the file no longer matches is kept and listed (R2)
        if (verified) {
          for (const [entry, file, sha] of [...entriesS.map((e) => [e, p.scriptPath, after.script]), ...entriesM.map((e) => [e, p.mergePath, after.merge])]) {
            if (entry.backup && sha === entry.pre_sha256) { try { if (dropBackup(entry.backup, fs)) { const c = res.changed.find((x) => x.path === file); if (c) c.backup_dropped = true } } catch (e) { res.notes.push(`${entry.backup} could not be removed (${legacyWhy(e)})`) } } else if (entry.backup) {
              res.kept_backups.push({ path: file, backup: entry.backup, reason: sha === entry.pre_sha256 ? 'kept' : 'the file is not byte for byte what it was before asight changed it (asight rewrote the stock no-op main(), or you edited it since): only asight\'s block was taken out', at: nowFn().toISOString() })
              const c = res.changed.find((x) => x.path === file); if (c) c.result = 'reverted-not-identical'
            }
            entry.__done = true
          }
        }
      } else res.skipped.push({ what: p.runtimePath, reason: 'Clash Verge is here, but nothing says asight put a route in it (no block, no ledger entry, not in the live proxy list): it is not reloaded' })
    }

    // 3 · the LaunchAgents: the MITM first (launchd sends it SIGTERM; it drains), then the monitor, then the environment primer
    if (onDarwin) {
      const unload = (a) => {
        const r = a.installed ? execTool('launchctl', ['unload', a.plistPath], { run: exec, env }) : execTool('launchctl', ['remove', a.label], { run: exec, env }) // loaded with no plist: only its label is left to name it
        const l = execTool('launchctl', ['list', a.label], { run: exec, env })
        const gone = l.code === null ? r.code === 0 : l.code !== 0 // launchctl list <label> exits non-zero for a label that is not loaded
        return { gone, why: gone ? null : `launchctl unload ${a.plistPath} did not take ${a.label} out (${r.err || `exit ${r.code}`})` }
      }
      const dropPlist = (a, what) => {
        try { fs.rmSync(a.plistPath, { force: true }) } catch (e) { fail(CODE_NOT_UNDONE, `${a.plistPath} could not be removed (${legacyWhy(e)})`, { file: a.plistPath }); res.left.push({ path: a.plistPath, harness: CLAUDE_CODE, result: 'error', reason: legacyWhy(e) }); return false }
        res.removed.push(a.plistPath); say('launch-agent', `${a.label} was unloaded and ${a.plistPath} removed${what ? ` (${what})` : ''}`, { file: a.plistPath }); return true
      }
      const present = (a) => a.installed === true || a.loaded === true
      const ledgerRow = (a, kind) => ledgerEntry(ledger, kind, a.plistPath)
      // the MITM
      const mitm = art.agents.mitm
      if (present(mitm)) {
        if (!routeGone) {
          res.skipped.push({ what: mitm.label, reason: 'the Clash route was not confirmed gone, so the MITM was left running: unloading it now would leave Claude Desktop pointed at a proxy that is not there' })
        } else {
          const tail = legacyEventsTail(home, fs)
          const lastStart = [...tail.recs].reverse().find((r) => r.event === 'mitm-start' && (r.source || 'mitm') === 'mitm')
          const pid = mitm.pid ?? (lastStart && Number.isInteger(lastStart.pid) && alive(lastStart.pid) ? lastStart.pid : null)
          const stoppedAfter = nowFn().toISOString()
          const u = unload(mitm)
          if (!u.gone) { fail(CODE_NOT_UNDONE, u.why, { file: mitm.plistPath }); res.left.push({ path: mitm.plistPath, harness: CLAUDE_CODE, result: 'error', reason: u.why }); res.cut = 'unknown'; res.cut_reason = u.why } else {
            if (pid == null) { res.cut = mitm.loaded === false || mitm.loaded === true ? 0 : 'unknown' } else {
              // the MITM drains: it stops accepting, waits for open connections for at most drainMs, writes `mitm-stop` with `cut`, exits. Wait for that line.
              const end = clk.ms() + drainMs + MITM_STOP_GRACE_MS
              let stop = null, gone = false
              for (;;) {
                const t = legacyEventsTail(home, fs)
                stop = t.recs.find((r) => r.event === 'mitm-stop' && (r.source || 'mitm') === 'mitm' && r.pid === pid && String(r.ts) >= stoppedAfter) || null
                gone = !alive(pid)
                if (stop || gone || clk.ms() >= end) break
                await clk.sleep(250)
              }
              if (stop && Number.isInteger(stop.cut)) res.cut = stop.cut
              else if (stop) { res.cut = 'unknown'; res.cut_reason = 'this MITM was started by a build that does not count the connections it cuts' }
              else if (gone) { res.cut = 'unknown'; res.cut_reason = `the MITM (pid ${pid}) is gone, but wrote no mitm-stop line: ${tail.error || 'killed, or the log could not be read'}` }
              else { res.cut = 'unknown'; res.cut_reason = `the MITM (pid ${pid}) is still running ${Math.round((drainMs + MITM_STOP_GRACE_MS) / 1000)} s after its unload`; fail(CODE_NOT_UNDONE, res.cut_reason, { file: mitm.plistPath }) }
            }
            if (dropPlist(mitm, res.cut === 0 ? '没有在途连接' : typeof res.cut === 'number' ? `${res.cut} 条在途连接被切断` : null)) {
              row(mitm.plistPath, '卸载并删除 com.asight.mitm', ledgerRow(mitm, 'legacy-launch-agent') ? 'reverted' : 'old-command', { old_command: !ledgerRow(mitm, 'legacy-launch-agent'), launch_agent: true })
              const e = ledgerRow(mitm, 'legacy-launch-agent'); if (e) e.__done = true
            }
          }
        }
      }
      // the monitor (the old CC-CLI reverse proxy's boot item) and the environment primer
      for (const key of ['monitor', 'env']) {
        const a = art.agents[key]
        if (!present(a)) continue
        const u = unload(a)
        if (!u.gone) { fail(CODE_NOT_UNDONE, u.why, { file: a.plistPath }); res.left.push({ path: a.plistPath, harness: CLAUDE_CODE, result: 'error', reason: u.why }); continue }
        if (dropPlist(a, null)) {
          const kind = key === 'env' ? 'legacy-env' : 'legacy-launch-agent'
          row(a.plistPath, `卸载并删除 ${a.label}`, ledgerRow(a, kind) ? 'reverted' : 'old-command', { old_command: !ledgerRow(a, kind), launch_agent: true })
          const e = ledgerRow(a, kind); if (e) e.__done = true
        }
      }
      // the login environment's CA variable: asight's own value only
      const mine = ownCaPaths(art, home)
      if (art.envValue.value && mine.has(art.envValue.value)) {
        const r = execTool('launchctl', ['unsetenv', LEGACY_ENV_VAR], { run: exec, env })
        if (r.code === 0) { row('launchctl', `unsetenv ${LEGACY_ENV_VAR}(登录环境里它指向 asight 的 CA)`, 'old-command', { old_command: true, environment: true }); say('login-env', `${LEGACY_ENV_VAR} was unset in the login environment (it pointed at asight's CA)`) } else fail(CODE_NOT_UNDONE, `launchctl unsetenv ${LEGACY_ENV_VAR} failed (${r.err || `exit ${r.code}`}): the login environment still points at asight's CA`)
      } else if (art.envValue.value) res.notes.push(`${LEGACY_ENV_VAR} in the login environment is ${art.envValue.value}, not asight's CA: left as it is`)
      else if (art.envValue.error) res.notes.push(`${art.envValue.error}: whether the login environment still points at asight's CA is not known`)
    }

    // 4 · the old CA in the user-level trust store
    if (art.oldCa.where && art.oldCa.present !== false && (platform === 'darwin' || platform === 'linux')) {
      let last = null, chk = null
      const f = caFindArgv({ platform, home })
      const missing = (c) => c.code === 44 || /could not be found|could not find/i.test(`${c.err}${c.out}`)
      for (let tries = 0; tries < 5; tries++) { // a second same-CN CA (2026-07-21) goes too: delete, look again, until the store says there is none
        last = uninstallCa({ platform, home, run: exec, env })
        chk = execTool(f.file, f.args, { run: exec, env })
        if (missing(chk) || last.status !== 0) break
      }
      const gone = missing(chk)
      if (gone || (last.status === 0 && chk.code !== 0)) { row(platform === 'darwin' ? p.keychain : p.nssdb, `去掉旧 CA(${platform === 'darwin' ? LEGACY_CA_CN : LEGACY_CA_NICKNAME})`, 'old-command', { old_command: true, trust_store: true }); say('old-ca', `the old CA was taken out of the user trust store (${platform === 'darwin' ? 'login keychain' : 'NSS database'})`) } else {
        fail(CODE_NOT_UNDONE, `the old CA is still in the user trust store (${(last.stderr || `exit ${last.status}`)})`)
        res.left.push({ path: platform === 'darwin' ? p.keychain : p.nssdb, harness: CLAUDE_CODE, result: 'error', reason: last.stderr || `exit ${last.status}` })
      }
    } else if (art.oldCa.present === null) res.notes.push(`${art.oldCa.error}: whether the old CA is in the trust store is not known`)

    // 5 · the claude processes that were started while the CC-CLI steer was in settings.json still point at its port: said, not stopped (R8)
    if (steerUndone) {
      try {
        const table = await (procs ? procs() : listProcs({ platform, exec }))
        for (const x of table) {
          const isClaude = (x.argv || [x.exe]).some((a) => /(^|\/)claude(-code)?$/.test(String(a || '')))
          if (isClaude && !(steerSince != null && x.startedAt != null && x.startedAt < steerSince)) res.restart.push({ harness: CLAUDE_CODE, pid: x.pid })
        }
        if (res.restart.length) res.notes.push(`正在跑的 claude 进程(${res.restart.map((r) => r.pid).join(', ')})若是 steer 生效期间启动的,重启前仍连着那个本地端口;asight 不替你重启它们`)
      } catch (e) { legacyRethrowSandbox(e); res.notes.push(`the process table could not be read (${legacyWhy(e)}), so the claude processes started while the CC-CLI steer was on are not listed`) }
    }

    // 6 · the ledger: what was undone is struck off; the file goes when nothing is left in it
    if (ledger) {
      const m = ledger.manifest
      m.entries = (m.entries || []).filter((e) => !e.__done)
      for (const e of m.entries) delete e.__done
      m.kept_backups = [...(m.kept_backups || []), ...res.kept_backups]
      try {
        if (!m.entries.length && !(m.kept_backups || []).length && !(m.files || []).length) { fs.rmSync(ledger.path, { force: true }); res.removed.push(ledger.path) } else saveManifestAt(ledger.path, m, fs)
      } catch (e) { res.notes.push(`the ledger ${ledger.path} could not be updated (${legacyWhy(e)})`) }
    }
    if (!res.changed.length && !res.problems.length && !res.removed.length) say('nothing', 'there was nothing of the old capture to undo')
    say('result', res.ok ? `the old capture was taken out: ${res.changed.length} change(s), cut ${res.cut}` : `the old capture was not fully taken out: ${res.problems[0]}`, { counts: { changed: res.changed.length, left: res.left.length } })
  } finally {
    if (marked) { try { fs.rmSync(marker, { force: true }) } catch { /* a marker nobody's pid is behind is ignored by the watch */ } }
  }
  return res
}

// the paths the login environment's CA variable may point at and still be asight's: the one the env plist sets, and the two CA directories (D27)
function ownCaPaths(art, home) {
  const out = new Set([path.join(asightHome(home), 'ca', 'atrace-ca.crt'), path.join(home, '.atrace', 'ca', 'atrace-ca.crt')])
  if (art.agents && art.agents.env && art.agents.env.caPath) out.add(art.agents.env.caPath)
  return out
}

/** `undoLegacy` as the `legacyUndo` hook of `asight off` / `asight uninstall` on Linux, in the shape of their receipts (src/off/orchestrate.mjs, src/cli/uninstall.mjs): the CC steer and the NSS CA
 *  that an old command left there. It writes nothing when there is nothing (a run of `off` that has no old capture to undo must not leave a file). */
export async function legacyUndoHook(ctx = {}) {
  const r = await undoLegacy({ home: ctx.home, platform: 'linux', exec: ctx.exec || null, fs: ctx.fs || nodeFs, env: ctx.env || process.env, now: ctx.now || null })
  return { changed: r.changed, removed: r.removed, skipped: r.skipped, left: r.left, problems: r.problems, notes: r.notes, ok: r.ok }
}

