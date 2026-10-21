// src/query/projection.mjs — the CONTEXT PROJECTION's store (RFC 4.3 §4, D69): one append-only NDJSON
// file per session, `index/ctx/<first 32 hex of sha256(session key)>.ndjson`, that keeps what extraction found so a
// warm session is not re-extracted. Storage only: it knows a definition by `def.bid`, a call row by `row.rid` and a
// break by its `brk` pair, and nothing else of their contents. A projection like the index (invariant 2, D59): delete
// it and the next open rebuilds it, answer for answer the same.
//
// Lines: `{"v":PROJ_V}`, then `{"d":def}`, `{"c":row}`, `{"b":brk}`, `{"s":{k,v}}` in any order. Definitions stay on disk;
// the store holds only bid → [offset, length] and reads one back when asked (the worker's heap budget). Rows and breaks are held.
//   Shared values (`s`): a value that recurs across rows (a lane's facts, a call's attributes, the wire's labels) is written once.
// Top down to SHARE_DEPTH levels under a row, a value of SHARE_MIN bytes or more whose content was seen before in this store is
// written as an `s` line keyed by its hash and stands in the row as `{"$s":key}`; a value seen for the first time stays inline and
// its children are looked at. Opening puts each shared value back as one object every row holding it shares. An original value of
// the reference's own shape is always shared, so a reference is never ambiguous. Content-blind: the store knows nothing of a row.
//   A header of another version, or a line that does not parse before the last → the file is deleted and the store
// starts empty, with one `projection-rebuilt` note (D38). A torn last line (no newline, or not JSON) is cut off before
// the next append, silently: an interrupted append, nothing lost that was ever whole. A write that fails keeps the
// items in memory, says `projection-write-failed` once per episode, and writes them with the next write that works.
// `write: false` (the local CLI's path) never touches the disk.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { indexDir } from './index-build.mjs';
import { parseRecordId } from '../collector/core/record/segments.mjs';
import { trocarHome } from '../paths.mjs';

export const PROJ_V = 2;
const CAP_BYTES = 512 << 20; // the total's ceiling (gcProjections)
const SHARE_DEPTH = 3, SHARE_MIN = 48;
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
// a row just parsed, its references put back in place (shared instances); null when one names no shared value
function expand(row, shared) {
  let ok = true;
  eachSlot(row, 0, (h, k) => {
    const v = h[k];
    if (!isRef(v)) return isObj(v);
    if (shared.has(v.$s)) h[k] = shared.get(v.$s); else ok = false;
    return false;
  });
  return ok ? row : null;
}

