// src/view/reduce.mjs — reduction (RFC 4.3 §3, RFC 2.3 §读与画): a session's document from its context projection
// (src/query/projection.mjs) alone. Each call row's list of block ids is materialised from its base chain; the analyzer
// (createAnalyzer, the same fold the record path runs) is fed call views built from the row's facts `x` and its definitions' facts
// `f`; the cache break of each lane is taken against the lane's last call that chained a prefix, over the definitions' frame hashes;
// the composition is the lane's previous one minus the removed blocks plus the added ones. No record is read, except once per pair
// of diverging blocks whose break detail (key reorder, byte offset) needs both texts: that detail is kept as a `brk` line of the
// projection, so the next reduction reads it from there.
//
// The document is what createAssembler(...).finish() gives for the same records (src/view/assemble.mjs), every call in its meta
// form, plus `lanes[].key` (the id of the lane's first call) and `items` (record id → the facts the session document reads of it).
// It carries no `prefixSha256` (the board only ever compared digests): `prefixByteIdentical` compares each block's verbatim slice
// with its cache_control cut out (the definition's `vh`), never the frame text, so it can be false where the record fold says true.
// One place it is more exact: the record fold keys a block by its first 4,096 characters (analyze.mjs BLK_KEY_CAP), so two blocks
// that differ only past that are the same to it; here a block is its whole frame (one call of the user's live session, 2026-10-21).
import { createAnalyzer, stepOrder, OrderBound, breakOf, blockDiff, compactionMeta, unparsedErrMsg } from './analyze.mjs';
import { realGroundTruth, unknownSummary, assembleUnknown, flatLaneView, mergeViews } from './assemble.mjs';
import { compactionVerdict } from '../identity/session-identity.mjs';
import { boardDissectorOf } from '../dissect/registry.mjs';
import { COMP_KEYS, tellApart } from './blockmeta.mjs';
import { posCmp } from '../query/projection.mjs';

const KEYFRAME = 32; // a materialised list kept every KEYFRAME links of a base chain
const RECENT = 64; // and the lists asked last (lane tips are asked again and again)

// ── lists ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LISTS = new WeakMap(); // store → its lists (block ids interned as ints)
function listsOf(store) {
  if (LISTS.has(store)) return LISTS.get(store);
  const ix = new Map(), names = [];
  const int = (bid) => { let k = ix.get(bid); if (k === undefined) { k = names.length; names.push(bid); ix.set(bid, k); } return k; };
  const keyframes = new Map(), recent = new Map();
  const remember = (e) => { recent.delete(e.rid); recent.set(e.rid, e); if (recent.size > RECENT) recent.delete(recent.keys().next().value); return e; };
  const apply = (base, { k = 0, patch, add }, map) => {
    const out = base ? base.slice(0, k) : [];
    for (const [i, v] of patch || []) out[i] = map(v);
    for (const v of add || []) out.push(map(v));
    return out;
  };
  const same = (v) => v;
  // a call row's { rid, list (ints), mb, depth }, through its base chain from the nearest list held; `head`: the row itself when the
  // caller holds it, `rowOf`: how a row of the chain is read
  function at(rid, rowOf = (r) => store.rows.get(r), head = null) {
    const hit = recent.get(rid) || keyframes.get(rid);
    if (hit) return remember(hit);
    const path = [];
    let e = null;
    for (let r = head || rowOf(rid); r;) {
      path.push(r);
      if (r.base == null) break;
      const c = recent.get(r.base) || keyframes.get(r.base); // a base whose list is held is not read
      if (c) { e = c; break; }
      r = rowOf(r.base);
    }
    if (!e && !path.length) return null;
    for (let i = path.length - 1; i >= 0; i--) {
      const r = path[i], from = r.base != null ? e : null;
      e = { rid: r.rid, list: apply(from && from.list, r, int), mb: apply(from && from.mb, r.mb || {}, same), depth: from ? from.depth + 1 : 0 };
      if (e.depth % KEYFRAME === 0) keyframes.set(r.rid, e);
    }
    return remember(e);
  }
  const lists = { at, int, bid: (k) => names[k] };
  LISTS.set(store, lists);
  return lists;
}
/** listOf(store, rid) → { bids, attrs, mb } of a call row: its list of block ids, its attributes by position, its message starts. */
export function listOf(store, rid) {
  const L = listsOf(store), e = L.at(String(rid)), row = store.rows.get(String(rid));
  return e ? { bids: e.list.map(L.bid), attrs: row.attrs || {}, mb: e.mb.slice() } : null;
}

