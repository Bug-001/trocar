// src/view/assemble.mjs — server-side view assembler (D18a Option-2). Runs the demo's
// analyze pipeline SERVER-SIDE over ONE session's raw records and BAKES per-call flat +
// cacheBreak + groundTruth, so the reused demo render code reads PRE-COMPUTED fields instead
// of calling analyze functions in the browser. Result: the demo's exact look, with ZERO
// provider parsing in the browser → invariant 3 / AC-3 intact (adding a provider = a new
// server-side analyzer, frontend unchanged).
import { createHash } from 'node:crypto';
import { analyze, linearContext, cacheBreak, normResp, flatBlockText } from './analyze.mjs';
import { reqIncompleteOf, wsIncompleteOf, respIncompleteOf, captureLabelsOf } from '../dissect/capture-labels.mjs'; // #21 request-body labels, D38 WebSocket labels, response labels; captureLabelsOf: the per-call wire.labels (4.6 §记录)
import { blockSpans } from '../adapters/cc.mjs';
import { scanJson, spanAt } from '../adapters/content-hash.mjs';
import { slimBlock, compBuckets } from './blockmeta.mjs';
import { mintRawRef, composeTextRef } from '../etl/orchestrator.mjs';
import { sessionKeyOf, hintsOf, observerEffectsOf } from '../dissect/harnesses.mjs';
import { wireFormatOf, boardDissectorFor, contextStateOf, blockKeysOf } from '../dissect/registry.mjs';
import { vendorOf } from '../dissect/vendors.mjs';

// D17④ 地面真相(RFC 3.3:65 · 独立字节护城河). The demo proxied prefix identity with the 32-bit
// bounded content_hash SEQUENCE (collision-prone). Product MUST use a REAL full SHA-256 over the
// VERBATIM prefix bytes (skipping volatile) — so a 32-bit-key collision hiding a real byte difference
// makes the prefixes hash-UNequal → no false ground-truth flag. Computed SERVER-SIDE (不变式 3).
function prefixSha256(flat, idx) {
  if (!flat || idx <= 0) return null; // no reusable prefix
  const h = createHash('sha256');
  // length-prefixed frames = unambiguous block boundaries with NO delimiter byte (ASCII-only source).
  for (let i = 0; i < idx; i++) { const b = flat[i]; if (b.volatile) continue; const t = flatBlockText(b); h.update(String(t.length) + ':' + t); }
  return h.digest('hex');
}
// Ground-truth from PROVEN byte-identity (not the structural proxy). Strict wording per 3.3:73 — the
// claim is only "MY outbound prefix is byte-identical", never "the provider is wrong".
function realGroundTruth(prefixByteIdentical, read, create) {
  if (!prefixByteIdentical) return null;             // no proven byte-identical reusable prefix
  if (read > 0) return null;                          // genuinely reused → normal
  return create > 0 ? 'ttl-rebuild' : 'provider-contradiction';
}

// CC dissector · board intake (RFC 3.1 dissector · D18a). The board's block extractor (linearContext /
// analyze) reads a PARSED v0-shape record: `.request` (object) + `.response`. The PRODUCT capture (D10,
// see 4.1/3.1:12) stores the request as a VERBATIM `req_body` STRING and the response under `resp`. So a
// D10 record renders EMPTY on the board unless we dissect it first. hydrateForBoard parses req_body →
// request (carrying the FULL verbatim tool `input_schema` → analyze marks tools verbatim, not metadata)
// and aliases resp→response. This is the source truth (不变式 2): blocks are sliced from the verbatim
// wire req_body, so AC-1 holds MORE directly for D10 than v0. No-op for records already in v0 shape.
function hydrateForBoard(r) {
  if (!r || r.request !== undefined || typeof r.req_body !== 'string') return r; // already v0 / not a D10 body
  let body;
  try { body = JSON.parse(r.req_body); } catch { return r; } // unparseable → leave (analyze filters it)
  const system = Array.isArray(body.system) ? body.system
    : (typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : []);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const request = {
    ...body, system, messages, tools,
    // derived counts the v0 capture used to bake (the raw wire body doesn't carry them)
    message_count: messages.length,
    tool_count: tools.length,
    system_chars: system.reduce((a, b) => a + String((b && b.text) || '').length, 0),
    context_chars: r.req_body.length,
  };
  // Carry the source-stream stamp across the copy. `{...r}` takes only ENUMERABLE properties, and
  // `_stream` is deliberately non-enumerable (so it never appears in stored or shipped JSON) — which
  // means a spread silently drops it, and every block downstream loses the half of its text_ref that
  // says WHICH capture file its bytes are in. Silent, because the result is simply a missing locator.
  const out = { ...r, request, response: r.response || r.resp || {} };
  if (r._stream) Object.defineProperty(out, '_stream', { value: r._stream, enumerable: false, configurable: true });
  return out;
}

