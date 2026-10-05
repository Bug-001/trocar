// events.mjs — durable failure records (D38: a capture failure is never silent).
// Every failure the collector owns becomes one JSON line `{ts, event, reason, …}` in <collector>/flows/<UTC date>.ndjson
// (RFC 4.6 §记录: the board never reads flows/, so these are never mistaken for envelopes). appendEvent writes with its
// own descriptor, so a record store whose files broke can still report that it broke. recentFailures reads them
// back for `asight collector status`, also when no daemon is running.
import nodeFs from 'node:fs'
import path from 'node:path'

// Event kinds that are failures (the daemon's, the switch's, the tracker's, install's).
export const FAILURE_EVENTS = new Set(['failure', 'helper-down', 'helper-version-mismatch', 'attach-failed', 'detach-failed', 'agent-untrusted'])

export function appendEvent(dir, rec, { now = new Date(), fs = nodeFs } = {}) {
  const file = path.join(dir, 'flows', `${now.toISOString().slice(0, 10)}.ndjson`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, JSON.stringify({ ts: now.toISOString(), ...rec }) + '\n', { mode: 0o600 })
}

// A failure event, or a flow the engine could not capture: the client rejected the leaf (it does not trust the
// asight CA), the upstream failed, or a not_captured label.
export const isFailure = (r) => !!r && (FAILURE_EVENTS.has(r.event) || (r.flow_id != null && (r.reason === 'client-rejected-leaf' || r.error != null || r.not_captured != null)))

export function recentFailures(dir, { limit = 10, files = 2, maxBytes = 1 << 20, fs = nodeFs } = {}) {
  const d = path.join(dir, 'flows')
  let names
  try { names = fs.readdirSync(d).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort().slice(-files) } catch { return [] }
  const out = []
  for (const n of names) {
    const buf = fs.readFileSync(path.join(d, n))
    const text = buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8')
    for (const line of text.split('\n')) {
      let r = null
      try { r = JSON.parse(line) } catch { continue } // the first line of a tail may be cut
      if (isFailure(r)) out.push(r)
    }
  }
  return out.slice(-limit)
}
