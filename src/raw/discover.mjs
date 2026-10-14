// src/raw/discover.mjs — which files ARE the source, for every reader (D35 · RFC 4.2 「读」「并存期」).
//
// The board loader, the resolver and `asight doctor` used to each decide this for themselves, and
// drifted (the scan comment in src/server.mjs, above scanRoots, explains how that once certified a capture nobody had read).
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
//    changed in place, that is reported (invariant 4). A copied tree (new inode, same size and mtime)
//    is still the source; same size with another mtime is read twice and reported (review 3 F4).
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
import { copyRelation } from './relation.mjs';
import { isCaptureFile, skipReason } from '../paths.mjs';

export const SEALED_EXT = '.sealed';
const SEG = /^(.+)\.(\d{4,})\.sealed$/;
export const isSealedPath = (p) => SEG.test(path.basename(p));
export const streamOfSealed = (name) => { const m = SEG.exec(path.basename(name)); return m ? m[1] : null; };

// The order a reader reads one directory's files in (4.2 「watermark」: a session's record sequence is
// the same before and after sealing). By stream — `streams` first, in that order, then any other
// stream by name — then by segment number, numerically (…9999, 10000), and a stream's live original
// after its segments: it holds what was written after them (`asight shard` writing a fresh
// calls.ndjson beside the sealed one). Sorting by file name read a session's sealed `other` before its
// sealed `probes`, unlike the originals (review 3 F2). Stable for files of one stream in several dirs.
export function orderInputs(files, streams = []) {
  const rank = (f) => {
    const n = path.basename(f), m = SEG.exec(n), stream = m ? m[1] : n, k = streams.indexOf(stream);
    return { k: k < 0 ? streams.length : k, stream, seg: m ? Number(m[2]) : Infinity };
  };
  const cmp = (a, b) => a.k - b.k || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0) || (a.seg === b.seg ? 0 : a.seg < b.seg ? -1 : 1);
  return files.map((f) => [f, rank(f)]).sort((x, y) => cmp(x[1], y[1])).map(([f]) => f);
}
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
  if (!st.isDirectory()) return { flat: [root], below: [], skipped: [] };
  const flat = [], below = [], skipped = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(root, e.name);
    // not `isFile()`: a symlinked capture is still a capture (test/query/source-symlink.test.mjs), and a
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

// Does the file at `o` (the same inode as the sealed original, another size) still begin with the bytes
// that were sealed — the sealed original, grown in place — or is it another file that was handed the freed
// inode (ext4 and tmpfs do that at once; APFS never does)? An inode is no file identity, a shard's bytes
// are (4.2 「并存期」): hashed here only where the stat cannot tell, and remembered — a file that is another
// file stays so while it only grows, a live calls.ndjson is not re-hashed at every poll. A read that fails
// cannot tell: it counts as the sealed original, so the report stays (never a silent loss of the warning).
const prefixCache = new Map();
function keptSealedPrefix(o, s, st, fs) {
  if (st.size < s.length) return false;                      // it cannot hold what was sealed
  const k = `${o}\0${st.ino}\0${s.sha256}`, hit = prefixCache.get(k);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.v;
  if (hit && !hit.v && st.size >= hit.size) return false;
  let v; try { v = copyRelation(s, o, { fs }).rel !== 'other'; } catch { v = true; }
  prefixCache.set(k, { size: st.size, mtimeMs: st.mtimeMs, v });
  return v;
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
      // Same inode but different size/mtime: the sealed original was changed in place afterwards —
      // both are read (never lose a byte) and that is reported, duplicates possible. Unless the file of
      // another size does not begin with the sealed bytes: then it is another file that reuses the freed
      // inode (the fresh calls.ndjson `asight shard` writes after the sealer deleted the old one, on
      // ext4) — read beside the sealed copy and, as for another inode of another size, nothing to report.
      if (st.ino === s.ino) {
        if (st.size === s.length && st.mtimeMs === s.mtimeMs) return o;
        if (st.size !== s.length && !keptSealedPrefix(o, s, st, fs)) return null;
        mismatched.push({ sealed: f, original: o, why: `the original was changed after it was sealed (${st.size === s.length ? `same size, ${st.size} bytes, other mtime` : `size ${st.size} vs ${s.length}`}) — both are read, records may appear twice` });
        return null;
      }
      // Another inode. Of another size it is another file (`asight shard` writing a fresh calls.ndjson
      // after the sealer deleted the old one): both are read, nothing to report. Of the same size and
      // mtime (within the 1 s some copy tools keep) it is this file copied or restored with its tree —
      // a backup, `cp -a`, another disk — and is used alone, or every record would be read twice
      // (review 3 F4). Same size, other mtime: cannot tell without reading it — both are read, and
      // that is reported.
      if (st.size !== s.length) return null;
      if (Math.abs(st.mtimeMs - s.mtimeMs) < 1000) return o;
      mismatched.push({ sealed: f, original: o, why: `the file at the original's path is another inode of the same size (${st.size} bytes) with another mtime — a copy that did not keep times? Both are read, records may appear twice; \`asight raw verify\` tells whether it holds the sealed bytes` });
      return null;
    });
    if (present.length && present.every(Boolean)) { drop.add(f); superseded.push({ sealed: f, original: present[0] }); }
  }
  return { files: all.filter((f) => !drop.has(f)), superseded, mismatched, drop };
}

