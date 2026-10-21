// src/query/projection.mjs — the CONTEXT PROJECTION's store (RFC 4.3 §4, D69): one append-only NDJSON
// file per session, `index/ctx/<first 32 hex of sha256(session key)>.ndjson`, that keeps what extraction found so a
// warm session is not re-extracted. Storage only: it knows a definition by `def.bid`, a call row by `row.rid` and a
// break by its `brk` pair, and nothing else of their contents. A projection like the index (invariant 2, D59): delete
// it and the next open rebuilds it, answer for answer the same.
//
// Lines: `{"v":PROJ_V}`, then `{"d":def}`, `{"c":row}`, `{"t":row}`, `{"b":brk}`, `{"s":{k,v}}` in any order. Definitions, rows
// and shared values stay on disk: the store holds key → where its line is (compact columns) and reads a line back when asked, the
// most recently used rows and shared values kept up to a few MiB of their lines, so its heap does not grow with the session's rows (extraction's bound, 4.3 §4). Breaks
// are held. A `t` line is a held row (extracted after a member that failed, §3.9): opening stops at the first one and cuts the
// file there before the next append, so what is read back is always the rows of one pass over a prefix.
//   Shared values (`s`): a value that recurs across rows (a lane's facts, a call's attributes, the wire's labels) is written once.
// Top down to SHARE_DEPTH levels under a row, a value of SHARE_MIN bytes or more whose content was seen among the last SEEN (to 2 × SEEN)
// values looked at, or is shared already, is written as an `s` line keyed by its hash and stands in the row as `{"$s":key}`; a value not
// seen stays inline and its children are looked at. A row read back puts each shared value back as one object every row read
// while it is kept shares. An original value of the reference's own shape is always shared, so a reference is never ambiguous.
// Content-blind: the store knows nothing of a row.
//   A header of another version, or a line that does not parse before the last, or a row naming a shared value the file does
// not hold → the file is deleted and the store starts empty, with one `projection-rebuilt` note (D38). A torn last line (no
// newline, or not JSON) is cut off before the next append, silently: an interrupted append, nothing lost that was ever whole. A
// write that fails keeps the items in memory, says `projection-write-failed` once per episode (in the `errors` of the request
// whose append failed), and writes them with the next write that works.
// `write: false` (the local CLI's path) never writes: what it extracts is held in memory.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { indexDir } from './index-build.mjs';
import { parseRecordId } from '../collector/core/record/segments.mjs';
import { trocarHome } from '../paths.mjs';

export const PROJ_V = 6;
const CAP_BYTES = 512 << 20; // the total's ceiling (gcProjections)
const SHARE_DEPTH = 3, SHARE_MIN = 48;
// rows and shared values read back are kept by the bytes of their lines (a row grows with its context: a count let a long lane's
// rows hold most of the heap, 2026-10-22), the value keys looked for by count; each cache holds one to two times its figure
const ROW_BYTES = 2 << 20, SHARED_BYTES = 2 << 20, SEEN = 1 << 14;
/** What an open store keeps at most of rows and shared values read back (each cache holds one to two times its figure): the heap
 *  a warm session's store costs beside its reduction (src/query/named/session.mjs). */
export const STORE_HEAP = 2 * (ROW_BYTES + SHARED_BYTES);
const CHUNK = 1 << 20;
const NAME = /^[0-9a-f]{32}\.ndjson$/;

const ctxDir = (home) => path.join(indexDir(home), 'ctx');
const hashOf = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
export const projectionFile = (home, sessionKey) => path.join(ctxDir(home), `${hashOf(sessionKey)}.ndjson`);
const pairKey = (a, b) => `${a}\n${b}`;
const held = new FinalizationRegistry(({ fs, fd }) => { try { fs.closeSync(fd); } catch { /* already closed */ } });

