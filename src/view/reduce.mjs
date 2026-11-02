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
// that differ only past that are the same to it; here a block is its whole frame (real captures carry blocks that differ only past 4,096 characters).
import { createAnalyzer, stepOrder, OrderBound, breakOf, blockDiff, compactionMeta, unparsedErrMsg, laneMeta, replayLedger } from './analyze.mjs';
import { realGroundTruth, unknownSummary, FLAT_LANES } from './assemble.mjs';
import { callRow, itemsView } from './board.mjs';
import { compareStep } from './step-order.mjs';
import { compactionVerdict } from '../identity/session-identity.mjs';
import { boardDissectorOf } from '../dissect/registry.mjs';
import { COMP_KEYS, departer, departs, taskOf, HEAD } from './blockmeta.mjs';
import { posCmp, lru, num52, numTable } from '../query/projection.mjs';
import { materializeAttrs } from './extract.mjs';
import { openFoldLog } from '../query/fold-log.mjs';

const CPS = 256; // the lane states a reduction keeps of its last takes, for a late call to go back to (pushOf)
const KEYFRAME = 32; // a materialised list kept every KEYFRAME links of a base chain
// what the lists kept (keyframes and the lists asked last) and the facts read back may weigh in the heap: each a cache of two times
// its figure (src/query/projection.mjs lru)
const LIST_BYTES = 2 << 20, FACTS_BYTES = 2 << 20;
/** The shape of reduction().snapshot(): one more whenever what it holds changes. */
export const REDUCE_V = 1;
/** What a store's reduction caches hold at most beside its block columns (src/query/named/session.mjs counts it with the store's). */
export const REDUCE_HEAP = 2 * (LIST_BYTES + FACTS_BYTES);

// ── blocks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A block is the store's own definition slot (store.defSlot). What the reduction reads of a definition is kept in typed columns by
// slot, filled from its line the first time a slot is asked for; a definition's facts `f` are read from its line when asked (the
// blocks of messages new to their lane, a lane's first prompt), through a cache weighed in bytes. So a block costs a few columns,
// never its definition (3.5 §内存有界 SPINE_PER_BLOCK).
// value → the first slot that had it; `read(slot)` → that slot's value (read back to verify a hit: a collision never merges two).
// Its ids are compared for equality only, within one call (cacheOf, breakOf), and no state or line holds one: whatever order an
// interner fills in, two slots share an id iff their values are equal, so a reduction resumed over a store opened afresh (and its
// interners filled afresh) folds the same bytes, and the interners are no part of a snapshot.
function interner(read) {
  const first = numTable(), spill = new Map(); // spill: values whose number another value holds
  return (v, slot) => {
    const h = num52(v), s = first.get(h);
    if (s === undefined) { first.set(h, slot); return slot; }
    if (read(s) === v) return s;
    const t = spill.get(v);
    if (t !== undefined) return t;
    spill.set(v, slot);
    return slot;
  };
}
// a small closed set of strings (a section, a role, a bucket) as an index into a table
function enumOf() {
  const ix = new Map(), names = [];
  return { id: (v) => { let k = ix.get(v); if (k === undefined) { k = names.length; names.push(v); ix.set(v, k); } return k; }, name: (k) => names[k] };
}
const BLOCKS = new WeakMap(); // store → its block columns
function blocksOf(store) {
  if (BLOCKS.has(store)) return BLOCKS.get(store);
  let cap = 0, known, key, vh, name, bytes, chars, sec, role, bucket;
  const grow = (n) => {
    const to = Math.max(256, cap * 2, n), m = (T, a) => { const x = new T(to); if (a) x.set(a); return x; };
    known = m(Uint8Array, known); key = m(Int32Array, key); vh = m(Int32Array, vh); name = m(Int32Array, name);
    bytes = m(Uint32Array, bytes); chars = m(Uint32Array, chars); sec = m(Uint16Array, sec); role = m(Uint16Array, role); bucket = m(Uint16Array, bucket);
    cap = to;
  };
  const E = enumOf(), facts = lru(2 * FACTS_BYTES);
  const readDef = (k) => {
    const D = store.readDef(store.defBid(k));
    if (!D) throw new Error(`the context projection has no definition for block ${store.defBid(k)}`);
    return D;
  };
  const keyText = (D) => `${D.sec}\x1F${D.role}\x1F${D.kind}\x1F${D.fh}`;
  const keys = interner((k) => keyText(readDef(k))), vhs = interner((k) => readDef(k).vh), names = interner((k) => readDef(k).name);
  const remember = (k, f) => { facts.set(k, f, 2 * JSON.stringify(f || null).length + 64); return f; };
  const factsOf = (D) => (D.sec === 'messages' ? D.f || {} : null);
  const fill = (k) => {
    if (k < cap && known[k]) return k;
    if (k >= cap) grow(k + 1);
    const D = readDef(k);
    key[k] = keys(keyText(D), k);
    vh[k] = D.vh == null ? -1 : vhs(D.vh, k);
    name[k] = typeof D.name === 'string' ? names(D.name, k) : -1;
    bytes[k] = D.bytes || 0; chars[k] = D.chars || 0;
    sec[k] = E.id(D.sec); role[k] = E.id(D.role); bucket[k] = E.id((D.f && D.f.bucket) || 'other');
    known[k] = 1;
    if (D.sec === 'messages') remember(k, factsOf(D)); // a block seen the first time is a new one: its facts are asked next
    return k;
  };
  // (each column read after fill: it may grow the columns)
  const B = {
    key: (k) => { fill(k); return key[k]; },
    vh: (k) => { fill(k); return vh[k] < 0 ? null : vh[k]; },
    name: (k) => { fill(k); return name[k] < 0 ? undefined : name[k]; },
    bytes: (k) => { fill(k); return bytes[k]; },
    chars: (k) => { fill(k); return chars[k]; },
    sec: (k) => { fill(k); return E.name(sec[k]); },
    role: (k) => { fill(k); return E.name(role[k]); },
    bucket: (k) => { fill(k); return E.name(bucket[k]); },
    // the facts of a block of the messages (null for one of the tools or system), read back when the cache no longer holds them
    f: (k) => {
      if (B.sec(k) !== 'messages') return null;
      const hit = facts.get(k);
      return hit !== undefined ? hit : remember(k, factsOf(readDef(k)));
    },
  };
  BLOCKS.set(store, B);
  return B;
}

