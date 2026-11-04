// src/view/extract.mjs — extraction (RFC 4.3 §3): one record → the definitions of its blocks that are new to the
// session and its call row, read from that record alone (never another one). A call whose request carries its whole context is
// written against its lane's previous call; a call whose context is stitched across records (a thread continuation, a WebSocket call
// with previous_response_id) is written against its predecessor's row, at the id level. extractMembers drives it
// over a session's members in write order, up to a time budget, and says how far the session is extracted (its frontier).
//
// A block's id (`bid`) is the hash of the exact text its ref names, with its section and role: anyone can resolve the ref, hash the
// bytes and compare (a per-block AC-1). A block with no span hashes its canonical JSON under a 'u' tag and keeps its body inline,
// labelled unaddressable as the board always did (invariant 4). A definition depends only on its bytes, section and role; what
// depends on the block's place in a call (a turn boundary, a volatile block, the links between a file's tool_use and its result) is
// the row's `attrs`, by list position.
import { createHash } from 'node:crypto';
import { admitted, flatBlockText, blockFacts, callFacts, normResp, replyPartsAnthropic, linearContext } from './analyze.mjs';
import { slimBlock, compBucket, firstHuman, blockQuery } from './blockmeta.mjs';
import { BODY, readsOf } from './render-kind.mjs';
import { blockSpans } from '../dissect/cc-spans.mjs';
import { resourceRef as ccResourceRef } from '../dissect/cc.mjs';
import { resourceRef as oaResourceRef, faithfulness as oaFaithfulness } from '../dissect/openai.mjs';
import { scanJson, spanAt } from '../dissect/json-scan.mjs';
import { scannedRequestBody, sharesBody, parsedRequestBody, storedRequestBody, requestEncodingOf } from '../dissect/request-body.mjs';
import { fieldTextOf, respOf, headersOf } from '../dissect/record-fields.mjs';
import { composeTextRef, mintRawRef } from '../raw/refs.mjs';
import { V0_CONVERTED } from '../raw/ingest.mjs';
import { boardDissectorFor, wireFormatOf, flatLaneOf, contextStateOf, blockKeysOf, MULTI_LANE_CONTEXT } from '../dissect/registry.mjs';
import { hintsOf, sessionKeyOf, observerEffectsOf } from '../dissect/harnesses.mjs';
import { vendorOf } from '../dissect/vendors.mjs';
import { failedOf } from '../dissect/endpoints.mjs';
import { mapUsage, boardUsage } from '../model/schema.mjs';
import { CC_THREADS, replyIdOf, patchSystem } from '../dissect/cc-threads.mjs';
import { hasCompactionPreamble } from '../identity/session-identity.mjs';
import { posCmp, num52, numTable } from '../query/projection.mjs';
import { bodyRetentionOf, retentionLabelOf, reqIncompleteOf, wsIncompleteOf, respIncompleteOf, isLogOnly, captureLabelsOf } from '../dissect/capture-labels.mjs';

const SEP = '\x1F';
const b64 = (s) => createHash('sha256').update(s, 'utf8').digest().subarray(0, 16).toString('base64url');
/** bidOf(sec, role, exactText) → the block id: sha256(sec 0x1F role 0x1F exact text, as UTF-8), first 16 bytes, base64url (22 chars). */
export const bidOf = (sec, role, text) => b64(sec + SEP + role + SEP + text);
/** canonical JSON: object keys sorted, recursively (an unaddressable block's identity). */
const canonicalJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** The id of a block with no span: 'u' 0x1F sec 0x1F role 0x1F its canonical JSON. */
export const unaddressableBid = (sec, role, value) => b64('u' + SEP + sec + SEP + role + SEP + (canonicalJson(value) ?? 'null'));
/** fh: sha256 hex of the block's length-prefixed frame (cache_control is not in it). */
export const fhOf = (b) => { const t = flatBlockText(b); return createHash('sha256').update(String(t.length) + ':' + t, 'utf8').digest('hex'); };
const CC = '"cache_control"';
/**
 * vhOf(exact) → the SHA-256 (base64url) of a block's verbatim slice with its own `cache_control` member cut out by byte span: the
 * member and the comma on one side, every other byte as it is (3.3:75, acceptance #12): what the board's "reusable prefix
 * byte-identical" flag compares. null when the cut cannot be placed for sure (the slice does not scan, the member's key is not
 * spelled plainly): no proof rather than a wrong one.
 */
export function vhOf(exact) {
  let t = exact;
  if (t.includes(CC)) {
    let root = null;
    try { root = scanJson(t); } catch { return null; }
    if (root.kind === 'object' && root.props.has('cache_control')) {
      const keys = [...root.props.keys()], vals = [...root.props.values()], j = keys.indexOf('cache_control');
      const keyAt = (k) => { let p = k ? vals[k - 1].end : root.start + 1; while (p < t.length && /[\s,]/.test(t[p])) p++; return p; };
      const from = keyAt(j);
      if (!t.startsWith(CC, from)) return null;
      const [a, z] = j + 1 < vals.length ? [from, keyAt(j + 1)] : j > 0 ? [vals[j - 1].end, vals[j].end] : [from, vals[j].end];
      t = t.slice(0, a) + t.slice(z);
    }
  }
  return createHash('sha256').update(t, 'utf8').digest('base64url');
}

// what an unaddressable block's id is taken over: its content, never its place
const contentOf = (b) => (b.sec === 'messages' ? b.block ?? null : b.sec === 'system' ? b.text ?? ''
  : b.src ?? { name: b.name, ttype: b.ttype, desc: b.desc, schema: b.schema, descChars: b.descChars, props: b.props });
// a definition's byte-derived metadata (the rest of a flat entry is its place in the call, or its body)
const META = ['name', 'ttype', 'toolName', 'cc', 'mcp', 'label', 'descChars', 'props', 'verbatim'];
// a definition and a row are JSON documents: undefined members dropped, and every string a copy of its own. A string cut out of a
// record (a regex match, a slice) keeps the whole text it was cut from alive, and a row is held for the life of the session's
// extraction: on a real 6.6k-call session that was ~200 KB of heap per row, against ~19 KB for the same row read from disk.
const jsonClean = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function factsOf(b) {
  if (b.sec === 'tools') return { type: 'tool', name: b.name || '', mcp: !!b.mcp, bucket: 'tools' };
  if (b.sec === 'system') return { type: 'system', bucket: 'system' };
  const bl = b.block && typeof b.block === 'object' ? b.block : { type: 'text', text: String(b.block ?? '') };
  // `human`: a user text's human prompt (blockmeta firstHuman), what names a lane whose first call this block opens;
  // `reads`: how a tool call's result reads (a call and its result often sit in different records: the lane joins them)
  return { ...blockFacts(bl), bucket: compBucket(b), human: firstHuman([b]) ?? undefined, reads: readsOf(bl) };
}

/** definition(b, ref, exact, why, bid) → { bid, def }: `exact` the text the ref names (null: no span, `why` says why); `bid` the
 *  block's id when the caller already hashed it (4.3 §3: a block is hashed once). */
