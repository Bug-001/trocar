// src/view/extract.mjs — extraction (RFC 4.3 §3): one record → the definitions of its blocks that are new to the
// session and its call row, read from that record alone (never another one). This part reads the records whose request carries its
// whole context (an Anthropic call that continues no thread, a Responses HTTP call, a Chat call) and every record that is no call;
// a call whose context is stitched across records (a thread continuation, a WebSocket call) is lane P7's.
//
// A block's id (`bid`) is the hash of the exact text its ref names, with its section and role: anyone can resolve the ref, hash the
// bytes and compare (a per-block AC-1). A block with no span hashes its canonical JSON under a 'u' tag and keeps its body inline,
// labelled unaddressable as the board always did (invariant 4). A definition depends only on its bytes, section and role; what
// depends on the block's place in a call (a turn boundary, a volatile block, the links between a file's tool_use and its result) is
// the row's `attrs`, by list position.
import { createHash } from 'node:crypto';
import { admitted, flatBlockText, blockFacts, callFacts, replyPartsAnthropic } from './analyze.mjs';
import { hydrateForBoard, anthropicFlat, flatRequest, rawRefOf, wireOf, respRefsOf, extraMessagesOf, nonBlockKeysOf, unknownFacts, headersOf, respOf } from './assemble.mjs';
import { slimBlock, compBucket } from './blockmeta.mjs';
import { renderOf } from './render-kind.mjs';
import { blockSpans } from '../adapters/cc.mjs';
import { resourceRef as ccResourceRef } from '../dissect/cc.mjs';
import { resourceRef as oaResourceRef, faithfulness as oaFaithfulness } from '../dissect/openai.mjs';
import { scanJson, spanAt } from '../dissect/json-scan.mjs';
import { fieldTextOf } from '../dissect/record-fields.mjs';
import { composeTextRef } from '../raw/refs.mjs';
import { boardDissectorFor, wireFormatOf, flatLaneOf } from '../dissect/registry.mjs';
import { hintsOf } from '../dissect/harnesses.mjs';
import { isContinuation, replyIdOf } from '../dissect/cc-threads.mjs';
import { safeHeaders } from '../capture/redact.mjs';
import { bodyRetentionOf, retentionLabelOf } from '../dissect/capture-labels.mjs';

const SEP = '\x1F';
const b64 = (s) => createHash('sha256').update(s, 'utf8').digest().subarray(0, 16).toString('base64url');
/** bidOf(sec, role, exactText) → the block id: sha256(sec 0x1F role 0x1F exact text, as UTF-8), first 16 bytes, base64url (22 chars). */
export const bidOf = (sec, role, text) => b64(sec + SEP + role + SEP + text);
/** canonical JSON: object keys sorted, recursively (an unaddressable block's identity). */
const canonicalJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** The id of a block with no span: 'u' 0x1F sec 0x1F role 0x1F its canonical JSON. */
export const unaddressableBid = (sec, role, value) => b64('u' + SEP + sec + SEP + role + SEP + (canonicalJson(value) ?? 'null'));
/** fh: sha256 hex of the block's length-prefixed frame (the frame prefixChain hashes; cache_control is not in it). */
export const fhOf = (b) => { const t = flatBlockText(b); return createHash('sha256').update(String(t.length) + ':' + t, 'utf8').digest('hex'); };

// what an unaddressable block's id is taken over: its content, never its place
const contentOf = (b) => (b.sec === 'messages' ? b.block ?? null : b.sec === 'system' ? b.text ?? ''
  : b.src ?? { name: b.name, ttype: b.ttype, desc: b.desc, schema: b.schema, descChars: b.descChars, props: b.props });
// a definition's byte-derived metadata (the rest of a flat entry is its place in the call, or its body)
const META = ['name', 'ttype', 'toolName', 'cc', 'mcp', 'label', 'descChars', 'props', 'verbatim'];
const BODY = ['text', 'block', 'desc', 'schema'];
// drop undefined members, recursively: a definition and a row are JSON documents
function jsonClean(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : jsonClean(x)));
  if (!v || typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = jsonClean(v[k]);
  return o;
}
function factsOf(b) {
  if (b.sec === 'tools') return { type: 'tool', name: b.name || '', mcp: !!b.mcp, bucket: 'tools' };
  if (b.sec === 'system') return { type: 'system', bucket: 'system' };
  const bl = b.block && typeof b.block === 'object' ? b.block : { type: 'text', text: String(b.block ?? '') };
  return { ...blockFacts(bl), bucket: compBucket(b) };
}

