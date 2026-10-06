// src/dissect/registry.mjs — which WIRE FORMAT a record speaks (D37 ①: from the endpoint and the body,
// recorded per call; never from the UA or the harness). The board (src/view/assemble.mjs) and the ETL
// adapters both dispatch through this, so the two readers cannot disagree about what a record is.
// Leaf module.
import { detect as anthropicShape, serverEdited, CC_SECTIONS } from './cc.mjs';
import { contextStateOfRequest } from './capture-labels.mjs';
import { wireShape, RESPONSES, CHAT } from './openai.mjs';
import { isWsHandshake } from './ws-handshake.mjs';
import { RESPONSES_WS } from './openai-ws.mjs';

export { isWsHandshake };
const epPath = (rec) => String((rec && rec.endpoint) || '').split('?')[0];

// D37 ⑥: no dissector in v1 — stored as captured, read as 「未识别」 and labelled. Vertex first: its
// Gemini models also end in :generateContent.
const UNSUPPORTED = [
  ['vertex', /\/projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/[^/:]+:[A-Za-z]+$/],
  ['bedrock', /\/model\/[^/]+\/(invoke|invoke-with-response-stream|converse|converse-stream)$/],
  ['gemini', /:(stream)?[gG]enerateContent$/],
];
export function unsupportedOf(rec) {
  const ep = epPath(rec);
  for (const [name, re] of UNSUPPORTED) if (re.test(ep)) return name;
  return null;
}

// count_tokens: a ruler, not inference (3.2:134). Path rule; the querystring is ignored.
export const isProbeEndpoint = (rec) => epPath(rec).includes('count_tokens');

// → 'anthropic' | 'openai-responses' | 'openai-chat' | 'openai-responses-ws' | 'ws-handshake' | null.
// null = no registered wire claims these bytes (they are counted and labelled, never guessed at).
export function wireFormatOf(rec) {
  if (!rec) return null;
  const ep = epPath(rec);
  if (rec.transport === 'ws') return /(^|\/)responses$/.test(ep) ? 'openai-responses-ws' : null;
  if (isWsHandshake(rec)) return 'ws-handshake';
  if (unsupportedOf(rec) || isProbeEndpoint(rec)) return null;
  if (/(^|\/)v1\/messages$/.test(ep)) return 'anthropic';
  // The OpenAI dissector reads its endpoints AND refuses Anthropic bytes on them ("bytes beat path": a
  // gateway that posts an Anthropic body to /chat/completions is still the Anthropic wire). With no
  // recognizable endpoint (v0 fixtures, odd relays) the body shape alone decides.
  const shape = wireShape(rec);
  if (shape) return shape === 'chat' ? 'openai-chat' : 'openai-responses';
  return anthropicShape(rec) ? 'anthropic' : null;
}

// Board dissectors for the flat-lane wires (D25: dissector = adapter; the shared assembler only calls
// them). The Anthropic wire is assembled by the multi-lane analyzer (src/view/analyze.mjs), so it has no
// row here. Adding a wire = one dissector object + one row. The WebSocket row's object also carries the
// cross-record hooks (prepare / contextOf / admits / laneOf / failed, src/dissect/openai-ws.mjs).
const BOARD = { 'openai-responses': RESPONSES, 'openai-chat': CHAT, 'openai-responses-ws': RESPONSES_WS };
export function boardDissectorFor(rec) {
  return BOARD[wireFormatOf(rec)] || null;
}

// The request's top-level keys that become context blocks, per wire format; every other top-level key is a
// non-block key the board lists one by one (4.6 R2 「不成块的顶层键逐个列出」).
const ANTHROPIC_BLOCK_KEYS = Object.freeze(CC_SECTIONS.map((x) => x.id));
export function blockKeysOf(format) {
  if (format === 'anthropic') return ANTHROPIC_BLOCK_KEYS;
  return (BOARD[format] && BOARD[format].blockKeys) || [];
}

// 3.2:52 context_state of an HTTP-wire call: 'partial' when the stored request is incomplete (gate G17,
// capture-labels.mjs), 'server_edited' when an Anthropic response reports context edits, else 'complete'.
// (A WebSocket call's state comes from its previous_response_id chain instead.) The ETL's Anthropic
// adapter and the board both read it here.
export function contextStateOf(rec) {
  return contextStateOfRequest(rec) ?? (wireFormatOf(rec) === 'anthropic' && serverEdited(rec) ? 'server_edited' : 'complete');
}
