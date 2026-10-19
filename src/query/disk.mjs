// src/query/disk.mjs — what ~/.asight takes on disk, and how well the sealed files compress (RFC 3.5 「保存什么」行, 4.4
// /api/retention, 2.6 §D 页脚). Both are about FILES, so they come from the file system and nothing else:
//   diskUsage()  walks the home with lstat — only sizes, never a file's content, never through a symbolic link (a link counts as
//                the link) — and adds them up by what the file is. Live: no cache, whatever is on the disk now.
//   sealStats()  the sealed files' own index tails say how long each record's line was before sealing (record length, the same
//                number the sealer checked); the sum of those over the sealed files' sizes is the overall seal ratio the size
//                view uses to ESTIMATE what a class would take once sealed. A file whose index cannot be read is listed with
//                the reason and left out of the ratio — never counted as 0 bytes. An index is read once per (size, mtime, inode).
// What cannot be read is returned (`unreadable`), so a total that is short says it is short (invariant 4).
import fsp from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import { asightHome } from '../paths.mjs';
import { readIndex, R } from '../raw/format.mjs';

export const DISK_GROUPS = Object.freeze(['records', 'sealed', 'index', 'logs', 'other']);

// What a file under the home is, by where it lies and what it is called (first rule that fits) — today's layout
// (4.2 §目录): raw/<segment>.ndjson the captured records, raw/<segment>.sealed their sealed copies, index/ the
// rebuildable segment index, and the journals and event logs. No rule names one file of one product.
export function groupOf(rel) {
  if (rel.startsWith('logs/') || /(^|\/)flows\//.test(rel) || /(^|\/)journal\.jsonl$/.test(rel)) return 'logs'; // events, the raw journal, the change log
  if (/\.sealed$/.test(rel)) return 'sealed';
  if (/\.ndjson$/.test(rel)) return 'records';
  if (rel.startsWith('index/')) return 'index';
  return 'other';
}

/**
 * diskUsage({home, fs}) → {home, source:'lstat', generated_at, files, total_bytes, groups:{<group>:{files, bytes}}, unreadable:[{path, error}], sealed_paths:[…]}
 * total_bytes = the sum of the file sizes found; when `unreadable` is not empty it is a floor, and the caller says so.
 */
export async function diskUsage({ home = asightHome(), fs = fsp, now = Date.now } = {}) {
  const groups = Object.fromEntries(DISK_GROUPS.map((g) => [g, { files: 0, bytes: 0 }]));
  const unreadable = [], sealedPaths = [];
  let files = 0, total = 0;
  async function walk(dir, rel) {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) {
      if (!(e && e.code === 'ENOENT' && rel === '')) unreadable.push({ path: dir, error: String((e && e.message) || e) });
      return;
    }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name), r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { await walk(abs, r); continue; } // a directory is never a link here: Dirent from readdir does not follow
      let st;
      try { st = await fs.lstat(abs); } catch (e) { unreadable.push({ path: abs, error: String((e && e.message) || e) }); continue; }
      const g = groupOf(r);
      groups[g].files++; groups[g].bytes += st.size; files++; total += st.size;
      if (g === 'sealed' && st.isFile()) sealedPaths.push({ path: abs, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    }
  }
  await walk(home, '');
  return { home, source: 'lstat', generated_at: new Date(now()).toISOString(), files, total_bytes: total, groups, unreadable, sealed_paths: sealedPaths };
}

const indexCache = new Map(); // path → {sig, original, error}
/**
 * sealStats(sealedPaths) → {files, original_bytes, sealed_bytes, ratio, unreadable:[{path, error}]}
 * ratio = sealed_bytes / original_bytes over the files whose index could be read, or null when none could (no sealed file, or none readable).
 */
export async function sealStats(sealedPaths = [], { fs = nodeFs } = {}) {
  let original = 0, sealed = 0, files = 0;
  const unreadable = [];
  for (const f of sealedPaths) {
    const sig = `${f.size}:${f.mtimeMs}:${f.ino}`;
    let hit = indexCache.get(f.path);
    if (!hit || hit.sig !== sig) {
      hit = { sig };
      try {
        const fd = fs.openSync(f.path, 'r');
        try { hit.original = readIndex(fs, fd, f.size, path.basename(f.path)).tables.records.reduce((n, rec) => n + (Number(rec[R.len]) || 0), 0); } finally { fs.closeSync(fd); }
      } catch (e) { hit.error = String((e && e.message) || e); }
      indexCache.set(f.path, hit);
      await new Promise((r) => setImmediate(r)); // a home with many sealed files must not hold the server's loop for the whole pass
    }
    if (hit.error) { unreadable.push({ path: f.path, error: hit.error }); continue; }
    files++; original += hit.original; sealed += f.size;
  }
  return { files, original_bytes: original, sealed_bytes: sealed, ratio: original > 0 ? sealed / original : null, unreadable };
}
