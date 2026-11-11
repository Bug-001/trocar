// src/query/rows.mjs — the segment index as ONE list of rows, and which session each row belongs to.
//
// `sessions` and `session` must agree on membership, so it is computed here once (3.4: membership is a
// read-side decision) and both ask this module: `sessions` counts the rows, `session` reads back only the
// records of the one session it was asked for. Nothing here parses a record but a compaction request's own (headsReader below): a row is what the segment
// index already stored (src/query/index-build.mjs), which is why `sessions` can meet its ≤ 1 s budget on
// 1 GB (1.6 §4.1 速度目标) where reading every record back cost 4.5 s on Windows and 7 s on macOS.
import nodeFs from 'node:fs';
import path from 'node:path';
import { asksFactOf, createSynthAssigner, headsFactOf, KIN_V } from '../dissect/synth-key.mjs';
import { LEGACY_PROVIDER, wireProviderOfEndpoint } from '../dissect/harnesses.mjs';
import { endpointClass } from '../dissect/endpoints.mjs';
import { indexDir, segmentFiles, warmSegmentIndex, problemEntry, recordsId, grownFrom, IndexPending } from './index-build.mjs';
import { recordsAt } from './records.mjs';
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
// (src/query/row-table.mjs) and a column store of the same kind with what the list derives (`session_id`, `synthesized`, `lane_key`); a row is
// a read-only flyweight over the two. Its session index (session id → positions in the list) is built and grown with it.
// What a list holds in the V8 heap beside its column stores (heapOf), each measured with liveHeap() on generated homes (forced GC
// before and after, divided by the count; 2026-10-23, node 22) × 1.25: a segment's part 350 B; an open synthesized key copied at a
// part's end 83 B; a session in the index 208 B (its Map entry and positions array); a position 8.8 B on average, charged at the
// 12 B a slot holds right after its array grew (1.5× its length); a kinship fingerprint in an open keyed session's set 22.5 B
// (2026-10-30, node 22; charged once per part that holds the set, even when parts share it).
// OPEN_HEAP: an open chain with its tail and its items, measured about 664 B (a keyed entry holds neither and is charged the same),
// and its latest call's locator (`at`, one flat string), measured 56 B more (2026-11-11, node 22; × 1.25 = 70).
// TAIL_HEAP: a chain held for extension only (its tail; 3.4 合成键 有界), copied at a part's end, measured 110 B (2026-11-08, node 22).
// REPLY_HEAP: a reply kept for kinship (its key with the item, its entry and its sessions' array; 3.4 按内容认亲 有界), measured 276 B,
// charged once per list: the parts share the entry (copyOpen); REPLY_SLOT_HEAP: one more part's Map slot for it, measured 57 B (4,050
// replies in the rule's state, liveHeap() before and after, then 8 copies of the state; 2026-11-08, node 22; × 1.25).
const PART_HEAP = 450, OPEN_HEAP = 710, TAIL_HEAP = 140, SESSION_HEAP = 260, POSITION_HEAP = 12, FP_HEAP = 28, REPLY_HEAP = 350, REPLY_SLOT_HEAP = 72;
const lists = warmCache({ max: 4, cost: (v) => v.heap, steady: true });
// the rule moves a chain's `lastMs` in place (and replaces `fp`); a kept reply's entry it only replaces, so the copy shares it
const copyOpen = (open) => new Map([...open].map(([k, v]) => [k, v.owners ? v : { ...v }]));
// the index keeps a call's kinship fingerprints as one space-joined string (index-build.mjs `kin_fp` / `kin_probe`; `kin_chain` the same way)
const fpOf = (s) => (s == null ? null : s ? s.split(' ').map(Number) : []);
const lineOf = (id) => Number(String(id).split(':').pop());
// `at`: where the row's record is (headsReader reads a compaction request's windows, and a session's latest call, back from it when the
// rule asks), joined: one flat string, a quarter of what a template's pieces hold. `decided`: the attribution table's entry for the row
const assignRow = (assign, r, decided) => (r.synth_hash != null || r.kin_fp != null ? assign({ harness: r.harness_id, ms: Date.parse(r.ts || ''), key: r.session_key, at: [r.id, r.offset ?? '', r.stored_bytes].join('\t'),
  hash: r.synth_hash, fp: fpOf(r.kin_fp), probe: fpOf(r.kin_probe), late: r.kin_late, chain: r.kin_chain ? r.kin_chain.split(' ') : [], items: r.kin_items ? r.kin_items.split(' ') : [], mark: r.kin_mark === true,
  reply: r.kin_reply ?? null, decided }) : null);
