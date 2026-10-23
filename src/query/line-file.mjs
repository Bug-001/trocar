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

export const SIDECAR_V = 1;
const TYPES = { f64: Float64Array, u32: Uint32Array, i32: Int32Array, u8: Uint8Array };
export const sidecarOf = (file) => file.replace(/\.ndjson$/, '') + '.idx';

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

/** loadSidecar({fs, file}) → {head, parts: {name: array}} | null: missing, unreadable, of another version, short or long, or covering
 *  more than `file` holds or not ending at a line's end. */
export function loadSidecar({ fs = nodeFs, file }) {
  try {
    const b = fs.readFileSync(sidecarOf(file)), nl = b.indexOf(10);
    if (nl < 0) return null;
    const { v, parts: desc, ...head } = JSON.parse(b.toString('utf8', 0, nl));
    if (v !== SIDECAR_V || !Array.isArray(desc) || !Number.isSafeInteger(head.bytes) || head.bytes < 1) return null;
    const parts = {};
    let at = nl + 1;
    for (const [name, type, n] of desc) {
      if (!Number.isSafeInteger(n) || n < 0 || at + n > b.length || (type !== 'str' && (!TYPES[type] || n % TYPES[type].BYTES_PER_ELEMENT))) return null;
      parts[name] = type === 'str' ? strings(b, at, at + n) : new TYPES[type](b.buffer.slice(b.byteOffset + at, b.byteOffset + at + n));
      at += n;
    }
    if (at !== b.length) return null;
    const fd = fs.openSync(file, 'r'), last = Buffer.alloc(1);
    try { if (fs.readSync(fd, last, 0, 1, head.bytes - 1) !== 1 || last[0] !== 10) return null; } finally { fs.closeSync(fd); }
    return { head, parts };
  } catch { return null; }
}

const held = new FinalizationRegistry(({ fs, fd }) => { try { fs.closeSync(fd); } catch { /* already closed */ } });

/** lineFile({fs, file, write, onFail}) → {append(text) → the offset of its first byte, read(off, len) → Buffer, bytes, settled,
 *  cut(len), close()}. `settled`: written, every byte in the file (no arena, nothing to cut): a sidecar may be saved.
 *  `bytes`: the end (the file's bytes that count, then the arena's). `cut(len)` (len ≤ the file's end): what lies past `len` is no
 *  longer there (a torn tail, a file rebuilt); with `write` the file is truncated to it before the next write. */
export function lineFile({ fs = nodeFs, file, write = true, onFail = () => {} } = {}) {
  let end = 0; // the file's bytes that count: the arena starts here
  try { end = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let trunc = false; // the file may hold bytes past `end` (a torn tail, a write that failed halfway): cut before the next write
  let starts = [], bufs = [], arena = 0; // the arena: each append's text, by the offset of its first byte
  let failing = false, fd = null;

  function append(text) {
    const at = end + arena, buf = Buffer.from(text, 'utf8');
    if (write) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (trunc || !end) fs.rmSync(sidecarOf(file), { force: true }); // what it covers is no longer there
        if (trunc) { try { fs.truncateSync(file, end); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
        trunc = true; // until the append is known whole
        const out = arena ? Buffer.concat([...bufs, buf]) : buf;
        fs.appendFileSync(file, out, { mode: 0o600 });
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
      if (!b || from + len > b.length) throw new RangeError(`no line at byte ${off} of ${path.basename(file)}`);
      return b.subarray(from, from + len);
    }
    if (fd == null) { fd = fs.openSync(file, 'r'); held.register(self, { fs, fd }, self); }
    const b = Buffer.alloc(len);
    if (fs.readSync(fd, b, 0, len, off) !== len) throw new RangeError(`no line at byte ${off} of ${path.basename(file)}`);
    return b;
  }

  function cut(len) {
    if (len >= end) return;
    starts = []; bufs = []; arena = 0; end = len; trunc = write;
  }

  function close() {
    if (fd == null) return;
    held.unregister(self);
    try { fs.closeSync(fd); } finally { fd = null; }
  }

  const self = { append, read, cut, close, get bytes() { return end + arena; }, get settled() { return write && !arena && !trunc; } };
  return self;
}