// headersOf tolerates BOTH the demo v0 `request_headers` and the product D10 `req_headers` envelope key.
export const headersOf = (rec) => (rec && (rec.request_headers || rec.req_headers)) || {};
// Envelope drift guard (R1, audit 2026-07-19). The product D10 envelope stores the response under
// `resp` (src/capture/envelope.mjs); demo v0 used `response`. Readers MUST go through this helper —
// reading `.response` directly is what silently killed the probe rail, every HTTP status and the
// whole control-plane view on real captures (`.response` was present on 0 of 25,817 live records)
// while the pre-D10 test fixture kept them green. Mirrors headersOf: tolerate BOTH shapes forever,
// because old captures on disk are still the user's data (invariant 2).
export const respOf = (rec) => (rec && (rec.resp || rec.response)) || null;
// Session key per harness (RFC 3.4 table, D37): read from the ONE table the ETL and sharder also use.
export function sessionIdOf(rec) {
  return sessionKeyOf(rec).key;
}
export function recordsForSession(records, sessionId) {
  return records.filter((r) => sessionIdOf(r) === sessionId);
}

// ── wire dispatch (D25 · one dissector per WIRE FORMAT, D37 ①) ──────────────────────────────────
// Which dissector reads a record is the shared registry's answer (src/dissect/registry.mjs): the flat-lane
// wires have a board dissector object there; the Anthropic wire is assembled by the multi-lane analyzer
// (src/view/analyze.mjs). This module names no wire and imports no wire dissector.

// No dissector claimed these bytes. Report that IN PLACE (invariant 4) and COUNT them (3.1:44 — an
// unclaimed record MUST land in a labelled "unrecognized" state, MUST NOT be silently dropped).
// We deliberately emit ZERO calls/lanes/blocks: any number we printed here would be a number we did
// not parse. The evidence below (endpoints, user-agents, models) is copied verbatim from the envelope
// so a human can see WHAT arrived without us pretending to have understood it.
// The evidence block for records no dissector claims. `partial` = they sit inside a session whose other
// records ARE rendered (a mixed session); otherwise the whole session is unrecognized.
function unknownSummary(recs, partial) {
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const models = uniq(recs.map((r) => {
    let b = r && r.request && typeof r.request === 'object' ? r.request : null;
    if (!b && r && typeof r.req_body === 'string') { try { b = JSON.parse(r.req_body); } catch { b = null; } }
    return b && typeof b.model === 'string' ? b.model : null;
  }));
  return {
    partial,
    reason: partial
      ? 'Some records in this session match no registered dissector (src/dissect/registry.mjs). They are '
        + 'counted here and NOT rendered; the rest of the session is.'
      : 'No registered dissector claims these bytes (src/dissect/registry.mjs), so they are NOT '
        + 'parsed and NOT rendered — showing them under another wire\'s vocabulary would be a fabrication.',
    records: recs.length,
    endpoints: uniq(recs.map((r) => String((r && r.endpoint) || '').split('?')[0])),
    userAgents: uniq(recs.map((r) => (headersOf(r) || {})['user-agent'])),
    models,
  };
}
function assembleUnknown(records) {
  return {
    provider: 'unknown',
    unknown: unknownSummary(records || [], false),
    streams: [], steps: [], lanes: [],
    stats: { calls: 0, streams: 0, subagents: 0, monitors: 0, compactions: 0, totalIn: 0, totalOut: 0, peakCtx: 0 },
  };
}