// ── reduce ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ridOf = (m) => String(m && typeof m === 'object' ? m.id : m);
const isCall = (row) => !!(row && row.x && Array.isArray(row.x.secs));

/**
 * reduce(store, members, {mark, resolve, errors}) → the session's document (see the head of this file) at `mark` (design §3.4
 * "Extraction frontier"): the reduction over the members whose record id is ≤ mark (posCmp) and nothing else. `members`: the
 * session's index rows (or record ids); those up to the mark that the store holds a row for go through one reduction(). With no
 * mark, the mark is the store's frontier: the largest member such that every member up to it has a row. The document carries `mark`;
 * `failed: [{id, reason, code}]` (code: record-unreadable / record-unparseable), the members up to the mark whose row says why they did not extract (design §3.9, D38: their call is
 * shown by its reason, never dropped); and `pending: {done, total}` (members up to the mark that have a row, members) while a member
 * is above the mark or has no row — a failed member is reported, not pending (3.5:43). `resolve(ref)` → the flat entry of the block
 * `ref` names (src/view/extract.mjs blockAt over the record read back): asked only for a break detail no `brk` line holds yet.
 * `errors`: the answering request's (where a note of writing the `brk` lines goes).
 */
export function reduce(store, members, { mark = undefined, resolve = null, errors = undefined } = {}) {
  const all = [...new Set(members.map(ridOf))].sort(posCmp);
  if (mark === undefined) { mark = null; for (const rid of all) { if (!store.rows.has(rid)) break; mark = rid; } }
  const upTo = mark == null ? [] : all.filter((rid) => posCmp(rid, mark) <= 0 && store.rows.has(rid));
  const doc = reduction(store, { resolve, errors }).add(upTo).doc();
  doc.mark = mark;
  if (upTo.length < all.length) doc.pending = { done: upTo.length, total: all.length };
  return doc;
}

/**
 * reduction(store, {resolve, errors, progress}) → {add(rids), doc(), has(rid)}: a session's reduction that grows (design §3.4).
 * `add(rids)`: member record ids that have a row, in any order. In write order each row is read from the store once, as it is
 * folded; what the fold asks of it again — its order, for a late call's lane put in again and for the step order — is kept as a small
 * record. Rows are read again only for a late call's own lane put in again, a base chain past the lists held, and a fold from scratch.
 * New rids that all sort after the last one folded (write order; step order once the reduction is in step order) are folded on;
 * else the fold starts again over everything added, as it does on an `OrderBound` (sub-agents told apart by order only: then in step
 * order). So `doc()` is always the document of one pass over the rids added so far: byte for byte what one add of them all gives.
 * `progress(rid)` is called once per row folded (the worker's silence clock, 3.5:46). `doc()` → the document (the head of this file),
 * with `failed` when a row added says its record did not extract; it is built at each call (the analyzer's finish) and shares its
 * calls with the fold, which the next add goes on changing.
 */
