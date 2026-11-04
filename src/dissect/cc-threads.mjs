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
import { createHash } from 'node:crypto';
import { parsedRequestBody } from './request-body.mjs';
import { isVolatile, serverEdited } from './cc.mjs';
import { contextStateOfRequest, respIncompleteOf } from './capture-labels.mjs';
import { extendChain, linked, segmentsIn, sourceOf, createLinks, withUnread } from './chain.mjs';

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
const replyContent = (rec) => {
  const p = replyOf(rec);
  const content = p.kind === 'json' && p.body && Array.isArray(p.body.content) ? p.body.content : p.content_blocks;
  return Array.isArray(content) && content.length ? content : null;
};
const replyItem = (r) => ({ role: 'assistant', content: replyContent(r) });
function replySegs(rec) {
  if (!replyContent(rec)) return [];
  return [{ src: sourceOf(rec), field: null, path: null, node: null, of: replyItem,
    why: `the assistant reply of record ${rec.id ?? '(no id)'}, rebuilt from its streamed response, not one byte span` }];
}

// A call's own system, tools and messages, located in its req_body. System and tools keep their items (a continuation inherits
// them whole); a message is taken out of the record again when it is needed (chain.mjs). How is made at module level, so it closes
// over nothing of the record (a closure here would keep the record alive with the segment).
const systemText = (r) => ({ type: 'text', text: bodyOf(r).system });
const at = (key, i) => (r) => bodyOf(r)[key][i];
// An item that is the same bytes as one a call of this session already sent is that call's parsed item: Claude Code resends its
// system and tools with every call, and held once per call they were most of what a session's spine cost (3.5 §内存有界). Keyed
// by a digest of the item's bytes, never the bytes (a slice of the body would keep the whole body). Parsed items are read-only.
function sharing() {
  const byDigest = new Map();
  return (text, node, item) => {
    if (!node || !item || typeof item !== 'object') return item;
    const k = createHash('sha256').update(text.slice(node.start, node.end)).digest('base64');
    const had = byDigest.get(k);
    if (had !== undefined) return had;
    byDigest.set(k, item);
    return item;
  };
}
const own = (rec, body, share) => {
  const seg0 = segmentsIn(rec, 'req_body', rec.req_body);
  // a system or tools item is one block (locate: no path below it), so its span is all its segment keeps
  const seg = (path, of, item) => { const s = seg0(path, of, undefined, 0); s.item = share(rec.req_body, s.node, item); return s; };
  const sys = body.system;
  const system = typeof sys === 'string' ? [seg(['system'], systemText, { type: 'text', text: sys })]
    : (Array.isArray(sys) ? sys : []).map((item, i) => seg(['system', i], at('system', i), item));
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((item, i) => seg(['tools', i], at('tools', i), item));
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((m, i) => seg0(['messages', i], at('messages', i), { arr: Array.isArray(m && m.content) }));
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
  if (!replyContent(pred)) return `the reply of ${id} has no content blocks, so what the model answered is not known`;
  return null;
}
// The call's own state on top of its chain's: a request stored only in part, a context the server edited.
function finish(rec, plan) {
  if (plan.contextState !== 'partial' && contextStateOfRequest(rec))
    return { ...plan, contextState: 'partial', missing: `the request body of record ${rec.id ?? '(no id)'} is stored only in part` };
  if (plan.contextState !== 'partial' && serverEdited(rec)) return { ...plan, contextState: 'server_edited' };
  return plan;
}

// What a thread call's own bytes say about its chain, shared by the planner below and the id-level stitch (stitchOf):
// why its predecessor is unknown when it is absent, a head's own state, and which of system / tools it inherits (3.1:35).
const absentWhy = (thread) => (thread.prevId
  ? `message ${thread.prevId} (named by thread.previous_message_id) is the reply of no call in this capture, so the earlier turns and the system / tools the server kept for the thread are not known`
  : 'this call continues a thread but names no previous_message_id, so the earlier turns and the system / tools the server kept for the thread are not known');
const headState = (thread) => (thread.kind === 'create' ? { contextState: 'complete', missing: null }
  : { contextState: 'partial', missing: `thread.type ${JSON.stringify(thread.kind)} is neither create nor continue, so whether the server added earlier context is not known` });
/** inherit(body) → { system, tools }: 'own' (the call's own), 'inherit' (the predecessor's whole) or, for system, 'patch' (the
 *  predecessor's, with the call's own volatile blocks in the inherited volatile blocks' places). */
export function inherit(body) {
  const sys = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [];
  return { tools: Array.isArray(body.tools) && body.tools.length ? 'own' : 'inherit',
    system: !sys.length ? 'inherit' : sys.every((s) => isVolatile('system', s)) ? 'patch' : 'own' };
}
/** patchSystem(inherited, own, isVol) → the system a 'patch' call ran with: own volatile entries take the inherited volatile
 *  entries' places in order; own ones left over go first. Works on any entries (segments here, block ids in extraction). */
export function patchSystem(inherited, own, isVol) {
  const sent = [...own];
  const kept = inherited.flatMap((s) => (!isVol(s) ? [s] : sent.length ? [sent.shift()] : []));
  return [...sent, ...kept];
}