// ── lists ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const attrCount = (a) => { let n = 0; for (const _ in a) n++; return n; };
const LISTS = new WeakMap(); // store → its lists (blocks as the store's definition slots)
function listsOf(store) {
  if (LISTS.has(store)) return LISTS.get(store);
  const int = (bid) => {
    const k = store.defSlot(bid);
    if (k === undefined) throw new Error(`the context projection has no definition for block ${bid}`);
    return k;
  };
  const held = lru(2 * LIST_BYTES); // rid → its list: keyframes and the lists asked last alike
  // a list weighs 16 B an element (arrays of small integers built by push: 8 B an element and up to half again of spare room; at
  // 8 B an element the cache held 7.3 MB at its 4 MB figure, test/query/big-session.mjs live(0.48))
  // an attribute entry weighs as a few list elements (its key, its object's slot; the attribute objects are the rows' own)
  const keep = (e) => { held.set(e.rid, e, 16 * (e.list.length + e.mb.length + 4 * attrCount(e.attrs)) + 160); return e; };
  const apply = (base, { k = 0, patch, add }, map) => {
    const out = base ? base.slice(0, k) : [];
    for (const [i, v] of patch || []) out[i] = map(v);
    for (const v of add || []) out.push(map(v));
    return out;
  };
  const same = (v) => v;
  // a call row's { rid, list (slots), mb, attrs, depth }, through its base chain from the nearest list held; `head`: the row itself when the
  // caller holds it, `rowOf`: how a row of the chain is read
  function at(rid, rowOf = (r) => store.rows.get(r), head = null) {
    const hit = held.get(rid);
    if (hit) return hit;
    const path = [];
    let e = null;
    for (let r = head || rowOf(rid); r;) {
      path.push(r);
      if (r.base == null) break;
      const c = held.get(r.base); // a base whose list is held is not read
      if (c) { e = c; break; }
      r = rowOf(r.base);
    }
    if (!e && !path.length) return null;
    for (let i = path.length - 1; i >= 0; i--) {
      const r = path[i], from = r.base != null ? e : null;
      e = { rid: r.rid, list: apply(from && from.list, r, int), mb: apply(from && from.mb, r.mb || {}, same), attrs: materializeAttrs(from && from.attrs, { k: r.k, attrs: r.attrs || {} }), depth: from ? from.depth + 1 : 0 };
      if (e.depth % KEYFRAME === 0) keep(e);
    }
    return keep(e);
  }
  const lists = { at, bid: (k) => store.defBid(k) };
  LISTS.set(store, lists);
  return lists;
}
/** listOf(store, rid) → { bids, attrs, mb } of a call row: its list of block ids, its attributes by position, its message starts. */
export function listOf(store, rid) {
  const L = listsOf(store), e = L.at(String(rid));
  return e ? { bids: e.list.map(L.bid), attrs: e.attrs, mb: e.mb.slice() } : null;
}

// ── reduce ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ridOf = (m) => String(m && typeof m === 'object' ? m.id : m);
const isCall = (row) => !!(row && row.x && Array.isArray(row.x.secs));
const enoent = () => { throw Object.assign(new Error('no file: the fold log is held in memory'), { code: 'ENOENT' }); };
/** An fs with no files: what an in-memory store or fold log is opened over (it reads nothing back and writes nothing). */
export const NO_FILE = { statSync: enoent, readdirSync: enoent, openSync: enoent, closeSync() {}, readSync: () => 0 };
/** A block a cache-break detail needs whose text did not read back (3.5 §读不全不静默): `code` one of BLOCK_PROBLEMS
 *  (src/health/codes.mjs), `rid` the member whose take needed it. A resolver throws it to say why; null from it is `record-missing`. */
export class BlockUnread extends Error {
  constructor(code, reason) { super(reason); this.code = code; this.rid = null; }
}
/** memoryLog(store) → a fold log (src/query/fold-log.mjs) held in memory only, over no file: what reduce() folds into. */
export const memoryLog = (store) => openFoldLog({ home: '/', fs: NO_FILE, key: 'reduce', write: false, projection: { id: store.id, bytes: store.bytes } });

/**
 * reduce(store, members, {mark, resolve, errors}) → skeletonDoc of the reduction at `mark` (the 归约前沿 of 3.5 §访问模式; 4.3 §1 归约状态),
 * folded into a fold log held in memory: the members whose record id is ≤ mark (posCmp) and nothing else. `members`: the session's
 * index rows (or record ids); those up to the mark that the store holds a row for are folded. With no mark, the mark is the store's
 * frontier: the largest member such that every member up to it has a row. `pending: {done, total}` (members up to the mark that
 * have a row, members) while a member is above the mark or has no row — a failed member is reported in `failed`, not pending (3.5:43).
 */
export function reduce(store, members, { mark = undefined, resolve = null, errors = undefined } = {}) {
  const all = [...new Set(members.map(ridOf))].sort(posCmp);
  if (mark === undefined) { mark = null; for (const rid of all) { if (!store.rows.has(rid)) break; mark = rid; } }
  const upTo = mark == null ? [] : all.filter((rid) => posCmp(rid, mark) <= 0 && store.rows.has(rid));
  const log = memoryLog(store), R = reduction(store, { log, resolve, errors });
  R.add(upTo);
  const doc = { mark, ...(upTo.length < all.length ? { pending: { done: upTo.length, total: all.length } } : null), ...skeletonDoc(R) };
  log.close();
  return doc;
}

/**
 * reduction(store, {log, resolve, errors, progress}) → {add(rids, {budgetMs}) → the rids not reached, frontier, has(rid), log}: a
 * session's reduction that grows (3.5 §访问模式 "内存有界"), writing what it folds into the fold log `log` (src/query/fold-log.mjs).
 * `add(rids)`: member record ids that have a row, in any order. In write order each row is read from the store once, as it is
 * folded, until `budgetMs` is spent (the rest handed back); new rids that do not all sort after the last one folded (write order;
 * step order once the reduction is in step order) fold again from scratch over everything added, as an `OrderBound` does (sub-agents
 * told apart by order only: then in step order). A call that sorts before its lane's last call folds its lane again from the first
 * call it sorts before (pushOf).
 *   Each call folded is one call line `{c: rid, r: row, e: lane events, d: ledger delta, rc: record facts}`: its skeleton row (3.5
 * §会话读 row closed set, src/view/board.mjs callRow, `lane` = its lane's key), its lane events in the lane answer's form (no tool
 * input), what it did to its lane's ledger (analyze.mjs replayLedger), its record's facts. A line is appended only when its bytes
 * differ from the rid's latest (an 8-byte digest per rid). After each add, in order: the lines of calls whose lane key or spawned
 * lane changed, lane header lines that changed (3.5 lane-header closed set), lane-gone lines, item lines (members that are no call),
 * failed lines, and one frontier line `{f: the last rid in write order, n: members folded, pb: the projection's bytes, st: stats}`.
 *   The heap keeps per member, by its row's slot in the store, its step-order ts and its latest line's digest; per lane its calls'
 * slots in step order, its base and last call (their lists through the bounded list cache), last composition, first prompt, the
 * sums its header and the stats read, and the analyzer's state (its lane ledgers among it); the spawns' 60-character prompt
 * heads for linking; the lane states of the last CPS takes (a late call goes back to one). No call, event or document is kept.
 * `members()`: the rids read so far, failed ones included.
 * `progress(rid)` is called once per row folded (the worker's silence clock, 3.5:46). `failedBefore(rid)` → the failed line
 * `{x, reason, code}` a member already has in the fold log this reduction rebuilds up to, or null: such a member stays failed, as a
 * member whose record did not parse (3.5 §读不全不静默: failed until the fold log is rebuilt).
 *   `snapshot()` (between adds) → the reduction's state as plain data (Map, Set, arrays, typed arrays, plain objects; REDUCE_V), to be
 * passed through v8.serialize (in one call: its lanes are shared by identity) before the next add; `from`: such a snapshot, of this
 * store (its id, and at least the rows it had), with `log` the fold log it folded into: the reduction goes on from it as the one that
 * took it would. What only saves work (the list and facts caches, the fold log's read cache) is no part of it.
 */
