// src/dissect/cc-threads.mjs — Anthropic Message Threads (3.1:35 / 3.1:60, D37 ②): the server keeps the
// conversation, so a continuation request carries only its delta.
//   head        body.thread = {type:'create'}: system, tools and messages in full
//   continuation body.thread = {type:'continue', previous_message_id}: the id of the predecessor's REPLY (its
//               message_start message.id); messages = the new delta only; system and tools usually left out
// The context a continuation ran with is RECONSTRUCTED across records:
//   messages(N) = stitched messages(N-1) ⧺ N-1's assistant reply ⧺ messages(N)
//   system(N)   = N's own system when it resends one with a cached (non-volatile) block, else the thread's system
//                 with N's own volatile blocks in place of the inherited ones (isVolatile: never in the cache key)
//   tools(N)    = N's own tools when non-empty, else the thread's
// Whether to stitch depends ONLY on thread.type === 'continue' (never on a model, a version or a beta header), and
// the predecessor is found by its reply id anywhere in the session's records: chains interleave (the main thread,
// one per subagent) and arrive in any order. A call without `thread` is its own whole context, as before.
// States (3.2:52): every predecessor in the capture = 'reconstructed'; one missing, so the inherited system / tools
// and earlier turns cannot be restored = 'partial', with what is missing. Bytes are untouched: request blocks are
// located in the record they came from (locate → req_body path); an assistant reply is assembled from the streamed
// reply, so it says where it came from instead of a byte span. Leaf module.
import { parsedRequestBody } from './request-body.mjs';
import { isVolatile, serverEdited } from './cc.mjs';
import { contextStateOfRequest } from './capture-labels.mjs';
import { extendChain } from './chain.mjs';

const bodyOf = (rec) => { const b = parsedRequestBody(rec); return b && typeof b === 'object' ? b : null; };

// → null (no thread) | { kind: 'create' | 'continue' | <other>, prevId }
export function threadOf(body) {
  const t = body && body.thread;
  if (!t || typeof t !== 'object') return null;
  const prevId = typeof t.previous_message_id === 'string' && t.previous_message_id ? t.previous_message_id : null;
  return { kind: String(t.type || ''), prevId };
}
export const isContinuation = (rec) => { const t = threadOf(bodyOf(rec)); return !!t && t.kind === 'continue'; };

// The reply of a call: its message id and content blocks (a streamed reply as the collector rebuilt it from the SSE,
// a JSON reply's body; an error envelope keeps what arrived under resp.partial).
const replyOf = (rec) => {
  const r = (rec && (rec.resp || rec.response)) || {};
  return r.kind === 'error' && r.partial && typeof r.partial === 'object' ? r.partial : r;
};
export function replyIdOf(rec) {
  const p = replyOf(rec);
  const id = (p.message && p.message.id) || (p.body && typeof p.body === 'object' && p.body.id);
  return typeof id === 'string' && id ? id : null;
}
function replySegs(rec) {
  const p = replyOf(rec);
  const content = p.kind === 'json' && p.body && Array.isArray(p.body.content) ? p.body.content : p.content_blocks;
  if (!Array.isArray(content) || !content.length) return [];
  return [{ rec, field: null, path: null, item: { role: 'assistant', content },
    why: `the assistant reply of record ${rec.id ?? '(no id)'}, rebuilt from its streamed response (resp.raw), not one byte span` }];
}

const own = (rec, body) => {
  const sys = body.system;
  const system = typeof sys === 'string' ? [{ rec, path: ['system'], item: { type: 'text', text: sys }, str: true }]
    : (Array.isArray(sys) ? sys : []).map((item, i) => ({ rec, path: ['system', i], item }));
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((item, i) => ({ rec, path: ['tools', i], item }));
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((item, i) => ({ rec, field: 'req_body', path: ['messages', i], item }));
  return { system, tools, messages };
};
const volatile = (s) => isVolatile('system', s.item);

