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
// (offset and length in typed columns, an index per kind), frontier rid → offset; nothing else per line. Lines are read back by offset through a cache of two times LOG_BYTES of heap (projection.mjs lru).
//   Open: a header of another FOLD_V or a pid not the projection's id, or a line that does not parse before the last → the file is
// deleted and the log starts empty, with one `projection-rebuilt` note (D38). Then it is cut back to the last frontier whose `pb` ≤
// the projection's bytes (a step whose frontier is missing or torn, or that the projection no longer holds, is dropped with all
// after it), cut from the file before the next append. The lines sit on src/query/line-file.mjs: `write: false` and a write that
// fails keep them in the off-heap arena at the offsets they will have; `projection-write-failed` once per episode.
import nodeFs from 'node:fs';
import { trocarHome } from '../paths.mjs';
import { lineFile } from './line-file.mjs';
import { projectionFile, linesOf, lineIndex, lru, HEAP_PER_LINE_BYTE } from './projection.mjs';

export const FOLD_V = 1;
/** The heap the read cache keeps of parsed lines (two times it): a K term of the reduction's bound (3.5 §内存有界). */
export const LOG_BYTES = 4 << 20;
const CHAIN = { c: 'rid', g: 'rid', l: 'lane', lg: 'lane' };
const KINDS = new Set(['c', 'g', 'l', 'lg', 'i', 'x', 'f']);

export const foldLogFile = (home, key) => projectionFile(home, key).replace(/\.ndjson$/, '.fold.ndjson');

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
export function openFoldLog({ home = trocarHome(), fs = nodeFs, key, write = true, projection, errors = [] } = {}) {
  const file = foldLogFile(home, key);
  let sink = errors; // the errors of the request whose append is running
  const lines = lineFile({ fs, file, write, onFail: (e) => sink.push({ where: 'fold-log', code: 'projection-write-failed', level: 'note',
    reason: `The fold log could not be written (${e.code || e.message}); this session's reduction is kept in memory and done again next time.` }) });
  const calls = lineIndex(), lanes = lineIndex(), items = lineIndex(), fails = lineIndex(), fronts = new Map();
  const own = { i: items, x: fails };
  const cache = lru(2 * LOG_BYTES); // offset → [line, length]
  let last; // the last frontier's offset
  const take = (k, id, off, len) => {
    if (k === 'f') { fronts.set(id, off); last = off; } else if (CHAIN[k]) (CHAIN[k] === 'rid' ? calls : lanes).set(id, off, len);
    else own[k].set(id, off, len);
  };

  let head = true, bad = null, end = 0, step = [];
  const rebuild = (reason) => {
    calls.clear(); lanes.clear(); items.clear(); fails.clear(); fronts.clear(); last = undefined; step = []; end = 0;
    if (write) { try { fs.rmSync(file, { force: true }); } catch { /* cut before the next append */ } }
    errors.push({ where: 'fold-log', code: 'projection-rebuilt', level: 'note', reason });
  };
  for (const l of linesOf(fs, file)) {
    if (bad) { rebuild(bad); break; } // a bad line that was not the last
    const o = parse(l.text);
    if (head) {
      if (!l.nl || !o) { bad = 'The stored fold log has no readable header; it is folded again.'; continue; }
      if (o.v !== FOLD_V || o.pid !== projection.id) { rebuild(`The stored fold log is of version ${JSON.stringify(o.v)} for projection ${JSON.stringify(o.pid)}, not ${FOLD_V} for ${JSON.stringify(projection.id)}; it is folded again.`); break; }
      head = false; end = l.off + l.len + 1; continue;
    }
    const k = l.nl ? kindOf(o) : undefined;
    if (!k) { bad = `Line at byte ${l.off} of the stored fold log does not parse; it is folded again.`; continue; }
    if (k === 'f' && o.pb > projection.bytes) break; // a step the projection no longer holds: it and all after it are dropped
    step.push([k, o[k], l.off, l.len]);
    if (k === 'f') { for (const t of step) take(...t); step = []; end = l.off + l.len + 1; }
  }
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
  const keyed = (idx) => ({ get: (id) => idx.get(id), keys: () => idx.keys(), get size() { return idx.size; } });
  const past = (idx, off) => { const out = []; for (const k of idx.keys()) if (idx.get(k)[0] > off) out.push(k); return out; };

  return {
    append,
    latest: (rid) => calls.get(rid),
    lane: (k) => lanes.get(k),
    /** The item lines and the failed lines by rid (their latest), as {get(rid) → location, keys() in first-written order, size}. */
    items: keyed(items),
    failures: keyed(fails),
    read: (off, len) => entry(off, len)[0],
    /** read() that leaves the cache as it is: a scan of every line (session-doc.mjs sync) parses each once and lets it go young. */
    peek: (off, len) => { const e = cache.get(off); return e ? e[0] : JSON.parse(lines.read(off, len).toString('utf8')); },
    /** The latest line of `rid` at or before byte `off`: walks `p` back from its latest line. */
    versionAt,
    /** The rids and lane keys whose latest line lies past byte `off`. */
    changedSince: (off) => ({ rids: past(calls, off), lanes: past(lanes, off) }),
    get frontier() { return last; },
    frontierAt: (rid) => fronts.get(rid),
    get bytes() { return lines.bytes; },
    close: () => lines.close(),
  };
}
