// src/query/line-file.mjs — an append-only file of newline-ended lines, read back by byte offset (RFC 4.3 §4 上下文投影 写者). The
// projection store (src/query/projection.mjs) and the fold log keep where each line is and read it back when asked, so their heap
// does not grow with what they hold.
//   The lines past the file's end live in an off-heap ARENA (Buffers: external memory, not the V8 heap): `write: false` (the local
// path, which writes nothing) appends every line there; `write: true` appends to the file, and a write that fails keeps the text in
// the arena (`onFail(error)` once per episode of failures) and writes it with the next append that works. The arena starts at the
// file's end, so an offset handed out never changes. One descriptor for reads, closed by close() or, failing that, when the
// line file is collected.
//   A SIDECAR (4.3 §4 旁索引) beside it, `<name>.idx`, holds what a scan of the file's first `bytes` would have put in the heap: the
// header line `{v: SIDECAR_V, …head, bytes, parts: [[name, type, byteLength]]}`, then each part's bytes. Never a second source: a
// sidecar that does not load is a scan. The file created anew or truncated drops its sidecar first.
import nodeFs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SIDECAR_V = 1;
const TYPES = { f64: Float64Array, u32: Uint32Array, i32: Int32Array, u8: Uint8Array };
/** A line file's sidecar: `<name>.idx` beside its plain files `<name>.<T>.ndjson`. */
export const sidecarOf = (file) => file.replace(/(\.\d+)?\.ndjson$/, '') + '.idx';

/** saveSidecar({fs, file, head, parts}): `file`'s sidecar, written to a temp file in its directory then renamed over (0600). `head`
 *  carries `bytes` (the length it covers); `parts`: [[name, a typed array of TYPES or an array of strings (`str`: none holds "\n")]]. */
