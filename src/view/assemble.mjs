// src/view/assemble.mjs — server-side view assembler (D18a Option-2). Runs the demo's
// analyze pipeline SERVER-SIDE over ONE session's raw records and BAKES per-call flat +
// cacheBreak + groundTruth, so the reused demo render code reads PRE-COMPUTED fields instead
// of calling analyze functions in the browser. Result: the demo's exact look, with ZERO
// provider parsing in the browser → invariant 3 / AC-3 intact (adding a provider = a new
// server-side analyzer, frontend unchanged).
import { createHash } from 'node:crypto';
import { createAnalyzer, admitted, stepOrder, linearContext, cacheBreak, normResp, flatBlockText, unparsedErrMsg, compactionMeta } from './analyze.mjs';
import { compactionVerdict } from '../identity/session-identity.mjs';
import { reqIncompleteOf, wsIncompleteOf, respIncompleteOf, captureLabelsOf } from '../dissect/capture-labels.mjs'; // #21 request-body labels, D38 WebSocket labels, response labels; captureLabelsOf: the per-call wire.labels (4.6 §记录)
import { blockSpans } from '../adapters/cc.mjs';
import { scanJson, spanAt } from '../dissect/json-scan.mjs';
import { slimBlock, compBuckets } from './blockmeta.mjs';
import { mintRawRef, composeTextRef } from '../raw/refs.mjs';
import { fieldTextOf, TEXT_REF_FIELD } from '../dissect/record-fields.mjs';
import { sessionKeyOf, observerEffectsOf, hintsOf } from '../dissect/harnesses.mjs';
import { wireFormatOf, boardDissectorFor, contextStateOf, blockKeysOf, flatLaneOf, MULTI_LANE_CONTEXT } from '../dissect/registry.mjs';
import { parsedRequestBody } from '../dissect/request-body.mjs';
import { vendorOf } from '../dissect/vendors.mjs';
import { cacheSemanticsKnown } from '../cache/cache-events.mjs';
import { requestEncodingOf } from '../dissect/request-body.mjs';