// a block's id: its verbatim slice's when it has a span, its content's otherwise (3.5 §会话读)
const bidFor = (b, ref, exact) => (ref != null && exact != null ? bidOf(b.sec, b.role, exact) : unaddressableBid(b.sec, b.role, contentOf(b)));
export function definition(b, ref, exact, why = null, bid = bidFor(b, ref, exact)) {
  const s = slimBlock(b, ref != null && exact != null ? ref : null, why);
  // vh: only of a verbatim slice. A block with no span has none, nor one whose faithfulness says its bytes are not the wire's
  // (metadata, summarized, omitted, truncated). An opaque block (signature-only reasoning) is unreadable, not unproven: its span
  // is the wire's bytes, so it keeps its vh (on a measured live Claude Code session 9,092 of 10,308 calls carry one in their prefix).
  const verbatim = ref != null && exact != null && (b.faithfulness == null || b.faithfulness === 'verbatim' || b.faithfulness === 'opaque');
  const def = { bid, fh: fhOf(b), vh: verbatim ? vhOf(exact) : null, ref: s.text_ref ?? null, sec: b.sec, role: b.role, kind: b.kind, head: s.head, preview: s.preview,
    chars: s.chars, bytes: s.bytes, ff: jsonClean({ faithfulness: b.faithfulness, unaddressable: s.unaddressable }), f: factsOf(b) };
  for (const k of META) if (b[k] !== undefined) def[k] = b[k];
  // the block's own resource key: a tool_result's mirrored file key is its place in the call (attrs), never its own
  def.resKey = b.resRole === 'result' ? '' : (b.resKey ?? '');
  if (s.unaddressable) for (const k of BODY) if (b[k] !== undefined) def[k] = b[k];
  return { bid, def: jsonClean(def), query: s.query };
}

// ── what a record's own bytes hold ──────────────────────────────────────────────────────────────────────────────────────────────
// The wire a call is read on: a flat-lane dissector, the Anthropic wire, or null (no call: counted, never guessed at).
export function callWireOf(r) {
  if (!r || !r.is_llm_call || isLogOnly(r)) return null; // D40: a call kept as a log line is no step (the session's `logged`)
  let d = boardDissectorFor(r);
  if (d && d.admits && !d.admits(r)) d = null;
  if (d) return { d, format: d.id };
  return wireFormatOf(r) === 'anthropic' ? { d: null, format: 'anthropic' } : null;
}
const NO_STREAM = 'the record carries no id or stream to address';

// The call read once: the Anthropic wire's hydrated record (`h`), or a flat-lane wire's parsed request (`req`, `unparsed`).
function readCall(rec, { d, format }) {
  if (format === 'anthropic') return { h: admitted(hydrateForBoard(rec, null)) };
  const copy = sharesBody({ ...rec }, rec); // flatRequest sets `request` on the record it is given: the caller's record stays as it was
  return { h: copy, ...flatRequest(d, copy, null) };
}
/** requestBlocks(rec, wire, read?) → { flat, at: [{ref, exact, why}] } — the request's blocks, each with the exact text its ref names. */
export function requestBlocks(rec, wire, read = readCall(rec, wire)) {
  const base = rawRefOf(rec), body = spanBody(rec);
  if (wire.format === 'anthropic') {
    const flat = anthropicFlat(read.h.request, null);
    let spans = null;
    if (body != null) try { spans = blockSpans(read.h); } catch { spans = null; }
    return { flat, at: flat.map((_, i) => locate(base, body, spans && spans[i])) };
  }
  const flat = wire.d.boardFlat(read.req, read.h);
  const root = body != null ? scannedRequestBody(rec) : null;
  return { flat, at: flat.map((b) => locate(base, body, root && Array.isArray(b.path) ? spanAt(root, b.path) : null)) };
}
const locate = (base, text, span, field = null) => {
  if (!span || text == null) return { ref: null, exact: null, why: null };
  if (!base) return { ref: null, exact: null, why: NO_STREAM };
  return { ref: composeTextRef(base, span, field), exact: text.slice(span[0], span[1]), why: null, span };
};

// reasoning with no plaintext on the wire: a thinking block with its signature only, a redacted block with its data
const sealedThinking = (bl) => (bl.type === 'redacted_thinking' || (bl.type === 'thinking' && bl.signature)) && !(bl.thinking || bl.text);
// a reply part as a flat entry of the same vocabulary (section messages, role assistant)
const WIRE_RULES = {
  anthropic: { links: true, resourceRef: ccResourceRef, faith: (bl) => (sealedThinking(bl) ? 'opaque' : undefined) },
  openai: { resourceRef: oaResourceRef, faith: (bl) => (bl.type === 'thinking' ? oaFaithfulness(bl) : undefined) },
};
/** replyBlocks(rec, wire) → [{ b, ref, exact, why }] in reply order: the call's own reply blocks (a part with no block has none). */
export function replyBlocks(rec, { d, format }) {
  const parts = format === 'anthropic' ? replyPartsAnthropic(rec) : d && d.replyParts ? d.replyParts(rec) : [];
  const rules = WIRE_RULES[format === 'anthropic' ? 'anthropic' : 'openai'], base = rawRefOf(rec);
  const out = [], texts = new Map(); // a parsed JSON reply's text is written out per read: once per field, not per block
  const textOf = (field) => { if (!texts.has(field)) texts.set(field, fieldTextOf(rec, field).text ?? null); return texts.get(field); };
  for (const p of parts) {
    const bl = p.block;
    if (!bl || typeof bl !== 'object') continue;
    const tool = /(^|_)tool_use$/.test(bl.type);
    const b = { sec: 'messages', kind: bl.type, role: 'assistant', block: bl, toolName: tool ? bl.name || '' : '', cc: bl.cache_control || null,
      resKey: rules.resourceRef(bl) || '', faithfulness: rules.faith(bl), events: p.events };
    const text = p.field ? textOf(p.field) : null;
    const at = p.span ? locate(base, text, p.span, p.field) : { ref: null, exact: null, why: p.why || null };
    out.push({ b, ...at, unit: p.unit ?? 0 });
  }
  return out;
}

/** blockAt(rec, ref) → the flat entry of the block `ref` names in `rec` (a request or a reply block), as extraction built it, or null.
 *  Within its record a block is named by its field and byte range (4.2 text_ref = record id + range): the stream half of the ref
 *  says which file the record was read from, which a seal renames. */