export function saveSidecar({ fs = nodeFs, file, head, parts }) {
  const bufs = [], desc = [];
  for (const [name, v] of parts) {
    const type = Array.isArray(v) ? 'str' : Object.keys(TYPES).find((t) => v instanceof TYPES[t]);
    if (!type) throw new TypeError(`sidecar part ${name}: not one of str, ${Object.keys(TYPES).join(', ')}`);
    if (type === 'str' && v.some((x) => String(x).includes('\n'))) throw new TypeError(`sidecar part ${name}: a string holds a newline`);
    const b = type === 'str' ? Buffer.from(v.join('\n'), 'utf8') : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    bufs.push(b); desc.push([name, type, b.length]);
  }
  const side = sidecarOf(file), tmp = `${side}.tmp`;
  try {
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, v: SIDECAR_V, parts: desc })}\n`), ...bufs]), { mode: 0o600 });
    fs.renameSync(tmp, side);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* the next save */ } throw e; }
}

// a str part's strings, each decoded on its own: a split of one decoded string would give slices that keep all of it alive while any one
// is kept (the indexes keep every key for as long as the file is open)
function strings(b, from, to) {
  const out = [];
  for (let at = from - 1; from < to && at < to; from = at + 1) { at = b.indexOf(10, from); if (at < 0 || at > to) at = to; out.push(b.toString('utf8', from, at)); }
  if (to > 0 && b[to - 1] === 10 && out.length) out.push('');
  return out;
}

/** loadSidecar({fs, file, endsLine}) → {head, parts: {name: array}} | null: missing, unreadable, of another version, short or long, or
 *  covering more than the lines hold or not ending at a line's end (`endsLine(bytes)`; by default `file`'s byte before `bytes`). */
export function loadSidecar({ fs = nodeFs, file, endsLine = (n) => lastIsNl(fs, file, n) }) {
  // each part read into a buffer of its own: no copy of the whole file is held while the parts are taken out of it (a resumed
  // session's sidecar is tens of MB, and the garbage would stay until the next full collection)
  let fd;
  try {
    fd = fs.openSync(sidecarOf(file), 'r');
    const size = fs.fstatSync(fd).size, read = (n, pos, into = Buffer.allocUnsafe(n)) => (fs.readSync(fd, into, 0, n, pos) === n ? into : null);
    let hb = Buffer.alloc(0), nl = -1;
    while (nl < 0 && hb.length < size) { const c = read(Math.min(1 << 16, size - hb.length), hb.length); if (!c) return null; nl = c.indexOf(10); nl = nl < 0 ? -1 : hb.length + nl; hb = Buffer.concat([hb, c]); }
    if (nl < 0) return null;
    const { v, parts: desc, ...head } = JSON.parse(hb.toString('utf8', 0, nl));
    if (v !== SIDECAR_V || !Array.isArray(desc) || !Number.isSafeInteger(head.bytes) || head.bytes < 1) return null;
    const parts = {};
    let at = nl + 1;
    for (const [name, type, n] of desc) {
      if (!Number.isSafeInteger(n) || n < 0 || at + n > size || (type !== 'str' && (!TYPES[type] || n % TYPES[type].BYTES_PER_ELEMENT))) return null;
      const b = read(n, at, type === 'str' ? undefined : new Uint8Array(new ArrayBuffer(n)));
      if (!b) return null;
      parts[name] = type === 'str' ? strings(b, 0, n) : new TYPES[type](b.buffer);
      at += n;
    }
    if (at !== size || !endsLine(head.bytes)) return null;
    return { head, parts };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

function lastIsNl(fs, file, n) {
  const fl = fs.openSync(file, 'r'), last = Buffer.alloc(1);
  try { return fs.readSync(fl, last, 0, 1, n - 1) === 1 && last[0] === 10; } finally { fs.closeSync(fl); }
}

const held = new FinalizationRegistry(({ fs, fd }) => { try { fs.closeSync(fd); } catch { /* already closed */ } });


/** Plain bytes a sealed part holds at least (4.3 §4 分片, about 8 MiB, SHOULD): seal() cuts at the first line end at or past it. */
export const PART_BYTES = 8 << 20;
const BROTLI = { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 }; // as src/raw/writer.mjs
const DECODED_BYTES = 32 << 20; // the decoded parts kept, by bytes
const CHUNK = 1 << 20;
/** The first read of a scan of the plain tail, doubling up to CHUNK: a caller that stops after the first lines reads about them only. */
export const FIRST_CHUNK = 4 << 10;

// parts decoded (a Buffer's bytes are external memory, not the V8 heap), by path and the file's identity, least recently used first
const decoded = new Map();
let decodedBytes = 0;
/** releaseParts(): drop every decoded part (the worker's idle period). */
export function releaseParts() { decoded.clear(); decodedBytes = 0; }
function plainOf(fs, p) {
  let b = decoded.get(p.key);
  if (b) { decoded.delete(p.key); decoded.set(p.key, b); return b; }
  b = zlib.brotliDecompressSync(fs.readFileSync(p.path));
  if (b.length !== p.b - p.a) throw new RangeError(`${path.basename(p.path)} decodes to ${b.length} bytes`);
  decoded.set(p.key, b); decodedBytes += b.length;
  for (const [k, v] of decoded) { if (decodedBytes <= DECODED_BYTES || k === p.key) break; decoded.delete(k); decodedBytes -= v.length; }
  return b;
}
function syncDir(fs, dir) { try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* a platform with no directory fsync */ } }
// `file` holds `buf` whole or is as it was: a temp file, fsynced, renamed over, the directory fsynced
function durable(fs, file, buf) {
  const tmp = `${file}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(fs, path.dirname(file));
}
function readAt(fs, fd, pos, n) {
  const b = Buffer.alloc(n);
  for (let got = 0, k; got < n; got += k) if (!(k = fs.readSync(fd, b, got, n - got, pos + got))) throw new RangeError(`short read at ${pos + got}`);
  return b;
}

/** lineFile({fs, base, write, onFail}) → {append(text) → the offset of its first byte, read(off, len) → Buffer, scan(from), bytes,
 *  settled, unreadable, cut(len), remove(), seal({partBytes}), touch(), loadSidecar(), saveSidecar({head, parts}), close()}.
 *  `base` = `<dir>/<name>`: the lines' global bytes [0, end) are the sealed parts `<name>.<a>-<b>.br` (the brotli of exactly
 *  [a, b), cut at a line end, chaining from 0 to C) then the plain tail `<name>.<C>.ndjson`; the sidecar is `<name>.idx`. Content
 *  blind: bytes and line ends only. `settled`: written, every byte on disk (no arena, nothing to cut): a sidecar may be saved, a
 *  part sealed. `bytes`: the end (the disk's bytes that count, then the arena's). `cut(len)`: what lies past `len` is no longer
 *  there (a torn tail, a file rebuilt); with `write` the disk is made so before the next write (parts past it removed, the one it
 *  falls in turned back into the tail). `unreadable`: why the files are not one line file (a broken chain of parts, a tail that
 *  begins past them, a part that does not decode), or null: the owner rebuilds (remove()). `scan(from)` yields every line on disk
 *  from `from` (a line's start) as {off, len, text, nl}. */