// D17④ 地面真相(RFC 3.3:65 · 独立字节护城河). The demo proxied prefix identity with the 32-bit
// bounded content_hash SEQUENCE (collision-prone). Product MUST use a REAL full SHA-256 over the
// VERBATIM prefix bytes (skipping volatile) — so a 32-bit-key collision hiding a real byte difference
// makes the prefixes hash-UNequal → no false ground-truth flag. Computed SERVER-SIDE (不变式 3).
//
// KEPT AS A RESUMABLE CHAIN, not re-hashed per call. The first version hashed a call's whole prefix
// text from scratch, twice per call (this call's prefix and the previous call's over the same range).
// An agent context grows ~7 KB a turn to ~0.8 MB, so that is O(session bytes²): a 115-call session
// hashed ~90 MB and spent 351 of its 669 ms inside crypto — every time the session was opened, and
// again for every page of it.
//
// Two consecutive calls share their prefix VERBATIM up to the first block whose frame differs, so this
// call resumes the running hash from that block (`Hash.copy()`) and the previous call's digest is read
// off the snapshot the chain already holds. The frames, their order and the length-prefixed framing are
// UNCHANGED, so every digest is byte-identical to the from-scratch one — the tests assert the hex.
//
// `prev` = the chain of the call that established the current cache baseline (never the immediately
// preceding call when that one failed); passing null, or a chain that diverges at block 0, is always
// correct, only slower.
function prefixChain(flat, prev) {
  // one frame per block; null = a volatile block (the billing nonce), which the digest skips
  const texts = (flat || []).map((b) => (b && b.volatile ? null : flatBlockText(b)));
  const n = texts.length;
  let d = 0; // first block whose frame differs from the previous call's — everything before it is shared
  if (prev) { const m = Math.min(n, prev.texts.length); while (d < m && prev.texts[d] === texts[d]) d++; }
  const states = new Array(n + 1); // states[i] = the hash of frames [0,i); never updated in place
  for (let i = 0; i <= d; i++) states[i] = prev ? prev.states[i] : createHash('sha256');
  let h = states[d].copy();
  for (let i = d; i < n; i++) {
    const t = texts[i];
    // length-prefixed frames = unambiguous block boundaries with NO delimiter byte (ASCII-only source).
    if (t != null) h.update(String(t.length) + ':' + t);
    states[i + 1] = h.copy();
  }
  // idx <= 0 → no reusable prefix, as before
  return { texts, states, digestAt: (idx) => (idx > 0 && idx <= n ? states[idx].copy().digest('hex') : null) };
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
// A context the dissector stitched across records (ctx, D37 ②) stands in for the call's own body, and rides on the
// copy as the non-enumerable `_ctx` (state, lineage) for the lane segmentation in analyze().
function hydrateForBoard(r, ctx = null) {
  if (!r || r.request !== undefined || typeof r.req_body !== 'string') return r; // already v0 / not a D10 body
  const body = ctx ? ctx.req : parsedRequestBody(r); // parsed once per record (src/dissect/request-body.mjs)
  if (!body || typeof body !== 'object') return r; // unparseable → leave (analyze filters it)
  const system = Array.isArray(body.system) ? body.system
    : (typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : []);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const request = {
    ...body, system, messages, tools,
    // derived counts the v0 capture used to bake (the raw wire body doesn't carry them)
    message_count: messages.length,
    tool_count: MULTI_LANE_CONTEXT.toolCountOf({ tools, messages }),
    system_chars: system.reduce((a, b) => a + String((b && b.text) || '').length, 0),
    context_chars: r.req_body.length,
  };
  // Carry the source-stream stamp across the copy. `{...r}` takes only ENUMERABLE properties, and
  // `_stream` is deliberately non-enumerable (so it never appears in stored or shipped JSON) — which
  // means a spread silently drops it, and every block downstream loses the half of its text_ref that
  // says WHICH capture file its bytes are in. Silent, because the result is simply a missing locator.
  const out = { ...r, request, response: r.response || r.resp || {} };
  if (r._stream) Object.defineProperty(out, '_stream', { value: r._stream, enumerable: false, configurable: true });
  if (ctx) Object.defineProperty(out, '_ctx', { value: ctx, enumerable: false, configurable: true });
  // The body parsed, and we hold the result: say so, so the label side (capture-labels.bodyUnparsedOf,
  // reached through contextStateOf below) does not JSON.parse the same 0.8 MB a second time. Same
  // non-enumerable discipline as `_stream`: never stored, never shipped.
  Object.defineProperty(out, '_reqParsed', { value: true, enumerable: false, configurable: true });
  return out;
}

// headersOf tolerates BOTH the demo v0 `request_headers` and the product D10 `req_headers` envelope key.
export const headersOf = (rec) => (rec && (rec.request_headers || rec.req_headers)) || {};
// Envelope drift guard (R1). The product D10 envelope stores the response under
// `resp` (src/capture/envelope.mjs); demo v0 used `response`. Readers MUST go through this helper —
// reading `.response` directly is what silently killed the probe rail, every HTTP status and the
// whole control-plane view on real captures (`.response` was present on 0 of 25,817 live records)
// while the pre-D10 test fixture kept them green. Mirrors headersOf: tolerate BOTH shapes forever,
// because old captures on disk are still the user's data (invariant 2).
export const respOf = (rec) => (rec && (rec.resp || rec.response)) || null;
// Session key per harness (RFC 3.4 table, D37): read from the ONE table the ETL and sharder also use; else the
// synthesized key board.groupSessions stamped on a keyless Hermes / Kimi call (3.4 合成键, gate G11).
export function sessionIdOf(rec) {
  return sessionKeyOf(rec).key ?? (rec && rec._synthKey) ?? null;
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
// What the evidence block keeps of one such record (the fold lets the record go): endpoint, user-agent, model.
function unknownFacts(r) {
  let b = r && r.request && typeof r.request === 'object' ? r.request : null;
  if (!b && r && typeof r.req_body === 'string') { try { b = JSON.parse(r.req_body); } catch { b = null; } }
  return { endpoint: String((r && r.endpoint) || '').split('?')[0], ua: (headersOf(r) || {})['user-agent'], model: b && typeof b.model === 'string' ? b.model : null };
}
function unknownSummary(recs, partial) {
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const models = uniq(recs.map((r) => r.model));
  return {
    partial,
    reason: partial
      ? 'Some records in this session are read as a call by no registered dissector (src/dissect/registry.mjs): '
        + 'an unknown wire, or a record of a known wire that is no call (e.g. a message the server pushed with no '
        + 'call open). They are counted here and NOT rendered; the rest of the session is.'
      : 'No registered dissector reads these records as a call (src/dissect/registry.mjs): an unknown wire, or '
        + 'records of a known wire that are no call (e.g. messages the server pushed with no call open). They are NOT '
        + 'parsed and NOT rendered — showing them under another wire\'s vocabulary would be a fabrication.',
    records: recs.length,
    endpoints: uniq(recs.map((r) => r.endpoint)),
    userAgents: uniq(recs.map((r) => r.ua)),
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
  probe: { kind: 'probe', icon: '👁', label: 'warm-up / probe requests',
    note: 'A request the harness itself marks as a warm-up or probe (a request-kind hint, or a request that asks for no output): it primes the cache and is not a conversation turn. Its body is kept verbatim like any call, and a later call may build on it.' },
};
// A flat-lane wire's request as its dissector reads it: the stitched context (ctx), else the body parsed, else the demo v0
// shape. `unparsed`: a body that is there but does not parse is unrenderable, with its reason (R4-3). A req_body that is
// null (a WebSocket call whose request message is undecoded, or a server push: 4.6 §传输) is no body at all: such a call
// has no request, and its labels say why (wsIncomplete); it must not take /api/session down either.
// Side effect, as the board's callComp / cost need it: `r.request` is the parsed request, with the dissector's counts.
function flatRequest(d, r, ctx) {
  let req = ctx ? ctx.req : null, unparsed = false;
  if (!ctx) {
    try { req = JSON.parse(r.req_body); } catch { req = null; }
    if (!req || typeof req !== 'object') {
      if (r.request && typeof r.request === 'object') req = r.request; // demo v0 shape
      else { req = {}; if (r.req_body != null) unparsed = true; }
    }
  }
  r.request = req;
  Object.assign(req, d.reqCounts(req)); // derived counts the board header + raw card read (parallel to hydrateForBoard)
  req.context_chars = (r.req_body || '').length; // verbatim wire byte count
  return { req, unparsed };
}
// The fold of one flat-lane wire (`d` = its dissector object): push(rec, gi) one call at a time in step order → the call
// with the call in its META form (no blocks, `paged_out`); bodyOf() gives an in-window call its blocks back from its record.
function flatLaneFold(d, read) {
  const plans = d.prepare ? d.prepare(read) : null; // a wire whose context spans records (D37 ②) plans it as the calls arrive
  const calls = [];
  const prevFlatOf = new Map(); // lane kind → the last call that established a cache prefix in that lane
  const prevChainOf = new Map(); // and its resumable prefix-hash chain (prefixChain)
  const prevInfoOf = new Map(); // lane kind → { msgCount, marker } of the last parsed call: the compaction verdict's predecessor
  function push(r, gi) {
    if (!r.is_llm_call) return null;
    const ctx = plans ? plans.context(r) : null; // { req, contextState, missing, locate }
    // the dissector's own lane (a warm-up, 3.1:37) first, else the harness table's hint (3.4: e.g. a subagent
    // header) — the rule the ETL uses too (registry.flatLaneOf); labels are server-side (invariant 3)
    const laneKind = flatLaneOf(d, r);
    const prevFlat = prevFlatOf.get(laneKind) || null;
    const prevChain = prevChainOf.get(laneKind) || null; // set together with prevFlat: both or neither
    // a call the dissector knows ran but whose request was not stored (ctx.unrenderable says why): no context to
    // show either, but no failure — its reply and usage are real
    const unstored = ctx && ctx.unrenderable ? String(ctx.unrenderable) : null;
    const { req, unparsed } = flatRequest(d, r, ctx);
    // 3.4: a call whose context is unknown (no stored request, a body that did not parse, a partial context — the ETL's
    // context_state, a continuation with no predecessor in the capture included) has no observed message count: it
    // gets no compaction verdict and is not the lane's baseline for the next call
    const noContext = () => unparsed || !!unstored || wire.contextState === 'partial';
    const flat = d.boardFlat(req, r);
    const norm = d.normResp(r);
    const usage = norm.canonUsage;
    const st = (respOf(r) || {}).status;
    const failed = unparsed || !!(d.failed && d.failed(norm, r));
    const wire = wireOf(r, d.id, ctx, norm);
    // 3.4 compaction, the ETL's verdict (compactionVerdict, the one shared rule): a harness hint (Codex
    // request_kind=compaction, a compact header), a text marker on its rising edge (Hermes), then a big drop.
    // The count is the dissector's own (the ETL's), so compaction_from / _to match DuckDB.
    const h = hintsOf(r);
    const msgN = d.messageCount ? d.messageCount(req) : (req.message_count || 0);
    const comp = noContext() ? { compaction: false } : compactionMeta(compactionVerdict(prevInfoOf.get(laneKind) || null,
      { hint: h.compaction === true, marker: h.compactionMarker === true, msgCount: msgN }));
    if (!noContext()) prevInfoOf.set(laneKind, { msgCount: msgN, marker: h.compactionMarker === true });
    const brk = cacheBreak(prevFlat, flat, { compaction: comp.compaction });
    // 3.2:124 on the board too: what is shown of a partial / server-edited context is not what the model saw,
    // so no byte-identity claim and no ground truth is made over it
    const blind = wire.contextState === 'partial' || wire.contextState === 'server_edited';
    const chain = prefixChain(flat, prevChain);
    const curPfx = blind ? null : chain.digestAt(brk.idx);
    const prevPfx = prevChain ? prevChain.digestAt(brk.idx) : null;
    const prefixByteIdentical = brk.idx > 0 && curPfx != null && curPfx === prevPfx;
    brk.prefixSha256 = curPfx;
    brk.prefixByteIdentical = prefixByteIdentical;
    brk.gt = realGroundTruth(prefixByteIdentical, usage.read, usage.create);
    brk.gtReal = true;
    const call = {
      gi, id: r.id, streamId: laneKind, rec: slimRec(r), norm: { usage: norm.usage }, wireFormat: d.id,
      ctx: d.ctxTokens(norm),
      msgCount: req.message_count || 0,
      tools: Array.isArray(req.tools) ? req.tools.length : 0,
      ts: r.ts_request || r.ts || '', status: (r.resp && r.resp.status) || null,
      ...comp, error: !!r.error || failed, reqIncomplete: reqIncompleteOf(r), wsIncomplete: wsIncompleteOf(r), respIncomplete: respIncompleteOf(r),
      // the same sentinel the multi-lane path makes of a body that did not parse: the page shows why, not an empty window
      ...(unparsed ? { unparsed: true, errMsg: unparsedErrMsg(reqIncompleteOf(r)) } : unstored ? { unparsed: true, errMsg: `unrenderable: ${unstored}` } : null),
      // blocks ride only on a call a page ships with its body (bodyOf); a call in its meta form says so (invariant 4)
      wire, nonBlockKeys: [], ...extraMessagesOf(r), respRefs: respRefsOf(r), flat: [], paged_out: true,
      // Tier A, same as the multi-lane path: computed from `flat` before it is let go.
      comp: compBuckets(flat),
      usage, cacheBreak: brk, gt: brk.gt, prefixSha256: curPfx,
    };
    calls.push(call);
    // A call that failed never established a cache prefix, so it MUST NOT become the next baseline. A call whose request
    // was not stored does (with no blocks, as in the ETL): the next call then has no known prefix to compare with.
    if (!(r.error || failed || (st != null && st !== 200))) { prevFlatOf.set(laneKind, flat); prevChainOf.set(laneKind, chain); }
    return call;
  }
  // shipped as metadata + a text_ref per block, never the body (4.2:55); a cross-record context locates each block in the
  // record and field its bytes came from
  function bodyOf(call, r) {
    const ctx = plans ? plans.context(r) : null;
    const { req } = flatRequest(d, r, ctx);
    const flat = d.boardFlat(req, r);
    return { rec: slimRec(r), norm: d.normResp(r), nonBlockKeys: nonBlockKeysOf(r, d.id), flat: ctx ? withLocatedRefs(flat, ctx.locate, new Map()) : withPathRefs(flat, r) };
  }
  function finish() {
    const kinds = Object.keys(FLAT_LANES).filter((k) => calls.some((c) => c.streamId === k));
    const lanes = kinds.map((k) => {
      const lc = calls.filter((c) => c.streamId === k);
      // the compaction events the board's outline lists, carrying the step's inference marker with them (invariant 4)
      const events = lc.filter((c) => c.compaction).map((c) => ({ type: 'compaction', step: c.gi, streamId: k, from: c.evictedFrom, to: c.evictedTo,
        inferred: c.compactionInferred, confidence: c.compactionConfidence, basis: c.compactionBasis }));
      return { id: k, streamId: k, ...FLAT_LANES[k], calls: lc, events, resources: [], seenFiles: [],
        giLocal: new Map(lc.map((c, i) => [c.gi, i])), peakCtx: lc.reduce((m, c) => Math.max(m, c.ctx), 1),
        spawnStep: null, parent: null, flagged: 0 };
    });
    const stats = {
      calls: calls.length, streams: lanes.length, subagents: lanes.filter((l) => l.kind === 'subagent').length, monitors: 0,
      compactions: calls.filter((c) => c.compaction).length,
      totalIn: calls.reduce((a, c) => a + ((c.norm.usage || {}).input_tokens || 0), 0),
      totalOut: calls.reduce((a, c) => a + ((c.norm.usage || {}).output_tokens || 0), 0),
      peakCtx: calls.reduce((a, c) => Math.max(a, c.ctx), 0),
    };
    return { provider: d.provider, streams: lanes.map((l) => ({ id: l.id, kind: l.kind, calls: l.calls })), steps: [...calls], stats, lanes };
  }
  return { push, bodyOf, finish };
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

// A record's raw_ref (4.2:40), or null when it cannot be addressed: no id, or no stream it was read from.
const rawRefOf = (rec) => (rec && rec.id != null && rec._stream ? mintRawRef(sessionIdOf(rec), rec._stream, String(rec.id)) : null);

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
  const base = rawRefOf(rec);
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
  const base = rawRefOf(rec);
  return flat.map((b) => {
    const span = base && root && Array.isArray(b.path) ? spanAt(root, b.path) : null;
    return slimBlock(b, span ? composeTextRef(base, span) : null);
  });
}

// Canonical wire facts per call (3.2:131-133), baked HERE so the page only reads them (invariant 3):
// format, vendor, whether that vendor's cache semantics are known on this wire (3.3:89: the DB's rule — false for
// an unknown host, for a vendor with no cache row, and for DeepSeek over the Anthropic wire), transport, context
// state, observer effects and the
// incompleteness labels (4.6 §记录 「不完整的标注」 — shown on the call, never dropped). Cheap: no body parse.
// A cross-record context (ctx, from the dissector) brings its own state and, when partial, what is missing;
// `norm.unread` counts reply messages the dissector could not read (D38: never skipped without a trace).
function wireOf(rec, format, ctx = null, norm = null) {
  const labels = captureLabelsOf(rec);
  const unread = norm && norm.unread;
  if (unread) labels.push({ id: 'reply-unread', label: `回复部分未读 · ${unread} reply message${unread > 1 ? 's' : ''} not read`,
    text: `${unread} server message${unread > 1 ? 's' : ''} of this call are not JSON text (binary, past the size cap, or not decodable); the reply shown is read from the others` });
  // a request sent compressed and shown decompressed says so (4.6 §记录, invariant 4): exact text, not the wire bytes
  const enc = rec && typeof rec.req_body === 'string' ? requestEncodingOf(rec) : null;
  const vendor = vendorOf(rec);
  return { format, vendor, cacheSemanticsKnown: cacheSemanticsKnown(vendor, format), transport: rec && rec.transport === 'ws' ? 'ws' : 'http',
    contextState: ctx && ctx.contextState ? ctx.contextState : contextStateOf(rec), ...(ctx && ctx.contextState === 'partial' && ctx.missing ? { contextMissing: ctx.missing } : {}),
    observerEffect: observerEffectsOf(rec), labels, ...(enc ? { reqEncoding: enc } : {}) };
}
// 3.1:37: client messages that arrived while the call was open (req_extra_messages, e.g. an interrupt) belong to
// the call and MUST be visible — listed one by one with a locator to their verbatim text (4.2:40 字段段), or with
// what is stored instead. Cheap meta: no parse.
function extraMessagesOf(rec) {
  const xs = rec && Array.isArray(rec.req_extra_messages) ? rec.req_extra_messages : [];
  if (!xs.length) return null;
  const base = rawRefOf(rec);
  return { extraMessages: xs.map((v, k) => {
    const field = `req_extra_messages.${k}`;
    if (typeof v === 'string') return { key: `req_extra_messages[${k}]`, chars: v.length, ref: base ? composeTextRef(base, [0, v.length], field) : null };
    return { key: `req_extra_messages[${k}]`, chars: null, ref: null, note: `stored ${fieldTextOf(rec, field).missing.replace(/^stores \S+ as /, 'as ')}` };
  }) };
}
// Locators for a context assembled across records: each block's bytes live in the record and field its segment came from
// (D37 ②), addressed by a field-qualified text_ref (4.2:40). A locator is either { rec, field, path } — the record in hand, its
// field scanned here (`scans` caches each (record, field) once) — or { src, field, node, sub } — a segment of an earlier record
// that the dissector keeps by locator (src/dissect/chain.mjs): its source's id and stream, and the scan of its item. A block that
// cannot be addressed is shipped inline and labelled unaddressable by slimBlock with the reason it could not be (invariant 4) —
// a field outside the 4.2:40 grammar included, so a dissector's mistake labels one block instead of failing the whole session.
// Exported for its own test.
export function withLocatedRefs(flat, locateFn, scans = new Map()) {
  const rootOf = (rec, field) => {
    let m = scans.get(rec);
    if (!m) scans.set(rec, (m = new Map()));
    if (!m.has(field)) {
      const t = field === 'req_body' ? (typeof rec.req_body === 'string' ? rec.req_body : null) : (fieldTextOf(rec, field).text ?? null);
      let root = null;
      try { root = t != null ? scanJson(t) : null; } catch { root = null; }
      m.set(field, root);
    }
    return m.get(field);
  };
  return flat.map((b) => {
    const loc = locateFn(b);
    const at = loc && (loc.rec || loc.src);
    if (!at) return slimBlock(b, null, 'the dissector placed this block in no source record');
    if (loc.why) return slimBlock(b, null, String(loc.why)); // e.g. a reply rebuilt from a stream: no single byte span
    const base = loc.rec ? rawRefOf(loc.rec) : (at.id != null && at.stream ? mintRawRef(at.sid, at.stream, String(at.id)) : null);
    const of = `record ${at.id ?? '(no id)'}`;
    if (!base) return slimBlock(b, null, `its source ${of} carries no id or stream to address`);
    if (loc.field !== 'req_body' && !TEXT_REF_FIELD.test(String(loc.field))) return slimBlock(b, null, `field "${loc.field}" of ${of} is no text_ref field segment (4.2:40)`);
    const root = loc.rec ? rootOf(loc.rec, loc.field) : loc.node;
    if (!root) return slimBlock(b, null, `field ${loc.field} of ${of} holds no JSON text`);
    const path = loc.rec ? loc.path : loc.sub;
    const span = spanAt(root, path);
    if (!span) return slimBlock(b, null, `path ${JSON.stringify(path)} is not in field ${loc.field} of ${of}`);
    return slimBlock(b, composeTextRef(base, span, loc.field));
  });
}
// 4.6 R2 「回复 == mock 发出的 SSE 事件 / WebSocket 消息」 · gate G1: where the verbatim reply sits in the
// raw record, as field-qualified refs (4.2:40), in reply order — resp.raw for an HTTP reply (the decoded SSE / text the
// collector stored; on an error envelope, what arrived before the failure), one resp.messages.<j> per WebSocket server
// message. Joining an HTTP call's resolved pieces gives the whole decoded reply. A piece that cannot be addressed is
// listed with why (invariant 4), never dropped. Envelope fields only (record-fields.mjs): no wire knowledge.
// → [{ label, ref: string|null, chars: number|null, why? }]
function respRefsOf(rec) {
  const r = respOf(rec);
  if (!r) return [{ label: 'reply', ref: null, chars: null, why: 'no response is recorded for this call' }];
  const part = r.kind === 'error' && r.partial && typeof r.partial === 'object' ? r.partial : r;
  const cut = part !== r ? ' (what arrived before the exchange failed)' : '';
  const base = rawRefOf(rec);
  const one = (label, field) => {
    const f = fieldTextOf(rec, field);
    if (f.text == null) return { label, ref: null, chars: null, why: f.missing.replace(/^stores \S+ as /, 'stored as ') };
    return base ? { label, ref: composeTextRef(base, [0, f.text.length], field), chars: f.text.length }
      : { label, ref: null, chars: f.text.length, why: 'the record carries no id or stream to address' };
  };
  if (part.kind === 'ws' && Array.isArray(part.messages)) return part.messages.map((_, j) => one(`message ${j + 1}${cut}`, `resp.messages.${j}`));
  if (typeof part.raw === 'string') return [one((part.kind === 'sse' ? 'stream' : 'body') + cut, 'resp.raw')];
  if (part.body !== undefined) return [{ label: 'body', ref: null, chars: null, why: 'a JSON reply that re-serializes to itself, or one captured before D40, is stored parsed only, so it has no byte-verbatim text to point at (gate G16)' }];
  if (typeof part.raw_b64 === 'string') {
    return [{ label: 'body', ref: null, chars: null, why: part.encoding_error ? `could not be decoded (${part.encoding_error}); kept as base64 in the record` : 'not UTF-8 text; kept as base64 in the record' }];
  }
  if (part.kind === 'empty') return [{ label: 'body', ref: null, chars: 0, why: 'the reply had no body' }];
  return [{ label: 'reply', ref: null, chars: null, why: r.kind === 'error' ? 'no reply bytes arrived before the exchange failed' : 'no reply text is stored in this record' }];
}

// 4.6 R2 「不成块的顶层键逐个列出」: every top-level request key that is not a block section, each with a
// locator to its verbatim value (null when the record cannot be addressed).
function nonBlockKeysOf(rec, format) {
  if (!rec || typeof rec.req_body !== 'string') return [];
  let root = null;
  try { root = scanJson(rec.req_body); } catch { return []; }
  if (!root || root.kind !== 'object') return [];
  const keep = blockKeysOf(format);
  const base = rawRefOf(rec);
  const out = [];
  for (const [key, node] of root.props) if (!keep.includes(key)) out.push({ key, chars: node.end - node.start, ref: base ? composeTextRef(base, [node.start, node.end]) : null });
  return out;
}

// ONE SESSION, FOLDED (3.5 §内存有界). createAssembler() → { push(rec), finish(), bodyOf(call, rec) }: the session's records go in
// ONE AT A TIME in step order (analyze.mjs stepOrder). push() assembles the call — its lane, the cache-break and prefix chain
// against its lane's previous call, its composition, wire facts and usage — and keeps it in its META form: no blocks, `paged_out`,
// `rec` and `norm` reduced to what the timeline reads. The record's body is let go when push() returns; what the fold holds is
// the calls' meta, each lane's previous call (its blocks are the next call's baseline) and the records a cross-record context
// (D37 ②) stitches from. bodyOf() gives one call its blocks back — `flat` (metadata + a text_ref per block), `nonBlockKeys`, the
// reply (`norm`), `rec` — from its own record, with the same functions push() used, so a page can ship the calls it shows with
// their bodies without the session ever being held whole. finish() builds the `analyzed` document without changing the fold,
// so it can go on afterwards (a session that grew is folded on from where it stopped).
//
// SEVERAL WIRES (D37 ①: the wire format is per call — an auxiliary model, a provider template or a per-model protocol choice can
// mix them). Each record goes to the fold of its own wire; every call carries the session's GLOBAL step index (the push order),
// lanes of the same id merge, and `steps[gi]` is the call with that gi (the browser rehydrates by it). Records no dissector
// claims are counted in `analyzed.unknown` and never rendered (3.1:58).
export function createAssembler({ read = null } = {}) {
  const folds = new Map(); // dissector object | 'analyzed' → its fold
  const unknown = [], other = []; // the facts unknownSummary reads of records no fold takes (LLM calls / the rest)
  const src = new WeakMap(); // call → the fold that assembled it
  let gi = 0;
  return {
    push(r) {
      if (!r) return null;
      let d = boardDissectorFor(r);
      if (d && d.admits && !d.admits(r)) d = null; // a record of a known wire that is no call (e.g. a server push): counted
      const key = d || (wireFormatOf(r) === 'anthropic' ? 'analyzed' : null);
      if (!key) { (r.is_llm_call ? unknown : other).push(unknownFacts(r)); return null; }
      let f = folds.get(key);
      if (!f) folds.set(key, (f = key === 'analyzed' ? multiLaneFold(read) : flatLaneFold(key, read)));
      const call = f.push(r, gi);
      if (!call) return null;
      gi++;
      src.set(call, f);
      return call;
    },
    bodyOf(call, r) { return src.get(call).bodyOf(call, r); },
    finish() {
      if (!folds.size) return assembleUnknown(unknown.length ? unknown : other); // labelled, never faked
      const views = [...folds.values()].map((f) => f.finish());
      const A = views.length === 1 ? views[0] : mergeViews(views);
      if (unknown.length) A.unknown = unknownSummary(unknown, true);
      return A;
    },
  };
}

// The batch form: `records` (one session's, any order) folded whole. `opts.keepFlat(gi)` — RETENTION WINDOW: only the calls it
// names get their blocks back (bodyOf); the others stay in their meta form (`paged_out`). Omitted → every call keeps its body.
export function assembleSession(records, opts = {}) {
  const a = createAssembler();
  const pushed = [];
  for (const r of [...(records || [])].sort(stepOrder)) { const c = a.push(r); if (c) pushed.push([c, r]); }
  const A = a.finish();
  for (const [c, r] of pushed) if (!opts.keepFlat || opts.keepFlat(c.gi)) { Object.assign(c, a.bodyOf(c, r)); delete c.paged_out; }
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

// The blocks of an Anthropic-wire request, tagged with their faithfulness SERVER-SIDE (reads provider block shape here, not in
// the browser → invariant 3). opaque = encrypted/redacted reasoning replayed as signature-only, no plaintext on the wire
// (thinking/redacted_thinking with a signature but empty text). The board renders a badge off b.faithfulness so nobody
// mistakes ciphertext for verbatim content (invariant 4). (1.4:52)
function anthropicFlat(request, keyMemo) {
  const flat = linearContext(request, keyMemo);
  for (const b of flat) {
    const bl = b.block || {};
    if ((b.kind === 'thinking' || b.kind === 'redacted_thinking') && bl.signature && !(bl.thinking || bl.text)) b.faithfulness = 'opaque';
  }
  return flat;
}
// The multi-lane fold (the Anthropic wire): each record is dissected to the shape the board's block extractor reads (v0 in
// place; D10 req_body→request), analyze()'s fold puts it in its lane, then the call is baked against its lane's previous one.
// A call that continues a server-held thread carries only its delta: the dissector stitches its context as the calls arrive.
function multiLaneFold(read) {
  const an = createAnalyzer();
  const plans = MULTI_LANE_CONTEXT.prepare(read);
  // Block keys of one session: the same context is re-sent every turn, so the per-text hash is asked for once per call. The
  // memo is keyed by a block's first BLK_KEY_CAP chars, so it grows with the session's distinct content, not its stored bytes.
  const keyMemo = new Map();
  const prev = new Map(); // lane (stream id) → { flat, chain } of the call that established the lane's cache baseline
  function push(r, gi) {
    const ctx = MULTI_LANE_CONTEXT.contextOf(r, plans);
    const call = an.push(hydrateForBoard(r, ctx), gi);
    if (!call) return null;
    call.wire = wireOf(call.rec, 'anthropic', ctx); // cheap meta: rides on out-of-window calls too
    call.respRefs = respRefsOf(call.rec); // locators only (a few dozen bytes each), never the reply body
    const flat = anthropicFlat(call.rec.request, keyMemo);
    const u = call.norm.usage || {};
    // Bake NEUTRAL canonical usage (D18a Q1 / D24): the board frontend reads call.usage.{read,
    // create,fresh,out} — ZERO provider-native usage field names in the browser. Provider→canonical
    // mapping happens HERE (server-side normResp), so adding a harness never touches the frontend (AC-3).
    // Names track the 3.2 usage columns (cache_read / cache_write / input_uncached / output).
    call.usage = { read: u.cache_read_input_tokens || 0, create: u.cache_creation_input_tokens || 0, fresh: u.input_tokens || 0, out: u.output_tokens || 0 };
    const p = prev.get(call.streamId) || null;
    // cacheBreak with prevFlat=null on the first call — matches the demo render's own call site.
    const brk = cacheBreak(p && p.flat, flat, { compaction: !!call.compaction });
    // D17④: REAL prefix SHA-256 over verbatim bytes (not the demo's 32-bit structural proxy). Two calls'
    // prefixes are byte-identical iff their full SHA-256 over [0,idx) match → independent byte truth.
    // 3.2:124, as on the flat-lane path: what is shown of a partial / server-edited context is not what the model
    // saw, so no byte-identity claim and no ground truth is made over it (the ETL writes NULL / NULL too)
    const blind = call.wire.contextState === 'partial' || call.wire.contextState === 'server_edited';
    const chain = prefixChain(flat, p && p.chain);
    const curPfx = blind ? null : chain.digestAt(brk.idx);
    const prevPfx = p ? p.chain.digestAt(brk.idx) : null;
    const prefixByteIdentical = brk.idx > 0 && curPfx != null && curPfx === prevPfx;
    brk.prefixSha256 = curPfx;                       // 逐字字节事实(可独立复算)
    brk.prefixByteIdentical = prefixByteIdentical;
    brk.gt = realGroundTruth(prefixByteIdentical, call.usage.read, call.usage.create); // byte-truth-backed, not structural proxy
    brk.gtReal = true;                               // marker MAY drop the "结构估计" caveat for the gt claim
    call.cacheBreak = brk;
    call.gt = brk.gt;
    call.prefixSha256 = curPfx;
    // Advance the cache-prefix baseline ONLY for calls that actually established one. A call that
    // 4xx'd/5xx'd never got far enough for the provider to write a KV-cache prefix, so chaining
    // through it makes the NEXT successful call diff against context that was never cached — the
    // board then reports a cache break that did not happen, with a cause and a fix hint. analyze()
    // marks this as `chainsPrefix`; undefined (older shapes) means "assume it chained".
    if (call.chainsPrefix !== false) prev.set(call.streamId, { flat, chain });
    // COMPOSITION IS TIER A — computed HERE, while the blocks are still in hand: nine integers that ride on every call
    // whether or not its body does, so the timeline draws the WHOLE session rather than hatching everything outside the
    // current page as "composition unknown".
    call.comp = compBuckets(flat);
    // The META form: the blocks, the parsed body and the reply text are let go here (bodyOf gives them back from the record).
    // `prev` above still holds this call's real blocks, so the NEXT call's diff is against the true baseline.
    call.flat = []; call.nonBlockKeys = []; call.paged_out = true;
    call.rec = slimRec(call.rec);
    call.norm = { usage: call.norm.usage };
    return call;
  }
  // SHIP METADATA + A LOCATOR, NEVER THE BODY (RFC 4.2:55 「看全文=回源」 · 1.4:35 「点开惰性填正文」): the collapsed row plus a
  // text_ref; the body is fetched from the raw capture when a row is opened.
  function bodyOf(call, r) {
    const ctx = MULTI_LANE_CONTEXT.contextOf(r, plans);
    const h = admitted(hydrateForBoard(r, ctx));
    const flat = anthropicFlat(h.request, new Map());
    return { flat: ctx ? withLocatedRefs(flat, ctx.locate, new Map()) : withRefs(flat, h), nonBlockKeys: nonBlockKeysOf(h, 'anthropic'), rec: slimRec(h), norm: normResp(h) };
  }
  return { push, bodyOf, finish() { const A = an.finish(); A.provider = 'cc'; return A; } };
}