const spanOf = (ref) => { const i = ref.indexOf('::'); return i < 0 ? ref : ref.slice(i); };
// A record's block tables, built once per record object (a cache-break detail reads two blocks of one record, the next break of the
// lane one more), each when a ref first needs it: span → flat entry. A reply ref never builds the request's, so it reads whatever the
// request's bytes hold; any other ref is the request's first, the reply's when the request has no such span.
const tables = new WeakMap();
const firstBySpan = (rows, flatOf) => {
  const out = new Map();
  rows.forEach((x, i) => { if (x.ref != null && !out.has(spanOf(x.ref))) out.set(spanOf(x.ref), flatOf(x, i)); });
  return out;
};
const requestTable = (rec, t) => {
  if (!t.req) { const { flat, at } = requestBlocks(rec, t.wire); t.req = firstBySpan(at, (_, i) => flat[i]); }
  return t.req;
};
const replyTable = (rec, t) => (t.reply ??= firstBySpan(replyBlocks(rec, t.wire), (x) => x.b));
export function blockAt(rec, ref) {
  if (ref == null) return null;
  let t = tables.get(rec);
  if (!t) {
    const wire = callWireOf(rec);
    if (!wire) return null;
    tables.set(rec, (t = { wire, req: null, reply: null }));
  }
  const want = spanOf(ref);
  if (!want.startsWith('::resp.') && requestTable(rec, t).has(want)) return t.req.get(want);
  return replyTable(rec, t).get(want) ?? null;
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
/** materializeAttrs(baseAttrs, {k, attrs}) → a row's attributes by position: its base's before `k`, then its own (a null deletes). */
export function materializeAttrs(baseAttrs, { k = 0, attrs }) {
  const out = {};
  if (baseAttrs) for (const i in baseAttrs) { if (+i >= k) break; out[i] = baseAttrs[i]; }
  for (const i in attrs) if (attrs[i] == null) delete out[i]; else out[i] = attrs[i];
  return out;
}
// A call's attributes (by position) against its base's: the positions its delta brings (at or after k, patched) and those before k
// whose attribute is not the base's (a null deletes one); a keyframe keeps them all
function attrDelta(was, { k, patch }, now) {
  if (!was) return now;
  const out = {};
  for (const [i] of patch) out[i] = now[i] || null;
  for (const i in was) if (+i < k && !(i in out) && !(i in now)) out[i] = null;
  for (const i in now) if (+i >= k || (!(i in out) && JSON.stringify(now[i]) !== JSON.stringify(was[i]))) out[i] = now[i];
  return out;
}
/** A call's base is the last call extracted with the same lane hint; a chain of more than KEYFRAME links starts over (null base). */
const KEYFRAME = 128;

// The facts the session document reads of any record (src/view/board.mjs itemOf), its request headers left in the record: they differ
// on every call (request ids, lengths), were a sixth of the projection, and are read of the few records that need them.
function itemFacts(r) {
  const rp = respOf(r) || {};
  return jsonClean({ id: r.id, is_llm_call: !!r.is_llm_call, ts_request: r.ts_request, ts: r.ts, endpoint: r.endpoint, proc: r.proc,
    status: rp.status ?? null, body_retention: r.body_retention, retention: bodyRetentionOf(r), retentionLabel: retentionLabelOf(r),
    body_wire_bytes: r.body_wire_bytes, probeTokens: (rp.body && rp.body.input_tokens) ?? null,
    synthKey: r._synthKey });
}
const ATTR = ['volatile', 'resRole', 'resPending', 'resError', 'resTruncNote'];

const callRow = (row) => !!(row && row.x && Array.isArray(row.x.secs));
const MEMO = 64; // materialised lists kept (lane tips and predecessors are asked again and again)

/**
 * createExtractContext(store) → the state extraction keeps across one session's records, in the order they are extracted: which
 * definitions exist (`store.hasDef`, plus those extracted since the last `flushed()`), the rows (`store.rows`, plus those extracted
 * since), each lane hint's last call (the next call of that hint is written against it), each linkable call by the id a successor
 * names it by, and the last MEMO lists materialised. Seeded from the store's rows, so a context opened over a stored projection goes
 * on exactly where one pass would: from `seed` (a `seed()` of a context over the same store instance, by part name, as the
 * projection's sidecar hands it back: store.saved) for the rows it covers, then from each row after them; without one (or one of
 * another instance, or covering more rows than the store holds) from every row. With a store, what it keeps does not grow with the
 * session's rows (4.3 §4): rows and definitions are the store's once appended (the driver calls `flushed()`), a lane's last rid is
 * held per lane, and a link's row slot in a table of numbers (typed arrays, off the heap: the lineIndex way, src/query/projection.mjs).
 */
export function createExtractContext(store = null, seed = null) {
  const fresh = new Set(), mine = new Map(), lanes = new Map(), memo = new Map();
  const rows = store && store.rows;
  const rowOf = (rid) => mine.get(rid) || (rows ? rows.get(rid) : undefined) || null;
  // links: scope\nlink → the slot of the first stored row of it (num52 → slot, and a key whose number another took first in `spill`);
  // `pend`: those of rows not stored yet (extracted since the last flushed(), or every row when there is no store)
  let tab = numTable();
  const spill = new Map(), pend = new Map();
  const linkOf = (row) => (callRow(row) && row.x.link != null ? `${row.x.scope ?? ''}\n${row.x.link}` : null);
  const stored = (k) => {
    const s = tab.get(num52(k));
    return s === undefined ? undefined : linkOf(rows.get(rows.keyAt(s))) === k ? s : spill.get(k);
  };
  const keep = (k, slot) => {
    const h = num52(k), s = tab.get(h), at = stored(k);
    if (at !== undefined && posCmp(rows.keyAt(at), rows.keyAt(slot)) <= 0) return;
    if (s === undefined || (at !== undefined && at === s)) tab.set(h, slot); else spill.set(k, slot);
  };
  // a lane's last call (the latest in write order), a link's first; `slot`: the row's in the store when it is stored
  const note = (row, slot) => {
    if (!callRow(row)) return;
    const h = row.x.hint, k = linkOf(row);
    if (h != null && !(lanes.has(h) && posCmp(lanes.get(h), row.rid) > 0)) lanes.set(h, row.rid);
    if (k == null) return;
    if (slot !== undefined) keep(k, slot);
    else if (!(pend.has(k) && posCmp(pend.get(k), row.rid) <= 0)) pend.set(k, row.rid);
  };
  const remember = (e) => { memo.delete(e.rid); memo.set(e.rid, e); if (memo.size > MEMO) memo.delete(memo.keys().next().value); return e; };
  let from = 0;
  if (rows && seed && loadSeed(seed)) from = seed['e.n'][0];
  if (rows) for (let i = from; i < rows.size; i++) note(rows.get(rows.keyAt(i)), i);
  // a seed of this store instance covering at most its rows (slots are the order the store took rows in: the sidecar's, then its
  // scan's, then appends'; a cut tail drops rows from the end); anything else, or one that does not read, is not used
  function loadSeed(p) {
    try {
      const n = p['e.n'][0], hs = p['e.lh'], ls = p['e.ll'], sk = p['e.sk'], ss = p['e.ss'];
      if (p['e.id'][0] !== store.id || !(n <= rows.size) || hs.length !== ls.length || sk.length !== ss.length) return false;
      tab.load([p['e.tk'], p['e.tv']]);
      hs.forEach((h, i) => lanes.set(JSON.parse(h), rows.keyAt(ls[i])));
      sk.forEach((k, i) => spill.set(JSON.parse(k), ss[i]));
      return true;
    } catch {
      lanes.clear(); spill.clear(); tab = numTable();
      return false;
    }
  }
  // a call row's { rid, list, mb, attrs, depth } through its base chain (iteratively: a chain is up to KEYFRAME links)
  function listsOf(rid) {
    if (memo.has(rid)) return remember(memo.get(rid));
    const path = [];
    let at = null;
    for (let r = rowOf(rid); r; r = r.base == null ? null : rowOf(r.base)) {
      if (memo.has(r.rid)) { at = memo.get(r.rid); break; }
      path.push(r);
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const r = path[i];
      at = { rid: r.rid, list: materialize(at && at.list, r), mb: materialize(at && at.mb, r.mb), attrs: materializeAttrs(at && at.attrs, r), depth: at && r.base != null ? at.depth + 1 : 0 };
    }
    // only the list asked for is kept, not the chain's lists on the way to it: a lane's tip is what is asked again (its next call's
    // base, a continuation's predecessor), and the memo's places are its lanes', not one walk's (MEMO)
    return at && remember(at);
  }
  return {
    held: false, // a member before the ones being extracted has no row on disk (it failed): what follows is kept in memory only
    store: { hasDef: (bid) => fresh.has(bid) || !!(store && store.hasDef(bid)) },
    defined: (bid) => fresh.add(bid),
    rowOf,
    listsOf,
    linked(scope, id) {
      if (id == null) return null;
      const k = `${scope}\n${id}`, s = rows ? stored(k) : undefined, a = s === undefined ? undefined : rows.keyAt(s), b = pend.get(k);
      const rid = a === undefined ? b : b === undefined || posCmp(a, b) <= 0 ? a : b;
      return rid == null ? null : rowOf(rid);
    },
    prevOf: (hint) => (lanes.has(hint) ? listsOf(lanes.get(hint)) : null),
    took: (row, lists) => { mine.set(row.rid, row); note(row); remember({ rid: row.rid, ...lists }); },
    flushed() { // what was extracted is the store's now
      fresh.clear(); mine.clear();
      if (rows) for (const [k, rid] of pend) { const s = rows.slotOf(rid); if (s !== undefined) { keep(k, s); pend.delete(k); } }
    },
    /** seed() → what a context opened over this store instance later starts from (createExtractContext's `seed`), by part name; null
     *  while it holds rows the store does not (extracted since the last flushed(), or after a member that failed). */
    seed() {
      if (!rows || this.held || mine.size || pend.size) return null;
      const lh = [], ll = [];
      for (const [h, rid] of lanes) { lh.push(JSON.stringify(h)); ll.push(rows.slotOf(rid)); }
      const [tk, tv] = tab.dump();
      return { 'e.id': [store.id], 'e.n': Uint32Array.of(rows.size), 'e.lh': lh, 'e.ll': Int32Array.from(ll), 'e.tk': tk, 'e.tv': tv,
        'e.sk': [...spill.keys()].map((k) => JSON.stringify(k)), 'e.ss': Int32Array.from(spill.values()) };
    },
  };
}
const laneHintOf = (rec, format, lane) => { const h = hintsOf(rec); return h.laneKey != null ? `agent\n${h.laneKey}` : `${format}\n${lane}`; };
const attrsOf = (b, query) => {
  const a = {};
  for (const k of ATTR) if (b[k]) a[k] = b[k];
  if (b.resRole === 'result') a.resKey = b.resKey;
  if (query) a.query = query;
  return Object.keys(a).length ? a : null;
};
// The resource key of a file a tool_use reads or writes (src/dissect/cc.mjs resourceRef): the only kind linkStubs carries across
// records, as linearContext links only file results to their tool_use.
const FILE_KEY = 'file::';
// A pending file tool_use of an earlier record, as a block linearContext links a result to: the same id, the same file.
const linkStub = (id, key) => ({ type: 'tool_use', id, name: '', input: { file_path: key.slice(FILE_KEY.length) } });
const counts = (x) => x.facts || x; // where a call's msgCount is (the Anthropic wire's facts, a flat lane's x)
/** TAIL_HEAP: the byte cap of the lane tails (K, 3.5 §内存有界): per store and lane hint, the previous request's body and, for each of
 *  its request blocks that has a span, [sec, role, from, to, bid]. A request block at the same place, of the same section and role,
 *  byte-identical to that slice, inherits its bid unhashed (4.3 §3: the same input, the same hash). Least recently kept go first;
 *  a body bigger than the cap is not kept. Bytes = 2 × the body's characters + TAIL_PER_BLOCK a block. */
export const TAIL_HEAP = 4 << 20;
const TAIL_PER_BLOCK = 128;
const tails = new Map(), storeIds = new WeakMap();
let tailBytes = 0, storeSeq = 0;
const tailKey = (store, hint) => { if (!storeIds.has(store)) storeIds.set(store, ++storeSeq); return `${storeIds.get(store)}\n${hint}`; };
const dropTail = (k) => { const t = tails.get(k); if (t) { tails.delete(k); tailBytes -= t.bytes; } };
function keepTail(k, body, blocks) {
  dropTail(k);
  const bytes = 2 * body.length + TAIL_PER_BLOCK * blocks.length;
  if (bytes > TAIL_HEAP) return;
  for (const [o] of tails) { if (tailBytes + bytes <= TAIL_HEAP) break; dropTail(o); }
  tails.set(k, { body, blocks, bytes }); tailBytes += bytes;
}
/** releaseTails(): lets the lane tails go (the idle worker's saveIndexes, src/query/named/session.mjs). */
export function releaseTails() { tails.clear(); tailBytes = 0; }
// the bid of request block b at place i when the lane's previous request has the same bytes there (null: hash it)
const inherited = (tail, i, b, at) => {
  const t = tail && at.ref != null && at.exact != null ? tail.blocks[i] : null;
  return t && t[0] === b.sec && t[1] === b.role && t[3] - t[2] === at.exact.length && at.exact === tail.body.slice(t[2], t[3]) ? t[4] : null;
};

/**
 * extract(record, ctx) → { defs, row }. defs: the definitions of the record's blocks that `ctx` has not seen. row: a call's
 * { rid, pos, base, k, patch, add, reply, mb, attrs, x }, or a record's { rid, pos, x } when it is no call.
 * A call that continues a chain (a thread continuation, a WebSocket call with previous_response_id) is stitched at the id level
 * from its predecessor's row: its messages are the predecessor's, then the predecessor's reply, then its own;
 * system / tools are its own or inherited as its wire says (`stitchOf(rec).inherit`). No other record is read. A predecessor that
 * is not among the rows (not in the capture, failed to extract, or not extracted yet: it was written later) leaves the call its
 * own blocks, partial, saying which reply is missing.
 */
export function extract(rec, ctx) {
  const rid = String(rec.id), pos = rid, wire = callWireOf(rec);
  if (!wire) return { defs: [], row: { rid, pos, x: { item: itemFacts(rec), ...(isLogOnly(rec) ? null : { unknown: jsonClean(unknownFacts(rec)) }) } } };
  // identity before definition (4.3 §3): a block the session has a definition for costs its bid and its place's query, nothing more
  const defs = [], local = new Set(), take = (b, at, known = null) => {
    const bid = known ?? bidFor(b, at.ref, at.exact);
    if (ctx.store.hasDef(bid) || local.has(bid)) return { bid, query: blockQuery(b) };
    const { def, query } = definition(b, at.ref, at.exact, at.why, bid);
    local.add(bid); defs.push(def);
    return { bid, query };
  };
  const rules = WIRE_RULES[wire.format === 'anthropic' ? 'anthropic' : 'openai'];
  const rp = replyBlocks(rec, wire), reply = rp.map((p) => take(p.b, p).bid);
  const rmb = rp.flatMap((p, j) => (j === 0 || p.unit !== rp[j - 1].unit ? [j] : []));
  const read = readCall(rec, wire), x = callX(rec, wire, read);
  const linker = wire.format === 'anthropic' ? CC_THREADS : wire.d;
  const st = linker && linker.stitchOf ? linker.stitchOf(rec) : null;
  // the call's own blocks, by section
  const { flat, at } = requestBlocks(rec, wire, read);
  const body = spanBody(rec), tstore = ctx.store || ctx, tail = body != null ? tails.get(tailKey(tstore, laneHintOf(rec, wire.format, x.lane))) : null;
  const own = { tools: [], system: [], messages: [] }, ownFlat = [], tailBlocks = [];
  flat.forEach((b, i) => {
    const { bid, query } = take(b, at[i], inherited(tail, i, b, at[i]));
    tailBlocks.push(at[i].ref != null && at[i].exact != null ? [b.sec, b.role, at[i].span[0], at[i].span[1], bid] : null);
    own[b.sec === 'tools' || b.sec === 'system' ? b.sec : 'messages'].push({ bid, a: attrsOf(b, query), mi: b.mi, b });
    if (b.sec === 'messages') ownFlat.push(b);
  });
  const pred = st && st.cont ? ctx.linked(st.scope, st.prev) : null;
  // what a continuation inherits of its predecessor's messages and reply, as they stand there: block ids, attributes and message
  // starts by position from the first message (no object a position)
  let tools = own.tools, system = own.system, inh = { bids: [], attrs: {}, starts: [] }, predX = null, base = null, state = null;
  if (pred) {
    predX = pred.x;
    const P = ctx.listsOf(pred.rid), [pt, ps] = predX.secs, lo = pt + ps;
    const ent = (from, to) => P.list.slice(from, to).map((bid, k) => ({ bid, a: P.attrs[from + k] || null }));
    if (st.inherit.tools !== 'own') tools = ent(0, pt);
    if (st.inherit.system === 'inherit') system = ent(pt, lo);
    else if (st.inherit.system === 'patch') system = patchSystem(ent(pt, lo), own.system, (e) => !!(e.a && e.a.volatile));
    inh = { bids: P.list.slice(lo).concat(pred.reply), attrs: {}, starts: P.mb.filter((i) => i >= lo).map((i) => i - lo) };
    for (const i in P.attrs) if (+i >= lo) inh.attrs[i - lo] = P.attrs[i];
    for (const j of predX.rmb || []) inh.starts.push(P.list.length - lo + j);
    base = P.depth < KEYFRAME ? P : null;
    const s = predX.wire.contextState, m = predX.wire.contextMissing ?? null;
    state = s === 'partial' || s === 'server_edited' ? { contextState: s, missing: m } : { contextState: 'reconstructed', missing: null };
    if (predX.gap) state = { contextState: 'partial', missing: state.missing ? `${state.missing}; ${predX.gap}` : predX.gap };
  } else if (st && st.cont) state = { contextState: 'partial', missing: ctx.held ? `the call it continues (reply ${st.prev ?? '(unnamed)'}) is not extracted yet` : st.absent };
  else if (st) state = { ...st.head };
  if (st) state = st.settle(state);
  // own messages, their boundaries; file tool_uses still waiting for a result carried across records (linearContext's links)
  let mine = own.messages.map((e, k) => ({ ...e, start: k === 0 || e.mi !== own.messages[k - 1].mi }));
  let open = predX && predX.open ? Object.entries(predX.open) : [];
  if (rules.links && open.length) {
    const msgs = (read.h.request && read.h.request.messages) || [];
    const linked = linearContext({ system: [], tools: [], messages: [{ role: 'assistant', content: open.map(([id, [, key]]) => linkStub(id, key)) }, ...msgs] });
    const stubs = linked.filter((b) => b.mi === 0), lmsg = linked.filter((b) => b.mi !== 0);
    mine = mine.map((e, k) => ({ ...e, a: attrsOf(lmsg[k] || e.b, e.a && e.a.query) }));
    open = open.map(([id, [rel, key]], k) => [id, [rel, key], !stubs[k] || stubs[k].resPending]);
    for (const [, [rel], pending] of open) if (rel < inh.bids.length) {
      const a = { ...(inh.attrs[rel] || {}), resRole: 'request' };
      if (pending) a.resPending = true; else delete a.resPending;
      inh.attrs[rel] = a;
    }
    open = open.filter((o) => o[2]).map(([id, v]) => [id, v]);
  }
  const head = tools.concat(system), H = head.length, I = inh.bids.length;
  const list = head.map((e) => e.bid).concat(inh.bids, mine.map((e) => e.bid)), attrs = {}, mb = inh.starts.map((i) => H + i);
  head.forEach((e, i) => { if (e.a) attrs[i] = e.a; });
  for (const i in inh.attrs) attrs[H + +i] = inh.attrs[i];
  mine.forEach((e, k) => { if (e.a) attrs[H + I + k] = e.a; if (e.start) mb.push(H + I + k); });
  if (st && st.unstored != null) x.unstored = st.unstored; // a call whose request was not stored: no context, its reply real
  if (st) {
    // what a successor stitches from this row: where it is found, its reply's message starts, its pending file tool_uses
    Object.assign(x, { link: st.link, scope: st.scope, gap: st.gap, continued: st.cont, rmb,
      lineage: !st.cont ? st.link || rid : predX ? predX.lineage : st.prev || rid });
    if (rules.links) {
      const off = I;
      mine.forEach((e, k) => { if (e.a && e.a.resRole === 'request' && e.a.resPending) open.push([e.b.block.id, [off + k, e.b.resKey]]); });
      rp.forEach((p, j) => { if (p.b.kind === 'tool_use' && String(p.b.resKey).startsWith(FILE_KEY)) open.push([p.b.block.id, [I + mine.length + j, p.b.resKey]]); });
      x.open = Object.fromEntries(open);
      x.toolAdj = (predX ? predX.toolAdj || 0 : 0) + ownFlat.reduce((n, b) => n + (b.kind === 'tool_addition') - (b.kind === 'tool_removal'), 0);
    }
    stitchedFacts(x, { rec, st, predX, state, tools: tools.length, ownMsgs: (read.h.request && read.h.request.messages) || null });
  }
  x.secs = [tools.length, system.length];
  x.hint = laneHintOf(rec, wire.format, x.lane);
  if (!pred) { const prev = ctx.prevOf(x.hint); base = prev && prev.depth < KEYFRAME ? prev : null; }
  const d = delta(base && base.list, list);
  const row = jsonClean({ rid, pos, base: base ? base.rid : null, ...d, reply, mb: delta(base && base.mb, mb), attrs: attrDelta(base && base.attrs, d, attrs), x });
  for (const def of defs) ctx.defined(def.bid); // only once the record extracted whole: a record that throws leaves no trace
  ctx.took(row, { list, mb, attrs, depth: base ? base.depth + 1 : 0 });
  if (body != null) keepTail(tailKey(tstore, x.hint), body, tailBlocks);
  return { defs, row };
}

// The facts of a stitched call that need its whole context, from its predecessor's (no record read back): its state, how many
// messages and tools it held, and the system facts (subagent, monitor) when its system is inherited.
function stitchedFacts(x, { rec, st, predX, state, tools, ownMsgs }) {
  x.wire = { ...x.wire, contextState: state.contextState };
  delete x.wire.contextMissing;
  if (state.contextState === 'partial' && state.missing) x.wire.contextMissing = state.missing;
  const n = counts(x), pn = predX && counts(predX), before = pn ? pn.msgCount + (predX.rmb || []).length : 0;
  if (pn) n.msgCount += before;
  if (!x.facts) return;
  const f = x.facts, pf = predX && predX.facts;
  Object.assign(f, { continued: st.cont, lineage: x.lineage, ctxPartial: state.contextState === 'partial', tools: Math.max(0, tools + x.toolAdj) });
  if (!pf) return;
  if (st.inherit.system !== 'own') { f.sub = !!(f.sub || pf.sub); f.monitor = !!(f.monitor || pf.monitor); }
  if (st.inherit.tools !== 'own') f.mcp = pf.mcp;
  f.preamble = !!(pf.preamble || (before < 4 && ownMsgs && hasCompactionPreamble(ownMsgs.slice(0, 4 - before))));
  f.firstText = f.sub ? pf.firstText ?? f.firstText : undefined;
  const h = f.hints || {};
  if (!(h.lane === 'aux' || n.msgCount <= 2)) f.aux = undefined;
  x.lane = f.sub ? 'subagent' : f.monitor ? 'monitor' : hintsOf(rec).lane || 'main';
}

// x: the per-call facts (3.5 §会话读), all from this record. `nonBlockKeys`: the request's top-level keys that are no block
// (refs into the body and short scalars, never a body: nonBlockKeysOf below), what a lane answer's step detail ships (3.5 §会话读).
function callX(rec, { d, format }, { h, req, unparsed }) {
  const st = (respOf(rec) || {}).status ?? null;
  const common = { item: itemFacts(rec), format, respRefs: respRefsOf(rec), ...(extraMessagesOf(rec) || {}), ts: rec.ts_request || rec.ts || '', status: st,
    nonBlockKeys: nonBlockKeysOf(rec, format) };
  if (format === 'anthropic') {
    const facts = callFacts(h);
    const lane = facts.sub ? 'subagent' : facts.monitor ? 'monitor' : hintsOf(rec).lane || 'main';
    return jsonClean({ ...common, facts, lane, wire: wireOf(h, format, null), rq: slimRec(h).request,
      usage: boardUsage(mapUsage(format, facts.usage || {}, { vendor: vendorOf(h) })),
      error: !!rec.error || !!facts.failed, replyId: replyIdOf(rec), stop_reason: normResp(h).stop_reason ?? null });
  }
  const norm = d.normResp(rec);
  // `agent`: the wire's own agent (a WebSocket connection), what a subagent's lane is folded by when the harness names none
  return jsonClean({ ...common, lane: flatLaneOf(d, rec), hints: hintsOf(rec), msgCount: d.messageCount ? d.messageCount(req) : (req.message_count || 0),
    agent: d.agentOf ? d.agentOf(rec) ?? undefined : undefined, rq: slimRec(h).request, ctx: d.ctxTokens(norm), nu: norm.usage,
    reqIncomplete: reqIncompleteOf(rec), wsIncomplete: wsIncompleteOf(rec), respIncomplete: respIncompleteOf(rec),
    model: req.model, unparsed, error: failedOf({ status: st, ws: rec.transport === 'ws', error: !!rec.error || unparsed || !!(d.failed && d.failed(norm, rec)) }), wire: wireOf(rec, d.id, null, norm), usage: boardUsage(mapUsage(format, norm.usage || {}, { vendor: vendorOf(rec) })),
    stop_reason: norm.stop_reason, replyId: norm.id ?? null });
}

// ── the build driver ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What one append of extraction covers, in stored bytes: consecutive members whose `stored_bytes` sum to at most this (at least
 *  one). Records are read one at a time, but the rows and definitions extracted from them are held until the append, so this is
 *  the reservation the reading side makes before it reads (src/query/named/session.mjs working()). */
