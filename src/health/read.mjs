// read.mjs — capture health read from disk (D38; RFC 4.6 §控制面 `lock`, §记录「看得到」). Whether the collector daemon
// runs is judged from ~/.trocar/collector/lock alone — `trocar collector status`, uninstall and (stage D2) the board
// never ask the daemon's socket for it, so a dead or stuck daemon is still reported.
//   lock = {pid, start_time, boot_id, helper_pid, engine_port, socket}: start_time is /proc/<pid>/stat field 22
// (clock ticks since boot), boot_id /proc/sys/kernel/random/boot_id; the daemon refreshes the file's mtime every
// 1 s. A pid is reused and a lock survives a reboot, so "running" needs all three to match and a fresh mtime.
//   captureHealth() is what GET /api/capture-health answers and `trocar collector status` prints when no daemon
// answers (RFC 4.4, 4.6 §记录「看得到」): from disk only — flows/ (src/health/flows.mjs), the lock, the install manifest,
// state.json and the raw journal — never through the daemon's socket.
// Node built-ins, src/paths.mjs, src/raw/ and src/off/proc.mjs (a process's identity and liveness: the one reader `off` uses too) only (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { trocarHome } from '../paths.mjs'
import { procIdentity, pidAlive } from '../off/proc.mjs'
import { readFlows, readDay, foldFlows, pick, groupKey, lastRun, WINDOW_MS, HealthUnreadable } from './flows.mjs'

// Has `install` finished? The same reading as src/off/manifest.mjs installComplete (D55: `install.state`, which replaced v2's `complete`); src/health imports no manifest code (0.1 §2)
const installComplete = (m) => !!(m && m.install && m.install.state === 'complete')

export { HealthUnreadable, procIdentity }

export const LOCK_FRESH_MS = 5000

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
export const RANK = { unreadable: 8, 'not-running': 7, 'not-responding': 7, failing: 6, unknown: 5, off: 4, ok: 3, residue: 2, 'not-installed': 1 }
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
    install: fold.install.install.length ? fold.install.install : at(installComplete(m) ? (m.install.at || m.created_at) : null, 'install-note'),
    uninstall: fold.install.uninstall.length ? fold.install.uninstall : at(m && m.uninstalled_at, 'uninstall-note'),
  }
}

// The switch as state.json says it (RFC 1.6 §1.5, src/off/state.mjs): version 2 is per harness — `desired` is 'on' when every harness is on,
// 'off' when none is, 'mixed' otherwise (no harness recorded: off); `since` is the newest per-harness `updated_at` ("capture off since T").
// Version 1 (before D39, or a file with no version) is one `desired` for everything. A version this build does not know is an error, never "off".
// Read here and not through src/off/state.mjs: src/health depends on node built-ins, src/paths.mjs and src/raw/ only (0.1 §2).
function switchOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'is not a JSON object' }
  if (v.version === 2) {
    const hs = Object.entries(v.harnesses && typeof v.harnesses === 'object' ? v.harnesses : {}).map(([id, h]) => [id, { desired: h && h.desired === 'on' ? 'on' : 'off', updated_at: h && typeof h.updated_at === 'string' ? h.updated_at : null }])
    const on = hs.filter(([, h]) => h.desired === 'on').length
    return { desired: hs.length && on === hs.length ? 'on' : on ? 'mixed' : 'off', since: latest(...hs.map(([, h]) => h.updated_at)) || (typeof v.updated_at === 'string' ? v.updated_at : null), harnesses: Object.fromEntries(hs) }
  }
  if (v.version !== undefined && v.version !== 1) return { error: `is version ${JSON.stringify(v.version)}; this build reads versions 1 and 2` }
  return { desired: v.desired === 'on' ? 'on' : 'off', since: v.updated_at || null }
}

