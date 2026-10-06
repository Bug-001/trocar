// src/view/assemble.mjs — server-side view assembler (D18a Option-2). Runs the demo's
// analyze pipeline SERVER-SIDE over ONE session's raw records and BAKES per-call flat +
// cacheBreak + groundTruth, so the reused demo render code reads PRE-COMPUTED fields instead
// of calling analyze functions in the browser. Result: the demo's exact look, with ZERO
// provider parsing in the browser → invariant 3 / AC-3 intact (adding a provider = a new
// server-side analyzer, frontend unchanged).
import { createHash } from 'node:crypto';
import { analyze, linearContext, cacheBreak, normResp, flatBlockText } from './analyze.mjs';
import * as openai from '../dissect/openai.mjs'; // D25 · Phase 4: the OpenAI/Codex dissector
import { reqIncompleteOf, wsIncompleteOf, respIncompleteOf } from '../dissect/capture-labels.mjs'; // #21 request-body labels, D38 WebSocket labels, response labels
import { blockSpans } from '../adapters/cc.mjs';
import { slimBlock, compBuckets } from './blockmeta.mjs';
import { mintRawRef, composeTextRef } from '../etl/orchestrator.mjs';
import { sessionKeyOf } from '../dissect/harnesses.mjs';

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

// ── provider dispatch (D25 · one dissector per provider) ──────────────────────────────────────
// Positive CC/Anthropic detection. This USED to be the implicit `else` branch — anything the OpenAI
// dissector did not claim was handed to the Claude Code dissector, so foreign bytes (Gemini, or any
// harness we have no dissector for) rendered under Claude Code's vocabulary with NO label, zeroed
// usage, and — because the CC walker finds nothing — could even emit a FALSE 'provider-contradiction'
// accusation. Invariant 4 requires the opposite: what we cannot faithfully represent MUST say so.
// Signals are the wire-stable ones 3.1:23 asks for (endpoint / header / body shape), most reliable
// first. Body shape is required because the frozen view fixtures carry no `endpoint` at all.
//
// WIRING GAP (reported, not made): this belongs in src/dissect/cc.mjs as `detect(rec)`, next to the
// dissector it speaks for — cc.mjs is outside this change's file scope.
function looksCC(rec) {
  if (!rec) return false;
  const h = headersOf(rec);
  if (h['anthropic-version'] || h['anthropic-beta']) return true;
  const ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (/claude|anthropic/.test(ua)) return true;
  if (h['x-claude-code-session-id']) return true;
  const ep = String(rec.endpoint || '').split('?')[0];
  if (/(^|\/)v1\/messages$/.test(ep)) return true;
  // Anthropic request-body shape (D10 verbatim string or a v0 parsed `request` object)
  let body = rec.request && typeof rec.request === 'object' ? rec.request : null;
  if (!body && typeof rec.req_body === 'string') { try { body = JSON.parse(rec.req_body); } catch { body = null; } }
  if (!body || !Array.isArray(body.messages)) return false;
  if (body.system !== undefined || body.max_tokens !== undefined) return true;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((t) => t && t.input_schema !== undefined)) return true;
  return body.messages.some((m) => Array.isArray(m && m.content)
    && m.content.some((c) => c && (c.type === 'tool_use' || c.type === 'tool_result')));
}
// 'openai' | 'cc' | 'unknown' — an EXPLICIT unknown, never a silent fallback to a known dissector.
function providerOf(records) {
  for (const r of records || []) if (openai.detect(r)) return 'openai';
  for (const r of records || []) if (looksCC(r)) return 'cc';
  return 'unknown';
}

