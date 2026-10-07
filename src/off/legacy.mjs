// legacy.mjs (src/off) — taking the OLD capture out of a machine: what `asight off` does on a platform without the new collector, and what it still finds on Linux (RFC 1.6 §4 「旧采集(过渡期)」,
// §6 「核对生效」, R2 / R3 / R11; D28 only asight's own block, key and line; D29 the VPN software is asked, not trusted; D31 transition). The old capture is: the CC-CLI steer in
// ~/.claude/settings.json (HTTPS_PROXY pointing at the local proxy, the displaced values in a stash), the Clash Verge route (a sentinel block in Script.js, its copy in the runtime config), three
// LaunchAgents (com.asight.mitm, com.asight.monitor, com.asight.env), the CA in the login keychain (macOS) or the user NSS database (Linux), and ~/.asight/legacy-manifest.json — the ledger of
// what `asight on` wrote through it (a thing an old command wrote, `desktop on` and `monitor on`, is not in the ledger: its own mark is its ledger, and it is called 「旧命令装的,无备份」).
// Imports only node:* and src/off (0.1 §2): the standalone ~/.asight/bin/asight-off is made of this directory, so the undo works when the repository is gone.
//   hasNewCollector     the one question that decides which generation `on` / `off` / `status` drive on a platform (1.6 §1.2)
//   clearCliSteer · uninstallCa · caRemoveArgv      the steer and the CA undo, moved from src/capture/onboard.mjs and trust-store.mjs, which call them: there is one undo, not two
//   legacyArtifacts     what of the old capture is there (read only)
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { readOrNull } from './fsutil.mjs'
import { legacyManifestPath } from './paths.mjs'
import { readManifestAt } from './manifest.mjs'
import { makeClash, stripBlock, stripRuntime, stripMergeLegacy, SCRIPT_BEGIN } from './clash.mjs'

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