/** definition(b, ref, exact, why) → { bid, def }: `exact` the text the ref names (null: no span, `why` says why). */
export function definition(b, ref, exact, why = null) {
  const bid = ref != null && exact != null ? bidOf(b.sec, b.role, exact) : unaddressableBid(b.sec, b.role, contentOf(b));
  const s = slimBlock(b, ref != null && exact != null ? ref : null, why);
  const def = { bid, fh: fhOf(b), ref: s.text_ref ?? null, sec: b.sec, role: b.role, kind: b.kind, head: s.head, preview: s.preview,
    chars: s.chars, bytes: s.bytes, ff: jsonClean({ faithfulness: b.faithfulness, unaddressable: s.unaddressable }), r: renderOf(b), f: factsOf(b) };
  for (const k of META) if (b[k] !== undefined) def[k] = b[k];
  // the block's own resource key: a tool_result's mirrored file key is its place in the call (attrs), never its own
  def.resKey = b.resRole === 'result' ? '' : (b.resKey ?? '');
  if (s.unaddressable) for (const k of BODY) if (b[k] !== undefined) def[k] = b[k];
  return { bid, def: jsonClean(def), query: s.query };
}

// ── what a record's own bytes hold ──────────────────────────────────────────────────────────────────────────────────────────────
// The wire a call is read on: a flat-lane dissector, the Anthropic wire, or null (no call: counted, never guessed at).
export function callWireOf(r) {
  if (!r || !r.is_llm_call) return null;
  let d = boardDissectorFor(r);
  if (d && d.admits && !d.admits(r)) d = null;
  if (d) return { d, format: d.id };
  return wireFormatOf(r) === 'anthropic' ? { d: null, format: 'anthropic' } : null;
}
const reqText = (rec) => (rec && typeof rec.req_body === 'string' ? rec.req_body : null);
const NO_STREAM = 'the record carries no id or stream to address';

// The call read once: the Anthropic wire's hydrated record (`h`), or a flat-lane wire's parsed request (`req`, `unparsed`).
function readCall(rec, { d, format }) {
  if (format === 'anthropic') return { h: admitted(hydrateForBoard(rec, null)) };
  const copy = { ...rec }; // flatRequest sets `request` on the record it is given: the caller's record stays as it was
  return { h: copy, ...flatRequest(d, copy, null) };
}
/** requestBlocks(rec, wire, read?) → { flat, at: [{ref, exact, why}] } — the request's blocks, each with the exact text its ref names. */
export function requestBlocks(rec, wire, read = readCall(rec, wire)) {
  const base = rawRefOf(rec), body = reqText(rec);
  if (wire.format === 'anthropic') {
    const flat = anthropicFlat(read.h.request, null);
    let spans = null;
    if (body != null) try { spans = blockSpans(read.h); } catch { spans = null; }
    return { flat, at: flat.map((_, i) => locate(base, body, spans && spans[i])) };
  }
  const flat = wire.d.boardFlat(read.req, read.h);
  let root = null;
  if (body != null) try { root = scanJson(body); } catch { root = null; }
  return { flat, at: flat.map((b) => locate(base, body, root && Array.isArray(b.path) ? spanAt(root, b.path) : null)) };
}
const locate = (base, text, span, field = null) => {
  if (!span || text == null) return { ref: null, exact: null, why: null };
  if (!base) return { ref: null, exact: null, why: NO_STREAM };
  return { ref: composeTextRef(base, span, field), exact: text.slice(span[0], span[1]), why: null };
};

