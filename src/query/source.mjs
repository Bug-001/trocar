// src/query/source.mjs — resolve a block's text_ref back to its VERBATIM bytes in the
// source NDJSON. The derived store holds NO fulltext (invariant 2: only a pointer); the
// verbatim truth lives in the source, so faithful replay (AC-1) reads back from it here.
//
// MEMORY (RFC 4.4:88 · D24(i)): we DO NOT load every record's req_body into RAM (that was
// O(total source bytes) ≈ O(N²) resident for an append-only quadratic trace). Instead we build a
// lean `recordId → {file, offset, length}` byte-offset index (a byte-scan that never retains a
// body), then on resolve we seek+read only the ONE needed record's line and slice it. A tiny
// req_body LRU makes rendering a call's many blocks read that call's line once, not per block.
//
// SEALED FILES (D35 · RFC 4.2 「读」): the same index also holds records that live in sealed files —
// keyed by the record's ORIGINAL stream from the sealed index, so a text_ref minted before sealing
// resolves to the same bytes after it, and DuckDB is never rebuilt. Their lines are decoded through one
// bounded frame LRU shared by every sealed file (~8 frames), and every line's sha256 is checked.
// Which files are read at all — and which copy wins while an original and its sealed copy coexist — is
// src/raw/discover.mjs, the one rule the board loader and doctor use too (its top-level classification
// is src/paths.mjs isCaptureFile / skipReason: a symlinked capture counts, a dangling link is reported).
import { open } from 'node:fs/promises';
import { statSync, openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseTextRef } from '../raw/refs.mjs';
import { TEXT_REF_FIELD, fieldTextOf } from '../dissect/record-fields.mjs';
import { normalizeRecord } from '../raw/ingest.mjs';
import { expandRequestBody, requestEncodingOf } from '../dissect/request-body.mjs';
import { listSources, isSealedPath } from '../raw/discover.mjs';
import { openSealed, createFrameCache } from '../raw/reader.mjs';
import { R, FLAG_NL, FLAG_UNPARSEABLE } from '../raw/format.mjs';

const NL = 0x0a;
const BODY_LRU = 8; // req_body strings held at once — a call's blocks resolve off one cached body

// ── record-id collisions across files (invariant 2) ───────────────────────
// A record id is unique only WITHIN one capture file — every harness mints req_00001, req_00002…
// So a DIRECTORY source indexing on the bare id let the last-scanned file silently overwrite the
// earlier one, and the "回源 verbatim bytes" panel then served the WRONG file's body while
// labelling it the verbatim source truth. For a byte-faithfulness tool that is the worst possible
// failure: not a missing answer, a confidently wrong one.
//
// So the index is keyed on the QUALIFIED reference — `<streamBasename>#<recordId>` — which is
// exactly what mintRawRef already encodes in every text_ref. A bare-id map is kept ONLY as a
// back-compat fallback for refs minted with a placeholder stream name, and it remembers
// ambiguity: if the id exists in more than one file and the ref does not say which, we THROW
// rather than guess. Loud beats plausible.
const AMBIGUOUS = Symbol('ambiguous-record-id');
// rawRef = `<sessionId>/<streamBasename>#<recordId>` → the stream component.
const streamOfRawRef = (rawRef) => rawRef.slice(rawRef.indexOf('/') + 1, rawRef.lastIndexOf('#'));

