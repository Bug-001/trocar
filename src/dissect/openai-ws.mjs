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
import { boardFlat, reqCountsFor, ctxTokens, normEvents, faithfulness, itemToBlocks } from './openai.mjs';
import { scanJson, spanAt } from './json-scan.mjs';
import { storedReply, noSpanWhy, replyPart, partsOfUnit } from './sse-spans.mjs';
import { isWsHandshake } from './ws-handshake.mjs'; // not ./registry.mjs: the registry imports THIS module
import { headerOf } from './harnesses.mjs';
import { extendChain, linked, segmentsIn, createLinks, withUnread } from './chain.mjs';

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

// The segments of a call's own input: a string input is one user message, exactly as the server reads it (its bytes are the
// whole JSON string); else one per input item. How a segment's item is taken out of its record again is made at module level,
// so it closes over nothing of the record it came from (a closure here would keep the record alive with the segment).
const inputString = (r) => ({ role: 'user', content: bodyOf(r).input });
const inputAt = (i) => (r) => bodyOf(r).input[i];
const outputAt = (j, i) => (r) => parse(serverMessages(r)[j]).response.output[i];
function ownSegments(rec, b) {
  const seg = segmentsIn(rec, 'req_body', rec.req_body);
  if (typeof b.input === 'string') return [seg(['input'], inputString, { whole: true })];
  return (Array.isArray(b.input) ? b.input : []).map((_, i) => seg(['input', i], inputAt(i)));
}
// The segments of a completed response's output (message j of the call's server messages), or none.
function outputSegments(rec, done) {
  if (!done) return [];
  const seg = segmentsIn(rec, `resp.messages.${done.j}`, serverMessages(rec)[done.j]);
  const output = Array.isArray(done.e.response.output) ? done.e.response.output : [];
  return output.map((_, i) => seg(['response', 'output', i], outputAt(done.j, i)));
}
const completed = (rec) => { const t = terminalOf(rec); return t && t.e.type === 'response.completed' && t.e.response && typeof t.e.response.id === 'string' ? t : null; };

const absentWhy = (prevId) => `response ${prevId} (named by previous_response_id) is not a completed response in this capture of the connection`;
// A continuation's own state on top of its chain's: the collector's own `partial` (a gap earlier on the connection, 3.1:60).
const settled = (rec, p) => (rec.partial === true
  ? Object.assign(p, { contextState: 'partial', missing: p.missing || `the collector saw a gap earlier on this connection (${(rec.partial_reasons || []).join(', ') || 'partial'})` })
  : p);
const prevIdOf = (b) => (typeof b.previous_response_id === 'string' && b.previous_response_id ? b.previous_response_id : null);

// The chain, one record at a time (the ETL reads a stream; 4.2 incremental). createChain(read) → { plan(rec), context(rec) }.
// plan(rec) → Plan | null (not a call); Plan = { role, prevId, responseId, contextState, missing, up, own, out } (chain.mjs). A
// connection's records MUST arrive in seq order: file order gives that, since the collector writes a call's envelope when its
// terminal message arrives and one connection carries one response at a time (a continuation read before its predecessor
// reads as partial). A record read back later (by id) gets the plan it was given. `read` as chain.mjs createLinks.
export function createChain(read = null) {
  const conns = new Map(); // connOf → (response id → plan): only a response.completed can be continued
  const plans = new Map(); // record id (the record itself when it has none) → plan | null
  const links = createLinks(read);
  const keyOf = (rec) => rec.id ?? rec;
  function plan(rec) {
    if (plans.has(keyOf(rec))) return plans.get(keyOf(rec));
    const role = roleOf(rec);
    if (role !== 'call' && role !== 'warmup' && role !== 'unstored') { plans.set(keyOf(rec), null); return null; }
    const k = connOf(rec);
    if (!conns.has(k)) conns.set(k, new Map());
    const heads = conns.get(k);
    const done = completed(rec);
    let p;
    if (role === 'unstored') {
      // no input is known, so no context: partial, and a continuation of its response is partial too
      const why = unstoredRequestOf(rec);
      p = { up: null, own: [], contextState: 'partial', missing: why, unstored: why };
    } else {
      const b = bodyOf(rec);
      const prevId = prevIdOf(b);
      p = { up: null, own: ownSegments(rec, b), contextState: 'complete', missing: null };
      if (prevId) {
        p = settled(rec, extendChain(heads.get(prevId) || null, p.own, absentWhy(prevId)));
      }
      p.prevId = prevId;
    }
    p = linked(Object.assign(p, { role, responseId: done ? done.e.response.id : null, out: outputSegments(rec, done) }));
    plans.set(keyOf(rec), p);
    if (done) heads.set(p.responseId, p);
    links.hold(p, rec);
    return p;
  }
  return {
    plan,
    // the request the model was given: the call's own body with `input` replaced by the stitched input; each stitched block
    // located in the record and field its bytes came from
    context(rec) {
      const p = plan(rec);
      if (!p) return null;
      const { items, segments, missing } = links.items(p, rec);
      return { req: { ...(bodyOf(rec) || {}), input: items }, ...withUnread(p.contextState, p.missing, missing), segments,
        locate: (blk) => locate(blk, rec, segments), ...(p.unstored ? { unrenderable: p.unstored } : {}) };
    },
  };
}

