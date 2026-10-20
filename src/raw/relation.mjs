// src/raw/relation.mjs — is a sealed copy a copy of the file now at the original's path? By content.
// Shared by `trocar raw verify` / the sealer (verify.mjs re-exports it) and by the readers' coexistence
// rule (discover.mjs), which asks it only where a stat cannot tell (same inode, other size).
import nodeFs from 'node:fs';
import { createHash } from 'node:crypto';

const CHUNK = 8 << 20;
// Is the sealed copy of source shard `src` (an entry of a sealed file's source-shard table) a copy of
// the file now at `file`? By content — a shard's identity is its bytes (4.2): the file's first
// src.length bytes must hash to src.sha256. 'same' = all of it; 'earlier' = its first bytes (it grew
// since); 'other' = another file now stands at that path, e.g. the fresh calls.ndjson `trocar shard
// --watch` writes after the sealed one's original was deleted (review 3 F3) — that copy is then the
// only home of its records, and is checked by itself. The inode only spares the hash where it cannot
// match, and an untouched file (same inode, size, mtime) is taken as 'same' here — every caller then
// compares it byte for byte. A copied tree (new inode, same bytes) is 'same' too: sealing it again
// would leave every record twice once the original is deleted.
export function copyRelation(src, file, { fs = nodeFs } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return { rel: 'gone', why: `${file} no longer exists` }; }
  if (st.size < src.length) return { rel: 'other', why: `the file now at ${file} has ${st.size} bytes, fewer than the ${src.length} that were sealed` };
  if (st.size === src.length && st.ino === src.ino && (src.dev == null || st.dev === src.dev) && st.mtimeMs === src.mtimeMs) return { rel: 'same' };
  const h = createHash('sha256'), buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, src.length)));
  const fd = fs.openSync(file, 'r');
  try { for (let pos = 0; pos < src.length;) { const n = fs.readSync(fd, buf, 0, Math.min(buf.length, src.length - pos), pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n; } }
  finally { fs.closeSync(fd); }
  if (h.digest('hex') !== src.sha256) return { rel: 'other', why: `the file now at ${file} does not begin with the ${src.length} bytes that were sealed (${st.ino === src.ino ? 'same inode, rewritten since' : 'another inode'})` };
  return st.size === src.length ? { rel: 'same' } : { rel: 'earlier', why: `${file} grew from ${src.length} to ${st.size} bytes after it was sealed; its first ${src.length} bytes are still the sealed ones` };
}
