// src/query/fold-log.mjs — the FOLD LOG's store (RFC 4.3 §4 折叠日志): one append-only NDJSON file per session beside its
// projection, `index/ctx/<the projection's hash>.fold.ndjson`, that keeps what the reduction produced so a cold open reads it back
// instead of folding again. Storage only: it knows a line by its kind and key, nothing of its contents (the one exception, a
// frontier's `pb`, ties the log to the projection's bytes). A projection like the index (invariant 2, D59): delete it and the next
// fold writes it again.
//
// Lines, the kind = the line's first key, its value the line's rid or lane key: `{v: FOLD_V, pid}` the header (`pid` = the
// projection header's id); `{c: rid, …, p}` a call; `{g: rid, p}` a rid that is no longer a call; `{l: key, …, p}` a lane's head;
// `{lg: key, p}` a lane gone; `{i: rid, …}` an item (a member that is not a call); `{x: rid, …}` a member that failed; `{f: rid, n,
// pb}` a frontier, after each fold step (`pb` = the projection's bytes then). `p` (set by append) = the offset of the previous line
// of the same rid (calls and gones) or lane key (lanes and lane gones), null for the first: versionAt walks it.
//   In the heap: rid → its latest call / gone line, lane key → its latest line, rid → its latest item line and its latest failed line
// (offset and length in typed columns, an index per kind, its slots also linked in the order of their latest offset so what changed
// past an offset is found from the newest back: changedSince, `since`), frontier rid → offset; nothing else per line. Lines are read back by offset through a cache of two times LOG_BYTES of heap (projection.mjs lru).
//   Open: a header of another FOLD_V or a pid not the projection's id, or a line that does not parse before the last → the file is
// deleted and the log starts empty, with one `projection-rebuilt` note (D38). Then it is cut back to the last frontier whose `pb` ≤
// the projection's bytes (a step whose frontier is missing or torn, or that the projection no longer holds, is dropped with all
// after it), cut from the file before the next append. The lines sit on src/query/line-file.mjs: `write: false` and a write that
// fails keep them in the off-heap arena at the offsets they will have; `projection-write-failed` once per episode.
//   Its sidecar (4.3 §4 旁索引, `<hash>.fold.idx`, saveIndex) holds the indexes and frontiers up to the end of a frontier line: an
// open whose header names the projection loads it when it is of this FOLD_V and its frontier's `pb` ≤ the projection's bytes, and
// scans only past it. `upTo` (the end of a frontier line): what lies past it is cut as a torn tail is, so a sidecar that covers
// exactly it stays the log's (session.mjs resumes a reduction whose state that sidecar holds).
import nodeFs from 'node:fs';
import { trocarHome } from '../paths.mjs';
import { lineFile, saveSidecar, loadSidecar } from './line-file.mjs';
import { projectionFile, linesOf, lineIndex, lru, HEAP_PER_LINE_BYTE } from './projection.mjs';

export const FOLD_V = 1;
/** The heap the read cache keeps of parsed lines (two times it): a K term of the reduction's bound (3.5 §内存有界). */
export const LOG_BYTES = 4 << 20;
const CHAIN = { c: 'rid', g: 'rid', l: 'lane', lg: 'lane' };
const KINDS = new Set(['c', 'g', 'l', 'lg', 'i', 'x', 'f']);

export const foldLogFile = (home, key) => projectionFile(home, key).replace(/\.ndjson$/, '.fold.ndjson');

// lineIndex() whose slots are also linked in the order of their latest offset, the newest last (a set moves its slot there; a load
// links them by offset): since(off) → the keys whose latest offset is past `off`, walked back from the newest, O(what it returns)
function byOffset() {
  const idx = lineIndex();
  let prev = new Int32Array(64), next = new Int32Array(64), on = new Uint8Array(64), tail = -1;
  function last(i) {
    if (i === tail) return;
    if (i >= on.length) {
      const m = Math.max(i + 1, 2 * on.length), g = (a) => { const b = new a.constructor(m); b.set(a); return b; };
      prev = g(prev); next = g(next); on = g(on);
    }
    if (on[i]) { if (prev[i] >= 0) next[prev[i]] = next[i]; prev[next[i]] = prev[i]; } // not the tail: it has a next
    prev[i] = tail; next[i] = -1; on[i] = 1;
    if (tail >= 0) next[tail] = i;
    tail = i;
  }
  return {
    get: idx.get, keys: idx.keys, dump: idx.dump, get size() { return idx.size; },
    set(k, o, l) { idx.set(k, o, l); last(idx.slotOf(k)); },
    load(p) { idx.load(p); [...p[1].keys()].sort((a, b) => p[1][a] - p[1][b]).forEach(last); },
    clear() { idx.clear(); on.fill(0); tail = -1; },
    since(off) {
      const out = [];
      for (let i = tail; i >= 0; i = prev[i]) { const k = idx.keyAt(i); if (!(idx.get(k)[0] > off)) break; out.push(k); }
      return out;
    },
  };
}

