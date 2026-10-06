// read.mjs — capture health read from disk (D38; RFC 4.6 §控制面 `lock`, §记录「看得到」). Whether the collector daemon
// runs is judged from ~/.asight/collector/lock alone — `asight collector status`, uninstall and (stage D2) the board
// never ask the daemon's socket for it, so a dead or stuck daemon is still reported.
//   lock = {pid, start_time, boot_id, helper_pid, engine_port, socket}: start_time is /proc/<pid>/stat field 22
// (clock ticks since boot), boot_id /proc/sys/kernel/random/boot_id; the daemon refreshes the file's mtime every
// 1 s. A pid is reused and a lock survives a reboot, so "running" needs all three to match and a fresh mtime.
//   captureHealth() is what GET /api/capture-health answers and `asight collector status` prints when no daemon
// answers (RFC 4.4, 4.6 §记录「看得到」): from disk only — flows/ (src/health/flows.mjs), the lock, the install manifest,
// state.json, the raw journal and the old capture's events file — never through the daemon's socket.
// Node built-ins, src/paths.mjs and src/raw/ only (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { asightHome } from '../paths.mjs'
import { readFlows, readDay, foldFlows, pick, groupKey, lastRun, WINDOW_MS, HealthUnreadable } from './flows.mjs'
import { isFailure } from './codes.mjs'

export { HealthUnreadable }

export const LOCK_FRESH_MS = 5000

/** {start_time, boot_id} of a live process (strings), each null when it cannot be read (no /proc, gone, EACCES). */
export function procIdentity(pid, { root = '/proc', fs = nodeFs } = {}) {
  let start_time = null, boot_id = null
  try {
    const stat = fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/) // field 3 onward: comm may hold ')' or spaces
    if (/^\d+$/.test(f[19] || '')) start_time = f[19]
  } catch { /* gone or no /proc: start_time stays null, and the judge below says so */ }
  try { boot_id = fs.readFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim() || null } catch { /* no /proc */ }
  return { start_time, boot_id }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/**
 * lockState({file}) → {state, …}:
 *   'none'          no lock: the daemon stopped cleanly, or never ran
 *   'unknown'       the lock is unreadable ({error}): whether a daemon runs cannot be said
 *   'stale'         a lock whose daemon is gone ({why}: pid dead, or its start time / boot id is another process's)
 *   'unresponsive'  that daemon's process is there but has not refreshed the lock for over 5 s ({age_ms}): stuck
 *   'running'       pid, start time and boot id match and the lock is fresh ({age_ms})
 * Every state but 'none' carries `lock` when it could be read; `verified:false` when this OS has no /proc to check
 * the start time and boot id against (then only the pid and the freshness were judged).
 */
export function lockState({ file, now = Date.now(), alive = pidAlive, identity = procIdentity, fs = nodeFs } = {}) {
  let text, mtimeMs
  try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs } catch (e) {
    if (e.code === 'ENOENT') return { state: 'none' }
    return { state: 'unknown', error: `${file}: ${String(e.message || e)}` }
  }
  let lock
  try { lock = JSON.parse(text) } catch (e) { return { state: 'unknown', error: `${file} is not valid JSON (${e.message}): cut short by a crash or power loss?` } }
  if (!lock || !Number.isInteger(lock.pid)) return { state: 'unknown', error: `${file} names no pid` }
  const age_ms = Math.max(0, Math.round(now - mtimeMs))
  if (!alive(lock.pid)) return { state: 'stale', lock, why: `pid ${lock.pid} is not running`, age_ms }
  const id = identity(lock.pid)
  const verified = id.start_time != null && id.boot_id != null && lock.start_time != null && lock.boot_id != null // an older lock has neither
  if (verified && String(lock.boot_id) !== id.boot_id) return { state: 'stale', lock, why: 'the machine has rebooted since (boot id differs)', age_ms }
  if (verified && String(lock.start_time) !== id.start_time) return { state: 'stale', lock, why: `pid ${lock.pid} is another process now (start time differs)`, age_ms }
  return { state: age_ms > LOCK_FRESH_MS ? 'unresponsive' : 'running', lock, age_ms, ...(verified ? {} : { verified: false }) }
}

// ── captureHealth ─────────────────────────────────────────────────────────────────────────────────────────────
const errText = (e) => String((e && e.message) || e)
const DAEMON = { none: 'not-running', stale: 'not-running', unresponsive: 'not-responding', running: 'running', unknown: 'unknown' }
// how bad each state is (1.5: `?` unreadable > ✗ > ⚠ > `?` unknown > ○ > ✓ > –); the top bar shows the worst part
export const RANK = { unreadable: 8, 'not-running': 7, 'not-responding': 7, failing: 6, unknown: 5, 'no-events': 5, off: 4, ok: 3, residue: 2, stopped: 2, 'not-installed': 1 }
const latest = (...ts) => ts.filter(Boolean).sort().at(-1) || null

