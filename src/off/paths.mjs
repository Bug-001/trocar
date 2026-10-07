// paths.mjs (src/off) — where asight keeps what `off` has to find, for one HOME. src/off may import nothing outside itself (0.1 §2: the
// standalone `~/.asight/bin/asight-off` is made of this directory alone), so these few paths are written here instead of imported from
// src/paths.mjs; test/paths.test.mjs makes the two one fact (and oldCaDir the same answer as caDir() in every shape, D27).
// Every function takes the user's HOME (default: the process's) so a test points it at a sandbox; none touches the disk but oldCaDir.
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** ~/.asight (D27; the v0 prototype's ~/.atrace is read, never written, and is not here). */
export const asightHome = (home = os.homedir()) => path.join(home, '.asight')
/** ~/.asight/collector: the manifest, state.json, the lock, the CA, the daemon's records. */
export const collectorDir = (home = os.homedir()) => path.join(asightHome(home), 'collector')
/** ~/.asight/backup: what asight saved of a user's file before changing it (1.6 R2; 0700, the files 0600). */
export const backupDir = (home = os.homedir()) => path.join(asightHome(home), 'backup')
/** ~/.asight/bin/asight-off: the single-file copy of src/off that runs without the repo (1.6 R3). */
export const standalonePath = (home = os.homedir()) => path.join(asightHome(home), 'bin', 'asight-off')
/** ~/.asight/legacy-manifest.json: the ledger of what `on` changed through the old capture (1.6 §4). */
export const legacyManifestPath = (home = os.homedir()) => path.join(asightHome(home), 'legacy-manifest.json')
/** ~/.asight/legacy-off.pending: `{pid, at}` while `asight off` is between stripping the old capture's Clash block and unloading its MITM (1.6 §4); the MITM's steer watch does not call the block's going away a failure then. */
export const legacyPendingPath = (home = os.homedir()) => path.join(asightHome(home), 'legacy-off.pending')
/** ~/.asight/legacy-op.lock: the lock of the one `on` / `off` / `uninstall` that changes the old capture at a time (1.6 R12; the old capture has no ~/.asight/collector/). */
export const legacyLockPath = (home = os.homedir()) => path.join(asightHome(home), 'legacy-op.lock')
/** ~/.asight/logs/mitm-events.ndjson: where the old capture says what it did and what failed (D38, RFC 4.1 过渡期); `asight off` writes its notes there on a platform without the new collector (1.6 R11). */
export const legacyEventsFile = (home = os.homedir()) => path.join(asightHome(home), 'logs', 'mitm-events.ndjson')
/** What the operator asked for, per harness (1.6 §1.5); the daemon reads the same file. */
export const stateFile = (home = os.homedir()) => path.join(collectorDir(home), 'state.json')
/** The lock of the one command that changes state at a time (1.6 R12). */
export const opLockFile = (home = os.homedir()) => path.join(collectorDir(home), 'op.lock')

/** The old capture's CA directory (D27): ~/.asight/ca, else ~/.atrace/ca when only that exists — a root already trusted by its subject
 *  name keeps being THE CA wherever it sits; only a machine with no CA at all has the new place. Same answer as src/paths.mjs caDir(). */
export function oldCaDir(home = os.homedir(), fs = nodeFs) {
  const there = (p) => { try { return fs.existsSync(p) } catch { return false } }
  const fresh = path.join(asightHome(home), 'ca')
  if (there(fresh)) return fresh
  const legacy = path.join(home, '.atrace', 'ca')
  return there(legacy) ? legacy : fresh
}