function collectorHealth({ dir, now, fs, alive, identity, maxBytes, read }) {
  try { fs.statSync(dir) } catch (e) {
    if (e.code === 'ENOENT') return { present: false, installed: false, residue: [], summary: { state: 'not-installed' } }
    throw new HealthUnreadable(`${dir}: ${errText(e)}`)
  }
  const man = readJson(path.join(dir, 'install-manifest.json'), fs)
  if (man.error) read.errors.push({ file: path.join(dir, 'install-manifest.json'), error: man.error })
  const m = man.value && typeof man.value === 'object' ? man.value : null
  const installed = man.error ? null : installComplete(m)
  // what an uninstall could not undo (D-18), or what a crashed install left
  const residue = !m || installComplete(m) ? [] : Array.isArray(m.uninstall_left) && m.uninstall_left.length
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
  const stateFile = path.join(dir, 'state.json')
  const st = readJson(stateFile, fs)
  const sw0 = st.value ? switchOf(st.value) : st.missing ? { desired: 'off', since: null, harnesses: {} } : { error: st.error }
  const swError = sw0.error ? (st.error || `${stateFile} ${sw0.error}`) : null
  if (swError) read.errors.push({ file: stateFile, error: swError })
  const sw = swError ? { desired: null, since: null, error: swError } : sw0
  const c = {
    present: true, installed, residue, ...(man.error ? { manifest_error: man.error } : {}), daemon, switch: sw,
    // partial: no daemon-start in what was read AND the read stopped at its limit — the start may be beyond it; a
    // flows/ read whole with no daemon-start is a daemon that never started, its conditions complete
    conditions: fold.conditions, ...(fold.partial && flows.truncated ? { conditions_partial: true } : {}),
    ...(daemon.state !== 'running' && fold.conditions.length ? { conditions_as_of: fold.last_ts } : {}),
    unknown_procs: fold.unknown_procs, // process-unknown of this daemon life (D51⑥): expected, not a condition
    failures: fold.groups, expected: fold.expected, expected_groups: fold.expected_groups, agents: fold.agents, install: notesOf(dir, fold, m, fs, read),
  }
  c.summary = collectorSummary(c)
  return c
}
// A manifest that cannot be read (installed null) is "unknown" — but never hides what is worse (1.5 order: ✗ and ⚠
// rank above ? unknown): the daemon and the failures are judged all the same, and the worse wins.
function collectorSummary(c) {
  if (c.installed === false) return c.residue.length ? { state: 'residue', n: c.residue.length } : { state: 'not-installed' }
  const s = judgedSummary(c)
  return c.installed === null && RANK[s.state] < RANK.unknown ? { state: 'unknown', reason: c.manifest_error } : s
}
function judgedSummary(c) {
  const d = c.daemon, n = c.conditions.length + c.failures.length
  if (d.state === 'not-running') return { state: 'not-running', since: d.last_record_at, n, ...(d.unclean ? { reason: d.why } : d.last_stop ? { signal: d.last_stop.signal ?? null, reason: d.last_stop.reason ?? null } : {}) }
  if (d.state === 'not-responding') return { state: 'not-responding', since: d.lock_refreshed_at, n }
  if (n) return { state: 'failing', n }
  if (d.state === 'unknown') return { state: 'unknown', reason: d.error }
  // the last daemon-start is not in what was read: the conditions are only what that part says — never ✓ or ○
  if (c.conditions_partial) return { state: 'unknown', partial: true, reason: 'the current conditions could not be read whole (the last daemon-start is older than the part of flows/ read)' }
  if (c.switch.desired === 'off') return { state: 'off', since: c.switch.since || (d.last_start && d.last_start.ts) || null }
  return { state: 'ok', since: latest(d.last_start && d.last_start.ts, c.switch.since) }
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

// trocar's own netenv.json: the adopted records and the topology `on` and `status` last wrote (RFC 1.6 §6, D49 「看板」): ~/.trocar/netenv.json, written by src/netenv/index.mjs (not imported here: 0.1 §2).
// A missing file is "not written yet" with the reason; one that cannot be read or parsed carries the file and the error. Neither is an absent key or an empty list, and neither goes into
// `read.errors`: the file is a cache the next `trocar status` writes again, and a broken one must not turn the bar to 读不全 (it is not capture health).
function netenvOf({ home, fs }) {
  const file = path.join(home, 'netenv.json')
  const r = readJson(file, fs)
  if (r.missing) return { present: false, reason: `${file} is not there yet: trocar status, doctor and on write it` }
  if (r.error) return { present: true, error: r.error }
  if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return { present: true, error: `${file} is not a JSON object` }
  return { present: true, ...r.value }
}

/**
 * captureHealth({home}) → the /api/capture-health payload (RFC 4.4): `installed`,
 * `summary` (the verdict over the collector and the raw layer: C.3's `health`), `collector`, `raw`,
 * `netenv` (trocar's own netenv.json: the adopted records and the topology, 1.6 §6), `read` (files read, files that could not be, truncated). Throws HealthUnreadable when flows/ (or the collector
 * directory) cannot be read at all — never an empty answer.
 */
export function captureHealth({ home = trocarHome(), now = Date.now(), fs = nodeFs, alive = pidAlive, identity = procIdentity, maxBytes } = {}) {
  const read = { files: [], errors: [], truncated: false, unparsable: 0, window_hours: WINDOW_MS / 3600e3 }
  const collector = collectorHealth({ dir: path.join(home, 'collector'), now, fs, alive, identity, maxBytes, read })
  const raw = rawHealth({ home, now, fs, read })
  let summary = collector.summary
  // the raw layer's failures count whatever else is installed
  if (raw.failures.length && RANK[summary.state] <= RANK.failing) summary = { state: 'failing', n: (summary.state === 'failing' ? summary.n : 0) + raw.failures.length }
  read.errors = [...new Map(read.errors.map((e) => [e.file, e])).values()] // one entry per file
  if (read.errors.length) summary = { ...summary, read_errors: read.errors.length }
  // installed: null when the collector's manifest cannot be read — false only means not installed (4.4)
  const installed = collector.installed
  return { generated_at: new Date(now).toISOString(), installed, summary, collector, raw, netenv: netenvOf({ home, fs }), read }
}