// the rule over one row. A compaction request's outcome comes from the attribution table when it holds one, else from the rule, which
// reads back what it needs (headsReader), and is put in the table unless a read failed (4.2 §归属表)
async function ruleRow(assign, r, heads) {
  if (r.kin_probe == null || !heads) return assignRow(assign, r);
  const id = String(r.id), had = heads.kin.d.get(id), errs = heads.errors.length, reads = heads.reads;
  const got = assignRow(assign, r, had);
  if (had === undefined && got && got.anchor !== undefined && heads.errors.length === errs) { heads.kin.d.set(id, got.anchor); heads.kin.dirty = true; }
  if (heads.reads !== reads && heads.ease) await heads.ease();
  return got;
}
// A part keeps the rule's state at its end (`open`) only where a build resumes: the last part (the live segment grows from its own state)
// and the one before it (a new segment, or the live one renamed or rewritten, starts from it), and every KEEP-th part; a build that starts
// further back replays the rule from the nearest kept state (stateAt; at most KEEP - 1 parts, read from their warm index views)
const KEEP = 16, kept = (j, n) => j >= n - 2 || j % KEEP === KEEP - 1;
async function stateAt(parts, j, heads) {
  let m = j - 1;
  while (m >= 0 && !parts[m].open) m--;
  const open = copyOpen(m >= 0 ? parts[m].open : new Map()), assign = createSynthAssigner({ open, asks: heads?.asks, heads: heads?.heads });
  for (let q = m + 1; q < j; q++) for (let k = 0; k < parts[q].view.length; k++) await ruleRow(assign, parts[q].view.at(k), heads);
  return open;
}

/**
 * indexRows({home, fs, errors, progress, ease}) → a read-only row list (length, at, iteration, find, filter / map / slice → arrays) of
 * {…index row, segment, lineNo, session_id, synthesized, lane_key}, oldest segment first, capture order inside a segment — the order the
 * synthesized keys (3.4 合成键) are assigned in, the same order the board stamps them in, so both name a session the same. It is
 * shared by every reader until a segment moves. What a segment could not say goes into `errors` (D38), never silently missing — on
 * every call. `progress` is called after every segment and every chunk of raw bytes a cold segment's scan reads: the query worker
 * reports that work, so the daemon's idle clock does not end it in the middle of a long read (3.5 后台抽取与归约). `ease`, an async
 * function, is awaited after every segment and inside a long scan (index-build.mjs `easing`), so a read of every segment leaves the
 * event loop to others (3.5 §行表先读); the rows are the same with it or without.
 */
export async function indexRows({ home = trocarHome(), fs = nodeFs, errors = [], progress = null, ease = null, now = Date.now } = {}) {
  const segs = [];
  for (const [segment, at] of segmentFiles(home, fs, errors)) {
    const { records, problems } = await warmSegmentIndex({ home, segment, fs, at, progress, ease });
    if (progress) progress();
    for (const pr of problems) errors.push(problemEntry(`segments/${segment}`, pr));
    segs.push({ segment, records, entry: recordsId(records) });
    if (ease) await ease();
  }
  const stamp = segs.map((s) => `${s.segment}#${s.entry}`).join('\n'), key = `${fsTag(fs)}\n${home}`, heads = headsReader({ home, fs, errors, progress, ease });
  let built = false;
  const list = await lists.get(key, stamp, async (old) => {
    built = true;
    const prev = old ? await Promise.resolve(old).catch(() => null) : null, v = await rowList(segs, prev, false, heads);
    // a list built while a read back failed, or grown from one, carries that failure: its state lacks what that read would have given
    v.failed = heads.errors.length ? { at: now(), errors: heads.errors } : prev && prev.failed ? prev.failed : null;
    return v;
  });
  // ...and says it on every read it answers (D38). It is kept, so one record that stays unreadable does not cost a whole build per read;
  // the first read FAILED_RETRY_MS after it was built takes it out, so the next one builds it again and reads again (records.mjs: a failed
  // read is never remembered for good)
  if (list.failed) {
    if (!built) errors.push(...list.failed.errors);
    if (now() - list.failed.at >= FAILED_RETRY_MS) lists.take(key);
  }
  return list.rows;
}
const FAILED_RETRY_MS = 60_000;
/** What the rule reads back when a compaction request asks it (one seek each), never held (3.4 按内容认亲 有界): `heads(at)` the request's
 *  windows, `asks(at)` a session's latest call's user texts, with a progress tick after each (`reads` counts them; ruleRow yields after
 *  one where the caller gives `ease`: the worker's boot pass, 3.5 后台抽取与归约). One that cannot be read decides nothing and is said
 *  (D38): `errors` holds what this build said. `kin`: the attribution table (4.2 §归属表). */
