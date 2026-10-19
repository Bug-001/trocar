// src/view/board.mjs — server-side board data assembly (D18a Option-2). Groups a FLAT raw
// NDJSON (the source of truth, invariant 2) into the shapes the reused demo dashboard polls:
//   session → { records(slim), analyzed, probes, meta, truncated }
// All provider parsing happens in assembleSession (analyze) HERE, server-side — the browser
// receives only canonical `analyzed` (invariant 3 / AC-3). Pure over its `records` input;
// human-title / cwd enrichment is injected via `enrich(id)` so this module stays testable.
import { assembleSession, sessionIdOf, headersOf, respOf } from './assemble.mjs';
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
const probeSeries = (precs) =>
  // D40: `retention` says whether the probe's own request body was kept (full), set to a log line (log) or never kept (legacy-meta)
  precs.map((r) => { const rp = respOf(r); return { ts: r.ts_request, tokens: (rp && rp.body && rp.body.input_tokens) ?? null, retention: bodyRetentionOf(r) }; })
    .filter((p) => p.tokens != null);
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

// project_slug / project_path / title are a BOARD-side lookup (enrich against ~/.claude/projects),
// not a capture fact — so they are layered on separately from the per-session facts. This is applied
// both to metas computed from records (sessionMetaFor) and to facts counted from the segment index
// (sessionMetaOfFacts), so the two paths produce identical session objects.
// It is also the ONE place the session document's shape lives (附录 C.5): `asight query sessions` derives the
// same facts from the segment index (src/query/rows.mjs sessionFactsOf) and hands them to this function, so the
// list the board draws and the list the CLI prints are one document, however they were counted.
function applyEnrich(base, enrich) {
  const info = enrich ? enrich(base.session_id) : null; // { slug, cwd, title } | null
  return {
    session_id: base.session_id,
    project_slug: info && info.slug ? info.slug : '_unresolved',
    project_path: (info && info.cwd) || null,
    entrypoint: base.entrypoint ?? null,
    harness: base.harness ?? null,
    // a meta.json written before D37 has no flag: that fold read only the UA, so its harness was inferred
    harness_inferred: base.harness_inferred ?? (base.harness != null),
    // grouped by a synthesized key (3.4: confidence low) — the chip says so
    session_synthesized: !!base.session_synthesized,
    provider: base.provider ?? null,
    title: (info && info.title) || null,
    calls: base.calls || 0,
    logged: base.logged || 0, // D40: inference calls kept as a log line only (a meta.json written before D40 has none)
    probes: base.probes || 0,
    other: base.other || 0,
    has_subagent: !!base.has_subagent,
    last_ts: base.last_ts || '',
  };
}

function sessionMetaFor(id, recs, enrich) {
  return applyEnrich({
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
  }, enrich);
}

/** One session meta from facts counted elsewhere (the segment index), in the one document shape. */
export const sessionMetaOfFacts = (facts, { enrich } = {}) => applyEnrich(facts, enrich);

