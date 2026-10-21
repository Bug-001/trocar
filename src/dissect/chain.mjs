// src/dissect/chain.mjs — what every cross-record context shares (3.1:60, D37 ②): a call that names its predecessor's reply
// (OpenAI WebSocket previous_response_id, Anthropic Message Threads previous_message_id) ran with the predecessor's whole
// stitched context, then the predecessor's reply, then its own delta.
//
// HELD BY LOCATOR, NOT BY RECORD (3.5 §内存有界). A plan names its predecessor's plan (`up`), its own segments (`own`) and its
// reply's (`out`); its context is segmentsOf(plan) = the chain's segments in order. A segment says where one item of a context
// lives: the record (`src`: its id and what its raw_ref is minted from), the field, the JSON path, the scan of that item kept only
// as deep as blocks are addressed (`node`, offsets absolute, so each block stays verbatim), and how to take the item out of the
// record again (`of`). A plan keeps no record and no item, so a session's chains cost locators, not stored bytes. The items are
// asked of createLinks(): the contexts of the newest chain tips are held (a continuation, and the calls a page shows, are prefixes
// of one), anything else is taken out of its records again, read back by id. Which items are held changes the cost, never the
// answer. Leaf module.
import { sessionKeyOf } from './harnesses.mjs';
import { scanJson, nodeAt, pruned } from './json-scan.mjs';

// How many chain tips keep their context in hand (a main thread, the subagents running beside it); older ones are read back.
const TIPS = 8;
// How far below its item a block is addressed (a content part of a message: ['content', j]).
const BLOCK_DEPTH = 2;

const SRC = new WeakMap();
/** The record a segment's bytes are in: its id and what its raw_ref (4.2:40) is minted from — never the record itself. */
export function sourceOf(rec) {
  if (!SRC.has(rec)) SRC.set(rec, { id: rec.id, stream: rec._stream, sid: sessionKeyOf(rec).key ?? rec._synthKey ?? null });
  return SRC.get(rec);
}
/** segmentsIn(rec, field, text) → seg(path, of, extra): the segments of one field of one record (the field is scanned once). */
export function segmentsIn(rec, field, text) {
  const src = sourceOf(rec);
  let root = null;
  try { root = typeof text === 'string' ? scanJson(text) : null; } catch { root = null; }
  return (path, of, extra) => ({ src, field, path, node: root ? pruned(nodeAt(root, path), BLOCK_DEPTH) : null, of, ...extra });
}

// → { up, own, contextState, missing }: 'reconstructed' when the whole chain is in the capture, else 'partial' with what is
// missing; a 'server_edited' predecessor passes its state on.
export function extendChain(up, own, missingWhenAbsent) {
  if (!up) return { up: null, own, contextState: 'partial', missing: missingWhenAbsent };
  return { up, own, contextState: up.contextState === 'partial' || up.contextState === 'server_edited' ? up.contextState : 'reconstructed',
    missing: up.missing || null };
}
/** A context with records it is stitched from that did not read back (createLinks items().missing) is partial, naming them. */
export function withUnread(state, missing, unread) {
  if (!unread.length) return { contextState: state, missing };
  const why = `record${unread.length > 1 ? 's' : ''} ${unread.join(', ')} that this context is stitched from did not read back`;
  return { contextState: 'partial', missing: missing ? `${missing}; ${why}` : why };
}
/** A plan made whole: how many segments its context has (`n`) and how far down its chain it is (`depth`). */
export const linked = (plan) => Object.assign(plan, { n: (plan.up ? plan.up.n + plan.up.out.length : 0) + plan.own.length, depth: plan.up ? plan.up.depth + 1 : 0 });

/** The segments of a plan's context, in order: each predecessor's own, then its reply, down to the plan's own. */
export function segmentsOf(plan) {
  const path = [];
  for (let p = plan; p; p = p.up) path.push(p);
  const segs = [];
  for (let i = path.length - 1; i >= 0; i--) { if (i < path.length - 1) segs.push(...path[i + 1].out); segs.push(...path[i].own); }
  return segs;
}

const lca = (a, b) => {
  while (a && b && a.depth > b.depth) a = a.up;
  while (a && b && b.depth > a.depth) b = b.up;
  while (a !== b) { a = a.up; b = b.up; }
  return a;
};
/**
 * createLinks(read) → { items(plan, rec, withOut), hold(plan, rec) }. items() = { items, segments, missing }: the items of plan's
 * context (and of its reply when `withOut`), in order, with the segment each came from: the longest prefix a held tip knows, then
 * the rest from `rec` (the record in hand) or from the records `read(ids)` yields (any order, one at a time). A segment whose
 * record did not read back is left out, and that record's id is in `missing` (the read failure itself is said in read's sink, D38).
 * hold() keeps a newly planned plan's context as a tip (never one with a gap). With no `read` (the batch forms, every record in
 * memory) every tip is held.
 */
export function createLinks(read = null) {
  const tips = new Map(); // tip plan → { items, out }
  function known(plan, withOut) {
    let best = [];
    for (const [t, v] of tips) {
      const x = lca(plan, t);
      if (!x) continue;
      const len = x === plan ? plan.n + (withOut ? plan.out.length : 0) : x.n + x.out.length;
      if (len > best.length) best = len <= v.items.length ? v.items.slice(0, len) : [...v.items, ...v.out.slice(0, len - v.items.length)];
    }
    return best;
  }
  function items(plan, rec = null, withOut = false) {
    const segs = segmentsOf(plan);
    if (withOut) segs.push(...plan.out);
    const got = known(plan, withOut);
    if (got.length === segs.length) return { items: got, segments: segs, missing: [] };
    const mine = (s) => rec && (s.src === SRC.get(rec) || (s.src.id != null && s.src.id === rec.id));
    const need = new Map(); // record id → the indexes of its segments
    for (let i = got.length; i < segs.length; i++) {
      if (mine(segs[i])) got[i] = segs[i].of(rec);
      else { const k = segs[i].src.id; if (!need.has(k)) need.set(k, []); need.get(k).push(i); }
    }
    if (need.size && read) for (const r of read([...need.keys()])) for (const i of need.get(r.id) || []) got[i] = segs[i].of(r);
    const missing = [...need.keys()].filter((k) => need.get(k).some((i) => got[i] === undefined));
    if (!missing.length) return { items: got, segments: segs, missing };
    const kept = segs.map((_, i) => i).filter((i) => got[i] !== undefined);
    return { items: kept.map((i) => got[i]), segments: kept.map((i) => segs[i]), missing };
  }
  function hold(plan, rec) {
    const ctx = items(plan, rec);
    if (ctx.missing.length) return;
    const v = { items: ctx.items, out: plan.out.map((s) => s.of(rec)) };
    for (const t of tips.keys()) if (lca(t, plan) === t) tips.delete(t); // plan's context holds theirs
    tips.set(plan, v);
    if (read) for (const t of tips.keys()) { if (tips.size <= TIPS) break; tips.delete(t); }
  }
  return { items, hold };
}
