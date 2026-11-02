// screens/settings/storage-model.mjs — 设置 · 存储 as data (1.11): the 磁盘 card and the 保存什么 card from the C.5 `classes` and
// `segments` documents and `GET /control/status`. Framework-free (D75②): no DOM, no timers; StorageScreen.tsx only renders what this
// returns. One level per class (D60③), editable only when a control can work (1.5 K-25); a failed `segments` read is said, never read as
// zero problems (D38). Fixed words come from labels/settings.mjs; server words only ever sit in technical pairs.
import { fmtStamp, relTime } from '../../../legacy/core/fmt.mjs'
import { CLASS_NAME, CLASS_DESC, FALLBACK_CLASS } from '../../../legacy/core/classes.mjs'
import { COMMANDS } from '../../../legacy/labels/capture.mjs'
import { READ_FAIL } from '../../../legacy/labels/common.mjs'
import * as W from '../../../legacy/labels/settings.mjs'

const list = (x) => (Array.isArray(x) ? x : [])
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// the route's window (1.11-01: unknown → 24 hours) and its counts key in a `classes[]` entry
export const winOf = (params) => { const w = params && params.window; return W.WINDOWS.some((o) => o.value === w) ? w : '24h' }
export const countKey = (w) => ({ '7d': 'd7', all: 'all' })[w] || 'h24'

// diskFigures(classesDoc) — the bytes on disk now, and Σ the last 24 hours' stored bytes (unknown when any class lacks it, never 0)
export function diskFigures(doc) {
  const d = (doc && doc.disk) || {}
  const days = list(doc && doc.classes).map((c) => num(c && c.counts && c.counts.h24 && c.counts.h24.bytes))
  return {
    total: num(d.trocar_bytes),
    perDay: days.length && days.every((b) => b != null) ? days.reduce((s, b) => s + b, 0) : null,
    asOf: (doc && doc.as_of) || null,
  }
}

