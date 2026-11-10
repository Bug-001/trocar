// src/dissect/registry.mjs — which WIRE FORMAT a record speaks (D37 ①: from the endpoint and the body,
// recorded per call; never from the UA or the harness). The board (src/view/extract.mjs) and the ETL
// adapters both dispatch through this, so the two readers cannot disagree about what a record is.
// Leaf module.
import { detect as anthropicShape, serverEdited, replyEnd } from './cc.mjs';
import { contextStateOfRequest } from './capture-labels.mjs';
import { wireShape, RESPONSES, CHAT } from './openai.mjs';
import { isWsHandshake } from './ws-handshake.mjs';
import { hintsOf } from './harnesses.mjs';
import { RESPONSES_WS } from './openai-ws.mjs';
import { ANTHROPIC } from './anthropic-board.mjs';
import { GEMINI } from './gemini.mjs';
import { CC_THREADS, isContinuation } from './cc-threads.mjs';
import { endpointOf, pathOf, failedOf } from './endpoints.mjs';
import { respOf } from './record-fields.mjs';
import { sharesBody } from './request-body.mjs';

export { isWsHandshake };

// D37 ⑥: no dissector in v1 — stored as captured, read as 「未识别」 and labelled. Vertex first: its
// Gemini models also end in :generateContent, which the endpoint table names the Gemini API wire.
const UNSUPPORTED = [
  ['vertex', /\/projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/[^/:]+:[A-Za-z]+$/],
  ['bedrock', /\/model\/[^/]+\/(invoke|invoke-with-response-stream|converse|converse-stream)$/],
];
/** unsupportedOf(rec) → the name of the inference wire this version records and does not read that `rec` is on (D37 ⑥), else null. */
export function unsupportedOf(rec) {
  const ep = pathOf(rec && rec.endpoint);
  for (const [name, re] of UNSUPPORTED) if (re.test(ep)) return name;
  return endpointOf(ep)?.unsupported ?? null;
}

// → 'anthropic' | 'gemini' | 'openai-responses' | 'openai-chat' | 'openai-responses-ws' | 'ws-handshake' | null.
// null = no registered wire claims these bytes (they are counted and labelled, never guessed at).
export function wireFormatOf(rec) {
  if (!rec) return null;
  // the path's own row of the endpoint table (./endpoints.mjs); a token count (count_tokens) is a ruler, not inference (3.2)
  const row = endpointOf(rec.endpoint), wire = row && row.wire;
  if (rec.transport === 'ws') return wire === 'openai-responses' ? 'openai-responses-ws' : null;
  if (isWsHandshake(rec)) return 'ws-handshake';
  if (unsupportedOf(rec) || (row && row.class === 'token-count')) return null;
  if (wire === 'anthropic' || wire === 'gemini') return wire;
  // The OpenAI dissector reads its endpoints AND refuses Anthropic bytes on them ("bytes beat path": a
  // gateway that posts an Anthropic body to /chat/completions is still the Anthropic wire). With no
  // recognizable endpoint (v0 fixtures, odd relays) the body shape alone decides.
  const shape = wireShape(rec);
  if (shape) return shape === 'chat' ? 'openai-chat' : 'openai-responses';
  return anthropicShape(rec) ? 'anthropic' : null;
}

// Board dissectors (D25: dissector = adapter; the shared assembler only calls them). Every wire is a row;
// its `fold` says how the board folds it: 'flat' (one lane per call, the OpenAI wires) or 'tree' (lanes with
// sub-agents, the Anthropic wire, ./anthropic-board.mjs). Adding a wire = one dissector object + one row. The
// WebSocket row's object also carries the cross-record hooks (prepare → a planner with context(rec) / admits /
// laneOf / ended, src/dissect/openai-ws.mjs).
const BOARD = { anthropic: ANTHROPIC, 'openai-responses': RESPONSES, 'openai-chat': CHAT, 'openai-responses-ws': RESPONSES_WS, gemini: GEMINI };
export function boardDissectorFor(rec) {
  return BOARD[wireFormatOf(rec)] || null;
}
// The board dissector of a wire format by its id (a call row names its wire by the id: src/view/reduce.mjs).
export const boardDissectorOf = (format) => BOARD[format] || null;
// The cross-record context hooks of the Anthropic wire (Message Threads, src/dissect/cc-threads.mjs), which the
// multi-lane assembler calls the way the flat-lane one calls a board dissector's prepare.
export const MULTI_LANE_CONTEXT = CC_THREADS;

// The reply's own terminal (3.1 `ended`) of a record, read from its own `resp`: 'ok' | 'failed' | null.
export function replyEndOf(rec) {
  if (wireFormatOf(rec) === 'anthropic') return replyEnd(respOf(rec));
  const d = boardDissectorFor(rec);
  return d && d.ended ? d.ended(d.normResp(rec), rec) : null;
}
// 3.5 §访问模式 ②: a reply the client closed after its own success terminal — an error envelope (`error`, the reply under resp.partial)
// that is not failed once read as that reply. → the record as that reply (resp = the partial, `error` kept, the request body shared) | null.
// A status ≥ 400 never qualifies; nor does a partial with no named terminal (cut at the cap, not decoded).
export function closedAfterEnd(rec) {
  const r = respOf(rec);
  if (!r || r.kind !== 'error' || !r.partial || typeof r.partial !== 'object') return null;
  const copy = sharesBody({ ...rec, resp: r.partial, _closed: true }, rec); // `_closed`: read as the reply of an error envelope
  if (rec._stream) Object.defineProperty(copy, '_stream', { value: rec._stream, enumerable: false, configurable: true });
  return failedOf({ status: r.status, ws: rec.transport === 'ws', error: true, ended: replyEndOf(copy), cut: true }) ? null : copy;
}

// The lane of a call on a flat-lane wire (the OpenAI wires), ONE rule for the board and the ETL: the dissector's
// own lane (a warm-up, 3.1:37), else the harness table's hint (3.4), else main (gate G15). Claude Code's
// heuristics (haiku aux, security monitor, cc_is_subagent) read Anthropic-wire fields and do not apply here.
const FLAT_LANE_KINDS = Object.freeze(['main', 'subagent', 'aux', 'probe']);
export function flatLaneOf(d, rec) {
  const hint = (d && d.laneOf && d.laneOf(rec)) || hintsOf(rec).lane;
  return FLAT_LANE_KINDS.includes(hint) ? hint : 'main';
}

// The request's top-level keys that become context blocks, per wire format; every other top-level key is a
// non-block key the board lists one by one (4.6 R2 「不成块的顶层键逐个列出」).
export function blockKeysOf(format) {
  return (BOARD[format] && BOARD[format].blockKeys) || [];
}

// 3.2:52 context_state of an HTTP-wire call: 'partial' when the stored request is incomplete (gate G17,
// capture-labels.mjs), 'server_edited' when an Anthropic response reports context edits, else 'complete'.
// (A WebSocket call's state comes from its previous_response_id chain instead.) The ETL's Anthropic
// adapter and the board both read it here. A Message Threads continuation read on its own carries only its delta:
// its earlier turns are in other records, so it is 'partial' here; the board's thread chain (cc-threads.mjs) reads
// it 'reconstructed' when every predecessor is in the capture.
export function contextStateOf(rec) {
  const stored = contextStateOfRequest(rec);
  if (stored) return stored;
  if (wireFormatOf(rec) !== 'anthropic') return 'complete';
  return isContinuation(rec) ? 'partial' : serverEdited(rec) ? 'server_edited' : 'complete';
}
