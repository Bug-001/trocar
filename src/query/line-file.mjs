// src/query/line-file.mjs — an append-only line file of newline-ended lines, read back by global byte offset (RFC 4.3 §4 上下文投影
// 分片 · 写者). The projection store (src/query/projection.mjs) and the fold log keep where each line is and read it back when asked,
// so their heap does not grow with what they hold.
//   On disk, in the session's directory: SEALED PARTS `<name>.<a>-<b>.br` (exactly the bytes [a, b), cut at a line end, chaining
// from 0, as independently decodable brotli FRAMES each cut at a line end, then their table) and one PLAIN TAIL `<name>.<T>.ndjson`
// (the bytes from T, the last part's end): offsets never change when a prefix is sealed. A line read decodes the one frame that
// holds it, once, into a cache of decoded frames capped by bytes, off the V8 heap (releaseParts() drops it). The lines past the
// disk's end live in an off-heap ARENA (Buffers: external memory, not the V8 heap): `write: false` (the local path, which writes
// nothing) appends every line there; `write: true` appends to the tail, and a write that fails keeps
// the text in the arena (`onFail(error)` once per episode of failures) and writes it with the next append that works. The arena
// starts at the disk's end, so an offset handed out never changes. One descriptor for reads of the tail, closed by close(), by
// seal(), or, failing that, when the line file is collected.
//   A SIDECAR (4.3 §4 旁索引) beside it, `<name>.idx`, holds what a scan of the first `bytes` would have put in the heap: the
// header line `{v: SIDECAR_V, …head, bytes, parts: [[name, type, byteLength]]}`, then each part's bytes. Never a second source: a
// sidecar that does not load is a scan. The lines created anew or cut drop their sidecar before the next write.
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
const DECODED_BYTES = 32 << 20; // the decoded frames kept, by bytes
const CHUNK = 1 << 20;
/** The first read of a scan of the plain tail, doubling up to CHUNK: a caller that stops after the first lines reads about them only. */
export const FIRST_CHUNK = 4 << 10;

// frames decoded (a Buffer's bytes are external memory, not the V8 heap), by path, the file's identity and the frame, least recently
// used first
const decoded = new Map();
let decodedBytes = 0;
// parts that did not decode, by the same identity: an open that finds one is not one line file (the local path, which does not
// remove it, rebuilds in memory instead of decoding it again at a read; 4.3 §4 分片)
const undecodable = new Set();
/** releaseParts(): drop every decoded frame (the worker's idle period). */
export function releaseParts() { decoded.clear(); decodedBytes = 0; }
/** Plain bytes a frame of a sealed part holds at least (4.3 §4 分片): seal() cuts a part into independently decodable frames, each at
 *  the first line end at or past it, so a line lies in one frame and reading it decodes that frame only. */
export const FRAME_BYTES = 256 << 10;
const MAGIC = 0x31465254; // "TRF1"
/** framed(raw, frameBytes) → a sealed part's bytes: the brotli of each frame of `raw` (cut at the first line end at or past
 *  frameBytes from its start), then the frame table (per frame: compressed length, plain length; u32 LE), the frame count, MAGIC. */