// classRows(classesDoc, key) — one row per `classes[]` entry, most stored bytes in the window first
export function classRows(doc, key = 'h24') {
  return list(doc && doc.classes).map((c) => {
    const n = (c.counts && c.counts[key]) || {}
    return { id: c.class, name: c.class == null ? W.NO_CLASS : CLASS_NAME[c.class] || c.class, keep: c.keep, builtin: !!c.builtin, inTable: c.in_table !== false && c.class != null, calls: num(n.calls), bytes: num(n.bytes),
      rules: list(c.rules).map((r) => (r.path ? `${r.host} ${r.path}` : String(r.host)) + (r.harness ? ` (${r.harness})` : '')) }
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
}

// a `level:'note'` entry is said but is no problem: the reader built a missing index itself (slow, nothing lost, 4.2 §段索引)
const isNote = (e) => !!e && e.level === 'note'

// problemCount(segmentsDoc) — the `segments[].problems[]` entries that are not notes
export const problemCount = (doc) => list(doc && doc.segments).reduce((s, x) => s + list(x.problems).filter((p) => p && !isNote(p)).length, 0)

// fileProblems(...docs) — every errors[] entry `{where, code, reason, note}`, one per distinct triple (a segment's problem is in
// `segments` and again in `classes`' errors[]: listed once)
export function fileProblems(...docs) {
  const out = new Map()
  for (const e of docs.flatMap((d) => list(d && d.errors))) if (e) out.set(`${e.where}\n${e.code}\n${e.reason}`, { where: String(e.where ?? ''), code: e.code ? String(e.code) : '', reason: String(e.reason ?? ''), note: isNote(e) })
  return [...out.values()]
}
const anyNote = (segments, ...docs) => list(segments && segments.segments).some((x) => list(x.problems).some(isNote)) || fileProblems(segments, ...docs).some((p) => p.note)
const sealRatio = (d) => (num(d.records_bytes) > 0 && num(d.sealed_bytes) > 0 ? d.sealed_bytes / d.records_bytes : null)

// the settings file's own problems (`where: 'classes.json'`); `fatal` marks the one that points at the whole file
const fileErrors = (doc) => list(doc && doc.errors).filter((e) => e && e.where === 'classes.json')
const fileFatal = (doc) => fileErrors(doc).some((e) => e.fatal === true)

// canEdit(control, classesDoc) — the control plane answered and is mounted, and the settings file reads as a whole (1.11 §改级别)
export const canEdit = (control, doc) => !!(control && control.ok && control.data && control.data.control === true) && !fileFatal(doc)

// receiptOf(out, keep) — planConfirm's outcome → the row's receipt {kind, text, tech?, keep}; null for a cancel or a 403 (the K-30
// page takes over, 1.5). Server words go only into `tech`.
const keepOf = (x) => (x && x.keep) || 'full' // no entry = the default level
const keepName = (k) => W.KEEP_NAME[k] || String(k)
export function receiptOf(out, keep) {
  if (!out || out.outcome === 'cancelled' || out.status === 403) return null
  if (out.outcome === 'done') {
    const b = keepOf(out.receipt && out.receipt.before), a = keepOf(out.receipt && out.receipt.after)
    return b === a ? { kind: 'already', text: W.RCPT_ALREADY(keepName(a)), keep } : { kind: 'changed', text: W.RCPT_CHANGED(keepName(b), keepName(a)), keep }
  }
  if (out.outcome === 'refused') {
    const e = out.receipt && out.receipt.error
    return { kind: 'not-changed', text: W.RCPT_NOT_CHANGED, tech: (e && (e.message || e.code)) || String(e || ''), keep }
  }
  if (out.status === 0) return { kind: 'offline', text: W.RCPT_OFFLINE, tech: out.error || '', keep }
  if (out.status === 404 || out.status === 405) return { kind: 'read-only', text: W.RCPT_READ_ONLY, tech: `HTTP ${out.status}`, keep }
  return { kind: 'not-changed', text: W.RCPT_NOT_CHANGED, tech: out.error || `HTTP ${out.status}`, keep }
}

const LEVEL_CMD = { full: COMMANDS.setFull, log: COMMANDS.setLog }
export const other = (k) => (keepOf({ keep: k }) === 'log' ? 'full' : 'log')
export const cmdFor = (cls, keep) => LEVEL_CMD[keep].replace('<class>', cls)

// failOf(what, answer) — a failed read (1.5 K-29) as data: the board's line, and the status / reason pairs for the technical details
export function failOf(what, r) {
  const obj = r != null && typeof r === 'object'
  const status = obj && typeof r.status === 'number' ? r.status : null
  const why = obj ? r.error : r
  return { line: READ_FAIL(what, status), pairs: [...(status != null ? [['status', String(status)]] : []), ['error', why == null || why === '' ? '—' : String(why)]] }
}

// flatText(pairs) — the copy text of technical pairs: `k: v` per line, the bare value on a continuation row
export const flatText = (pairs) => pairs.map(([k, v]) => (k ? `${k}: ${v}` : String(v))).join('\n')

const sum = (rows, k) => (rows.every((r) => r[k] != null) ? rows.reduce((s, r) => s + r[k], 0) : null)

function diskOf(classes, segments, segmentsFail) {
  const fig = diskFigures(classes), all = fileProblems(segments, classes)
  const ratio = sealRatio((classes && classes.disk) || {})
  const files = [[W.FILES_SEAL_RATIO, ratio != null ? `${ratio.toFixed(3)} · ${W.ESTIMATE}` : W.FILES_SEAL_NONE]]
  for (const [title, ps] of [[W.FILES_READ_PROBLEMS, all.filter((p) => !p.note)], [W.FILES_READ_NOTES, all.filter((p) => p.note)]]) {
    if (ps.length) files.push([title, ''], ...ps.map((p) => ['', [p.where, p.code, p.reason].filter(Boolean).join(' · ')]))
  }
  return { ...fig, bad: problemCount(segments), segFail: segmentsFail ? failOf(W.FILES_CHECK, segmentsFail) : null, slow: anyNote(segments, classes), files }
}

function cardOf(classes, window, { control, hl, now }) {
  const rows = classRows(classes, countKey(window)), editable = canEdit(control, classes)
  const root = !!(control && control.ok && control.data && control.data.root)
  const fileErrs = fileErrors(classes), fatal = fileFatal(classes)
  const notes = [{ code: 'later', text: W.NOTE_LATER }]
  if (classes && classes.as_of) notes.push({ code: 'as-of', text: `${W.CLASSES_AS_OF} ${fmtStamp(classes.as_of)}` })
  else if (classes && classes.as_of === null) notes.push({ code: 'no-calls', text: W.NOTE_NO_CALLS })
  if (list(classes && classes.errors).some((e) => e && !isNote(e) && String(e.where || '').startsWith('segments/'))) notes.push({ code: 'partial', text: W.NOTE_PARTIAL })
  if (root) notes.push({ code: 'read-only', text: W.NOTE_READ_ONLY })
  if (fatal) notes.push({ code: 'file-bad', text: W.NOTE_FILE_BAD })
  else if (fileErrs.length) notes.push({ code: 'file-some', text: W.NOTE_FILE_SOME(fileErrs.length) })
  const total = { calls: sum(rows, 'calls'), bytes: sum(rows, 'bytes') }
  const out = rows.map((r) => ({
    id: r.id, key: r.id == null ? '*none*' : r.id, name: r.name, keep: keepOf({ keep: r.keep }), inTable: r.inTable, rules: r.rules,
    fallback: !r.rules.length && r.id === FALLBACK_CLASS, calls: r.calls, bytes: r.bytes,
    share: total.bytes > 0 && r.bytes != null ? Math.round((r.bytes / total.bytes) * 100) : null,
    hl: hl != null && r.id === hl,
    pop: r.id == null ? null : { desc: CLASS_DESC[r.id] || null, stored: r.bytes > 0 ? r.bytes : null, href: `#/traffic?${new URLSearchParams({ class: r.id, window })}` },
    cmd: r.inTable ? cmdFor(r.id, other(r.keep)) : null,
  }))
  const lc = classes && classes.last_change
  const last = lc && lc.ts ? { cls: lc.class ?? null, name: lc.class == null ? W.NO_CLASS : CLASS_NAME[lc.class] || lc.class, keep: (lc.to && lc.to.keep) || null,
    source: lc.source || null, sourceWord: W.SOURCE_WORD[lc.source] || lc.source || '', ts: lc.ts, stamp: fmtStamp(lc.ts), when: relTime(lc.ts, now) } : null
  // segment read problems are listed once, in the 磁盘 card's files; here only the settings file's own; one command row per class
  const tech = [
    ...fileErrs.map((e, i) => [i ? '' : W.TECH_PROBLEM, `${e.where} · ${e.reason}`]),
    [W.CLASSES_FILE, classes && classes.file ? classes.file : W.FILE_NONE],
    ...(fatal ? [['', W.FILE_FIX]] : []),
    ...out.filter((r) => r.inTable).map((r) => [r.name, r.cmd]),
  ]
  return { notes, editable, rows: out, total, last, tech }
}

// storageModel({classes, segments, segmentsFail}, window, {control, hl, now}) → {disk, card}
export function storageModel({ classes, segments = null, segmentsFail = null }, window, { control = null, hl = null, now = Date.now() } = {}) {
  return { disk: diskOf(classes, segments, segmentsFail), card: cardOf(classes, window, { control, hl, now }) }
}