export function reduction(store, { log, resolve = null, errors = undefined, progress = null, failedBefore = null, from = null } = {}) {
  const L = listsOf(store), B = blocksOf(store);
  if (from && (from.v !== REDUCE_V || from.store !== store.id || !(from.rows <= store.rows.size))) throw new RangeError('not a snapshot of a reduction of this store');
  // per member, by its row's slot in the store (store.rows.slotOf): its ts and its call's own ts (step order; one string when they
  // are equal), the digest of its latest line (NaN: none yet; 0: an item); failed rid → its line's offset; the item lines' offsets;
  // lane key → its header line's digest; spawn → the child lane its call line names
  const st = from || { ts: [], cts: [], dig: new Float64Array(1024).fill(NaN), failed: new Map(), items: [], heads: new Map(), written: new Map(),
    inStep: false, last: -1, top: null, n: 0, F: null };
  const { ts, cts, failed, items, heads, written } = st;
  let { dig, inStep, last, top, n } = st;
  const ridAt = (k) => store.rows.keyAt(k), slotOf = (rid) => store.rows.slotOf(rid);
  const found = new Map(); // break details worked out by this reduction, written as `brk` lines once an add is done
  let pend = [], newItems = [], newFailed = [], F, taking = null;
  const before = (a, b) => compareStep(cts[a], ridAt(a), cts[b], ridAt(b));
  const byStep = (a, b) => { const p = slotOf(a), q = slotOf(b); return ts[p] != null && ts[q] != null ? compareStep(ts[p], a, ts[q], b) : 0; };
  const setDig = (k, h) => { if (k >= dig.length) { const d = new Float64Array(Math.max(2 * dig.length, k + 1)).fill(NaN); d.set(dig); dig = d; } dig[k] = h; };
  const flush = () => { if (pend.length) log.append(pend, { errors }); pend = []; };
  const put = (k, line) => { const h = num52(JSON.stringify(line)); if (dig[k] === h) return; setDig(k, h); pend.push(line); if (pend.length >= 256) flush(); };
  // the latest line of a call, changed by `edit` (false: unchanged), written again
  const rewrite = (k, edit) => { flush(); const at = log.latest(ridAt(k)); if (!at) return; const { p, ...o } = log.read(...at); const line = structuredClone(o); if (edit(line) !== false) put(k, line); };

  // a lane's sums for the stats and its header (its calls' peak context, compactions, tokens in and out, monitor flags)
  const sums = () => ({ peak: 0, cmp: 0, tin: 0, tout: 0, flags: 0 });
  // ── one pass of the fold: its lanes, from scratch on again()
  const fold = () => ({ subs: new Map(), flat: new Map(), dls: new Map(), an: null, spawns: [], links: new Map(), uid: 0, relink: false, fresh: [], subsNew: [], inc: marks() });
  // what settle() redoes after an add: the doc lanes an add touched (`dirty`), or every lane (`all`: a fold begun or resumed, a lane
  // whose first call or spawn links moved, a wire's first call earlier: `ff`); the headers last made by lane (`h`), each lane's place in
  // F.dls (`ord`), the first prompts that are told apart (`dep`, `open`: lane → its prompt, `of`: prompt → its lanes), the stats as
  // the calls since the last full count left them (`st`, `kinds`), the lane states of the last takes (`cps`, pushOf). Not in a
  // snapshot: what only saves work; a resumed fold redoes every lane once.
  const marks = () => ({ all: true, dirty: new Set(), cps: [], st: null, kinds: null, ff: new Map(), h: new WeakMap(), ord: new WeakMap(), n: 0, dep: null, open: new WeakMap(), of: new Map() });
  F = fold();
  let rowOf = (rid) => store.rows.get(rid);
  // a doc lane (what the document shows as one lane: a sub-agent's analyzer lane, else a kind) and the sub-lanes it holds
  const dlOf = (S) => { let d = F.dls.get(S.dl); if (!d) { F.dls.set(S.dl, d = { id: S.dl, parts: new Set(), first: -1, moved: false }); F.inc.ord.set(d, F.inc.n++); } d.parts.add(S); return d; };
  const keyOf = (S) => ridAt(F.dls.get(S.dl).first);
  function newSub(fmt, kind, dl) {
    const S = { fmt, kind, dl, uid: F.uid++, rids: [], base: -1, last: -1, comp: null, ask: null, info: null, ...sums() };
    dlOf(S); F.subsNew.push(S);
    return S;
  }
  function dropSub(S) {
    S.rids = []; S.base = S.last = -1; S.comp = null; S.info = null; Object.assign(S, sums());
    F.spawns = F.spawns.filter((s) => s.S !== S); F.relink = true;
    const d = F.dls.get(S.dl);
    let first = -1;
    for (const T of d.parts) if (T.rids.length && (first < 0 || before(T.rids[0], first) < 0)) first = T.rids[0];
    if (first !== d.first) { d.first = first; d.moved = true; }
    F.inc.all = true;
  }
  // a call folded: its columns, its place in its lane, its line
  function emit(k, S, call, ev, ld, usage) {
    S.peak = Math.max(S.peak, call.ctx || 0); S.cmp += call.compaction ? 1 : 0; S.tin += usage.input_tokens || 0; S.tout += usage.output_tokens || 0;
    S.rids.push(k);
    count(S, call, usage);
    const d = F.dls.get(S.dl);
    F.inc.dirty.add(d);
    if (S.rids.length === 1) { const f = F.inc.ff.get(S.fmt); if (f === undefined || before(k, f) < 0) { F.inc.ff.set(S.fmt, k); F.inc.all = true; } } // a lane's lead is by its wires' first calls
    if (d.first < 0 || before(k, d.first) < 0) { if (d.first >= 0) d.moved = true; d.first = k; }
    const key = ridAt(d.first), rid = ridAt(k);
    const e = ev.map(({ step, streamId, childStreamId, ...x }, i) => {
      const out = { ...x, rid, lane: key };
      if (x.type === 'monitor' && x.flagged) S.flags++;
      if (x.type === 'spawn') {
        const sp = { k, i, head: ev[i].head || '', arg: x.arg, S };
        F.spawns.push(sp); F.fresh.push(sp);
        const child = F.links.get(`${k}:${i}`);
        if (child) out.childLane = keyOf(child);
        written.set(`${k}:${i}`, out.childLane ?? null);
      }
      return out;
    });
    const it = (store.rows.get(rid) || {}).x;
    put(k, { c: rid, r: callRow(call, key), e, d: ld, rc: recFacts(it && it.item) });
  }
  const K = { B, cacheOf, pushOf, emit, newSub, at: (rid, row) => L.at(rid, rowOf, row), baseOf, lastOf, int: slotOf };
  function push(rid, row, reader) {
    rowOf = reader;
    const k = slotOf(rid), x = row.x || {};
    if (!isCall(row)) { if (!(dig[k] >= 0)) { setDig(k, 0); newItems.push(k); } return; }
    if (!F.flat.has(x.format)) F.flat.set(x.format, foldOf(x.format));
    F.flat.get(x.format).push(rid, row);
  }
  // a wire's fold, from its state in a snapshot or anew
  const foldOf = (fmt, s = null) => (fmt === 'anthropic' ? anthropicFold(K, F, s) : flatFold(boardDissectorOf(fmt), K, F, s));
  if (st.F) { const { flat, ...rest } = st.F; Object.assign(F, rest); for (const [fmt, s] of flat) F.flat.set(fmt, foldOf(fmt, s)); }
  // the break detail of a pair of blocks: from the projection, else from both blocks' texts (once)
  const blockOf = (bid) => {
    const D = store.readDef(bid);
    if (D.ref == null) return D; // unaddressable: its body is inline
    if (!resolve) throw new Error(`block ${bid} needs its text for a cache-break detail and no resolver was given`);
    let b;
    try { b = resolve(D.ref); } catch (e) { if (e instanceof BlockUnread) e.rid ??= taking; throw e; }
    if (!b) throw Object.assign(new BlockUnread('record-missing', `block ${bid}: ${D.ref} does not resolve`), { rid: taking });
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
  const seq = (list, attrs) => ({ n: list.length, key: (i) => B.key(list[i]), vol: (i) => !!(attrs[i] && attrs[i].volatile), sec: (i) => B.sec(list[i]), name: (i) => B.name(list[i]) });
  // a lane's base (its last call that chained a prefix) and last call, from their rows and the list cache
  function baseOf(k) { if (k < 0) return null; const rid = ridAt(k); const e = L.at(rid, rowOf); return { rid, list: e.list, attrs: e.attrs }; }
  function lastOf(S) { return S.last < 0 ? null : { list: L.at(ridAt(S.last), rowOf).list, comp: S.comp }; }
  // a call's cache break against its lane's base, and the byte-identity of the prefix before it (3.3:75, acceptance #12): no claim
  // over a context shown in part or edited by the server; else each position of [0, idx) holds, on both sides, a block whose
  // verbatim slice with its cache_control cut out has the same SHA-256 (`vh`), volatile positions skipped; a block with no verbatim
  // slice (vh null) proves nothing, so the flag is false
  function cacheOf(base, list, attrs, x, compaction, usage) {
    const P = base ? seq(base.list, base.attrs) : null, C = seq(list, attrs);
    const brk = breakOf(P, C, { compaction, detail: (i) => detail(base.list[i], list[i]) });
    const blind = x.wire.contextState === 'partial' || x.wire.contextState === 'server_edited';
    let same = brk.idx > 0 && !blind && !!P;
    for (let i = 0; same && i < brk.idx; i++) {
      if (P.vol(i) && C.vol(i)) continue;
      const a = P.vol(i) ? null : B.vh(base.list[i]);
      same = a != null && a === (C.vol(i) ? null : B.vh(list[i]));
    }
    brk.prefixByteIdentical = same;
    brk.gt = realGroundTruth(same, usage.read, usage.create);
    brk.gtReal = true;
    if (base) brk.refRid = base.rid; // the 缓存对比步 (2.3): the call this one's break is taken against
    return brk;
  }
  // a lane's own state, as a take leaves it (its calls but their number, F.inc.cps)
  const laneState = (S) => ({ base: S.base, last: S.last, comp: S.comp, ask: S.ask, info: S.info, peak: S.peak, cmp: S.cmp, tin: S.tin, tout: S.tout, flags: S.flags });
  // a fold's push: a call that sorts before its lane's last call puts the lane in again from the first call it sorts before, its rows
  // in step order with this one in place: from the state the lane had just before that call when one of the last CPS takes left it
  // (the takes after it undone: `back`, the fold's own part of a lane), else from the lane's start. `mark()`: the fold's own part
  // of the lane the last take left.
  function pushOf(own, drop, mark = () => null, back = () => {}) {
    const take = (rid, row) => {
      taking = rid;
      const S = own(rid, row), cps = F.inc.cps;
      cps.push({ S, n: S.rids.length, s: laneState(S), m: mark(), dead: false });
      if (cps.length >= 2 * CPS) cps.splice(0, CPS);
      return S;
    };
    return (rid, row) => {
      const S = take(rid, row), cs = S.rids, me = cs[cs.length - 1];
      if (cs.length < 2 || before(cs[cs.length - 2], me) < 0) return;
      const ids = cs.slice(0, -1).map(ridAt);
      let j = 0;
      while (j < ids.length && byStep(rid, ids[j]) >= 0) j++;
      // the lane's takes back to the one that left it with j calls: one for each of its places cs.length … j + 1, newest first
      const cps = F.inc.cps, after = [];
      let at = -1;
      for (let i = cps.length - 1, want = cs.length; j > 0 && i >= 0; i--) {
        const c = cps[i];
        if (c.S !== S || c.dead) continue;
        if (c.n !== want) break;
        if (want === j) { at = i; break; }
        after.push(c); want--;
      }
      if (at >= 0) {
        const c = cps[at], gone = new Set([rid, ...ids.slice(j)].map(slotOf)), mine = (sp) => sp.S === S && gone.has(sp.k);
        after.reverse();
        for (const x of after) x.dead = true;
        back(S, c, after);
        Object.assign(S, c.s); S.rids = cs.slice(0, j); F.inc.st = null;
        if (F.spawns.some(mine)) { F.spawns = F.spawns.filter((sp) => !mine(sp)); F.fresh = F.fresh.filter((sp) => !mine(sp)); F.relink = true; F.inc.all = true; }
        take(rid, row);
        for (const id of ids.slice(j)) take(id, rowOf(id));
        return;
      }
      for (const c of cps) if (c.S === S) c.dead = true;
      drop(S); dropSub(S);
      let pending = true;
      for (const id of ids) {
        if (pending && byStep(rid, id) < 0) { take(rid, row); pending = false; }
        take(id, rowOf(id));
      }
      if (pending) take(rid, row);
    };
  }

  let reader = (rid) => store.rows.get(rid);
  const step = (rid, row) => { push(rid, row, reader); last = slotOf(rid); if (progress) progress(rid); };
  // a row read: a failed one noted, else its order kept (the row returned)
  function read(rid) {
    const row = store.rows.get(rid);
    if (!row) throw new Error(`the context projection has no row for ${rid}`);
    const k = slotOf(rid), x = row.x || {};
    if (top == null || posCmp(rid, top) > 0) top = rid;
    const was = failedBefore && failedBefore(rid);
    if (was || (typeof x.unparsed === 'string' && !x.item)) {
      if (!failed.has(rid)) { failed.set(rid, -1); newFailed.push(was ? { x: rid, reason: was.reason, code: was.code } : { x: rid, reason: x.unparsed, code: x.code || 'record-unparseable' }); }
      return null;
    }
    n++;
    ts[k] = x.item ? x.item.ts_request : null;
    const c = !isCall(row) ? ts[k] : x.format === 'anthropic' ? (x.facts || {}).ts_request : x.ts; // the call's own ts (its step order)
    cts[k] = c === ts[k] ? ts[k] : c;
    return row;
  }
  const folded = () => { const out = []; ts.forEach((t, k) => { const rid = ridAt(k); if (!failed.has(rid)) out.push(rid); }); return out; };
  // from scratch over everything added, each row read again
  function again() {
    F = fold(); last = -1; reader = (rid) => store.rows.get(rid);
    const all = folded().sort(posCmp);
    for (const rid of inStep ? all.sort(byStep) : all) step(rid, store.rows.get(rid));
  }
  function add(list, { budgetMs = Infinity } = {}) {
    const t0 = performance.now();
    const fresh = [...new Set(list.map(String))].filter((rid) => !has(rid)).sort(posCmp);
    let rest = [];
    // a member whose block did not read back fails, and the fold is rebuilt without it (one more member each round, so it ends)
    for (let first = true; ; first = false) try {
      if (!first) again();
      else if (!fresh.length) { /* nothing new */ } else if (!inStep && (last < 0 || posCmp(fresh[0], ridAt(last)) > 0)) {
        reader = (rid) => store.rows.get(rid);
        for (let i = 0; i < fresh.length; i++) { // write order: each row read once, as it is folded
          if (i && performance.now() - t0 >= budgetMs) { rest = fresh.slice(i); break; }
          const row = read(fresh[i]);
          if (row) step(fresh[i], row);
        }
      } else {
        const held = new Map(); // in step order: the new rows' order is read first, their rows kept while they are folded
        for (const rid of fresh) { const row = read(rid); if (row) held.set(rid, row); }
        const next = [...held.keys()].sort(byStep);
        reader = (rid) => held.get(rid) || store.rows.get(rid);
        if (!next.length) { /* only failures */ } else if (inStep && last >= 0 && byStep(next[0], ridAt(last)) > 0) for (const rid of next) step(rid, held.get(rid));
        else again();
      }
      break;
    } catch (e) {
      if (e instanceof BlockUnread && e.rid != null && !failed.has(e.rid)) {
        const k = slotOf(e.rid);
        failed.set(e.rid, -1); n--; newFailed.push({ x: e.rid, reason: e.message, code: e.code });
        if (dig[k] > 0 || dig[k] < 0) put(k, { g: e.rid }); // it had a call line: it is no call now
      } else if (!(e instanceof OrderBound) || inStep) throw e;
      else inStep = true; // sub-agents told apart only by order: from scratch, in step order
      for (const rid of fresh) if (!has(rid)) read(rid);
    }
    settle();
    if (found.size) { store.append({ brks: [...found.values()] }, { errors }); found.clear(); }
    return rest;
  }
  const has = (rid) => { const k = slotOf(String(rid)); return k !== undefined && (ts[k] !== undefined || failed.has(String(rid))); };

  // after an add: the calls whose lane key or child lane moved, the lane headers, the items, the failures, the frontier — of the lanes
  // the add touched (F.inc), so a call costs its own lanes, not the session's
  function settle() {
    flush();
    const I = F.inc;
    for (const d of I.all ? F.dls.values() : [...I.dirty].sort((a, b) => I.ord.get(a) - I.ord.get(b))) if (d.moved) {
      const key = ridAt(d.first);
      for (const S of d.parts) for (const k of S.rids) rewrite(k, (o) => {
        if (o.r.lane === key) return false;
        o.r.lane = key; for (const e of o.e) e.lane = key;
      });
      d.moved = false; I.all = true;
    }
    if (link() || I.all) for (const sp of F.spawns) {
      const sk = `${sp.k}:${sp.i}`, child = F.links.get(sk), want = child ? keyOf(child) : null;
      if (written.get(sk) === want) continue;
      written.set(sk, want);
      rewrite(sp.k, (o) => { const e = o.e[sp.i]; if (want == null) delete e.childLane; else e.childLane = want; });
    }
    const all = I.all, now = headers(), lines = [];
    for (const h of now) { const g = num52(JSON.stringify(h)); if (heads.get(h.lane) !== g) { heads.set(h.lane, g); const l = { l: h.lane, ...h }; delete l[HEAD]; lines.push(l); } }
    if (all) { const keys = new Set(now.map((h) => h.lane)); for (const key of [...heads.keys()]) if (!keys.has(key)) { heads.delete(key); lines.push({ lg: key }); } }
    for (const k of newItems) { const x = store.rows.get(ridAt(k)).x || {}; lines.push({ i: ridAt(k), it: x.item || null, ...(x.unknown ? { u: x.unknown } : null) }); }
    lines.push(...newFailed);
    if (top != null) lines.push({ f: top, n, pb: store.bytes, st: stats() });
    flush();
    if (lines.length) {
      const offs = log.append(lines, { errors });
      lines.forEach((o, j) => { const kind = Object.keys(o)[0]; if (kind === 'i') items.push(offs[j]); else if (kind === 'x') failed.set(o.x, offs[j]); });
    }
    newItems = []; newFailed = []; I.all = false; I.dirty.clear();
  }
  // spawns linked to sub-agent lanes (the record fold's rule, analyze.mjs finish): a sub-agent lane is spawned by the last spawn, in
  // the order of lanes by their first call and then of the lane's steps, whose prompt's head opens the lane's first user text.
  // → whether the links were made again (no new spawn, no new lane and none dropped: they stand)
  function link() {
    if (!F.relink && !F.fresh.length && !F.subsNew.length) return false;
    const order = (a, b) => before(a.S.rids[0], b.S.rids[0]) || before(a.k, b.k) || a.i - b.i;
    const matches = (S, sp) => { const p = sp.head; return p && F.firstText(S).includes(p.slice(0, 40)); };
    const subs = [...F.subs.values()].filter((S) => S.fmt === 'anthropic' && S.kind === 'subagent' && S.rids.length);
    const best = F.best || (F.best = new Map());
    const scan = (S, list) => {
      const was = best.get(S) || null;
      let b = was; for (const sp of list) if (matches(S, sp) && (!b || order(sp, b) > 0)) b = sp;
      if (b) best.set(S, b); else best.delete(S);
      if (b !== was) F.inc.dirty.add(F.dls.get(S.dl));
    };
    if (F.relink) { best.clear(); F.inc.all = true; for (const S of subs) scan(S, F.spawns); }
    else {
      const born = new Set(F.subsNew);
      for (const S of subs) scan(S, born.has(S) ? F.spawns : F.fresh);
    }
    F.relink = false; F.fresh = []; F.subsNew = [];
    // a spawn names the last lane (in the order of lanes by their first call) it spawned
    F.links = new Map();
    for (const S of subs.sort((a, b) => before(a.rids[0], b.rids[0]))) { const b = best.get(S); if (b) F.links.set(`${b.k}:${b.i}`, S); }
    return true;
  }
  // the lane headers (3.5 lane-header closed set) of the doc lanes whose header may have changed (every lane on F.inc.all), in the
  // order of F.dls; a lane's first prompt (HEAD) is kept on its header, for the next time a sibling's comes or goes
  function headers() {
    const I = F.inc, best = F.best || new Map();
    if (I.all) {
      I.ff = new Map(); I.ord = new WeakMap(); I.n = 0;
      for (const S of F.subs.values()) if (S.rids.length) { const f = I.ff.get(S.fmt); if (f === undefined || before(S.rids[0], f) < 0) I.ff.set(S.fmt, S.rids[0]); }
      for (const d of F.dls.values()) I.ord.set(d, I.n++);
    }
    const head = (d) => {
      const parts = [...d.parts].filter((S) => S.rids.length);
      if (!parts.length) return null;
      let count = 0, lastK = -1, peak = 1, flagged = 0;
      for (const S of parts) {
        count += S.rids.length; flagged += S.flags; peak = Math.max(peak, S.peak);
        const l = S.rids[S.rids.length - 1];
        if (lastK < 0 || before(l, lastK) > 0) lastK = l;
      }
      const lead = parts.slice().sort((a, b) => before(I.ff.get(a.fmt), I.ff.get(b.fmt)))[0], firstS = parts.find((S) => S.rids[0] === d.first);
      const meta = lead.fmt === 'anthropic' ? { kind: lead.kind, ...laneMeta(lead.kind) } : FLAT_LANES[lead.kind];
      const sp = lead.fmt === 'anthropic' && lead.kind === 'subagent' ? best.get(lead) : null;
      const h = { lane: ridAt(d.first), kind: meta.kind, icon: meta.icon, label: meta.label, task: sp ? sp.arg || taskOf(lead.ask) : null,
        ...(meta.note ? { note: meta.note } : null), count, first: ridAt(d.first), last: ridAt(lastK), peakCtx: peak,
        spawnRid: sp ? ridAt(sp.k) : null, parent: sp ? keyOf(sp.S) : null, flagged };
      if (!sp) h[HEAD] = firstS.ask ?? null;
      return h;
    };
    const ds = I.all ? [...F.dls.values()] : [...I.dirty];
    for (const d of ds) I.h.set(d, head(d));
    // the first prompts told apart: all of them anew, else each lane's that changed in and out, the lanes of every prompt whose
    // offset that moved redone too
    const more = new Set(ds), tell = (d, h) => { const o = I.of.get(h) || I.of.set(h, new Set()).get(h); o.add(d); I.open.set(d, h); };
    if (I.all) {
      I.open = new WeakMap(); I.of = new Map();
      for (const d of ds) { const h = I.h.get(d); if (h && departs(h)) tell(d, h[HEAD]); }
      I.dep = departer([...I.of].flatMap(([h, o]) => Array(o.size).fill(h)));
    } else for (const d of ds) {
      const h = I.h.get(d), was = I.open.get(d) ?? null, now = h && departs(h) ? h[HEAD] : null;
      if (was === now) continue;
      const moved = [];
      if (was != null) { I.of.get(was).delete(d); if (!I.of.get(was).size) I.of.delete(was); I.open.delete(d); moved.push(...I.dep.remove(was)); }
      if (now != null) { tell(d, now); moved.push(...I.dep.add(now)); }
      for (const p of moved) for (const e of I.of.get(p) || []) more.add(e);
    }
    const out = [];
    for (const d of [...more].sort((a, b) => I.ord.get(a) - I.ord.get(b))) {
      const h = I.h.get(d);
      if (!h) continue;
      if (HEAD in h) h.task = taskOf(h[HEAD] && h[HEAD].slice(I.open.has(d) ? I.dep.offset(h[HEAD]) : 0));
      out.push(h);
    }
    return out;
  }
  // the session's stats (the record fold's: analyze.mjs finish, assemble.mjs flatLaneView, mergeViews)
  // (over every lane when F.inc.all or a lane went back (pushOf); else as emit() kept them: `F.inc.st`)
  function stats() {
    const I = F.inc;
    if (!I.all && I.st) return { ...I.st };
    const s = { calls: 0, streams: 0, subagents: 0, monitors: 0, compactions: 0, totalIn: 0, totalOut: 0, peakCtx: 0 };
    const kinds = new Set();
    for (const S of F.subs.values()) {
      if (!S.rids.length) continue;
      s.calls += S.rids.length; s.compactions += S.cmp; s.totalIn += S.tin; s.totalOut += S.tout; if (S.peak > s.peakCtx) s.peakCtx = S.peak;
      if (S.fmt !== 'anthropic') { const kk = `${S.fmt}\n${S.kind}`; if (kinds.has(kk)) continue; kinds.add(kk); }
      s.streams++;
      if (S.kind === 'subagent') s.subagents++;
      if (S.fmt === 'anthropic' && S.kind === 'monitor') s.monitors += S.rids.length;
    }
    I.st = s; I.kinds = kinds;
    return { ...s };
  }
  // a call's part of the stats (stats() above, one lane's call at a time)
  function count(S, call, usage) {
    const T = F.inc.st;
    if (!T) return;
    T.calls++; T.compactions += call.compaction ? 1 : 0; T.totalIn += usage.input_tokens || 0; T.totalOut += usage.output_tokens || 0; if (S.peak > T.peakCtx) T.peakCtx = S.peak;
    if (S.rids.length === 1) {
      const kk = `${S.fmt}\n${S.kind}`;
      if (S.fmt === 'anthropic' || !F.inc.kinds.has(kk)) { if (S.fmt !== 'anthropic') F.inc.kinds.add(kk); T.streams++; if (S.kind === 'subagent') T.subagents++; }
    }
    if (S.fmt === 'anthropic' && S.kind === 'monitor') T.monitors++;
  }
  const R = {
    add, has, log,
    snapshot() {
      if (pend.length || found.size) throw new Error('a reduction is snapshotted between adds only');
      const { flat, firstText, an, inc, ...rest } = F;
      return { v: REDUCE_V, store: store.id, rows: store.rows.size, ts, cts, dig, failed, items, heads, written, inStep, last, top, n,
        F: { ...rest, flat: [...flat].map(([fmt, f]) => [fmt, f.snapshot()]) } };
    },
    members: () => [...folded(), ...failed.keys()],
    get frontier() { return top; },
    // what skeletonDoc reads besides the log: the calls in step order, the lanes in the order of their first call, items and failures
    view: () => ({
      calls: [...F.subs.values()].flatMap((S) => S.rids).sort(before).map(ridAt),
      lanes: [...F.dls.values()].filter((d) => d.first >= 0 && [...d.parts].some((S) => S.rids.length)).map((d) => d.first).sort(before).map(ridAt),
      items, failed: [...failed.values()],
    }),
  };
  return R;
}

/** skeletonDoc(R) → the comparison form of a reduction, read from its fold log: skeletonOf(R) with every lane's events and ledger
 *  (laneDoc) as {laneEvents: {key: events}, ledgers: {key: {resources, seen}}}. */
export function skeletonDoc(R) {
  const sk = skeletonOf(R), laneEvents = {}, ledgers = {};
  for (const h of sk.lanes) { const { rids, events, ...ledger } = laneDoc(R, h.lane); laneEvents[h.lane] = events; ledgers[h.lane] = ledger; }
  const { records, ...rest } = sk;
  return { ...rest, laneEvents, ledgers, records };
}
/** skeletonOf(R) → {rows (step order), lanes (headers, in the order of their first row), events [{type, rid, lane}], failed?,
 *  unknown?, stats, logged, probes, records (every member folded but the failed, in step order)}, read from R's fold log. */
function skeletonOf(R) {
  const { log } = R, v = R.view();
  const rows = [], events = [], records = [];
  for (const rid of v.calls) {
    const o = log.read(...log.latest(rid));
    rows.push(o.r);
    records.push({ id: rid, ...o.rc });
    for (const e of o.e) events.push({ type: e.type, rid, lane: o.r.lane });
  }
  const lanes = v.lanes.map((key) => { const { l, p, ...h } = log.read(...log.lane(key)); return h; });
  const its = v.items.map((off) => log.read(off)).filter((o) => o.it).sort((a, b) => stepOrder(a.it, b.it));
  for (const o of its) records.push({ id: o.i, ts_request: o.it.ts_request, is_llm_call: !!o.it.is_llm_call, response: { status: o.it.status ?? null } });
  records.sort(stepOrder);
  const llm = its.filter((o) => o.u && o.it.is_llm_call).map((o) => o.u), other = its.filter((o) => o.u && !o.it.is_llm_call).map((o) => o.u);
  const unknown = rows.length ? (llm.length ? unknownSummary(llm, true) : undefined) : unknownSummary(llm.length ? llm : other, false);
  const failed = v.failed.map((off) => { const { x, reason, code } = log.read(off); return { id: x, reason, code }; }).sort((a, b) => posCmp(a.id, b.id));
  const f = log.frontier == null ? null : log.read(log.frontier);
  return { rows, lanes, events, ...(failed.length ? { failed } : null), ...(unknown ? { unknown } : null),
    stats: f ? f.st : { calls: 0, streams: 0, subagents: 0, monitors: 0, compactions: 0, totalIn: 0, totalOut: 0, peakCtx: 0 }, ...itemsView(its.map((o) => o.it)), records };
}
/** The heap one entry of a kept ledger takes (a resource, a segment or load of it, a seen path; replayLedger's `units`): the most
 *  measured over ledgers of 3,040 resources (1–4 segments, 1–8 loads each) and 0–13,738 seen paths of ~50 characters, after a forced
 *  GC (232 B, all resources of one segment and load), × 1.25. */
export const LEDGER_UNIT_BYTES = 300;
/** The heap the kept lane ledgers may take (src/query/named/lane.mjs): a K term of the reduction's bound (3.5 §内存有界), each weighed
 *  by ledgerWeight; room for a lane of the generated 6,598-call session in test/query/big-session.mjs. */
export const LEDGER_BYTES = 8 << 20;
/** laneLedger(rids, deltaOf, base?, kept?) → {resources, seen, kept} of a lane from its steps' ledger deltas (deltaOf(i) → step i's
 *  `d` from its call line, asked only for the steps replayed; analyze.mjs replayLedger), `rids` its steps in step order (an entry's
 *  steps go on the wire as rids): resources' segments {enter, evict} and loads {rid, range, via}; seen paths {path, firstRid, count},
 *  every entry in the ledger's order. With `base` (a step's place): only the entries new after it or whose bytes differ from the
 *  ledger's at it (3.5 §会话读 `lane`). `kept: {maps, step}`: the replay's maps at `step` of these same steps (its rids up to it
 *  unchanged), with `base` -1 or `step`: only the steps after it are replayed, its maps going on in place. The `kept` returned: the
 *  maps at the last step (null for a lane of no step). */
export function laneLedger(rids, deltaOf, base = -1, kept = null) {
  const at = (n) => (n == null ? n : rids[n]);
  const res = ({ segments, loads, ...r }) => ({ ...r, segments: segments.map((g) => ({ enter: at(g.enter), evict: at(g.evict) })),
    loads: loads.map(({ step, ...x }) => ({ rid: at(step), ...x })) });
  const see = (f) => ({ path: f.path, firstRid: at(f.firstStep), count: f.count });
  const from = kept ? kept.step + 1 : 0, maps = kept ? kept.maps : { resources: new Map(), seen: new Map() };
  // the entries' wire bytes at `base`: all of them (a replay from the first step), or those the steps after a kept `base` touch
  let was = null;
  const touched = kept && base >= 0 ? (was = { r: new Map(), s: new Map() }) : null;
  const snap = (m, wire) => new Map([...m].map(([k, v]) => [k, JSON.stringify(wire(v))]));
  const steps = function* () { for (let i = from; i < rids.length; i++) yield [i, deltaOf(i) || []]; };
  replayLedger(steps(), touched ? null : (n, r, s) => { if (n === base) was = { r: snap(r, res), s: snap(s, see) }; }, maps,
    touched && ((kind, key, e) => { if (!touched[kind].has(key)) touched[kind].set(key, e ? JSON.stringify(kind === 'r' ? res(e) : see(e)) : null); }));
  const out = { kept: rids.length ? { maps, step: rids.length - 1 } : null };
  const resources = [], seen = [];
  for (const [k, r] of maps.resources) { const w = res(r); if (!was || (touched ? touched.r.has(k) : true) && was.r.get(k) !== JSON.stringify(w)) resources.push(w); }
  for (const [k, f] of maps.seen) { const w = see(f); if (!was || (touched ? touched.s.has(k) : true) && was.s.get(k) !== JSON.stringify(w)) seen.push(w); }
  return { ...out, resources, seen };
}
/** ledgerWeight(kept) → the heap a kept ledger (laneLedger's `kept`) is weighed at: its entries (counted as the replay changes them)
 *  × LEDGER_UNIT_BYTES. */
export const ledgerWeight = (kept) => kept.maps.units * LEDGER_UNIT_BYTES;
/** laneDoc(R, key) → {rids, events, resources, seen} of the lane `key` names, read from R's fold log: its calls in step order, their
 *  lane events, and its ledger (laneLedger). */
function laneDoc(R, key) {
  const { log } = R, lines = [];
  for (const rid of R.view().calls) { const o = log.read(...log.latest(rid)); if (o.r.lane === key) lines.push(o); }
  const { resources, seen } = laneLedger(lines.map((o) => o.c), (i) => lines[i].d);
  return { rids: lines.map((o) => o.c), events: lines.flatMap((o) => o.e), resources, seen };
}

const recFacts = (it) => (it ? { ts_request: it.ts_request, is_llm_call: !!it.is_llm_call, response: { status: it.status ?? null } } : {});

// The Anthropic wire's fold: the analyzer's lanes (createAnalyzer, fed call views, keeping nothing), each call baked against its
// lane's base and written out.
function anthropicFold({ at, B, cacheOf, pushOf, emit, newSub, baseOf, lastOf, int }, F, from) {
  const an = createAnalyzer({ keep: false, from: from && from.an });
  F.firstText = (S) => an.firstText(S.stream);
  // a call's view: its messages' roles from the columns, their tool uses and block facts read when the analyzer asks (the messages
  // new to the lane: analyze.mjs eventsOf)
  function view(row, list, mb) {
    const messages = mb.map((s, j) => {
      const end = j + 1 < mb.length ? mb[j + 1] : list.length;
      let blocks = null;
      const factsOf = () => blocks || (blocks = list.slice(s, end).map(B.f));
      return {
        role: B.role(list[s]),
        get uses() { const u = []; for (const f of factsOf()) if (f && f.type === 'tool_use') u.push([f.id, f.name]); return u; },
        get blocks() { return factsOf(); },
      };
    });
    return { facts: row.x.facts, messages };
  }
  let last = null; // the last take's lane and step
  function take(rid, row) {
    const x = row.x, e = at(rid, row), list = e.list, attrs = e.attrs, k = int(rid);
    const call = an.pushView(view(row, list, e.mb));
    const lane = an.laneOf(call);
    let S = F.subs.get(lane);
    if (!S) { S = newSub('anthropic', lane.kind, lane.kind === 'subagent' ? `\0${F.uid}` : lane.kind); S.stream = lane; F.subs.set(lane, S); }
    if (!S.rids.length) S.ask = firstHumanOf(list, B);
    call.wire = x.wire;
    call.respRefs = x.respRefs;
    call.usage = x.usage;
    call.cacheBreak = cacheOf(baseOf(S.base), list, attrs, x, !!call.compaction, call.usage);
    call.gt = call.cacheBreak.gt;
    call.comp = compOf(lastOf(S), list, B);
    if (call.chainsPrefix !== false) S.base = k;
    S.last = k; S.comp = call.comp;
    call.rec = { id: x.item.id, request: requestOf(x, list, B) };
    call.norm = { usage: x.facts.usage };
    emit(k, S, call, call.ev, call.ld, x.facts.usage || {});
    last = { S, undo: call.undo };
    return S;
  }
  return { push: pushOf(take, (S) => an.drop(S.stream), () => ({ a: an.save(last.S.stream), u: last.undo }), (S, c, after) => an.rewind(S.stream, c.m.a, after.map((x) => x.m.u))),
    snapshot: () => ({ an: an.snapshot() }) };
}

// A flat-lane wire's fold (assemble.mjs flatLaneFold over rows): a lane per agent (a subagent named by the harness's agent id or the
// wire's own, the rest by lane kind), each call's compaction verdict on the dissector's message count, its cache break against its
// lane's last call that did not fail; the document names lanes by kind (flatLaneView): one doc lane per kind.
function flatFold(d, { at, B, cacheOf, pushOf, emit, newSub, baseOf, lastOf, int }, F, from) {
  const lanes = from ? from.lanes : new Map();
  function take(rid, row) {
    const x = row.x, e = at(rid, row), list = e.list, attrs = e.attrs, h = x.hints || {}, k = int(rid);
    const kind = x.lane, agent = kind === 'subagent' ? h.laneKey ?? x.agent ?? null : null;
    const lk = agent == null ? kind : `${kind}\n${agent}`;
    let S = lanes.get(lk);
    if (!S) { S = newSub(d.id, kind, kind); lanes.set(lk, S); F.subs.set(`${d.id}\n${lk}`, S); }
    if (!S.rids.length) S.ask = firstHumanOf(list, B);
    // 3.4: a call whose context is unknown (a body that does not parse; a partial context, an unstored WebSocket request included) has
    // no observed message count: no compaction verdict, and not the next one's predecessor
    const noContext = !!x.unparsed || x.wire.contextState === 'partial';
    const comp = noContext ? { compaction: false } : compactionMeta(compactionVerdict(S.info,
      { hint: h.compaction === true, marker: h.compactionMarker === true, msgCount: x.msgCount || 0 }));
    if (!noContext) S.info = { msgCount: x.msgCount || 0, marker: h.compactionMarker === true };
    const brk = cacheOf(baseOf(S.base), list, attrs, x, comp.compaction, x.usage);
    const rq = requestOf(x, list, B);
    const call = {
      gi: null, id: x.item.id, streamId: kind, rec: { id: x.item.id, request: rq }, norm: { usage: x.nu || {} }, wireFormat: d.id, ctx: x.ctx || 0,
      msgCount: rq.message_count || 0, tools: rq.tool_count || 0, ts: x.ts, status: x.status || null,
      ...comp, error: !!x.error, reqIncomplete: x.reqIncomplete, wsIncomplete: x.wsIncomplete, respIncomplete: x.respIncomplete,
      ...(x.unparsed ? { unparsed: true, errMsg: unparsedErrMsg(x.reqIncomplete) } : x.unstored != null ? { unparsed: true, errMsg: `unrenderable: ${x.unstored}` } : null),
      wire: x.wire, nonBlockKeys: [], ...(x.extraMessages ? { extraMessages: x.extraMessages } : null), respRefs: x.respRefs, flat: [], paged_out: true,
      comp: compOf(lastOf(S), list, B), usage: x.usage, cacheBreak: brk, gt: brk.gt,
    };
    S.last = k; S.comp = call.comp;
    // a call that failed (x.error: the one verdict, extract.mjs callX) never established a cache prefix; one whose request was not stored does (with no blocks)
    if (!x.error) S.base = k;
    // the compaction events the board's outline lists, carrying the step's inference marker with them (invariant 4)
    const ev = call.compaction ? [{ type: 'compaction', step: null, streamId: kind, from: call.evictedFrom, to: call.evictedTo,
      inferred: call.compactionInferred, confidence: call.compactionConfidence, basis: call.compactionBasis }] : [];
    emit(k, S, call, ev, [], x.nu || {});
    return S;
  }
  return { push: pushOf(take, () => {}), snapshot: () => ({ lanes }) };
}

// The first human prompt of a list (blockmeta firstHuman, from each user text's `human` fact).
function firstHumanOf(list, B) {
  for (const k of list) { const f = B.f(k); if (f && f.human) return f.human; }
  return null;
}
// The composition: the lane's previous call's, minus its blocks after the shared prefix, plus this call's.
function compOf(last, list, B) {
  const c = {};
  for (const k of COMP_KEYS) c[k] = last ? last.comp[k] : 0;
  let p = 0;
  if (last) { const m = Math.min(last.list.length, list.length); while (p < m && last.list[p] === list[p]) p++; }
  if (last) for (let i = p; i < last.list.length; i++) c[B.bucket(last.list[i])] -= B.bytes(last.list[i]);
  for (let i = p; i < list.length; i++) c[B.bucket(list[i])] += B.bytes(list[i]);
  return c;
}
// What the timeline reads of the request (assemble.mjs slimRec): the record's own, with what a stitched context changes — its message
// and tool counts and its system's characters — from the stitched list.
function requestOf(x, list, B) {
  const rq = { ...(x.rq || {}) };
  if (!x.continued) return rq;
  rq.message_count = (x.facts || x).msgCount;
  rq.tool_count = x.facts ? x.facts.tools : x.secs[0];
  let chars = 0;
  for (let i = x.secs[0]; i < x.secs[0] + x.secs[1]; i++) chars += B.chars(list[i]);
  rq.system_chars = chars;
  return rq;
}
