// src/view/assemble.mjs — server-side view assembler (D18a Option-2). Runs the demo's
// analyze pipeline SERVER-SIDE over ONE session's raw records and BAKES per-call flat +
// cacheBreak + groundTruth, so the reused demo render code reads PRE-COMPUTED fields instead
// of calling analyze functions in the browser. Result: the demo's exact look, with ZERO
// provider parsing in the browser → invariant 3 / AC-3 intact (adding a provider = a new
// server-side analyzer, frontend unchanged).
import { createHash } from 'node:crypto';
import { createAnalyzer, admitted, stepOrder, cacheBreak, normResp, flatBlockText, unparsedErrMsg, compactionMeta } from './analyze.mjs';
import { compactionVerdict } from '../identity/session-identity.mjs';
import { reqIncompleteOf, wsIncompleteOf, respIncompleteOf } from '../dissect/capture-labels.mjs'; // #21 request-body labels, D38 WebSocket labels, response labels
import { blockSpans } from '../dissect/cc-spans.mjs';
import { scanJson, spanAt } from '../dissect/json-scan.mjs';
import { slimBlock, compBuckets, firstHuman, HEAD, tellApart } from './blockmeta.mjs';
import { mintRawRef, composeTextRef } from '../raw/refs.mjs';
import { fieldTextOf, TEXT_REF_FIELD, respOf } from '../dissect/record-fields.mjs';
import { realGroundTruth, unknownSummary, FLAT_LANES } from './reduce.mjs';
import { hydrateForBoard, anthropicFlat, flatRequest, spanBody, rawRefOf, wireOf, respRefsOf, extraMessagesOf, unknownFacts, slimRec, nonBlockKeysOf } from './extract.mjs';
import { hintsOf } from '../dissect/harnesses.mjs';
import { wireFormatOf, boardDissectorFor, flatLaneOf, MULTI_LANE_CONTEXT } from '../dissect/registry.mjs';
import { scannedRequestBody } from '../dissect/request-body.mjs';
import { mapUsage, boardUsage } from '../model/schema.mjs';

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



