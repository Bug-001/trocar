// src/adapters/cc.mjs — CC (Anthropic / Claude Code) adapter (RFC 3.1).
// One captured unified-envelope record -> 3.2 canonical rows (session / call /
// blocks / resources). Provider-native field names are consumed HERE and never
// surface downstream (invariant 3).
//
// IMPORTS the already-built primitives — this file does NOT reimplement them:
//   • content-hash.mjs  → contentHash / hashSpan / spanOf  (D19 byte-exact hashing); scanJson from src/dissect/json-scan.mjs
//   • session-identity.mjs (3.4) → nativeId / classOf / controlKindFor / controlKind /
//                                  lane / entrypoint / parseSessionCC  (session/lane/control logic)
//   • model/schema.mjs (3.2) → mapUsage('cc', rawUsage)  (canonical usage mapping)
import { contentHash, hashSpan, spanOf } from './content-hash.mjs';
import { scanJson } from '../dissect/json-scan.mjs';
import { storedRequestBody, scannedRequestBody } from '../dissect/request-body.mjs';
import { collectExtra } from './contract.mjs';
import { ENVELOPE_CONSUMED, v0RequestOf } from './envelope.mjs';
import { wireFormatOf, contextStateOf } from '../dissect/registry.mjs';
import { hintsOf } from '../dissect/harnesses.mjs';
import { vendorOf } from '../dissect/vendors.mjs';
import { mapUsage } from '../model/schema.mjs';
import {
  parseSessionCC,
  lane,
  classOf,
  controlKindFor,
  controlKind,
  hasCompactionPreamble,
} from '../identity/session-identity.mjs';
// D25: the CC block model (assembly-order walk, volatile rule, resource linking, kind, faithfulness,
// bash-read parsing) lives in ONE dissector, shared with the board (analyze.linearContext). parseBlocks
// below is the ETL PROJECTION of that dissector's spine — adds the D19 verbatim byte spans + text_ref.
import { dissectBlocks, resourceRef, blockKind, faithfulness, parseBashReads } from '../dissect/cc.mjs';
export { parseBashReads }; // re-exported for back-compat (was defined here before the D25 extraction)

// ── req_body access ────────────────────────────────────────────────────────────
// D10: req_body is the VERBATIM captured request bytes (a string). parseBlocks hashes
// the raw string's byte spans (D19). The 3.4 identity layer, by contrast, expects
// req_body PARSED — so `withParsedBody` normalizes a record for those pure functions.
export function reqSource(record) {
  const b = record?.req_body;
  if (typeof b === 'string') return b;
  if (b == null) return '{}';
  // Fallback only (real D10 envelopes carry a string): if an already-parsed object
  // slips in, serialize it so spans still work — a documented degradation, NOT the norm.
  try {
    return JSON.stringify(b);
  } catch {
    return '{}';
  }
}
export function reqObj(record) {
  const b = record?.req_body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return v0RequestOf(record) ?? {}; // the demo v0 shape: the parsed request object (see envelope.mjs)
}
function withParsedBody(record) {
  return { ...record, req_body: reqObj(record) };
}

// ── detect (RFC 3.1:23 / D37 ①) ──────────────────────────────────────────────────
// This adapter claims Anthropic-WIRE INFERENCE only, decided by the shared wire registry (endpoint and
// body shape). Control-plane and count_tokens records go to the envelope adapter (./envelope.mjs); a
// harness's UA or session header no longer decides the wire.
export function detect(record) {
  // D40: a call the operator set to 「只记日志」 has no body to dissect; the envelope adapter takes it (a row, no blocks, no usage)
  return record?.is_llm_call === true && record.body_retention !== 'log' && wireFormatOf(record) === 'anthropic';
}

// ── usage (承 demo normResp; mapping delegated to 3.2 schema.mapUsage) ──────────
// ccUsage unifies the two response shapes into the raw Anthropic usage object: SSE
// capture reconstructs the terminal usage into resp.usage; non-streaming JSON keeps
// it in resp.body.usage. The canonical mapping itself lives in schema.mjs (imported).
export function ccUsage(resp = {}) {
  if (resp.kind === 'json' && resp.body && typeof resp.body === 'object') return resp.body.usage || {};
  return resp.usage || {};
}

// ccLane = 3.4 identity lane (per-CALL), delegating to the imported classifier. It is
// wrapped only to parse req_body first (identity.lane expects a parsed body).
export const ccLane = (record) => lane(withParsedBody(record));

// ccControlKind = 3.4 identity endpoint→control_kind classifier (re-exported so 3.3/4.2
// can import it from the adapter). NOT reimplemented here (avoids the plan's regex drift).
export { controlKind as ccControlKind };

// ── parseCall (class / control_kind / lane / usage / error / unmapped_count) ─────
// Every envelope field the read side recognizes is ENVELOPE_CONSUMED (./envelope.mjs, shared by every
// adapter). collectExtra diffs the record's actual keys against it; the remainder -> calls.extra +
// unmapped_count (RFC 3.1 unmapped invariant, D7 auto-evolution signal). The #21 req_* labels are left
// unconsumed on purpose, so they reach calls.extra.

// req_body keys this adapter maps to canonical columns / blocks / identity. The remainder (real
// provider request fields — max_tokens / temperature / top_p / top_k / tool_choice / thinking /
// stop_sequences …) are UNMAPPED and MUST surface in calls.extra.req_body + unmapped_count (RFC
// 3.1:44 — canonical ∪ extra == all keys, per layer; D7 auto-evolution signal). The envelope-level
// collectExtra treats req_body as consumed-whole, so without this pass those fields silently vanish.
const REQ_BODY_CONSUMED = new Set([
  'model', 'stream', 'system', 'tools', 'messages', 'metadata',
  // demo-capture derived summaries (not provider wire fields; consumed so they don't inflate count)
  'system_chars', 'tool_count', 'message_count', 'context_chars',
]);