// Plan = { thread, replyId, lineage, contextState, missing, system, tools, up, own, out, gap } for every thread call (chain.mjs);
// `hp` = the predecessor's plan. `gap`: why this call's reply does not hand a successor a whole context, or null.
function build(rec, body, thread, hp, share) {
  const o = own(rec, body, share);
  const mine = { thread, replyId: replyIdOf(rec), out: replySegs(rec), gap: replyGap(rec) };
  if (thread.kind !== 'continue')
    return finish(rec, { ...mine, lineage: mine.replyId || String(rec.id), ...headState(thread), system: o.system, tools: o.tools, up: null, own: o.messages });
  let { up, contextState, missing } = extendChain(hp, o.messages, absentWhy(thread));
  if (hp && hp.gap) { contextState = 'partial'; missing = missing ? `${missing}; ${hp.gap}` : hp.gap; }
  const how = inherit(body);
  const system = !hp || how.system === 'own' ? o.system : how.system === 'inherit' ? hp.system : patchSystem(hp.system, o.system, volatile);
  const tools = how.tools === 'own' || !hp ? o.tools : hp.tools;
  return finish(rec, { ...mine, lineage: hp ? hp.lineage : (thread.prevId || String(rec.id)), up, own: o.messages, contextState, missing, system, tools });
}

// The planner the board's assembler folds a session through, one record at a time in step order (3.5 §内存有界):
// get(rec) → the call's Plan, or null for a call without `thread`; context(rec) → the request the model was given (the call's own
// body with system / tools / messages as stitched) with each block located, or null. A record read back later (by id) gets the
// plan it was given. `read` as chain.mjs createLinks.
export function threadPlanner(read = null) {
  const byReply = new Map(); // reply id → the plan of the thread call that replied with it
  const plans = new Map(); // record id (the record itself when it has none) → plan | null
  const links = createLinks(read);
  const share = sharing();
  const keyOf = (rec) => rec.id ?? rec;
  function get(rec) {
    if (plans.has(keyOf(rec))) return plans.get(keyOf(rec));
    const b = bodyOf(rec), t = b && Array.isArray(b.messages) ? threadOf(b) : null;
    let plan = null;
    if (t) {
      plan = linked(build(rec, b, t, t.kind === 'continue' && t.prevId ? byReply.get(t.prevId) || null : null, share));
      if (plan.replyId && !byReply.has(plan.replyId)) byReply.set(plan.replyId, plan);
      links.hold(plan, rec);
    }
    plans.set(keyOf(rec), plan);
    return plan;
  }
  return {
    get,
    context(rec) {
      const p = get(rec);
      if (!p) return null; // a call without `thread`: its own bytes are its context, read exactly as before
      const { items, segments, missing } = links.items(p, rec);
      return { req: { ...(bodyOf(rec) || {}), system: p.system.map((s) => s.item), tools: p.tools.map((s) => s.item), messages: items },
        ...withUnread(p.contextState, p.missing, missing), lineage: p.lineage, continued: p.thread.kind === 'continue', segments,
        locate: (b) => locate(b, p, segments) };
    },
  };
}
// A board block of the stitched request (linearContext: tools ti, system si, messages mi/bi) → where its bytes are: the record,
// field and scan (`node`) of its segment with the path below it (`sub`), or { src, why } for a block assembled from a streamed reply.
export function locate(block, plan, segments) {
  if (!block) return null;
  if (block.sec === 'tools' || block.sec === 'system') {
    const s = block.sec === 'tools' ? plan.tools[block.ti] : plan.system[block.si];
    return s ? { src: s.src, field: 'req_body', node: s.node, sub: [] } : null;
  }
  const seg = segments[block.mi];
  if (!seg) return null;
  if (!seg.field) return { src: seg.src, why: seg.why };
  return { src: seg.src, field: seg.field, node: seg.node, sub: seg.arr ? ['content', block.bi] : ['content'] };
}

// Tool definitions in the context: the tools array plus the ones added mid-conversation, less the ones removed
// (tool_addition / tool_removal blocks in a message, D37 ①: inline tools).
export function toolCountOf(req) {
  let n = Array.isArray(req && req.tools) ? req.tools.length : 0;
  for (const m of Array.isArray(req && req.messages) ? req.messages : [])
    for (const b of Array.isArray(m && m.content) ? m.content : []) n += b && b.type === 'tool_addition' ? 1 : b && b.type === 'tool_removal' ? -1 : 0;
  return Math.max(0, n);
}

// stitchOf(rec): what the id-level stitch (src/view/extract.mjs) needs of one record, read from it alone; null for a call without
// `thread`. cont: it continues a chain; prev: the reply id it names; scope: where that id is looked up (the session); link: the id
// a successor names it by; gap: why its reply does not hand a successor a whole context; absent: why its context is partial when
// its predecessor is not found; head: a head's own state; inherit: as inherit(); settle(state): the call's own state on top.
function stitchOf(rec) {
  const b = bodyOf(rec), t = b && Array.isArray(b.messages) ? threadOf(b) : null;
  if (!t) return null;
  const cont = t.kind === 'continue';
  return { cont, prev: cont ? t.prevId : null, scope: '', link: replyIdOf(rec), gap: replyGap(rec), absent: cont ? absentWhy(t) : null,
    head: cont ? null : headState(t), inherit: inherit(b), settle: (s) => finish(rec, s) };
}

// The cross-record hooks the board's multi-lane assembler calls (same names as the WebSocket dissector's).
export const CC_THREADS = Object.freeze({
  prepare: (read) => threadPlanner(read),
  stitchOf,
  toolCountOf,
});
