// flows.mjs — read the collector's flows/ back from the newest line and fold it (D38; RFC 4.6
// §记录「看得到」). Shared by `trocar status`, the board's `status` query and the daemon's GET /status (src/health/read.mjs).
//   readFlows: day files <UTC date>.ndjson newest first — until the lines read
// reach back past the last daemon-start AND cover the 24 h window, or until `maxBytes` (then `truncated`). A missing
// flows/ is "nothing recorded yet"; an unreadable one throws (`status` then has no `health` and names it in `errors`, never "no failures"); one
// unreadable file is listed in `errors` and the rest is still read.
//   foldFlows: in file and line order (never by ts: a clock that jumped must not reorder them) — the conditions that
// still hold since the last daemon-start, the failure groups and expected counts of the last 24 h, each agent's last
// capture and last failure. Every record that leaves here is cut down to a whitelist of metadata fields: no record
// bytes (ws.tail_raw, proxy preludes, bodies) ever reach the board.
import nodeFs from 'node:fs'
import path from 'node:path'
import { isFailure, notCapturedClass, expectedKey, LEVELS } from './codes.mjs'

export const WINDOW_MS = 24 * 3600e3
export const MAX_BYTES = 4 << 20
const DAY = /^(\d{4}-\d{2}-\d{2})\.ndjson$/
const errText = (e) => String((e && e.message) || e)
export class HealthUnreadable extends Error { constructor(m) { super(m); this.name = 'HealthUnreadable' } }

// One day file's complete lines; `budget` bytes at most, newest kept. → {lines: [string], bytes, cut}
function readDayFile(file, budget, fs) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, budget)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, size - len + got); if (!n) break; got += n }
    let text = buf.subarray(0, got).toString('utf8')
    const cut = size > len
    if (cut) text = text.slice(text.indexOf('\n') + 1) // the first line of a tail may be cut
    const end = text.lastIndexOf('\n') // after it: a line being written right now, read next time
    return { lines: end < 0 ? [] : text.slice(0, end).split('\n'), bytes: got, cut }
  } finally { fs.closeSync(fd) }
}

/** readFlows({dir}) → {records (oldest first), files, errors: [{file, error}], truncated, unparsable, missing} */
export function readFlows({ dir, now = Date.now(), windowMs = WINDOW_MS, maxBytes = MAX_BYTES, fs = nodeFs } = {}) {
  const d = path.join(dir, 'flows')
  const out = { records: [], files: [], errors: [], truncated: false, unparsable: 0, missing: false }
  let names
  try { names = fs.readdirSync(d) } catch (e) {
    if (e.code === 'ENOENT') { out.missing = true; return out }
    throw new HealthUnreadable(`${d}: ${errText(e)}`)
  }
  const days = new Map() // date → file
  for (const n of names) { const m = DAY.exec(n); if (m) days.set(m[1], path.join(d, n)) }
  const cutoff = now - windowMs
  let budget = maxBytes
  let sawStart = false
  const perFile = [] // newest first; reversed at the end
  const order = [...days.keys()].sort().reverse()
  for (let k = 0; k < order.length; k++) {
    for (const file of [days.get(order[k])]) {
      if (budget <= 0) { out.truncated = true; break } // a file of this day left unread
      let r
      try { r = readDayFile(file, budget, fs) } catch (e) { out.errors.push({ file, error: errText(e) }); continue }
      budget -= r.bytes
      if (r.cut) out.truncated = true
      out.files.push(file)
      const recs = []
      for (const line of r.lines) {
        if (!line) continue
        let rec
        try { rec = JSON.parse(line) } catch { out.unparsable++; continue }
        if (!rec || typeof rec !== 'object') { out.unparsable++; continue }
        if (rec.event === 'daemon-start') sawStart = true
        recs.push(rec)
      }
      perFile.push(recs)
    }
    // an older day holds only lines older than its next midnight: once that is outside the window and the last
    // daemon-start has been seen, nothing older is needed
    const older = order[k + 1]
    if (!older || (sawStart && Date.parse(`${older}T00:00:00Z`) + 86400e3 <= cutoff)) break
    if (budget <= 0) { out.truncated = true; break } // older days that were needed are left unread
  }
  out.records = perFile.reverse().flat()
  return out
}

