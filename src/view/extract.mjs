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
import { hydrateForBoard, anthropicFlat, flatRequest, rawRefOf, wireOf, respRefsOf, extraMessagesOf, unknownFacts, respOf, slimRec, nonBlockKeysOf } from './assemble.mjs';
import { slimBlock, compBucket, firstHuman } from './blockmeta.mjs';
import { renderOf } from './render-kind.mjs';
import { blockSpans } from '../adapters/cc.mjs';
import { resourceRef as ccResourceRef } from '../dissect/cc.mjs';
import { resourceRef as oaResourceRef, faithfulness as oaFaithfulness } from '../dissect/openai.mjs';
import { scanJson, spanAt } from '../dissect/json-scan.mjs';
import { fieldTextOf } from '../dissect/record-fields.mjs';
import { composeTextRef } from '../raw/refs.mjs';
import { boardDissectorFor, wireFormatOf, flatLaneOf } from '../dissect/registry.mjs';
import { hintsOf } from '../dissect/harnesses.mjs';
import { CC_THREADS, replyIdOf, patchSystem } from '../dissect/cc-threads.mjs';
import { hasCompactionPreamble } from '../identity/session-identity.mjs';
import { sessionKeyOf } from '../dissect/harnesses.mjs';
import { posCmp } from '../query/projection.mjs';
import { bodyRetentionOf, retentionLabelOf, reqIncompleteOf, wsIncompleteOf, respIncompleteOf, isLogOnly } from '../dissect/capture-labels.mjs';

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
const BODY = ['text', 'block', 'desc', 'schema'];
// a definition and a row are JSON documents: undefined members dropped, and every string a copy of its own. A string cut out of a
// record (a regex match, a slice) keeps the whole text it was cut from alive, and a row is held for the life of the session's
// extraction: on the user's 6.6k-call session that was ~200 KB of heap per row, against ~19 KB for the same row read from disk.
const jsonClean = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function factsOf(b) {
  if (b.sec === 'tools') return { type: 'tool', name: b.name || '', mcp: !!b.mcp, bucket: 'tools' };
  if (b.sec === 'system') return { type: 'system', bucket: 'system' };
  const bl = b.block && typeof b.block === 'object' ? b.block : { type: 'text', text: String(b.block ?? '') };
  // `human`: a user text's human prompt (blockmeta firstHuman), what names a lane whose first call this block opens
  return { ...blockFacts(bl), bucket: compBucket(b), human: firstHuman([b]) ?? undefined };
}

/** definition(b, ref, exact, why) → { bid, def }: `exact` the text the ref names (null: no span, `why` says why). */
export function definition(b, ref, exact, why = null) {
  const bid = ref != null && exact != null ? bidOf(b.sec, b.role, exact) : unaddressableBid(b.sec, b.role, contentOf(b));
  const s = slimBlock(b, ref != null && exact != null ? ref : null, why);
  // vh: only of a verbatim slice. A block with no span has none, nor one whose faithfulness says its bytes are not the wire's
  // (metadata, summarized, omitted, truncated). An opaque block (signature-only reasoning) is unreadable, not unproven: its span
  // is the wire's bytes, so it keeps its vh (on the user's live session 9,092 of 10,308 calls carry one in their prefix).
  const verbatim = ref != null && exact != null && (b.faithfulness == null || b.faithfulness === 'verbatim' || b.faithfulness === 'opaque');
  const def = { bid, fh: fhOf(b), vh: verbatim ? vhOf(exact) : null, ref: s.text_ref ?? null, sec: b.sec, role: b.role, kind: b.kind, head: s.head, preview: s.preview,
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
  if (!r || !r.is_llm_call || isLogOnly(r)) return null; // D40: a call kept as a log line is no step (the session's `logged`)
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
  anthropic: { links: true, resourceRef: ccResourceRef, faith: (bl) => ((bl.type === 'thinking' || bl.type === 'redacted_thinking') && bl.signature && !(bl.thinking || bl.text) ? 'opaque' : undefined) },
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
    out.push({ b, ...at, unit: p.unit ?? 0 });
  }
  return out;
}

