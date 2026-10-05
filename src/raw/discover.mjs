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
//    different file at the original's path is not the source: both are read; if it is the same inode
//    changed in place, that is reported (invariant 4).
// 3. Continuations (review 2026-10-06 F2). The marker-gated sealer files a shard's records by session
//    under <sessionsRoot>/<key>/ (`asight raw seal`'s default --sessions, ~/.asight/sessions — 0.2
//    状态表 「封存文件」). Those files continue a shard that lived in some directory, so a reader that
//    serves THAT directory reads them as part of it and shows the same records after the seal as
//    before (4.6 E8). Only sealed files whose source shard's directory is a served root are taken —
//    never `asight shard` copies, which are a second copy of a stream read elsewhere. Callers opt in
//    by passing `sessionsRoot` (the CLI does; a test that wants a hermetic scan does not).
import nodeFs from 'node:fs';
import path from 'node:path';
import { readIndex } from './format.mjs';
import { isCaptureFile, skipReason } from '../paths.mjs';

export const SEALED_EXT = '.sealed';
const SEG = /^(.+)\.\d{4,}\.sealed$/;
export const isSealedPath = (p) => SEG.test(path.basename(p));
export const streamOfSealed = (name) => { const m = SEG.exec(path.basename(name)); return m ? m[1] : null; };
// A file that looks like captured bytes (a stream, a sealed file, a compressed capture) — what a reader
// that does NOT read it must report (4.2 「读」: skipped or unrecognised files are reported, never folded
// into empty). Not the sealer's own sidecars (close marker, lock, dot-temps), not anything else.
const COMPRESSED = /\.(gz|zst|bz2|xz|zip|br|lz4)$/i;
export function unreadCapture(name) {
  const n = path.basename(name);
  if (n.startsWith('.') || /\.(closed|sealing)$/.test(n)) return null;
  if (COMPRESSED.test(n) && /ndjson|capture|calls|probes|other/i.test(n)) return 'a compressed capture — not read; decompress it, or seal it, to have it shown';
  if (n.endsWith('.sealed') && !isSealedPath(n)) return 'a sealed file without a segment number — not read; give it its <stream>.<NNNN>.sealed name';
  if (/\.ndjson\./.test(n) && !isSealedPath(n)) return 'a capture stream under another name — not read';
  return null;
}

// The source-shard table of a sealed file, cached by (size, mtime, inode). null if unreadable — the
// file then stays in the list, so the reader that opens it fails loudly instead of skipping it.
const tableCache = new Map();
export function sealedSources(file, { fs = nodeFs } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const k = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const hit = tableCache.get(file);
  if (hit && hit.k === k) return hit.v;
  let v = null, err = null, fd;
  try {
    fd = fs.openSync(file, 'r');
    const { tables } = readIndex(fs, fd, st.size, path.basename(file));
    v = tables.shards.map((s) => ({ ...s, abs: path.resolve(path.dirname(file), s.path || s.name) }));
  } catch (e) { v = null; err = e.message; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  tableCache.set(file, { k, v, err });
  return v;
}
// Why sealedSources(file) last returned null (for a report), or null.
export const sealedSourcesError = (file) => (tableCache.get(file) || {}).err || null;

// a regular file, or a symlink to one
const fileLike = (fs, dir, e) => e.isFile() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isFile(); } catch { return false; } })());

function scanRoot(root, fs) {
  const st = fs.statSync(root);                        // missing root throws: broken MUST NOT look empty
  if (!st.isDirectory()) return { files: [root], skipped: [] };
  const files = [], skipped = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(root, e.name);
    // not `isFile()`: a symlinked capture is still a capture (test/query/source-symlink.test.mjs), and a
    // link to nothing, or to a directory, is not one — it is listed with its reason instead of being
    // opened (src/paths.mjs isCaptureFile / skipReason, the classifier read-cc-line gave the readers).
    if (!e.isDirectory()) {
      if (isCaptureFile(root, e) || (isSealedPath(e.name) && fileLike(fs, root, e))) files.push(p);
      else {
        // reason + attention (may it hold capture bytes?), and a `report` when the name looks like a
        // capture the readers must name (unreadCapture)
        const why = unreadCapture(e.name);
        skipped.push({ name: e.name, file: p, ...skipReason(root, e), ...(why ? { report: why } : {}) });
      }
      continue;
    }
    const dirSkip = { name: e.name, reason: 'directory', attention: e.name.endsWith('.ndjson') };
    let sub; try { sub = fs.readdirSync(p, { withFileTypes: true }); } catch { skipped.push(dirSkip); continue; }
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
    if (!took) skipped.push(dirSkip);
  }
  return { files, skipped };
}