/** One UTC day's flows/ lines (oldest first), for notes older than the window. */
export function readDay({ dir, date, fs = nodeFs, maxBytes = 1 << 20 } = {}) {
  const d = path.join(dir, 'flows')
  const out = { records: [], errors: [] }
  let names
  try { names = fs.readdirSync(d) } catch (e) { if (e.code !== 'ENOENT') out.errors.push({ file: d, error: errText(e) }); return out }
  for (const f of names.filter((n) => { const m = DAY.exec(n); return m && m[1] === date }).map((n) => path.join(d, n))) {
    try { for (const l of readDayFile(f, maxBytes, fs).lines) { try { out.records.push(JSON.parse(l)) } catch { /* counted by readFlows when in its window */ } } } catch (e) { out.errors.push({ file: f, error: errText(e) }) }
  }
  return out
}

// ── the metadata whitelist ─────────────────────────────────────────────────────────────────────────────────────
const KEEP = ['ts', 'event', 'where', 'code', 'reason', 'suppressed', 'folded', 'pid', 'agent', 'host', 'dst', 'peer',
  'flow_id', 'seq', 'd', 'i', 'pattern', 'candidates', 'cause', 'via', 'hint', 'which', 'file', 'harness', 'path', 'kind',
  'type', 'index', 'desired', 'actual', 'links', 'counts', 'from', 'to', 'lost', 'exit', 'stderr', 'signal', 'failed',
  'version', 'foreground', 'linger', 'upstream_ca', 'dropped', 'neg_key', 'errno', 'route', 'phase', 'decision', 'inner',
  'not_captured', 'write_failed', 'transport', 'port', 'out', 'servername', 'op', 'outcome', 'records', 'originalKept', 'reader', 'target', 'source', 'id', 'run',
  'level', 'door', 'process', 'alert', 'trust_entry', 'method', 'owner_unread', 'retry_at'] // level..trust_entry: trust-rejected (D51④); method, owner_unread: ingress-unknown (4.8 §5.1)
const CLIP = 1000
const clip = (v) => (typeof v === 'string' && v.length > CLIP ? `${v.slice(0, CLIP)}… (${v.length} chars)` : v)
/** A record cut down to metadata: listed fields only, long strings clipped and said so, `error` as {type, message, side}. */
export function pick(rec) {
  const o = {}
  for (const k of KEEP) {
    const v = rec[k]
    if (v === undefined) continue
    if (v === null || typeof v === 'number' || typeof v === 'boolean') o[k] = v
    else if (typeof v === 'string') o[k] = clip(v)
    else if (Array.isArray(v)) o[k] = v.slice(0, 40).map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x).slice(0, 200) : clip(String(x))))
    else if (k === 'counts' && typeof v === 'object') o[k] = Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number'))
    else if (k === 'trust_entry' && typeof v === 'object') o[k] = Object.fromEntries(['var', 'via', 'file'].map((x) => [x, typeof v[x] === 'string' ? clip(v[x]) : null]))
    else if (k === 'proc' || typeof v === 'object') continue
  }
  if (rec.error != null) o.error = typeof rec.error === 'object' ? { type: clip(String(rec.error.type ?? '')), message: clip(String(rec.error.message ?? '')), ...(rec.error.side ? { side: String(rec.error.side) } : {}) } : clip(String(rec.error))
  if (rec.ws && typeof rec.ws === 'object' && typeof rec.ws.failures === 'number') o.ws_failures = rec.ws.failures // a count, never ws.tail_raw
  if (o.agent == null && rec.proc && typeof rec.proc === 'object' && typeof rec.proc.agent === 'string') o.agent = rec.proc.agent
  return o
}