// A board block of the stitched request → where its bytes are: the call's own record for what is not stitched (instructions,
// tools), else the segment's record, field and scan (`node`) with the path below it (`sub`).
export function locate(block, rec, segments) {
  const p = Array.isArray(block && block.path) ? block.path : null;
  if (!p) return null;
  if (p[0] !== 'input') return { rec, field: 'req_body', path: p };
  const seg = typeof p[1] === 'number' ? segments[p[1]] : null;
  if (!seg) return null;
  return { src: seg.src, field: seg.field, node: seg.node, sub: seg.whole ? [] : p.slice(2) };
}

// The reply, from the server messages. Messages that are not JSON text ({b64}, {omitted_bytes}, a parse
// failure) cannot be read; they are counted in `unread`, never dropped without a trace.
export function normRespWs(rec) {
  const events = [];
  let unread = 0;
  for (const m of serverMessages(rec)) { const e = parse(m); if (e) events.push(e); else unread++; }
  return { ...normEvents(events), unread };
}

// The reply's blocks as addressable parts (sse-spans.mjs): the server message that closes an item
// (response.output_item.done) holds it whole, so its span is the `item` node inside that message, field resp.messages.<j>.
// Each part carries `unit`, the output item it is a block of (one item = one message of a successor's context). A stream whose
// items no message closed has them in its response.completed: there the span is the item's node in that message's output.
export function replyPartsWs(rec) {
  const out = [];
  let unit = 0;
  const push = (item, m, j, path) => {
    let span = null;
    try { span = spanAt(scanJson(m), path); } catch { /* parsed, so scannable */ }
    out.push(...partsOfUnit(itemToBlocks(item).map((x) => x.block), `resp.messages.${j}`, span, 'the item could not be located in its message').map((p) => ({ ...p, unit })));
    unit++;
  };
  serverMessages(rec).forEach((m, j) => {
    const e = parse(m);
    if (e && e.type === 'response.output_item.done' && e.item && typeof e.item === 'object') push(e.item, m, j, ['item']);
  });
  const done = out.length ? null : completed(rec);
  if (done) (Array.isArray(done.e.response.output) ? done.e.response.output : []).forEach((item, i) => push(item, serverMessages(rec)[done.j], done.j, ['response', 'output', i]));
  if (out.length) return out;
  const { r, part } = storedReply(rec);
  return [replyPart(null, null, null, r && serverMessages(rec).length ? 'no server message closed an output item' : noSpanWhy(r, part || {}))];
}

// stitchOf(rec) → what the id-level stitch (src/view/extract.mjs) needs of one record, read from it alone (as CC_THREADS.stitchOf);
// null when it is no call. A response is continued on its own connection only, and only once it completed.
function stitchOf(rec) {
  const role = roleOf(rec);
  if (role !== 'call' && role !== 'warmup' && role !== 'unstored') return null;
  const done = completed(rec);
  const base = { scope: connOf(rec), link: done ? done.e.response.id : null, gap: null, inherit: { system: 'own', tools: 'own' } };
  if (role === 'unstored') { const why = unstoredRequestOf(rec); return { ...base, cont: false, prev: null, unstored: why, head: { contextState: 'partial', missing: why }, settle: (s) => s }; }
  const prev = prevIdOf(bodyOf(rec));
  return { ...base, cont: !!prev, prev, absent: prev ? absentWhy(prev) : null, head: { contextState: 'complete', missing: null },
    settle: (s) => (prev ? settled(rec, { ...s }) : s) };
}

// The dissector object the board's flat-lane assembler calls (D25: the shared layer names no wire; the
// registry registers this under 'openai-responses-ws'). prepare (→ a planner whose context(rec) stitches) / roleOf / laneOf / agentOf / failed are the hooks a
// wire with a cross-record context provides.
export const RESPONSES_WS = Object.freeze({
  id: 'openai-responses-ws', provider: 'openai', blockKeys: ['tools', 'instructions', 'input'],
  roleOf,
  consumedBody: ['type', 'model', 'stream', 'instructions', 'tools', 'input', 'previous_response_id', 'generate'],
  faithfulnessOf: (b) => faithfulness(b && b.block),
  // one record at a time, in step order: a connection's calls are sequential, so step order is its seq order
  prepare: (read) => createChain(read),
  stitchOf, // the id-level stitch's view of one record (as CC_THREADS.stitchOf; instructions and tools are always the call's own)
  admits: (rec) => { const r = roleOf(rec); return r === 'call' || r === 'warmup' || r === 'unstored'; },
  laneOf: (rec) => (roleOf(rec) === 'warmup' ? 'probe' : null), // W3: a warmup is lane probe, not a turn
  agentOf: connOf, // one connection carries one agent's conversation: a subagent is folded by its own (3.5 §缓存)
  boardFlat: (req) => boardFlat(req),
  normResp: (rec) => normRespWs(rec),
  replyParts: (rec) => replyPartsWs(rec),
  reqCounts: (req) => reqCountsFor('responses', req),
  ctxTokens,
  // a call failed when its terminal says so, or when no terminal arrived at all (the connection cut it)
  failed: (norm, rec) => norm.stop_reason === 'error' || norm.stop_reason === 'failed' || !!(rec && rec.error),
});