/** posCmp(ridA, ridB): write order of two record ids `<segment>:<line>` — segment instant, collision suffix, line. */
export function posCmp(a, b) {
  const pa = parseRecordId(a), pb = parseRecordId(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  const [sa, na = 1] = pa.segment.split('-'), [sb, nb = 1] = pb.segment.split('-');
  return sa < sb ? -1 : sa > sb ? 1 : (Number(na) - Number(nb)) || (pa.lineNo - pb.lineNo);
}

// Every line of `file` with its byte offset and length (newline excluded), read in chunks; `nl`: it ended in a newline.
function* linesOf(fs, file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try {
    let carry = Buffer.alloc(0), at = 0, n;
    const buf = Buffer.alloc(CHUNK);
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
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
// key → [offset, length] of a line on disk: a Map to a slot, the places in two typed columns (no array per key)
function lineIndex() {
  const slot = new Map();
  let off = new Float64Array(256), len = new Uint32Array(256);
  return {
    has: (k) => slot.has(k),
    get: (k) => { const i = slot.get(k); return i === undefined ? undefined : [off[i], len[i]]; },
    set(k, o, l) {
      let i = slot.get(k);
      if (i === undefined) {
        i = slot.size;
        if (i === off.length) { const o2 = new Float64Array(2 * i), l2 = new Uint32Array(2 * i); o2.set(off); l2.set(len); off = o2; len = l2; }
        slot.set(k, i);
      }
      off[i] = o; len[i] = l;
    },
    keys: () => slot.keys(),
    get size() { return slot.size; },
    clear: () => slot.clear(),
  };
}
// a cache in two generations: an entry goes into the current one, which becomes the old one (the old one dropped) once what it
// holds weighs `cap`; a hit in the old one moves to the current one. So it keeps at least the last `cap` of weight used and at
// most 2 × `cap` (plus one entry), every operation O(1). (Evicting the oldest entry of one Map in insertion order costs time with
// the Map's size in V8, whose deleted entries stay as holes the next eviction walks: 6 µs an eviction at 32768 entries, 2026-10-22.)
function gens(cap) {
  let cur = new Map(), old = new Map(), w = 0;
  const put = (k, v, kw) => {
    cur.set(k, [v, kw]); w += kw;
    if (w >= cap) { old = cur; cur = new Map(); w = 0; }
  };
  return {
    get(k) {
      const e = cur.get(k);
      if (e) return e[0];
      const o = old.get(k);
      if (!o) return undefined;
      old.delete(k); put(k, o[0], o[1]);
      return o[0];
    },
    has: (k) => cur.has(k) || old.has(k),
    set(k, v, kw = 1) { const e = cur.get(k); if (e) w -= e[1]; old.delete(k); put(k, v, kw); },
    delete(k) { const e = cur.get(k); if (e) { w -= e[1]; cur.delete(k); } old.delete(k); },
    clear() { cur = new Map(); old = new Map(); w = 0; },
  };
}

/** openProjection({home, fs, key, write, errors}) → the session's store (see the head of this file). `errors`: where notes go
 *  when an append names no other sink (an append of a later request passes that request's `errors`). */
export function openProjection({ home = trocarHome(), fs = nodeFs, key, write = true, errors = [] } = {}) {
  const file = projectionFile(home, key);
  const at = lineIndex(); // bid → its line on disk
  const mem = new Map(); // bid → def, for the definitions that are not on disk
  const rowAt = lineIndex(); // rid → its line on disk
  const rowMem = new Map(); // rid → row, for the rows that are not on disk
  const rowCache = gens(ROW_BYTES); // rid → row, weighed by its line's length
  const brks = new Map();
  const sharedAt = lineIndex(); // shared value key → its line on disk
  const sharedMem = new Map(); // shared value key → the value, while it is not on disk
  const sharedCache = gens(SHARED_BYTES); // one object for every row read while it is kept
  const seen = gens(SEEN); // content keys of the values at share positions written last
  let bytes = 0, torn = false, failing = false, pending = [];

  const refsHeld = (row) => { let ok = true; eachSlot(row, 0, (h, k) => { const v = h[k]; if (!isRef(v)) return isObj(v); if (!sharedAt.has(v.$s)) ok = false; return false; }); return ok; };
  // a line read from disk (opening, append and reads all use the same offsets)
  let fd = null;
  function lineAt([o, l]) {
    if (fd == null) { fd = fs.openSync(file, 'r'); held.register(store, { fs, fd }, store); }
    const buf = Buffer.alloc(l);
    fs.readSync(fd, buf, 0, l, o);
    return JSON.parse(buf.toString('utf8'));
  }
  function sharedOf(k) {
    if (sharedMem.has(k)) return sharedMem.get(k);
    let v = sharedCache.get(k);
    if (v !== undefined) return v;
    const p = sharedAt.get(k);
    if (!p) return undefined;
    v = lineAt(p).s.v;
    sharedCache.set(k, v, p[1]);
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
  const rowKey = (o) => (o.c || o.t).rid;
  // an item taken in: from disk (`off` given: only where its line is) or kept in memory
  const take = (o, off, len) => {
    if (o.d) { if (off == null) mem.set(o.d.bid, o.d); else { mem.delete(o.d.bid); if (!at.has(o.d.bid)) at.set(o.d.bid, off, len); } }
    if (o.s) { if (off == null) sharedMem.set(o.s.k, o.s.v); else { sharedAt.set(o.s.k, off, len); sharedMem.delete(o.s.k); } }
    if (o.c || o.t) {
      const rid = rowKey(o);
      if (off == null) rowMem.set(rid, o.row || o.c || o.t);
      else { rowAt.set(rid, off, len); rowMem.delete(rid); }
      rowCache.delete(rid);
      if (o.row) rowCache.set(rid, o.row, len); // the row as given (the same as it reads back)
    }
    if (o.b) brks.set(pairKey(o.b.brk[0], o.b.brk[1]), o.b);
  };
  // what an append writes of a row: a recurring value (or one of a reference's shape) as an `s` line and a reference
  const note = (v) => { const j = JSON.stringify(v); return j === undefined ? null : j; };
  function encode(row, out) {
    const copy = { ...row };
    eachSlot(copy, 0, (h, k) => {
      const v = h[k], j = note(v);
      if (j == null) return false;
      const key = keyOf(j);
      if (isRef(v) || (j.length >= SHARE_MIN && (seen.has(key) || sharedAt.has(key) || sharedMem.has(key)))) {
        if (!sharedAt.has(key) && !sharedMem.has(key)) { sharedMem.set(key, v); out.push({ s: { k: key, v } }); }
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
    for (const m of [at, mem, rowAt, rowMem, rowCache, brks, sharedAt, sharedMem, sharedCache, seen]) m.clear();
    bytes = 0; torn = false;
    if (write) { try { fs.rmSync(file, { force: true }); } catch { /* the next append truncates it */ torn = true; } }
    errors.push({ where: 'projection', code: 'projection-rebuilt', level: 'note', reason });
  };

  let head = true, bad = null;
  for (const l of linesOf(fs, file)) {
    if (bad) { rebuilt(bad); bad = null; break; } // a bad line that was not the last
    const o = parse(l.text);
    if (head) {
      if (!l.nl || !o) { bad = 'The stored context projection has no readable header; it is rebuilt from the capture.'; continue; }
      if (o.v !== PROJ_V) { rebuilt(`The stored context projection is of version ${JSON.stringify(o.v)}, not ${PROJ_V}; it is rebuilt from the capture.`); break; }
      head = false; bytes = l.off + l.len + 1; continue;
    }
    if (o && o.t) { torn = true; break; } // held rows of an earlier process: from here on everything is extracted again
    if (!l.nl || !shaped(o)) { bad = `Line at byte ${l.off} of the stored context projection does not parse; it is rebuilt from the capture.`; continue; }
    if (o.c && !refsHeld(o.c)) { rebuilt(`Line at byte ${l.off} of the stored context projection names a shared value it does not hold; it is rebuilt from the capture.`); break; }
    take(o, l.off, l.len);
    bytes = l.off + l.len + 1;
  }
  if (bad) torn = true; // only the last line was bad: cut it off before the next append
  if (write && bytes) { try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* the GC order only */ } }

  /** append({defs, rows, brks}, {held, errors}): `held` rows are written as `t` lines, which the next open cuts off with all that
   *  follows them (rows extracted after a member that failed: §3.9); `errors` is where this append's note goes. */
  function append({ defs = [], rows: rs = [], brks: bs = [] } = {}, { held: tent = false, errors: sink = errors } = {}) {
    const items = [...defs.filter((d) => !at.has(d.bid)).map((d) => ({ d })), ...rs.map((r) => (tent ? { t: r } : { c: r })), ...bs.map((b) => ({ b }))];
    if (!write) { for (const o of items) take(o); return; }
    const all = [];
    for (const o of [...pending, ...items]) {
      if ((o.c || o.t) && !o.enc) { const r = o.c || o.t, e = encode(r, all); all.push(o.c ? { c: e, enc: true, row: r } : { t: e, enc: true, row: r }); } else all.push(o);
    }
    let text = bytes ? '' : `${JSON.stringify({ v: PROJ_V })}\n`;
    const placed = [];
    let off = bytes + Buffer.byteLength(text);
    for (const o of all) {
      const line = JSON.stringify(o.enc ? (o.c ? { c: o.c } : { t: o.t }) : o), len = Buffer.byteLength(line);
      placed.push([o, off, len]); text += `${line}\n`; off += len + 1;
    }
    try {
      fs.mkdirSync(ctxDir(home), { recursive: true, mode: 0o700 });
      if (torn) { try { fs.truncateSync(file, bytes); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      torn = true; // until the append is known whole
      fs.appendFileSync(file, text, { mode: 0o600 });
      torn = false; failing = false; pending = []; bytes = off;
      for (const [o, o2, len] of placed) take(o, o2, len);
    } catch (e) {
      for (const o of items) take(o);
      pending = all;
      if (!failing) sink.push({ where: 'projection', code: 'projection-write-failed', level: 'note', reason: `The context projection could not be written (${e.code || e.message}); this session is kept in memory and extracted again next time.` });
      failing = true;
    }
  }

  // one descriptor for the store's reads (a reduction reads tens of thousands of definitions: an open each was most of its time,
  // 2026-10-21), closed by close() or, failing that, when the store is collected
  function readDef(bid) {
    if (mem.has(bid)) return mem.get(bid);
    const p = at.get(bid);
    return p ? lineAt(p).d : undefined;
  }
  function close() {
    if (fd == null) return;
    held.unregister(store);
    try { fs.closeSync(fd); } finally { fd = null; }
  }
  // the rows: those on disk are read back when asked (the most recently used kept, by bytes), so a store's heap does not grow with its session
  function* rowKeys() { yield* rowAt.keys(); for (const k of rowMem.keys()) if (!rowAt.has(k)) yield k; }
  const rows = {
    has: (rid) => rowMem.has(rid) || rowAt.has(rid),
    get(rid) {
      if (rowMem.has(rid)) return rowMem.get(rid);
      const hit = rowCache.get(rid);
      if (hit !== undefined) return hit;
      const p = rowAt.get(rid);
      if (!p) return undefined;
      const o = lineAt(p), row = expand(o.c || o.t);
      rowCache.set(rid, row, p[1]);
      return row;
    },
    get size() { let n = rowAt.size; for (const k of rowMem.keys()) if (!rowAt.has(k)) n++; return n; },
    keys: rowKeys,
    *values() { for (const k of rowKeys()) yield rows.get(k); },
    *[Symbol.iterator]() { for (const k of rowKeys()) yield [k, rows.get(k)]; },
  };

  const store = {
    hasDef: (bid) => at.has(bid) || mem.has(bid),
    readDef,
    close,
    rows,
    brks,
    brk: (prevBid, curBid) => brks.get(pairKey(prevBid, curBid)),
    append,
    get bytes() { return bytes; },
  };
  return store;
}

/** gcProjections({home, fs, liveKeys, keepKeys, capBytes}) → {deleted: [file]}: drops the projections of sessions not in
 *  `liveKeys`, then the least recently opened (mtime: opening touches it) until the total is within `capBytes` (512 MiB).
 *  Never one of `keepKeys` (the sessions open or followed: evicting one would cost its whole extraction on the next read).
 *  `liveKeys` is required: no list is not "no session lives". Only files named like a projection, only under index/ctx/. */
export function gcProjections({ home = trocarHome(), fs = nodeFs, liveKeys, keepKeys = [], capBytes = CAP_BYTES } = {}) {
  if (!liveKeys || typeof liveKeys[Symbol.iterator] !== 'function') throw new TypeError('gcProjections needs liveKeys, the sessions that still have members');
  const dir = ctxDir(home);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => NAME.test(n)); } catch (e) { if (e.code === 'ENOENT') return { deleted: [] }; throw e; }
  const file = (k) => `${hashOf(k)}.ndjson`;
  const keep = new Set([...keepKeys].map(file)), live = new Set([...liveKeys].map(file));
  const deleted = [];
  const drop = (n) => { try { fs.rmSync(path.join(dir, n), { force: true }); deleted.push(path.join(dir, n)); } catch { /* the next GC */ } };
  const kept = [];
  let total = 0;
  for (const n of names) {
    if (!live.has(n) && !keep.has(n)) { drop(n); continue; }
    try { const st = fs.statSync(path.join(dir, n)); total += st.size; if (!keep.has(n)) kept.push({ n, size: st.size, t: st.mtimeMs }); } catch { /* gone meanwhile */ }
  }
  for (const f of kept.sort((a, b) => a.t - b.t)) {
    if (total <= capBytes) break;
    drop(f.n); total -= f.size;
  }
  return { deleted };
}
