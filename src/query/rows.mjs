// src/query/rows.mjs — the segment index as ONE list of rows, and which session each row belongs to.
//
// `sessions` and `session` must agree on membership, so it is computed here once (3.4: membership is a
// read-side decision) and both ask this module: `sessions` counts the rows, `session` reads back only the
// records of the one session it was asked for. Nothing here parses a record: a row is what the segment
// index already stored (src/query/index-build.mjs), which is why `sessions` can meet its ≤ 1 s budget on
// 1 GB (1.6 §4.1 速度目标) where reading every record back cost 4.5 s on Windows and 7 s on macOS.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createSynthAssigner } from '../dissect/synth-key.mjs';
import { LEGACY_PROVIDER, wireProviderOfEndpoint } from '../dissect/harnesses.mjs';
import { segmentFiles, warmSegmentIndex, problemEntry, recordsId, grownFrom } from './index-build.mjs';
import { trocarHome } from '../paths.mjs';
import { warmCache, fsTag } from './warm.mjs';
import { rowTable, heapOf, keysOf, wholeAt, cellAt } from './row-table.mjs';

// WARM (D63 ①, 1.6 §4.1 附近的查询): the rows of one segment come from the ONE warm reading of its index
// (src/query/index-build.mjs `warmSegmentIndex`, which `allSegments` reads through as well), kept against that
// segment's own source file, so a line appended to the live segment is never missed. The segment list is the names in
// raw/ (`segmentFiles`), read each time, and every segment's problems are said by each read: a note about the read that indexed
// a segment (`index-cold`) reaches this read's `errors` and no later one.

export const namesStamp = (home, fs) => { try { return fs.readdirSync(path.join(home, 'raw')).sort().join('\n'); } catch { return ''; } };

// The row list itself is kept per home (3.5 §缓存按依赖失效): a poll of the board asks for it every 1.5 s. It is rebuilt from the
// first segment whose warm index entry is not the one it was built from (the live segment is the last, so usually only its rows),
// with the synthesized-key rule resumed from the state it had after the segment before; nothing moved → the SAME row list, so the
// session groups below hold too. A list holds no row object (3.5 §内存有界 `steady`): per segment, its warm index view
// (src/query/row-table.mjs) and a column store of the same kind with what the list derives (`session_id`, `synthesized`); a row is
// a read-only flyweight over the two. Its session index (session id → positions in the list) is built and grown with it.
// What a list holds in the V8 heap beside its column stores (heapOf), each measured with liveHeap() on generated homes (forced GC
// before and after, divided by the count; 2026-10-23, node 22) × 1.25: a segment's part 350 B; an open synthesized key copied at a
// part's end 83 B; a session in the index 208 B (its Map entry and positions array); a position 8.8 B on average, charged at the
// 12 B a slot holds right after its array grew (1.5× its length).
const PART_HEAP = 450, OPEN_HEAP = 105, SESSION_HEAP = 260, POSITION_HEAP = 12;
const lists = warmCache({ max: 4, cost: (v) => v.heap, steady: true });
const copyOpen = (open) => new Map([...open].map(([k, v]) => [k, { ...v }])); // the rule moves `lastMs` in place
const lineOf = (id) => Number(String(id).split(':').pop());

/**
 * indexRows({home, fs, errors}) → a read-only row list (length, at, iteration, find, filter / map / slice → arrays) of
 * {…index row, segment, lineNo, session_id, synthesized}, oldest segment first, capture order inside a segment — the order the
 * synthesized keys (3.4 合成键) are assigned in, the same order the board stamps them in, so both name a session the same. It is
 * shared by every reader until a segment moves. What a segment could not say goes into `errors` (D38), never silently missing — on
 * every call.
 */