const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
// a line's kind, or undefined when it is not one
function kindOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const k = Object.keys(o)[0];
  return KINDS.has(k) && typeof o[k] === 'string' && (k !== 'f' || Number.isFinite(o.pb)) ? k : undefined;
}

/** openFoldLog({home, fs, key, write, projection: {id, bytes}, errors}) → the session's fold log (see the head of this file).
 *  Locations are `[offset, length]` (latest, lane, versionAt) or an offset (frontier, frontierAt); read(off, len?) parses the line
 *  there (shared with the cache: read-only). */
export function openFoldLog({ home = trocarHome(), fs = nodeFs, key, write = true, projection, errors = [], upTo = Infinity } = {}) {
  const file = foldLogFile(home, key);
  let sink = errors; // the errors of the request whose append is running
  const lines = lineFile({ fs, file, write, onFail: (e) => sink.push({ where: 'fold-log', code: 'projection-write-failed', level: 'note',
    reason: `The fold log could not be written (${e.code || e.message}); this session's reduction is kept in memory and done again next time.` }) });
  const calls = byOffset(), lanes = byOffset(), items = byOffset(), fails = byOffset(), fronts = new Map();
  const own = { i: items, x: fails };
  const cache = lru(2 * LOG_BYTES); // offset → [line, length]
  let last; // the last frontier's offset
  const take = (k, id, off, len) => {
    if (k === 'f') { fronts.set(id, off); last = off; } else if (CHAIN[k]) (CHAIN[k] === 'rid' ? calls : lanes).set(id, off, len);
    else own[k].set(id, off, len);
  };

  let head = true, bad = null, end = 0, step = [], savedAt = 0, saved = null;
  const OWN = [['c', calls], ['l', lanes], ['i', items], ['x', fails]];
  const rebuild = (reason) => {
    calls.clear(); lanes.clear(); items.clear(); fails.clear(); fronts.clear(); last = undefined; step = []; end = savedAt = 0; saved = null;
    if (write) { try { fs.rmSync(file, { force: true }); } catch { /* cut before the next append */ } }
    errors.push({ where: 'fold-log', code: 'projection-rebuilt', level: 'note', reason });
  };
  // the sidecar of this projection, FOLD_V and a frontier the projection still holds, or nothing of it
  function loaded() {
    const sc = loadSidecar({ fs, file }), h = sc && sc.head;
    if (!h || h.pid !== projection.id || h.fold !== FOLD_V || !(h.pb <= projection.bytes) || !(h.bytes <= upTo) || !Number.isFinite(h.last)) return false;
    try {
      const p = sc.parts;
      for (const [n, idx] of OWN) idx.load([p[`${n}.k`], p[`${n}.o`], p[`${n}.l`]]);
      if (p['f.k'].length !== p['f.o'].length) throw new RangeError('frontiers');
      p['f.k'].forEach((rid, i) => fronts.set(rid, p['f.o'][i]));
      saved = { bytes: h.bytes, parts: Object.fromEntries(Object.entries(p).filter(([n]) => !/^[clixf]\.[kol]$/.test(n))) };
    } catch {
      for (const [, idx] of OWN) idx.clear();
      fronts.clear();
      return false;
    }
    last = h.last; end = savedAt = h.bytes;
    return true;
  }
  function scan(from) {
    for (const l of linesOf(fs, file, from)) {
      if (bad) { rebuild(bad); return false; } // a bad line that was not the last
      if (l.off >= upTo) return false;
      const o = parse(l.text);
      if (head) {
        if (!l.nl || !o) { bad = 'The stored fold log has no readable header; it is folded again.'; continue; }
        if (o.v !== FOLD_V || o.pid !== projection.id) { rebuild(`The stored fold log is of version ${JSON.stringify(o.v)} for projection ${JSON.stringify(o.pid)}, not ${FOLD_V} for ${JSON.stringify(projection.id)}; it is folded again.`); return false; }
        head = false; end = l.off + l.len + 1;
        if (loaded()) return true; // the rest is scanned from where it ends
        continue;
      }
      const k = l.nl ? kindOf(o) : undefined;
      if (!k) { bad = `Line at byte ${l.off} of the stored fold log does not parse; it is folded again.`; continue; }
      if (k === 'f' && o.pb > projection.bytes) return false; // a step the projection no longer holds: it and all after it are dropped
      step.push([k, o[k], l.off, l.len]);
      if (k === 'f') { for (const t of step) take(...t); step = []; end = l.off + l.len + 1; }
    }
    return false;
  }
  if (scan(0)) scan(end);
  step = [];
  lines.cut(end);

  const tryRead = (off, n) => { try { return lines.read(off, n); } catch (e) { if (e instanceof RangeError) return null; throw e; } };
  // the line at `off` when its length is not known: reads that grow until a newline (a line lies wholly in the file or in one
  // append of the arena, so a read that runs past either is narrowed back)
  function lineAt(off) {
    let lo = 0, hi = lines.bytes - off; // `lo` bytes read with no newline; nothing past `hi`
    for (let n = Math.min(1024, hi); ;) {
      const b = tryRead(off, n);
      if (b) { const i = b.indexOf(10); if (i !== -1) return [JSON.parse(b.toString('utf8', 0, i)), i]; lo = n; } else hi = n - 1;
      if (lo >= hi) throw new RangeError(`no line at byte ${off} of the fold log`);
      n = b ? Math.min(2 * n, hi) : (lo + hi + 1) >> 1;
    }
  }
  function entry(off, len) {
    let e = cache.get(off);
    if (e) return e;
    e = len == null ? lineAt(off) : [JSON.parse(lines.read(off, len).toString('utf8')), len];
    cache.set(off, e, e[1] * HEAP_PER_LINE_BYTE);
    return e;
  }

  /** append(lines, {errors}) → each line's offset; sets `p` on the lines of a chain. `errors`: where this append's note goes. */
  function append(ls, { errors: to = errors } = {}) {
    let text = lines.bytes ? '' : `${JSON.stringify({ v: FOLD_V, pid: projection.id })}\n`;
    const start = lines.bytes, mine = new Map(), placed = [];
    let rel = Buffer.byteLength(text);
    for (const o of ls) {
      const k = kindOf(o);
      if (!k) throw new TypeError(`not a fold log line: its first key must be one of ${[...KINDS].join(', ')} naming a string`);
      let line = o;
      if (CHAIN[k]) {
        const ck = `${CHAIN[k]}\n${o[k]}`, prev = mine.get(ck) ?? (CHAIN[k] === 'rid' ? calls : lanes).get(o[k])?.[0] ?? null;
        line = { [k]: o[k], ...o, p: prev };
        mine.set(ck, start + rel);
      }
      const json = JSON.stringify(line), len = Buffer.byteLength(json);
      placed.push([k, o[k], start + rel, len, line]); text += `${json}\n`; rel += len + 1;
    }
    sink = to;
    const base = lines.append(text);
    sink = errors;
    if (base !== start) throw new Error('the fold log moved under an append');
    for (const [k, id, off, len, line] of placed) { take(k, id, off, len); cache.set(off, [line, len], len * HEAP_PER_LINE_BYTE); }
    return placed.map((p) => p[2]);
  }

  function versionAt(rid, off) {
    let at = calls.get(rid);
    while (at && at[0] > off) {
      const p = entry(at[0], at[1])[0].p;
      at = p == null ? undefined : [p, entry(p)[1]];
    }
    return at;
  }
  const keyed = (idx) => ({ get: (id) => idx.get(id), keys: () => idx.keys(), since: (off) => idx.since(off), get size() { return idx.size; } });

  /** saveIndex(extra) → whether it wrote the sidecar: up to the end of the last frontier line, when that grew since the last save
   *  (written logs only). `extra`: [[name, array]] parts a caller adds (no name of the form `<c|l|i|x|f>.<k|o|l>`), handed back by
   *  the next open that loads the sidecar as `saved.parts` (`saved.bytes`: what they cover). */
  function saveIndex(extra = []) {
    if (!lines.settled || last === undefined) return false;
    const [f, len] = entry(last), bytes = last + len + 1;
    if (bytes === savedAt) return false;
    const parts = [];
    for (const [n, idx] of OWN) { const [k, o, l] = idx.dump(); parts.push([`${n}.k`, k], [`${n}.o`, o], [`${n}.l`, l]); }
    parts.push(['f.k', [...fronts.keys()]], ['f.o', Float64Array.from(fronts.values())], ...extra);
    saveSidecar({ fs, file, head: { pid: projection.id, fold: FOLD_V, bytes, pb: f.pb, last }, parts });
    savedAt = bytes;
    return true;
  }

  return {
    append,
    saveIndex,
    /** What the sidecar this open loaded carried besides the indexes ({bytes, parts}), or null (saveIndex). */
    get saved() { return saved; },
    latest: (rid) => calls.get(rid),
    lane: (k) => lanes.get(k),
    /** The item lines and the failed lines by rid (their latest), as {get(rid) → location, keys() in first-written order, since(off)
     *  → the rids whose latest line lies past byte `off` (newest first), size}. */
    items: keyed(items),
    failures: keyed(fails),
    read: (off, len) => entry(off, len)[0],
    /** read() that leaves the cache as it is: a scan of every line (session-doc.mjs sync) parses each once and lets it go young. */
    peek: (off, len) => { const e = cache.get(off); return e ? e[0] : JSON.parse(lines.read(off, len).toString('utf8')); },
    /** The latest line of `rid` at or before byte `off`: walks `p` back from its latest line. */
    versionAt,
    /** The rids and lane keys whose latest line lies past byte `off` (newest first): O(how many). */
    changedSince: (off) => ({ rids: calls.since(off), lanes: lanes.since(off) }),
    get frontier() { return last; },
    frontierAt: (rid) => fronts.get(rid),
    get bytes() { return lines.bytes; },
    close: () => lines.close(),
  };
}