export const CHUNK_STORED = 8 * 1048576;
// and at most this many: a row lists its whole context however few bytes its record stores (a thread's continuation stores its
// delta), so the rows a chunk holds until it is appended are bounded by count (by bytes alone, 800 rows of a lane that never
// compacts, each a context of megabytes, passed the worker's heap)
const CHUNK = 16;
const contexts = new WeakMap(); // store → its extraction context (slices of one session go on with the same one)
/** extractSeed(store) → the parts ([[name, array]]) of the extraction context of `store` for its sidecar (store.saveIndex), [] when
 *  it holds rows the store does not; an open that loads that sidecar hands them back as `store.saved` (4.3 §4 旁索引). A store that
 *  extracted nothing yet gets its context here, seeded from what it was opened with, so a sidecar written after a fold alone keeps it. */
export function extractSeed(store) {
  if (!contexts.has(store)) contexts.set(store, createExtractContext(store, store.saved));
  const seed = contexts.get(store).seed();
  return seed ? Object.entries(seed) : [];
}

/**
 * extractMembers({store, members, recordsAt, sessionId, budgetMs, clock, errors, from}) → { frontier, done, total } (3.5 §访问模式
 * "谁执行它"; 4.3 §3). `members`: the session's index rows in write order (src/query/rows.mjs: segments in segmentCmp order,
 * lines in order); `from`: a cursor, the place of a member such that every member before it has a row (0, or the `done` of a call
 * over a list this one extends). `recordsAt(rows)` → their records (one that does not read back is left out). Extracts the members
 * from the cursor on that the store has no row for, in write order: the first of them whatever the budget (a member is the
 * unit, so a budget spent before it still moves the frontier: 3.5 后台抽取与归约), then until `budgetMs` of `clock` is spent, appending
 * each chunk's definitions and rows; `errors`: the answering request's (where a store note goes). A member that fails to extract gets
 * a row { x: { unparsed: reason } } appended as held (a `t` line the next open cuts off), so the next open tries it again (4.3 §3); so
 * are the rows extracted after it (one that continues it, or is written against it, would otherwise be stored without it), so what
 * a later open reads is the rows of one pass over a prefix. What extraction holds is one record at a time, a chunk's rows until its append, the store's indexes and the
 * context's per-lane / per-link ids: not the rows (4.3 §4). frontier: the largest rid such that every member up to it has a row;
 * done: the members up to it (the cursor the next call goes on from); total: the members. A keyless record gets the session's
 * synthesized key (3.4 合成键), as the query does. The work is by the members from the cursor on, never by the members before it.
 */
