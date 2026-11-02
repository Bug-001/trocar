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


// ONE SESSION, FOLDED (3.5 §内存有界). createAssembler() → { push(rec), finish(), bodyOf(call, rec) }: the session's records go in
// ONE AT A TIME. push() assembles the call — its lane, the cache-break and prefix chain against its lane's previous call, its
// composition, wire facts and usage — and keeps it in its META form: no blocks, `paged_out`, `rec` and `norm` reduced to what the
// timeline reads. The record's body is let go when push() returns; what the fold holds is the calls' meta, each lane's baseline
// (the blocks its next call is diffed against) and the locators a cross-record context (D37 ②) is stitched by. bodyOf() gives one call its blocks back — `flat` (metadata + a text_ref per
// block), `nonBlockKeys`, the reply (`norm`), `rec` — from its own record, with the same functions push() used, so a page can ship
// the calls it shows with their bodies without the session ever being held whole. finish() builds the `analyzed` document without changing what the fold derived, so it can go on afterwards.
//
// IN STEP ORDER. The batch forms (assembleSession, board.mjs sessionFold) push a
// session's records sorted by step order; what orders the lanes against each other — the global step index `gi`, the stream ids —
// is given at finish(), by step order (analyze.mjs stepOrder). A record that sorts before its lane's last call throws (inOrder).
//
// SEVERAL WIRES (D37 ①: the wire format is per call — an auxiliary model, a provider template or a per-model protocol choice can
// mix them). Each record goes to the fold of its own wire; every call carries the session's GLOBAL step index, lanes of the same
// id merge, and `steps[gi]` is the call with that gi (the browser rehydrates by it). Records no dissector claims are counted in
// `analyzed.unknown` and never rendered (3.1:58).
export function createAssembler() {
  const folds = new Map(); // dissector object | 'analyzed' → its fold
  const unknown = [], other = []; // { at, facts }: what unknownSummary reads of records no fold takes (LLM calls / the rest)
  const foldKey = (r) => {
    let d = boardDissectorFor(r);
    if (d && d.admits && !d.admits(r)) d = null; // a record of a known wire that is no call (e.g. a server push): counted
    return d || (wireFormatOf(r) === 'anthropic' ? 'analyzed' : null);
  };
  const facts = (xs) => [...xs].sort((a, b) => stepOrder(a.at, b.at)).map((x) => x.facts);
  let done = null; // the document of what has gone in so far, until the next push
  function finish() {
    if (!folds.size) return assembleUnknown(facts(unknown.length ? unknown : other)); // labelled, never faked
    [...folds.values()].flatMap((f) => f.calls()).sort(byOrder).forEach((c, i) => { c.gi = i; });
    const first = (v) => (v.steps.length ? v.steps[0].gi : Infinity);
    const views = [...folds.values()].map((f) => f.finish()).sort((a, b) => first(a) - first(b));
    const A = views.length === 1 ? views[0] : mergeViews(views);
    tellApart(A.lanes); // every lane's task, sub-agents told apart across every wire's lanes at once
    if (unknown.length) A.unknown = unknownSummary(facts(unknown), true);
    return A;
  }
  return {
    push(r) {
      if (!r) return null;
      done = null;
      const key = foldKey(r);
      if (!key) { (r.is_llm_call ? unknown : other).push({ at: orderOf(r), facts: unknownFacts(r) }); return null; }
      let f = folds.get(key);
      if (!f) folds.set(key, (f = key === 'analyzed' ? multiLaneFold() : flatLaneFold(key)));
      return f.push(r);
    },
    bodyOf: (call, r) => PLACE.get(call).fold.bodyOf(call, r),
    finish: () => (done = done || finish()), // the same object until the next push: nothing downstream changes it
  };
}
// A call's place in step order (its record's ts_request and id; the global index is given by it at finish()) and the fold that
// assembled it (which gives its body back), kept beside it.
const PLACE = new WeakMap();
const orderOf = (r) => ({ ts_request: r.ts_request, id: r.id });
const placed = (call, r, fold) => { PLACE.set(call, { ...orderOf(r), fold }); return call; };
const byOrder = (a, b) => stepOrder(PLACE.get(a), PLACE.get(b));
// A call that sorts before its lane's previous call: the batch forms push every session in step order, so this is a caller's bug,
// never folded over silently. `cs` = the lane's calls, `call` last. → call.
function inOrder(cs, call) {
  if (cs.length > 1 && byOrder(cs[cs.length - 2], call) >= 0) throw new Error(`record ${PLACE.get(call).id} sorts before calls already folded in its lane: push a session in step order`);
  return call;
}

