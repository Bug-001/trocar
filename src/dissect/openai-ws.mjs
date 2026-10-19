// src/dissect/openai-ws.mjs — OpenAI Responses over WebSocket (RFC 3.1:37 / 3.1:60, D37 ②③; Codex's default
// transport). The collector writes one envelope per logical call on a connection (4.6 §传输与帧级记录):
// req_body = the client's response.create text, resp.messages = the server's messages (resp.partial.messages
// when the connection ended the call early), req_extra_messages = later client messages of the same call.
// Only `input` is a delta, so the context a call ran with is RECONSTRUCTED across records:
//   context(N) = stitched input(N-1) ⧺ output of N-1's response.completed ⧺ input(N)
// Whether to stitch depends ONLY on previous_response_id (3.1:37 — never on the message's position: OpenCode
// resends the full input on every message). instructions / tools are resent and come from the call itself.
// States (3.2:52): no previous_response_id = 'complete'; predecessor found on this connection = 'reconstructed';
// predecessor not in the capture (connection start missed, an off window, a record removed at read time), or
// itself partial = 'partial'. The collector's own top-level `partial` (a gap earlier on the connection) makes a
// continuation partial too; a call without previous_response_id is narrowed back to complete, since its own
// bytes carry its whole input (3.1:60). The bytes are untouched: every stitched block is located in the record
// and field it came from (locate), so it resolves verbatim through a field-qualified text_ref (4.2:40, gate G1).
// Leaf module.
import { boardFlat, reqCountsFor, ctxTokens, normEvents, faithfulness } from './openai.mjs';
import { isWsHandshake } from './ws-handshake.mjs'; // not ./registry.mjs: the registry imports THIS module
import { headerOf } from './harnesses.mjs';