// Flat-lane assembler (one per wire format, chosen from the registry's table): produces the SAME `analyzed`
// shape the multi-lane path does — a `main` lane of calls, each baked with the neutral fields the board reads
// (flat/usage/cacheBreak/gt/prefixSha256) — through the dissector object `d` (src/dissect/registry.mjs
// `boardDissectorFor`). The cache-break + ground-truth machinery (cacheBreak / prefixSha256 / realGroundTruth)
// is wire-agnostic over the flat block vocabulary, so it is REUSED verbatim. Lanes beyond `main` and the
// resource ledger are not extracted on this path (fidelity: not-yet-extracted, not misreported).
// Lanes a flat-lane wire can be split into by the harness table's hints (3.4). Labels are server-side
// (invariant 3); the board renders them as it renders analyze()'s lanes.
const FLAT_LANES = {
  main: { kind: 'main', icon: '💬', label: 'conversation' },
  subagent: { kind: 'subagent', icon: '🧬', label: 'subagent' },
  aux: { kind: 'aux', icon: '⚙', label: 'other util' },
  probe: { kind: 'probe', icon: '👁', label: 'warm-up / probe requests' },
};
// analyze()'s step order (ts_request, then id), exactly: every assembler uses it, so a session's global
// step index is one sort whichever wires it mixes.
const stepOrder = (a, b) => String(a.ts_request).localeCompare(String(b.ts_request)) || String(a.id).localeCompare(String(b.id));
function assembleFlatLane(records, d, opts = {}) {
  // Admit every record the registry hands to THIS dissector (shape in, shape out: the dissector dispatches,
  // the shared layer does not branch).
  const llm = (records || []).filter((r) => r && r.is_llm_call && boardDissectorFor(r) === d).sort(stepOrder);
  const calls = [];
  const prevFlatOf = new Map(); // lane kind → the last call that established a cache prefix in that lane
  let local = 0;
  for (const r of llm) {
    // the harness table's lane hint (3.4: e.g. a subagent header); labels are server-side (invariant 3)
    const laneKind = FLAT_LANES[hintsOf(r).lane] ? hintsOf(r).lane : 'main';
    const prevFlat = prevFlatOf.get(laneKind) || null;
    const gi = opts.giOf ? opts.giOf(r) : local;
    local++;
    let req; try { req = JSON.parse(r.req_body); } catch { req = null; }
    // req_body null (a WebSocket call whose request message is undecoded, or a server push: 4.6 §传输) parses to null,
    // which used to throw below and take the whole session's /api/session down: such a call has no request
    if (!req || typeof req !== 'object') req = (r.request && typeof r.request === 'object') ? r.request : {};
    r.request = req; // so the board's callComp / cost read the parsed request
    // derived counts the board header + raw card read (parallel to hydrateForBoard on the multi-lane path)
    Object.assign(req, d.reqCounts(req));
    req.context_chars = (r.req_body || '').length; // verbatim wire byte count
    const flat = d.boardFlat(req, r);
    const norm = d.normResp(r);
    const usage = norm.canonUsage;
    const brk = cacheBreak(prevFlat, flat, {});
    const curPfx = prefixSha256(flat, brk.idx);
    const prevPfx = prefixSha256(prevFlat, brk.idx);
    const prefixByteIdentical = brk.idx > 0 && curPfx != null && curPfx === prevPfx;
    brk.prefixSha256 = curPfx;
    brk.prefixByteIdentical = prefixByteIdentical;
    brk.gt = realGroundTruth(prefixByteIdentical, usage.read, usage.create);
    brk.gtReal = true;
    const kept = !opts.keepFlat || opts.keepFlat(gi); // see assembleSession: retention window
    calls.push({
      gi, id: r.id, streamId: laneKind, rec: kept ? slimRec(r) : { id: r.id, request: { model: req.model } }, norm, wireFormat: d.id,
      ctx: d.ctxTokens(norm),
      msgCount: req.message_count || 0,
      tools: Array.isArray(req.tools) ? req.tools.length : 0,
      ts: r.ts_request || r.ts || '', status: (r.resp && r.resp.status) || null,
      compaction: false, error: !!r.error, reqIncomplete: reqIncompleteOf(r), wsIncomplete: wsIncompleteOf(r), respIncomplete: respIncompleteOf(r),
      wire: wireOf(r, d.id), nonBlockKeys: kept ? nonBlockKeysOf(r, d.id) : [],
      // shipped as metadata + a text_ref per block, never the body (4.2:55); out of the window: no blocks
      flat: kept ? withPathRefs(flat, r) : [], ...(kept ? null : { paged_out: true }),
      // Tier A, same as the multi-lane path: computed from `flat` BEFORE the retention window drops it.
      comp: compBuckets(flat),
      usage, cacheBreak: brk, gt: brk.gt, prefixSha256: curPfx,
    });
    // A call that failed never established a cache prefix, so it MUST NOT become the next baseline.
    const st = (respOf(r) || {}).status;
    if (!(r.error || (st != null && st !== 200))) prevFlatOf.set(laneKind, flat);
  }
  const kinds = Object.keys(FLAT_LANES).filter((k) => calls.some((c) => c.streamId === k));
  const lanes = kinds.map((k) => {
    const lc = calls.filter((c) => c.streamId === k);
    return { id: k, streamId: k, ...FLAT_LANES[k], calls: lc, events: [], resources: [], seenFiles: [],
      giLocal: new Map(lc.map((c, i) => [c.gi, i])), peakCtx: lc.reduce((m, c) => Math.max(m, c.ctx), 1),
      spawnStep: null, parent: null, flagged: 0 };
  });
  const stats = {
    calls: calls.length, streams: lanes.length, subagents: lanes.filter((l) => l.kind === 'subagent').length, monitors: 0, compactions: 0,
    totalIn: calls.reduce((a, c) => a + ((c.norm.usage || {}).input_tokens || 0), 0),
    totalOut: calls.reduce((a, c) => a + ((c.norm.usage || {}).output_tokens || 0), 0),
    peakCtx: calls.reduce((a, c) => Math.max(a, c.ctx), 0),
  };
  return { provider: d.provider, streams: lanes.map((l) => ({ id: l.id, kind: l.kind, calls: l.calls })), steps: calls, stats, lanes };
}