// ── session ──────────────────────────────────────────────────────────────
// analyze() sees LLM calls only (count_tokens probes are passed separately, as the demo did);
// `records` is SLIMMED to what the browser still needs locally (errStats status + change-sig) —
// the heavy request bodies ride inside `analyzed.…calls[].rec`, never duplicated.
//
// PAGING (4.4:88② · 3.5 游标契约 · D25 轻路):`page = {cursor, limit}` returns only the view page.
// Cursor unit = the GLOBAL call index `gi` (analyze's step order = timeline order). Every call still
// carries its CHEAP meta (ctx/usage/cacheBreak/gi — the overview strip + brush need the whole strip);
// the HEAVY payload (rec request body / flat verbatim blocks / norm.text) rides ONLY on calls whose gi
// is in [cursor, cursor+limit). Out-of-window calls are marked `paged_out` (invariant 4 — the body was
// not shipped on THIS page, not silently dropped). No `page` → full send (back-compat; render gate/demo
// board unchanged). Windowing is a SHALLOW non-mutating transform over an already-assembled view, so a
// memoized full view (D21) can back many page requests without re-running analyze.
// Tail-bound a session's records to a raw-bytes budget (4.4:90 "服务端只回当前视图所需的页 · 不再整条下发").
// An UNBOUNDED session view is the whole-page-breaks bug: assembling + JSON.stringify-ing a large
// session overruns V8's max string length (500 "Invalid string length") and can OOM the process, so
// the board falls through to its empty state and LIES that there are no calls. Keep the MOST RECENT
// calls that fit; the omitted ones stay intact in the raw NDJSON and the view is MARKED non-complete
// (invariant 4) via `truncated`, which the board renders as the 非完整视图 banner.
function tailBound(recs, maxBytes) {
  const bytesOf = (r) => (typeof r.req_body === 'string' ? r.req_body.length
    : (r.request ? JSON.stringify(r.request).length : 0));
  const calls = (rs) => rs.reduce((n, r) => n + (r.is_llm_call && !isLogOnly(r) ? 1 : 0), 0);
  let total = 0;
  for (const r of recs) total += bytesOf(r);
  if (!maxBytes || total <= maxBytes) return { recs, bound: null };
  let kept = 0, i = recs.length;
  while (i > 0 && kept + bytesOf(recs[i - 1]) <= maxBytes) kept += bytesOf(recs[--i]);
  if (i === recs.length && recs.length) { i = recs.length - 1; kept = bytesOf(recs[i]); } // always keep ≥1
  const out = recs.slice(i);
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;
  return { recs: out, bound: { shown: calls(out), total: calls(recs), kept_mb: mb(kept), file_mb: mb(total) } };
}

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
function loggedView(recs) {
  if (!recs.length) return null;
  const labels = [...new Set(recs.map((r) => (retentionLabelOf(r) || {}).label).filter(Boolean))];
  const items = recs.slice(-LOGGED_SHOWN).reverse().map((r) => {
    const rp = respOf(r) || {}, w = r.body_wire_bytes || {};
    return { id: r.id, ts: r.ts_request || r.ts || null, endpoint: String(r.endpoint || '').split('?')[0], status: rp.status ?? null, request_bytes: w.req ?? null, response_bytes: w.resp ?? null };
  });
  return { count: recs.length, labels, items, shown: items.length };
}
export function sessionView(records, sessionId, { enrich, bound, page, maxBytes } = {}) {
  const g = groupSessions(records);
  let recs = g.get(sessionId);
  if (!recs) return null;
  let autoBound = null;
  // PAGING SUPERSEDES TAIL-BOUNDING. Both exist to keep one response serializable, but they answer
  // it differently, and running the bound FIRST silently defeated paging: on a real 578-call session
  // tailBound discarded 573 calls before pageView ever saw them, so the board paged through a
  // 5-call stub and the timeline showed 5 bars for a session with 578. Whenever the client asks for a
  // window it is asking for the WHOLE session's shape plus one page of bodies — which the retention
  // window below delivers at bounded cost, with nothing dropped and so nothing to disclose.
  const win = page ? windowOf(page) : null;
  const all = recs;
  if (!win) ({ recs, bound: autoBound } = tailBound(recs, maxBytes));
  const probes = probeRecs(recs);
  // A context stitched across records (D37 ②, a WebSocket call) is planned over the WHOLE session, so a call
  // the tail bound keeps does not turn partial because its predecessor fell outside the bound.
  const analyzed = assembleSession(llmRecs(recs), { ...(win ? { keepFlat: (gi) => inPage(gi, win) } : {}), chainRecords: llmRecs(all) });
  const slim = recs.map((r) => ({
    is_llm_call: !!r.is_llm_call, ts_request: r.ts_request, id: r.id,
    response: { status: (respOf(r) || {}).status ?? null }, // R1: read via respOf (D10 `resp` + v0 `response`)
  }));
  const view = {
    records: slim,
    analyzed,
    logged: loggedView(loggedRecs(recs)),
    probes: { count: probes.length, series: probeSeries(probes) },
    meta: sessionMetaFor(sessionId, recs, enrich),
    truncated: bound || autoBound || null, // 保真边界 (invariant 4): set when a large session was tail-bounded
  };
  return page ? pageView(view, page) : view;
}

