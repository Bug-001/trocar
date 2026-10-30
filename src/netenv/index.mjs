// index.mjs (src/netenv) — trocar's own netenv.json: the adoption records and the topology (D49). ~/.trocar/netenv.json (0600; outside collector/, so a platform with no new collector writes it too) holds `schema`,
// `adopted` (what `on` found of each agent's proxy, 1.6 §9.5) and `topology` (what `status` drew, 1.6 §9); the board reads it through the `status` query (1.6 C.3). trocar looks at no VPN / proxy software.
// Read-only apart from this file: the only write in this directory is writeNetenv's own.
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { trocarHome } from '../off/paths.mjs'

export const NETENV_SCHEMA = 1
export const netenvFile = (home = os.homedir()) => path.join(trocarHome(home), 'netenv.json')

/** ~/.trocar/netenv.json as it is on disk → the object, or null when it is not there or does not parse (the board says that itself: src/health/read.mjs netenvOf). */
export function readNetenvFile(home, { fs = nodeFs } = {}) {
  try { const v = JSON.parse(fs.readFileSync(netenvFile(home), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}
/** What a write keeps of the file already there: `adopted` (what `on` found, 1.6 §9.5) is carried over when the new result has none, and so is each harness of
 *  `topology` the new one does not redraw (a `status codex` redraws codex only: the others keep their own `at`). */
export function mergeNetenv(prev, result) {
  const out = { ...result }
  if (!prev) return out
  if (out.adopted === undefined && prev.adopted !== undefined) out.adopted = prev.adopted
  if (out.topology !== undefined && prev.topology && typeof prev.topology === 'object') out.topology = { ...prev.topology, ...out.topology }
  else if (out.topology === undefined && prev.topology !== undefined) out.topology = prev.topology
  return out
}

/** Writes the result to ~/.trocar/netenv.json whole or not at all (temp file, rename), 0600 in a 0700 directory when it had to be made → `{ path }`; throws what failed. It is the one place under
 *  src/netenv that writes (4.7 N15). */
export function writeNetenv(home, result, { fs = nodeFs } = {}) {
  const file = netenvFile(home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schema: NETENV_SCHEMA, ...mergeNetenv(readNetenvFile(home, { fs }), result) }, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* the failure that matters is e */ } throw e }
  return { path: file }
}
