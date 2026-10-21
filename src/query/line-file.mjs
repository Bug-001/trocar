// src/query/line-file.mjs — an append-only file of newline-ended lines, read back by byte offset (RFC 4.3 §4 上下文投影 写者). The
// projection store (src/query/projection.mjs) and the fold log keep where each line is and read it back when asked, so their heap
// does not grow with what they hold.
//   The lines past the file's end live in an off-heap ARENA (Buffers: external memory, not the V8 heap): `write: false` (the local
// path, which writes nothing) appends every line there; `write: true` appends to the file, and a write that fails keeps the text in
// the arena (`onFail(error)` once per episode of failures) and writes it with the next append that works. The arena starts at the
// file's end, so an offset handed out never changes. One descriptor for reads, closed by close() or, failing that, when the
// line file is collected.
import nodeFs from 'node:fs';
import path from 'node:path';

const held = new FinalizationRegistry(({ fs, fd }) => { try { fs.closeSync(fd); } catch { /* already closed */ } });

/** lineFile({fs, file, write, onFail}) → {append(text) → the offset of its first byte, read(off, len) → Buffer, bytes, cut(len),
 *  close()}. `bytes`: the end (the file's bytes that count, then the arena's). `cut(len)` (len ≤ the file's end): what lies past
 *  `len` is no longer there (a torn tail, a file rebuilt); with `write` the file is truncated to it before the next write. */
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

  const self = { append, read, cut, close, get bytes() { return end + arena; } };
  return self;
}