export async function indexRows({ home = trocarHome(), fs = nodeFs, errors = [] } = {}) {
  const segs = [];
  for (const [segment] of segmentFiles(home, fs)) {
    const { records, problems } = await warmSegmentIndex({ home, segment, fs });
    for (const pr of problems) errors.push(problemEntry(`segments/${segment}`, pr));
    segs.push({ segment, records, entry: recordsId(records) });
  }
  const stamp = segs.map((s) => `${s.segment}#${s.entry}`).join('\n');
  return lists.get(`${fsTag(fs)}\n${home}`, stamp, (old) => rowList(segs, old)).rows;
}
function rowList(segs, old) {
  let i = 0;
  if (old) while (i < segs.length && i < old.parts.length && old.parts[i].segment === segs[i].segment && old.parts[i].entry === segs[i].entry) i++;
  // only the newest segment grew, and its records begin with the ones its rows were built from (index-build.mjs grownFrom): its
  // rows so far stay, and its new records are added, the synthesized-key rule resumed from where those rows left it (3.5:45)
  const grown = !!old && i === segs.length - 1 && i === old.parts.length - 1 && old.parts[i].segment === segs[i].segment && grownFrom(segs[i].records) === old.parts[i].entry;
  const parts = old ? old.parts.slice(0, i) : [];
  // the positions the old list had all stay (only rows were added after them): its session index goes on, a session's positions
  // appended past the old list's count of them (a list reads its own `n` of a shared array; the array is copied only when another
  // list appended to it already); else it is built again from the derived columns
  const from = grown ? old.parts[i].end : i ? parts[i - 1].end : 0, extend = !!old && from === old.rows.length;
  const index = extend ? new Map(old.index) : new Map(), mine = new Set();
  let slots = extend ? old.slots : 0;
  const place = (sid, at) => {
    let v = index.get(sid);
    if (!v) { index.set(sid, (v = { a: [], n: 0 })); mine.add(v); } else if (!mine.has(v)) { index.set(sid, (v = { a: v.a.length === v.n ? v.a : v.a.slice(0, v.n), n: v.n })); mine.add(v); }
    v.a.push(at); v.n++; slots++;
  };
  if (!extend) for (const p of parts) for (let k = 0; k < p.end - p.start; k++) { const sid = cellAt(p.d, 0, k); if (sid) place(sid, p.start + k); }
  for (let j = i; j < segs.length; j++) {
    const { segment, records: view, entry } = segs[j], was = grown && j === i ? old.parts[i] : null;
    const start = was ? was.start : j ? parts[j - 1].end : 0, k0 = was ? was.end - was.start : 0;
    const open = copyOpen(was ? was.open : j ? parts[j - 1].open : new Map()), assign = createSynthAssigner({ open });
    const derived = [];
    for (let k = k0; k < view.length; k++) {
      const r = view.at(k);
      const synth = r.synth_hash ? assign({ harness: r.harness_id, hash: r.synth_hash, ms: Date.parse(r.ts || '') }) : null;
      const sid = r.session_key ?? synth ?? null;
      derived.push({ session_id: sid, synthesized: !!synth });
      if (sid) place(sid, start + k); // a row with no session id is in no group (sessionGroups)
    }
    parts.push({ segment, entry, view, d: was ? was.d.concat(derived) : rowTable(derived), start, end: start + view.length, open });
  }
  const n = parts.length ? parts[parts.length - 1].end : 0;
  const rows = new RowList(parts, n, index);
  let heap = heapOf(...parts.map((p) => p.d)) + SESSION_HEAP * index.size + POSITION_HEAP * slots;
  for (const p of parts) heap += PART_HEAP + OPEN_HEAP * p.open.size;
  // the member arrays of the list before, while something holds them: a session that got no rows keeps its array (3.5:45), a grown
  // one is that array and its new members (sessionGroups below)
  const was = extend && built.get(old.rows);
  if (was) built.set(rows, new Map(was));
  return { rows, parts, index, slots, heap };
}

