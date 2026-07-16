// src/view/assemble.mjs — server-side view assembler (D18a Option-2). Runs the demo's
// analyze pipeline SERVER-SIDE over ONE session's raw records and BAKES per-call flat +
// cacheBreak + groundTruth, so the reused demo render code reads PRE-COMPUTED fields instead
// of calling analyze functions in the browser. Result: the demo's exact look, with ZERO
// provider parsing in the browser → invariant 3 / AC-3 intact (adding a provider = a new
// server-side analyzer, frontend unchanged).
import { createHash } from 'node:crypto';
import { analyze, linearContext, cacheBreak, normResp, flatBlockText } from './analyze.mjs';

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
  return { ...r, request, response: r.response || r.resp || {} };
}

const SIDH = ['x-claude-code-session-id', 'x-session-id'];
export function sessionIdOf(rec) {
  const h = rec.request_headers || {};
  for (const k of SIDH) if (h[k]) return h[k];
  return null;
}
export function recordsForSession(records, sessionId) {
  return records.filter((r) => sessionIdOf(r) === sessionId);
}

// records = ONE session's raw (v0/demo-shape) records. Returns analyze() output with each
// call augmented: .flat (linearContext), .cacheBreak (vs prev in lane), .gt (groundTruth).
export function assembleSession(records) {
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
      prevFlat = flat;
    }
  }
  return A;
}
