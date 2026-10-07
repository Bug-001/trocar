// legacy.mjs (src/off) — taking the OLD capture out of a machine: what `asight off` does on a platform without the new collector, and what it still finds on Linux (RFC 1.6 §4 「旧采集(过渡期)」,
// §6 「核对生效」, R2 / R3 / R11; D28 only asight's own block, key and line; D29 the VPN software is asked, not trusted; D31 transition). The old capture is: the CC-CLI steer in
// ~/.claude/settings.json (HTTPS_PROXY pointing at the local proxy, the displaced values in a stash), the Clash Verge route (a sentinel block in Script.js, its copy in the runtime config), three
// LaunchAgents (com.asight.mitm, com.asight.monitor, com.asight.env), the CA in the login keychain (macOS) or the user NSS database (Linux), and ~/.asight/legacy-manifest.json — the ledger of
// what `asight on` wrote through it (a thing an old command wrote, `desktop on` and `monitor on`, is not in the ledger: its own mark is its ledger, and it is called 「旧命令装的,无备份」).
// Imports only node:* and src/off (0.1 §2): the standalone ~/.asight/bin/asight-off is made of this directory, so the undo works when the repository is gone.
//   hasNewCollector     the one question that decides which generation `on` / `off` / `status` drive on a platform (1.6 §1.2)
//   clearCliSteer · uninstallCa · caRemoveArgv      the steer and the CA undo, moved from src/capture/onboard.mjs and trust-store.mjs, which call them: there is one undo, not two
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { execTool } from './exec.mjs'

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
/** Takes the CA out of the user trust store: the runner's `{ status, stdout, stderr }` of the delete (the same shape the trust-store installers return). `run` replaces the spawn. */
export function uninstallCa({ platform, home = nodeOs.homedir(), run = null, env = process.env, keychain = null, nssdb = null }) {
  const a = caRemoveArgv({ platform, home, keychain, nssdb })
  const r = execTool(a.file, a.args, { run, env })
  return { status: r.code, stdout: r.out, stderr: r.err }
}
