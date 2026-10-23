// src/query/projection.mjs — the CONTEXT PROJECTION's store (RFC 4.3 §4, D69): one append-only NDJSON
// file per session, `index/ctx/<first 32 hex of sha256(session key)>.ndjson`, that keeps what extraction found so a
// warm session is not re-extracted. Storage only: it knows a definition by `def.bid`, a call row by `row.rid` and a
// break by its `brk` pair, and nothing else of their contents. A projection like the index (invariant 2, D59): delete
// it and the next open rebuilds it, answer for answer the same.
//
// Lines: `{"v":PROJ_V,"id"}` (`id`: a random id taken when the file is made, which the fold log beside it names as its own: a
// projection rebuilt is another projection, and src/query/fold-log.mjs drops a log that names another), then `{"d":def}`, `{"c":row}`, `{"t":row}`, `{"b":brk}`, `{"s":{k,v}}` in any order. Definitions, rows
// and shared values stay on disk: the store holds key → where its line is (compact columns) and reads a line back when asked, the
// most recently used rows and shared values kept up to a few MiB of heap, so its heap does not grow with the session's rows
// (extraction's bound, 4.3 §4). Breaks are held. A `t` line is a held row (extracted after a member that failed, §3.9): opening stops at the first one and cuts the
// file there before the next append, so what is read back is always the rows of one pass over a prefix.
//   Shared values (`s`): a value that recurs across rows (a lane's facts, a call's attributes, the wire's labels) is written once.
// Top down to SHARE_DEPTH levels under a row, a value of SHARE_MIN bytes or more whose content was seen among the last SEEN (to 2 × SEEN)
// values looked at, or is shared already, is written as an `s` line keyed by its hash and stands in the row as `{"$s":key}`; a value not
// seen stays inline and its children are looked at. A row read back puts each shared value back as one object every row read
// while it is kept shares. An original value of the reference's own shape is always shared, so a reference is never ambiguous.
// Content-blind: the store knows nothing of a row.
//   A header of another version, or a line that does not parse before the last, or a row naming a shared value the file does
// not hold → the file is deleted and the store starts empty, with one `projection-rebuilt` note (D38). A torn last line (no
// newline, or not JSON) is cut off before the next append, silently: an interrupted append, nothing lost that was ever whole.
//   The lines are kept by src/query/line-file.mjs: a write that fails keeps them in its off-heap arena at the offsets they will
// have, says `projection-write-failed` once per episode (in the `errors` of the request whose append failed), and writes them with
// the next write that works; `write: false` (the local CLI's path) never writes: every line it appends lives in the arena (external
// memory, about the projection's bytes per call extracted), so its V8 heap is bounded as the worker's is.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { indexDir, segmentCmp } from './index-build.mjs';
import { parseRecordId } from '../collector/core/record/segments.mjs';
import { trocarHome } from '../paths.mjs';
import { lineFile, saveSidecar, loadSidecar } from './line-file.mjs';

export const PROJ_V = 8;
const CAP_BYTES = 512 << 20; // the total's ceiling (gcProjections)
const SHARE_DEPTH = 3, SHARE_MIN = 48;
// rows and shared values read back are kept by what they weigh in the heap (a row grows with its context: a count let a long
// lane's rows hold most of the heap, 2026-10-22), the value keys looked for by count; each cache holds two times its figure
const ROW_HEAP = 2 << 20, SHARED_HEAP = 2 << 20, SEEN = 1 << 14;
// what a row or shared value read back costs in the heap per byte of its line: 2.6 measured (after a forced GC) on rows read back
// with their shared values put back unshared, from test/query/big-session.mjs live(0.08) and live(0.2) (a row parsed alone 1.9, a
// shared value 1.95), 3.5-7 on the user's live session (a heap diagnosis); 2026-10-22
export const HEAP_PER_LINE_BYTE = 4;
/** What an open store keeps at most of rows and shared values read back (each cache holds two times its figure): the heap
 *  a warm session's store costs beside its reduction (src/query/named/session.mjs). */
export const STORE_HEAP = 2 * (ROW_HEAP + SHARED_HEAP);
const CHUNK = 1 << 20;
/** The first read of a line scan (linesOf), doubling up to CHUNK. */
export const FIRST_CHUNK = 4 << 10;
const NAME = /^([0-9a-f]{32})(?:\.fold)?\.(?:ndjson|idx(?:\.tmp)?)$/; // a projection, its fold log (src/query/fold-log.mjs), their sidecars

