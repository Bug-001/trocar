// paths.mjs (src/off) — where trocar keeps what `off` has to find, for one HOME. src/off may import nothing outside itself (0.1 §2: the
// standalone `~/.trocar/bin/trocar-off` is made of this directory alone), so these few paths are written here instead of imported from
// src/paths.mjs; test/paths.test.mjs makes the two one fact (and oldCaDir the same answer as caDir() in every shape, D27).
// Every function takes the user's HOME (default: the process's) so a test points it at a sandbox; none touches the disk but oldCaDir.
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DOOR_SEEN_FILE } from './door-seen.mjs'
import { CONTROL_FILE } from './control-client.mjs'

/** ~/.trocar (D27; the v0 prototype's ~/.atrace is read, never written, and is not here). */
export const trocarHome = (home = os.homedir()) => path.join(home, '.trocar')
/** ~/.trocar/collector: the manifest, state.json, the lock, the CA, the daemon's records. */
export const collectorDir = (home = os.homedir()) => collectorIn(trocarHome(home))
/** The same directory named from the TROCAR home instead of the user's (whoever already holds ~/.trocar: the board's
 *  server, src/server.mjs — so a server given a sandbox home asks THAT sandbox's daemon and no other). */
export const collectorIn = (home) => path.join(home, 'collector')
/** ~/.trocar/backup: what trocar saved of a user's file before changing it (1.6 R2; 0700, the files 0600). */
export const backupDir = (home = os.homedir()) => path.join(trocarHome(home), 'backup')
/** ~/.trocar/bin/trocar-off: the single-file copy of src/off that runs without the repo (1.6 R3). */
export const standalonePath = (home = os.homedir()) => path.join(trocarHome(home), 'bin', 'trocar-off')
/** ~/.trocar/app: what the install script places (4.5 §A, D74): `<version>/`, `node/<id>/`, the pointer `current`. The one resolver of it. */
export const appDir = (home = os.homedir()) => path.join(trocarHome(home), 'app')
/** ~/.trocar/bin/trocar (Windows trocar.cmd): the launcher that reads `app/current` and runs the version it names. */
export const launcherPath = (home = os.homedir(), platform = process.platform) => path.join(trocarHome(home), 'bin', platform === 'win32' ? 'trocar.cmd' : 'trocar')
const cmdBeside = (p) => `${p}.cmd`
/** The files of that copy, one list that is written, checked, listed and removed as one (1.6 §3.2 step 1): trocar-off, and on Windows, which ignores the
 *  shebang, trocar-off.cmd beside it, which starts it with the Node the launcher would (`..\app\current`'s node.exe, else `node`). */
export const standaloneFiles = (home = os.homedir(), platform = process.platform) => [standalonePath(home), ...(platform === 'win32' ? [cmdBeside(standalonePath(home))] : [])]
/** The command that runs that copy, the one place it is worded: elsewhere the path runs itself (its sh prologue finds a Node); on Windows the .cmd of
 *  standaloneFiles, as `cmd --% /c @"<path>.cmd"` — one line that PowerShell and cmd both run unchanged (1.6 §1.1⑤): PowerShell hands everything after
 *  `--%` to cmd as it is, cmd skips that word, and the `@` keeps `/c` from stripping the quotes, so spaces, `&`, `(`, `^` in the path stay. */
export function standaloneCommand(p, platform = process.platform) {
  return platform === 'win32' ? `cmd --% /c @"${cmdBeside(p)}"` : p
}
/** ~/.trocar/legacy-manifest.json: the ledger of what `on` changed through the old capture. */
export const legacyManifestPath = (home = os.homedir()) => path.join(trocarHome(home), 'legacy-manifest.json')
/** ~/.trocar/legacy-op.lock: the lock of the one `on` / `off` / `uninstall` that changes the old capture at a time (1.6 R12; the old capture has no ~/.trocar/collector/). */
export const legacyLockPath = (home = os.homedir()) => path.join(trocarHome(home), 'legacy-op.lock')
/** What the operator asked for, per harness (1.6 §1.5); the daemon reads the same file. */
export const stateFile = (home = os.homedir()) => path.join(collectorDir(home), 'state.json')
/** The user's PATH as the last state-changing command run in a terminal saw it (user-path.mjs, 4.11 §2.3 `present`). */
export const USER_PATH_FILE = 'user-path.json'
/** The daemon's own state in ~/.trocar/collector (not captures, 0.2): every uninstall removes these once the daemon has stopped, and its plan names
 *  the same list, so for these files the plan and the act cannot drift. door-seen.json is read by uninstall's holder check first (4.11 P12). */
export const BOARD_TOKEN_FILE = 'board.token' // the board's per-user token, 0600 (4.4, D26③)
export const COLLECTOR_STATE_FILES = ['state.json', CONTROL_FILE, BOARD_TOKEN_FILE, 'update.json', DOOR_SEEN_FILE, USER_PATH_FILE]
/** The lock of the one command that changes state at a time (1.6 R12). */
export const opLockFile = (home = os.homedir()) => path.join(collectorDir(home), 'op.lock')

/** The old capture's CA directory (D27): ~/.trocar/ca, else ~/.atrace/ca when only that exists — a root already trusted by its subject
 *  name keeps being THE CA wherever it sits; only a machine with no CA at all has the new place. Same answer as src/paths.mjs caDir(). */
export function oldCaDir(home = os.homedir(), fs = nodeFs) {
  const there = (p) => { try { return fs.existsSync(p) } catch { return false } }
  const fresh = path.join(trocarHome(home), 'ca')
  if (there(fresh)) return fresh
  const legacy = path.join(home, '.atrace', 'ca')
  return there(legacy) ? legacy : fresh
}