export function lineFile({ fs = nodeFs, base, write = true, onFail = () => {} } = {}) {
  const dir = path.dirname(base), name = path.basename(base), side = `${base}.ndjson`; // sidecarOf(side) = <name>.idx
  const NAMES = new RegExp(`^${name.replace(/[^\w-]/g, '\\$&')}\\.(?:(\\d+)-(\\d+)\\.br|(\\d+)\\.ndjson)(\\.tmp)?$`);
  const tailOf = (t) => `${base}.${t}.ndjson`, partOf = (a, b) => `${base}.${a}-${b}.br`;
  const files = () => {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.flatMap((n) => { const m = NAMES.exec(n); return m ? [{ path: path.join(dir, n), a: m[1] && +m[1], b: m[2] && +m[2], t: m[3] && +m[3], tmp: !!m[4] }] : []; });
  };
  const partAt = (f) => { const st = fs.statSync(f.path); return { path: f.path, a: f.a, b: f.b, key: `${f.path}|${st.ino}|${st.size}|${st.mtimeMs}` }; };
  let parts = [], C = 0, T = 0, end = 0; // the parts [0, C), the tail from T (T == C once a writer opened it), the disk's end
  let junk = false, unreadable = null, trunc = false; // trunc: the disk may hold bytes past `end`: made so before the next write
  let starts = [], bufs = [], arena = 0; // the arena: each append's text, by the offset of its first byte
  let failing = false, fd = null;

  const found = files(), ps = found.filter((f) => !f.tmp && f.b !== undefined).sort((x, y) => x.a - y.a);
  for (const p of ps) { if (p.a !== C || !(p.b > p.a)) { unreadable = `${path.basename(p.path)} does not follow the parts before it`; break; } C = p.b; }
  const tails = found.filter((f) => !f.tmp && f.t !== undefined).sort((x, y) => y.t - x.t);
  const tail = tails.find((f) => f.t === C) || tails.find((f) => f.t < C);
  if (!unreadable && !tail && tails.length) unreadable = `the plain tail of ${name} begins past its parts`;
  if (unreadable) { junk = true; C = 0; trunc = write; } else {
    parts = ps.map(partAt);
    T = tail ? tail.t : C;
    end = Math.max(C, tail ? T + fs.statSync(tail.path).size : C);
    if (write) {
      try {
        if (T < C) { // killed between a part and the tail after it: the tail from C, the old one gone
          const f = fs.openSync(tail.path, 'r');
          try { durable(fs, tailOf(C), end > C ? readAt(fs, f, C - T, end - C) : Buffer.alloc(0)); } finally { fs.closeSync(f); }
          T = C;
        }
        for (const f of found) if (f.tmp || (f.t !== undefined && f.t !== T)) fs.rmSync(f.path, { force: true }); // what a killed seal left
      } catch { /* read as it is; the next writer tries again */ }
    }
  }

  // a part that does not decode: the file is not one line file; a writer removes the part, so the next open rebuilds
  function broken(p, e) {
    unreadable = `${path.basename(p.path)} does not decode (${e.code || e.message})`;
    if (write) try { fs.rmSync(p.path, { force: true }); } catch { /* the next open */ }
  }
  const partIndex = (off) => { let lo = 0, hi = parts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (parts[mid].a <= off) lo = mid; else hi = mid - 1; } return lo; };
  function plain(p) { try { return plainOf(fs, p); } catch (e) { broken(p, e); throw Object.assign(new Error(unreadable), { code: 'ELINEPART' }); } }

  // the disk made to hold [0, end) only: the tail truncated, or the parts past `end` removed (the newest first, so what is left
  // always chains from 0) and the one `end` falls in turned back into the tail
  function settle() {
    if (!junk && end >= C) { try { fs.truncateSync(tailOf(T), end - T); } catch (e) { if (e.code !== 'ENOENT') throw e; } return; }
    const keep = junk ? [] : parts.filter((p) => p.b <= end), nc = keep.length ? keep[keep.length - 1].b : 0;
    const pre = end > nc ? plain(parts[keep.length]).subarray(0, end - nc) : null;
    close();
    const kept = new Set(keep.map((p) => p.path)), rank = (f) => (f.b === undefined || f.tmp ? Infinity : f.a);
    for (const f of files().sort((x, y) => rank(y) - rank(x))) if (!kept.has(f.path)) fs.rmSync(f.path, { force: true });
    if (pre) durable(fs, tailOf(nc), pre);
    parts = keep; C = T = nc; junk = false;
  }

  function append(text) {
    const at = end + arena, buf = Buffer.from(text, 'utf8');
    if (write) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (trunc || !end) fs.rmSync(sidecarOf(side), { force: true }); // what it covers is no longer there
        if (trunc) settle();
        trunc = true; // until the append is known whole
        const out = arena ? Buffer.concat([...bufs, buf]) : buf;
        fs.appendFileSync(tailOf(T), out, { mode: 0o600 });
        trunc = false; failing = false; end += out.length; starts = []; bufs = []; arena = 0;
        return at;
      } catch (e) {
        if (!failing) onFail(e);
        failing = true;
      }
    }
    starts.push(at); bufs.push(buf); arena += buf.length;
    return at;
  }

  function read(off, len) {
    if (off >= end) { // in the arena: the last append that starts at or before it
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      const b = bufs[lo], from = off - starts[lo];
      if (!b || from + len > b.length) throw new RangeError(`no line at byte ${off} of ${name}`);
      return b.subarray(from, from + len);
    }
    if (off < C) {
      const p = parts[partIndex(off)];
      if (off + len > p.b) throw new RangeError(`no line at byte ${off} of ${name}`);
      return plain(p).subarray(off - p.a, off - p.a + len);
    }
    if (fd == null) { fd = fs.openSync(tailOf(T), 'r'); held.register(self, { fs, fd }, self); }
    const b = Buffer.alloc(len);
    if (fs.readSync(fd, b, 0, len, off - T) !== len) throw new RangeError(`no line at byte ${off} of ${name}`);
    return b;
  }

  // the disk's bytes from `from`, chunk by chunk (a chunk is overwritten by the next)
  function* chunks(from) {
    for (let i = partIndex(from); from < C && i < parts.length; i++) {
      let b;
      try { b = plainOf(fs, parts[i]); } catch (e) { broken(parts[i], e); return; }
      yield b.subarray(from - parts[i].a); from = parts[i].b;
    }
    let f;
    try { f = fs.openSync(tailOf(T), 'r'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      const buf = Buffer.alloc(CHUNK);
      for (let n, size = FIRST_CHUNK, pos = from - T; (n = fs.readSync(f, buf, 0, size, pos)) > 0; pos += n, size = Math.min(2 * size, CHUNK)) yield buf.subarray(0, n);
    } finally { fs.closeSync(f); }
  }
  function* scan(from = 0) {
    let carry = null, at = from;
    for (const c of chunks(from)) {
      const b = carry ? Buffer.concat([carry, c]) : c;
      let s = 0, i;
      while ((i = b.indexOf(10, s)) !== -1) { yield { off: at + s, len: i - s, text: b.toString('utf8', s, i), nl: true }; s = i + 1; }
      at += s; carry = s < b.length ? Buffer.from(b.subarray(s)) : null;
    }
    if (carry) yield { off: at, len: carry.length, text: carry.toString('utf8'), nl: false };
  }

  function cut(len) {
    if (len >= end) return;
    starts = []; bufs = []; arena = 0; end = len; trunc = write;
  }
  /** remove(): no lines; a writer deletes every file of this line file now (a rebuild). */
  function remove() {
    cut(0);
    if (!write) return;
    try { fs.rmSync(sidecarOf(side), { force: true }); settle(); trunc = false; } catch { /* cut before the next append */ }
  }

  function close() {
    if (fd == null) return;
    held.unregister(self);
    try { fs.closeSync(fd); } finally { fd = null; }
  }

  const self = {
    append, read, scan, cut, remove, close,
    touch() { if (write && end) try { const t = new Date(); fs.utimesSync(tailOf(T), t, t); } catch { /* the GC order only */ } },
    loadSidecar: () => loadSidecar({ fs, file: side, endsLine: (n) => n <= end && read(n - 1, 1)[0] === 10 }),
    saveSidecar: ({ head, parts: ps2 }) => saveSidecar({ fs, file: side, head, parts: ps2 }),
    get bytes() { return end + arena; }, get settled() { return write && !arena && !trunc; }, get unreadable() { return unreadable; },
  };
  return self;
}
