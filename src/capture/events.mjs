// events.mjs — the old capture's durable failure records (D38, transitional — deleted with the old capture): one JSON line per failure or lifecycle step in ~/.asight/logs/mitm-events.ndjson,
// the shape of the collector's flows/ event lines ({ts, event, where?, code?, reason, …}; the closed names live in
// src/health/codes.mjs, which src/capture may not import — test/health/codes.test.mjs checks these writers against
// it). Not in the ~/.asight top level, so the board never reads it as envelopes; GET /api/capture-health reads it
// (its `legacy` part). A failure also gets one stderr line (launchd's ~/.asight/logs/*.log).
//   A line that cannot be written is never lost silently: stderr gets the line itself (the record is in front of the
// operator, at least) and the call returns false.
import fs from 'node:fs'
import path from 'node:path'
import { asightHome } from '../paths.mjs'

export const legacyEventsPath = (home = asightHome()) => path.join(home, 'logs', 'mitm-events.ndjson')
const stderr = (m) => { try { process.stderr.write(m + '\n') } catch { /* nothing left to tell */ } }

export function appendLegacyEvent(rec, { file = legacyEventsPath(), now = new Date(), log = stderr } = {}) {
  const line = { ts: now.toISOString(), ...rec }
  if (rec.event === 'failure') log(`asight ${rec.where}: ${rec.code}: ${rec.reason}`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
    return true
  } catch (e) {
    log(`asight: could not write ${file} (${(e && e.message) || e}) — this event is recorded nowhere else: ${JSON.stringify(line)}`)
    return false
  }
}
