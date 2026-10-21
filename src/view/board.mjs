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
    session_synthesized: recs.some((r) => !!r._synthKey),
    title,
  });
}

/** One session meta from facts counted elsewhere (the segment index; `title` from the usage sidecar), in the one document shape. */
export const sessionMetaOfFacts = (facts) => sessionDoc(facts);

// ── session ──────────────────────────────────────────────────────────────
// analyze() sees LLM calls only (count_tokens probes are passed separately, as the demo did);
// `records` is SLIMMED to what the browser still needs locally (errStats status + change-sig) —
// the heavy request bodies ride inside `analyzed.…calls[].rec`, never duplicated.
//
// PAGING (4.4:88② · 3.5 游标契约 · D25 轻路):`page = {cursor, limit}` returns only the view page.
// Cursor unit = the GLOBAL call index `gi` (analyze's step order = timeline order). Every call still
// carries its CHEAP meta (ctx/usage/cacheBreak/gi — the overview strip + brush need the whole strip);
// the HEAVY payload (flat block list / norm.text / nonBlockKeys) rides ONLY on calls of the window
// [cursor, cursor+limit) that fit the page's body budget (pageView). The others are marked `paged_out`
// (invariant 4 — the body was not shipped on THIS page, not silently dropped).
// ONE COPY OF EACH CALL ON THE WIRE.
//
// analyze() returns the same call objects in THREE places — `steps` (global order), `lanes[].calls`
// (partitioned) and `streams[].calls` — because in-process they are shared references and cost
// nothing. JSON.stringify does not share: it wrote every call, and every block of it, three times.
// Measured on the 8-call sample: 216 KB of `analyzed`, of which 73 KB was `streams`, 69 KB `steps`
// and 73 KB `lanes` — the same content, thrice.
//
// The board reads NEITHER `streams` NOR `steps`: it renders entirely from `lanes` (buildLanes). So
// the wire carries `steps` as the one array of call objects, and a lane names its calls by `gi` —
// the global index it already carries. The browser re-hydrates in one map(). `streams` is dropped
// outright; nothing has ever read it.
//
// This is a WIRE transform only: the in-process view keeps its shared references, so every
// server-side consumer (paging, memoisation, tests) is untouched.
// (The other full-text channel, `lanes[].events[].text`, is NOT slimmed here. It carried a verbatim
// second copy of every user message and tool_result — 7.8 of 10.1 MB on a 40-call fixture — but it
// was dead weight in-process too: nothing reads it after analyze() derives the event. So it is
// dropped at its source, in analyze(), rather than projected away at the wire.)
function onWire(analyzed) {
  if (!analyzed) return analyzed;
  const { streams, ...rest } = analyzed;
  const lanes = (analyzed.lanes || []).map((l) => ({ ...l, calls: (l.calls || []).map((c) => c.gi) }));
  return { ...rest, lanes };
}
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
 * sessionFold(sessionId, {read}) → { push(rec, key), view(keys, {bound}), bodyOf(call, rec), filled(call, body) } — ONE session, folded record by
 * record (3.5 §内存有界; src/view/assemble.mjs createAssembler; `read(ids)` yields records back by id, in the order asked, for a
 * cross-record context whose items the fold no longer holds — src/dissect/chain.mjs — and for a lane folded again). push() takes the
 * session's records in step order within each lane, the lanes in any order (createAssembler); `key` names the record
 * (its id, or the record itself when ids may repeat). view(keys) is the session document over the records `keys` names, in that
 * order, with every call in its META form; it does not change the fold, so more records can be pushed after it. bodyOf(call, rec)
 * is that call's body built from its record — it never changes for that call object (a lane folded again makes new ones), so it
 * may be kept; filled(call, body) is the call with that body put back (a new object), for the calls a page ships (pageView's `fill`).
 */
export function sessionFold(sessionId, { read = null } = {}) {
  const asm = createAssembler({ read });
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
// The batch form over records in memory (the usage sidecar's fill, tests). No `page` → every call ships its body.
export function sessionView(records, sessionId, { page } = {}) {
  const recs = groupSessions(records).get(sessionId);
  if (!recs) return null;
  const f = sessionFold(sessionId);
  const recOf = new Map();
  for (const r of [...recs].sort(stepOrder)) { const c = f.push(r); if (c) recOf.set(c, r); }
  const fill = (calls) => new Map(calls.map((c) => [c, f.filled(c, f.bodyOf(c, recOf.get(c)))]));
  const view = f.view(recs);
  return page ? pageView(view, page, { fill }) : bodied(view, (c) => fill([c]).get(c));
}
// A call in its meta form with its body put back (a NEW object: the fold's own call is left as it is).
const withBody = (c, body) => { const { paged_out, ...rest } = c; return { ...rest, ...body }; };
// The view with every call object mapped once through `to` — `steps`, `lanes[].calls` and `streams[].calls` hold the SAME
// objects (analyze() shares them), so the three arrays are rewritten through one map and stay the same objects as before.
function bodied(view, to) {
  const A = view.analyzed;
  if (!A) return view;
  const done = new Map();
  const m = (c) => { if (!done.has(c)) done.set(c, to(c)); return done.get(c); };
  const lanes = (A.lanes || []).map((l) => ({ ...l, calls: (l.calls || []).map(m) }));
  const steps = (A.steps || []).map(m);
  // …and `streams`, the THIRD array holding the same objects. Missing it shipped every body anyway, and a deep window then 500'd
  // with "Invalid string length" — which the board shows as its empty state, reporting a many-hundred-call session as having none.
  const streams = (A.streams || []).map((st) => ({ ...st, calls: (st.calls || []).map(m) }));
  return { ...view, analyzed: { ...A, lanes, steps, streams } };
}

// What a paged-out call ships (3.5 §分页): a CLOSED field set — exactly what the board reads from a call whose body is not on the
// page, and nothing else. Everything else (respRefs, extraMessages, a label's long `text`, the raw `norm`, the rest of `cacheBreak`)
// rides only on calls with their bodies. Who reads what (src/web/v2):
//   gi id ts streamId       cursor unit, lane index (giLocal), tech id, 时间轴 (timeline / stepbar / replay playheadSig)
//   ctx comp usage tools    bar height, composition, cache cell / cost (core/metrics usageOf · costOf), the tool-definition count (outline)
//   status error errMsg     failed predicate + its reason (core/metrics isFailed · timeline · detail · ctxwin · stepbar)
//   unparsed rec            the load control's reachability and the model (jump · rawpanel · stepbar/timeline modelOf); rec = {id, request:{model}}
//   compaction compactionInferred gt probe   compaction mark, ground-truth verdict, cost buckets (timeline · header · metrics)
//   reqIncomplete wsIncomplete respIncomplete   the 调用保真行 and ◐ (analysis callFacts)
//   paged_out flat nonBlockKeys   invariant 4 + the meta form (flat / nonBlockKeys empty), shared with assemble.mjs
//   wire        cacheSemanticsKnown (cache cell, popover) · contextState contextMissing reqEncoding labels (callFacts, replyMark)
//   wire.labels[]  id label (callFacts words); the long `text` is a tech detail of a loaded step
//   cacheBreak  cause attribution idx refGi gt firstCall (core/metrics cacheState · stepbar popover · ctxwin · outline · timeline refCallOf)
export const PAGED_META = Object.freeze({
  call: Object.freeze(['gi', 'id', 'ts', 'streamId', 'ctx', 'comp', 'usage', 'tools', 'status', 'error', 'errMsg', 'unparsed', 'rec',
    'compaction', 'compactionInferred', 'gt', 'probe', 'reqIncomplete', 'wsIncomplete', 'respIncomplete', 'paged_out', 'flat', 'nonBlockKeys',
    'wire', 'cacheBreak']),
  wire: Object.freeze(['cacheSemanticsKnown', 'contextState', 'contextMissing', 'reqEncoding', 'labels']),
  label: Object.freeze(['id', 'label']),
  cacheBreak: Object.freeze(['cause', 'attribution', 'idx', 'refGi', 'gt', 'firstCall']),
});
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
// a raw usage the wire did not fill (absent or {}) — the board reads it as "no usage" (core/metrics usageOf); said as usage:null
const noRawUsage = (norm) => !!norm && typeof norm === 'object' && 'usage' in norm
  && (norm.usage == null || (typeof norm.usage === 'object' && !Object.keys(norm.usage).length));
// Slim a call to its PAGED_META form. Non-mutating: returns a NEW object, leaves the source call intact.
function slimCall(c) {
  const out = pick(c, PAGED_META.call);
  out.paged_out = true; // invariant 4: this call's body was not shipped on this page
  // a key list with byte refs into the request body is the body's shape, which this page does not ship — and a slimmed call MUST
  // read as a call the fold kept in its meta form (src/view/assemble.mjs), whichever this is
  out.flat = [];
  if (c.nonBlockKeys) out.nonBlockKeys = [];
  if (noRawUsage(c.norm)) out.usage = null;
  if (c.rec) out.rec = { id: c.rec.id, request: { model: c.rec.request && c.rec.request.model } };
  if (c.wire) {
    out.wire = pick(c.wire, PAGED_META.wire);
    if (Array.isArray(c.wire.labels)) out.wire.labels = c.wire.labels.map((l) => (l && typeof l === 'object' ? pick(l, PAGED_META.label) : l));
  }
  if (c.cacheBreak) out.cacheBreak = pick(c.cacheBreak, PAGED_META.cacheBreak);
  return out;
}
// A lane event ships whole when its step is on the page or its kind is read session-wide (the 提问刻度 / 第 K 次提问 read `user`, the
// resource lifecycle reads `compaction` / `summarize`); any other one ships as {type, step, streamId} (3.5 §分页).
export const SESSION_WIDE_EVENTS = Object.freeze(new Set(['user', 'compaction', 'summarize']));
const slimEvent = (e) => (e && typeof e === 'object' ? pick(e, ['type', 'step', 'streamId']) : e);

// A page ships ONE CALL MORE than it displays: the call just before the window. That call is the
// diff baseline for the first call ON the window, and without it the very first step of every page
// can only report "Δ 无法计算" — a hole in the answer at a boundary the user did not choose and cannot
// see. One extra body per page buys an exact ◆new / ⊖removed at every boundary, so scrolling a long
// session reads the same as scrolling a short one.
const inPage = (gi, { lo, hi }) => gi >= lo - 1 && gi < hi;

function windowOf({ cursor = 0, limit = Infinity } = {}) {
  const lo = Math.max(0, cursor | 0);
  const lim = limit == null ? Infinity : limit;
  return { lo, hi: lim === Infinity ? Infinity : lo + Math.max(0, lim | 0), limit: lim };
}
// What a call's body costs a page: the bytes of the context it ships, block by block — its composition (`comp`, on every call), so a
// context stitched across records (D37 ②) is charged whole, not its record's delta.
const bodyBytes = (c) => Object.values(c.comp || {}).reduce((n, v) => n + v, 0);
// the call failed: it carries an error, or the wire answered with a status that is not 200 (the board's own predicate, core/metrics isFailed)
const failed = (c) => !!c.error || (c.status != null && c.status !== 200);
// The 缓存对比步 of `c` (2.3): the call `cacheBreak.refGi` names, else the nearest earlier call of its lane that did not fail; null when none.
// The front end's twin is src/web/v2/core/metrics.mjs refOf.
function comparisonOf(c, lanes, byGi) {
  const named = c.cacheBreak && c.cacheBreak.refGi;
  if (named != null && byGi.has(named)) return byGi.get(named);
  const lane = lanes.find((l) => (l.calls || []).includes(c));
  const cs = lane ? lane.calls : [];
  for (let k = cs.indexOf(c) - 1; k >= 0; k--) if (!failed(cs[k])) return cs[k];
  return null;
}
/** The calls that ride WITH their bodies (3.5 §分页 正文预算): the in-window call nearest the window's middle (the board puts the step it
 *  shows there) and its cache comparison call — wherever that one lies, so the step always has its diff baseline — then the other
 *  in-window calls nearest the middle first, while their contexts sum to at most `budget` bytes. */
function bodiesFor(calls, inWin, { lo, limit }, budget, lanes) {
  if (limit === Infinity || budget === Infinity) return new Set(inWin);
  const mid = lo + Math.floor(limit / 2);
  const near = [...inWin].sort((a, b) => Math.abs(a.gi - mid) - Math.abs(b.gi - mid) || a.gi - b.gi);
  const keep = new Set();
  if (!near.length) return keep;
  const ref = comparisonOf(near[0], lanes, new Map(calls.map((c) => [c.gi, c])));
  let sum = 0;
  for (const c of [near[0], ref]) if (c && !keep.has(c)) { keep.add(c); sum += bodyBytes(c); }
  for (const c of near) {
    if (keep.has(c)) continue;
    if (sum + bodyBytes(c) > budget) break;
    keep.add(c); sum += bodyBytes(c);
  }
  return keep;
}

/**
 * pageView(view, spec, {fill, budget}) — the cursor/limit window over a session view, WITHOUT mutating it (the lane/call spine is
 * cloned). Every call keeps its cheap meta (PAGED_META); the middle call's comparison call and the calls of the window (plus its
 * baseline) whose bodies fit `budget` (bodiesFor) ride with them — `fill(calls)` → Map(call → that call with its body) puts them back
 * when the view holds calls in their meta form (sessionFold) — and every other call is slimmed and marked `paged_out`. A lane event
 * off the page ships slim unless its kind is SESSION_WIDE_EVENTS. `page.returned` = how many rode with their bodies.
 */
export function pageView(view, spec = {}, { fill = null, budget = Infinity } = {}) {
  const { lo, hi, limit } = windowOf(spec);
  const A = view.analyzed || {};
  // Count over the UNION of both arrays, deduped by object identity: `steps` and `lanes[].calls` hold
  // the same call objects in real assembler output, but a view may legitimately carry one and not the
  // other, and counting the wrong array reports a session length that does not exist.
  const calls = new Set([...(A.steps || []), ...(A.lanes || []).flatMap((l) => l.calls || [])]);
  const total = calls.size;
  const all = [...calls];
  const keep = bodiesFor(all, all.filter((c) => inPage(c.gi, { lo, hi })), { lo, limit }, budget, A.lanes || []);
  const filled = fill ? fill([...keep]) : null;
  // a call whose body could not be put back (its record did not read: said in `errors`) is shipped like any other paged-out call
  const out = bodied(view, (c) => (!keep.has(c) ? slimCall(c) : filled ? (filled.get(c) || slimCall(c)) : c));
  // bodied() cloned the lanes, so their events are re-mapped here without touching the view's own
  if (hi !== Infinity) {
    const whole = (e) => !e || typeof e !== 'object' || SESSION_WIDE_EVENTS.has(e.type) || (e.step != null && inPage(e.step, { lo, hi }));
    for (const l of out.analyzed.lanes) if (Array.isArray(l.events)) l.events = l.events.map((e) => (whole(e) ? e : slimEvent(e)));
  }
  let returned = 0;
  for (const c of new Set([...out.analyzed.steps, ...out.analyzed.lanes.flatMap((l) => l.calls)])) if (!c.paged_out) returned++;
  const nextCursor = hi !== Infinity && hi < total ? hi : null;
  // `returned` counts every call shipped WITH its body: at most the window plus `baseline` — the one call before it, sent so
  // the first step of the page can still be diffed (see inPage) — plus the middle call's comparison call when it lies further
  // back. `baseline` is named on the wire rather than left as an unexplained off-by-one.
  const baseline = lo > 0 && lo <= total ? lo - 1 : null;
  const page = { cursor: lo, limit: limit === Infinity ? null : (limit | 0), total, returned, baseline, nextCursor, hasMore: nextCursor != null };
  return { ...out, page };
}

// Project an assembled view onto WHAT THE BOARD ACTUALLY READS, for the wire.
//
// analyze() stores each call in three arrays — `steps`, `lanes[].calls`, `streams[].calls` — as the
// SAME object. In memory that is one object and two extra references; serialized it is three full
// copies, because JSON has no references. The browser reads `lanes` (buildLanes, index.html:823) and
// `stats`, and never touches the other two: `grep -n '\.steps\|\.streams' src/web/index.html`
// returns nothing. So two thirds of every session response was inert — 20.5 MB shipped for 6.4 MB of
// distinct content on a 6-call fixture with 1.2 MB contexts.
//
// This is orthogonal to paging and compounded with it: paging bounds WHICH calls carry bodies, this
// bounds how many times each one is written out. Together they are what let a large session's window
// stay under V8's max string instead of 500-ing.
//
// A PROJECTION, never a mutation: the same assembled view is memoized and backs later page requests,
// and server-side callers (the test suite) legitimately read `steps`. Returns a new object.
export function forWire(view) {
  if (!view || !view.analyzed) return view;
  const { streams, ...analyzed } = view.analyzed;
  return { ...view, analyzed: onWire(analyzed) };
}

// ── the reduced document mapped to 3.5 §会话读 (RFC 4.3 §3; src/view/reduce.mjs) ───────────────────────────────────────────────────────
// A lane is named by its key (the record id of its first call), a step by its rid; nothing names a gi or a stream id. Rows are the
// closed set of 3.5:59 (absent fields left out; no verdict / flagged: those ride the lane's events), lane headers that of 3.5:60.
const ROW = ['ts', 'ctx', 'comp', 'usage', 'tools', 'status', 'error', 'errMsg', 'unparsed', 'rec', 'compaction', 'compactionInferred', 'gt',
  'probe', 'reqIncomplete', 'wsIncomplete', 'respIncomplete', 'wire', 'cacheBreak'];
const ROW_BREAK = ['cause', 'attribution', 'idx', 'refRid', 'gt', 'firstCall'];
function namesOf(doc) {
  const lanes = doc.lanes || [], keyOf = new Map(), laneOfCall = new Map(), ridAt = new Map();
  for (const s of doc.steps || []) ridAt.set(s.gi, String(s.id));
  for (const l of lanes) { keyOf.set(l.streamId, l.key); for (const c of l.calls) laneOfCall.set(c, l.key); }
  const rid = (gi) => (gi == null ? null : ridAt.get(gi) ?? null);
  return { lanes, rid, key: (streamId) => (streamId == null ? null : keyOf.get(streamId) ?? null), laneOfCall };
}
function rowOf(c, lane) {
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
function headOf(l, N) {
  const first = l.calls[0], last = l.calls[l.calls.length - 1];
  return { lane: l.key, kind: l.kind, icon: l.icon, label: l.label, task: l.task ?? null, ...(l.note ? { note: l.note } : null), count: l.calls.length,
    first: first ? String(first.id) : null, last: last ? String(last.id) : null, peakCtx: l.peakCtx, spawnRid: N.rid(l.spawnStep), parent: N.key(l.parent),
    flagged: l.flagged || 0 };
}
/** skeletonOf(doc) → {rows, lanes, events, records, stats} of a reduced document (src/view/reduce.mjs): rows in step order (3.5:59),
 *  every lane's header (3.5:60), every lane event as {type, rid, lane}, every member's record facts in step order. */
export function skeletonOf(doc) {
  const N = namesOf(doc);
  const rows = (doc.steps || []).map((c) => rowOf(c, N.laneOfCall.get(c) ?? null));
  const events = N.lanes.flatMap((l) => (l.events || []).map((e) => ({ type: e.type, rid: N.rid(e.step), lane: l.key })));
  const records = [...(doc.items || new Map()).values()]
    .map((it) => ({ id: String(it.id), ts_request: it.ts_request, is_llm_call: !!it.is_llm_call, response: { status: it.status ?? null } }))
    .sort((a, b) => stepOrder(a, b));
  return { rows, lanes: N.lanes.map((l) => headOf(l, N)), events, records, stats: doc.stats };
}
/** laneOf(doc, key) → {head, rids, resources, seen, events} of the lane `key` names (null when none): its calls' rids in step order;
 *  its resources with rids for steps (segments {enter, evict}, loads {rid, range, via}); its seen paths {path, firstRid, count}; its
 *  events with `rid` for `step` and `lane` for the stream (a spawn's `childLane` for its child's), a monitor's verdict and flagged kept. */
export function laneOf(doc, key) {
  const N = namesOf(doc), l = N.lanes.find((x) => x.key === key);
  if (!l) return null;
  const resources = (l.resources || []).map(({ segments, loads, ...r }) => ({ ...r,
    segments: (segments || []).map((g) => ({ enter: N.rid(g.enter), evict: N.rid(g.evict) })),
    loads: (loads || []).map(({ step, ...x }) => ({ rid: N.rid(step), ...x })) }));
  const seen = (l.seenFiles || []).map((f) => ({ path: f.path, firstRid: N.rid(f.firstStep), count: f.count }));
  const events = (l.events || []).map(({ step, streamId, childStreamId, ...e }) => ({ ...e, rid: N.rid(step), lane: l.key,
    ...(childStreamId !== undefined ? { childLane: N.key(childStreamId) } : null) }));
  return { head: headOf(l, N), rids: l.calls.map((c) => String(c.id)), resources, seen, events };
}