// Slim a call to CHEAP meta only — drop the heavy request body + reconstructed blocks + response text,
// keep everything the timeline/overview reads (ctx/usage/gi/cacheBreak/error/compaction) plus the model
// (so cost + labels still resolve). Non-mutating: returns a NEW object, leaves the source call intact.
function slimCall(c) {
  const { rec, flat, norm, _comp, nonBlockKeys, ...rest } = c;
  return {
    ...rest,
    paged_out: true, // invariant 4: this call's body was not shipped on this page
    flat: [],
    // Same as `flat`: a key list with byte refs into the request body is the body's shape, which this page does not
    // ship. It is also what made a slimmed call differ from one the assembler never flattened (`keepFlat`), and the
    // two MUST be the same document: the warm path pages an assembly built whole, the cold one assembles the window
    // only (D63; src/query/named/session.mjs).
    nonBlockKeys: nonBlockKeys ? [] : nonBlockKeys,
    norm: norm ? { usage: norm.usage } : norm,
    rec: rec ? { id: rec.id, request: { model: rec.request && rec.request.model } } : rec,
  };
}

// Apply the cursor/limit window over an assembled view WITHOUT mutating it (clones only the lane/call
// spine; shares in-window call objects, slims out-of-window ones). Returns the view + `page` metadata.
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

export function pageView(view, spec = {}) {
  const { lo, hi, limit } = windowOf(spec);
  const lanes = (view.analyzed && view.analyzed.lanes) || [];
  // analyze() puts each call object in TWO arrays — `lanes[].calls` and the flat `steps` — as the same
  // object. Slimming only the lanes therefore left every body still reachable through `steps`, and the
  // response barely shrank (measured 367 KB → 286 KB on an 8-call sample, i.e. paging bought ~nothing
  // on the one axis it exists for). Slim ONCE into a map keyed by the original object, then rewrite
  // both arrays through it, so the two views stay the same object as they were before paging.
  const slimmed = new Map();
  let returned = 0;
  const paged = (c) => {
    if (inPage(c.gi, { lo, hi })) return c;
    if (!slimmed.has(c)) slimmed.set(c, slimCall(c));
    return slimmed.get(c);
  };
  const pagedLanes = lanes.map((lane) => ({ ...lane, calls: (lane.calls || []).map(paged) }));
  const steps = (view.analyzed && view.analyzed.steps) || [];
  const pagedSteps = steps.map(paged);
  // …and `streams`, the THIRD array holding the same objects. Missing it shipped every body anyway,
  // and a deep window then 500'd with "Invalid string length" — which the board shows as its empty
  // state, reporting a many-hundred-call session as having none.
  const pagedStreams = ((view.analyzed && view.analyzed.streams) || [])
    .map((st) => ({ ...st, calls: (st.calls || []).map(paged) }));
  // Count over the UNION of both arrays, deduped by object identity: `steps` and `lanes[].calls` hold
  // the same call objects in real assembler output, but a view may legitimately carry one and not the
  // other, and counting the wrong array reports a session length that does not exist.
  const seen = new Set([...pagedSteps, ...pagedLanes.flatMap((l) => l.calls)]);
  const total = seen.size;
  for (const c of seen) if (!c.paged_out) returned++;
  const analyzed = { ...view.analyzed, lanes: pagedLanes, steps: pagedSteps, streams: pagedStreams };
  const nextCursor = hi !== Infinity && hi < total ? hi : null;
  // `returned` counts every call shipped WITH its body, which is the window plus `baseline` — the one
  // call before it, sent so the first step of the page can still be diffed (see inPage). `baseline` is
  // named on the wire rather than left as an unexplained off-by-one.
  const baseline = lo > 0 && lo <= total ? lo - 1 : null;
  const page = { cursor: lo, limit: limit === Infinity ? null : (limit | 0), total, returned, baseline, nextCursor, hasMore: nextCursor != null };
  return { ...view, analyzed, page };
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