const ctxDir = (home) => path.join(indexDir(home), 'ctx');
const hashOf = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
export const projectionFile = (home, sessionKey) => path.join(ctxDir(home), `${hashOf(sessionKey)}.ndjson`);
const newId = () => randomBytes(12).toString('base64url');
const pairKey = (a, b) => `${a}\n${b}`;

/** posCmp(ridA, ridB): write order of two record ids `<segment>:<line>` — the segments' order (segmentCmp), then the line. */
export function posCmp(a, b) {
  const pa = parseRecordId(a), pb = parseRecordId(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return segmentCmp(pa.segment, pb.segment) || (pa.lineNo - pb.lineNo);
}

// Every line of `file` from byte `from` (a line's start) with its byte offset and length (newline excluded), read in chunks; `nl`: it
// ended in a newline.
export function* linesOf(fs, file, from = 0) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try {
    // reads of FIRST_CHUNK, doubling up to CHUNK: a caller that stops after the first lines (a header) reads about them only
    let carry = Buffer.alloc(0), at = from, pos = from, n, size = FIRST_CHUNK;
    const buf = Buffer.alloc(CHUNK);
    while ((n = fs.readSync(fd, buf, 0, size, pos)) > 0) {
      pos += n; size = Math.min(2 * size, CHUNK);
      const b = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0, i;
      while ((i = b.indexOf(10, from)) !== -1) { yield { off: at + from, len: i - from, text: b.toString('utf8', from, i), nl: true }; from = i + 1; }
      at += from;
      carry = Buffer.from(b.subarray(from));
    }
    if (carry.length) yield { off: at, len: carry.length, text: carry.toString('utf8'), nl: false };
  } finally { fs.closeSync(fd); }
}

const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
const shaped = (o) => o && typeof o === 'object' && ((o.d && o.d.bid != null) || (o.c && o.c.rid != null) || (o.b && Array.isArray(o.b.brk))
  || (o.s && typeof o.s.k === 'string' && 'v' in o.s));
const isObj = (v) => v !== null && typeof v === 'object';
const isRef = (v) => isObj(v) && !Array.isArray(v) && typeof v.$s === 'string' && Object.keys(v).length === 1;
const keyOf = (json) => createHash('sha256').update(json).digest().subarray(0, 16).toString('base64url');
// each child position of a row to SHARE_DEPTH levels, top down: visit(holder, key) → whether to go below holder[key]
function eachSlot(v, depth, visit) {
  if (!isObj(v) || depth >= SHARE_DEPTH) return;
  for (const k of Array.isArray(v) ? v.keys() : Object.keys(v)) if (visit(v, k)) eachSlot(v[k], depth + 1, visit);
}
// a 52-bit number of a string (two 32-bit FNV-style hashes), for a table of numbers: a hit is verified against the value itself
export const num52 = (v) => {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15); }
  return (a >>> 0) * 0x100000 + ((b >>> 0) & 0xfffff);
};
/** numTable() → 52-bit numbers → int32 values, open addressing in two typed arrays filled to at most three quarters (a Map's entry
 *  costs about 40 B, a key here 16 to 32 B). */