function stopReasonOf(resp = {}) {
  if (resp.kind === 'json' && resp.body && typeof resp.body === 'object') return resp.body.stop_reason ?? null;
  return resp.stop_reason ?? null;
}

export function parseCall(record) {
  const norm = withParsedBody(record); // identity layer wants a parsed body
  const req = norm.req_body;
  const resp = record?.resp || {};
  const cls = classOf(norm); // 'llm' | 'control' (3.4)
  const isLlm = cls === 'llm';
  const env = collectExtra(record, ENVELOPE_CONSUMED);
  // ALSO diff req_body's inner keys — unmapped provider request fields flatten in with a `req_body.`
  // prefix (keeps the contract invariant unmapped_count == |extra keys|, and gives the D7
  // unmapped_fields view a precise path like `req_body.max_tokens` rather than an opaque `req_body`).
  const body = req && typeof req === 'object' ? collectExtra(req, REQ_BODY_CONSUMED) : { extra: {}, unmapped_count: 0 };
  const extra = { ...env.extra };
  for (const [k, v] of Object.entries(body.extra)) extra['req_body.' + k] = v;
  const unmapped_count = env.unmapped_count + body.unmapped_count;
  return {
    class: cls,
    control_kind: controlKindFor(norm), // NULL for llm; config|account|registry|telemetry|other for control
    lane: lane(norm), // per-CALL (B-lane): main|subagent|monitor|aux|probe
    endpoint: record?.endpoint || '',
    model: req.model || null,
    stream: req.stream === true,
    usage: isLlm ? mapUsage('cc', ccUsage(resp), { vendor: vendorOf(record) }) : mapUsage('cc', {}), // NULL write per vendor (3.2)
    stop_reason: isLlm ? stopReasonOf(resp) : null,
    duration_ms: record?.duration_ms ?? null,
    error: !!record?.error || resp.kind === 'error' || (resp.status || 0) >= 500,
    unmapped_count,
    extra,
    // D37 (3.2:49/52): this adapter speaks the Anthropic Messages wire. Only an inference call has a
    // context to judge; control / probe rows leave both NULL. An incomplete stored request is 'partial'
    // (gate G17); its req_* labels stay in calls.extra, unconsumed, saying why. One rule for board + ETL.
    wire_format: record?.is_llm_call === true ? 'anthropic' : null,
    context_state: record?.is_llm_call === true ? contextStateOf(record) : null,
    // 3.4 compaction: a harness hint (header, high) or a text marker (medium; the ETL takes its rising
    // edge). compaction/compaction_from/to themselves are cross-call, decided by the ETL (compactionVerdict falls
    // back to a SHARP message-count drop when neither is present; CC's own "continued from a previous conversation"
    // preamble lets a smaller drop count, the board reads the same preamble: hasCompactionPreamble).
    compaction_hint: hintsOf(record).compaction === true,
    compaction_marker: hintsOf(record).compactionMarker === true,
    compaction_preamble: hasCompactionPreamble(req && req.messages),
  };
}

// ── parseBlocks — the D19 + AC-1 crux ───────────────────────────────────────────
// Do BOTH:
//   (a) JSON.parse(req_body) for STRUCTURE (section/role/kind, assembly order), AND
//   (b) scanJson(req_body) for the VERBATIM BYTE SPAN of the SAME element.
// content_hash = hashSpan(src, node) (sha-256 over the raw wire bytes, D19 — NEVER over
// JSON.stringify(parsedBlock), which would normalize whitespace/key-order/number/unicode
// and mask cache-breaks). text = src.slice(...span) (verbatim), text_ref = span (回源 locator).
const MSG_BLOCK_CONSUMED = [
  'type', 'text', 'thinking', 'signature', 'data', 'name', 'input', 'id',
  'content', 'tool_use_id', 'is_error', 'source', 'cache_control',
];

// faithfulness (invariant 4 · opaque signature-only reasoning), block kind, and resource linking now
// come from the shared CC dissector (src/dissect/cc.mjs, imported above) — one source for board + ETL.

// One 3.2 block_contents + call_blocks row. content_hash / text / text_ref ALL derive
// from the verbatim byte span (node); everything else from the parsed structure.
function mkBlock({ section, role, parsed, node, src, seq, volatile = false, resource_ref = null, extra = {} }) {
  const span = node ? spanOf(node) : null;
  const text = span
    ? src.slice(span[0], span[1])
    : typeof parsed === 'string'
      ? parsed
      : JSON.stringify(parsed); // fallback only when no span could be located (malformed src)
  const content_hash = node ? hashSpan(src, node) : contentHash(text);
  return {
    section,
    role,
    kind: blockKind(parsed),
    content_hash, // D19: sha-256 over the VERBATIM wire span, not a re-serialization
    text, // verbatim byte slice of req_body
    text_ref: span, // [start,end) byte span into req_body — the AC-1 回源 locator
    chars: text.length,
    preview: text.slice(0, 200),
    faithfulness: faithfulness(parsed),
    cache_control: (parsed && typeof parsed === 'object' && parsed.cache_control) || null,
    volatile: !!volatile,
    resource_ref,
    extra,
    seq,
  };
}

export function parseBlocks(record) {
