// retention.mjs — what to keep of each call, per harness × traffic class (RFC 4.6 §记录「保存级别」, 4.1 D40).
// Two levels only: `full` (the body verbatim, the cap and its labels as before) and `log` (one line per call: metadata
// and headers, the body's byte count, no body). Default: every cell `full`. The setting lives in ~/.asight/retention.json
// (0600, apart from the collector's state.json) and BOTH capture paths read it — the old MITM / reverse proxy and the
// collector's engine — through createRetention(), so they cannot disagree.
//
//   {"version":1,"levels":{"<harness>":{"<class>":"full"|"log"}},"updated_at":"…"}     (only cells that were set)
//
// Rules this file keeps:
//   - a call's level is sampled when its request STARTS (a WebSocket call: at its first frame); an edit reaches the calls
//     that start after it, within recheckMs (1 s), never the ones already open, never what is stored (invariant 2);
//   - the file is re-checked by (inode, size, mtime) at most once per recheckMs — no watcher, no restart;
//   - a file that cannot be read or parsed means EVERYTHING is `full` (keeping too much loses nothing; keeping too
//     little does), and that is a failure event (the top bar goes ⚠); `retention-ok` says it is readable again;
//   - ONE write path: setRetention() (the CLI and the board both call it) — atomic, 0600, and one change-log line per
//     cell, ~/.asight/logs/retention.ndjson {ts, event:'retention-set', harness, class, from, to, source}.
// It knows no harness and holds no host pattern (D20, 0.1 §5): the classifier is injected by the wiring (bin / daemon),
// which reads the table in src/dissect/harnesses.mjs. Leaf-ish: node built-ins, src/paths.mjs, ./envelope.mjs.
import nodeFs from 'node:fs'
import path from 'node:path'
import { retentionFile, retentionLog } from '../paths.mjs'
import { TRAFFIC_CLASSES, RETENTION_LEVELS, MAX_BODY_BYTES, endpointClass } from './envelope.mjs'

export { TRAFFIC_CLASSES, RETENTION_LEVELS, retentionFile, retentionLog }
export const RETENTION_VERSION = 1

const isLevel = (v) => RETENTION_LEVELS.includes(v)
const errText = (e) => String((e && e.message) || e)

/**
 * readRetentionFile(file, {fs}) → {levels, problems, missing, sig}
 *   levels   {harness: {class: 'full'|'log'}} — only cells that hold a valid level; the rest read as `full`
 *   problems [{code, reason, cell?}] — why something in the file cannot be honoured (unreadable, unparsable, a cell that
 *            is neither full nor log); an unreadable or unparsable file has `levels: {}`: everything is `full`
 *   missing  no file at all (the default: not a problem)
 *   sig      the (inode, size, mtime) the next check compares against, or null
 */