// No dissector claimed these bytes. Report that IN PLACE (invariant 4) and COUNT them (3.1:44 — an
// unclaimed record MUST land in a labelled "unrecognized" state, MUST NOT be silently dropped).
// We deliberately emit ZERO calls/lanes/blocks: any number we printed here would be a number we did
// not parse. The evidence below (endpoints, user-agents, models) is copied verbatim from the envelope
// so a human can see WHAT arrived without us pretending to have understood it.
function assembleUnknown(records) {
  const recs = records || [];
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const models = uniq(recs.map((r) => {
    let b = r && r.request && typeof r.request === 'object' ? r.request : null;
    if (!b && r && typeof r.req_body === 'string') { try { b = JSON.parse(r.req_body); } catch { b = null; } }
    return b && typeof b.model === 'string' ? b.model : null;
  }));
  return {
    provider: 'unknown',
    unknown: {
      reason: 'No dissector recognizes this traffic. asight has dissectors for the Anthropic '
        + '(Claude Code) and OpenAI (Responses / Chat Completions) wire formats; these bytes match '
        + 'neither, so they are NOT parsed and NOT rendered — showing them under another provider\'s '
        + 'vocabulary would be a fabrication.',
      records: recs.length,
      endpoints: uniq(recs.map((r) => String((r && r.endpoint) || '').split('?')[0])),
      userAgents: uniq(recs.map((r) => (headersOf(r) || {})['user-agent'])),
      models,
    },
    streams: [], steps: [], lanes: [],
    stats: { calls: 0, streams: 0, subagents: 0, monitors: 0, compactions: 0, totalIn: 0, totalOut: 0, peakCtx: 0 },
  };
}

// Codex/OpenAI assembler (Phase 4). Produces the SAME `analyzed` shape the CC path does — a single
// `main` lane of calls, each baked with the neutral fields the board reads (flat/usage/cacheBreak/gt/
// prefixSha256) — but via the OpenAI dissector (src/dissect/openai.mjs). The cache-break + ground-truth
// machinery (cacheBreak / prefixSha256 / realGroundTruth) is provider-agnostic over the flat block
// vocabulary, so it is REUSED verbatim. Lanes beyond `main` (subagent/monitor/aux) + the resource
// ledger are CC-specific and left empty here (fidelity: not-yet-extracted for Codex, not misreported).
function assembleOpenai(records, opts = {}) {
  // Admit every record the dissector CLAIMS, keyed on its wire shape. This used to be a hard-coded
  // `/responses` endpoint test, which is the half of D25's warning that renders a blank board: once
  // detect() claims Chat Completions, an endpoint-only filter drops all of it and the session shows
  // as empty. Shape in, shape out — the dissector dispatches, the shared layer does not branch.
  const shapeOf = (r) => (r && r.is_llm_call ? openai.wireShape(r) : null);
  const llm = (records || []).filter((r) => shapeOf(r) !== null)
    .sort((a, b) => String(a.ts_request || a.ts || '').localeCompare(String(b.ts_request || b.ts || '')));
  const calls = [];
  let prevFlat = null, gi = 0;
  for (const r of llm) {
    const shape = shapeOf(r);
    let req; try { req = JSON.parse(r.req_body); } catch { req = null; }
    // req_body null (a WebSocket call whose request message is undecoded, or a server push: 4.6 §传输) parses to null,
    // which used to throw below and take the whole session's /api/session down: such a call has no request
    if (!req || typeof req !== 'object') req = (r.request && typeof r.request === 'object') ? r.request : {};
    r.request = req; // so the board's callComp / cost read the parsed request
    // derived counts the board header + raw card read (parallel to hydrateForBoard for CC)
    Object.assign(req, openai.reqCountsFor(shape, req));
    req.context_chars = (r.req_body || '').length; // verbatim wire byte count
    const flat = openai.boardFlatFor(shape, req);
    const norm = openai.normRespFor(shape, r);
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
      gi: gi++, id: r.id, streamId: 'main', rec: r, norm, wireShape: shape,
      ctx: openai.ctxTokens(norm),
      msgCount: req.message_count || 0,
      tools: Array.isArray(req.tools) ? req.tools.length : 0,
      ts: r.ts_request || r.ts || '', status: (r.resp && r.resp.status) || null,
      compaction: false, error: !!r.error, reqIncomplete: reqIncompleteOf(r), wsIncomplete: wsIncompleteOf(r), respIncomplete: respIncompleteOf(r),
      flat: kept ? flat : [], ...(kept ? null : { paged_out: true }),
      // Tier A, same as the CC path: computed from `flat` BEFORE the retention window drops it, so a
      // Codex session's timeline is as complete as a Claude Code one. Omitting it here is the same
      // family of bug as this branch skipping withRefs/slimRec — one endpoint, two block shapes.
      comp: compBuckets(flat),
      usage, cacheBreak: brk, gt: brk.gt, prefixSha256: curPfx,
    });
    // Same rule as the CC assembler: a call that failed never established a cache prefix, so it
    // MUST NOT become the baseline for the next one (otherwise the board invents a cache break).
    const oaStatus = (respOf(r) || {}).status;
    if (!(r.error || (oaStatus != null && oaStatus !== 200))) prevFlat = flat;
  }
  const mainLane = {
    id: 'main', streamId: 'main', kind: 'main', icon: '💬', label: 'conversation',
    calls, events: [], resources: [], seenFiles: [], giLocal: new Map(),
    peakCtx: calls.reduce((m, c) => Math.max(m, c.ctx), 1),
    spawnStep: null, parent: null, flagged: 0,
  };
  const stats = {
    calls: calls.length, streams: 1, subagents: 0, monitors: 0, compactions: 0,
    totalIn: calls.reduce((a, c) => a + ((c.norm.usage || {}).input_tokens || 0), 0),
    totalOut: calls.reduce((a, c) => a + ((c.norm.usage || {}).output_tokens || 0), 0),
    peakCtx: calls.reduce((a, c) => Math.max(a, c.ctx), 0),
  };
  return { provider: 'openai', streams: [{ id: 'main', kind: 'main', calls }], steps: calls, stats, lanes: [mainLane] };
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