// ── folding ───────────────────────────────────────────────────────────────────────────────────────────────────
const isRow = (r) => r.event == null
/** The group a failure belongs to: where + code for a failure event, the event (and resolver reason) otherwise,
 *  not_captured for a connection row. */
export function groupKey(r) {
  if (isRow(r)) return `flow:${r.not_captured || r.reason}`
  if (r.event === 'failure') return `${r.where}/${r.code}`
  return r.event === 'agent-untrusted' ? `agent-untrusted:${r.code ?? r.reason}` : `${r.event}${r.where ? `/${r.where}` : ''}`
}
/** The lines of the newest install (or uninstall) run, oldest first: every line one run writes carries its `run` and
 *  the run ends with a `kind:'result'` line (4.6 安装 / 卸载不静默, D1-5). Lines without `run`: those within a minute
 *  of the newest. */
export function lastRun(notes) {
  if (!notes.length) return []
  const last = notes[notes.length - 1]
  if (last.run != null) return notes.filter((n) => n.run === last.run)
  const lastT = Date.parse(last.ts)
  return notes.filter((n) => n.run == null && Date.parse(n.ts) >= lastT - 60e3)
}
// a folded line (events.mjs: written when the 10 s window closes) re-states the last suppressed record and stands for
// exactly `suppressed` occurrences — the first one of the window was its own line already
const PRELUDE_MS = 60_000 // a daemon's start-up lines are written within this before its daemon-start
const weight = (r) => (r.folded ? 0 : 1) + (typeof r.suppressed === 'number' ? r.suppressed : 0)

/**
 * foldFlows(records, {now}) →
 *   last_start / last_stop   the last daemon-start, and the daemon-stop after it (or null)
 *   conditions               what still holds since the last daemon-start (with no daemon-start read: over all records
 *                            read, `partial:true`) — untrusted agents, negative-cache pairs, a dead helper, a wrong
 *                            helper protocol, desired ≠ actual, an unusable CA, an unreadable retention.json, a broken agents.json; each {kind, failure:true, since, …}
 *   unknown_procs            process-unknown since the last daemon-start, one per (harness, name), the newest pid: {harness, name, wide, named, pid, door, since}
 *                            — expected (the process is only forwarded), so not a condition; a daemon restart clears them (D51⑥)
 *   groups                   failures of the last 24 h by groupKey: {key, count, first_ts, last_ts, last}
 *   expected_groups          expected not_captured codes of the last 24 h: {code: {count, first_ts, last_ts}} (`expected` is its counts)
 *   expected                 {not_captured: count} of the last 24 h
 *   agents                   [{agent, last_captured, last_failure, last_failure_key}]
 *   last_ts                  the newest line of any kind ("last record at")
 *   install                  the install-note / uninstall-note lines of the newest run per kind (lastRun)
 */