function readJson(file, fs) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { error: `${file}: ${errText(e)}` } }
  try { return { value: JSON.parse(text) } } catch (e) { return { error: `${file} does not parse (${e.message})` } }
}
// the complete lines of a file's last `max` bytes; {missing} / {error}
function tailLines(file, max, fs) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { error: `${file}: ${errText(e)}` } }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    let text = buf.toString('utf8')
    if (size > len) text = text.slice(text.indexOf('\n') + 1)
    const recs = []
    let unparsable = 0
    for (const l of text.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r && typeof r === 'object') recs.push(r); else unparsable++ } catch { unparsable++ } }
    return { recs, truncated: size > len, unparsable }
  } catch (e) { return { error: `${file}: ${errText(e)}` } } finally { fs.closeSync(fd) }
}
const groupsOf = (recs, now, key = groupKey) => {
  const m = new Map()
  for (const r of recs) {
    if (!(Date.parse(r.ts) >= now - WINDOW_MS)) continue
    const k = key(r)
    const g = m.get(k) || { key: k, count: 0, first_ts: r.ts, last_ts: r.ts, last: null }
    g.count += 1 + (typeof r.suppressed === 'number' ? r.suppressed : 0); g.last_ts = r.ts; g.last = pick(r)
    m.set(k, g)
  }
  return [...m.values()]
}

// The notes the last install / uninstall wrote (install-note / uninstall-note): in the window read, else in the day
// files of the date the manifest gives (an install a week ago is still "the last install").
function notesOf(dir, fold, m, fs, read) {
  const at = (iso, event) => {
    if (!iso) return []
    const days = [iso.slice(0, 10), new Date(Date.parse(iso) + 86400e3).toISOString().slice(0, 10)]
    const out = []
    for (const d of days) { const r = readDay({ dir, date: d, fs }); read.errors.push(...r.errors); out.push(...r.records.filter((x) => x.event === event && Date.parse(x.ts) >= Date.parse(iso) - 60e3)) }
    return lastRun(out.map(pick))
  }
  return {
    install: fold.install.install.length ? fold.install.install : at(m && m.complete ? m.created_at : null, 'install-note'),
    uninstall: fold.install.uninstall.length ? fold.install.uninstall : at(m && m.uninstalled_at, 'uninstall-note'),
  }
}

