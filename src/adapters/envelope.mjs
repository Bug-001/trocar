// src/adapters/envelope.mjs — the ONE adapter for every envelope that is not an inference call
// (is_llm_call !== true), for ALL harnesses: control plane (telemetry / registry / account), count_tokens
// probes, and body_retention:'verbatim' side uploads. It parses no provider wire, so it yields no blocks
// and no usage (a probe is not inference: no fake zero-usage row, 3.2:134). Class follows 3.4 classOf (a
// session key makes it 'llm', else 'control'); lane: probe for count_tokens, aux for other
// session-attributed traffic, NULL for control.
import { collectExtra } from './contract.mjs';
import { classOf, controlKind, nativeId } from '../identity/session-identity.mjs';
import { isProbeEndpoint, unsupportedOf, wireFormatOf, boardDissectorFor } from '../dissect/registry.mjs';

// Every envelope key the read side understands (4.1 D10, 4.6 §记录, the D33 intervention reserve, D37 and
// the WebSocket recorder's fields, gate G7). Shared by every adapter, so none reports these as unmapped.
export const ENVELOPE_CONSUMED = new Set([
  // core (4.1 § 统一原始信封) + observ-meta (D10) + the interruption marker
  'ts', 'endpoint', 'method', 'req_headers', 'req_body', 'resp',
  'id', 'ts_request', 'ts_response_start', 'ts_response_end', 'duration_ms', 'is_llm_call', 'capture', 'auth_mode',
  'error',
  // transparent-capture fields appended after req_body (4.6 §记录 / D32)
  'host', 'scheme', 'dst', 'proc', 'flow_id', 'seq', 'req_head_raw', 'resp_head_raw',
  // intervention fields reserved by 5.1 (D33)
  'origin', 'client_req_body', 'client_resp', 'intervention', 'resend_of',
  // D37 / WebSocket structure the read side interprets (gate G7)
  'transport', 'ws_frames', 'ws_ext', 'ws_raw', 'body_retention', 'req_body_b64', 'req_content_encoding',
  // NOT listed on purpose: req_truncated / req_body_bytes / req_partial (#21) and partial / partial_reasons /
  // ws_truncated / req_encoding_error. They say a record is incomplete and calls has no column for them, so
  // consuming them would drop the invariant-4 label from the DuckDB row; unmapped, they land in calls.extra.
  // Nor req_extra_messages: client messages sent while the call was open (e.g. response.interrupt) MUST be
  // visible, "same as 未映射字段" (3.1:37). No reader maps them to a column or a block, so consuming them would
  // drop them from DuckDB without a trace; unmapped, they land verbatim in calls.extra (3.1:59).
]);

const parsedBody = (r) => {
  const b = r && r.req_body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { const v = JSON.parse(b); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
  return {};
};

export const envelopeAdapter = {
  name: 'envelope',
  priority: 10,
  detect: (record) => !!record && record.is_llm_call !== true,
  parseSession(record) {
    const n = nativeId({ ...record, req_body: parsedBody(record) });
    return { native_id: n.native_id, native_id_confidence: n.native_id_confidence, parent: null, fork_of: null,
      forked_at: null, lane: null, entrypoint: null, title: null, cwd: null, extra: {} };
  },
  parseCall(record) {
    const cls = classOf({ ...record, req_body: parsedBody(record) });
    const env = collectExtra(record, ENVELOPE_CONSUMED);
    const resp = (record && record.resp) || {};
    return {
      class: cls,
      control_kind: cls === 'control' ? controlKind(record.endpoint) : null,
      lane: cls === 'control' ? null : (isProbeEndpoint(record) ? 'probe' : 'aux'),
      endpoint: record.endpoint || '',
      model: null,
      stream: false,
      usage: null, // not inference: no usage row and no cache_events row
      stop_reason: null,
      duration_ms: record.duration_ms ?? null,
      error: !!record.error || resp.kind === 'error' || (resp.status || 0) >= 500,
      unmapped_count: env.unmapped_count,
      extra: env.extra,
      wire_format: null,
      context_state: null,
    };
  },
  parseBlocks: () => [],
  parseResources: () => [],
};

// Why a record had no adapter. Persisted with the quarantined record and counted, never dropped (3.1:58).
// Closed set: unsupported-wire-format:<name> | ws-handshake | not-a-call:<wire> | no-adapter:<wire> | no-adapter-detect.
export function quarantineReason(record) {
  const u = unsupportedOf(record);
  if (u) return `unsupported-wire-format:${u}`;
  const wf = wireFormatOf(record);
  if (wf === 'ws-handshake') return 'ws-handshake';
  // a record of a known wire its dissector reads as no call (e.g. a server message pushed with no call open,
  // or a client message that is no response.create, on a WebSocket)
  const d = boardDissectorFor(record);
  if (d && d.admits && !d.admits(record)) return `not-a-call:${wf}`;
  return wf ? `no-adapter:${wf}` : 'no-adapter-detect';
}
