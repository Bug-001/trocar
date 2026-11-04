// screens/capture/log-model.mjs — the capture log as data (1.9 §采集记录): the capture failures of the last 24 h (D38) as the C.3
// `status` document carries them — `failures.groups[]`, one row per group, newest first, each worded by the CLI's failureBrief — and
// the honest read state (a partial read says so). Filtering by agent keeps the groups whose own `harness` is that agent. Framework-free
// (D75②): no DOM, no timers; CaptureLogScreen.tsx only renders what this returns.
import { fmtWhen } from '../../../legacy/core/fmt.mjs'
import { harnessName, harnessKey, HARNESS_ORDER } from '../../../legacy/core/chips.mjs'
import { HEALTH_READ } from '../../../legacy/labels/common.mjs'
import { redactUrlCredentials } from '../../../legacy/core/sensitive.mjs'
import { failureSentence } from '../../../legacy/core/capture-verdict.mjs'
import { LOG, ERR_WHERE } from '../../../legacy/labels/capture.mjs'

const list = (x) => (Array.isArray(x) ? x : [])
const groupsOf = (doc) => list(doc && doc.failures && doc.failures.groups).filter((g) => g && typeof g === 'object')
const errorsAt = (doc, where) => list(doc && doc.errors).filter((e) => e && e.where === where)
const expectedOf = (doc) => groupsOf(doc).filter((g) => g.level === 'expected')

/** The agents the filter menu offers: every agent a group names, in chip-table order (1.9: the options are the agents the table shows). */
export function agentsOf(doc) {
  const ids = new Set(groupsOf(doc).filter((g) => g.harness != null).map((g) => harnessKey(g.harness)))
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(id); return i < 0 ? HARNESS_ORDER.length : i }
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
}

// one row per non-expected group, newest last_ts first; `filter` keeps the groups whose own `harness` folds to it
function rowOf(g) {
  const s = failureSentence(g)
  const who = g.harness != null ? { id: harnessKey(g.harness), name: harnessName(harnessKey(g.harness)) } : null
  const single = g.first_ts === g.last_ts || g.first_ts == null
  const count = String(g.count ?? '?')
  return {
    key: `${g.level ?? ''}/${g.where ?? ''}/${g.code ?? ''}`, // the fold's own key (C.3): level + where + code
    time: single ? fmtWhen(g.last_ts) : `${fmtWhen(g.first_ts)} – ${fmtWhen(g.last_ts)}`,
    who, whoText: who ? who.name : LOG.who, text: s.text, unknown: s.unknown, count,
    tech: [
      ...['level', 'where', 'code'].filter((k) => g[k] != null).map((k) => ({ k, v: { mono: String(g[k]) } })),
      ...(g.reason != null ? [{ k: 'reason', v: { text: String(g.reason) } }] : []), // the server's own words
      { k: 'first', v: { text: fmtWhen(g.first_ts) } }, { k: 'latest', v: { text: fmtWhen(g.last_ts) } }, { k: 'count', v: { text: count } },
    ],
    diag: redactUrlCredentials(JSON.stringify(g, null, 2)),
  }
}

/** The failure rows of one document (the capture page links the log only when there are any). */
export function failureRows(doc, filter = null) {
  return groupsOf(doc)
    .filter((g) => g.level !== 'expected' && (!filter || (g.harness != null && harnessKey(g.harness) === filter)))
    .sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0))
    .map(rowOf)
}

/**
 * The capture log of one `status` document. → { state, reason, say, partial, rows, none, manifest, foot }. `state` 'reading' before an
 * answer (never an invented empty table), 'unreadable' when the server could not read the capture health (its reason only in foot's
 * technical pairs), else 'ready'. `expected` groups are not failures: they live only in foot.expected.
 */
export function logModel(doc, { filter = null } = {}) {
  const base = { reason: null, say: [], partial: null, rows: [], none: null, manifest: [], foot: null }
  if (doc == null) return { state: 'reading', ...base }
  if (doc.unreadable != null) {
    const reason = String(doc.unreadable)
    return { state: 'unreadable', ...base, reason, say: [HEALTH_READ.unreadable], foot: { expected: [], errors: [{ k: 'reason', v: { text: reason } }] } }
  }
  const rows = failureRows(doc, filter), exp = expectedOf(doc)
  const since = doc.failures && doc.failures.since
  const partial = errorsAt(doc, ERR_WHERE.health)
  const say = [...(since ? [LOG.window(fmtWhen(since))] : []), ...(filter ? [LOG.filterRule] : []), ...(partial.length ? [LOG.truncated] : []),
    ...(rows.length || exp.length ? [LOG.metadataOnly] : [])] // said once per page, not once per row
  const errors = list(doc.errors).filter(Boolean).map((e) => ({ k: String(e.where ?? '?'), v: { text: redactUrlCredentials(String(e.reason ?? '')) } }))
  return {
    state: 'ready', reason: null, say,
    partial: partial.length ? partial.map((e) => ({ k: String(e.where), v: { text: String(e.reason ?? '') } })) : null,
    rows, none: rows.length ? null : LOG.none,
    manifest: errorsAt(doc, ERR_WHERE.manifest).map((e) => ({ k: LOG.manifestError, v: { mono: String(e.reason ?? '') } })),
    foot: exp.length || errors.length ? { expected: exp.map((g) => `${failureSentence(g).text} ×${g.count ?? '?'}`), errors } : null,
  }
}