export function reduction(store, { resolve = null, errors = undefined, progress = null } = {}) {
  const ord = new Map(); // rid folded → { ts_request, id } (null: a row with no item)
  const failed = new Map(); // rid → why its record did not extract
  const found = new Map(); // break details worked out by this reduction, written as `brk` lines once an add is done
  const byStep = (a, b) => { const oa = ord.get(a), ob = ord.get(b); return oa && ob ? stepOrder(oa, ob) : 0; };
  let inStep = false, last = null, F = foldOf(store, resolve, found, ord);
  const store_ = (rid) => store.rows.get(rid);
  const fold = (rid, row, rowOf) => { F.push(rid, row, rowOf); last = rid; if (progress) progress(rid); };
  // a row read: a failed one noted, else its order kept (the row returned)
  function read(rid) {
    const row = store.rows.get(rid);
    if (!row) throw new Error(`the context projection has no row for ${rid}`);
    const x = row.x || {};
    if (typeof x.unparsed === 'string' && !x.item) { failed.set(rid, { reason: x.unparsed, code: x.code || 'record-unparseable' }); return null; }
    ord.set(rid, x.item ? { ts_request: x.item.ts_request, id: x.item.id } : null);
    return row;
  }
  // from scratch over everything added, each row read again
  function again() {
    F = foldOf(store, resolve, found, ord); last = null;
    const rids = [...ord.keys()].sort(posCmp);
    for (const rid of inStep ? rids.sort(byStep) : rids) fold(rid, store.rows.get(rid), store_);
  }
  function add(rids) {
    const fresh = [...new Set(rids.map(String))].filter((rid) => !ord.has(rid) && !failed.has(rid)).sort(posCmp);
    try {
      if (!fresh.length) { /* nothing new */ } else if (!inStep && (last == null || posCmp(fresh[0], last) > 0)) {
        for (const rid of fresh) { const row = read(rid); if (row) fold(rid, row, store_); } // write order: each row read once, as it is folded
      } else {
        const held = new Map(); // in step order: the new rows' order is read first, their rows kept while they are folded
        for (const rid of fresh) { const row = read(rid); if (row) held.set(rid, row); }
        const next = [...held.keys()].sort(byStep), rowOf = (rid) => held.get(rid) || store.rows.get(rid);
        if (!next.length) { /* only failures */ } else if (inStep && last != null && byStep(next[0], last) > 0) for (const rid of next) fold(rid, held.get(rid), rowOf);
        else again();
      }
    } catch (e) {
      if (!(e instanceof OrderBound) || inStep) throw e;
      for (const rid of fresh) if (!ord.has(rid) && !failed.has(rid)) read(rid);
      inStep = true; // sub-agents told apart only by order: from scratch, in step order
      again();
    }
    if (found.size) { store.append({ brks: [...found.values()] }, { errors }); found.clear(); }
    return R;
  }
  function doc() {
    const A = F.doc();
    if (failed.size) A.failed = [...failed].sort((a, b) => posCmp(a[0], b[0])).map(([id, f]) => ({ id, ...f }));
    return A;
  }
  const R = { add, doc, has: (rid) => ord.has(String(rid)) || failed.has(String(rid)) };
  return R;
}

const byOrder = (a, b) => stepOrder({ ts_request: a.ts, id: a.id }, { ts_request: b.ts, id: b.id });