export function numTable() {
  let cap = 1024, n = 0, keys = new Float64Array(cap), vals = new Int32Array(cap).fill(-1);
  const index = (x) => { let i = x % cap; while (vals[i] >= 0 && keys[i] !== x) i = (i + 1) & (cap - 1); return i; };
  const put = (x, v) => { const i = index(x); if (vals[i] < 0) n++; keys[i] = x; vals[i] = v; };
  return {
    get: (x) => { const v = vals[index(x)]; return v >= 0 ? v : undefined; },
    set(x, v) {
      if (4 * (n + 1) > 3 * cap) {
        const ok = keys, ov = vals;
        cap *= 2; n = 0; keys = new Float64Array(cap); vals = new Int32Array(cap).fill(-1);
        for (let i = 0; i < ok.length; i++) if (ov[i] >= 0) put(ok[i], ov[i]);
      }
      put(x, v);
    },
    // dump() → [keys, values] as they lie; load(dump) into an empty table gives it the same entries
    dump: () => [keys.slice(), vals.slice()],
    load([ks, vs]) {
      if (n || ks.length !== vs.length || ks.length & (ks.length - 1)) throw new RangeError('not a table of numbers of this shape');
      cap = ks.length; keys = ks.slice(); vals = vs.slice(); n = 0;
      for (const v of vals) if (v >= 0) n++;
    },
  };
}
// key → [offset, length] of a line on disk: a slot found through the key's number (numTable; a key whose number another key took
// first in a Map of its own), the places in two typed columns; a slot never changes while the store is open, and names its key back.
// dump() → [keys, offsets, lengths] by slot; load(dump) into an empty index gives each key the slot it had (a sidecar's, line-file.mjs).
export function lineIndex() {
  let first = numTable(), spill = new Map();
  const names = [];
  let off = new Float64Array(256), len = new Uint32Array(256);
  const slotOf = (k) => { const s = first.get(num52(k)); return s === undefined ? undefined : names[s] === k ? s : spill.get(k); };
  return {
    has: (k) => slotOf(k) !== undefined,
    get: (k) => { const i = slotOf(k); return i === undefined ? undefined : [off[i], len[i]]; },
    set(k, o, l) {
      let i = slotOf(k);
      if (i === undefined) {
        i = names.length;
        if (i === off.length) { const o2 = new Float64Array(2 * i), l2 = new Uint32Array(2 * i); o2.set(off); l2.set(len); off = o2; len = l2; }
        const h = num52(k);
        if (first.get(h) === undefined) first.set(h, i); else spill.set(k, i);
        names.push(k);
      }
      off[i] = o; len[i] = l;
    },
    slotOf,
    dump: () => [names.slice(), off.slice(0, names.length), len.slice(0, names.length)],
    load([ks, os, ls]) {
      if (names.length || ks.length !== os.length || ks.length !== ls.length) throw new RangeError('not a line index of this shape');
      for (let i = 0; i < ks.length; i++) this.set(ks[i], os[i], ls[i]);
    },
    keyAt: (i) => names[i],
    keys: () => names.values(),
    get size() { return names.length; },
    clear: () => { first = numTable(); spill = new Map(); names.length = 0; },
  };
}
/** lru(max) → a cache that holds at most `max` of weight (plus its newest entry): the least recently used entry goes first. Uses
 *  are kept in a queue whose stale places are skipped and compacted away, so every operation is O(1) amortised (evicting the oldest
 *  entry of one Map in insertion order costs time with the Map's size in V8, whose deleted entries stay as holes the next eviction
 *  walks: 6 µs an eviction at 32768 entries, 2026-10-22). Once full it holds its figure, so a heap measured past that does not swing
 *  with when a generation turned over. */
export function lru(max) {
  let map = new Map(), q = [], h = 0, w = 0;
  const compact = () => {
    const nq = [];
    for (let j = h; j < q.length; j++) { const k = q[j], e = k !== undefined && map.get(k); if (e && e.at === j) { e.at = nq.length; nq.push(k); } }
    q = nq; h = 0;
  };
  const touch = (k, e) => { e.at = q.length; q.push(k); if (q.length > 2 * map.size + 64) compact(); };
  const evict = () => {
    while (w > max && map.size > 1) {
      const k = q[h], e = k !== undefined && map.get(k);
      q[h++] = undefined;
      if (e && e.at === h - 1) { map.delete(k); w -= e.w; }
    }
  };
  return {
    get(k) { const e = map.get(k); if (!e) return undefined; touch(k, e); return e.v; },
    has: (k) => map.has(k),
    set(k, v, kw = 1) {
      const e = map.get(k);
      if (e) w -= e.w;
      const n = { v, w: kw, at: 0 };
      map.set(k, n); w += kw; touch(k, n); evict();
    },
    delete(k) { const e = map.get(k); if (e) { w -= e.w; map.delete(k); } },
    clear() { map = new Map(); q = []; h = 0; w = 0; },
  };
}

/** openProjection({home, fs, key, write, errors}) → the session's store (see the head of this file). `errors`: where notes go
 *  when an append names no other sink (an append of a later request passes that request's `errors`). */
