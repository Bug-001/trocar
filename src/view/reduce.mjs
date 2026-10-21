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
import { createAnalyzer, stepOrder, OrderBound, breakOf, blockDiff } from './analyze.mjs';
import { realGroundTruth, unknownSummary, assembleUnknown } from './assemble.mjs';
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
 * reduce(store, members, {resolve}) → the session's document (see the head of this file). `members`: the session's index rows (or
 * record ids); those the store holds a row for are reduced, in write order, as the record path folds them. `resolve(ref)` → the flat
 * entry of the block `ref` names (src/view/extract.mjs blockAt over the record read back): asked only for a break detail no `brk`
 * line holds yet.
 */
export function reduce(store, members, { resolve = null } = {}) {
  const rids = [...new Set(members.map(ridOf))].filter((rid) => store.rows.has(rid)).sort(posCmp);
  const found = new Map(); // break details worked out by this reduction, written as `brk` lines once it is done
  let doc;
  try { doc = reduceIn(store, rids, resolve, found); } catch (e) {
    if (!(e instanceof OrderBound)) throw e;
    // sub-agents told apart only by order: from scratch, in step order
    const byOrder = (a, b) => { const ra = store.rows.get(a), rb = store.rows.get(b); return ra.x.item && rb.x.item ? stepOrder(orderOfRow(ra), orderOfRow(rb)) : 0; };
    doc = reduceIn(store, rids.slice().sort(byOrder), resolve, found);
  }
  if (found.size) store.append({ brks: [...found.values()] });
  return doc;
}

function reduceIn(store, rids, resolve, found) {
  const L = listsOf(store), an = createAnalyzer(), items = new Map(), unknown = [], other = [];
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
  const lanes = new Map(); // the analyzer's lane → { base: the list and attributes of its last call that chained a prefix, last: { list, comp } }
  let calls = 0;

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
    calls++;
    const lane = an.laneOf(call);
    if (lane.calls[0] === call) an.ask(lane, firstHumanOf(list, def));
    call.wire = x.wire;
    call.respRefs = x.respRefs;
    call.usage = x.usage;
    const st = lanes.get(lane) || { base: null, last: null };
    lanes.set(lane, st);
    const P = st.base ? seq(st.base.list, st.base.attrs) : null, C = seq(list, attrs);
    const brk = breakOf(P, C, { compaction: !!call.compaction, detail: (i) => detail(st.base.list[i], list[i]) });
    // 3.2:124: no byte-identity claim over a context shown in part or edited by the server; else the frames before the break are the
    // previous call's, volatile ones left out on each side (prefixChain's digest equality, over the frame hashes)
    const blind = x.wire.contextState === 'partial' || x.wire.contextState === 'server_edited';
    let same = brk.idx > 0 && !blind && !!P;
    for (let i = 0; same && i < brk.idx; i++) same = (P.vol(i) ? -1 : def(st.base.list[i]).fh) === (C.vol(i) ? -1 : def(list[i]).fh);
    brk.prefixByteIdentical = same;
    brk.gt = realGroundTruth(same, call.usage.read, call.usage.create);
    brk.gtReal = true;
    call.cacheBreak = brk;
    call.gt = brk.gt;
    if (call.chainsPrefix !== false) st.base = { list, attrs };
    call.comp = compOf(st.last, list, def);
    st.last = { list, comp: call.comp };
    call.flat = []; call.nonBlockKeys = []; call.paged_out = true;
    call.rec = { id: x.item.id, request: requestOf(x, list, def) };
    call.norm = { usage: x.facts.usage };
    return call;
  }
  const byOrder = (a, b) => stepOrder({ ts_request: a.ts, id: a.id }, { ts_request: b.ts, id: b.id });
  // a call that sorts before its lane's last call: the lane goes in again, its rows in step order with this one in its place
  function push(rid) {
    const call = take(rid), lane = an.laneOf(call), cs = lane.calls;
    if (cs.length < 2 || byOrder(cs[cs.length - 2], call) < 0) return;
    const ids = cs.slice(0, -1).map((c) => String(c.id)), me = orderOfRow(store.rows.get(rid));
    an.drop(lane); lanes.delete(lane);
    let pending = true;
    for (const id of ids) {
      if (pending && stepOrder(me, orderOfRow(store.rows.get(id))) < 0) { take(rid); pending = false; }
      take(id);
    }
    if (pending) take(rid);
  }

  for (const rid of rids) {
    const row = store.rows.get(rid), x = row.x || {};
    if (x.item) items.set(rid, x.item);
    if (isCall(row)) {
      if (x.format !== 'anthropic') throw new Error(`reduce: calls on the ${x.format} wire are not reduced yet`);
      push(rid);
    } else if (x.unknown) (x.item.is_llm_call ? unknown : other).push({ at: { ts_request: x.item.ts_request, id: x.item.id }, facts: x.unknown });
  }
  const facts = (xs) => [...xs].sort((a, b) => stepOrder(a.at, b.at)).map((u) => u.facts);
  if (!calls) return { ...assembleUnknown(facts(unknown.length ? unknown : other)), items };
  an.calls().sort(byOrder).forEach((c, i) => { c.gi = i; });
  const A = an.finish();
  A.provider = 'cc';
  tellApart(A.lanes);
  if (unknown.length) A.unknown = unknownSummary(facts(unknown), true);
  for (const l of A.lanes) l.key = l.calls.length ? String(l.calls[0].id) : null;
  A.items = items;
  return A;
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
  rq.message_count = x.facts.msgCount;
  rq.tool_count = x.facts.tools;
  let chars = 0;
  for (let i = x.secs[0]; i < x.secs[0] + x.secs[1]; i++) chars += def(list[i]).chars;
  rq.system_chars = chars;
  return rq;
}