// One pass of the fold: push(rid, row, rowOf) in order, doc() at any point. `rowOf(rid)` reads a row again (a late call's lane put
// in again; a base chain no held list reaches): the add's own rows first, the store's for the rest.
function foldOf(store, resolve, found, ord) {
  const L = listsOf(store), items = new Map(), unknown = [], other = [];
  let rowOf = (rid) => store.rows.get(rid);
  const defs = []; // block int → what the reduction reads of its definition (held for this reduction only)
  const keys = new Map(); // (sec, role, kind, fh) → int
  const intOf = (s) => { let k = keys.get(s); if (k === undefined) keys.set(s, (k = keys.size)); return k; };
  const def = (k) => {
    let d = defs[k];
    if (d) return d;
    const D = store.readDef(L.bid(k));
    if (!D) throw new Error(`the context projection has no definition for block ${L.bid(k)}`);
    const f = D.f || {};
    d = defs[k] = { key: intOf(`${D.sec}\x1F${D.role}\x1F${D.kind}\x1F${D.fh}`), vh: D.vh ?? null, sec: D.sec, role: D.role, name: D.name,
      bytes: D.bytes || 0, bucket: f.bucket || 'other', chars: D.chars || 0, f: D.sec === 'messages' ? f : null };
    return d;
  };

  // the break detail of a pair of blocks: from the projection, else from both blocks' texts (once)
  const blockOf = (bid) => {
    const D = store.readDef(bid);
    if (D.ref == null) return D; // unaddressable: its body is inline
    if (!resolve) throw new Error(`block ${bid} needs its text for a cache-break detail and no resolver was given`);
    const b = resolve(D.ref);
    if (!b) throw new Error(`block ${bid}: ${D.ref} does not resolve`);
    return b;
  };
  function detail(pk, ck) {
    const p = L.bid(pk), c = L.bid(ck), pair = `${p}\n${c}`;
    const got = store.brk(p, c) || found.get(pair);
    if (got) return got;
    const d = { brk: [p, c], ...blockDiff(blockOf(p), blockOf(c)) };
    found.set(pair, d);
    return d;
  }
  const seq = (list, attrs) => ({ n: list.length, key: (i) => def(list[i]).key, vol: (i) => !!(attrs[i] && attrs[i].volatile), sec: (i) => def(list[i]).sec, name: (i) => def(list[i]).name });
  // a call's cache break against its lane's base (the list and attributes of the lane's last call that chained a prefix), and the
  // byte-identity of the prefix before it (3.3:75, acceptance #12): no claim over a context shown in part or edited by the server;
  // else each position of [0, idx) holds, on both sides, a block whose verbatim slice with its cache_control cut out has the same
  // SHA-256 (`vh`), volatile positions skipped; a block with no verbatim slice (vh null) proves nothing, so the flag is false
  function cacheOf(base, list, attrs, x, compaction, usage) {
    const P = base ? seq(base.list, base.attrs) : null, C = seq(list, attrs);
    const brk = breakOf(P, C, { compaction, detail: (i) => detail(base.list[i], list[i]) });
    const blind = x.wire.contextState === 'partial' || x.wire.contextState === 'server_edited';
    let same = brk.idx > 0 && !blind && !!P;
    for (let i = 0; same && i < brk.idx; i++) {
      if (P.vol(i) && C.vol(i)) continue;
      const a = P.vol(i) ? null : def(base.list[i]).vh;
      same = a != null && a === (C.vol(i) ? null : def(list[i]).vh);
    }
    brk.prefixByteIdentical = same;
    brk.gt = realGroundTruth(same, usage.read, usage.create);
    brk.gtReal = true;
    if (base) brk.refRid = base.rid; // the 缓存对比步 (2.3): the call this one's break is taken against
    return brk;
  }
  // a fold's push: a call that sorts before its lane's last call puts the lane in again, its rows in step order with this one in place
  const pushOf = (take, callsOf, drop) => (rid, row) => {
    const call = take(rid, row), cs = callsOf(call);
    if (cs.length < 2 || byOrder(cs[cs.length - 2], call) < 0) return;
    const ids = cs.slice(0, -1).map((c) => String(c.id)), me = ord.get(rid);
    drop(call);
    let pending = true;
    for (const id of ids) {
      if (pending && stepOrder(me, ord.get(id)) < 0) { take(rid, row); pending = false; }
      take(id, rowOf(id));
    }
    if (pending) take(rid, row);
  };
  const K = { store, L, def, cacheOf, pushOf, at: (rid, row) => L.at(rid, rowOf, row) };
  const folds = new Map(); // wire format → its fold
  function push(rid, row, reader) {
    rowOf = reader;
    const x = row.x || {};
    if (x.item) items.set(rid, x.item);
    if (isCall(row)) {
      if (!folds.has(x.format)) folds.set(x.format, x.format === 'anthropic' ? anthropicFold(K) : flatFold(boardDissectorOf(x.format), K));
      folds.get(x.format).push(rid, row);
    } else if (x.unknown) (x.item.is_llm_call ? unknown : other).push({ at: { ts_request: x.item.ts_request, id: x.item.id }, facts: x.unknown });
  }
  function doc() {
    const facts = (xs) => [...xs].sort((a, b) => stepOrder(a.at, b.at)).map((u) => u.facts);
    if (!folds.size) return { ...assembleUnknown(facts(unknown.length ? unknown : other)), items: new Map(items) };
    [...folds.values()].flatMap((f) => f.calls()).sort(byOrder).forEach((c, i) => { c.gi = i; });
    const first = (v) => (v.steps.length ? v.steps[0].gi : Infinity);
    const views = [...folds.values()].map((f) => f.finish()).sort((a, b) => first(a) - first(b));
    const A = views.length === 1 ? views[0] : mergeViews(views);
    tellApart(A.lanes);
    if (unknown.length) A.unknown = unknownSummary(facts(unknown), true);
    for (const l of A.lanes) l.key = l.calls.length ? String(l.calls[0].id) : null;
    A.items = new Map(items);
    return A;
  }
  return { push, doc };
}