export function extractMembers({ store, members, recordsAt, sessionId = null, budgetMs = Infinity, clock = () => performance.now(), errors = undefined, from = 0 }) {
  const t0 = clock(), spent = () => clock() - t0 >= budgetMs, idOf = (i) => String(members[i].id), has = (i) => store.rows.has(idOf(i));
  let at = from;
  const settle = () => { while (at < members.length && has(at)) at++; };
  settle();
  for (let i = at, first = true; i < members.length && (first || !spent()); first = false) {
    const part = []; // the next members with no row: at most CHUNK, their stored bytes at most CHUNK_STORED (the first whatever its size)
    for (let sum = 0; i < members.length && part.length < CHUNK; i++) {
      if (has(i)) continue;
      const b = members[i].stored_bytes || 0;
      if (part.length && sum + b > CHUNK_STORED) break;
      sum += b; part.push(i);
    }
    if (!part.length) break;
    if (!contexts.has(store)) contexts.set(store, createExtractContext(store, store.saved));
    // each member's record is read just before it is extracted, so a slice that runs out leaves no read record behind (the next
    // slice would read it again); within one slice the reads share one stretch's caches
    const ctx = contexts.get(store);
    const defs = [], rows = [], held = [];
    for (const k of part) {
      if (spent() && (rows.length || held.length)) { i = k; break; }
      const rid = idOf(k), rec = (recordsAt([members[k]]) || []).find((r) => r && String(r.id) === rid);
      if (rec && sessionId != null && sessionKeyOf(rec).key == null) Object.defineProperty(rec, '_synthKey', { value: sessionId, enumerable: false, configurable: true, writable: true });
      let out = null, why = rec ? null : 'the record did not read back';
      if (rec) try { out = extract(rec, ctx); } catch (e) { why = `extraction failed: ${e && e.message ? e.message : e}`; }
      if (!out) ctx.held = true;
      if (out) defs.push(...out.defs);
      (ctx.held ? held : rows).push(out ? out.row : { rid, pos: rid, x: { unparsed: why, code: rec ? 'record-unparseable' : 'record-unreadable' } });
    }
    store.append({ defs, rows }, { errors });
    if (held.length) store.append({ rows: held }, { held: true, errors });
    ctx.flushed();
  }
  settle();
  return { frontier: at ? idOf(at - 1) : null, done: at, total: members.length };
}