// a reply part as a flat entry of the same vocabulary (section messages, role assistant)
const WIRE_RULES = {
  anthropic: { resourceRef: ccResourceRef, faith: (bl) => ((bl.type === 'thinking' || bl.type === 'redacted_thinking') && bl.signature && !(bl.thinking || bl.text) ? 'opaque' : undefined) },
  openai: { resourceRef: oaResourceRef, faith: (bl) => (bl.type === 'thinking' ? oaFaithfulness(bl) : undefined) },
};
/** replyBlocks(rec, wire) → [{ b, ref, exact, why }] in reply order: the call's own reply blocks (a part with no block has none). */
export function replyBlocks(rec, { d, format }) {
  const parts = format === 'anthropic' ? replyPartsAnthropic(rec) : d && d.replyParts ? d.replyParts(rec) : [];
  const rules = WIRE_RULES[format === 'anthropic' ? 'anthropic' : 'openai'], base = rawRefOf(rec);
  const out = [];
  for (const p of parts) {
    const bl = p.block;
    if (!bl || typeof bl !== 'object') continue;
    const tool = bl.type === 'tool_use' || bl.type === 'server_tool_use';
    const b = { sec: 'messages', kind: bl.type, role: 'assistant', block: bl, toolName: tool ? bl.name || '' : '', cc: bl.cache_control || null,
      resKey: rules.resourceRef(bl) || '', faithfulness: rules.faith(bl) };
    const text = p.field ? fieldTextOf(rec, p.field).text ?? null : null;
    const at = p.span ? locate(base, text, p.span, p.field) : { ref: null, exact: null, why: p.why || null };
    out.push({ b, ...at });
  }
  return out;
}

// ── the call row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A call's list against its base's: keep base[0:k], patch positions, append `add` — whichever of the two encodings is shorter. */
function delta(baseList, list) {
  if (!baseList) return { k: 0, patch: [], add: list.slice() };
  const m = Math.min(baseList.length, list.length);
  let p = 0;
  while (p < m && baseList[p] === list[p]) p++;
  const patch = [];
  for (let i = p; i < m; i++) if (baseList[i] !== list[i]) patch.push([i, list[i]]);
  return 2 * patch.length + list.length - m < list.length - p ? { k: m, patch, add: list.slice(m) } : { k: p, patch: [], add: list.slice(p) };
}
/** materialize(baseList, {k, patch, add}) → the list a row (or its `mb`) stands for. */
export function materialize(baseList, { k, patch, add }) {
  const out = (baseList || []).slice(0, k);
  for (const [i, v] of patch || []) out[i] = v;
  return out.concat(add || []);
}
/** A call's base is the last call extracted with the same lane hint; a chain of more than KEYFRAME links starts over (null base). */
const KEYFRAME = 128;

// The facts the session document reads of any record (src/view/board.mjs itemOf), credential headers masked (4.1 §凭据处置).
function itemFacts(r) {
  const rp = respOf(r) || {};
  return jsonClean({ id: r.id, is_llm_call: !!r.is_llm_call, ts_request: r.ts_request, ts: r.ts, endpoint: r.endpoint, proc: r.proc,
    status: rp.status ?? null, body_retention: r.body_retention, retention: bodyRetentionOf(r), retentionLabel: retentionLabelOf(r),
    body_wire_bytes: r.body_wire_bytes, probeTokens: (rp.body && rp.body.input_tokens) ?? null, req_headers: safeHeaders(headersOf(r)),
    synthKey: r._synthKey });
}
const ATTR = ['volatile', 'resRole', 'resPending', 'resError', 'resTruncNote'];

/**
 * createExtractContext(store) → the state extraction keeps across one session's records, in the order they are extracted: which
 * definitions exist (`store.hasDef`, e.g. the projection, plus those extracted since) and each lane hint's last call (its list,
 * message boundaries and chain depth), which the next call of that hint is written against.
 */
export function createExtractContext(store = null) {
  const lanes = new Map(), fresh = new Set();
  return {
    store: { hasDef: (bid) => fresh.has(bid) || !!(store && store.hasDef(bid)) },
    defined: (bid) => fresh.add(bid),
    prevOf: (hint) => lanes.get(hint) || null,
    took: (hint, e) => lanes.set(hint, e),
  };
}
const laneHintOf = (rec, format, lane) => { const h = hintsOf(rec); return h.laneKey != null ? `agent\n${h.laneKey}` : `${format}\n${lane}`; };

