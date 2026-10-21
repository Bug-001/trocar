// door-seen.mjs (src/off) — the door's durable record of the lives it met (4.11 P12 「门的持久记录」): `~/.trocar/collector/door-seen.json` =
// `{ version: 1, rows: [{ harness, group, pid, start, kind: 'accept' | 'pac', at, n, decrypt?, reason? }] }`. The daemon writes it when a door
// accepts a connection or hands out a PAC; `off`'s receipt, `status` and `uninstall` with the daemon down read the same file. A file that cannot be
// read is "door evidence not known" (rows null), never "no row": the holders then take the safe direction (D50). Imports only src/off and node:*.
import nodeFs from 'node:fs'
import path from 'node:path'
import { writeDurable } from './fsutil.mjs'

export const DOOR_SEEN_FILE = 'door-seen.json'
export const DOOR_SEEN_MAX = 256 // rows kept, the newest by `at`

export const msOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : Number.isFinite(v) ? v : NaN; return Number.isFinite(t) ? t : null }

/** → { rows, error }: a missing file is no row ([], null); an unreadable or malformed one is rows null with the reason in one sentence. */
export function readDoorSeen({ dir, fs = nodeFs } = {}) {
  let raw
  try { raw = fs.readFileSync(path.join(dir, DOOR_SEEN_FILE), 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return { rows: [], error: null }
    return { rows: null, error: `the door record ${DOOR_SEEN_FILE} could not be read (${(e && e.code) || e})` }
  }
  let doc
  try { doc = JSON.parse(raw) } catch { return { rows: null, error: `the door record ${DOOR_SEEN_FILE} is not JSON` } }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rows)) return { rows: null, error: `the door record ${DOOR_SEEN_FILE} has no rows list` }
  return { rows: doc.rows.filter((r) => r && typeof r === 'object'), error: null }
}

/** Replaces the file atomically (temp + rename, 0600) with the newest DOOR_SEEN_MAX rows by `at`. */
export function writeDoorSeen({ dir, rows = [], fs = nodeFs } = {}) {
  const kept = [...rows].sort((a, b) => (msOf(a.at) ?? -Infinity) - (msOf(b.at) ?? -Infinity)).slice(-DOOR_SEEN_MAX)
  fs.mkdirSync(dir, { recursive: true })
  writeDurable(path.join(dir, DOOR_SEEN_FILE), `${JSON.stringify({ version: 1, rows: kept })}\n`, 0o600, fs)
}

/** The harness whose liveness record governs a row: its group's, before ':' (a row without a group: its harness). */
export const groupHarness = (row) => (typeof row.group === 'string' && row.group.includes(':') ? row.group.slice(0, row.group.indexOf(':')) : row.harness)

/** Is `row` still evidence (P12): its door value unchanged since — `at` ≥ door_since[group] and ≥ since, where the record states them. */
export function validFor(row, l) {
  const at = msOf(row && row.at)
  if (at == null) return false
  const ds = l && l.door_since && typeof l.door_since === 'object' ? msOf(l.door_since[row.group]) : null
  const since = l ? msOf(l.since) : null
  return (ds == null || at >= ds) && (since == null || at >= since)
}
export const validRow = (row, liveness) => validFor(row, ((liveness || {})[groupHarness(row || {})]) || null)