// ── one record, read for the board: its parsed request, its wire facts and the locators of its reply, parameters and later messages
// CC dissector · board intake (RFC 3.1 dissector · D18a). The board's block extractor (linearContext /
// analyze) reads a PARSED v0-shape record: `.request` (object) + `.response`. The PRODUCT capture (D10,
// see 4.1/3.1:12) stores the request as a VERBATIM `req_body` STRING and the response under `resp`. So a
// D10 record renders EMPTY on the board unless we dissect it first. hydrateForBoard parses req_body →
// request (carrying the FULL verbatim tool `input_schema` → analyze marks tools verbatim, not metadata)
// and aliases resp→response. This is the source truth (不变式 2): blocks are sliced from the verbatim
// wire req_body, so AC-1 holds MORE directly for D10 than v0. No-op for records already in v0 shape.
// A context the dissector stitched across records (ctx, D37 ②) stands in for the call's own body, and rides on the
// copy as the non-enumerable `_ctx` (state, lineage) for the lane segmentation in analyze().
export function hydrateForBoard(r, ctx = null) {
  if (!r || r.request !== undefined || typeof r.req_body !== 'string') return r; // already v0 / not a D10 body
  const body = ctx ? ctx.req : parsedRequestBody(r); // parsed once per record (src/dissect/request-body.mjs)
  if (!body || typeof body !== 'object') return r; // unparseable → leave (analyze filters it)
  const system = Array.isArray(body.system) ? body.system
    : (typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : []);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const request = {
    ...body, system, messages, tools,
    // derived counts the v0 capture used to bake (the raw wire body doesn't carry them)
    message_count: messages.length,
    tool_count: MULTI_LANE_CONTEXT.toolCountOf({ tools, messages }),
    system_chars: system.reduce((a, b) => a + String((b && b.text) || '').length, 0),
    context_chars: r.req_body.length,
  };
  // Carry the source-stream stamp across the copy. `{...r}` takes only ENUMERABLE properties, and
  // `_stream` is deliberately non-enumerable (so it never appears in stored or shipped JSON) — which
  // means a spread silently drops it, and every block downstream loses the half of its text_ref that
  // says WHICH capture file its bytes are in. Silent, because the result is simply a missing locator.
  const out = sharesBody({ ...r, request, response: r.response || r.resp || {} }, r); // the copy's stored body parses and scans as r's
  if (r._stream) Object.defineProperty(out, '_stream', { value: r._stream, enumerable: false, configurable: true });
  if (ctx) Object.defineProperty(out, '_ctx', { value: ctx, enumerable: false, configurable: true });
  return out;
}