export function openProjection({ home = trocarHome(), fs = nodeFs, key, write = true, errors = [] } = {}) {
  const file = projectionFile(home, key);
  let sink = errors; // the errors of the request whose append is running
  const lines = lineFile({ fs, file, write, onFail: (e) => sink.push({ where: 'projection', code: 'projection-write-failed', level: 'note',
    reason: `The context projection could not be written (${e.code || e.message}); this session is kept in memory and extracted again next time.` }) });
  const at = lineIndex(); // bid → its line
  const rowAt = lineIndex(); // rid → its line
  const rowCache = lru(2 * ROW_HEAP); // rid → row, weighed in heap
  const brks = new Map(), brkAt = [[], []]; // break pairs, and where their lines are (offsets, lengths)
  const sharedAt = lineIndex(); // shared value key → its line
  const sharedCache = lru(2 * SHARED_HEAP); // one object for every row read while it is kept
  const seen = lru(2 * SEEN); // content keys of the values at share positions written last

  const refsHeld = (row) => { let ok = true; eachSlot(row, 0, (h, k) => { const v = h[k]; if (!isRef(v)) return isObj(v); if (!sharedAt.has(v.$s)) ok = false; return false; }); return ok; };
  const lineAt = ([o, l]) => JSON.parse(lines.read(o, l).toString('utf8'));
  function sharedOf(k) {
    let v = sharedCache.get(k);
    if (v !== undefined) return v;
    const p = sharedAt.get(k);
    if (!p) return undefined;
    v = lineAt(p).s.v;
    sharedCache.set(k, v, p[1] * HEAP_PER_LINE_BYTE);
    return v;
  }
  // a row read back: its references put back in place (the shared instances kept)
  function expand(row) {
    eachSlot(row, 0, (h, k) => {
      const v = h[k];
      if (!isRef(v)) return isObj(v);
      const got = sharedOf(v.$s);
      if (got === undefined) throw new Error(`the context projection has no shared value ${v.$s}`);
      h[k] = got;
      return false;
    });
    return row;
  }
  // an item taken in: where its line is
  const take = (o, off, len) => {
    if (o.d && !at.has(o.d.bid)) at.set(o.d.bid, off, len);
    if (o.s) sharedAt.set(o.s.k, off, len);
    if (o.c || o.t) {
      const rid = (o.c || o.t).rid;
      rowAt.set(rid, off, len);
      rowCache.delete(rid);
      if (o.row) rowCache.set(rid, o.row, len * HEAP_PER_LINE_BYTE); // the row as given (the same as it reads back)
    }
    if (o.b) { brks.set(pairKey(o.b.brk[0], o.b.brk[1]), o.b); brkAt[0].push(off); brkAt[1].push(len); }
  };
  // what an append writes of a row: a recurring value (or one of a reference's shape) as an `s` line and a reference
  const note = (v) => { const j = JSON.stringify(v); return j === undefined ? null : j; };
  const shares = new Set(); // keys given an `s` line by the append being built
  function encode(row, out) {
    const copy = { ...row };
    eachSlot(copy, 0, (h, k) => {
      const v = h[k], j = note(v);
      if (j == null) return false;
      const key = keyOf(j);
      if (isRef(v) || (j.length >= SHARE_MIN && (seen.has(key) || sharedAt.has(key) || shares.has(key)))) {
        if (!sharedAt.has(key) && !shares.has(key)) { shares.add(key); out.push({ s: { k: key, v } }); }
        h[k] = { $s: key };
        return false;
      }
      seen.set(key, true);
      if (!isObj(v)) return false;
      h[k] = Array.isArray(v) ? v.slice() : { ...v };
      return true;
    });
    return copy;
  }
  const rebuilt = (reason) => {
    id = newId();
    for (const m of [at, rowAt, rowCache, brks, sharedAt, sharedCache, seen]) m.clear();
    brkAt[0].length = brkAt[1].length = 0;
    bytes = savedAt = 0; saved = null;
    if (write) { try { fs.rmSync(file, { force: true }); } catch { /* cut before the next append */ } }
    lines.cut(0);
    errors.push({ where: 'projection', code: 'projection-rebuilt', level: 'note', reason });
  };

  let head = true, bad = null, bytes = 0, id = newId(), savedAt = 0, heldRows = false, saved = null;
  // the sidecar (4.3 §4 旁索引) of this header's id: the indexes and the breaks of its first `bytes`, or nothing of it
  function loaded() {
    const sc = loadSidecar({ fs, file });
    if (!sc || sc.head.id !== id) return false;
    try {
      const p = sc.parts;
      for (const [n, idx] of [['d', at], ['r', rowAt], ['s', sharedAt]]) idx.load([p[`${n}.k`], p[`${n}.o`], p[`${n}.l`]]);
      for (let i = 0; i < p['b.o'].length; i++) take({ b: lineAt([p['b.o'][i], p['b.l'][i]]).b }, p['b.o'][i], p['b.l'][i]);
      saved = Object.fromEntries(Object.entries(p).filter(([n]) => !/^([drs]\.[kol]|b\.[ol])$/.test(n)));
    } catch {
      for (const m of [at, rowAt, sharedAt, brks]) m.clear();
      brkAt[0].length = brkAt[1].length = 0;
      return false;
    }
    bytes = savedAt = sc.head.bytes;
    return true;
  }
  function scan(from) {
    for (const l of linesOf(fs, file, from)) {
      if (bad) { rebuilt(bad); bad = null; return false; } // a bad line that was not the last
      const o = parse(l.text);
      if (head) {
        if (!l.nl || !o) { bad = 'The stored context projection has no readable header; it is rebuilt from the capture.'; continue; }
        if (o.v !== PROJ_V || typeof o.id !== 'string') { rebuilt(`The stored context projection is of version ${JSON.stringify(o.v)}, not ${PROJ_V}; it is rebuilt from the capture.`); return false; }
        head = false; id = o.id; bytes = l.off + l.len + 1;
        if (loaded()) return true; // the rest is scanned from where it ends
        continue;
      }
      if (o && o.t) return false; // held rows of an earlier process: from here on everything is extracted again
      if (!l.nl || !shaped(o)) { bad = `Line at byte ${l.off} of the stored context projection does not parse; it is rebuilt from the capture.`; continue; }
      if (o.c && !refsHeld(o.c)) { rebuilt(`Line at byte ${l.off} of the stored context projection names a shared value it does not hold; it is rebuilt from the capture.`); return false; }
      take(o, l.off, l.len);
      bytes = l.off + l.len + 1;
    }
    return false;
  }
  if (scan(0)) scan(bytes);
  lines.cut(bytes); // a torn or held tail is cut off before the next append
  if (write && bytes) { try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* the GC order only */ } }

  /** append({defs, rows, brks}, {held, errors}): `held` rows are written as `t` lines, which the next open cuts off with all that
   *  follows them (rows extracted after a member that failed: §3.9); `errors` is where this append's note goes. */
  function append({ defs = [], rows: rs = [], brks: bs = [] } = {}, { held: tent = false, errors: to = errors } = {}) {
    const all = [];
    for (const d of defs) if (!at.has(d.bid)) all.push({ d });
    if (tent && rs.length) heldRows = true;
    for (const r of rs) { const e = encode(r, all); all.push(tent ? { t: e, row: r } : { c: e, row: r }); }
    for (const b of bs) all.push({ b });
    shares.clear();
    let text = lines.bytes ? '' : `${JSON.stringify({ v: PROJ_V, id })}\n`;
    const placed = [];
    let off = Buffer.byteLength(text);
    for (const o of all) {
      const line = JSON.stringify(o.c ? { c: o.c } : o.t ? { t: o.t } : o), len = Buffer.byteLength(line);
      placed.push([o, off, len]); text += `${line}\n`; off += len + 1;
    }
    sink = to;
    const base = lines.append(text);
    sink = errors;
    for (const [o, o2, len] of placed) take(o, base + o2, len);
  }

  const rows = {
    has: (rid) => rowAt.has(rid),
    get(rid) {
      const hit = rowCache.get(rid);
      if (hit !== undefined) return hit;
      const p = rowAt.get(rid);
      if (!p) return undefined;
      const o = lineAt(p), row = expand(o.c || o.t);
      rowCache.set(rid, row, p[1] * HEAP_PER_LINE_BYTE);
      return row;
    },
    get size() { return rowAt.size; },
    /** a row's slot: 0, 1, … in the order the store took them in, fixed while it is open; keyAt(slot) names it back */
    slotOf: (rid) => rowAt.slotOf(rid),
    keyAt: (slot) => rowAt.keyAt(slot),
    keys: () => rowAt.keys(),
    *values() { for (const k of rowAt.keys()) yield rows.get(k); },
    *[Symbol.iterator]() { for (const k of rowAt.keys()) yield [k, rows.get(k)]; },
  };

  return {
    hasDef: (bid) => at.has(bid),
    readDef: (bid) => { const p = at.get(bid); return p ? lineAt(p).d : undefined; },
    /** A definition's slot: 0, 1, … in the order the store took them in, fixed while it is open (src/view/reduce.mjs keys its block
     *  columns by it); defBid(slot) names it back; defCount: how many distinct blocks the store holds. */
    defSlot: (bid) => at.slotOf(bid),
    defBid: (slot) => at.keyAt(slot),
    get defCount() { return at.size; },
    close: () => lines.close(),
    rows,
    brks,
    brk: (prevBid, curBid) => brks.get(pairKey(prevBid, curBid)),
    append,
    /** saveIndex(extra) → whether it wrote the sidecar (4.3 §4 旁索引): written stores only, none while the store holds `t` rows or
     *  when nothing grew since the last. `extra`: [[name, array]] parts a caller adds (no name of the form `<d|r|s>.<k|o|l>`,
     *  `b.<o|l>`), handed back by the next open that loads the sidecar as `saved`. */
    saveIndex(extra = []) {
      if (!lines.settled || heldRows || !lines.bytes || lines.bytes === savedAt) return false;
      const parts = [];
      for (const [n, idx] of [['d', at], ['r', rowAt], ['s', sharedAt]]) { const [k, o, l] = idx.dump(); parts.push([`${n}.k`, k], [`${n}.o`, o], [`${n}.l`, l]); }
      parts.push(['b.o', Float64Array.from(brkAt[0])], ['b.l', Uint32Array.from(brkAt[1])], ...extra);
      saveSidecar({ fs, file, head: { id, bytes: lines.bytes }, parts });
      savedAt = lines.bytes;
      return true;
    },
    /** Whether its sidecar covers every line it holds (saveIndex wrote it, or nothing grew since): none while it holds `t` rows. */
    get indexed() { return lines.settled && !heldRows && lines.bytes > 0 && lines.bytes === savedAt; },
    /** What the sidecar this open loaded carried besides the indexes ({name: array}), or null (saveIndex). */
    get saved() { return saved; },
    /** The header's id (taken now when the file is made or rebuilt); `bytes`: the length of the whole lines it holds. */
    get id() { return id; },
    get bytes() { return lines.bytes; },
  };
}