// Coexistence over an explicit list of files (a session dir, the control dir, or a whole scan): drop
// sealed files superseded by an original that is IN THIS LIST and still the very file that was sealed.
export function resolveCoexistence(all, { fs = nodeFs } = {}) {
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
      // Same inode but different size/mtime: the sealed original was changed in place afterwards —
      // both are read (never lose a byte) and that is reported, duplicates possible. A different
      // inode is simply another file at that path (e.g. `asight shard` writing a fresh calls.ndjson
      // after the sealer deleted the old one): both are read, nothing to report. (ext4 may reuse a
      // freed inode, which then shows up as a report — noise, never a loss.)
      if (!same && st.ino === s.ino) mismatched.push({ sealed: f, original: o, why: `the original was changed after it was sealed (size ${st.size} vs ${s.length}) — both are read, records may appear twice` });
      return same ? o : null;
    });
    if (present.length && present.every(Boolean)) { drop.add(f); superseded.push({ sealed: f, original: present[0] }); }
  }
  return { files: all.filter((f) => !drop.has(f)), superseded, mismatched, drop };
}

const realCache = new Map();
const realDir = (fs, d) => { if (!realCache.has(d)) { let r = null; try { r = fs.realpathSync(d); } catch {} realCache.set(d, r); } return realCache.get(d); };
function addContinuations(perRoot, sessionsRoot, fs) {
  const unattributed = [];
  const want = new Map();
  perRoot.forEach((r, k) => { try { if (fs.statSync(r.root).isDirectory()) want.set(fs.realpathSync(r.root), k); } catch {} });
  if (!want.size) return unattributed;
  let ents; try { ents = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return unattributed; }
  const have = new Set(perRoot.flatMap((r) => r.files.map((f) => path.resolve(f))));
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(sessionsRoot, e.name);
    let names; try { names = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const n of names) {
      const q = path.join(dir, n);
      if (!isSealedPath(n) || have.has(path.resolve(q))) continue;
      const src = sealedSources(q, { fs });
      // unreadable: whose continuation it is cannot be told — say so rather than drop it silently
      if (!src) { unattributed.push({ file: q, reason: `${sealedSourcesError(q) || 'unreadable'} — a sealed file under the sessions directory that could not be opened, so it is unknown whether its records belong to this source`, unreadableRecords: null }); continue; }
      const k = src.length === 1 ? want.get(realDir(fs, path.dirname(src[0].abs))) : undefined;
      if (k !== undefined) perRoot[k].files.push(q);
    }
  }
  return unattributed;
}

// Every sealed file directly in `dir` and one level down (doctor ④b: owner-only check).
export function sealedUnder(dir, { fs = nodeFs } = {}) {
  const out = [];
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (!e.isDirectory()) { if (isSealedPath(e.name)) out.push(p); continue; }
    try { for (const n of fs.readdirSync(p)) if (isSealedPath(n)) out.push(path.join(p, n)); } catch {}
  }
  return out.sort();
}

// roots → { files (to read, in a stable order), perRoot, skipped, superseded, mismatched, unattributed, sig }.
export function listSources(roots, { fs = nodeFs, sessionsRoot = null } = {}) {
  const perRoot = roots.map((root) => ({ root, ...scanRoot(root, fs) }));
  const unattributed = sessionsRoot ? addContinuations(perRoot, sessionsRoot, fs) : [];
  const { superseded, mismatched, drop } = resolveCoexistence(perRoot.flatMap((r) => r.files), { fs });
  for (const r of perRoot) r.files = r.files.filter((f) => !drop.has(f));
  const files = perRoot.flatMap((r) => r.files);
  const sig = files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}.${Math.round(s.mtimeMs)}`; } catch { return ''; } }).join('|') || '∅dir';
  return { files, perRoot, skipped: perRoot.flatMap((r) => r.skipped), superseded, mismatched, unattributed, sig };
}