/** openProjection({home, fs, key, write, errors}) → the session's store (see the head of this file). */
export function openProjection({ home = trocarHome(), fs = nodeFs, key, write = true, errors = [] } = {}) {
  const file = projectionFile(home, key);
  const at = new Map(); // bid → [offset, length] of its line on disk
  const mem = new Map(); // bid → def, for the definitions that are not on disk
  const rows = new Map();
  const brks = new Map();
  const shared = new Map(); // shared value key → the value (one object for every row that holds it)
  let seen = null; // content keys of every value at a share position so far, built at the first append (opening does not hash)
  let bytes = 0, torn = false, failing = false, pending = [];

  const take = (o, off, len) => {
    if (o.d) { if (off == null) mem.set(o.d.bid, o.d); else if (!at.has(o.d.bid)) at.set(o.d.bid, [off, len]); }
    if (o.s) shared.set(o.s.k, o.s.v);
    if (o.c) { const row = off == null ? o.c : expand(o.c, shared); if (!row) return false; rows.set(row.rid, row); }
    if (o.b) brks.set(pairKey(o.b.brk[0], o.b.brk[1]), o.b);
    return true;
  };
  // what an append writes of a row: a recurring value (or one of a reference's shape) as an `s` line and a reference
  const note = (v) => { const j = JSON.stringify(v); return j === undefined ? null : j; };
  function seenSet() {
    if (seen) return seen;
    seen = new Set(shared.keys());
    for (const row of rows.values()) eachSlot(row, 0, (h, k) => { const j = note(h[k]); if (j == null) return false; seen.add(keyOf(j)); return isObj(h[k]); });
    return seen;
  }
  function encode(row, out) {
    const S = seenSet(), copy = { ...row };
    eachSlot(copy, 0, (h, k) => {
      const v = h[k], j = note(v);
      if (j == null) return false;
      const key = keyOf(j);
      if (isRef(v) || (j.length >= SHARE_MIN && S.has(key))) {
        if (!shared.has(key)) { shared.set(key, v); out.push({ s: { k: key, v } }); }
        h[k] = { $s: key };
        return false;
      }
      S.add(key);
      if (!isObj(v)) return false;
      h[k] = Array.isArray(v) ? v.slice() : { ...v };
      return true;
    });
    return copy;
  }
  const rebuilt = (reason) => {
    at.clear(); rows.clear(); brks.clear(); shared.clear(); seen = null; bytes = 0; torn = false;
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
    if (!l.nl || !shaped(o)) { bad = `Line at byte ${l.off} of the stored context projection does not parse; it is rebuilt from the capture.`; continue; }
    if (!take(o, l.off, l.len)) { rebuilt(`Line at byte ${l.off} of the stored context projection names a shared value it does not hold; it is rebuilt from the capture.`); break; }
    bytes = l.off + l.len + 1;
  }
  if (bad) torn = true; // only the last line was bad: cut it off before the next append
  if (write && bytes) { try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* the GC order only */ } }

  function append({ defs = [], rows: rs = [], brks: bs = [] } = {}, { persist = true } = {}) {
    const items = [...defs.filter((d) => !at.has(d.bid)).map((d) => ({ d })), ...rs.map((c) => ({ c })), ...bs.map((b) => ({ b }))];
    if (!write || !persist) { for (const o of items) take(o); return; }
    const all = [];
    for (const o of [...pending, ...items]) { if (o.c && !o.enc) { all.push({ c: encode(o.c, all), enc: true, row: o.c }); } else all.push(o); }
    let text = bytes ? '' : `${JSON.stringify({ v: PROJ_V })}\n`;
    const placed = [];
    let off = bytes + Buffer.byteLength(text);
    for (const o of all) {
      const line = JSON.stringify(o.enc ? { c: o.c } : o), len = Buffer.byteLength(line);
      placed.push([o, off, len]); text += `${line}\n`; off += len + 1;
    }
    try {
      fs.mkdirSync(ctxDir(home), { recursive: true, mode: 0o700 });
      if (torn) { try { fs.truncateSync(file, bytes); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      torn = true; // until the append is known whole
      fs.appendFileSync(file, text, { mode: 0o600 });
      torn = false; failing = false; pending = []; bytes = off;
      for (const [o, o2, len] of placed) { if (o.d) { mem.delete(o.d.bid); take(o, o2, len); } else if (o.b) take(o); }
      for (const o of items) if (o.c) take(o); // the rows as given (their shared values are in `shared` already)
    } catch (e) {
      for (const o of items) take(o);
      pending = all;
      if (!failing) errors.push({ where: 'projection', code: 'projection-write-failed', level: 'note', reason: `The context projection could not be written (${e.code || e.message}); this session is kept in memory and extracted again next time.` });
      failing = true;
    }
  }

  // one descriptor for the store's reads (a reduction reads tens of thousands of definitions: an open each was most of its time,
  // 2026-10-21), closed by close() or, failing that, when the store is collected
  let fd = null;
  function readDef(bid) {
    if (mem.has(bid)) return mem.get(bid);
    const p = at.get(bid);
    if (!p) return undefined;
    if (fd == null) { fd = fs.openSync(file, 'r'); held.register(store, { fs, fd }, store); }
    const buf = Buffer.alloc(p[1]);
    fs.readSync(fd, buf, 0, p[1], p[0]);
    return JSON.parse(buf.toString('utf8')).d;
  }
  function close() {
    if (fd == null) return;
    held.unregister(store);
    try { fs.closeSync(fd); } finally { fd = null; }
  }

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