// `opts.keepFlat(gi)` — RETENTION WINDOW. The cache-break chain is inherently sequential: call N's
// diff needs call N-1's flat blocks, so every call must be assembled. But only the calls the browser
// is actually about to render need to KEEP their blocks. When a window is supplied, an out-of-window
// call is assembled, used as the next call's baseline, and then has its blocks dropped — so peak cost
// is two flats plus N cheap metas instead of N flats. That is what lets a 578-call session be
// assembled whole (all 578 bars on the timeline, correct diffs) without the assembled view growing
// past what can be serialized. Omitted → keep everything (unchanged full-send behaviour).
export function assembleSession(records, opts = {}) {
  const provider = providerOf(records);
  if (provider === 'openai') return assembleOpenai(records, opts); // Phase 4: Codex/OpenAI path
  if (provider === 'unknown') return assembleUnknown(records); // no dissector → labelled, never faked
  // Dissect each record to the shape the board's block extractor reads (v0 in-place; D10 req_body→request).
  const A = analyze(records.map(hydrateForBoard));
  for (const lane of A.lanes || []) {
    let prevFlat = null;
    for (const call of lane.calls || []) {
      if (!call.rec || !call.rec.request) { call.flat = []; call.cacheBreak = null; call.gt = null; continue; }
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
      if (opts.keepFlat && !opts.keepFlat(call.gi)) { call.flat = []; call.paged_out = true; continue; }
      // SHIP METADATA + A LOCATOR, NEVER THE BODY (RFC 4.2:55 「看全文=回源」 · 1.4:35 「点开惰性填正文」).
      // Everything above this line needed the real text — the diff chain, the prefix sha-256, the
      // byte weights — and all of it has now been computed. What leaves the process is the collapsed
      // row plus a text_ref, and the body is fetched from the raw capture when a row is opened.
      call.flat = withRefs(flat, call.rec);
      call.rec = slimRec(call.rec);
    }
  }
  A.provider = 'cc';
  return A;
}
