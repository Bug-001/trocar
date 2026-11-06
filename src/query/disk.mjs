// src/query/disk.mjs — what ~/.trocar takes on disk (RFC 3.5 「保存什么」行, 4.4 /api/retention, 2.6 §D 页脚). It is about FILES, so it comes
// from the file system and nothing else:
//   diskUsage()  walks the home with lstat — only sizes, never a file's content — and adds them up by what the file is. A
//                top-level folder of the home that is a symbolic link (raw/ moved to another disk) is followed, each directory
//                once by (dev, ino); a link it cannot follow is `unreadable`; deeper links count as the link. Live: no cache.
// What cannot be read is returned (`unreadable`), so a total that is short says it is short (invariant 4).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { trocarHome } from '../paths.mjs';

const DISK_GROUPS = Object.freeze(['records', 'sealed', 'index', 'logs', 'other']);

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
 * diskUsage({home, fs}) → {home, source:'lstat', generated_at, files, total_bytes, groups:{<group>:{files, bytes}}, unreadable:[{path, error}]}
 * total_bytes = the sum of the file sizes found; when `unreadable` is not empty it is a floor, and the caller says so.
 */
export async function diskUsage({ home = trocarHome(), fs = fsp, now = Date.now } = {}) {
  const groups = Object.fromEntries(DISK_GROUPS.map((g) => [g, { files: 0, bytes: 0 }]));
  const unreadable = [];
  let files = 0, total = 0;
  const seen = new Set(); // `${dev}:${ino}` of every directory walked: a link back into the home, or two links to one folder, walk it once
  async function walk(dir, rel) {
    try { const st = await fs.stat(dir), id = `${st.dev}:${st.ino}`; if (seen.has(id)) return; seen.add(id); } catch { /* readdir says why */ }
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) {
      if (!(e && e.code === 'ENOENT' && rel === '')) unreadable.push({ path: dir, error: String((e && e.message) || e) });
      return;
    }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name), r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { await walk(abs, r); continue; } // Dirent from readdir does not follow a link
      if (rel === '' && ent.isSymbolicLink()) { // only the home's own top-level entries are followed
        let st;
        try { st = await fs.stat(abs); } catch (e) { unreadable.push({ path: abs, error: String((e && e.message) || e) }); continue; }
        if (st.isDirectory()) { await walk(abs, r); continue; }
      }
      let st;
      try { st = await fs.lstat(abs); } catch (e) { unreadable.push({ path: abs, error: String((e && e.message) || e) }); continue; }
      const g = groupOf(r);
      groups[g].files++; groups[g].bytes += st.size; files++; total += st.size;
    }
  }
  await walk(home, '');
  return { home, source: 'lstat', generated_at: new Date(now()).toISOString(), files, total_bytes: total, groups, unreadable };
}