// One directory as the board reads a session dir or `control/`: the named original streams that
// exist, plus every sealed file in it, one copy per line (coexistence), in record order (orderInputs).
// `exclude`: paths to treat as absent — `asight raw compare` reads the state after originals are
// deleted through this same function (review 3 F1).
export function dirInputs(dir, { originals = [], order = originals, fs = nodeFs, exclude = null } = {}) {
  const own = originals.map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
  let sealed = [];
  try { sealed = fs.readdirSync(dir).filter((n) => isSealedPath(n)).map((n) => path.join(dir, n)); } catch {}
  const r = resolveCoexistence([...own, ...sealed].filter((f) => !exclude || !exclude.has(f)), { fs });
  return { ...r, files: orderInputs(r.files, order) };
}

const realCache = new Map();
const realDir = (fs, d) => { if (!realCache.has(d)) { let r = null; try { r = fs.realpathSync(d); } catch {} realCache.set(d, r); } return realCache.get(d); };
function addContinuations(perRoot, sessionsRoot, fs) {
  const unattributed = [];
  const want = new Map();
  perRoot.forEach((r, k) => { try { if (fs.statSync(r.root).isDirectory()) want.set(fs.realpathSync(r.root), k); } catch {} });
  if (!want.size) return unattributed;
  let ents;
  try { ents = fs.readdirSync(sessionsRoot, { withFileTypes: true }); }
  catch (err) { if (err.code !== 'ENOENT') unattributed.push({ file: sessionsRoot, reason: `the sessions directory could not be read (${err.code}) — sealed continuations of this source in it are not read`, unreadableRecords: null }); return unattributed; }
  const have = new Set(perRoot.flatMap((r) => [...r.flat, ...r.below].map((f) => path.resolve(f))));
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(sessionsRoot, e.name);
    let names; try { names = fs.readdirSync(dir).sort(); }
    catch (err) { unattributed.push({ file: dir, reason: `a session directory that could not be read (${err.code}) — sealed continuations in it are not read`, unreadableRecords: null }); continue; }
    for (const n of names) {
      const q = path.join(dir, n);
      if (!isSealedPath(n) || have.has(path.resolve(q))) continue;
      const src = sealedSources(q, { fs });
      // unreadable: whose continuation it is cannot be told — say so rather than drop it silently
      if (!src) { unattributed.push({ file: q, reason: `${sealedSourcesError(q) || 'unreadable'} — a sealed file under the sessions directory that could not be opened, so it is unknown whether its records belong to this source`, unreadableRecords: null }); continue; }
      const k = src.length === 1 ? want.get(realDir(fs, path.dirname(src[0].abs))) : undefined;
      if (k !== undefined) perRoot[k].cont.push(q);
    }
  }
  return unattributed;
}

// Every sealed file directly in `dir` and one level down (doctor ④b: owner-only check). A directory that is
// not there is no files; one that exists and cannot be listed is `onError(dir, err)` — without an `onError`
// it is skipped as before.
export function sealedUnder(dir, { fs = nodeFs, onError = null } = {}) {
  const out = [];
  const bad = (d, e) => { if (onError && !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) onError(d, e); };
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { bad(dir, e); return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (!e.isDirectory()) { if (isSealedPath(e.name)) out.push(p); continue; }
    try { for (const n of fs.readdirSync(p)) if (isSealedPath(n)) out.push(path.join(p, n)); } catch (err) { bad(p, err); }
  }
  return out.sort();
}

// roots → { files (to read, in a stable order), perRoot, skipped, superseded, mismatched, unattributed, sig }.
// `exclude`: paths to treat as absent (`asight raw compare` reads the state after deletion this way).
export function listSources(roots, { fs = nodeFs, sessionsRoot = null, exclude = null } = {}) {
  const perRoot = roots.map((root) => ({ root, ...scanRoot(root, fs), cont: [] }));
  const unattributed = sessionsRoot ? addContinuations(perRoot, sessionsRoot, fs) : [];
  // A continuation continues one of the root's flat streams: they are ONE sequence per stream, by
  // segment, the live file last (orderInputs) — appended after every flat file, a session whose older
  // shard was sealed read its newer records first (review 3, second pass on F2).
  for (const r of perRoot) {
    r.files = [...orderInputs([...r.flat, ...r.cont]), ...r.below];
    if (exclude) r.files = r.files.filter((f) => !exclude.has(f));
  }
  const { superseded, mismatched, drop } = resolveCoexistence(perRoot.flatMap((r) => r.files), { fs });
  for (const r of perRoot) r.files = r.files.filter((f) => !drop.has(f));
  const files = perRoot.flatMap((r) => r.files);
  const sig = files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}.${Math.round(s.mtimeMs)}`; } catch { return ''; } }).join('|') || '∅dir';
  return { files, perRoot, skipped: perRoot.flatMap((r) => r.skipped), superseded, mismatched, unattributed, sig };
}
