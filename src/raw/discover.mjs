// src/raw/discover.mjs — which files ARE the source, for every reader (D35 · RFC 4.2 「读」「并存期」).
//
// The board loader, the resolver and `asight doctor` used to each decide this for themselves, and
// drifted (src/server.mjs::sourceFiles explains how that once certified a capture nobody had read).
// D35 adds sealed files, and with them the one rule that MUST be the same for all three readers:
//
// 1. Where. A root is scanned flat (every `*.ndjson`, every `*.sealed`) plus exactly one level down,
//    where only `calls.ndjson` was ever read (src/server.mjs, test/server-shard-source.test.mjs). A
//    sealed file one level down is read iff it stands where its stream would have been read: a sealed
//    `calls.ndjson`, or a per-session file whose source shard lived somewhere else (D35 ⑦).
// 2. Coexistence (并存期). While an original and sealed copies of it both exist — a crash between
//    rename and unlink, or a legacy seal that kept the original — a reader uses only ONE: the original,
//    if this reader scans it and it is still the very file that was sealed (size, inode, mtime). The
//    sealed copies are then "superseded" and skipped, so no record is read twice and none is lost. A
//    different file at the original's path (rotated, rewritten) is not the source: both are read, and
//    the mismatch is reported (invariant 4).
import nodeFs from 'node:fs';
import path from 'node:path';
import { readIndex } from './format.mjs';

export const SEALED_EXT = '.sealed';
const SEG = /^(.+)\.\d{4,}\.sealed$/;
export const isSealedPath = (p) => SEG.test(path.basename(p));
export const streamOfSealed = (name) => { const m = SEG.exec(path.basename(name)); return m ? m[1] : null; };

// The source-shard table of a sealed file, cached by (size, mtime, inode). null if unreadable — the
// file then stays in the list, so the reader that opens it fails loudly instead of skipping it.
const tableCache = new Map();
export function sealedSources(file, { fs = nodeFs } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const k = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const hit = tableCache.get(file);
  if (hit && hit.k === k) return hit.v;
  let v = null, fd;
  try {
    fd = fs.openSync(file, 'r');
    const { tables } = readIndex(fs, fd, st.size, path.basename(file));
    v = tables.shards.map((s) => ({ ...s, abs: path.resolve(path.dirname(file), s.path || s.name) }));
  } catch { v = null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  tableCache.set(file, { k, v });
  return v;
}

function scanRoot(root, fs) {
  const st = fs.statSync(root);                        // missing root throws: broken MUST NOT look empty
  if (!st.isDirectory()) return { files: [root], skipped: [] };
  const files = [], skipped = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(root, e.name);
    // not `isFile()`: a symlinked capture is still a capture (test/query/source-symlink.test.mjs)
    if (!e.isDirectory()) {
      if (e.name.endsWith('.ndjson') || isSealedPath(e.name)) files.push(p);
      else skipped.push({ name: e.name, reason: /\.(gz|zst|bz2|xz|zip|br|lz4)$/i.test(e.name) ? 'compressed' : 'not-ndjson' });
      continue;
    }
    let sub; try { sub = fs.readdirSync(p, { withFileTypes: true }); } catch { skipped.push({ name: e.name, reason: 'directory' }); continue; }
    let took = false;
    for (const s of sub.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (s.isDirectory()) continue;
      const q = path.join(p, s.name);
      if (s.name === 'calls.ndjson') { files.push(q); took = true; continue; }
      if (!isSealedPath(s.name)) continue;
      const src = sealedSources(q, { fs });
      const sameDir = src && src.every((x) => path.dirname(x.abs) === p);
      if (!src || !sameDir || streamOfSealed(s.name) === 'calls.ndjson') { files.push(q); took = true; }
    }
    if (!took) skipped.push({ name: e.name, reason: 'directory' });
  }
  return { files, skipped };
}

// roots → { files (to read, in a stable order), perRoot, skipped, superseded, mismatched, sig }.
export function listSources(roots, { fs = nodeFs } = {}) {
  const perRoot = roots.map((root) => ({ root, ...scanRoot(root, fs) }));
  const all = perRoot.flatMap((r) => r.files);
  const originals = new Map();
  for (const f of all) if (!isSealedPath(f)) originals.set(path.resolve(f), f);
  const superseded = [], mismatched = [], drop = new Set();
  for (const f of all) {
    if (!isSealedPath(f)) continue;
    const src = sealedSources(f, { fs });
    if (!src) continue;
    const present = src.map((s) => {
      const o = originals.get(s.abs);
      if (!o) return null;
      let st; try { st = fs.statSync(o); } catch { return null; }
      const same = st.size === s.length && st.ino === s.ino && st.mtimeMs === s.mtimeMs;
      if (!same) mismatched.push({ sealed: f, original: o, why: `the file at the original path is not the one that was sealed (size ${st.size} vs ${s.length})` });
      return same ? o : null;
    });
    if (present.length && present.every(Boolean)) { drop.add(f); superseded.push({ sealed: f, original: present[0] }); }
  }
  for (const r of perRoot) r.files = r.files.filter((f) => !drop.has(f));
  const files = perRoot.flatMap((r) => r.files);
  const sig = files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}.${Math.round(s.mtimeMs)}`; } catch { return ''; } }).join('|') || '∅dir';
  return { files, perRoot, skipped: perRoot.flatMap((r) => r.skipped), superseded, mismatched, sig };
}