// records = ONE session's raw (v0/demo-shape) records. Returns analyze() output with each
// call augmented: .flat (linearContext), .cacheBreak (vs prev in lane), .gt (groundTruth).


// The per-call record, reduced to what the board renders FROM it.
//
// /api/session used to ship `rec.request` whole — the entire wire body — to a browser that had just
// been sent every block of that same body, assembled. On a real 115-call session that was ~120 MB of
// a 142.8 MB response. The frontend was checked line by line against this: it reads `rq.model`,
// `rq.context_chars`, `rq.message_count`, `rq.tool_count`, `rq.system_chars` and nothing else. Every
// computation that genuinely needs the body — composition buckets, section tax, diff keys,
// cache-break — already runs server-side over the blocks (invariant 3 requires that anyway: the
// browser must never branch on a provider's wire shape).
//
// The body is not lost, it is where it always was: in the raw NDJSON, addressed by the same ref its
// blocks carry.
const REQ_KEEP = ['model', 'context_chars', 'message_count', 'tool_count', 'system_chars'];
function slimRec(rec) {
  if (!rec) return rec;
  const rq = rec.request || {};
  const request = {};
  for (const k of REQ_KEEP) if (rq[k] !== undefined) request[k] = rq[k];
  return { id: rec.id, request };
}

