// src/view/board.mjs — server-side board data assembly (D18a Option-2). Groups a FLAT raw
// NDJSON (the source of truth, invariant 2) into the shapes the reused demo dashboard polls:
//   session → { records(slim), analyzed, probes, meta, truncated }
// All provider parsing happens in the assembler (src/view/assemble.mjs) HERE, server-side — the browser
// receives only canonical `analyzed` (invariant 3 / AC-3). Pure over its `records` input;
import { createAssembler, sessionIdOf, headersOf, respOf } from './assemble.mjs';
import { stepOrder } from './analyze.mjs';
import { harnessOf as harnessOfRecord, LEGACY_PROVIDER, wireProviderOfEndpoint } from '../dissect/harnesses.mjs';
import { stampSynthKeys } from '../dissect/synth-key.mjs';
import { isLogOnly, bodyRetentionOf, retentionLabelOf } from '../dissect/capture-labels.mjs';

// tolerate both envelope shapes: demo v0 `request_headers` + product D10 `req_headers` (Codex).
const anyHeaders = (recs) => headersOf(recs.find((r) => r.request_headers || r.req_headers));

const isProbe = (r) => /count_tokens/.test(r.endpoint || '');
// A session record that is neither real inference nor a count_tokens probe — the sharder's `other`
// stream. Kept exactly complementary to is_llm_call/isProbe so calls+probes+other = the session total.
const isOther = (r) => !r.is_llm_call && !isProbe(r);
// D40 (3.2 §D40, K7): an inference call the operator set to 「只记日志」 kept its headers and sizes but no body. It is neither a call the board can
// draw (nothing to dissect) nor nothing: it is counted and shown apart, labelled, so a session of them does not read as "no calls".
const isLogged = (r) => !!r.is_llm_call && isLogOnly(r);

// ── grouping ────────────────────────────────────────────────────────────────
// Records carrying their harness's session key (src/dissect/harnesses.mjs, RFC 3.4) belong to a
// session; the rest are the session-less control plane (telemetry / config / account).
// A keyless Hermes / Kimi inference call gets a synthesized key first (3.4 合成键, gate G11), stamped over the
// whole input in its order — the order the segment index reads the files in, so both readers name it the same.
export function groupSessions(records) {
  stampSynthKeys(records);
  const g = new Map();
  for (const r of records) {
    const id = sessionIdOf(r);
    if (!id) continue;
    if (!g.has(id)) g.set(id, []);
    g.get(id).push(r);
  }
  return g;
}

// ── per-session derived meta (cheap; no analyze) ──────────────────────────────
const llmRecs = (recs) => recs.filter((r) => r.is_llm_call && !isLogOnly(r));
const loggedRecs = (recs) => recs.filter(isLogged);
const probeRecs = (recs) => recs.filter(isProbe);
const otherRecs = (recs) => recs.filter(isOther);
function entrypointOf(recs) {
  const h = anyHeaders(recs);
  const app = String(h['x-app'] || '').toLowerCase(), ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (app === 'desktop' || /desktop/.test(ua)) return 'desktop';
  if (app === 'cli' || /cli|sdk-cli/.test(ua)) return 'cli';
  return null;
}
// D37 ①: harness = proc.agent, through the ONE table (src/dissect/harnesses.mjs) the segment index
// also reads. The UA is consulted only for legacy records without proc, and that answer is flagged
// harness_inferred so the chip can say so. The first record WITH proc decides; else the first with headers.
// provider = the board's PRICING key (gate G10): fixed for the pre-D37 harnesses, otherwise the wire
// dialect actually observed, or null. A harness that can be pointed at ANY backend (OpenCode) MUST NOT
// have its provider inferred from its name — never claim a provider unobserved.
function wireProviderOf(recs) {
  for (const r of recs || []) { const p = wireProviderOfEndpoint(r && r.endpoint); if (p) return p; }
  return null;
}
function harnessOf(recs) {
  const list = recs || [];
  const h = harnessOfRecord(list.find((x) => x && x.proc) || list.find((x) => x && (x.req_headers || x.request_headers)));
  if (!h.id) return { harness: null, harness_inferred: false, provider: null };
  return { harness: h.id, harness_inferred: h.inferred, provider: LEGACY_PROVIDER[h.id] ?? wireProviderOf(list) };
}
// a subagent turn carries its own x-claude-code-agent-id (differs from the main lane's absence)
const hasSubagent = (recs) => recs.some((r) => String(headersOf(r)['x-claude-code-agent-id'] || '').trim());
// the same time the segment index keeps per record (src/query/rows.mjs), so the list and the board sort alike
function lastTs(recs) { let m = ''; for (const r of recs) { const t = String(r.ts_request ?? r.ts ?? ''); if (t > m) m = t; } return m; }

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