// Session key per harness (RFC 3.4 table, D37): read from the ONE table the ETL and sharder also use; else the
// synthesized key extractMembers stamped on a keyless Hermes / Kimi call (3.4 合成键, gate G11).
export function sessionIdOf(rec) {
  return sessionKeyOf(rec).key ?? (rec && rec._synthKey) ?? null;
}

// What the evidence block for records no dissector claims (reduce.mjs unknownSummary) keeps of one such record (the fold lets the record go): endpoint, user-agent, model.
export function unknownFacts(r) {
  const b = parsedRequestBody(r);
  return { endpoint: String((r && r.endpoint) || '').split('?')[0], ua: (headersOf(r) || {})['user-agent'], model: b && typeof b.model === 'string' ? b.model : null };
}

// A flat-lane wire's request as its dissector reads it: the stitched context (ctx), else the body parsed, else the demo v0
// shape. `unparsed`: a body that is there but does not parse is unrenderable, with its reason (R4-3). A req_body that is
// null (a WebSocket call whose request message is undecoded, or a server push: 4.6 §传输) is no body at all: such a call
// has no request, and its labels say why (wsIncomplete); it must not take /api/session down either.
// Side effect, as the board's callComp / cost need it: `r.request` is the parsed request, with the dissector's counts.
export function flatRequest(d, r, ctx) {
  let req = ctx ? ctx.req : null, unparsed = false;
  if (!ctx) {
    const v = storedRequestBody(r); // the record's one parse, READ-ONLY: the counts below go on a copy
    if (v && typeof v === 'object') req = { ...v };
    else if (r.request && typeof r.request === 'object') req = r.request; // demo v0 shape
    else { req = {}; if (r.req_body != null) unparsed = true; } // the labels still read the body as stored (G17 'partial')
  }
  r.request = req;
  Object.assign(req, d.reqCounts(req)); // derived counts the board header + raw card read (parallel to hydrateForBoard)
  req.context_chars = (r.req_body || '').length; // verbatim wire byte count
  return { req, unparsed };
}

// The per-call record, reduced to what the board renders FROM it.
//
// /api/session used to ship `rec.request` whole — the entire wire body — to a browser that had just
// been sent every block of that same body, assembled. On a real 115-call session that was ~120 MB of
// a 142.8 MB response. The frontend was checked line by line against this: it reads `rq.model`,
// `rq.context_chars`, `rq.message_count`, `rq.tool_count`, `rq.system_chars` and nothing else. Every
// computation that genuinely needs the body — composition buckets, section tax, diff keys,
// cache-break — already runs server-side over the blocks (invariant 3 requires that anyway: the
// browser must never branch on a provider's wire shape).
//
// The body is not lost, it is where it always was: in the raw NDJSON, addressed by the same ref its
// blocks carry.
const REQ_KEEP = ['model', 'context_chars', 'message_count', 'tool_count', 'system_chars'];
export function slimRec(rec) {
  if (!rec) return rec;
  const rq = rec.request || {};
  const request = {};
  for (const k of REQ_KEEP) if (rq[k] !== undefined) request[k] = rq[k];
  return { id: rec.id, request };
}

// The request text spans are cut from: the captured string. A converted v0 record's is re-serialized, not the wire's, so nothing is
// addressed into it: its blocks ship inline and say why, and it has no non-block keys (2.3 §窗口行 · 2.6 §A v0 记录).
export const spanBody = (rec) => (rec && typeof rec.req_body === 'string' && rec.capture !== V0_CONVERTED ? rec.req_body : null);
// A record's raw_ref (4.2:40), or null when it cannot be addressed: no id, or no stream it was read from.
export const rawRefOf = (rec) => (rec && rec.id != null && rec._stream ? mintRawRef(sessionIdOf(rec), rec._stream, String(rec.id)) : null);

// RFC 3.3:89 (D37): cache semantics are known per VENDOR (the upstream host), and a vendor row vouches only
// for the wire it was established on. DeepSeek's comes from its Chat Completions API; DeepSeek through its
// Anthropic endpoint (dsh) is still OPEN, so it reads unknown until a real capture settles it (then the
// VERIFIED_WIRES entry goes). An unknown vendor is unknown, never another vendor's semantics.
const CACHE_VENDORS = new Set(['anthropic', 'openai', 'deepseek', 'bedrock']);
const VERIFIED_WIRES = { deepseek: ['openai-chat'] };
function cacheSemanticsKnown(vendor, wireFormat) {
  if (!CACHE_VENDORS.has(vendor)) return false;
  const only = VERIFIED_WIRES[vendor];
  return !(only && wireFormat != null && !only.includes(wireFormat));
}

