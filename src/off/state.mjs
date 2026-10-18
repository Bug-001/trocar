// state.mjs — ~/.asight/collector/state.json: what the operator asked for, per harness (RFC 1.6 §1.5, 4.6 §开关语义, D39②).
//   version 2: { version: 2, updated_at, harnesses: { <id>: { desired: 'on'|'off', policy?: 'auto'|'all', extra_hosts?: [..], updated_at } } }
//   version 1 (before D39): { version: 1, desired, policy, extra_hosts, updated_at } — one switch for everything; read as version 2 by
//   giving each installed harness the same three values (migrateV1).
// This module reads, migrates and writes the file and knows nothing else: the daemon's switch (src/collector/core/switch.mjs) and the
// undo side (`asight off`, the standalone `asight-off`) both come through here, so a file written by one is read by the other. It
// imports only node:* (0.1 §2: src/off/ is what the single-file copy is generated from). An entry may omit `policy` / `extra_hosts`:
// the reader that needs them fills the default (the daemon's DEFAULT_POLICY, `[]`); this module never invents either.
// A file that is there and cannot be read is thrown, never read as "everything off" here: what to do about it (all off, say so) is
// the caller's — `code: 'state-unparsable'` for text that is not a state, the errno for a file that could not be read at all.
// Writes (R12): a temp file next to it, fsync, rename, fsync the directory; the file is 0600 and a directory made for it 0700, so
// a reader never sees half a file and a crash leaves the old one or the new one.
import nodeFs from 'node:fs'
import path from 'node:path'
import { fsyncDir } from './fsutil.mjs'

export const STATE_VERSION = 2

const unparsable = (file, why) => Object.assign(new Error(`${file} ${why}`), { code: 'state-unparsable' })
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hostList = (v) => v.filter((h) => typeof h === 'string')

/** A state nobody has written yet: no harness is on. */
export const emptyState = () => ({ version: STATE_VERSION, updated_at: null, harnesses: {} })

// one harness entry as read: `desired` is on only when it says so; policy / extra_hosts only when present and well formed
function readEntry(e) {
  const { policy, extra_hosts: hosts, ...rest } = isPlain(e) ? e : {}
  return {
    ...rest,
    desired: rest.desired === 'on' ? 'on' : 'off',
    ...(policy === 'all' || policy === 'auto' ? { policy } : {}),
    ...(Array.isArray(hosts) ? { extra_hosts: hostList(hosts) } : {}),
    updated_at: typeof rest.updated_at === 'string' ? rest.updated_at : null,
  }
}

/** A version 1 state read as version 2: every installed harness gets the same desired / policy / extra_hosts, and `updated_at` is
 *  the old file's (so "capture off since T" does not move) or `now`. A v1 field that is not well formed reads as off / absent. */
export function migrateV1(v1, installedIds, now = new Date()) {
  const at = typeof v1.updated_at === 'string' && v1.updated_at ? v1.updated_at : now.toISOString()
  const one = {
    desired: v1.desired === 'on' ? 'on' : 'off',
    ...(v1.policy === 'all' || v1.policy === 'auto' ? { policy: v1.policy } : {}),
    ...(Array.isArray(v1.extra_hosts) ? { extra_hosts: hostList(v1.extra_hosts) } : {}),
    updated_at: at,
  }
  return { version: STATE_VERSION, updated_at: at, harnesses: Object.fromEntries(installedIds.map((id) => [id, { ...one, ...(one.extra_hosts ? { extra_hosts: [...one.extra_hosts] } : {}) }])) }
}

/** Reads `file` → `{ state, from }`: `from` is the version the file had (1, 2) or null when there is no file (then `state` is
 *  `emptyState()`). A version 1 file comes back migrated for `installed` (default: no harness, so nothing is on). Throws what could
 *  not be read (its errno), or `state-unparsable` for a file that is not a state or has a version this build does not know. */
export function readStateFile(file, { fs = nodeFs, installed = [], now = new Date() } = {}) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { if (e && e.code === 'ENOENT') return { state: emptyState(), from: null }; throw e }
  let v
  try { v = JSON.parse(text) } catch (e) { throw unparsable(file, `does not parse (${e.message})`) }
  if (!isPlain(v)) throw unparsable(file, 'is not a JSON object')
  if (v.version === undefined || v.version === 1) return { state: migrateV1(v, installed, now), from: 1 } // an old file without a version is version 1's shape
  if (v.version !== STATE_VERSION) throw unparsable(file, `is version ${JSON.stringify(v.version)}; this build reads versions 1 and ${STATE_VERSION}`)
  const hs = isPlain(v.harnesses) ? v.harnesses : {}
  return { state: { version: STATE_VERSION, updated_at: typeof v.updated_at === 'string' ? v.updated_at : null, harnesses: Object.fromEntries(Object.entries(hs).map(([id, e]) => [id, readEntry(e)])) }, from: 2 }
}

/** A new state with `ids` set to `desired` and their own `updated_at` and the top-level one at `now`; what else an entry holds (policy,
 *  extra_hosts) is kept, and a harness that had no entry gets a new one. `state` is not changed. */
export function setDesired(state, ids, desired, now = new Date()) {
  const at = now.toISOString()
  const harnesses = { ...state.harnesses }
  for (const id of ids) harnesses[id] = { ...(harnesses[id] || {}), desired: desired === 'on' ? 'on' : 'off', updated_at: at }
  return { ...state, version: STATE_VERSION, updated_at: at, harnesses }
}

/** Writes `state` to `file` whole or not at all (temp file in the same directory, fsync, rename, fsync the directory), 0600, in a
 *  0700 directory when it had to be made. Throws what failed, and leaves no temp file behind. */
export function writeStateAtomic(file, state, { fs = nodeFs } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  let fd
  try {
    fd = fs.openSync(tmp, 'w', 0o600)
    fs.writeSync(fd, JSON.stringify(state, null, 2) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* the failure that matters is e */ }
    try { fs.rmSync(tmp, { force: true }) } catch { /* same */ }
    throw e
  }
  fsyncDir(fs, dir)
}