// Turn a call's assembled blocks into their WIRE shape: metadata + a text_ref locator, no body.
//
// The locator is minted in the SAME form the DuckDB projection persists (RFC 4.2:40 —
// `<session>/<stream>#<recordId>::<start>-<end>`), so the board and the analysis path address bytes
// identically and ONE resolver serves both. That is also what keeps AC-1 honest: what the browser
// eventually displays is produced by 「定位源记录 → slice(start,end)」 over the raw capture, not by a
// second copy of the text that could drift from it.
//
// Blocks whose span could not be located, or whose record cannot be addressed (no id, no known
// stream), keep no ref — slimBlock marks them `unresolvable` so the row can say so. Silence would
// render as an empty body, which reads as "the model saw nothing" (invariant 4).
function withRefs(flat, rec) {
  let spans = null;
  try { spans = blockSpans(rec); } catch { spans = null; }
  const id = rec && rec.id != null ? String(rec.id) : null;
  const stream = rec && rec._stream;
  const base = id && stream ? mintRawRef(sessionIdOf(rec), stream, id) : null;
  return flat.map((b, i) => {
    const span = spans && spans[i];
    return slimBlock(b, base && span ? composeTextRef(base, span) : null);
  });
}

// Locators for dissectors that describe each block by a JSON `path` into req_body (the flat-lane wires).
// Same ref grammar as withRefs, so one resolver serves both paths and AC-1 holds for both. A block whose
// path is absent from the bytes, or a record that cannot be addressed, is shipped inline and labelled
// unaddressable by slimBlock (invariant 4).
function withPathRefs(flat, rec) {
  let root = null;
  try { root = typeof rec.req_body === 'string' ? scanJson(rec.req_body) : null; } catch { root = null; }
  const id = rec && rec.id != null ? String(rec.id) : null;
  const base = id && rec._stream ? mintRawRef(sessionIdOf(rec), rec._stream, id) : null;
  return flat.map((b) => {
    const span = base && root && Array.isArray(b.path) ? spanAt(root, b.path) : null;
    return slimBlock(b, span ? composeTextRef(base, span) : null);
  });
}

// Canonical wire facts per call (3.2:131-133), baked HERE so the page only reads them (invariant 3):
// format, vendor (null = cache semantics unknown), transport, context state, observer effects and the
// incompleteness labels (4.6 §记录 「不完整的标注」 — shown on the call, never dropped). Cheap: no body parse.
function wireOf(rec, format) {
  return { format, vendor: vendorOf(rec), transport: rec && rec.transport === 'ws' ? 'ws' : 'http',
    contextState: contextStateOf(rec), observerEffect: observerEffectsOf(rec), labels: captureLabelsOf(rec) };
}
// 4.6 R2 「不成块的顶层键逐个列出」: every top-level request key that is not a block section, each with a
// locator to its verbatim value (null when the record cannot be addressed).
function nonBlockKeysOf(rec, format) {
  if (!rec || typeof rec.req_body !== 'string') return [];
  let root = null;
  try { root = scanJson(rec.req_body); } catch { return []; }
  if (!root || root.kind !== 'object') return [];
  const keep = blockKeysOf(format);
  const id = rec.id != null ? String(rec.id) : null;
  const base = id && rec._stream ? mintRawRef(sessionIdOf(rec), rec._stream, id) : null;
  const out = [];
  for (const [key, node] of root.props) if (!keep.includes(key)) out.push({ key, chars: node.end - node.start, ref: base ? composeTextRef(base, [node.start, node.end]) : null });
  return out;
}