function framed(raw, frameBytes = FRAME_BYTES) {
  const out = [], table = [];
  for (let a = 0; a < raw.length;) {
    let z = raw.indexOf(10, a + frameBytes - 1) + 1;
    if (z <= 0) z = raw.length;
    const x = raw.subarray(a, z), y = zlib.brotliCompressSync(x, { params: { ...BROTLI, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: x.length } });
    out.push(y); table.push(y.length, x.length); a = z;
  }
  const t = Buffer.alloc(4 * table.length + 8);
  table.forEach((v, i) => t.writeUInt32LE(v, 4 * i));
  t.writeUInt32LE(table.length / 2, 4 * table.length); t.writeUInt32LE(MAGIC, 4 * table.length + 4);
  return Buffer.concat([...out, t]);
}
// a part's frame table: [compressed start, plain start] per frame and the plain end, read once per part (its tail bytes)
function tableOf(fs, p) {
  if (p.t) return p.t;
  const fd = fs.openSync(p.path, 'r');
  try {
    const size = fs.fstatSync(fd).size, tail = size >= 8 ? readAt(fs, fd, size - 8, 8) : null, n = tail ? tail.readUInt32LE(0) : 0;
    if (!tail || tail.readUInt32LE(4) !== MAGIC || !n || 8 * n + 8 > size) throw new RangeError(`${path.basename(p.path)} has no frame table`);
    const t = readAt(fs, fd, size - 8 - 8 * n, 8 * n), c = new Float64Array(n + 1), q = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { c[i + 1] = c[i] + t.readUInt32LE(8 * i); q[i + 1] = q[i] + t.readUInt32LE(8 * i + 4); }
    if (c[n] + 8 * n + 8 !== size || q[n] !== p.b - p.a) throw new RangeError(`${path.basename(p.path)}'s frame table does not tile it`);
    return (p.t = { c, q, n });
  } finally { fs.closeSync(fd); }
}
// the frame of part p covering its plain byte `rel`: {buf, at} (at: the frame's plain start in the part), decoded once into the cache
function frameOf(fs, p, rel) {
  const { c, q, n } = tableOf(fs, p);
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (q[mid] <= rel) lo = mid; else hi = mid - 1; }
  const key = `${p.key}#${lo}`;
  let b = decoded.get(key);
  if (b) { decoded.delete(key); decoded.set(key, b); return { buf: b, at: q[lo] }; }
  const fd = fs.openSync(p.path, 'r');
  try { b = zlib.brotliDecompressSync(readAt(fs, fd, c[lo], c[lo + 1] - c[lo])); } finally { fs.closeSync(fd); }
  if (b.length !== q[lo + 1] - q[lo]) throw new RangeError(`${path.basename(p.path)} frame ${lo} decodes to ${b.length} bytes`);
  decoded.set(key, b); decodedBytes += b.length;
  for (const [k, v] of decoded) { if (decodedBytes <= DECODED_BYTES || k === key) break; decoded.delete(k); decodedBytes -= v.length; }
  return { buf: b, at: q[lo] };
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
 *  `base` = `<dir>/<name>`: the lines' global bytes [0, end) are the sealed parts `<name>.<a>-<b>.br` (exactly [a, b) framed,
 *  cut at a line end, chaining from 0 to C) then the plain tail `<name>.<C>.ndjson`; the sidecar is `<name>.idx`. Content
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
  let covers = Infinity; // the bytes the sidecar on disk covers, once this handle loaded or saved it; unknown: all

  const found = files(), ps = found.filter((f) => !f.tmp && f.b !== undefined).sort((x, y) => x.a - y.a);
  for (const p of ps) { if (p.a !== C || !(p.b > p.a)) { unreadable = `${path.basename(p.path)} does not follow the parts before it`; break; } C = p.b; }
  const tails = found.filter((f) => !f.tmp && f.t !== undefined).sort((x, y) => y.t - x.t);
  const tail = tails.find((f) => f.t === C) || tails.find((f) => f.t < C);
  if (!unreadable && !tail && tails.length) unreadable = `the plain tail of ${name} begins past its parts`;
  if (!unreadable) { parts = ps.map(partAt); const bad = parts.find((p) => undecodable.has(p.key)); if (bad) unreadable = `${path.basename(bad.path)} does not decode`; }
  if (unreadable) { parts = []; junk = true; C = 0; trunc = write; } else {
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
    undecodable.add(p.key);
    if (write) try { fs.rmSync(p.path, { force: true }); } catch { /* the next open */ }
  }
  const partIndex = (off) => { let lo = 0, hi = parts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (parts[mid].a <= off) lo = mid; else hi = mid - 1; } return lo; };
  function frame(p, rel) { try { return frameOf(fs, p, rel); } catch (e) { broken(p, e); throw Object.assign(new Error(unreadable), { code: 'ELINEPART' }); } }
  // part p's plain bytes [0, n): its frames from the first
  const prefix = (p, n) => { const bs = []; for (let at = 0; at < n;) { const f = frame(p, at); bs.push(f.buf); at = f.at + f.buf.length; } return Buffer.concat(bs).subarray(0, n); };

  // the disk made to hold [0, end) only: the tail truncated, or the parts past `end` removed (the newest first, so what is left
  // always chains from 0) and the one `end` falls in turned back into the tail
  function settle() {
    if (!junk && end >= C) { try { fs.truncateSync(tailOf(T), end - T); } catch (e) { if (e.code !== 'ENOENT') throw e; } return; }
    const keep = junk ? [] : parts.filter((p) => p.b <= end), nc = keep.length ? keep[keep.length - 1].b : 0;
    const pre = end > nc ? prefix(parts[keep.length], end - nc) : null;
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
        if (!end || (trunc && covers > end)) fs.rmSync(sidecarOf(side), { force: true }); // what it covers is no longer there
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
      const { buf, at } = frame(p, off - p.a), from = off - p.a - at;
      if (from + len > buf.length) throw new RangeError(`no line at byte ${off} of ${name}`);
      return buf.subarray(from, from + len);
    }
    if (fd == null) { fd = fs.openSync(tailOf(T), 'r'); held.register(self, { fs, fd }, self); }
    const b = Buffer.alloc(len);
    if (fs.readSync(fd, b, 0, len, off - T) !== len) throw new RangeError(`no line at byte ${off} of ${name}`);
    return b;
  }

  // the disk's bytes from `from`, chunk by chunk (a chunk is overwritten by the next)
  function* chunks(from) {
    for (let i = partIndex(from); from < C && i < parts.length; i++) {
      while (from < parts[i].b) {
        let f;
        try { f = frameOf(fs, parts[i], from - parts[i].a); } catch (e) { broken(parts[i], e); return; }
        yield f.buf.subarray(from - parts[i].a - f.at); from = parts[i].a + f.at + f.buf.length;
      }
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

  /** seal({partBytes, frameBytes}) → whether it sealed: while the settled tail holds partBytes or more, the next part (to the first
   *  line end at or past partBytes, framed by frameBytes) is written, then the tail from the last part's end, then the old tail
   *  removed (4.3 §4 分片: killed at any point, the next open reads the same lines). */
  function seal({ partBytes = PART_BYTES, frameBytes = FRAME_BYTES } = {}) {
    if (!write || arena || trunc || junk || end - T < partBytes) return false;
    close();
    const old = tailOf(T), f = fs.openSync(old, 'r');
    let a = T, made = false;
    try {
      while (end - a >= partBytes) {
        let b = 0;
        for (let pos = a + partBytes - 1; !b && pos < end; pos += 1 << 16) { const c = readAt(fs, f, pos - T, Math.min(1 << 16, end - pos)), i = c.indexOf(10); if (i >= 0) b = pos + i + 1; }
        if (!b) break; // no line ends there (none of a settled tail)
        const raw = readAt(fs, f, a - T, b - a);
        durable(fs, partOf(a, b), framed(raw, frameBytes));
        parts.push(partAt({ path: partOf(a, b), a, b })); C = a = b; made = true;
      }
      durable(fs, tailOf(a), end > a ? readAt(fs, f, a - T, end - a) : Buffer.alloc(0));
    } finally { fs.closeSync(f); }
    T = a;
    fs.rmSync(old, { force: true });
    syncDir(fs, dir);
    return made;
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
    append, read, scan, cut, remove, seal, close,
    touch() { if (write && end) try { const t = new Date(); fs.utimesSync(tailOf(T), t, t); } catch { /* the GC order only */ } },
    loadSidecar() { const r = loadSidecar({ fs, file: side, endsLine: (n) => n <= end && read(n - 1, 1)[0] === 10 }); covers = r ? r.head.bytes : Infinity; return r; },
    saveSidecar({ head, parts: ps2 }) { covers = Infinity; saveSidecar({ fs, file: side, head, parts: ps2 }); covers = head.bytes; },
    get bytes() { return end + arena; }, get settled() { return write && !arena && !trunc; }, get unreadable() { return unreadable; },
  };
  return self;
}