// The Anthropic wire's fold: the analyzer's lanes (createAnalyzer, fed call views), each call baked against its lane's base.
function anthropicFold({ at, def, cacheOf, pushOf }) {
  const an = createAnalyzer();
  const lanes = new Map(); // the analyzer's lane → { base, last: { list, comp } }
  function view(row, list, mb) {
    const messages = mb.map((s, j) => {
      const end = j + 1 < mb.length ? mb[j + 1] : list.length, ks = list.slice(s, end);
      const uses = [];
      for (const k of ks) { const f = def(k).f; if (f && f.type === 'tool_use') uses.push([f.id, f.name]); }
      return { role: def(ks[0]).role, uses, get blocks() { return ks.map((k) => def(k).f); } };
    });
    return { facts: row.x.facts, messages };
  }
  function take(rid, row) {
    const x = row.x, e = at(rid, row), list = e.list, attrs = row.attrs || {};
    const call = an.pushView(view(row, list, e.mb));
    const lane = an.laneOf(call);
    if (lane.calls[0] === call) an.ask(lane, firstHumanOf(list, def));
    call.wire = x.wire;
    call.respRefs = x.respRefs;
    call.usage = x.usage;
    const st = lanes.get(lane) || { base: null, last: null };
    lanes.set(lane, st);
    call.cacheBreak = cacheOf(st.base, list, attrs, x, !!call.compaction, call.usage);
    call.gt = call.cacheBreak.gt;
    if (call.chainsPrefix !== false) st.base = { rid, list, attrs };
    call.comp = compOf(st.last, list, def);
    st.last = { list, comp: call.comp };
    call.flat = []; call.nonBlockKeys = []; call.paged_out = true;
    call.rec = { id: x.item.id, request: requestOf(x, list, def) };
    call.norm = { usage: x.facts.usage };
    return call;
  }
  const push = pushOf(take, (call) => an.laneOf(call).calls, (call) => { const lane = an.laneOf(call); an.drop(lane); lanes.delete(lane); });
  return { push, calls: () => an.calls(), finish() { const A = an.finish(); A.provider = 'cc'; return A; } };
}