// ── fidelity of the bytes we hand back (invariant 4 保真边界写明) ──────────
// NOT every record we can resolve is byte-faithful. `normalizeRecord` (src/raw/ingest.mjs:14)
// has two branches:
//   · D10 — `req_body` is the VERBATIM captured request string → the bytes that went on the wire.
//   · demo v0 — the capture stored the request as PARSED JSON, so the body is rebuilt with
//     JSON.stringify. Whitespace, key order, duplicate keys, number formatting and unicode
//     escaping can all differ from the wire. It is a RE-SERIALIZATION, not the wire bytes.
// Both used to come back as bare strings, so the "回源 verbatim bytes" panel labelled the
// re-serialized ones verbatim too — presenting a reconstruction as the source truth, which is
// exactly the promise this tool exists to keep. So classify, and let every consumer label it.
// This is a CLASSIFIER only: it mirrors normalizeRecord's branches, it never rewrites anything.
export function classifyFidelity(raw) {
  // D10: the captured wire string — or, when the wire carried it compressed, its exact decompressed text (4.6 §记录)
  if (typeof raw.req_body === 'string') return requestEncodingOf(raw) ? 'decoded' : 'verbatim';
  if (raw.request === undefined) return null;                // not an llm record — no body at all
  if (raw.request === null) return 'reserialized';           // '' stand-in, synthesized not captured
  if (typeof raw.request === 'string') return 'verbatim';    // v0 stored raw text → passed through
  return 'reserialized';                                     // v0 parsed JSON → JSON.stringify(…)
}

// ── outcomes ───────────────────────────────────────────────────────────────
// "no such record", "the record's bytes are damaged" and "the record carries no body" used to
// collapse into a single `null`, so the caller of the SOURCE-TRUTH resolver — the one place the
// difference matters most — could not tell missing from broken. They are distinct now, and the
// plain resolve() stays non-throwing/string-or-null for back-compat.
const OUT = (status, reason = null, text = null, fidelity = null) => ({ status, reason, text, fidelity });

// A within-file duplicate keeps the source shards (sha256) of its sealed members, so
// poisonSplitDuplicates can carry the collision to a copy of the same record id in another root. An
// entry that an earlier cross-root pass poisoned counts as the record it was (`splitFrom`).
const shardShaOf = (loc) => (loc && loc.sealed ? loc.sealed.shards[loc.sealed.records[loc.i][R.shard]].sha256 : null);
const dupOf = (prev, loc) => {
  const was = prev.splitFrom || prev;
  return { dup: true, dupCount: (was.dupCount || 1) + 1, file: loc.file, shas: [...(was.dup ? was.shas || [] : [shardShaOf(was)]), shardShaOf(loc)].filter(Boolean) };
};

