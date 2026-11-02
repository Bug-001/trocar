// src/view/board.mjs — the session document's shapes (附录 C.5, RFC 3.5 §会话读): the session meta (sessionMetaOfFacts, from the
// facts the segment index counts), the logged-call and probe views of a session's members (itemsView, from the facts the reduction
// keeps of each, src/view/reduce.mjs) and the call row a session page ships (callRow). Pure; no provider parsing here (invariant 3).
import { stepOrder } from './analyze.mjs';
import { endpointClass } from '../dissect/endpoints.mjs';
import { isLogOnly } from '../dissect/capture-labels.mjs';

const isProbe = (r) => endpointClass(r.endpoint) === 'token-count';
// D40 (3.2 §D40, K7): an inference call the operator set to 「只记日志」 kept its headers and sizes but no body. It is neither a call the board can
// draw (nothing to dissect) nor nothing: it is counted and shown apart, labelled, so a session of them does not read as "no calls".
const isLogged = (r) => !!r.is_llm_call && isLogOnly(r);

// The ONE place the session document's shape lives (附录 C.5): `trocar query sessions` derives the same facts from the segment
// index (src/query/rows.mjs sessionFactsOf) and hands them to this function, so the list the board draws and the list the CLI prints
// are one document, however they were counted. The title is the main lane's task — the first prompt of the captured request (4.4
// §人类标题的来源) — so where it came from is always the wire. No project is known from the capture: '_unresolved', no path.
function sessionDoc(base) {
  const title = base.title ?? null;
  return {
    session_id: base.session_id,
    project_slug: '_unresolved',
    project_path: null,
    entrypoint: base.entrypoint ?? null,
    harness: base.harness ?? null,
    // a meta.json written before D37 has no flag: that fold read only the UA, so its harness was inferred
    harness_inferred: base.harness_inferred ?? (base.harness != null),
    // grouped by a synthesized key (3.4: confidence low) — the chip says so
    session_synthesized: !!base.session_synthesized,
    provider: base.provider ?? null,
    title,
    title_source: title != null ? 'wire' : null,
    calls: base.calls || 0,
    logged: base.logged || 0, // D40: inference calls kept as a log line only (a meta.json written before D40 has none)
    probes: base.probes || 0,
    other: base.other || 0,
    has_subagent: !!base.has_subagent,
    last_ts: base.last_ts || '',
  };
}

/** One session meta from facts counted elsewhere (the segment index; `title` from the usage sidecar), in the one document shape. */
export const sessionMetaOfFacts = (facts) => sessionDoc(facts);

// D40: the calls of a session that were kept as a log line only — how many, which setting did it, and the newest few with what is still
// known of them (time, endpoint, status, the wire sizes). null when there are none. Nothing here is a body: there is none to show.
const LOGGED_SHOWN = 50;
function loggedView(its) {
  if (!its.length) return null;
  const labels = [...new Set(its.map((i) => i.label).filter(Boolean))];
  const items = its.slice(-LOGGED_SHOWN).reverse().map((i) => i.item);
  return { count: its.length, labels, items, shown: items.length };
}
/** itemsView(items) → {logged, probes} of a session document (C.5) from the facts the reduction keeps of each member (src/view/reduce.mjs
 *  `items`, src/view/extract.mjs itemFacts), in step order. */
export function itemsView(items) {
  const its = [...items].sort(stepOrder);
  const probes = its.filter(isProbe).map((i) => ({ ts: i.ts_request, tokens: i.probeTokens ?? null, retention: i.retention }));
  const logged = its.filter(isLogged).map((i) => {
    const w = i.body_wire_bytes || {};
    return { label: (i.retentionLabel || {}).label, item: { id: i.id, ts: i.ts_request || i.ts || null, endpoint: String(i.endpoint || '').split('?')[0], status: i.status ?? null, request_bytes: w.req ?? null, response_bytes: w.resp ?? null } };
  });
  return { logged: loggedView(logged), probes: { count: probes.length, series: probes.filter((p) => p.tokens != null) } };
}
// What a session row ships of a call's `wire` and of each of its labels (3.5 §分页): a CLOSED field set, what the board reads.
// Who reads what (web/legacy):
//   wire        cacheSemanticsKnown (cache cell, popover) · contextState contextMissing reqEncoding labels (callFacts, replyMark)
//   wire.labels[]  id label (callFacts words); the long `text` is a tech detail of a loaded step
const PAGED_META = Object.freeze({
  wire: Object.freeze(['cacheSemanticsKnown', 'contextState', 'contextMissing', 'reqEncoding', 'labels']),
  label: Object.freeze(['id', 'label']),
});
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
// a raw usage the wire did not fill (absent or {}) — the board reads it as "no usage" (core/metrics usageOf); said as usage:null
const noRawUsage = (norm) => !!norm && typeof norm === 'object' && 'usage' in norm
  && (norm.usage == null || (typeof norm.usage === 'object' && !Object.keys(norm.usage).length));

// ── the reduced document mapped to 3.5 §会话读 (RFC 4.3 §3; src/view/reduce.mjs) ───────────────────────────────────────────────────────
// A lane is named by its key (the record id of its first call), a step by its rid; nothing names a gi or a stream id. Rows are the
// closed set of 3.5:59 (absent fields left out; no verdict / flagged: those ride the lane's events), lane headers that of 3.5:60.
const ROW = ['ts', 'ctx', 'comp', 'usage', 'tools', 'status', 'error', 'errMsg', 'unparsed', 'rec', 'compaction', 'compactionInferred', 'gt',
  'probe', 'reqIncomplete', 'wsIncomplete', 'respIncomplete', 'wire', 'cacheBreak'];
const ROW_BREAK = ['cause', 'attribution', 'idx', 'refRid', 'gt', 'firstCall'];
export function callRow(c, lane) {
  const out = { rid: String(c.id), lane, ...pick(c, ROW) };
  if (noRawUsage(c.norm)) out.usage = null;
  if (c.rec) out.rec = { id: c.rec.id, request: { model: c.rec.request && c.rec.request.model } };
  if (c.wire) {
    out.wire = pick(c.wire, PAGED_META.wire);
    if (Array.isArray(c.wire.labels)) out.wire.labels = c.wire.labels.map((l) => (l && typeof l === 'object' ? pick(l, PAGED_META.label) : l));
  }
  if (c.cacheBreak) out.cacheBreak = pick(c.cacheBreak, ROW_BREAK);
  return out;
}