export function readRetentionFile(file, { fs = nodeFs } = {}) {
  let st
  try { st = fs.statSync(file) } catch (e) {
    if (e && e.code === 'ENOENT') return { levels: {}, problems: [], missing: true, sig: null }
    return { levels: {}, problems: [{ code: (e && e.code) || 'retention-unreadable', reason: `${file} cannot be read (${errText(e)}); every call is kept in full until it can` }], missing: false, sig: null }
  }
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`
  let doc
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    const code = e && e.code ? e.code : 'retention-unparsable'
    return { levels: {}, problems: [{ code, reason: `${file} cannot be ${code === 'retention-unparsable' ? 'parsed' : 'read'} (${errText(e)}); every call is kept in full until it can` }], missing: false, sig }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc.levels != null && (typeof doc.levels !== 'object' || Array.isArray(doc.levels)))) {
    return { levels: {}, problems: [{ code: 'retention-unparsable', reason: `${file} is not a retention settings document ({"version":1,"levels":{…}}); every call is kept in full until it is` }], missing: false, sig }
  }
  const levels = {}, problems = []
  for (const [h, row] of Object.entries(doc.levels || {})) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { problems.push({ code: 'retention-unparsable', cell: h, reason: `${file}: the entry for ${JSON.stringify(h)} is not an object; its calls are kept in full` }); continue }
    for (const [c, v] of Object.entries(row)) {
      if (isLevel(v)) (levels[h] ||= {})[c] = v
      else problems.push({ code: 'retention-unparsable', cell: `${h} · ${c}`, reason: `${file}: ${JSON.stringify(h)} · ${JSON.stringify(c)} is ${JSON.stringify(v)}, neither "full" nor "log"; that cell is kept in full` })
    }
  }
  return { levels, problems, missing: false, sig }
}

/**
 * createRetention({file, classify, onFailure, onOk, now, recheckMs, fs}) → {decide, current, refresh}
 *   classify({harness, host, method, endpoint}) → a traffic class; injected (see the header). Without one a call is told
 *            by its endpoint alone: llm, token-count, else other.
 *   onFailure(rec) takes {event:'failure', where:'retention', code, reason} — once per distinct problem, not per call
 *   onOk(rec)      takes {event:'retention-ok', where:'retention', reason} when the file reads cleanly again
 *   decide({harness, host, method, endpoint}) → {harness, class, level}; the level is the cell's, `full` when unset
 */
export function createRetention({ file = retentionFile(), classify = null, onFailure = () => {}, onOk = () => {}, now = Date.now, recheckMs = 1000, fs = nodeFs } = {}) {
  let levels = {}, sig, problemsKey = null, checkedAt = -Infinity, lastProblems = [], loaded = false
  const emit = (fn, rec) => { try { fn({ where: 'retention', ...rec }) } catch { /* a recorder that throws must not stop a call from being captured */ } }

  function refresh(force = false) {
    const t = now()
    if (!force && loaded && t - checkedAt < recheckMs) return
    checkedAt = t
    // unchanged file: nothing to re-read. A read that failed has sig null, so it is retried every recheckMs.
    let cur = null
    if (loaded && sig != null) { try { const st = fs.statSync(file); cur = `${st.ino}:${st.size}:${st.mtimeMs}` } catch { cur = null } if (cur === sig) return }
    const r = readRetentionFile(file, { fs })
    loaded = true
    levels = r.levels; sig = r.sig; lastProblems = r.problems
    const key = r.problems.map((p) => `${p.code}\u0000${p.cell || ''}\u0000${p.reason}`).join('\u0001') || null
    if (key === problemsKey) return
    if (key == null) emit(onOk, { event: 'retention-ok', reason: `${file} reads cleanly again; the levels in it apply from the next call` })
    else for (const p of r.problems) emit(onFailure, { event: 'failure', code: p.code, reason: p.reason, ...(p.cell ? { cell: p.cell } : {}) })
    problemsKey = key
  }

  function decide({ harness = 'unknown', host = null, method = null, endpoint = '' } = {}) {
    refresh()
    let cls
    try { cls = classify ? classify({ harness, host, method, endpoint }) : (endpointClass(endpoint) || 'other') } catch (e) {
      cls = endpointClass(endpoint) || 'other' // the classifier is asight's own code: keep the call, and say so
      emit(onFailure, { event: 'failure', code: 'classify-failed', reason: `classifying ${host || '?'} ${String(endpoint).split('?')[0]} failed (${errText(e)}); it is kept as ${cls}` })
    }
    if (!TRAFFIC_CLASSES.includes(cls)) cls = 'other'
    const lv = levels[harness] && levels[harness][cls]
    return { harness, class: cls, level: isLevel(lv) ? lv : 'full' }
  }

  return {
    decide, refresh,
    /** what is in force now: {levels, problems, file} — the board's and the CLI's view of it */
    current() { refresh(); return { levels, problems: lastProblems, file } },
  }
}

// The old capture paths (reverse proxy, MITM) sample a call's level when its request starts. `retention` is injected by the
// CLI (bin/asight.mjs): ({host, method, endpoint}) → {class, level}. Without one — or when it throws — every call is kept in
// full and told by its endpoint alone: a settings problem must never cost a call its bytes.
export function sampleRetention(retention, q) {
  const fallback = () => ({ class: endpointClass(q.endpoint) || 'other', level: 'full' })
  if (typeof retention !== 'function') return fallback()
  try { const r = retention(q); return { class: TRAFFIC_CLASSES.includes(r && r.class) ? r.class : 'other', level: r && r.level === 'log' ? 'log' : 'full' } } catch { return fallback() }
}
// What the old paths store of a request they hold whole (they buffer it to forward it): at `log` nothing, else the first
// `cap` bytes — with the label and the exact wire length when it is longer.
export function storedRequest(body, level, cap = MAX_BODY_BYTES) {
  const cut = level !== 'log' && body.length > cap
  return { reqBody: level === 'log' ? null : cut ? body.subarray(0, cap) : body, reqWireBytes: body.length, reqTruncated: cut }
}

export class RetentionArgError extends Error {
  constructor(message) { super(message); this.name = 'RetentionArgError'; this.code = 'bad-args' }
}

/**
 * setRetention({file, logFile, harness, class, level, source, harnesses, now, fs}) → {changed, logError}
 * The one write path (the CLI's `asight keep` and the board's POST /control/retention). `harness` and `class` may be
 * 'all' (every name in `harnesses` / every class): one cell each. Names are checked against the closed sets BEFORE
 * anything is written — an unknown one throws RetentionArgError and the file is untouched. A cell already at the
 * wanted level is skipped (the file gains only what changed), and when nothing changes nothing is written. An existing
 * file that cannot be read or parsed is not overwritten (the operator's other cells would be lost): it throws.
 * Writes a temp file then renames it (0600); then one `retention-set` line per changed cell in the change log.
 * `harnesses` is the harness id list the wiring takes from the read-side table (plus 'unknown').
 */
export function setRetention({ file = retentionFile(), logFile = retentionLog(), harness, class: cls, level, source, harnesses = [], now = () => new Date(), fs = nodeFs }) {
  if (!isLevel(level)) throw new RetentionArgError(`unknown level ${JSON.stringify(level)}; use ${RETENTION_LEVELS.join(' or ')}`)
  if (!['cli', 'board'].includes(source)) throw new RetentionArgError(`unknown source ${JSON.stringify(source)}`)
  if (harness !== 'all' && !harnesses.includes(harness)) throw new RetentionArgError(`unknown harness ${JSON.stringify(harness)}; use one of ${harnesses.join(', ')}, or all`)
  if (cls !== 'all' && !TRAFFIC_CLASSES.includes(cls)) throw new RetentionArgError(`unknown class ${JSON.stringify(cls)}; use one of ${TRAFFIC_CLASSES.join(', ')}, or all`)
  const cur = readRetentionFile(file, { fs })
  if (cur.problems.length && cur.sig === null && !cur.missing) throw Object.assign(new Error(`${file} cannot be read (${cur.problems[0].reason}); fix or remove it first, nothing was changed`), { code: cur.problems[0].code })
  if (cur.problems.some((p) => !p.cell)) throw Object.assign(new Error(`${file} cannot be parsed (${cur.problems[0].reason}); fix or remove it first, nothing was changed`), { code: 'retention-unparsable' })
  const hs = harness === 'all' ? harnesses : [harness]
  const cs = cls === 'all' ? TRAFFIC_CLASSES : [cls]
  // start from the raw document so cells this version does not understand survive an edit
  let doc = { version: RETENTION_VERSION, levels: {} }
  if (!cur.missing) { try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* readRetentionFile just parsed it */ } }
  doc.levels = doc.levels && typeof doc.levels === 'object' ? doc.levels : {}
  const changed = []
  for (const h of hs) for (const c of cs) {
    const from = (cur.levels[h] && cur.levels[h][c]) || 'full'
    if (from === level) continue
    ;(doc.levels[h] = doc.levels[h] && typeof doc.levels[h] === 'object' ? doc.levels[h] : {})[c] = level
    changed.push({ harness: h, class: c, from, to: level })
  }
  if (!changed.length) return { changed, logError: null }
  const t = now()
  doc.version = RETENTION_VERSION; doc.updated_at = t.toISOString()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ } throw e }
  let logError = null
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(logFile, 'a', 0o600)
    try { fs.fchmodSync(fd, 0o600) } catch { /* best effort */ }
    try { for (const c of changed) fs.writeSync(fd, JSON.stringify({ ts: t.toISOString(), event: 'retention-set', ...c, source }) + '\n') } finally { fs.closeSync(fd) }
  } catch (e) { logError = errText(e) } // the change is made; its record is not — the caller says so
  return { changed, logError }
}