// Plan = { thread, replyId, lineage, contextState, missing, system, tools, segments }, for every thread call.
function build(rec, body, thread, head) {
  const o = own(rec, body);
  const replyId = replyIdOf(rec);
  if (thread.kind !== 'continue') return { thread, replyId, lineage: replyId || String(rec.id), contextState: 'complete', missing: null, system: o.system, tools: o.tools, segments: o.messages };
  const absent = thread.prevId
    ? `message ${thread.prevId} (named by thread.previous_message_id) is the reply of no call in this capture, so the earlier turns and the system / tools the server kept for the thread are not known`
    : 'this call continues a thread but names no previous_message_id, so the earlier turns and the system / tools the server kept for the thread are not known';
  const hp = head && head.plan;
  const ext = extendChain(head, o.messages, absent);
  const system = o.system.some((s) => !volatile(s)) ? o.system : [...o.system, ...(hp ? hp.system.filter((s) => !volatile(s)) : [])];
  const tools = o.tools.length ? o.tools : (hp ? hp.tools : []);
  return { thread, replyId, lineage: hp ? hp.lineage : (thread.prevId || String(rec.id)), ...ext, system, tools };
}

// The board's batch form over one session's records (any order, any wire). → Map<rec, Plan> for thread calls.
export function threadPlan(records) {
  const byReply = new Map();
  const threaded = [];
  for (const r of records || []) {
    const b = bodyOf(r);
    if (!b || !Array.isArray(b.messages)) continue;
    const id = replyIdOf(r);
    if (id && !byReply.has(id)) byReply.set(id, r);
    if (threadOf(b)) threaded.push(r);
  }
  const plans = new Map();
  for (const r of threaded) {
    // walk back to a known plan, a head or a gap, then build forward (no recursion: a thread can be long)
    const path = [];
    const seen = new Set();
    let cur = r;
    while (cur && !plans.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      const t = threadOf(bodyOf(cur));
      cur = t && t.kind === 'continue' && t.prevId ? byReply.get(t.prevId) || null : null;
    }
    for (let k = path.length - 1; k >= 0; k--) {
      const rec = path[k], body = bodyOf(rec), t = threadOf(body);
      const pred = t.kind === 'continue' && t.prevId ? byReply.get(t.prevId) : null;
      const hp = pred && plans.get(pred);
      plans.set(rec, build(rec, body, t, hp ? { plan: hp, outputSegs: replySegs(pred) } : null));
    }
  }
  return plans;
}

// The request the model was given: the call's own body with system / tools / messages as stitched.
export function stitchedRequest(rec, plan) {
  return { ...(bodyOf(rec) || {}), system: plan.system.map((s) => s.item), tools: plan.tools.map((s) => s.item), messages: plan.segments.map((s) => s.item) };
}

// A board block of the stitched request (linearContext: tools ti, system si, messages mi/bi) → where its bytes are:
// { rec, field, path } in a req_body, or { rec, why } for a block assembled from a streamed reply.
export function locate(block, plan) {
  if (!block) return null;
  if (block.sec === 'tools' || block.sec === 'system') {
    const s = block.sec === 'tools' ? plan.tools[block.ti] : plan.system[block.si];
    return s ? { rec: s.rec, field: 'req_body', path: s.path } : null;
  }
  const seg = plan.segments[block.mi];
  if (!seg) return null;
  if (!seg.field) return { rec: seg.rec, why: seg.why };
  return { rec: seg.rec, field: seg.field, path: Array.isArray(seg.item.content) ? [...seg.path, 'content', block.bi] : [...seg.path, 'content'] };
}

// Tool definitions that enter the context: the tools array plus the ones added mid-conversation (a tool_addition
// block in a message, D37 ①: inline tools).
export function toolCountOf(req) {
  let n = Array.isArray(req && req.tools) ? req.tools.length : 0;
  for (const m of Array.isArray(req && req.messages) ? req.messages : [])
    for (const b of Array.isArray(m && m.content) ? m.content : []) if (b && b.type === 'tool_addition') n++;
  return n;
}

// The cross-record hooks the board's multi-lane assembler calls (same names as the WebSocket dissector's).
export const CC_THREADS = Object.freeze({
  prepare: (records) => threadPlan(records),
  // null for a call without `thread`: its own bytes are its context, read exactly as before
  contextOf: (rec, plans) => {
    const p = plans && plans.get(rec);
    if (!p) return null;
    const stored = contextStateOfRequest(rec);
    const contextState = stored || (p.contextState === 'partial' ? 'partial' : serverEdited(rec) ? 'server_edited' : p.contextState);
    return { req: stitchedRequest(rec, p), contextState, missing: p.missing, lineage: p.lineage, continued: p.thread.kind === 'continue',
      locate: (b) => locate(b, p) };
  },
  toolCountOf,
});
