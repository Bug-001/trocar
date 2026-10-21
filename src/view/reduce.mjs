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
// It carries no `prefixSha256` (the board only ever compared digests: `prefixByteIdentical` says the same over the frame hashes).
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
  // a call row's { rid, list (ints), mb, depth }, through its base chain from the nearest list held
  function at(rid) {
    const hit = recent.get(rid) || keyframes.get(rid);
    if (hit) return remember(hit);
    const path = [];
    let e = null;
    for (let r = store.rows.get(rid); r; r = r.base == null ? null : store.rows.get(r.base)) {
      const c = recent.get(r.rid) || keyframes.get(r.rid);
      if (c) { e = c; break; }
      path.push(r);
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
const orderOfRow = (row) => ({ ts_request: row.x.item.ts_request, id: row.x.item.id });
const isCall = (row) => !!(row && row.x && Array.isArray(row.x.secs));

/**
 * reduce(store, members, {mark, resolve}) → the session's document (see the head of this file) at `mark` (design §3.4 "Extraction
 * frontier"): the reduction over the members whose record id is ≤ mark (posCmp) and nothing else. `members`: the session's index
 * rows (or record ids); those up to the mark that the store holds a row for are reduced, in write order, as the record path folds
 * them. With no mark, the mark is the store's frontier: the largest member such that every member up to it has a row. The document
 * carries `mark`; `failed: [{id, reason}]`, the members up to the mark whose row says why they did not extract (design §3.9, D38:
 * their call is shown by its reason, never dropped); and `pending: {done, total}` (members reduced, members) while any member is not
 * reduced (above the mark, failed, or with no row). `resolve(ref)` → the
 * flat entry of the block `ref` names (src/view/extract.mjs blockAt over the record read back): asked only for a break detail no
 * `brk` line holds yet.
 */
export function reduce(store, members, { mark = undefined, resolve = null } = {}) {
  const all = [...new Set(members.map(ridOf))].sort(posCmp);
  if (mark === undefined) { mark = null; for (const rid of all) { if (!store.rows.has(rid)) break; mark = rid; } }
  const upTo = mark == null ? [] : all.filter((rid) => posCmp(rid, mark) <= 0);
  const failed = [], rids = [];
  for (const rid of upTo) {
    const x = store.rows.has(rid) ? store.rows.get(rid).x || {} : null;
    if (x && typeof x.unparsed === 'string' && !x.item) failed.push({ id: rid, reason: x.unparsed });
    else if (x) rids.push(rid);
  }
  const found = new Map(); // break details worked out by this reduction, written as `brk` lines once it is done
  let doc;
  try { doc = reduceIn(store, rids, resolve, found); } catch (e) {
    if (!(e instanceof OrderBound)) throw e;
    // sub-agents told apart only by order: from scratch, in step order
    const byOrder = (a, b) => { const ra = store.rows.get(a), rb = store.rows.get(b); return ra.x.item && rb.x.item ? stepOrder(orderOfRow(ra), orderOfRow(rb)) : 0; };
    doc = reduceIn(store, rids.slice().sort(byOrder), resolve, found);
  }
  if (found.size) store.append({ brks: [...found.values()] });
  doc.mark = mark;
  if (failed.length) doc.failed = failed;
  if (rids.length < all.length) doc.pending = { done: rids.length, total: all.length };
  return doc;
}

const byOrder = (a, b) => stepOrder({ ts_request: a.ts, id: a.id }, { ts_request: b.ts, id: b.id });

function reduceIn(store, rids, resolve, found) {
  const L = listsOf(store), items = new Map(), unknown = [], other = [];
  const defs = []; // block int → what the reduction reads of its definition (held for this reduction only)
  const keys = new Map(); // (sec, role, kind, fh) → int
  const intOf = (s) => { let k = keys.get(s); if (k === undefined) keys.set(s, (k = keys.size)); return k; };
  const def = (k) => {
    let d = defs[k];
    if (d) return d;
    const D = store.readDef(L.bid(k));
    if (!D) throw new Error(`the context projection has no definition for block ${L.bid(k)}`);
    const f = D.f || {};
    d = defs[k] = { key: intOf(`${D.sec}\x1F${D.role}\x1F${D.kind}\x1F${D.fh}`), fh: intOf(D.fh), sec: D.sec, role: D.role, name: D.name,
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
  // byte-identity of the prefix before it: 3.2:124, no claim over a context shown in part or edited by the server; else the frames
  // before the break are the base's, volatile ones left out on each side (prefixChain's digest equality, over the frame hashes)
  function cacheOf(base, list, attrs, x, compaction, usage) {
    const P = base ? seq(base.list, base.attrs) : null, C = seq(list, attrs);
    const brk = breakOf(P, C, { compaction, detail: (i) => detail(base.list[i], list[i]) });
    const blind = x.wire.contextState === 'partial' || x.wire.contextState === 'server_edited';
    let same = brk.idx > 0 && !blind && !!P;
    for (let i = 0; same && i < brk.idx; i++) same = (P.vol(i) ? -1 : def(base.list[i]).fh) === (C.vol(i) ? -1 : def(list[i]).fh);
    brk.prefixByteIdentical = same;
    brk.gt = realGroundTruth(same, usage.read, usage.create);
    brk.gtReal = true;
    return brk;
  }
  // a fold's push: a call that sorts before its lane's last call puts the lane in again, its rows in step order with this one in place
  const pushOf = (take, callsOf, drop) => (rid) => {
    const call = take(rid), cs = callsOf(call);
    if (cs.length < 2 || byOrder(cs[cs.length - 2], call) < 0) return;
    const ids = cs.slice(0, -1).map((c) => String(c.id)), me = orderOfRow(store.rows.get(rid));
    drop(call);
    let pending = true;
    for (const id of ids) {
      if (pending && stepOrder(me, orderOfRow(store.rows.get(id))) < 0) { take(rid); pending = false; }
      take(id);
    }
    if (pending) take(rid);
  };
  const K = { store, L, def, cacheOf, pushOf };
  const folds = new Map(); // wire format → its fold
  for (const rid of rids) {
    const row = store.rows.get(rid), x = row.x || {};
    if (x.item) items.set(rid, x.item);
    if (isCall(row)) {
      if (!folds.has(x.format)) folds.set(x.format, x.format === 'anthropic' ? anthropicFold(K) : flatFold(boardDissectorOf(x.format), K));
      folds.get(x.format).push(rid);
    } else if (x.unknown) (x.item.is_llm_call ? unknown : other).push({ at: { ts_request: x.item.ts_request, id: x.item.id }, facts: x.unknown });
  }
  const facts = (xs) => [...xs].sort((a, b) => stepOrder(a.at, b.at)).map((u) => u.facts);
  if (!folds.size) return { ...assembleUnknown(facts(unknown.length ? unknown : other)), items };
  [...folds.values()].flatMap((f) => f.calls()).sort(byOrder).forEach((c, i) => { c.gi = i; });
  const first = (v) => (v.steps.length ? v.steps[0].gi : Infinity);
  const views = [...folds.values()].map((f) => f.finish()).sort((a, b) => first(a) - first(b));
  const A = views.length === 1 ? views[0] : mergeViews(views);
  tellApart(A.lanes);
  if (unknown.length) A.unknown = unknownSummary(facts(unknown), true);
  for (const l of A.lanes) l.key = l.calls.length ? String(l.calls[0].id) : null;
  A.items = items;
  return A;
}

// The Anthropic wire's fold: the analyzer's lanes (createAnalyzer, fed call views), each call baked against its lane's base.
function anthropicFold({ store, L, def, cacheOf, pushOf }) {
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
  function take(rid) {
    const row = store.rows.get(rid), x = row.x, e = L.at(rid), list = e.list, attrs = row.attrs || {};
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
    if (call.chainsPrefix !== false) st.base = { list, attrs };
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
function flatFold(d, { store, L, def, cacheOf, pushOf }) {
  const byLane = new Map(), base = new Map(), info = new Map(), last = new Map(), laneOfCall = new WeakMap(), asks = new WeakMap();
  function take(rid) {
    const row = store.rows.get(rid), x = row.x, e = L.at(rid), list = e.list, attrs = row.attrs || {}, h = x.hints || {};
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
    if (!(x.error || (x.status != null && x.status !== 200))) base.set(lane, { list, attrs });
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
