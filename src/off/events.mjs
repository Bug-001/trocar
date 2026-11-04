// events.mjs (src/off) — the one line of a `flows/` event (RFC 4.6 §记录, D38): `{ts, event, …}` appended to
// <collector>/flows/<UTC date>.ndjson with the writer's own descriptor, so a record store whose files broke can still say that it broke.
// Moved here from src/collector/core/events.mjs (which re-exports it as `appendEvent`): `trocar off` writes its `off-note` lines the same
// way and may import nothing outside src/off (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { hideUserinfo } from './userinfo.mjs'

/** Appends `{ts, ...rec}` to `<dir>/flows/<day>.ndjson` (0600, the directory 0700). `day` (YYYY-MM-DD): the file to write when the caller keeps a
 *  day that never goes back (the daemon's recorder); default the UTC day of `now`. Throws what the write throws. */
/** The flows/ file a line written at `now` goes to: one per UTC day. */
export const flowFile = (dir, now = new Date(), day = null) => path.join(dir, 'flows', `${day || now.toISOString().slice(0, 10)}.ndjson`)
export function appendFlowEvent(dir, rec, { now = new Date(), day = null, fs = nodeFs } = {}) {
  const file = flowFile(dir, now, day)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, hideUserinfo(JSON.stringify({ ts: now.toISOString(), ...rec })) + '\n', { mode: 0o600 }) // a line names a URL without its userinfo (1.6 §1.2)
}

const eventErr = (e) => String((e && e.message) || e)
const stderrLine = (m) => { try { process.stderr.write(`${m}\n`) } catch { /* nothing is left to tell it to */ } }

/** The writer of the lines of ONE run of a command that changes state (`off`, `uninstall`, `on`): `put(rec)` appends `{...base, ...rec}` to flows/. A line that cannot be written is
 *  never dropped quietly (RFC 1.6 R11, 4.6 §记录「记录本身写不成」, the way the daemon's recorder does it): stderr gets it first, the receipt's `notes` get it (the command's own output
 *  is then the record), and the next line that CAN be written is preceded by one `log-gap {from, to, lost, error}`, so the gap is on disk too. Never throws. `now` is a function
 *  that gives a Date; `log(message)` replaces stderr (a test's). */
export function runEventWriter({ dir, base = {}, notes = [], now = () => new Date(), fs = nodeFs, log = stderrLine } = {}) {
  let gap = null // { from, lost, error } while lines are being lost
  return (rec) => {
    const at = now()
    try {
      if (gap) {
        appendFlowEvent(dir, { event: 'log-gap', ...(base.where ? { where: base.where } : {}), ...(base.run ? { run: base.run } : {}), from: gap.from, to: at.toISOString(), lost: gap.lost, error: gap.error, reason: `${gap.lost} event line(s) could not be written (${gap.error})` }, { now: at, fs })
        gap = null
      }
      appendFlowEvent(dir, { ...base, ...rec }, { now: at, fs })
    } catch (e) {
      if (!gap) gap = { from: at.toISOString(), lost: 0, error: null }
      gap.lost++; gap.error = eventErr(e)
      log(`trocar: an event line could not be written to ${dir}/flows (${eventErr(e)}): ${rec.reason}`)
      notes.push(`not recorded (${eventErr(e)}): ${rec.reason}`)
    }
  }
}
