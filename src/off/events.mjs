// events.mjs (src/off) — the one line of a `flows/` event (RFC 4.6 §记录, D38): `{ts, event, …}` appended to
// <collector>/flows/<UTC date>.ndjson with the writer's own descriptor, so a record store whose files broke can still say that it broke.
// Moved here from src/collector/core/events.mjs (which re-exports it as `appendEvent`): `asight off` writes its `off-note` lines the same
// way and may import nothing outside src/off (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'

/** Appends `{ts, ...rec}` to `<dir>/flows/<day>.ndjson` (0600, the directory 0700). `day` (YYYY-MM-DD): the file to write when the caller keeps a
 *  day that never goes back (the daemon's recorder); default the UTC day of `now`. Throws what the write throws. */
export function appendFlowEvent(dir, rec, { now = new Date(), day = null, fs = nodeFs } = {}) {
  const file = path.join(dir, 'flows', `${day || now.toISOString().slice(0, 10)}.ndjson`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, JSON.stringify({ ts: now.toISOString(), ...rec }) + '\n', { mode: 0o600 })
}