/**
 * extract(record, ctx) → { defs, row }. defs: the definitions of the record's blocks that `ctx` has not seen. row: a call's
 * { rid, pos, base, k, patch, add, reply, mb, attrs, x }, or a record's { rid, pos, x } when it is no call.
 */
export function extract(rec, ctx) {
  const rid = String(rec.id), pos = rid, wire = callWireOf(rec);
  if (!wire) return { defs: [], row: { rid, pos, x: { item: itemFacts(rec), unknown: jsonClean(unknownFacts(rec)) } } };
  const defs = [], take = (b, at) => {
    const { bid, def, query } = definition(b, at.ref, at.exact, at.why);
    if (!ctx.store.hasDef(bid)) { ctx.defined(bid); defs.push(def); }
    return { bid, query };
  };
  const stitched = wire.format === 'anthropic' ? isContinuation(rec) : !!(wire.d && wire.d.prepare);
  const reply = replyBlocks(rec, wire).map((p) => take(p.b, p).bid);
  const read = readCall(rec, wire), x = callX(rec, wire, read);
  if (stitched) return { defs, row: { rid, pos, base: null, k: 0, patch: [], add: [], reply, mb: { k: 0, patch: [], add: [] }, attrs: {}, x: { ...x, stitch: 'pending' } } };
  const { flat, at } = requestBlocks(rec, wire, read);
  const list = [], mbs = [], attrs = {};
  let mi = null;
  flat.forEach((b, i) => {
    const { bid, query } = take(b, at[i]);
    list.push(bid);
    if (b.sec === 'messages' && (mi === null || b.mi !== mi)) { mbs.push(i); mi = b.mi; }
    const a = {};
    for (const k of ATTR) if (b[k]) a[k] = b[k];
    if (b.resRole === 'result') a.resKey = b.resKey;
    if (query) a.query = query;
    if (Object.keys(a).length) attrs[i] = a;
  });
  const hint = laneHintOf(rec, wire.format, x.lane), prev = ctx.prevOf(hint);
  const base = prev && prev.depth < KEYFRAME ? prev : null;
  ctx.took(hint, { rid, list, mb: mbs, depth: base ? base.depth + 1 : 0 });
  const row = { rid, pos, base: base ? base.rid : null, ...delta(base && base.list, list), reply, mb: delta(base && base.mb, mbs), attrs, x };
  return { defs, row };
}

// x: the per-call facts (design §3.2 "x"), all from this record.
function callX(rec, { d, format }, { h, req, unparsed }) {
  const st = (respOf(rec) || {}).status ?? null;
  const common = { item: itemFacts(rec), format, respRefs: respRefsOf(rec), ...(extraMessagesOf(rec) || {}), ts: rec.ts_request || rec.ts || '', status: st };
  if (format === 'anthropic') {
    const facts = callFacts(h), u = facts.usage || {};
    const lane = facts.sub ? 'subagent' : facts.monitor ? 'monitor' : hintsOf(rec).lane || 'main';
    return jsonClean({ ...common, facts, lane, wire: wireOf(h, format, null), nonBlockKeys: nonBlockKeysOf(h, format),
      usage: { read: u.cache_read_input_tokens || 0, create: u.cache_creation_input_tokens || 0, fresh: u.input_tokens || 0, out: u.output_tokens || 0 },
      error: !!rec.error || !!facts.failed, replyId: replyIdOf(rec) });
  }
  const norm = d.normResp(rec);
  return jsonClean({ ...common, lane: flatLaneOf(d, rec), hints: hintsOf(rec), msgCount: d.messageCount ? d.messageCount(req) : (req.message_count || 0),
    model: req.model, unparsed, wire: wireOf(rec, d.id, null, norm), nonBlockKeys: nonBlockKeysOf(rec, d.id), usage: norm.canonUsage,
    stop_reason: norm.stop_reason, error: !!rec.error || unparsed || !!(d.failed && d.failed(norm, rec)), replyId: norm.id ?? null });
}