function collectorHealth({ dir, now, fs, alive, identity, maxBytes, read }) {
  try { fs.statSync(dir) } catch (e) {
    if (e.code === 'ENOENT') return { present: false, installed: false, residue: [], summary: { state: 'not-installed' } }
    throw new HealthUnreadable(`${dir}: ${errText(e)}`)
  }
  const man = readJson(path.join(dir, 'install-manifest.json'), fs)
  if (man.error) read.errors.push({ file: path.join(dir, 'install-manifest.json'), error: man.error })
  const m = man.value && typeof man.value === 'object' ? man.value : null
  const installed = man.error ? null : !!(m && m.complete)
  // what an uninstall could not undo (D-18), or what a crashed install left
  const residue = !m || m.complete ? [] : Array.isArray(m.uninstall_left) && m.uninstall_left.length
    ? m.uninstall_left.map((l) => ({ path: l.path, harness: l.harness ?? null, result: l.result }))
    : [...(m.entries || []).map((e) => ({ path: e.path, harness: e.harness ?? null, result: 'install did not finish' })), ...(m.files || []).map((f) => ({ path: f.path, harness: f.harness ?? null, result: 'install did not finish' }))]
  const ls = lockState({ file: path.join(dir, 'lock'), now, alive, identity, fs })
  const daemon = {
    state: DAEMON[ls.state], ...(ls.lock ? { pid: ls.lock.pid } : {}), ...(ls.why ? { why: ls.why } : {}), ...(ls.error ? { error: ls.error } : {}),
    ...(ls.age_ms != null ? { lock_refreshed_at: new Date(now - ls.age_ms).toISOString() } : {}), ...(ls.verified === false ? { verified: false } : {}),
    unclean: ls.state === 'stale',
  }
  let flows
  // an unreadable flows/ throws (the endpoint's 503); what could be read rides along for `collector status`
  try { flows = readFlows({ dir, now, fs, maxBytes }) } catch (e) { e.collector = { present: true, installed, residue, daemon }; throw e }
  read.files.push(...flows.files); read.errors.push(...flows.errors); read.unparsable += flows.unparsable
  if (flows.truncated) read.truncated = true
  const fold = foldFlows(flows.records, { now })
  Object.assign(daemon, { last_record_at: fold.last_ts, last_start: fold.last_start, last_stop: fold.last_stop })
  const st = readJson(path.join(dir, 'state.json'), fs)
  if (st.error) read.errors.push({ file: path.join(dir, 'state.json'), error: st.error })
  const sw = st.value ? { desired: st.value.desired === 'on' ? 'on' : 'off', since: st.value.updated_at || null } : st.missing ? { desired: 'off', since: null } : { desired: null, since: null, error: st.error }
  const c = {
    present: true, installed, residue, ...(man.error ? { manifest_error: man.error } : {}), daemon, switch: sw,
    conditions: fold.conditions, ...(fold.partial ? { conditions_partial: true } : {}),
    ...(daemon.state !== 'running' && fold.conditions.length ? { conditions_as_of: fold.last_ts } : {}),
    failures: fold.groups, expected: fold.expected, agents: fold.agents, install: notesOf(dir, fold, m, fs, read),
  }
  c.summary = collectorSummary(c)
  return c
}
function collectorSummary(c) {
  if (c.installed === null) return { state: 'unknown', reason: c.manifest_error }
  if (!c.installed) return c.residue.length ? { state: 'residue', n: c.residue.length } : { state: 'not-installed' }
  const d = c.daemon, n = c.conditions.length + c.failures.length
  if (d.state === 'not-running') return { state: 'not-running', since: d.last_record_at, n, ...(d.unclean ? { reason: d.why } : d.last_stop ? { signal: d.last_stop.signal ?? null, reason: d.last_stop.reason ?? null } : {}) }
  if (d.state === 'not-responding') return { state: 'not-responding', since: d.lock_refreshed_at, n }
  if (n) return { state: 'failing', n }
  if (d.state === 'unknown') return { state: 'unknown', reason: d.error }
  if (c.switch.desired === 'off') return { state: 'off', since: c.switch.since || (d.last_start && d.last_start.ts) || null }
  return { state: 'ok', since: latest(d.last_start && d.last_start.ts, c.switch.since) }
}

// The old MITM / reverse proxy (RFC 4.1 过渡期, D38): ~/.asight/logs/mitm-events.ndjson. Without it, a capture file
// written within 24 h means an old process started before the events writer existed: said, never "not installed".
// a capture file the old capture wrote within 24 h: {file, mtime} or null
function freshCapture(home, now, fs) {
  for (const f of ['claude-capture.ndjson', 'capture.ndjson']) {
    let s; try { s = fs.statSync(path.join(home, f)) } catch { continue }
    if (now - s.mtimeMs <= WINDOW_MS) return { file: path.join(home, f), mtime: new Date(s.mtimeMs).toISOString() }
  }
  return null
}
function legacyHealth({ home, now, fs, alive, read }) {
  const file = path.join(home, 'logs', 'mitm-events.ndjson')
  const t = tailLines(file, 1 << 20, fs)
  if (t.error) { read.errors.push({ file, error: t.error }); return { present: true, state: 'unknown', error: t.error, summary: { state: 'unknown', reason: t.error } } }
  if (t.missing) {
    const cap = freshCapture(home, now, fs)
    return cap ? { present: true, state: 'no-events', capture: cap, summary: { state: 'no-events', since: cap.mtime } } : { present: false, state: 'none', summary: { state: 'not-installed' } }
  }
  read.files.push(file); read.unparsable += t.unparsable
  if (t.truncated) read.truncated = true
  // per `source` (mitm / proxy; RFC 4.1 落地细节 (3)): the last start and stop of each — running (pid alive), gone (no
  // stop, pid dead: ✗) or stopped cleanly (○, ranked below ✓ so a running collector hides it)
  const by = new Map()
  for (const r of t.recs) {
    if (r.event !== 'mitm-start' && r.event !== 'mitm-stop') continue
    const k = r.source || 'mitm', s = by.get(k) || { source: k, last_start: null, last_stop: null }
    if (r.event === 'mitm-start') { s.last_start = pick(r); s.last_stop = null } else s.last_stop = pick(r)
    by.set(k, s)
  }
  const sources = [...by.values()].map((s) => ({ ...s, state: s.last_start && !s.last_stop ? (s.last_start.pid == null || alive(s.last_start.pid) ? 'running' : 'gone') : 'stopped' }))
  const failures = groupsOf(t.recs.filter(isFailure), now)
  const last = t.recs.length ? t.recs[t.recs.length - 1].ts : null
  // no start / stop line of any source in what was read is never "stopped" by itself (4.1 落地细节 (3)): the last
  // start may be before the tail read (unknown), or the process predates the events writer (judged by the capture file)
  if (!sources.length) {
    const cap = freshCapture(home, now, fs)
    const st = t.truncated ? 'unknown' : cap ? 'no-events' : null
    if (st) {
      const why = t.truncated ? `no mitm-start / mitm-stop in the last ${1 << 20} bytes of ${file}: whether the old capture runs is unknown` : null
      return { present: true, state: st, sources, last_start: null, last_stop: null, last_record_at: last, failures, ...(cap ? { capture: cap } : {}),
        summary: failures.length ? { state: 'failing', n: failures.length } : st === 'unknown' ? { state: 'unknown', reason: why } : { state: 'no-events', since: cap.mtime } }
    }
  }
  const gone = sources.find((s) => s.state === 'gone'), running = sources.find((s) => s.state === 'running')
  const lead = gone || running || sources.at(-1) || {}
  const l = { present: true, state: gone ? 'not-running' : running ? 'running' : 'stopped', sources, last_start: lead.last_start || null, last_stop: lead.last_stop || null, last_record_at: last, failures }
  l.summary = gone ? { state: 'not-running', since: last, source: gone.source, n: failures.length, reason: `pid ${gone.last_start.pid} is gone without a clean stop` }
    : failures.length ? { state: 'failing', n: failures.length }
    : running ? { state: 'ok', since: running.last_start.ts, source: running.source }
    : { state: 'stopped', since: (lead.last_stop && lead.last_stop.ts) || last, ...(lead.last_stop && lead.last_stop.signal ? { signal: lead.last_stop.signal } : {}) }
  return l
}

