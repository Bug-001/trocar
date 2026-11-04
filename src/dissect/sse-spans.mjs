// src/dissect/sse-spans.mjs — reply blocks as addressable spans of the stored reply (spec 4.2:61 text_ref field segment
// resp.raw; reply blocks get resp.raw::a-b, RFC 3.1). One generic rule for every SSE wire: each event
// gets a block key from the wire's own field (the wire says which, through `keysOf`); a block's span runs from the start
// of its first event to the end of its last. When an event with another key lies inside that range (an interleaved
// stream), no contiguous exact span exists: the span is null and says why (invariant 4). A wire whose closing event carries
// the item whole as one JSON value addresses each block as its own JSON node in that event's data instead (RFC 3.1).
// Offsets are JS string indexes into the field text (fieldTextOf), as every text_ref is. No product, model or version knowledge.
// Leaf module.
import { fieldTextOf } from './record-fields.mjs';
import { scanJson, spanAt } from './json-scan.mjs';

// SSE text → its events, each its lines up to and including the blank line that ends it. `start` = offset of its first
// line, `end` = offset after the terminating blank line (or the text end), `data` = the joined `data:` payload or null,
// `dataAt` = where `data` stands in the text when it is one `data:` line (else null).
export function sseEvents(text) {
  const out = [];
  const s = typeof text === 'string' ? text : '';
  let cur = null;
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    const next = nl === -1 ? s.length : nl + 1;
    const line = s.slice(i, nl === -1 ? s.length : nl).replace(/\r$/, '');
    if (line === '') { if (cur) { cur.end = next; out.push(cur); cur = null; } }
    else {
      if (!cur) cur = { start: i, end: s.length, data: null, dataAt: null, _d: [] };
      if (line.startsWith('data:')) { cur.dataAt = i + (line[5] === ' ' ? 6 : 5); cur._d.push(line.slice(5).replace(/^ /, '')); }
    }
    i = next;
  }
  if (cur) out.push(cur);
  for (const e of out) { e.data = e._d.length ? e._d.join('\n') : null; if (e._d.length !== 1) e.dataAt = null; delete e._d; }
  return out;
}

const parse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } };
// the stored reply: an error envelope keeps what arrived under resp.partial (as respRefsOf and fieldTextOf read it)
export function storedReply(rec) {
  const r = (rec && (rec.resp || rec.response)) || null;
  if (!r) return { r: null, part: null };
  return { r, part: r.kind === 'error' && r.partial && typeof r.partial === 'object' ? r.partial : r };
}
// why a stored reply has no streamed text to point into (the reasons respRefsOf gives for the same envelope states)
export function noSpanWhy(r, part) {
  if (!r) return 'no response is recorded for this call';
  if (part.body !== undefined) return 'a JSON reply is not streamed: its blocks are read from the parsed body, which has no span per block';
  if (typeof part.raw_b64 === 'string') return part.encoding_error ? `could not be decoded (${part.encoding_error}); kept as base64 in the record` : 'not UTF-8 text; kept as base64 in the record';
  if (part.kind === 'empty') return 'the reply had no body';
  if (typeof part.raw === 'string') return 'the reply is not an event stream';
  return r.kind === 'error' ? 'no reply bytes arrived before the exchange failed' : 'no reply text is stored in this record';
}
const INTERLEAVED = 'its events interleave with another block\'s events in the stream, so no single contiguous span holds only this block';
const FANNED = 'one streamed item carries several blocks; the span would hold all of them, not this block alone';

// `events`: how many stream events the span holds of this block (a part cut from an event range, 3.1 回复块也回源).
export const replyPart = (block, field, span, why, events) => ({ kind: block ? block.type : null, role: 'assistant', block, field, span, ...(span ? {} : { why }), ...(span && events ? { events } : {}) });
// Blocks as JSON nodes of one JSON value: `nodes` [{block, path}], `root` that value's scan (null: not scannable), standing at
// offset `at` of `field`'s text. Each block's span is its own node (RFC 3.1 回复块也回源).
const UNLOCATED = 'the block could not be located in the JSON that carries it';
export const nodeParts = (nodes, root, field, at) => nodes.map(({ block, path }) => {
  const s = root && spanAt(root, path);
  return replyPart(block, field, s && [at + s[0], at + s[1]], UNLOCATED);
});
export const scanned = (text) => { try { return typeof text === 'string' ? scanJson(text) : null; } catch { return null; } };
// Many blocks from one addressable unit: a span only when it holds exactly one block.
export const partsOfUnit = (blocks, field, span, why, events) => blocks.map((b) => (blocks.length === 1 ? replyPart(b, field, span, why, events) : replyPart(b, field, null, span ? FANNED : why)));

// rec → [{kind, role, block, field, span, why?}] in reply order, for an SSE wire described by:
//   keysOf(evt) → the block keys an event carries (from the wire's own fields)
//   build(key, evts, all, part) → that key's blocks (cross-provider vocabulary), or a string saying why it has none, or
//     { evt, nodes: [{block, path}] }: `evt`, one of `all`, holds the blocks whole as JSON nodes of its data, each at `path`;
//     when that data is not one JSON value on one `data:` line, the blocks fall back to the key's event range
//   jsonBlocks(body) → the blocks of a non-streamed JSON reply
// The events are read from resp.raw; a stream stored without its text (base64) is read from raw_sse, without spans.
export function streamParts(rec, { keysOf, build, jsonBlocks }) {
  const { r, part } = storedReply(rec);
  const f = r ? fieldTextOf(rec, 'resp.raw') : { missing: true };
  const isSse = part && part.kind === 'sse';
  let events = null;
  if (isSse && f.text != null) events = sseEvents(f.text).map((e) => ({ ...e, evt: e.data == null ? null : parse(e.data) }));
  else if (isSse && Array.isArray(part.raw_sse)) events = part.raw_sse.map((evt) => ({ evt }));
  const why = noSpanWhy(r, part || {});
  if (!events) {
    const blocks = part && part.body && typeof part.body === 'object' ? jsonBlocks(part.body) : [];
    return blocks.length ? blocks.map((b) => replyPart(b, null, null, why)) : [replyPart(null, null, null, why)];
  }
  const field = f.text != null ? 'resp.raw' : null;
  const groups = new Map(); // key → event positions, in first-appearance order
  const keys = events.map((e) => (e.evt ? keysOf(e.evt) : []));
  keys.forEach((ks, i) => { for (const k of ks) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); } });
  const all = events.map((e) => e.evt);
  const out = [], roots = new Map(); // event position → its scanned data (a terminal holds many items: scanned once)
  const rootAt = (i) => { if (!roots.has(i)) roots.set(i, field && events[i].dataAt != null ? scanned(events[i].data) : null); return roots.get(i); };
  for (const [k, at] of groups) {
    const first = at[0], last = at[at.length - 1];
    let mixed = false;
    for (let i = first; i <= last && !mixed; i++) mixed = keys[i].some((x) => x !== k);
    const span = field && !mixed ? [events[first].start, events[last].end] : null;
    const evts = at.map((i) => all[i]);
    let blocks = build(k, evts, all, part);
    if (typeof blocks === 'string') { out.push(replyPart(null, field, null, blocks)); continue; }
    if (!Array.isArray(blocks)) {
      const i = all.indexOf(blocks.evt), root = i < 0 ? null : rootAt(i);
      if (root) { out.push(...nodeParts(blocks.nodes, root, field, events[i].dataAt)); continue; }
      blocks = blocks.nodes.map((n) => n.block);
    }
    out.push(...partsOfUnit(blocks, field, span, mixed ? INTERLEAVED : why, at.length));
  }
  return out;
}
