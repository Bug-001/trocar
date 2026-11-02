// src/raw/discover.mjs — which files under a root are capture files, for `trocar doctor` (listSources) and
// the record reader (isSealedPath, src/raw/ingest.mjs) (D35 · RFC 4.2 「读」「并存期」).
//
// 1. Where. A root is scanned flat (every `*.ndjson`, every `*.sealed`) plus exactly one level down,
//    where only `calls.ndjson` is read. A sealed file one level down is read iff it stands where its
//    stream would have been read: a sealed `calls.ndjson`, or a per-session file whose source shard
//    lived somewhere else (D35 ⑦).
// 2. Coexistence (并存期). While an original and sealed copies of it both exist — a crash between
//    rename and unlink — only the original is listed, if it is still the very file that was sealed (same
//    inode, size and mtime; or a copied tree: another inode, same size, mtime within 1 s). The sealed
//    copies are then "superseded": doctor checks them for credentials too. Any other file at the
//    original's path is not the source, and both are listed.
import nodeFs from 'node:fs';
import path from 'node:path';
import { readIndex } from './format.mjs';
import { isCaptureFile, skipReason } from '../paths.mjs';
import { parseSegment } from '../collector/core/record/segments.mjs';

// One sealed name: the raw layer's `<segment>.sealed` (D60 ①②, the only shape the daemon writes). The older
// `<stream>.<NNNN>.sealed` of the per-shard sealer is an older location — neither read nor touched (D60 ②).
const sealedSegment = (n) => { const s = parseSegment(n); return s && s.sealed ? s.segment : null; };
export const isSealedPath = (p) => !!sealedSegment(path.basename(p));
// the segment's plaintext name: what the sealed file's source-segment table holds
const streamOfSealed = (name) => { const seg = sealedSegment(path.basename(name)); return seg ? `${seg}.ndjson` : null; };

// The order a reader reads one directory's files in (4.2 「watermark」: a session's record sequence is
// the same before and after sealing). By stream — `streams` first, in that order, then any other
// stream by name — then by segment number, numerically (…9999, 10000), and a stream's live original
// after its segments: it holds what was written after them (`trocar shard` writing a fresh
// calls.ndjson beside the sealed one). Sorting by file name read a session's sealed `other` before its
// sealed `probes`, unlike the originals (review 3 F2). Stable for files of one stream in several dirs.
function orderInputs(files, streams = []) {
  const rank = (f) => {
    const n = path.basename(f), stream = streamOfSealed(n) || n, k = streams.indexOf(stream);
    return { k: k < 0 ? streams.length : k, stream };
  };
  const cmp = (a, b) => a.k - b.k || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0);
  return files.map((f) => [f, rank(f)]).sort((x, y) => cmp(x[1], y[1])).map(([f]) => f);
}
// A file that looks like captured bytes (a stream, a sealed file, a compressed capture) — what a reader
// that does NOT read it must report (4.2 「读」: skipped or unrecognised files are reported, never folded
// into empty). Not the sealer's own sidecars (close marker, lock, dot-temps), not anything else.
const COMPRESSED = /\.(gz|zst|bz2|xz|zip|br|lz4)$/i;
function unreadCapture(name) {
  const n = path.basename(name);
  if (n.startsWith('.') || /\.(closed|sealing)$/.test(n)) return null;
  if (COMPRESSED.test(n) && /ndjson|capture|calls|probes|other/i.test(n)) return 'a compressed capture — not read; decompress it, or seal it, to have it shown';
  if (n.endsWith('.sealed') && !isSealedPath(n)) return 'a sealed file whose name is not a segment — not read; give it its <segment>.sealed name';
  if (/\.ndjson\./.test(n) && !isSealedPath(n)) return 'a capture stream under another name — not read';
  return null;
}

// The source-shard table of a sealed file, cached by (size, mtime, inode). null if unreadable — the
// file then stays in the list, so the reader that opens it fails loudly instead of skipping it.
const tableCache = new Map();
function sealedSources(file, { fs = nodeFs } = {}) {
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

// a regular file, or a symlink to one
const fileLike = (fs, dir, e) => e.isFile() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isFile(); } catch { return false; } })());