const parse = (s) => { if (typeof s !== 'string') return null; try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const PARSED = new WeakMap();
const bodyOf = (rec) => {
  if (!rec || typeof rec !== 'object') return null;
  if (!PARSED.has(rec)) PARSED.set(rec, parse(rec.req_body));
  return PARSED.get(rec);
};
// The server messages of a call, in order; an error envelope keeps them under resp.partial (same numbering as
// ws_raw's m slices and as the text_ref field resp.messages.<j>).
export function serverMessages(rec) {
  const r = (rec && rec.resp) || {};
  const m = r.kind === 'ws' ? r.messages : (r.partial && r.partial.messages);
  return Array.isArray(m) ? m : [];
}
// Codex's terminal messages, as its harness data declares them (4.6 §传输与帧级记录; 3.1:37).
const TERMINAL = /^(response\.(completed|failed|incomplete)|error)$/;
function terminalOf(rec) {
  const msgs = serverMessages(rec);
  for (let j = msgs.length - 1; j >= 0; j--) { const e = parse(msgs[j]); if (e && TERMINAL.test(e.type)) return { j, e }; }
  return null;
}

// 4.6 §传输与帧级记录: a call whose first client message the collector did not store — over the per-call size cap
// (the framer omitted it: ws_truncated) or it could not be decompressed (partial_reasons has decode-failed) — has
// req_body:null and no req_body_b64. It is told apart from an envelope with no client message (a server push) by a
// client DATA frame in its ws_raw (opcode 0 / 1 / 2 in the frame header; control frames ride with any envelope).
// → why its request is not stored, as text, or null.
const hasClientDataFrame = (rec) => (Array.isArray(rec.ws_raw) ? rec.ws_raw : []).some((f) => {
  if (!f || f.d !== 'c' || typeof f.h !== 'string') return false;
  const h = Buffer.from(f.h, 'base64');
  return h.length > 0 && (h[0] & 0x0f) <= 2;
});
export function unstoredRequestOf(rec) {
  if (!rec || rec.transport !== 'ws' || rec.req_body != null || typeof rec.req_body_b64 === 'string' || !hasClientDataFrame(rec)) return null;
  const why = [];
  if (rec.ws_truncated === true) why.push('it was over the per-call size cap (ws_truncated: its frames keep only their headers)');
  if (Array.isArray(rec.partial_reasons) && rec.partial_reasons.includes('decode-failed')) why.push('it could not be decompressed (partial_reasons: decode-failed; its compressed frames are kept in ws_raw)');
  return why.length ? `the request message of this call was not stored: ${why.join(', or ')}` : null;
}

// 'handshake' = a legacy 101 envelope (main-era collector; gate G6) · 'warmup' = generate:false (W3: in the chain,
// not a turn) · 'call' = a response.create · 'unstored' = a call whose request message was not stored (above): it
// ran, its reply and usage are here, its context is not · 'other' = anything else on the socket (a non-create client
// message, a server message with no call open, a binary or unreadable opener) — counted by the board, never a call.
export function roleOf(rec) {
  if (isWsHandshake(rec)) return 'handshake';
  if (!rec || rec.transport !== 'ws') return 'other';
  if (unstoredRequestOf(rec)) return 'unstored';
  const b = bodyOf(rec);
  if (!b || b.type !== 'response.create') return 'other';
  return b.generate === false ? 'warmup' : 'call';
}

// One connection = one upgrade. flow_id restarts at 1 with the collector, so the upgrade's own random
// Sec-WebSocket-Key (in req_headers, which every call of the connection carries) keeps two runs apart.
const connOf = (rec) => `${rec.flow_id ?? ''}|${headerOf(rec, 'sec-websocket-key') || ''}`;
const order = (a, b) => (Number(a.seq) - Number(b.seq)) || String(a.ts_request).localeCompare(String(b.ts_request));

function ownSegments(rec, b) {
  // A string input is one user message, exactly as the server reads it; its bytes are the whole JSON string.
  if (typeof b.input === 'string') return [{ rec, field: 'req_body', path: ['input'], item: { role: 'user', content: b.input }, whole: true }];
  return (Array.isArray(b.input) ? b.input : []).map((item, i) => ({ rec, field: 'req_body', path: ['input', i], item }));
}

// The chain, one record at a time (the ETL reads a stream; 4.2 incremental). plan(rec) → Plan | null (not a
// call). Plan = { role, prevId, responseId, contextState, missing, segments }; segments, in assembly order, are the
// call's whole stitched input: { rec, field, path, item, whole? }. A connection's records MUST arrive in seq order:
// file order gives that, since the collector writes a call's envelope when its terminal message arrives and one
// connection carries one response at a time (a continuation read before its predecessor reads as partial).
export function createChain() {
  const conns = new Map(); // connOf → (response id → { plan, outputSegs }): only a response.completed can be continued
  const plans = new WeakMap();
  return {
    plan(rec) {
      if (plans.has(rec)) return plans.get(rec);
      const role = roleOf(rec);
      if (role !== 'call' && role !== 'warmup' && role !== 'unstored') return null;
      const k = connOf(rec);
      let heads = conns.get(k);
      if (!heads) conns.set(k, (heads = new Map()));
      if (role === 'unstored') {
        // no input is known, so no context: partial, and a continuation of its response is partial too
        const why = unstoredRequestOf(rec);
        const t = terminalOf(rec);
        const done = t && t.e.type === 'response.completed' && t.e.response && typeof t.e.response.id === 'string' ? t : null;
        const plan = { role, prevId: null, responseId: done ? done.e.response.id : null, contextState: 'partial', missing: why, unstored: why, segments: [] };
        plans.set(rec, plan);
        if (done) {
          const output = Array.isArray(done.e.response.output) ? done.e.response.output : [];
          heads.set(plan.responseId, { plan, outputSegs: output.map((item, i) => ({ rec, field: `resp.messages.${done.j}`, path: ['response', 'output', i], item })) });
        }
        return plan;
      }
      const b = bodyOf(rec);
      const prevId = typeof b.previous_response_id === 'string' && b.previous_response_id ? b.previous_response_id : null;
      let segments = ownSegments(rec, b), contextState = 'complete', missing = null;
      if (prevId) {
        const head = heads.get(prevId);
        if (head) {
          segments = [...head.plan.segments, ...head.outputSegs, ...segments];
          contextState = head.plan.contextState === 'partial' ? 'partial' : 'reconstructed';
          missing = head.plan.missing;
        } else {
          contextState = 'partial';
          missing = `response ${prevId} (named by previous_response_id) is not a completed response in this capture of the connection`;
        }
        if (rec.partial === true) {
          contextState = 'partial';
          missing = missing || `the collector saw a gap earlier on this connection (${(rec.partial_reasons || []).join(', ') || 'partial'})`;
        }
      }
      const t = terminalOf(rec);
      const done = t && t.e.type === 'response.completed' && t.e.response && typeof t.e.response.id === 'string' ? t : null;
      const plan = { role, prevId, responseId: done ? done.e.response.id : null, contextState, missing, segments };
      plans.set(rec, plan);
      if (done) {
        const output = Array.isArray(done.e.response.output) ? done.e.response.output : [];
        heads.set(plan.responseId, { plan, outputSegs: output.map((item, i) => ({ rec, field: `resp.messages.${done.j}`, path: ['response', 'output', i], item })) });
      }
      return plan;
    },
  };
}

// The board's batch form: every connection's records in seq order, through one chain. → Map<rec, Plan>.
export function chainPlan(records) {
  const conns = new Map();
  for (const r of records || []) {
    const role = roleOf(r);
    if (role !== 'call' && role !== 'warmup' && role !== 'unstored') continue;
    const k = connOf(r);
    if (!conns.has(k)) conns.set(k, []);
    conns.get(k).push(r);
  }
  const chain = createChain();
  const plans = new Map();
  for (const recs of conns.values()) for (const r of recs.sort(order)) plans.set(r, chain.plan(r));
  return plans;
}

// The request the model was given: the call's own body with `input` replaced by the stitched input.
export function stitchedRequest(rec, plan) {
  return { ...(bodyOf(rec) || {}), input: plan.segments.map((s) => s.item) };
}

// A board block of the stitched request → the record, field and JSON path its bytes live in.
export function locate(block, rec, plan) {
  const p = Array.isArray(block && block.path) ? block.path : null;
  if (!p) return null;
  if (p[0] !== 'input') return { rec, field: 'req_body', path: p };
  const seg = typeof p[1] === 'number' ? plan.segments[p[1]] : null;
  if (!seg) return null;
  return { rec: seg.rec, field: seg.field, path: seg.whole ? seg.path : [...seg.path, ...p.slice(2)] };
}

// The reply, from the server messages. Messages that are not JSON text ({b64}, {omitted_bytes}, a parse
// failure) cannot be read; they are counted in `unread`, never dropped without a trace.
export function normRespWs(rec) {
  const events = [];
  let unread = 0;
  for (const m of serverMessages(rec)) { const e = parse(m); if (e) events.push(e); else unread++; }
  return { ...normEvents(events), unread };
}

// The dissector object the board's flat-lane assembler calls (D25: the shared layer names no wire; the
// registry registers this under 'openai-responses-ws'). prepare/contextOf/roleOf/laneOf/failed are the hooks a
// wire with a cross-record context provides.
export const RESPONSES_WS = Object.freeze({
  id: 'openai-responses-ws', provider: 'openai', blockKeys: ['tools', 'instructions', 'input'],
  createChain, stitchedRequest, locate, roleOf,
  consumedBody: ['type', 'model', 'stream', 'instructions', 'tools', 'input', 'previous_response_id', 'generate'],
  faithfulnessOf: (b) => faithfulness(b && b.block),
  prepare: (records) => chainPlan(records),
  contextOf: (rec, plans) => {
    const p = plans && plans.get(rec);
    return p ? { req: stitchedRequest(rec, p), contextState: p.contextState, missing: p.missing, locate: (b) => locate(b, rec, p),
      ...(p.unstored ? { unrenderable: p.unstored } : {}) } : null;
  },
  admits: (rec) => { const r = roleOf(rec); return r === 'call' || r === 'warmup' || r === 'unstored'; },
  laneOf: (rec) => (roleOf(rec) === 'warmup' ? 'probe' : null), // W3: a warmup is lane probe, not a turn
  boardFlat: (req) => boardFlat(req),
  normResp: (rec) => normRespWs(rec),
  reqCounts: (req) => reqCountsFor('responses', req),
  ctxTokens,
  // a call failed when its terminal says so, or when no terminal arrived at all (the connection cut it)
  failed: (norm, rec) => norm.stop_reason === 'error' || norm.stop_reason === 'failed' || !!(rec && rec.error),
});