function sessionMetaFor(id, recs, title) {
  return sessionDoc({
    session_id: id,
    entrypoint: entrypointOf(recs),
    ...harnessOf(recs), // { harness, harness_inferred, provider }
    calls: llmRecs(recs).length,
    logged: loggedRecs(recs).length,
    probes: probeRecs(recs).length,
    other: otherRecs(recs).length,
    has_subagent: hasSubagent(recs),
    last_ts: lastTs(recs),
    session_synthesized: recs.some((r) => !!r._synthKey && !r._kin), // a call joined by content (3.4 按内容认亲) infers nothing
    title,
  });
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
 *  `items`, src/view/extract.mjs itemFacts), in step order: the same shapes sessionFold's view gives from the records. */
export function itemsView(items) {
  const its = [...items].sort(stepOrder);
  const probes = its.filter(isProbe).map((i) => ({ ts: i.ts_request, tokens: i.probeTokens ?? null, retention: i.retention }));
  const logged = its.filter(isLogged).map((i) => {
    const w = i.body_wire_bytes || {};
    return { label: (i.retentionLabel || {}).label, item: { id: i.id, ts: i.ts_request || i.ts || null, endpoint: String(i.endpoint || '').split('?')[0], status: i.status ?? null, request_bytes: w.req ?? null, response_bytes: w.resp ?? null } };
  });
  return { logged: loggedView(logged), probes: { count: probes.length, series: probes.filter((p) => p.tokens != null) } };
}
// What the session document keeps of one record besides its call (the fold lets the record go): the slim entry the browser reads
// (errStats status + change-sig), the probe point, the logged-call line, and the envelope fields the session meta is derived from.
const META_KEYS = ['is_llm_call', 'body_retention', 'endpoint', 'req_headers', 'request_headers', 'proc', 'ts_request', 'ts'];
function itemOf(r) {
  const rp = respOf(r) || {};
  const light = {};
  for (const k of META_KEYS) if (r[k] !== undefined) light[k] = r[k];
  if (r._synthKey) Object.defineProperty(light, '_synthKey', { value: r._synthKey });
  if (r._kin) Object.defineProperty(light, '_kin', { value: true });
  const w = r.body_wire_bytes || {};
  return {
    slim: { is_llm_call: !!r.is_llm_call, ts_request: r.ts_request, id: r.id, response: { status: rp.status ?? null } }, // R1: read via respOf (D10 `resp` + v0 `response`)
    // D40: `retention` says whether the probe's own request body was kept (full), set to a log line (log) or never kept (legacy-meta)
    probe: isProbe(r) ? { ts: r.ts_request, tokens: (rp.body && rp.body.input_tokens) ?? null, retention: bodyRetentionOf(r) } : null,
    logged: isLogged(r) ? { label: (retentionLabelOf(r) || {}).label, item: { id: r.id, ts: r.ts_request || r.ts || null, endpoint: String(r.endpoint || '').split('?')[0], status: rp.status ?? null, request_bytes: w.req ?? null, response_bytes: w.resp ?? null } } : null,
    light,
  };
}
/**
 * sessionFold(sessionId) → { push(rec, key), view(keys, {bound}), bodyOf(call, rec), filled(call, body) } — ONE session, folded record by
 * record (src/view/assemble.mjs createAssembler). push() takes the session's records in step order; `key` names the record
 * (its id, or the record itself when ids may repeat). view(keys) is the session document over the records `keys` names, in that
 * order, with every call in its META form; it does not change the fold, so more records can be pushed after it. bodyOf(call, rec)
 * is that call's body built from its record — it never changes for that call object (a lane folded again makes new ones), so it
 * may be kept; filled(call, body) is the call with that body put back (a new object), for the calls a reader ships with their bodies.
 */
export function sessionFold(sessionId) {
  const asm = createAssembler();
  const items = new Map();
  return {
    push(r, key = r) {
      items.set(key, itemOf(r));
      // analyze() sees inference calls only: count_tokens probes and D40 log-only calls are counted apart (above)
      return r.is_llm_call && !isLogOnly(r) ? asm.push(r) : null;
    },
    view(keys, { bound = null } = {}) {
      const its = keys.map((k) => items.get(k)).filter(Boolean);
      const probes = its.filter((i) => i.probe).map((i) => i.probe);
      const analyzed = asm.finish();
      const main = (analyzed.lanes || []).find((l) => l.kind === 'main');
      return {
        records: its.map((i) => i.slim),
        analyzed,
        logged: loggedView(its.filter((i) => i.logged).map((i) => i.logged)),
        probes: { count: probes.length, series: probes.filter((p) => p.tokens != null) },
        meta: sessionMetaFor(sessionId, its.map((i) => i.light), main ? main.task ?? null : null),
        truncated: bound, // 保真边界 (invariant 4): set when a session too large for even its meta was read from its tail
      };
    },
    bodyOf: (call, r) => asm.bodyOf(call, r),
    filled: withBody,
  };
}
// A call in its meta form with its body put back (a NEW object: the fold's own call is left as it is).
const withBody = (c, body) => { const { paged_out, ...rest } = c; return { ...rest, ...body }; };
// What a session row ships of a call's `wire` and of each of its labels (3.5 §分页): a CLOSED field set, what the board reads.
// Who reads what (src/web/v2):
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