// Byte-scan a file line-by-line from byte `from`, recording each record's { offset, length } WITHOUT
// retaining any body. Peak memory ≈ one chunk + one line + the index (O(records) small entries).
// Returns { size, ino, end, tail }: `end` = the offset just past the last NEWLINE-terminated line,
// where a refresh resumes; `tail` = what the unterminated last line (a record still being written,
// or a file without a final newline) did to the index, so a refresh can undo it and re-read it whole.
// `log` (optional) collects what an attempt did that a scan cannot undo — a key it turned into a
// duplicate, a bare id it turned AMBIGUOUS — plus a count of records it indexed (undoAttempt).
function lineIndexer(file, idx, from, log) {
  const base = path.basename(file);
  let lineStart = from, pending = Buffer.alloc(0);
  const record = (lineBuf) => {
    if (!lineBuf.length) return null;
    // key by String(id): parseTextRef always yields recordId as a string, so coerce to match
    // regardless of whether the harness minted numeric or string record ids.
    try {
      const raw = JSON.parse(lineBuf.toString('utf8')).id;
      if (raw != null) {
        const id = String(raw);
        const loc = { file, offset: lineStart, length: lineBuf.length };
        // WITHIN-FILE collision. The qualified key is documented as "the authoritative key", but a
        // plain set() overwrites — so when one file carries the same id twice, the LAST record
        // indexed silently becomes the answer for the first one's ref, and the verbatim panel
        // serves one record's bytes as another's. Live measurement on the author's capture:
        // 36,876 records, 165 duplicated ids, because the writer mints from a per-PROCESS counter
        // (req_00001…) and every MITM restart appends to the SAME file. Poison instead: the ref
        // genuinely does not name one record, and refusing loudly is the only answer that keeps
        // "verbatim" true (invariant 2) and the loss visible (invariant 4).
        const qk = base + '#' + id;
        const prev = idx.qual.get(qk);
        idx.qual.set(qk, prev === undefined ? loc : dupOf(prev, loc));
        // bare-id fallback: first writer wins, a second file poisons the entry to AMBIGUOUS
        const prevB = idx.byId.get(id), setB = prevB === undefined ? loc : AMBIGUOUS;
        idx.byId.set(id, setB);
        if (log) { log.n++; if (prev !== undefined) log.q.push([qk, prev]); if (prevB !== undefined) log.b.push([id, prevB]); }
        return { kind: 'indexed', qk, id, prev, prevB, setB };
      } else {
        // parseable, but nothing to key on — indexable content silently dropped. Report it.
        idx.scan.unidentifiedLines++;
        return { kind: 'unidentified' };
      }
    } catch {
      // A corrupt NDJSON line can never be indexed, so it can never surface per-record: the
      // record it was meant to carry just looks ABSENT. Count it so the omission is at least
      // reportable at scan level (invariant 4 — never let a loss be invisible).
      idx.scan.corruptLines++;
      idx.scan.corruptByFile[base] = (idx.scan.corruptByFile[base] || 0) + 1;
      return { kind: 'corrupt' };
    }
  };
  return {
    feed(buf, bytesRead) {
      let segStart = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === NL) {
          const lineBuf = pending.length ? Buffer.concat([pending, buf.subarray(segStart, i)]) : buf.subarray(segStart, i);
          record(lineBuf);
          lineStart += lineBuf.length + 1; // + newline
          pending = Buffer.alloc(0);
          segStart = i + 1;
        }
      }
      if (segStart < bytesRead) pending = pending.length ? Buffer.concat([pending, buf.subarray(segStart, bytesRead)]) : Buffer.from(buf.subarray(segStart, bytesRead));
    },
    finish(st, filePos) {
      const end = lineStart;
      const tail = record(pending); // trailing line without a newline (null when the file ends in one)
      idx.scan.bytesIndexed = (idx.scan.bytesIndexed || 0) + (filePos - from);
      return { size: st.size, ino: st.ino, end, tail };
    },
  };
}
const CHUNK = 1 << 20;
// WHICH FILE an index mark describes, beyond its inode. A refresh treats a same-inode file that grew as an append and
// reads on from `end`. But an inode is no identity: Linux ext4 hands a deleted file's inode straight to the next file,
// and a truncating rewrite (O_TRUNC) keeps it — the new file was then read at the old file's offsets. In an
// append-only file the bytes before `end` never change, so the first and the last FP bytes before `end` are kept with
// the mark (plus mtime / ctime, to catch a same-size rewrite) and compared before any resume.
const FP = 4096;
// Exported: the segment index (src/query/index-build.mjs) invalidates its own files by the SAME rule —
// an append-only file is resumed only when the bytes before the last indexed line are still the ones indexed.
export const fpRanges = (end) => [[0, Math.min(FP, end)], [Math.max(0, end - FP), end]];
const fpOfReads = (end, read) => fpRanges(end).map(([a, b]) => read(a, b));
export function readRangeSync(fd, a, b) { const out = Buffer.alloc(b - a); let n = 0; while (n < out.length) { const r = readSync(fd, out, n, out.length - n, a + n); if (!r) break; n += r; } return out.subarray(0, n); }
async function readRange(fd, a, b) { const out = Buffer.alloc(b - a); let n = 0; while (n < out.length) { const { bytesRead } = await fd.read(out, n, out.length - n, a + n); if (!bytesRead) break; n += bytesRead; } return out.subarray(0, n); }
const withIdentity = (mark, st, fp) => Object.assign(mark, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, fp });
// → true when `file` still holds, before m.end, the bytes it held when `m` was made (an append), false when they differ
// or cannot be read (then the caller rebuilds: the safe answer).
export function sameFileAs(file, m) {
  if (!m.fp) return true; // a mark without a fingerprint (sealed): its own rule applies
  let fd;
  try {
    fd = openSync(file, 'r');
    return fpOfReads(m.end, (a, b) => readRangeSync(fd, a, b)).every((buf, i) => buf.equals(m.fp[i]));
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
async function indexFile(file, idx, from = 0, log = null) {
  const fd = await open(file, 'r');
  try {
    const st = await fd.stat();
    const buf = Buffer.allocUnsafe(CHUNK), li = lineIndexer(file, idx, from, log);
    let filePos = from;
    while (filePos < st.size) {
      const { bytesRead } = await fd.read(buf, 0, CHUNK, filePos);
      if (!bytesRead) break;
      li.feed(buf, bytesRead);
      filePos += bytesRead;
    }
    const mark = li.finish(st, filePos);
    const fp = [];
    for (const [a, b] of fpRanges(mark.end)) fp.push(await readRange(fd, a, b));
    return withIdentity(mark, st, fp);
  } finally { await fd.close(); }
}
// The same scan, synchronous: only for the in-place re-index when an indexed file disappears under a
// read (`Stale` below), which runs inside a synchronous detail() call.
function indexFileSync(file, idx, from = 0, log = null) {
  const fd = openSync(file, 'r');
  try {
    const st = fstatSync(fd);
    const buf = Buffer.allocUnsafe(CHUNK), li = lineIndexer(file, idx, from, log);
    let filePos = from;
    while (filePos < st.size) {
      const bytesRead = readSync(fd, buf, 0, CHUNK, filePos);
      if (!bytesRead) break;
      li.feed(buf, bytesRead);
      filePos += bytesRead;
    }
    const mark = li.finish(st, filePos);
    return withIdentity(mark, st, fpOfReads(mark.end, (a, b) => readRangeSync(fd, a, b)));
  } finally { closeSync(fd); }
}

// A sealed file contributes its index entries (id + ORIGINAL stream, computed at seal time exactly as
// the NDJSON scan computes them), with the same duplicate poisoning and corrupt / unidentified counts.
// It is read whole and never grows. One that cannot be opened is COUNTED and named, never silently
// absent (user requirement 2026-10-06): a ref into it then says why it cannot be found.
function indexSealed(file, idx, frameCache) {
  const st = statSync(file);
  const mark = { size: st.size, ino: st.ino, end: st.size, tail: null, sealed: true };
  let sf;
  try { sf = openSealed(file, { frameCache }); }
  catch (e) {
    if (!idx.scan.unreadableSealed.some((x) => x.file === file)) idx.scan.unreadableSealed.push({ file, reason: e.message });
    return mark;
  }
  idx.sealed.push(sf);
  const base = path.basename(file);
  for (let i = 0; i < sf.count; i++) {
    const r = sf.records[i];
    if (r[R.len] - (r[R.flags] & FLAG_NL ? 1 : 0) === 0) continue;    // an empty line, as in the NDJSON scan
    if (r[R.flags] & FLAG_UNPARSEABLE) { idx.scan.corruptLines++; idx.scan.corruptByFile[base] = (idx.scan.corruptByFile[base] || 0) + 1; continue; }
    if (r[R.id] == null) { idx.scan.unidentifiedLines++; continue; }
    const id = String(r[R.id]), qk = sf.streams[r[R.stream]] + '#' + id, loc = { file, sealed: sf, i };
    const prev = idx.qual.get(qk);
    idx.qual.set(qk, prev === undefined ? loc : dupOf(prev, loc));
    idx.byId.set(id, idx.byId.has(id) ? AMBIGUOUS : loc);
  }
  return mark;
}

// Take back what an unterminated last line did to the index, before a refresh re-reads it in full
// (it may have been half a record then, or have since grown). Only the qualified key is exactly
// restorable — no other file writes `<this file>#<id>`; a bare-id entry is restored only if nothing
// changed it since, otherwise it stays AMBIGUOUS (refuse rather than guess).
function undoTail(idx, base, t) {
  if (!t) return;
  if (t.kind === 'corrupt') {
    idx.scan.corruptLines--;
    if (!--idx.scan.corruptByFile[base]) delete idx.scan.corruptByFile[base];
  } else if (t.kind === 'unidentified') idx.scan.unidentifiedLines--;
  else {
    if (t.prev === undefined) idx.qual.delete(t.qk); else idx.qual.set(t.qk, t.prev);
    if (idx.byId.get(t.id) === t.setB) { if (t.prevB === undefined) idx.byId.delete(t.id); else idx.byId.set(t.id, t.prevB); }
  }
}

// Take back everything an attempt that FAILED part-way did to the index, exactly, without re-reading
// anything: restore the keys it turned into duplicates / AMBIGUOUS (newest first), delete the entries
// it added (this file, at or past `from`: a scan of the maps, no JSON parse), restore the counts.
// A rebuild of the whole root did the same job at the cost of re-parsing every line.
function undoAttempt(idx, file, from, log, counts) {
  for (let i = log.q.length - 1; i >= 0; i--) idx.qual.set(log.q[i][0], log.q[i][1]);
  for (let i = log.b.length - 1; i >= 0; i--) idx.byId.set(log.b[i][0], log.b[i][1]);
  if (log.n) {
    for (const [k, v] of idx.qual) if (!v.dup && v.file === file && v.offset >= from) idx.qual.delete(k);
    for (const [id, v] of idx.byId) if (v !== AMBIGUOUS && v.file === file && v.offset >= from) idx.byId.delete(id);
  }
  const base = path.basename(file);
  Object.assign(idx.scan, { corruptLines: counts.c, unidentifiedLines: counts.u });
  if (counts.cb) idx.scan.corruptByFile[base] = counts.cb; else delete idx.scan.corruptByFile[base];
}

// An indexed file gone at read time (the sealer deleted a verified original, or it rotated away): its
// records may live on in sealed copies that the listing set aside while it existed, so the index is
// rebuilt in place once instead of reporting them absent (4.2 「并存期」). An fd opened before the unlink
// keeps reading the old inode and needs nothing.
class Stale extends Error {}

// Sealing splits one shard by session, possibly into files under different roots. Two records with
// one (stream, id) in that shard were ambiguous before (one file); each root alone may now hold the id
// once, and "first root that answers wins" would serve the other record's bytes. They come from one
// source shard (name + sha256 in each sealed file's shard table), so poison them across every root:
// "和封存前同名文件里撞 id 的行为一致" (4.2 「读」). An id already ambiguous within one root still counts
// against a copy of it in another root (a three-way duplicate).
// Idempotent: under several roots each root re-indexes on its own (refresh), so a pass first takes
// back what an earlier pass poisoned (`splitFrom`) and counts the collision from the index as it is now
// — a root that did not re-index still holds the earlier poisoning, and a root that did holds none.
function poisonSplitDuplicates(parts) {
  for (const idx of parts) for (const [qk, loc] of idx.qual) if (loc.splitFrom) idx.qual.set(qk, loc.splitFrom);
  const where = new Map();           // shard sha256 \0 stream#id → [{ idx, qk, file, shard, loc, already }]
  const put = (k, h) => { if (!where.has(k)) where.set(k, []); where.get(k).push(h); };
  for (const idx of parts) {
    for (const [qk, loc] of idx.qual) {
      if (loc.dup) {                 // already ambiguous in its root: it still counts against the others
        for (const sha of new Set(loc.shas || [])) put(sha + '\0' + qk, { idx, qk, file: loc.file, shard: loc.file, already: loc.dupCount });
        continue;
      }
      if (!loc.sealed) continue;     // an NDJSON line
      const sh = loc.sealed.shards[loc.sealed.records[loc.i][R.shard]];
      put(sh.sha256 + '\0' + qk, { idx, qk, file: loc.file, shard: sh.name, loc });
    }
  }
  for (const hits of where.values()) {
    const n = hits.reduce((a, h) => a + (h.already || 1), 0);
    if (n < 2) continue;
    const name = (hits.find((h) => !h.already) || hits[0]).shard;
    for (const h of hits) if (!h.already) h.idx.qual.set(h.qk, { dup: true, dupCount: n, file: name, sealedInto: hits.map((x) => path.basename(x.file)), splitFrom: h.loc });
  }
}

// What one root lists: discover's rule over this root alone, or — under several roots — this root's
// share of ONE listing across all of them, so an original in one root supersedes its sealed copy in
// another (4.2 「并存期」: every reader makes the same choice).
// `exclude`: files to treat as absent — only `trocar raw compare`, to resolve as it will once the
// originals with a sealed copy are deleted (review 3 F1).

// Several roots: index each independently and try them in order. Order matters only for a bare-id
// fallback, and the qualified key (`<file>#<id>`) is unaffected, so this cannot invent a winner
// among collisions — a ref that is ambiguous within a root still throws from that root's resolver.
// Which files each root reads is ONE listing across all of them (src/raw/discover.mjs), so an
// original in one root and its sealed copy in another are never both read.
async function buildMultiResolver(roots, { exclude, ...opts }) {
  const parts = [];
  const unreadable = [];
  // the roots a listing can include: one that cannot be listed is left out of it (and fails alone)
  const listable = () => roots.filter((r) => { try { listSources([r]); return true; } catch { return false; } });
  const shared = { at: null, ls: null };
  const frameCache = createFrameCache();   // one frame LRU for every root's sealed files
  const unreadableSealed = () => parts.flatMap((p) => (p.scan && p.scan.unreadableSealed) || []);
  // Re-poisons every root whenever one root's index changes (a rebuild swapped in, a new file indexed),
  // in the same tick — never on a later await, when a lookup may already have run.
  const poison = () => poisonSplitDuplicates(parts.map((p) => p.index));
  const lister = (root) => {
    const good = listable();
    if (!good.includes(root)) return listRoot(root, exclude); // throws this root's own error
    const ls = listSources(good, { exclude });
    shared.ls = ls;
    return { ...ls.perRoot.find((p) => p.root === root), superseded: ls.superseded, mismatched: ls.mismatched };
  };
  for (const r of roots) {
    // FAIL SOFT PER ROOT. A root can be absent, unreadable, or deleted between the caller's existence
    // check and this open — the legacy home is exactly the kind of directory a user tidies away, and
    // the live one is being written to while we read it. One bad root must cost the sessions in that
    // root, never the whole board: throwing here takes down the board at startup and the user
    // sees a crash where they should see the sessions that ARE readable (invariant 2 — a capture on
    // disk stays readable). What is dropped is recorded so `scan` can report it rather than hide it.
    try { parts.push(Object.assign(await buildResolver(r, { ...opts, lister, frameCache, unreadableSealed, onIndexChange: poison }), { rootPath: r })); }
    catch (e) { unreadable.push({ root: r, reason: (e && e.message) || String(e) }); }
  }
  poison();
  // Stale (an indexed file is gone): every root re-lists and re-indexes together, then the ref is asked
  // again once — the copy that replaces the file may sit in another root.
  const withRelist = (fn) => {
    try { return fn(); }
    catch (e) {
      if (!(e instanceof Stale)) throw e;
      for (const p of parts) p.rebuildSync();
      poison();
      return fn();
    }
  };
  const resolve = (...args) => withRelist(() => {
    let lastErr = null;
    for (const p of parts) {
      try { const got = p.detailOnce(...args); if (got.status === 'ok') return got.text; } catch (e) { if (e instanceof Stale) throw e; lastErr = e; }
    }
    if (lastErr) throw lastErr;   // an ambiguity/corruption report must not be swallowed by a miss
    return null;
  });
  const scanOf = () => ({
    files: parts.flatMap((p) => (p.scan && p.scan.files) || []),
    skipped: parts.flatMap((p) => (p.scan && p.scan.skipped) || []),
    corruptLines: parts.reduce((n, p) => n + ((p.scan && p.scan.corruptLines) || 0), 0),
    corruptByFile: Object.assign({}, ...parts.map((p) => (p.scan && p.scan.corruptByFile) || {})),
    unidentifiedLines: parts.reduce((n, p) => n + ((p.scan && p.scan.unidentifiedLines) || 0), 0),
    bytesIndexed: parts.reduce((n, p) => n + ((p.scan && p.scan.bytesIndexed) || 0), 0),
    unreadableSealed: unreadableSealed(),
    superseded: (shared.ls && shared.ls.superseded) || [], mismatched: (shared.ls && shared.ls.mismatched) || [],
    unreadableRoots: unreadable,
  });
  // live: a refresh that changed nothing can still have noted a skip
  Object.defineProperty(resolve, 'scan', { get: scanOf, enumerable: true });

  // A MISS IS AN OBJECT, SO "TRUTHY" IS NOT "FOUND".
  //
  // This used to be `for (const k of ['detail','close']) … if (k === 'detail' && v) return v`, and
  // detail() never returns falsy — a miss is `{status:'absent', reason}`, which is truthy. So the
  // FIRST root's miss was returned as the answer and no later root was ever consulted. Every block
  // whose bytes live in the legacy home rendered `absent` on the board while sitting on disk, which
  // is AC-1 (回源逐字, RFC 4.2:41,77) silently unavailable to precisely the users the D27 home move
  // created. Ask each root in turn, accept only an actual hit, and when they all miss return the LAST
  // reasoned miss so the row can say why rather than render empty (invariant 4).
  resolve.detail = (...a) => withRelist(() => {
    let last = null;
    for (const p of parts) {
      const v = p.detailOnce(...a);
      if (v && v.status === 'ok') return v;
      if (v) last = v;
    }
    return last;
  });

  // The server reports `source_resolved` as `resolve.size ? true : false` (RFC 4.4:98). With no size
  // the post-D27 DEFAULT configuration announced its capture source was unreadable while serving from
  // it. Sum the roots: the resolved corpus really is all of them.
  Object.defineProperty(resolve, 'size', { get: () => parts.reduce((n, p) => n + (typeof p.size === 'number' ? p.size : 0), 0), enumerable: true });
  resolve.refresh = async () => {
    let changed = false;
    for (const p of parts) {
      try { if (typeof p.refresh === 'function' && await p.refresh()) changed = true; }
      catch (e) { // later roots still refresh; this one is noted once
        const sk = p.scan && p.scan.skipped, root = path.dirname(p.rootPath), name = path.basename(p.rootPath);
        if (sk && !sk.some((x) => x.root === root && x.name === name && x.reason === 'unreadable')) sk.push({ root, name, reason: 'unreadable', error: (e && e.code) || String(e) });
      }
    }
    if (changed) poison();   // a root that re-indexed has un-poisoned entries again
    return changed;
  };

  // …and teardown. The old loop forwarded 'close', but a resolver's teardown is `dispose`, so no root
  // was ever closed and every indexed file's fd leaked for the life of the process. Idempotent and
  // non-throwing: shutdown paths overlap, and a failure to close must not mask the reason for the
  // shutdown.
  resolve.frameStats = frameCache.stats;   // sealed-frame LRU (shared by every root): decodes / hits / most frames ever resident
  resolve.dispose = () => { for (const p of parts) { try { p.dispose && p.dispose(); } catch {} } };
  return resolve;
}
