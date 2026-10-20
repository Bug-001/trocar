// src/dissect/cc-threads.mjs — Anthropic Message Threads (3.1:35 / 3.1:60, D37 ②): the server keeps the
// conversation, so a continuation request carries only its delta.
//   head        body.thread = {type:'create'}: system, tools and messages in full
//   continuation body.thread = {type:'continue', previous_message_id}: the id of the predecessor's REPLY (its
//               message_start message.id); messages = the new delta only; system and tools usually left out
// The context a continuation ran with is RECONSTRUCTED across records:
//   messages(N) = stitched messages(N-1) ⧺ N-1's assistant reply ⧺ messages(N)
//   system(N)   = N's own system when it resends one with a cached (non-volatile) block, else the thread's system
//                 with N's own volatile blocks in the inherited ones' places (isVolatile: never in the cache key);
//                 N sends no system at all = the thread's whole system
//   tools(N)    = N's own tools when non-empty, else the thread's
// Whether to stitch depends ONLY on thread.type === 'continue' (never on a model, a version or a beta header), and
// the predecessor is found by its reply id among the session's thread calls planned before it: chains interleave (the
// main thread, one per subagent), and a predecessor was sent before its continuation (it had to have replied), so in
// step order (ts_request) every predecessor comes first. A call without `thread` is its own whole context, as before.
// States (3.2:52): every predecessor in the capture with a whole reply = 'reconstructed'; one missing, its reply
// incomplete, its own context partial or its thread.type unknown = 'partial', with what is missing; a server-edited
// context anywhere up the chain = 'server_edited'. Bytes are untouched: request blocks are
// located in the record they came from (locate → req_body path); an assistant reply is assembled from the streamed
// reply, so it says where it came from instead of a byte span. Leaf module.
import { parsedRequestBody } from './request-body.mjs';
import { isVolatile, serverEdited } from './cc.mjs';
import { contextStateOfRequest, respIncompleteOf } from './capture-labels.mjs';
import { extendSegments as extendChain } from './chain.mjs';

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

// Why a predecessor does not hand its successor a whole context (3.2:52, invariant 4, D38): its reply did not
// fully arrive, so the turn the server appended to the thread is not known in full. → reason | null
function replyGap(pred) {
  const id = `record ${pred.id ?? '(no id)'}`;
  const r = (pred.resp || pred.response) || {};
  if (r.kind === 'error') return `the reply of ${id} ended in an error: only what arrived before it is known`;
  const inc = respIncompleteOf(pred);
  if (inc) return `the reply of ${id} is incomplete (${inc.text})`;
  if (!replySegs(pred).length) return `the reply of ${id} has no content blocks, so what the model answered is not known`;
  return null;
}
// The call's own state on top of its chain's: a request stored only in part, a context the server edited.
function finish(rec, plan) {
  if (plan.contextState !== 'partial' && contextStateOfRequest(rec))
    return { ...plan, contextState: 'partial', missing: `the request body of record ${rec.id ?? '(no id)'} is stored only in part` };
  if (plan.contextState !== 'partial' && serverEdited(rec)) return { ...plan, contextState: 'server_edited' };
  return plan;
}

// Plan = { thread, replyId, lineage, contextState, missing, system, tools, segments }, for every thread call.
function build(rec, body, thread, head) {
  const o = own(rec, body);
  const replyId = replyIdOf(rec);
  if (thread.kind !== 'continue') {
    const known = thread.kind === 'create';
    return finish(rec, { thread, replyId, lineage: replyId || String(rec.id), contextState: known ? 'complete' : 'partial',
      missing: known ? null : `thread.type ${JSON.stringify(thread.kind)} is neither create nor continue, so whether the server added earlier context is not known`,
      system: o.system, tools: o.tools, segments: o.messages });
  }
  const absent = thread.prevId
    ? `message ${thread.prevId} (named by thread.previous_message_id) is the reply of no call in this capture, so the earlier turns and the system / tools the server kept for the thread are not known`
    : 'this call continues a thread but names no previous_message_id, so the earlier turns and the system / tools the server kept for the thread are not known';
  const hp = head && head.plan;
  let { segments, contextState, missing } = extendChain(head, o.messages, absent);
  const gap = head && replyGap(head.pred);
  if (gap) { contextState = 'partial'; missing = missing ? `${missing}; ${gap}` : gap; }
  // the call's volatile blocks (never in the cache key) take the inherited volatile blocks' places; none sent → the thread's
  let system = o.system;
  if (hp && !o.system.length) system = hp.system;
  else if (hp && o.system.every(volatile)) {
    const mine = [...o.system];
    const kept = hp.system.flatMap((s) => (!volatile(s) ? [s] : mine.length ? [mine.shift()] : []));
    system = [...mine, ...kept];
  }
  const tools = o.tools.length ? o.tools : (hp ? hp.tools : []);
  return finish(rec, { thread, replyId, lineage: hp ? hp.lineage : (thread.prevId || String(rec.id)), segments, contextState, missing, system, tools });
}

// The planner the board's assembler folds a session through, one record at a time in step order (3.5 §内存有界):
// get(rec) → the call's Plan, or null for a call without `thread`. It keeps the thread calls (a continuation's context is
// built from them) and nothing else.
export function threadPlanner() {
  const byReply = new Map(); // reply id → the thread call that replied with it
  const plans = new WeakMap();
  return {
    get(rec) {
      if (plans.has(rec)) return plans.get(rec);
      const b = bodyOf(rec), t = b && Array.isArray(b.messages) ? threadOf(b) : null;
      let plan = null;
      if (t) {
        const pred = t.kind === 'continue' && t.prevId ? byReply.get(t.prevId) : null;
        plan = build(rec, b, t, pred ? { plan: plans.get(pred), outputSegs: replySegs(pred), pred } : null);
        const id = replyIdOf(rec);
        if (id && !byReply.has(id)) byReply.set(id, rec);
      }
      plans.set(rec, plan);
      return plan;
    },
  };
}
const stepOrder = (a, b) => String(a.ts_request).localeCompare(String(b.ts_request)) || String(a.id).localeCompare(String(b.id));
// The batch form over one session's records, in any order. → Map<rec, Plan> for thread calls.
export function threadPlan(records) {
  const p = threadPlanner(), plans = new Map();
  for (const r of [...(records || [])].sort(stepOrder)) { const plan = p.get(r); if (plan) plans.set(r, plan); }
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

// Tool definitions in the context: the tools array plus the ones added mid-conversation, less the ones removed
// (tool_addition / tool_removal blocks in a message, D37 ①: inline tools).
export function toolCountOf(req) {
  let n = Array.isArray(req && req.tools) ? req.tools.length : 0;
  for (const m of Array.isArray(req && req.messages) ? req.messages : [])
    for (const b of Array.isArray(m && m.content) ? m.content : []) n += b && b.type === 'tool_addition' ? 1 : b && b.type === 'tool_removal' ? -1 : 0;
  return Math.max(0, n);
}

// The cross-record hooks the board's multi-lane assembler calls (same names as the WebSocket dissector's).
export const CC_THREADS = Object.freeze({
  prepare: () => threadPlanner(),
  // null for a call without `thread`: its own bytes are its context, read exactly as before
  contextOf: (rec, plans) => {
    const p = plans && plans.get(rec);
    if (!p) return null;
    return { req: stitchedRequest(rec, p), contextState: p.contextState, missing: p.missing, lineage: p.lineage, continued: p.thread.kind === 'continue',
      locate: (b) => locate(b, p) };
  },
  toolCountOf,
});