// A flat-lane wire's fold (assemble.mjs flatLaneFold over rows): a lane per agent (a subagent named by the harness's agent id or the
// wire's own, the rest by lane kind), each call's compaction verdict on the dissector's message count, its cache break against its
// lane's last call that did not fail; the document names lanes by kind (flatLaneView).
function flatFold(d, { at, def, cacheOf, pushOf }) {
  const byLane = new Map(), base = new Map(), info = new Map(), last = new Map(), laneOfCall = new WeakMap(), asks = new WeakMap();
  function take(rid, row) {
    const x = row.x, e = at(rid, row), list = e.list, attrs = row.attrs || {}, h = x.hints || {};
    const kind = x.lane, agent = kind === 'subagent' ? h.laneKey ?? x.agent ?? null : null;
    const lane = agent == null ? kind : `${kind}\n${agent}`;
    // 3.4: a call whose context is unknown (a body that does not parse; a partial context, an unstored WebSocket request included) has
    // no observed message count: no compaction verdict, and not the next one's predecessor
    const noContext = !!x.unparsed || x.wire.contextState === 'partial';
    const comp = noContext ? { compaction: false } : compactionMeta(compactionVerdict(info.get(lane) || null,
      { hint: h.compaction === true, marker: h.compactionMarker === true, msgCount: x.msgCount || 0 }));
    if (!noContext) info.set(lane, { msgCount: x.msgCount || 0, marker: h.compactionMarker === true });
    const brk = cacheOf(base.get(lane), list, attrs, x, comp.compaction, x.usage);
    const rq = requestOf(x, list, def);
    const call = {
      gi: null, id: x.item.id, streamId: kind, rec: { id: x.item.id, request: rq }, norm: { usage: x.nu || {} }, wireFormat: d.id, ctx: x.ctx || 0,
      msgCount: rq.message_count || 0, tools: rq.tool_count || 0, ts: x.ts, status: x.status || null,
      ...comp, error: !!x.error, reqIncomplete: x.reqIncomplete, wsIncomplete: x.wsIncomplete, respIncomplete: x.respIncomplete,
      ...(x.unparsed ? { unparsed: true, errMsg: unparsedErrMsg(x.reqIncomplete) } : x.unstored != null ? { unparsed: true, errMsg: `unrenderable: ${x.unstored}` } : null),
      wire: x.wire, nonBlockKeys: [], ...(x.extraMessages ? { extraMessages: x.extraMessages } : null), respRefs: x.respRefs, flat: [], paged_out: true,
      comp: compOf(last.get(lane), list, def), usage: x.usage, cacheBreak: brk, gt: brk.gt,
    };
    last.set(lane, { list, comp: call.comp });
    laneOfCall.set(call, lane);
    if (!byLane.has(lane)) { byLane.set(lane, []); asks.set(call, firstHumanOf(list, def)); }
    byLane.get(lane).push(call);
    // a call that failed never established a cache prefix; one whose request was not stored does (with no blocks)
    if (!(x.error || (x.status != null && x.status !== 200))) base.set(lane, { rid, list, attrs });
    return call;
  }
  const push = pushOf(take, (call) => byLane.get(laneOfCall.get(call)), (call) => { const lane = laneOfCall.get(call); for (const m of [byLane, base, info, last]) m.delete(lane); });
  const calls = () => [...byLane.values()].flat();
  return { push, calls, finish: () => flatLaneView(d, calls(), (c) => asks.get(c)) };
}

// The first human prompt of a list (blockmeta firstHuman, from each user text's `human` fact).
function firstHumanOf(list, def) {
  for (const k of list) { const f = def(k).f; if (f && f.human) return f.human; }
  return null;
}
// The composition: the lane's previous call's, minus its blocks after the shared prefix, plus this call's.
function compOf(last, list, def) {
  const c = {};
  for (const k of COMP_KEYS) c[k] = last ? last.comp[k] : 0;
  let p = 0;
  if (last) { const m = Math.min(last.list.length, list.length); while (p < m && last.list[p] === list[p]) p++; }
  if (last) for (let i = p; i < last.list.length; i++) { const d = def(last.list[i]); c[d.bucket] -= d.bytes; }
  for (let i = p; i < list.length; i++) { const d = def(list[i]); c[d.bucket] += d.bytes; }
  return c;
}
// What the timeline reads of the request (assemble.mjs slimRec): the record's own, with what a stitched context changes — its message
// and tool counts and its system's characters — from the stitched list.
function requestOf(x, list, def) {
  const rq = { ...(x.rq || {}) };
  if (!x.continued) return rq;
  rq.message_count = (x.facts || x).msgCount;
  rq.tool_count = x.facts ? x.facts.tools : x.secs[0];
  let chars = 0;
  for (let i = x.secs[0]; i < x.secs[0] + x.secs[1]; i++) chars += def(list[i]).chars;
  rq.system_chars = chars;
  return rq;
}