// The raw layer's journal (4.2 §原始层封存, D35): every outcome that is not plain success.
function rawHealth({ home, now, fs, read }) {
  const file = path.join(home, 'raw', 'journal.jsonl')
  const t = tailLines(file, 1 << 20, fs)
  if (t.missing) return { problems: [], failures: [] }
  if (t.error) { read.errors.push({ file, error: t.error }); return { problems: [], failures: [], error: t.error } }
  read.files.push(file); read.unparsable += t.unparsable
  const bad = t.recs.filter((r) => r.outcome != null && r.outcome !== 'ok')
  return { problems: bad.slice(-20).map(pick), ...(bad.length > 20 || t.truncated ? { truncated: true } : {}), failures: groupsOf(bad, now, (r) => `raw:${r.op}/${r.outcome}`) }
}

/**
 * captureHealth({home}) → the /api/capture-health payload (RFC 4.4): `installed`,
 * `summary` (the top bar's state, the worst of the collector's and the old capture's), `collector`, `legacy`, `raw`,
 * `read` (files read, files that could not be, truncated). Throws HealthUnreadable when flows/ (or the collector
 * directory) cannot be read at all — never an empty answer.
 */
export function captureHealth({ home = asightHome(), now = Date.now(), fs = nodeFs, alive = pidAlive, identity = procIdentity, maxBytes } = {}) {
  const read = { files: [], errors: [], truncated: false, unparsable: 0, window_hours: WINDOW_MS / 3600e3 }
  const collector = collectorHealth({ dir: path.join(home, 'collector'), now, fs, alive, identity, maxBytes, read })
  const legacy = legacyHealth({ home, now, fs, alive, read })
  const raw = rawHealth({ home, now, fs, read })
  const parts = [{ part: 'collector', ...collector.summary }, { part: 'legacy', ...legacy.summary }]
  let summary = parts.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a))
  if (summary.state === 'failing') summary = { ...summary, n: parts.filter((p) => p.state === 'failing').reduce((k, p) => k + p.n, 0) }
  // the raw layer's failures count whatever else is installed (the sealer works on the old pipeline's sessions too)
  if (raw.failures.length && RANK[summary.state] <= RANK.failing) summary = { part: summary.state === 'failing' ? summary.part : 'raw', state: 'failing', n: (summary.state === 'failing' ? summary.n : 0) + raw.failures.length }
  if (summary.state === 'not-installed') summary = { state: 'not-installed' }
  read.errors = [...new Map(read.errors.map((e) => [e.file, e])).values()] // one entry per file
  if (read.errors.length) summary = { ...summary, read_errors: read.errors.length }
  return { generated_at: new Date(now).toISOString(), installed: collector.installed === true || legacy.present, summary, collector, legacy, raw, read }
}