export function foldFlows(records, { now = Date.now(), windowMs = WINDOW_MS } = {}) {
  let startIdx = -1
  for (let i = records.length - 1; i >= 0; i--) if (records[i].event === 'daemon-start') { startIdx = i; break }
  const out = { last_start: startIdx >= 0 ? pick(records[startIdx]) : null, last_stop: null, conditions: [], unknown_procs: [], partial: startIdx < 0 && records.length > 0, groups: [], expected: {}, expected_groups: {}, agents: [], last_ts: null, install: { install: [], uninstall: [] } }
  // conditions: only what this run wrote — from the last daemon-start, plus the start-up lines written before it (the
  // CA check, the helper's protocol): back to the last daemon-stop, the previous daemon-start, a refused start, or this
  // start's own unclean-stop, and no further than 60 s before daemon-start (4.6 §事件与码)
  let from = Math.max(0, startIdx)
  const startMs = startIdx >= 0 ? Date.parse(records[startIdx].ts) : NaN
  for (let i = startIdx - 1; startIdx > 0 && i >= 0; i--) {
    const r = records[i]
    if (r.event === 'daemon-stop' || r.event === 'daemon-start' || (r.event === 'failure' && r.where === 'start')) break
    if (!(startMs - Date.parse(r.ts) <= PRELUDE_MS)) break // also: a line without a readable ts is not taken
    from = i
    if (r.event === 'failure' && r.code === 'unclean-stop') break
  }
  const untrusted = new Map(), neg = new Map(), rejected = new Map() // rejected: trust-rejected per (pid, host), cleared as the negative cache is (D51④)
  // a negative-cache pair is (neg_key ?? pid, host): "<pid>", or "<route>.<group>" for a connection with no pid (4.8 §5.5, W17), so two forms with
  // no pid are listed apart, and a clearing removes only its own key
  const clearNeg = (who) => { for (const m of [neg, rejected]) for (const k of [...m.keys()]) if (k.slice(0, k.indexOf('\u0000')) === who) m.delete(k) }
  // `retention` holds the class table's condition (D60③) and the retired retention.json's, named by its `where`
  let degraded = null, version = null, mismatch = null, ca = null, retention = null, agentList = null
  // D51⑥: a process on no name list used a door — a fact of this daemon life per (harness, name), the newest pid kept; expected, so not a condition (no ⚠)
  const unknownProcs = new Map()
  for (let i = from; i < records.length; i++) {
    const r = records[i]
    if (r.event === 'daemon-stop') out.last_stop = pick(r)
    else if (r.event === 'agent-untrusted') untrusted.set(r.pid, { kind: 'untrusted', ...pick(r), since: r.ts })
    else if (r.event === 'agent-trusted') untrusted.delete(r.pid)
    else if (r.event === 'agent-exit') { untrusted.delete(r.pid); clearNeg(String(r.pid)) }
    else if (r.event === 'negative-cache-cleared') clearNeg(String(r.neg_key ?? r.pid))
    else if (r.event === 'helper-down') degraded = { kind: 'degraded', ...pick(r), since: r.ts }
    else if (r.event === 'helper-version-mismatch') version = { kind: 'helper-version', ...pick(r), since: r.ts }
    else if (r.event === 'switch') mismatch = r.actual && r.actual !== 'unknown' && r.desired !== r.actual ? { kind: 'state-mismatch', ...pick(r), since: r.ts } : null
    else if (r.event === 'failure' && r.code === 'state-mismatch') mismatch = { kind: 'state-mismatch', ...pick(r), since: r.ts }
    // an entry ends at its retry time (4.6 W22): a record past it is no condition; one without retry_at stands until cleared
    else if (r.event === 'failure' && r.code === 'negative-cache') {
      const k = `${r.neg_key ?? r.pid}\u0000${r.host}`
      if (r.retry_at != null && Date.parse(r.retry_at) <= now) neg.delete(k)
      else neg.set(k, { kind: 'negative-cache', ...pick(r), since: r.ts })
    }
    else if (r.event === 'failure' && r.code === 'trust-rejected') rejected.set(`${r.neg_key ?? r.pid}\u0000${r.host}`, { kind: 'trust-rejected', ...pick(r), since: r.ts })
    else if (r.event === 'failure' && r.code === 'ca-invalid') ca = { kind: 'ca-invalid', ...pick(r), since: r.ts }
    else if (r.event === 'ca-ok') ca = null // the daemon found the CA usable again and rebuilt what it signs with (D1-2)
    // D60③: ~/.trocar/classes.json cannot be read or parsed (or holds an entry that is not a class): the builtin class
    // table applies meanwhile, and that is a condition until classes-ok. A rule that does not compile (`pattern-invalid`),
    // or a classifier that threw, is a failure of its own (the groups below), not this condition: classes-ok does not say
    // they are fixed. (A change-log line that could not be written, `classes-log-failed`, is likewise its own failure:
    // the table itself is fine.) The retired retention.json's own condition read the same way: old flows/ still show it.
    else if (r.event === 'failure' && (r.where === 'classes' || r.where === 'retention') && !['pattern-invalid', 'classify-failed', 'retention-log-failed', 'classes-log-failed'].includes(r.code)) retention = { kind: r.where, ...pick(r), since: r.ts }
    else if (r.event === 'classes-ok' || r.event === 'retention-ok') retention = null
    // D51③: ~/.trocar/agents.json cannot be read or parsed, or holds bad items (the good ones and the presets apply meanwhile): a condition until agent-list-ok
    else if (r.event === 'failure' && r.code === 'agent-list-invalid') agentList = { kind: 'agent-list', ...pick(r), since: r.ts }
    else if (r.event === 'agent-list-ok') agentList = null
    else if (r.event === 'process-unknown' && typeof r.harness === 'string' && (typeof r.name === 'string' || r.name === null)) unknownProcs.set(`${r.harness}\u0000${r.name}`, { harness: r.harness, name: r.name, wide: r.wide === true, named: r.named === true, pid: Number.isInteger(r.pid) ? r.pid : null, door: typeof r.door === 'string' ? r.door : null, since: r.ts })
  }
  out.unknown_procs = [...unknownProcs.values()]
  out.conditions = [...[ca, degraded, version, mismatch, retention, agentList].filter(Boolean), ...untrusted.values(), ...neg.values()].map((c) => ({ ...c, failure: true }))
  // critical first (D51④, 4.6 §事件与码): status and the board's `status` query show them at the top; the rest keep their order
  out.conditions = [...rejected.values()].map((c) => ({ ...c, level: 'critical', failure: true })).concat(out.conditions)
  const rank = (c) => (LEVELS.includes(c.level) ? LEVELS.indexOf(c.level) : LEVELS.length)
  out.conditions.sort((a, b) => rank(a) - rank(b))
  // the last 24 h: failure groups, expected counts, per agent
  const cutoff = now - windowMs
  const groups = new Map(), agents = new Map()
  const agentRow = (a) => { if (!agents.has(a)) agents.set(a, { agent: a, last_captured: null, last_failure: null, last_failure_key: null }); return agents.get(a) }
  for (const r of records) {
    if (typeof r.ts === 'string') out.last_ts = r.ts
    if (r.event === 'install-note' || r.event === 'uninstall-note') out.install[r.event === 'install-note' ? 'install' : 'uninstall'].push(pick(r))
    const t = Date.parse(r.ts)
    if (!(t >= cutoff)) continue
    const agent = r.agent || r.harness || (r.proc && r.proc.agent) || null
    if (isFailure(r)) {
      const key = groupKey(r)
      const g = groups.get(key) || { key, count: 0, first_ts: r.ts, last_ts: r.ts, last: null }
      g.count += weight(r); g.last_ts = r.ts; g.last = pick(r)
      groups.delete(key); groups.set(key, g) // the Map's order is the order of each group's newest record
      if (agent) { const a = agentRow(agent); a.last_failure = r.ts; a.last_failure_key = key }
    } else if (isRow(r)) {
      if (notCapturedClass(r.not_captured, r.reason) === 'expected') {
        const k = expectedKey(r) // a by-design reason counts under its own name ('not-an-agent'), not under 'untracked'
        out.expected[k] = (out.expected[k] || 0) + 1
        const e = out.expected_groups[k] || (out.expected_groups[k] = { count: 0, first_ts: r.ts, last_ts: r.ts })
        e.count += 1; e.last_ts = r.ts
      }
      else if (r.decision === 'decrypt' && r.not_captured == null && agent) agentRow(agent).last_captured = r.ts
    }
  }
  out.groups = [...groups.values()].reverse() // newest record first: one ts can hold several lines, the log's order breaks the tie (C.3)
  out.agents = [...agents.values()]
  // one batch per kind: the newest run's lines
  for (const k of ['install', 'uninstall']) out.install[k] = lastRun(out.install[k])
  return out
}