const headsReader = ({ home, fs, errors, progress, ease }) => {
  const read = { errors: [], reads: 0, ease, kin: kinTable(home, fs) };
  const at = (where, what, fact) => (loc) => {
    const [id, offset, bytes] = loc.split('\t'), segment = id.split(':').slice(0, -1).join(':'), errs = [];
    const [rec] = recordsAt({ home, fs, rows: [{ id, segment, lineNo: lineOf(id), offset: offset === '' ? null : Number(offset), stored_bytes: Number(bytes) }], errors: errs, remember: false });
    read.reads++;
    if (!rec) { const e = { where: `segments/${segment}`, code: 'record-unreadable', reason: `${id}: ${where} could not be read back, so ${what} decide nothing: ${errs.map((x) => x.reason).join('; ') || 'no record'}` }; read.errors.push(e); errors.push(e); }
    if (progress) progress();
    return rec ? fact(rec) : null;
  };
  read.heads = at('a compaction request', 'its replies', headsFactOf);
  read.asks = at("a session's latest call", 'its user texts', asksFactOf);
  return read;
};

// The attribution table (4.2 §归属表): `index/kinship.json`, {v: KIN_V, d: {<compaction request's record id>: <record id of the latest
// call of the session it went to> | '' (none)}}. Held per home for the process; another version, or a file that does not parse, is an
// empty table. Only the query worker writes it (saveKin).
const kinFile = (home) => path.join(indexDir(home), 'kinship.json');
const kins = new Map();
function kinTable(home, fs) {
  const key = `${fsTag(fs)}\n${home}`;
  let t = kins.get(key);
  if (t) return t;
  let d = new Map();
  try { const doc = JSON.parse(fs.readFileSync(kinFile(home), 'utf8')); if (doc.v === KIN_V && doc.d && typeof doc.d === 'object') d = new Map(Object.entries(doc.d).filter(([, v]) => typeof v === 'string')); } catch { /* none yet, or torn: rebuilt */ }
  kins.set(key, (t = { d, dirty: false }));
  return t;
}
/** saveKin({home, fs}): the table, whole, when this process added to it, without the entries whose segment is gone; nothing otherwise. */
export async function saveKin({ home = trocarHome(), fs = nodeFs } = {}) {
  const t = kins.get(`${fsTag(fs)}\n${home}`);
  if (!t || !t.dirty) return;
  const segs = new Set(segmentFiles(home, fs, []).map(([s]) => s)), seg = (id) => id.split(':').slice(0, -1).join(':');
  for (const id of t.d.keys()) if (!segs.has(seg(id))) t.d.delete(id);
  // at run time: ctx-files.mjs imports this module
  const { putFile } = await import('./ctx-files.mjs');
  putFile(fs, kinFile(home), Buffer.from(JSON.stringify({ v: KIN_V, d: Object.fromEntries(t.d) }), 'utf8'));
  t.dirty = false;
}

/**
 * provisionalRows({home, fs, ready}) → {rows, errors, early: true}: the rows of the segments in `ready` (names) whose index is usable now, read as
 * `indexRows` reads them (warmOnly: never built here), while the worker's boot pass rebuilds the rest (3.5 §行表先读「先答的会话」).
 * A row is in a session only when the full list would put it in the same one whatever comes before it: it has a session key and no
 * chain (`synth_hash` null) — then it is that key's, with no lane key, in the full list too. A row whose session the synthesized-key
 * rule, kinship or a keyed session's chains decide has none here. `errors` says how many segments are left out (`index-pending`),
 * so the answer says it may lack calls. null: a ready segment is not usable now (the caller asks again).
 */