// Canonical wire facts per call (3.2:131-133), baked HERE so the page only reads them (invariant 3):
// format, vendor, whether that vendor's cache semantics are known on this wire (3.3:89: false for
// an unknown host, for a vendor with no cache row, and for DeepSeek over the Anthropic wire), transport, context
// state, observer effects and the
// incompleteness labels (4.6 §记录 「不完整的标注」 — shown on the call, never dropped). Cheap: no body parse.
// A cross-record context (ctx, from the dissector) brings its own state and, when partial, what is missing;
// `norm.unread` counts reply messages the dissector could not read (D38: never skipped without a trace).
export function wireOf(rec, format, ctx = null, norm = null) {
  const labels = captureLabelsOf(rec);
  const unread = norm && norm.unread;
  if (unread) labels.push({ id: 'reply-unread', label: `${unread} reply message${unread > 1 ? 's' : ''} not read`,
    text: `${unread} server message${unread > 1 ? 's' : ''} of this call are not JSON text (binary, past the size cap, or not decodable); the reply shown is read from the others` });
  // a request sent compressed and shown decompressed says so (4.6 §记录, invariant 4): exact text, not the wire bytes
  const enc = rec && typeof rec.req_body === 'string' ? requestEncodingOf(rec) : null;
  const vendor = vendorOf(rec);
  return { format, vendor, cacheSemanticsKnown: cacheSemanticsKnown(vendor, format), transport: rec && rec.transport === 'ws' ? 'ws' : 'http',
    contextState: ctx && ctx.contextState ? ctx.contextState : contextStateOf(rec), ...(ctx && ctx.contextState === 'partial' && ctx.missing ? { contextMissing: ctx.missing } : {}),
    observerEffect: observerEffectsOf(rec), labels, ...(enc ? { reqEncoding: enc } : {}) };
}
// 3.1:37: client messages that arrived while the call was open (req_extra_messages, e.g. an interrupt) belong to
// the call and MUST be visible — listed one by one with a locator to their verbatim text (4.2:40 字段段), or with
// what is stored instead. Cheap meta: no parse.
export function extraMessagesOf(rec) {
  const xs = rec && Array.isArray(rec.req_extra_messages) ? rec.req_extra_messages : [];
  if (!xs.length) return null;
  const base = rawRefOf(rec);
  return { extraMessages: xs.map((v, k) => {
    const field = `req_extra_messages.${k}`;
    if (typeof v === 'string') return { key: `req_extra_messages[${k}]`, chars: v.length, ref: base ? composeTextRef(base, [0, v.length], field) : null };
    return { key: `req_extra_messages[${k}]`, chars: null, ref: null, note: `stored ${fieldTextOf(rec, field).missing.replace(/^stores \S+ as /, 'as ')}` };
  }) };
}

// 4.6 R2 「回复 == mock 发出的 SSE 事件 / WebSocket 消息」 · gate G1: where the verbatim reply sits in the
// raw record, as field-qualified refs (4.2:40), in reply order — resp.raw for an HTTP reply (the decoded SSE / text the
// collector stored; on an error envelope, what arrived before the failure), one resp.messages.<j> per WebSocket server
// message. Joining an HTTP call's resolved pieces gives the whole decoded reply. A piece that cannot be addressed is
// listed with why (invariant 4), never dropped. Envelope fields only (record-fields.mjs): no wire knowledge.
// → [{ label, ref: string|null, chars: number|null, why? }]
export function respRefsOf(rec) {
  const r = respOf(rec);
  if (!r) return [{ label: 'reply', ref: null, chars: null, why: 'no response is recorded for this call' }];
  const part = r.kind === 'error' && r.partial && typeof r.partial === 'object' ? r.partial : r;
  const cut = part !== r ? ' (what arrived before the exchange failed)' : '';
  const base = rawRefOf(rec);
  const one = (label, field) => {
    const f = fieldTextOf(rec, field);
    if (f.text == null) return { label, ref: null, chars: null, why: f.missing.replace(/^stores \S+ as /, 'stored as ') };
    return base ? { label, ref: composeTextRef(base, [0, f.text.length], field), chars: f.text.length }
      : { label, ref: null, chars: f.text.length, why: 'the record carries no id or stream to address' };
  };
  if (part.kind === 'ws' && Array.isArray(part.messages)) return part.messages.map((_, j) => one(`message ${j + 1}${cut}`, `resp.messages.${j}`));
  if (fieldTextOf(rec, 'resp.raw').text != null) return [one((part.kind === 'sse' ? 'stream' : 'body') + cut, 'resp.raw')];
  if (typeof part.raw_b64 === 'string') {
    return [{ label: 'body', ref: null, chars: null, why: part.encoding_error ? `could not be decoded (${part.encoding_error}); kept as base64 in the record` : 'not UTF-8 text; kept as base64 in the record' }];
  }
  if (part.kind === 'empty') return [{ label: 'body', ref: null, chars: 0, why: 'the reply had no body' }];
  return [{ label: 'reply', ref: null, chars: null, why: r.kind === 'error' ? 'no reply bytes arrived before the exchange failed' : 'no reply text is stored in this record' }];
}

// 4.6 R2 「不成块的顶层键逐个列出」: every top-level request key that is not a block section, each with a
// locator to its verbatim value (null when the record cannot be addressed). 2.6 §A 请求参数: a short scalar — a number, a
// boolean, a string of at most SHORT_STRING characters — also ships as `value` (only its own byte slice is parsed).
const SHORT_STRING = 40;
function scalarOf(text, node) {
  if (node.kind !== 'literal' && !(node.kind === 'string' && node.end - node.start <= SHORT_STRING * 6 + 2)) return undefined;
  let v;
  try { v = JSON.parse(text.slice(node.start, node.end)); } catch { return undefined; }
  return typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= SHORT_STRING) ? v : undefined;
}
export function nonBlockKeysOf(rec, format) {
  if (spanBody(rec) == null) return [];
  const root = scannedRequestBody(rec);   // the record's one scan (src/dissect/request-body.mjs)
  if (!root || root.kind !== 'object') return [];
  const keep = blockKeysOf(format);
  const base = rawRefOf(rec);
  const out = [];
  for (const [key, node] of root.props) {
    if (keep.includes(key)) continue;
    const value = scalarOf(rec.req_body, node);
    out.push({ key, chars: node.end - node.start, ref: base ? composeTextRef(base, [node.start, node.end]) : null, ...(value !== undefined ? { value } : {}) });
  }
  return out;
}

// The blocks of an Anthropic-wire request, tagged with their faithfulness SERVER-SIDE (reads provider block shape here, not in
// the browser → invariant 3). opaque = encrypted/redacted reasoning, no plaintext on the wire (sealedThinking). The board renders
// a badge off b.faithfulness so nobody mistakes ciphertext for verbatim content (invariant 4). (1.4:52)
export function anthropicFlat(request, keyMemo) {
  const flat = linearContext(request, keyMemo);
  for (const b of flat) {
    if (sealedThinking(b.block || {})) b.faithfulness = 'opaque';
  }
  return flat;
}