// The batch form: `records` (one session's, any order) folded whole, every call with its body.
export function assembleSession(records) {
  const a = createAssembler();
  const pushed = [];
  for (const r of [...(records || [])].sort(stepOrder)) { const c = a.push(r); if (c) pushed.push([c, r]); }
  const A = a.finish();
  for (const [c, r] of pushed) { Object.assign(c, a.bodyOf(c, r)); delete c.paged_out; }
  return A;
}

// Several wires in one session: steps re-sorted by the global gi, lanes of the same id merged.
export function mergeViews(views) {
  const steps = views.flatMap((v) => v.steps || []).sort((a, b) => a.gi - b.gi);
  const by = new Map();
  for (const l of views.flatMap((v) => v.lanes || [])) {
    const cur = by.get(l.id);
    if (!cur) { by.set(l.id, { ...l, calls: [...l.calls], events: [...(l.events || [])], resources: [...(l.resources || [])] }); continue; }
    if (l.calls.length && (!cur.calls.length || l.calls[0].gi < cur.calls[0].gi)) { cur.task = l.task ?? null; delete cur[HEAD]; if (HEAD in l) cur[HEAD] = l[HEAD]; } // the earliest call's side
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

// The multi-lane fold (the Anthropic wire): each record is dissected to the shape the board's block extractor reads (v0 in
// place; D10 req_body→request), analyze()'s fold puts it in its lane, then the call is baked against its lane's previous one.
// A call that continues a server-held thread carries only its delta: the dissector stitches its context as the calls arrive.
function multiLaneFold() {
  const an = createAnalyzer();
  const plans = MULTI_LANE_CONTEXT.prepare();
  // lane (the analyzer's stream) → { flat, chain, keys } of the call that established the lane's cache baseline. Block keys: a lane
  // re-sends its context every turn, so a block's per-text hash is asked once per lane call, not once per block of every call; the
  // memo (text → key) is its baseline's blocks only (a key text is a slice that keeps its whole text alive), never the session's.
  const prev = new Map();
  function push(r) {
    const call = take(r);
    return call && inOrder(an.laneOf(call).calls, call);
  }
  function take(r) {
    const ctx = plans.context(r);
    const call = an.push(hydrateForBoard(r, ctx));
    if (!call) return null;
    placed(call, r, self);
    const lane = an.laneOf(call);
    call.wire = wireOf(call.rec, 'anthropic', ctx); // cheap meta: rides on out-of-window calls too
    call.respRefs = respRefsOf(call.rec); // locators only (a few dozen bytes each), never the reply body
    const p = prev.get(lane), was = p && p.keys, keys = new Map();
    const flat = anthropicFlat(call.rec.request, { get: (t) => { const k = keys.get(t) ?? (was && was.get(t)); if (k !== undefined) keys.set(t, k); return k; }, set: (t, k) => keys.set(t, k) });
    if (lane.calls[0] === call) an.ask(lane, firstHuman(flat)); // the lane's task (4.4 §看板 v2 需要的补充; finish)
    const u = call.norm.usage || {};
    // NEUTRAL usage (D18a Q1 / D24): the browser reads call.usage.{read, create, fresh, out}, never a provider's field name;
    // the one mapping is mapUsage (3.2), the board's names its projection.
    call.usage = boardUsage(mapUsage('anthropic', u, { vendor: call.wire.vendor }));
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
    if (call.chainsPrefix !== false) prev.set(lane, { flat, chain, keys });
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
    const ctx = plans.context(r);
    const h = admitted(hydrateForBoard(r, ctx));
    const flat = anthropicFlat(h.request, new Map());
    return { flat: ctx ? withLocatedRefs(flat, ctx.locate, new Map()) : withRefs(flat, h), nonBlockKeys: nonBlockKeysOf(h, 'anthropic'), rec: slimRec(h), norm: normResp(h) };
  }
  const self = { push, bodyOf, calls: an.calls, finish() { const A = an.finish(); A.provider = 'cc'; return A; } };
  return self;
}