export async function provisionalRows({ home = trocarHome(), fs = nodeFs, ready } = {}) {
  const errors = [], segs = [], all = segmentFiles(home, fs, errors);
  for (const [segment, at] of all) {
    if (!ready.has(segment)) continue;
    let got;
    // a ready segment whose index left the warm cache and is not on disk in this version (a plain one): no early answer, never one that lost members
    try { got = await warmSegmentIndex({ home, segment, fs, at, warmOnly: true }); } catch (e) { if (e instanceof IndexPending) return null; throw e; }
    for (const pr of got.problems) errors.push(problemEntry(`segments/${segment}`, pr));
    segs.push({ segment, records: got.records, entry: recordsId(got.records) });
  }
  // said while the list is provisional, every segment ready or not: the full list is still being built, and this answer is not its answer
  errors.push({ where: 'index', code: 'index-pending', level: 'state', reason: `${all.length - segs.length} of ${all.length} capture files are still being re-indexed, then the session list is built; until that ends this read may lack calls.` });
  const stamp = segs.map((s) => `${s.segment}#${s.entry}`).join('\n');
  return { rows: (await early.get(`${fsTag(fs)}\n${home}`, stamp, (old) => rowList(segs, old, true))).rows, errors, early: true };
}
const early = warmCache({ max: 1, cost: (v) => v.heap });
/** dropProvisional({home, fs}): the boot pass ended, the provisional list goes. */
export const dropProvisional = ({ home = trocarHome(), fs = nodeFs } = {}) => { early.take(`${fsTag(fs)}\n${home}`); };
async function rowList(segs, old, keyedOnly = false, heads = null) {
  old = old ? await Promise.resolve(old).catch(() => null) : null; // a list still being built when its stamp moved: grown from once it is
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
  const shed = (q) => { if (q >= 0 && parts[q].open && !kept(q, segs.length)) parts[q] = { ...parts[q], open: null }; }; // a copy: the old list shares the part
  if (!extend) for (const p of parts) for (let k = 0; k < p.end - p.start; k++) { const sid = cellAt(p.d, 0, k); if (sid) place(sid, p.start + k); }
  for (let j = i; j < segs.length; j++) {
    const { segment, records: view, entry } = segs[j], was = grown && j === i ? old.parts[i] : null;
    const start = was ? was.start : j ? parts[j - 1].end : 0, k0 = was ? was.end - was.start : 0;
    // the part before, built here and kept by no one (shed below), hands its state on as it is: copying it for every segment
    // churned every kept reply once per segment
    const prev = !keyedOnly && j > i && !kept(j - 1, segs.length) ? parts[j - 1].open : null;
    const open = keyedOnly ? null : was ? copyOpen(was.open) : prev || await stateAt(parts, j, heads), assign = open && createSynthAssigner({ open, asks: heads?.asks, heads: heads?.heads });
    const derived = [];
    for (let k = k0; k < view.length; k++) {
      const r = view.at(k);
      const got = assign ? await ruleRow(assign, r, heads) : null;
      // keyedOnly (provisionalRows): only a row whose session no rule before it decides
      const sid = keyedOnly ? (r.synth_hash == null ? r.session_key ?? null : null) : r.session_key ?? (got && got.key) ?? null;
      // a keyed call's chain (3.4 带键会话里的消息链) is no synthesized key: the session stays as it was
      derived.push({ session_id: sid, synthesized: !!got && got.key != null && !got.kin, lane_key: (got && got.lane) ?? null });
      if (sid) place(sid, start + k); // a row with no session id is in no group (sessionGroups)
    }
    parts.push({ segment, entry, view, d: was ? was.d.concat(derived) : rowTable(derived), start, end: start + view.length, open });
    shed(j - 1);
  }
  for (let q = 0; q < parts.length; q++) shed(q);
  const n = parts.length ? parts[parts.length - 1].end : 0;
  const rows = new RowList(parts, n, index);
  let heap = heapOf(...parts.map((p) => p.d)) + SESSION_HEAP * index.size + POSITION_HEAP * slots;
  const replies = new Set();
  for (const p of parts) {
    heap += PART_HEAP;
    if (p.open) for (const v of p.open.values()) heap += v.fp ? OPEN_HEAP + FP_HEAP * v.fp.size : !v.owners ? TAIL_HEAP : replies.has(v) ? REPLY_SLOT_HEAP : (replies.add(v), REPLY_HEAP);
  }
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
  if (x) return Object.freeze(Object.assign(Object.create(LISTED), x, { segment: p.segment, lineNo: lineOf(x.id), session_id: cellAt(p.d, 0, k), synthesized: cellAt(p.d, 1, k), lane_key: cellAt(p.d, 2, k) }));
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
    // the derived columns, in the order rowList writes them: session_id, synthesized, lane_key (always scalars, so never a row kept whole)
    get session_id() { return cellAt(this.#p.d, 0, this.#k); }
    get synthesized() { return cellAt(this.#p.d, 1, this.#k); }
    get lane_key() { return cellAt(this.#p.d, 2, this.#k); }
    toJSON() {
      const o = {};
      for (const key of keys) o[key] = this[key];
      return Object.assign(o, { segment: this.segment, lineNo: this.lineNo, session_id: this.session_id, synthesized: this.synthesized, lane_key: this.lane_key });
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

const isProbe = (r) => endpointClass(r.path) === 'token-count';

/** Which index rows are a MODEL CALL: the one rule every reader counts calls with (sessionFactsOf below,
 *  `overview`'s usage and the usage sidecar's fill), never a second copy of it. */
export const isModelCall = (r) => r.is_llm && !r.log_only;

/** sessionFacts(id) → {add(row), facts()}: one session's facts over the rows added so far, in member order: the harness of the first row that had `proc`, else
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