// ── wire dispatch (D25 · one dissector per WIRE FORMAT, D37 ①) ──────────────────────────────────
// Which dissector reads a record is the shared registry's answer (src/dissect/registry.mjs): the flat-lane
// wires have a board dissector object there; the Anthropic wire is assembled by the multi-lane analyzer
// (src/view/analyze.mjs). This module names no wire and imports no wire dissector.

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
// The fold of one flat-lane wire (`d` = its dissector object): push(rec, gi) one call at a time in step order → the call
// with the call in its META form (no blocks, `paged_out`); bodyOf() gives an in-window call its blocks back from its record.
function flatLaneFold(d) {
  const plans = d.prepare ? d.prepare() : null; // a wire whose context spans records (D37 ②) plans it as the calls arrive
  // A lane of the fold is one agent's calls (3.5 §缓存): a subagent named by the harness's agent id, or by the wire's own (a
  // WebSocket connection), is its own; the rest by lane kind. The board shows the kinds (finish()).
  const byLane = new Map(); // lane → its calls, in step order
  // lane → the blocks and resumable prefix-hash chain (prefixChain) of the last call that established a cache prefix in that lane
  const prev = new Map();
  const prevInfoOf = new Map(); // lane → { msgCount, marker } of the last parsed call: the compaction verdict's predecessor
  const laneOfCall = new WeakMap();
  const asks = new WeakMap(); // the first call of a lane → its first prompt (4.4 §看板 v2 需要的补充 `lanes[].task`)
  const laneOf = (kind, h, r) => {
    const agent = kind === 'subagent' ? h.laneKey ?? (d.agentOf ? d.agentOf(r) : null) : null;
    return agent == null ? kind : `${kind}\n${agent}`;
  };
  function push(r) {
    const call = take(r);
    return call && inOrder(byLane.get(laneOfCall.get(call)), call);
  }
  function take(r) {
    if (!r.is_llm_call) return null;
    const ctx = plans ? plans.context(r) : null; // { req, contextState, missing, locate }
    // the dissector's own lane (a warm-up, 3.1:37) first, else the harness table's hint (3.4: e.g. a subagent
    // header) — the rule the ETL uses too (registry.flatLaneOf); labels are server-side (invariant 3)
    const laneKind = flatLaneOf(d, r);
    const h = hintsOf(r);
    const lane = laneOf(laneKind, h, r);
    const p = prev.get(lane);
    const prevFlat = p ? p.flat : null, prevChain = p ? p.chain : null;
    // a call the dissector knows ran but whose request was not stored (ctx.unrenderable says why): no context to
    // show either, but no failure — its reply and usage are real
    const unstored = ctx && ctx.unrenderable ? String(ctx.unrenderable) : null;
    // the labels read the body as stored: before flatRequest stands a parsed request (`{}` for a body that does not parse) on it
    const norm = d.normResp(r);
    const wire = wireOf(r, d.id, ctx, norm);
    const { req, unparsed } = flatRequest(d, r, ctx);
    // 3.4: a call whose context is unknown (no stored request, a body that did not parse, a partial context — the ETL's
    // context_state, a continuation with no predecessor in the capture included) has no observed message count: it
    // gets no compaction verdict and is not the lane's baseline for the next call
    const noContext = () => unparsed || !!unstored || wire.contextState === 'partial';
    const flat = d.boardFlat(req, r);
    const usage = boardUsage(mapUsage(d.id, norm.usage || {}, { vendor: wire.vendor }));
    const st = (respOf(r) || {}).status;
    const failed = unparsed || !!(d.failed && d.failed(norm, r));
    // 3.4 compaction, the ETL's verdict (compactionVerdict, the one shared rule): a harness hint (Codex
    // request_kind=compaction, a compact header), a text marker on its rising edge (Hermes), then a big drop.
    // The count is the dissector's own (the ETL's), so compaction_from / _to match DuckDB.
    const msgN = d.messageCount ? d.messageCount(req) : (req.message_count || 0);
    const comp = noContext() ? { compaction: false } : compactionMeta(compactionVerdict(prevInfoOf.get(lane) || null,
      { hint: h.compaction === true, marker: h.compactionMarker === true, msgCount: msgN }));
    if (!noContext()) prevInfoOf.set(lane, { msgCount: msgN, marker: h.compactionMarker === true });
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
      gi: null, id: r.id, streamId: laneKind, rec: slimRec(r), norm: { usage: norm.usage }, wireFormat: d.id,
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
    placed(call, r, self);
    laneOfCall.set(call, lane);
    if (!byLane.has(lane)) { byLane.set(lane, []); asks.set(call, firstHuman(flat)); } // a lane's first call: its first prompt, the task tellApart says
    byLane.get(lane).push(call);
    // A call that failed never established a cache prefix, so it MUST NOT become the next baseline. A call whose request
    // was not stored does (with no blocks, as in the ETL): the next call then has no known prefix to compare with.
    if (!(r.error || failed || (st != null && st !== 200))) prev.set(lane, { flat, chain });
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
  const all = () => [...byLane.values()].flat();
  const finish = () => flatLaneView(d, all(), (c) => asks.get(c));
  const self = { push, bodyOf, finish, calls: all };
  return self;
}

// The document of a flat-lane wire's calls (`calls`, each with its global gi): one lane per kind, named by the kind (several agents'
// lanes of one kind shown as one), its compaction events, the stats. `askOf(call)` → the first prompt of the lane that call opens.
export function flatLaneView(d, all, askOf) {
  const calls = all.slice().sort((a, b) => a.gi - b.gi);
  const kinds = Object.keys(FLAT_LANES).filter((k) => calls.some((c) => c.streamId === k));
  const lanes = kinds.map((k) => {
    const lc = calls.filter((c) => c.streamId === k);
    // the compaction events the board's outline lists, carrying the step's inference marker with them (invariant 4)
    const events = lc.filter((c) => c.compaction).map((c) => ({ type: 'compaction', step: c.gi, streamId: k, from: c.evictedFrom, to: c.evictedTo,
      inferred: c.compactionInferred, confidence: c.compactionConfidence, basis: c.compactionBasis }));
    return { id: k, streamId: k, ...FLAT_LANES[k], task: null, [HEAD]: askOf(lc[0]) ?? null, calls: lc, events, resources: [], seenFiles: [],
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
  return { provider: d.provider, streams: lanes.map((l) => ({ id: l.id, kind: l.kind, calls: l.calls })), steps: calls, stats, lanes };
}

// records = ONE session's raw (v0/demo-shape) records. Returns analyze() output with each
// call augmented: .flat (linearContext), .cacheBreak (vs prev in lane), .gt (groundTruth).




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
  const base = spanBody(rec) != null ? rawRefOf(rec) : null;
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
  const root = scannedRequestBody(rec);
  const base = spanBody(rec) != null ? rawRefOf(rec) : null;
  return flat.map((b) => {
    const span = base && root && Array.isArray(b.path) ? spanAt(root, b.path) : null;
    return slimBlock(b, span ? composeTextRef(base, span) : null);
  });
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
      let root = null;
      if (field === 'req_body') root = scannedRequestBody(rec);
      else { const t = fieldTextOf(rec, field).text ?? null; try { root = t != null ? scanJson(t) : null; } catch { root = null; } }
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