// `opts.keepFlat(gi)` — RETENTION WINDOW. The cache-break chain is inherently sequential: call N's
// diff needs call N-1's flat blocks, so every call must be assembled. But only the calls the browser
// is actually about to render need to KEEP their blocks. When a window is supplied, an out-of-window
// call is assembled, used as the next call's baseline, and then has its blocks dropped — so peak cost
// is two flats plus N cheap metas instead of N flats. That is what lets a 578-call session be
// assembled whole (all 578 bars on the timeline, correct diffs) without the assembled view growing
// past what can be serialized. Omitted → keep everything (unchanged full-send behaviour).
//
// ONE SESSION, SEVERAL WIRES (D37 ①: the wire format is per call — an auxiliary model, a provider template
// or a per-model protocol choice can mix them). Each record goes to the assembler of its own wire; when more
// than one wire is present the calls carry the session's GLOBAL step index (one sort, analyze()'s order),
// lanes of the same id merge, and `steps[gi]` is the call with that gi (the browser rehydrates by it).
// Records no dissector claims are counted in `analyzed.unknown` and never rendered (3.1:58).
export function assembleSession(records, opts = {}) {
  const recs = records || [];
  const groups = new Map(); // dissector object | 'analyzed' → records
  const unknown = [];
  for (const r of recs) {
    const d = boardDissectorFor(r);
    const key = d || (wireFormatOf(r) === 'anthropic' ? 'analyzed' : null);
    if (!key) { if (r && r.is_llm_call) unknown.push(r); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  if (!groups.size) return assembleUnknown(unknown.length ? unknown : recs); // labelled, never faked
  let sub = opts;
  if (groups.size > 1) {
    const order = [...groups.values()].flat().filter((r) => r && r.is_llm_call).sort(stepOrder);
    const giByRec = new Map(order.map((r, i) => [r, i])); // by record identity: ids repeat across files
    sub = { ...opts, giOf: (r) => giByRec.get(r) };
  }
  const views = [...groups].map(([k, rs]) => (k === 'analyzed' ? assembleAnalyzed(rs, sub) : assembleFlatLane(rs, k, sub)));
  const A = views.length === 1 ? views[0] : mergeViews(views);
  if (unknown.length) A.unknown = unknownSummary(unknown, true);
  return A;
}

// Several wires in one session: steps re-sorted by the global gi, lanes of the same id merged.
function mergeViews(views) {
  const steps = views.flatMap((v) => v.steps || []).sort((a, b) => a.gi - b.gi);
  const by = new Map();
  for (const l of views.flatMap((v) => v.lanes || [])) {
    const cur = by.get(l.id);
    if (!cur) { by.set(l.id, { ...l, calls: [...l.calls], events: [...(l.events || [])], resources: [...(l.resources || [])] }); continue; }
    cur.calls = [...cur.calls, ...l.calls].sort((a, b) => a.gi - b.gi);
    cur.events.push(...(l.events || []));
    cur.resources.push(...(l.resources || []));
    cur.peakCtx = Math.max(cur.peakCtx || 1, l.peakCtx || 1);
  }
  const lanes = [...by.values()].map((l) => ({ ...l, giLocal: new Map(l.calls.map((c, i) => [c.gi, i])) }));
  const sum = (k) => views.reduce((a, v) => a + (((v.stats || {})[k]) || 0), 0);
  const streams = views.flatMap((v) => v.streams || []);
  return { provider: 'mixed', providers: views.map((v) => v.provider), streams, steps, lanes,
    stats: { calls: steps.length, streams: streams.length, subagents: sum('subagents'), monitors: sum('monitors'),
      compactions: sum('compactions'), totalIn: sum('totalIn'), totalOut: sum('totalOut'),
      peakCtx: Math.max(0, ...views.map((v) => (v.stats || {}).peakCtx || 0)) } };
}

// The multi-lane path (the Anthropic wire): analyze() segments lanes, then each call is baked.
function assembleAnalyzed(records, opts = {}) {
  // Dissect each record to the shape the board's block extractor reads (v0 in-place; D10 req_body→request).
  // A global step index (mixed session) is looked up on the original record, not the hydrated copy.
  const hydrated = records.map(hydrateForBoard);
  const giOfHydrated = opts.giOf ? new Map(hydrated.map((h, i) => [h, opts.giOf(records[i])])) : null;
  const A = analyze(hydrated, giOfHydrated ? { giOf: (h) => giOfHydrated.get(h) } : {});
  for (const lane of A.lanes || []) {
    let prevFlat = null;
    for (const call of lane.calls || []) {
      if (!call.rec || !call.rec.request) { call.flat = []; call.cacheBreak = null; call.gt = null; call.wire = null; continue; }
      call.wire = wireOf(call.rec, 'anthropic'); // cheap meta: rides on out-of-window calls too
      const flat = linearContext(call.rec.request);
      // Tag per-block faithfulness SERVER-SIDE (reads provider block shape here, not in the browser →
      // invariant 3). opaque = encrypted/redacted reasoning replayed as signature-only, no plaintext on
      // the wire (thinking/redacted_thinking with a signature but empty text). The board renders a badge
      // off b.faithfulness so nobody mistakes ciphertext for verbatim content (invariant 4). (1.4:52)
      for (const b of flat) {
        const bl = b.block || {};
        if ((b.kind === 'thinking' || b.kind === 'redacted_thinking') && bl.signature && !(bl.thinking || bl.text)) b.faithfulness = 'opaque';
      }
      call.flat = flat;
      call.norm = call.norm || normResp(call.rec);
      const u = call.norm.usage || {};
      // Bake NEUTRAL canonical usage (D18a Q1 / D24): the board frontend reads call.usage.{read,
      // create,fresh,out} — ZERO provider-native usage field names in the browser. Provider→canonical
      // mapping happens HERE (server-side normResp), so adding a harness never touches the frontend (AC-3).
      // Names track the 3.2 usage columns (cache_read / cache_write / input_uncached / output).
      call.usage = {
        read: u.cache_read_input_tokens || 0,
        create: u.cache_creation_input_tokens || 0,
        fresh: u.input_tokens || 0,
        out: u.output_tokens || 0,
      };
      // cacheBreak with prevFlat=null on the first call — matches the demo render's own call site.
      const brk = cacheBreak(prevFlat, flat, { compaction: !!call.compaction });
      // D17④: REAL prefix SHA-256 over verbatim bytes (not the demo's 32-bit structural proxy). Two calls'
      // prefixes are byte-identical iff their full SHA-256 over [0,idx) match → independent byte truth.
      const read = u.cache_read_input_tokens || 0, create = u.cache_creation_input_tokens || 0;
      const curPfx = prefixSha256(flat, brk.idx);
      const prevPfx = prefixSha256(prevFlat, brk.idx);
      const prefixByteIdentical = brk.idx > 0 && curPfx != null && curPfx === prevPfx;
      brk.prefixSha256 = curPfx;                       // 逐字字节事实(可独立复算)
      brk.prefixByteIdentical = prefixByteIdentical;
      brk.gt = realGroundTruth(prefixByteIdentical, read, create); // byte-truth-backed, not structural proxy
      brk.gtReal = true;                               // marker MAY drop the "结构估计" caveat for the gt claim
      call.cacheBreak = brk;
      call.gt = brk.gt;
      call.prefixSha256 = curPfx;
      // Advance the cache-prefix baseline ONLY for calls that actually established one. A call that
      // 4xx'd/5xx'd never got far enough for the provider to write a KV-cache prefix, so chaining
      // through it makes the NEXT successful call diff against context that was never cached — the
      // board then reports a cache break that did not happen, with a cause and a fix hint. analyze()
      // marks this as `chainsPrefix`; undefined (older shapes) means "assume it chained".
      if (call.chainsPrefix !== false) prevFlat = flat;
      // COMPOSITION IS TIER A — computed HERE, while the blocks are still in hand, because the very
      // next line throws them away for out-of-window calls. Nine integers, 125 bytes: it rides on
      // every call whether or not its body does, so the timeline draws the WHOLE session rather than
      // hatching everything outside the current page as "composition unknown".
      call.comp = compBuckets(flat);
      // Blocks kept only inside the retention window; `prevFlat` above still holds the real array, so
      // the NEXT call's diff is computed against the true baseline, not against an emptied one.
      if (opts.keepFlat && !opts.keepFlat(call.gi)) { call.flat = []; call.nonBlockKeys = []; call.paged_out = true; continue; }
      // SHIP METADATA + A LOCATOR, NEVER THE BODY (RFC 4.2:55 「看全文=回源」 · 1.4:35 「点开惰性填正文」).
      // Everything above this line needed the real text — the diff chain, the prefix sha-256, the
      // byte weights — and all of it has now been computed. What leaves the process is the collapsed
      // row plus a text_ref, and the body is fetched from the raw capture when a row is opened.
      call.flat = withRefs(flat, call.rec);
      call.nonBlockKeys = nonBlockKeysOf(call.rec, 'anthropic');
      call.rec = slimRec(call.rec);
    }
  }
  A.provider = 'cc';
  return A;
}