/** gcProjections({home, fs, liveKeys, keepKeys, capBytes}) → {deleted: [file]}: drops the projections of sessions not in
 *  `liveKeys`, then the least recently opened (mtime: opening touches it) until the total is within `capBytes` (512 MiB).
 *  A projection and its fold log go together and count together. Never one of `keepKeys` (the sessions open or followed:
 *  evicting one would cost its whole extraction on the next read). `liveKeys` is required: no list is not "no session lives".
 *  Only files named like a projection or a fold log, only under index/ctx/. */
export function gcProjections({ home = trocarHome(), fs = nodeFs, liveKeys, keepKeys = [], capBytes = CAP_BYTES } = {}) {
  if (!liveKeys || typeof liveKeys[Symbol.iterator] !== 'function') throw new TypeError('gcProjections needs liveKeys, the sessions that still have members');
  const dir = ctxDir(home);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return { deleted: [] }; throw e; }
  const keep = new Set([...keepKeys].map(hashOf)), live = new Set([...liveKeys].map(hashOf));
  const pairs = new Map(); // hash → {files, size, t}
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m) continue;
    const p = pairs.get(m[1]) || { h: m[1], files: [], size: 0, t: 0 };
    pairs.set(m[1], p);
    p.files.push(n);
    try { const st = fs.statSync(path.join(dir, n)); p.size += st.size; p.t = Math.max(p.t, st.mtimeMs); } catch { /* gone meanwhile */ }
  }
  const deleted = [];
  const drop = (p) => { for (const n of p.files) { try { fs.rmSync(path.join(dir, n), { force: true }); deleted.push(path.join(dir, n)); } catch { /* the next GC */ } } };
  const kept = [];
  let total = 0;
  for (const p of pairs.values()) {
    if (!live.has(p.h) && !keep.has(p.h)) { drop(p); continue; }
    total += p.size;
    if (!keep.has(p.h)) kept.push(p);
  }
  for (const p of kept.sort((a, b) => a.t - b.t)) {
    if (total <= capBytes) break;
    drop(p); total -= p.size;
  }
  return { deleted };
}