function scanRoot(root, fs) {
  const st = fs.statSync(root);                        // missing root throws: broken MUST NOT look empty
  if (!st.isDirectory()) return { flat: [root], below: [], skipped: [] };
  const flat = [], below = [], skipped = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(root, e.name);
    // not `isFile()`: a symlinked capture is still a capture, and a
    // link to nothing, or to a directory, is not one — it is listed with its reason instead of being
    // opened (src/paths.mjs isCaptureFile / skipReason, the classifier read-cc-line gave the readers).
    if (!e.isDirectory()) {
      if (isCaptureFile(root, e) || (isSealedPath(e.name) && fileLike(fs, root, e))) flat.push(p);
      else {
        // reason + attention (may it hold capture bytes?), and a `report` when the name looks like a
        // capture the readers must name (unreadCapture)
        // A sealed name that is not a file (a dangling link, a link to a directory) may stand for capture
        // bytes too: read-cc-line's classifier keys `attention` on *.ndjson only, so it is set here, and
        // named in the report — else it raised nothing at all.
        const sealedName = isSealedPath(e.name);
        const why = unreadCapture(e.name) || (sealedName ? 'a sealed file that is not a regular file (a dangling link, or a link to a directory) — not read' : null);
        skipped.push({ name: e.name, file: p, ...skipReason(root, e), ...(sealedName ? { attention: true } : {}), ...(why ? { report: why } : {}) });
      }
      continue;
    }
    const dirSkip = { name: e.name, reason: 'directory', attention: e.name.endsWith('.ndjson') };
    // a directory that cannot be read is NOT a harmless non-capture directory (D38 S-3): reported
    let sub; try { sub = fs.readdirSync(p, { withFileTypes: true }); }
    catch (err) { skipped.push({ name: e.name, file: p, reason: 'unreadable', error: err.code, attention: true, report: `a directory that could not be read (${err.code}) — nothing in it is read` }); continue; }
    const took = [];
    for (const s of sub.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (s.isDirectory()) continue;
      const q = path.join(p, s.name);
      if (s.name === 'calls.ndjson') { took.push(q); continue; }
      if (!isSealedPath(s.name)) continue;
      const src = sealedSources(q, { fs });
      const sameDir = src && src.every((x) => path.dirname(x.abs) === path.resolve(p));   // resolved: a relative root too
      if (!src || !sameDir || streamOfSealed(s.name) === 'calls.ndjson') took.push(q);
    }
    if (!took.length) skipped.push(dirSkip);
    else below.push(...orderInputs(took, ['calls.ndjson']));
  }
  return { flat, below, skipped };   // listSources orders flat files together with their continuations
}

// Coexistence over the listed files: drop
// sealed files superseded by an original that is IN THIS LIST and still the very file that was sealed.
function resolveCoexistence(all, { fs = nodeFs } = {}) {
  const originals = new Map();
  for (const f of all) if (!isSealedPath(f)) originals.set(path.resolve(f), f);
  const superseded = [], drop = new Set();
  for (const f of all) {
    if (!isSealedPath(f)) continue;
    const src = sealedSources(f, { fs });
    if (!src) continue;
    // the original, when it is still the file that was sealed: the same inode, size and mtime, or a copy of it
    // with its tree (another inode, same size, mtime within the 1 s some copy tools keep: review 3 F4)
    const present = src.map((s) => {
      const o = originals.get(s.abs);
      let st; try { st = o && fs.statSync(o); } catch { return null; }
      if (!st || st.size !== s.length) return null;
      return (st.ino === s.ino ? st.mtimeMs === s.mtimeMs : Math.abs(st.mtimeMs - s.mtimeMs) < 1000) ? o : null;
    });
    if (present.length && present.every(Boolean)) { drop.add(f); superseded.push({ sealed: f, original: present[0] }); }
  }
  return { superseded, drop };
}

// roots → { files (to read, in a stable order), perRoot, skipped, superseded, sig }.
export function listSources(roots, { fs = nodeFs } = {}) {
  const perRoot = roots.map((root) => ({ root, ...scanRoot(root, fs) }));
  for (const r of perRoot) r.files = [...orderInputs(r.flat), ...r.below];
  const { superseded, drop } = resolveCoexistence(perRoot.flatMap((r) => r.files), { fs });
  for (const r of perRoot) r.files = r.files.filter((f) => !drop.has(f));
  const files = perRoot.flatMap((r) => r.files);
  const sig = files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}.${Math.round(s.mtimeMs)}`; } catch { return ''; } }).join('|') || '∅dir';
  return { files, perRoot, skipped: perRoot.flatMap((r) => r.skipped), superseded, sig };
}