// A row of a row list: ONE read-only flyweight (part, position) whose getters read the segment's column store and the list's derived
// one straight (row-table.mjs `cellAt`), so a scan makes one small object per row; it keeps the last cell it read, so a sort that
// compares `ts` decodes each row's time once. One class per index key set; a row the segment keeps whole is a frozen plain object.
const byKeys = new Map(), classes = new WeakMap();
const LISTED = { toJSON() { return { ...this }; } };
function listRow(p, k) {
  const x = wholeAt(p.view, k);
  if (x) return Object.freeze(Object.assign(Object.create(LISTED), x, { segment: p.segment, lineNo: lineOf(x.id), session_id: cellAt(p.d, 0, k), synthesized: cellAt(p.d, 1, k) }));
  const keys = keysOf(p.view);
  let Row = classes.get(keys);
  if (!Row) {
    const id = JSON.stringify(keys);
    if (!byKeys.has(id)) byKeys.set(id, rowClass(keys));
    classes.set(keys, (Row = byKeys.get(id)));
  }
  return new Row(p, k);
}
function rowClass(keys) {
  class Row {
    #p; #k; #c = -1; #v;
    constructor(p, k) { this.#p = p; this.#k = k; }
    static cell(r, c) { if (r.#c !== c) { r.#v = cellAt(r.#p.view, c, r.#k); r.#c = c; } return r.#v; }
    get segment() { return this.#p.segment; }
    get lineNo() { return lineOf(this.id); }
    // the derived columns, in the order rowList writes them: session_id, synthesized (always scalars, so never a row kept whole)
    get session_id() { return cellAt(this.#p.d, 0, this.#k); }
    get synthesized() { return cellAt(this.#p.d, 1, this.#k); }
    toJSON() {
      const o = {};
      for (const key of keys) o[key] = this[key];
      return Object.assign(o, { segment: this.segment, lineNo: this.lineNo, session_id: this.session_id, synthesized: this.synthesized });
    }
  }
  keys.forEach((key, c) => Object.defineProperty(Row.prototype, key, { get() { return Row.cell(this, c); } }));
  return Row;
}

class RowList {
  #parts; #n; #index;
  constructor(parts, n, index) { this.#parts = parts; this.#n = n; this.#index = index; Object.freeze(this); }
  static index(l) { return l.#index; }
  get length() { return this.#n; }
  at(i) {
    i = Math.trunc(i) || 0;
    if (i < 0) i += this.#n;
    if (i < 0 || i >= this.#n) return undefined;
    const ps = this.#parts;
    let lo = 0, hi = ps.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ps[mid].start <= i) lo = mid; else hi = mid - 1; }
    return listRow(ps[lo], i - ps[lo].start);
  }
  *[Symbol.iterator]() { for (const p of this.#parts) for (let k = 0; k < p.end - p.start; k++) yield listRow(p, k); }
  map(fn) { const out = new Array(this.#n); let i = 0; for (const r of this) { out[i] = fn(r, i, this); i++; } return out; }
  filter(fn) { const out = []; let i = 0; for (const r of this) if (fn(r, i++, this)) out.push(r); return out; }
  find(fn) { let i = 0; for (const r of this) if (fn(r, i++, this)) return r; return undefined; }
  slice(a = 0, b = this.#n) {
    const n = this.#n, at = (x) => (x < 0 ? Math.max(n + x, 0) : Math.min(x, n));
    const out = [];
    for (let i = at(Math.trunc(a) || 0), to = at(Math.trunc(b) || 0); i < to; i++) out.push(this.at(i));
    return out;
  }
}

/** as_of (附录 C.5): the newest call time in the WHOLE index — what every number of an index-reading document is
 *  counted as of (invariant 4); null when the index has no row with a time. */
export const asOf = (rows) => {
  if (asOfs.has(rows)) return asOfs.get(rows);
  let m = null;
  for (const r of rows) { const ts = r.ts; if (ts && (m == null || String(ts) > m)) m = String(ts); }
  if (rows instanceof RowList) asOfs.set(rows, m); // a row list never changes (a moved segment is a new list)
  return m;
};
const asOfs = new WeakMap();

// The member arrays a row list's groups made, by session, through WeakRefs: alive exactly while something (a session's plan) holds
// them, so the same session asked again gets the same array.
const built = new WeakMap();
/** The rows of every session, in the order the sessions were first seen, as a Map-shaped object (get / has / keys / entries /
 *  iteration / size). A row with no session id is the session-less control plane (telemetry / config / account) and is in no group.
 *  Over a row list, a session's member array is made when it is asked for; over a plain array of rows, every group at once. */
export function sessionGroups(rows) {
  if (!(rows instanceof RowList)) {
    const was = groups.get(rows);
    if (was) return was;
    const g = addGroups(new Map(), rows);
    groups.set(rows, g);
    return g;
  }
  let g = groups.get(rows);
  if (!g) groups.set(rows, (g = listGroups(rows)));
  return g;
}
const groups = new WeakMap();
function listGroups(rows) {
  const index = RowList.index(rows);
  let refs = built.get(rows);
  if (!refs) built.set(rows, (refs = new Map()));
  // the array still held for `id` when it is this list's (a list before this one made it: its positions are a prefix of these),
  // grown by the new members: a session's member array only grows, so what a member costs is its own row (an older list that asks
  // after a newer one grew it gets its own array)
  const held = (id, at) => {
    const ref = refs.get(id), a = ref && ref.deref();
    if (!a || a.length > at.n) return null;
    for (let i = a.length; i < at.n; i++) a.push(rows.at(at.a[i])); // grown in place: a holder counts the members it took (planOf)
    return a;
  };
  const make = (at) => at.a.slice(0, at.n).map((i) => rows.at(i));
  return {
    get size() { return index.size; },
    has: (id) => index.has(id),
    get(id) {
      const at = index.get(id);
      if (!at) return undefined;
      let a = held(id, at);
      if (!a) refs.set(id, new WeakRef((a = make(at))));
      return a;
    },
    *keys() { yield* index.keys(); },
    *entries() { for (const [id, at] of index) yield [id, held(id, at) || make(at)]; },
    [Symbol.iterator]() { return this.entries(); },
  };
}
// `g` with the rows of a plain array added
function addGroups(g, rows) {
  for (const r of rows) {
    if (!r.session_id) continue;
    let m = g.get(r.session_id);
    if (!m) g.set(r.session_id, (m = []));
    m.push(r);
  }
  return g;
}

const isProbe = (r) => /count_tokens/.test(r.path || '');

/** Which index rows are a MODEL CALL: the one rule every reader counts calls with (sessionFactsOf below,
 *  `overview`'s usage and the usage sidecar's fill), never a second copy of it. */
export const isModelCall = (r) => r.is_llm && !r.log_only;

/** sessionFacts(id) → {add(row), facts()}: one session's facts over the rows added so far, in member order, the way
 *  src/view/board.mjs derives them from the records themselves (sessionMetaFor): the harness of the first row that had `proc`, else
 *  of the first that had headers; the entrypoint of the first row that had headers; calls / logged / probes / other complementary,
 *  so they sum to the session. A growing session adds its new members only (src/query/named/session.mjs). */
export function sessionFacts(id) {
  let proc = null, headers = null, wire = null, calls = 0, logged = 0, probes = 0, other = 0, sub = false, last = '', synth = false;
  return {
    add(r) {
      if (!proc && r.has_proc) proc = r;
      if (!headers && r.has_headers) headers = r;
      if (!wire) wire = wireProviderOfEndpoint(r.path) || null;
      if (isModelCall(r)) calls++; else if (r.is_llm) logged++;
      if (isProbe(r)) probes++; else if (!r.is_llm) other++;
      if (r.subagent) sub = true;
      if (String(r.ts || '') > last) last = String(r.ts || '');
      if (r.synthesized) synth = true;
    },
    facts() {
      const first = proc || headers, harness = first ? first.harness_id : null;
      return {
        session_id: id,
        entrypoint: headers ? headers.entrypoint : null,
        harness,
        harness_inferred: !!(first && first.harness_inferred),
        // a harness that can be pointed at ANY backend has no provider unless the wire showed one (gate G10)
        provider: harness == null ? null : LEGACY_PROVIDER[harness] ?? wire ?? null,
        calls, logged, probes, other,
        has_subagent: sub,
        last_ts: last,
        session_synthesized: synth,
      };
    },
  };
}
/** One session's facts over its rows (sessionFacts). */
export function sessionFactsOf(id, rows) {
  const f = sessionFacts(id);
  for (const r of rows) f.add(r);
  return f.facts();
}