/** blockAt(rec, ref) → the flat entry of the block `ref` names in `rec` (a request or a reply block), as extraction built it, or null. */
export function blockAt(rec, ref) {
  const wire = callWireOf(rec);
  if (!wire || ref == null) return null;
  const { flat, at } = requestBlocks(rec, wire);
  const i = at.findIndex((a) => a.ref === ref);
  if (i >= 0) return flat[i];
  const p = replyBlocks(rec, wire).find((x) => x.ref === ref);
  return p ? p.b : null;
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

// The facts the session document reads of any record (src/view/board.mjs itemOf), its request headers left in the record: they differ
// on every call (request ids, lengths), were a sixth of the projection, and are read of the few records that need them (P fix 2026-10-21).
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
 * on exactly where one pass would. With a store, what it keeps does not grow with the session's rows (4.3 §4): rows and definitions
 * are the store's once appended (the driver calls `flushed()`), and only a lane's last rid and a link's rid are held per lane / link.
 */
export function createExtractContext(store = null) {
  const fresh = new Set(), mine = new Map(), lanes = new Map(), links = new Map(), memo = new Map();
  const rowOf = (rid) => mine.get(rid) || (store && store.rows ? store.rows.get(rid) : undefined) || null;
  // a lane's last call (the latest in write order), a link's first
  const note = (row) => {
    if (!callRow(row)) return;
    const h = row.x.hint, k = row.x.link != null ? `${row.x.scope ?? ''}\n${row.x.link}` : null;
    if (h != null && !(lanes.has(h) && posCmp(lanes.get(h), row.rid) > 0)) lanes.set(h, row.rid);
    if (k != null && !(links.has(k) && posCmp(links.get(k), row.rid) <= 0)) links.set(k, row.rid);
  };
  const remember = (e) => { memo.delete(e.rid); memo.set(e.rid, e); if (memo.size > MEMO) memo.delete(memo.keys().next().value); return e; };
  if (store && store.rows) for (const row of store.rows.values()) note(row);
  // a call row's { rid, list, mb, depth } through its base chain (iteratively: a chain is up to KEYFRAME links)
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
      at = remember({ rid: r.rid, list: materialize(at && at.list, r), mb: materialize(at && at.mb, r.mb), depth: at && r.base != null ? at.depth + 1 : 0 });
    }
    return at;
  }
  return {
    held: false, // a member before the ones being extracted has no row on disk (it failed): what follows is kept in memory only
    store: { hasDef: (bid) => fresh.has(bid) || !!(store && store.hasDef(bid)) },
    defined: (bid) => fresh.add(bid),
    rowOf,
    listsOf,
    linked: (scope, id) => { const rid = id == null ? null : links.get(`${scope}\n${id}`); return rid == null ? null : rowOf(rid); },
    prevOf: (hint) => (lanes.has(hint) ? listsOf(lanes.get(hint)) : null),
    took: (row, lists) => { mine.set(row.rid, row); note(row); remember({ rid: row.rid, ...lists }); },
    flushed: () => { fresh.clear(); mine.clear(); }, // what was extracted is the store's now
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
const toMap = (attrs) => { const o = {}; attrs.forEach((a, i) => { if (a) o[i] = a; }); return o; };
// The resource key of a file a tool_use reads or writes (src/dissect/cc.mjs resourceRef): the only kind linkStubs carries across
// records, as linearContext links only file results to their tool_use.
const FILE_KEY = 'file::';
// A pending file tool_use of an earlier record, as a block linearContext links a result to: the same id, the same file.
const linkStub = (id, key) => ({ type: 'tool_use', id, name: '', input: { file_path: key.slice(FILE_KEY.length) } });
const counts = (x) => x.facts || x; // where a call's msgCount is (the Anthropic wire's facts, a flat lane's x)

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
  const defs = [], local = new Set(), take = (b, at) => {
    const { bid, def, query } = definition(b, at.ref, at.exact, at.why);
    if (!ctx.store.hasDef(bid) && !local.has(bid)) { local.add(bid); defs.push(def); }
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
  const own = { tools: [], system: [], messages: [] }, ownFlat = [];
  flat.forEach((b, i) => {
    const { bid, query } = take(b, at[i]);
    own[b.sec === 'tools' || b.sec === 'system' ? b.sec : 'messages'].push({ bid, a: attrsOf(b, query), mi: b.mi, b });
    if (b.sec === 'messages') ownFlat.push(b);
  });
  const pred = st && st.cont ? ctx.linked(st.scope, st.prev) : null;
  let tools = own.tools, system = own.system, inherited = [], predX = null, base = null, state = null;
  if (pred) {
    predX = pred.x;
    const P = ctx.listsOf(pred.rid), [pt, ps] = predX.secs;
    const ent = (lo, hi) => P.list.slice(lo, hi).map((bid, k) => ({ bid, a: pred.attrs[lo + k] || null }));
    if (st.inherit.tools !== 'own') tools = ent(0, pt);
    if (st.inherit.system === 'inherit') system = ent(pt, pt + ps);
    else if (st.inherit.system === 'patch') system = patchSystem(ent(pt, pt + ps), own.system, (e) => !!(e.a && e.a.volatile));
    const pmb = P.mb.filter((i) => i >= pt + ps).map((i) => i - pt - ps), pm = ent(pt + ps);
    inherited = pm.map((e, k) => ({ ...e, start: pmb.includes(k) }))
      .concat(pred.reply.map((bid, j) => ({ bid, a: null, start: (predX.rmb || []).includes(j) })));
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
    inherited = inherited.map((e) => ({ ...e }));
    for (const [, [rel], pending] of open) if (inherited[rel]) {
      const a = { ...(inherited[rel].a || {}), resRole: 'request' };
      if (pending) a.resPending = true; else delete a.resPending;
      inherited[rel].a = a;
    }
    open = open.filter((o) => o[2]).map(([id, v]) => [id, v]);
  }
  const msgs = inherited.concat(mine), head = tools.concat(system), all = head.concat(msgs);
  const list = all.map((e) => e.bid), attrs = all.map((e) => e.a), mb = [];
  msgs.forEach((e, k) => { if (e.start) mb.push(head.length + k); });
  if (st && st.unstored != null) x.unstored = st.unstored; // a call whose request was not stored: no context, its reply real
  if (st) {
    // what a successor stitches from this row: where it is found, its reply's message starts, its pending file tool_uses
    Object.assign(x, { link: st.link, scope: st.scope, gap: st.gap, continued: st.cont, rmb,
      lineage: !st.cont ? st.link || rid : predX ? predX.lineage : st.prev || rid });
    if (rules.links) {
      const off = inherited.length;
      mine.forEach((e, k) => { if (e.a && e.a.resRole === 'request' && e.a.resPending) open.push([e.b.block.id, [off + k, e.b.resKey]]); });
      rp.forEach((p, j) => { if (p.b.kind === 'tool_use' && String(p.b.resKey).startsWith(FILE_KEY)) open.push([p.b.block.id, [msgs.length + j, p.b.resKey]]); });
      x.open = Object.fromEntries(open);
      x.toolAdj = (predX ? predX.toolAdj || 0 : 0) + ownFlat.reduce((n, b) => n + (b.kind === 'tool_addition') - (b.kind === 'tool_removal'), 0);
    }
    stitchedFacts(x, { rec, st, predX, state, tools: tools.length, ownMsgs: (read.h.request && read.h.request.messages) || null });
  }
  x.secs = [tools.length, system.length];
  x.hint = laneHintOf(rec, wire.format, x.lane);
  if (!pred) { const prev = ctx.prevOf(x.hint); base = prev && prev.depth < KEYFRAME ? prev : null; }
  const row = jsonClean({ rid, pos, base: base ? base.rid : null, ...delta(base && base.list, list), reply, mb: delta(base && base.mb, mb), attrs: toMap(attrs), x });
  for (const d of defs) ctx.defined(d.bid); // only once the record extracted whole: a record that throws leaves no trace
  ctx.took(row, { list, mb, depth: base ? base.depth + 1 : 0 });
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

// x: the per-call facts (design §3.2 "x"), all from this record. `nonBlockKeys`: the request's top-level keys that are no block
// (refs into the body and short scalars, never a body: assemble.mjs nonBlockKeysOf), what a lane answer's step detail ships (3.5 §会话读).
function callX(rec, { d, format }, { h, req, unparsed }) {
  const st = (respOf(rec) || {}).status ?? null;
  const common = { item: itemFacts(rec), format, respRefs: respRefsOf(rec), ...(extraMessagesOf(rec) || {}), ts: rec.ts_request || rec.ts || '', status: st,
    nonBlockKeys: nonBlockKeysOf(rec, format) };
  if (format === 'anthropic') {
    const facts = callFacts(h), u = facts.usage || {};
    const lane = facts.sub ? 'subagent' : facts.monitor ? 'monitor' : hintsOf(rec).lane || 'main';
    return jsonClean({ ...common, facts, lane, wire: wireOf(h, format, null), rq: slimRec(h).request,
      usage: { read: u.cache_read_input_tokens || 0, create: u.cache_creation_input_tokens || 0, fresh: u.input_tokens || 0, out: u.output_tokens || 0 },
      error: !!rec.error || !!facts.failed, replyId: replyIdOf(rec), stop_reason: normResp(h).stop_reason ?? null });
  }
  const norm = d.normResp(rec);
  // `agent`: the wire's own agent (a WebSocket connection), what a subagent's lane is folded by when the harness names none
  return jsonClean({ ...common, lane: flatLaneOf(d, rec), hints: hintsOf(rec), msgCount: d.messageCount ? d.messageCount(req) : (req.message_count || 0),
    agent: d.agentOf ? d.agentOf(rec) ?? undefined : undefined, rq: slimRec(h).request, ctx: d.ctxTokens(norm), nu: norm.usage,
    reqIncomplete: reqIncompleteOf(rec), wsIncomplete: wsIncompleteOf(rec), respIncomplete: respIncompleteOf(rec),
    model: req.model, unparsed, wire: wireOf(rec, d.id, null, norm), usage: norm.canonUsage,
    stop_reason: norm.stop_reason, error: !!rec.error || unparsed || !!(d.failed && d.failed(norm, rec)), replyId: norm.id ?? null });
}

// ── the build driver ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What extraction reads at once, in stored bytes: consecutive members whose `stored_bytes` sum to at most this (at least one), so
 *  the records it holds at a time are a reservation the reading side makes before it reads (src/query/named/session.mjs working()). */
export const CHUNK_STORED = 8 * 1048576;
// and at most this many: a row lists its whole context however few bytes its record stores (a thread's continuation stores its
// delta), so the rows a chunk holds until it is appended are bounded by count (by bytes alone, 800 rows of a lane that never
// compacts, each a context of megabytes, passed the worker's heap: 2026-10-22)
const CHUNK = 16;
const contexts = new WeakMap(); // store → its extraction context (slices of one session go on with the same one)

/**
 * extractMembers({store, members, recordsAt, sessionId, budgetMs, clock, errors, from}) → { frontier, done, total } (design §3.4
 * "Extraction frontier"). `members`: the session's index rows in write order (src/query/rows.mjs: segments in segmentCmp order,
 * lines in order); `from`: a cursor, the place of a member such that every member before it has a row (0, or the `done` of a call
 * over a list this one extends). `recordsAt(rows)` → their records (one that does not read back is left out). Extracts the members
 * from the cursor on that the store has no row for, in write order, until `budgetMs` of `clock` is spent, appending
 * each chunk's definitions and rows; `errors`: the answering request's (where a store note goes). A member that fails to extract gets
 * a row { x: { unparsed: reason } } appended as held (a `t` line the next open cuts off), so the next open tries it again (§3.9); so
 * are the rows extracted after it (one that continues it, or is written against it, would otherwise be stored without it), so what
 * a later open reads is the rows of one pass over a prefix. What extraction holds is a chunk of records, the store's indexes and the
 * context's per-lane / per-link ids: not the rows (4.3 §4). frontier: the largest rid such that every member up to it has a row;
 * done: the members up to it (the cursor the next call goes on from); total: the members. A keyless record gets the session's
 * synthesized key (3.4 合成键), as the query does. The work is by the members from the cursor on, never by the members before it.
 */
export function extractMembers({ store, members, recordsAt, sessionId = null, budgetMs = Infinity, clock = () => performance.now(), errors = undefined, from = 0 }) {
  const t0 = clock(), spent = () => clock() - t0 >= budgetMs, idOf = (i) => String(members[i].id), has = (i) => store.rows.has(idOf(i));
  let at = from;
  const settle = () => { while (at < members.length && has(at)) at++; };
  settle();
  for (let i = at; i < members.length && !spent();) {
    const part = []; // the next members with no row: at most CHUNK, their stored bytes at most CHUNK_STORED (the first whatever its size)
    for (let sum = 0; i < members.length && part.length < CHUNK; i++) {
      if (has(i)) continue;
      const b = members[i].stored_bytes || 0;
      if (part.length && sum + b > CHUNK_STORED) break;
      sum += b; part.push(i);
    }
    if (!part.length) break;
    if (!contexts.has(store)) contexts.set(store, createExtractContext(store));
    const ctx = contexts.get(store), got = new Map();
    for (const r of recordsAt(part.map((k) => members[k])) || []) if (r) got.set(String(r.id), r);
    const defs = [], rows = [], held = [];
    for (const k of part) {
      if (spent() && (rows.length || held.length)) { i = k; break; }
      const rid = idOf(k), rec = got.get(rid);
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
