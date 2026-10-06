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
import { parseTextRef, TEXT_REF_FIELD, fieldTextOf } from '../etl/orchestrator.mjs';
import { normalizeRecord } from '../etl/ingest.mjs';
import { expandRequestBody, requestEncodingOf } from '../dissect/request-body.mjs';
import { listSources, isSealedPath } from '../raw/discover.mjs';
import { openSealed, createFrameCache } from '../raw/reader.mjs';
import { R, FLAG_NL, FLAG_UNPARSEABLE } from '../raw/format.mjs';

const NL = 0x0a;
const BODY_LRU = 8; // req_body strings held at once — a call's blocks resolve off one cached body

// ── record-id collisions across files (audit 2026-07-19 · invariant 2) ───────────────────────
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

// ── fidelity of the bytes we hand back (audit 2026-07-19 · invariant 4 保真边界写明) ──────────
// NOT every record we can resolve is byte-faithful. `normalizeRecord` (src/etl/ingest.mjs:14)
// has two branches:
//   · D10 — `req_body` is the VERBATIM captured request string → the bytes that went on the wire.
//   · demo v0 — the capture stored the request as PARSED JSON, so the body is rebuilt with
//     JSON.stringify. Whitespace, key order, duplicate keys, number formatting and unicode
//     escaping can all differ from the wire. It is a RE-SERIALIZATION, not the wire bytes.
// Both used to come back as bare strings, so the "回源 verbatim bytes" panel labelled the
// re-serialized ones verbatim too — presenting a reconstruction as the source truth, which is
// exactly the promise this tool exists to keep. So classify, and let every consumer label it.
// This is a CLASSIFIER only: it mirrors normalizeRecord's branches, it never rewrites anything.
function classifyFidelity(raw) {
  // D10: the captured wire string — or, when the wire carried it compressed, its exact decompressed text (4.6 §记录)
  if (typeof raw.req_body === 'string') return requestEncodingOf(raw) ? 'decoded' : 'verbatim';
  if (raw.request === undefined) return null;                // not an llm record — no body at all
  if (raw.request === null) return 'reserialized';           // '' stand-in, synthesized not captured
  if (typeof raw.request === 'string') return 'verbatim';    // v0 stored raw text → passed through
  return 'reserialized';                                     // v0 parsed JSON → JSON.stringify(…)
}

// ── outcomes (audit 2026-07-19) ───────────────────────────────────────────────────────────────
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
    return li.finish(st, filePos);
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
    return li.finish(st, filePos);
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
// `sessionsRoot`: where `asight raw seal` files a shard's records by session; sealed files there that
// continue a shard of a served root are read with that root (src/raw/discover.mjs, rule 3).
// `exclude`: files to treat as absent — only `asight raw compare`, to resolve as it will once the
// originals with a sealed copy are deleted (review 3 F1).
const listRoot = (root, sessionsRoot = null, exclude = null) => {
  const ls = listSources([root], { sessionsRoot, exclude });
  return { ...ls.perRoot[0], superseded: ls.superseded, mismatched: ls.mismatched, unattributed: ls.unattributed };
};

// Build resolve(text_ref) -> the block's exact byte slice (or null if unresolvable). Lean: holds a
// byte-offset index + ≤ BODY_LRU cached req_body strings, never the whole corpus.
// `source` may be one path or SEVERAL roots (D27: the new home plus the legacy one that still holds
// the user's captures). Scanning only the first would make raw-byte refs from the other root
// unresolvable — the block viewer would report "record not found" for bytes that are on disk.
export async function buildResolver(source, { retryMs = 30000, sessionsRoot = null, exclude = null, lister = (root) => listRoot(root, sessionsRoot, exclude), frameCache = createFrameCache(8), unreadableSealed = null, onIndexChange = null } = {}) {
  const roots = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (roots.length > 1) return buildMultiResolver(roots, { retryMs, sessionsRoot, exclude });
  const sourcePath = roots[0];
  const files = [];
  // scan (audit 2026-07-19): what is not read is recorded with its reason, so the omission is
  // reportable rather than silent. Which files are read, and the reasons for the rest, come from the
  // shared rule (src/raw/discover.mjs): the flat *.ndjson, one level down `<sid>/calls.ndjson`, and
  // sealed files standing where those streams would be read.
  const scan = { files, skipped: [], corruptLines: 0, corruptByFile: {}, unidentifiedLines: 0, bytesIndexed: 0, unreadableSealed: [], superseded: [], mismatched: [], unattributed: [] };
  const isDir = statSync(sourcePath).isDirectory();
  const listFiles = (skipped) => {
    const ls = lister(sourcePath); // throws if the root cannot be listed (broken ≠ empty)
    scan.superseded = ls.superseded || []; scan.mismatched = ls.mismatched || []; scan.unattributed = ls.unattributed || [];
    if (skipped) skipped.push(...ls.skipped.map(({ name, reason }) => ({ name, reason })));
    return [...ls.files];
  };
  files.push(...listFiles(scan.skipped));

  // qual: "<streamBasename>#<recordId>" -> { file, offset, length }  (the authoritative key)
  // byId: "<recordId>" -> loc | AMBIGUOUS                            (back-compat fallback only)
  const idx = { qual: new Map(), byId: new Map(), sealed: [], scan };
  const marks = new Map();     // file -> { size, ino, end, tail } as of its last indexing

  // A file that cannot be read is skipped, not fatal, at startup and on refresh: one unreadable
  // capture must not take down the root's index (or `asight serve`). It is noted in scan.skipped
  // (with its root, once per root + name + reason), which the board shows, and the note is dropped
  // once the file indexes or leaves the root. A read that failed after the open may have indexed
  // some lines; undoAttempt() takes them back, so a retry never indexes a line twice.
  const TRANSIENT = new Set(['unreadable', 'vanished']);
  function note(root, name, reason, e) {
    if (!scan.skipped.some((x) => x.root === root && x.name === name && x.reason === reason)) scan.skipped.push({ root, name, reason, ...(e ? { error: (e && e.code) || String(e) } : {}) });
  }
  const unnote = (pred) => { for (let i = scan.skipped.length - 1; i >= 0; i--) if (TRANSIENT.has(scan.skipped[i].reason) && pred(scan.skipped[i])) scan.skipped.splice(i, 1); };
  // A failed file is retried when its stat changes (ino, size, mtime, ctime: a chmod changes ctime)
  // or `retryMs` after its last attempt (an error can clear with no stat change: a one-off EIO, a
  // remount). Retrying on every refresh turned a recurring read error into a full rebuild per poll.
  const failedAt = new Map(); // file -> { sig, e, at } of its last failed read
  const statSig = (f) => { try { const st = statSync(f); return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; } catch { return 'gone'; } };
  const unchangedFailure = (f) => { const x = failedAt.get(f); return !!x && x.sig === statSig(f) && Date.now() - x.at < retryMs; };
  // `into`: the index the attempt writes — the live one, or the fresh one a rebuild swaps in
  const attempt = (f, from, run, into = idx) => {
    const sig = statSig(f); // before the read: a change that lands during it must not be absorbed
    const sc = into.scan, log = { n: 0, q: [], b: [] }, counts = { c: sc.corruptLines, u: sc.unidentifiedLines, cb: sc.corruptByFile[path.basename(f)] };
    const ok = (mk) => { failedAt.delete(f); unnote((x) => x.root === path.dirname(f) && x.name === path.basename(f)); return mk; };
    const fail = (e) => {
      undoAttempt(into, f, from, log, counts);
      failedAt.set(f, { sig, e, at: Date.now() });
      note(path.dirname(f), path.basename(f), 'unreadable', e);
      return null;
    };
    return run(log, ok, fail);
  };
  // a sealed file is indexed whole from its own index (sync); an NDJSON file by the line scan
  const indexSafe = (f, from = 0, into = idx) => attempt(f, from, (log, ok, fail) => (isSealedPath(f) ? Promise.resolve().then(() => indexSealed(f, into, frameCache)) : indexFile(f, into, from, log)).then(ok, fail), into);
  const indexSafeSync = (f, from = 0) => attempt(f, from, (log, ok, fail) => { try { return ok(isSealedPath(f) ? indexSealed(f, idx, frameCache) : indexFileSync(f, idx, from, log)); } catch (e) { return fail(e); } });
  for (const f of [...files]) { const mk = await indexSafe(f); if (mk) marks.set(f, mk); else files.splice(files.indexOf(f), 1); }
  // A file that left the root takes its failure (and its note) with it. By full path: one level down,
  // every session dir holds a `calls.ndjson`, so a basename names no one file.
  const fileRoot = path.dirname(isDir ? path.join(sourcePath, '_') : sourcePath); // as notes file it: `traces/` and `./traces` too
  const under = (dir) => dir === fileRoot || dir.startsWith(fileRoot + path.sep);
  const forgetUnlisted = (listed) => {
    const keep = new Set(listed.map((f) => path.resolve(f)));
    for (const f of [...failedAt.keys()]) if (!keep.has(path.resolve(f))) failedAt.delete(f);
    unnote((x) => under(x.root) && !keep.has(path.resolve(x.root, x.name)));
  };

  const fds = new Map();       // file -> open fd (reused across resolves)
  const fdFor = (f) => {
    let fd = fds.get(f);
    if (fd === undefined) {
      try { fd = openSync(f, 'r'); } catch (e) { if (e.code === 'ENOENT') throw new Stale(f); throw e; }
      fds.set(f, fd);
    }
    return fd;
  };
  const bodyCache = new Map(); // QUALIFIED key -> normalized req_body string (LRU)

  // Locate the ONE record a ref names. Prefers the qualified key; falls back to the bare id only
  // when that id is unambiguous across the whole source. Never picks a winner among collisions.
  const locate = (stream, recordId) => {
    const q = idx.qual.get(stream + '#' + recordId);
    if (q && q.dup) {
      throw new Error(
        `source: ambiguous record id "${recordId}" — it occurs ${q.dupCount} times inside a SINGLE ` +
        `capture file (${path.basename(q.file)}${q.sealedInto ? `, now sealed into ${q.sealedInto.join(', ')}` : ''}), so the text_ref names more than one record. This is ` +
        `the capture writer minting ids from a per-process counter and appending across restarts. ` +
        `Refusing to guess: serving one of them under a "verbatim" label would misreport the source ` +
        `truth (invariant 2). The bytes of both are intact in the raw NDJSON.`,
      );
    }
    if (q) return { key: stream + '#' + recordId, loc: q };
    // The ref names a capture file in this root that the index has not read yet (created since it
    // was built). The bare-id fallback below could answer with ANOTHER file's record of the same id,
    // labelled ok; report a miss instead, so the caller refreshes and the qualified key decides.
    if (isDir && path.basename(stream) === stream && !files.some((f) => path.basename(f) === stream)
      && existsSync(path.join(sourcePath, stream))) return null;
    const e = idx.byId.get(recordId);
    if (e === undefined) return null;                 // genuinely absent → null (callers expect it)
    if (e === AMBIGUOUS) {                            // present in several files, ref doesn't say which
      const files = [...idx.qual.entries()].filter(([k]) => k.endsWith('#' + recordId)).map(([k]) => k.split('#')[0]);
      throw new Error(
        `source: ambiguous record id "${recordId}" — it exists in ${files.length} capture files (${files.join(', ')}) ` +
        `and the text_ref names stream "${stream}", which matches none of them. Refusing to guess: returning any one ` +
        `file's bytes under a "verbatim" label would misreport the source truth (invariant 2).`,
      );
    }
    return { key: e.file + '#' + recordId, loc: e };
  };

  // Under several roots `unreadableSealed` is every root's list: a miss names all of them.
  const absentReason = (stream, recordId) => {
    const bad = [...(unreadableSealed ? unreadableSealed() : scan.unreadableSealed), ...(scan.unattributed || [])];
    return `no record "${recordId}" in stream "${stream}" in this source` + (bad.length
      ? ` — note: ${bad.length} sealed file(s) here could not be read (${bad.map((b) => path.basename(b.file)).join(', ')}), so a record inside them cannot be found`
      : '');
  };

  // → an OUTCOME, never a bare string: { status, reason, text, fidelity }. `text` is the whole
  // record body (or the named field); the caller slices it. Statuses: ok | absent | corrupt | no-body (detail adds bad-field).
  // `field` (4.2:40): null = req_body, else one TEXT_REF_FIELD; each field of a record has its own cache slot.
  const bodyOf = (stream, recordId, field = null) => {
    const hit = locate(stream, recordId);             // may throw on ambiguity — deliberately loud
    if (!hit) return OUT('absent', absentReason(stream, recordId));
    const ck = field ? hit.key + '\n' + field : hit.key;
    if (bodyCache.has(ck)) return bodyCache.get(ck);
    const { loc } = hit;
    let buf, out = null;
    if (loc.sealed) {
      try {
        buf = loc.sealed.lineAt(loc.i);
        if (buf.length && buf[buf.length - 1] === NL) buf = buf.subarray(0, buf.length - 1);
      } catch (e) {
        out = OUT('corrupt', `record "${recordId}" in sealed file ${path.basename(loc.file)} could not be decoded (${e.message})`);
      }
    } else {
      buf = Buffer.allocUnsafe(loc.length);
      readSync(fdFor(loc.file), buf, 0, loc.length, loc.offset);
    }
    if (!out) try {
      const raw = expandRequestBody(JSON.parse(buf.toString('utf8'))); // the same decoded text the loaders read
      if (field) {
        const f = fieldTextOf(raw, field); // the stored decoded text IS the verbatim record (4.6 §记录)
        out = f.text != null ? OUT('ok', null, f.text, 'verbatim') : OUT('no-body', `record "${recordId}" ${f.missing}`);
      } else {
        const body = normalizeRecord(raw).req_body;
        out = typeof body === 'string'
          ? OUT('ok', null, body, classifyFidelity(raw))
          // present and readable, but it carries no request body — a real answer ("there are no
          // bytes"), categorically different from "the record is missing" or "the bytes are damaged".
          : OUT('no-body', `record "${recordId}" has no request body (neither req_body nor a v0 request)`);
      }
    } catch (e) {
      // The line was parseable when we indexed it and is not now: the source bytes under this
      // record are DAMAGED (truncated / rewritten / partially flushed). Surface it — reporting
      // damage as absence would let a byte-faithfulness tool hide exactly the loss it exists to
      // detect. No fidelity claim is made about bytes we could not parse.
      out = OUT('corrupt',
        `record "${recordId}" in ${path.basename(loc.file)} @${loc.offset ?? 'record ' + loc.i}+${loc.length ?? buf.length} could not be ` +
        `parsed back from the source (${e.message}) — the bytes changed since indexing or are damaged`);
    }
    // cache on the QUALIFIED key — a bare-id cache key reintroduced the very collision above
    bodyCache.set(ck, out);
    if (bodyCache.size > BODY_LRU) bodyCache.delete(bodyCache.keys().next().value);
    return out;
  };

  // The detailed read: every consumer that wants to LABEL what it renders uses this. `detailOnce` may
  // throw Stale (an indexed file is gone); `detail` re-indexes in place once and asks again. Under
  // several roots the multi-root resolver catches Stale itself, so every root re-lists together.
  const detailOnce = (textRef) => {
    if (!textRef) return OUT('no-ref', 'block has no text_ref — nothing points at the source');
    const { rawRef, recordId, field, start, end } = parseTextRef(textRef);
    if (field != null && !TEXT_REF_FIELD.test(field)) return OUT('bad-field', `"${field}" is not a text_ref field (RFC 4.2:40: resp.raw | resp.messages.<j> | req_extra_messages.<k>)`);
    const got = bodyOf(streamOfRawRef(rawRef), recordId, field);
    // A ref with NO byte span addresses the WHOLE record body. `slice(null, null)` returns '', which
    // would hand back empty bytes under an "ok" status — a silently wrong answer from the source-truth
    // resolver. Only slice when a real span was supplied.
    if (got.status !== 'ok') return got;
    return (start == null || end == null) ? got : { ...got, text: got.text.slice(start, end) };
  };
  const detail = (textRef) => {
    try { return detailOnce(textRef); }
    catch (e) { if (!(e instanceof Stale)) throw e; rebuildSync(); return detailOnce(textRef); }
  };

  // Back-compat surface: string-or-null, non-throwing (except the deliberate ambiguity throw).
  const resolve = (textRef) => {
    const got = detail(textRef);
    return got.status === 'ok' ? got.text : null;
  };
  resolve.detail = detail;
  resolve.detailOnce = detailOnce;
  Object.defineProperty(resolve, 'index', { value: idx });   // for the multi-root poisoning pass only
  resolve.scan = scan;
  Object.defineProperty(resolve, 'size', { get: () => idx.qual.size, enumerable: true });
  const closeSealed = () => { for (const sf of idx.sealed) sf.close(); idx.sealed.length = 0; frameCache.clear(); };
  resolve.dispose = () => { for (const fd of fds.values()) try { closeSync(fd); } catch {} fds.clear(); bodyCache.clear(); closeSealed(); };
  resolve.frameStats = frameCache.stats;   // sealed-frame LRU: decodes / hits / most frames ever resident

  // LIVE SOURCES (4.4 #10). The index used to be built once, at startup, so under a running
  // collector a call captured after `asight serve` started was listed by the board but its blocks
  // came back `absent` — bytes on disk reported missing. refresh() brings the index up to date:
  // new files are indexed whole; a grown file is indexed from where the last complete line ended
  // (only the new tail is read, so the cost is the new bytes, not the corpus); a file that shrank
  // or was replaced (inode changed) is not append-only, so the whole index is rebuilt. Concurrent
  // callers share one in-flight refresh. Resolves to true when the index changed.
  let inflight = null;
  const clearIndex = () => {
    idx.qual.clear(); idx.byId.clear(); marks.clear(); bodyCache.clear();
    for (const fd of fds.values()) try { closeSync(fd); } catch {}
    fds.clear(); closeSealed();
    Object.assign(scan, { corruptLines: 0, corruptByFile: {}, unidentifiedLines: 0, unreadableSealed: [] });
    // Notes are not cleared up front: a reader polling during the rebuild must still see a failure
    // that persists. A recovered file's note goes when it indexes; a gone file's, below.
    files.length = 0;
  };
  // Rebuilt into a FRESH index, swapped in at once. The rebuild awaits file reads and lookups run in
  // between: on a half-built index one copy of a duplicate (two files holding one id — a sealed copy
  // and its per-session continuation) was back while the other was not, and it answered `ok` with
  // one record's bytes for a ref that names two (invariant 2). Lookups now see the old index, whole,
  // until the new one is. `onIndexChange`: the multi-root resolver re-poisons in the same tick.
  const rebuildAll = async () => {
    const next = { qual: new Map(), byId: new Map(), sealed: [], scan: { corruptLines: 0, corruptByFile: {}, unidentifiedLines: 0, unreadableSealed: [], bytesIndexed: 0 } };
    const nextFiles = [], nextMarks = new Map();
    const listed = listFiles(null);
    forgetUnlisted(listed);
    try {
      for (const f of listed) {
        if (unchangedFailure(f)) { note(path.dirname(f), path.basename(f), 'unreadable', failedAt.get(f).e); continue; }
        const mk = await indexSafe(f, 0, next); if (mk) { nextFiles.push(f); nextMarks.set(f, mk); }
      }
    } catch (e) { for (const sf of next.sealed) sf.close(); throw e; }
    // the swap: synchronous, nothing reads in between
    for (const fd of fds.values()) try { closeSync(fd); } catch {}
    fds.clear(); bodyCache.clear();
    const oldSealed = idx.sealed;
    Object.assign(idx, { qual: next.qual, byId: next.byId, sealed: next.sealed });
    for (const sf of oldSealed) sf.close();
    frameCache.clear();
    const { bytesIndexed, ...counts } = next.scan;
    Object.assign(scan, counts, { bytesIndexed: (scan.bytesIndexed || 0) + bytesIndexed });
    marks.clear(); for (const [f, m] of nextMarks) marks.set(f, m);
    files.length = 0; files.push(...nextFiles);
    if (onIndexChange) onIndexChange();
  };
  // The same, synchronously, for Stale: it runs inside a detail() call.
  const rebuildSync = () => {
    clearIndex();
    const listed = listFiles(null);
    forgetUnlisted(listed);
    for (const f of listed) {
      if (unchangedFailure(f)) { note(path.dirname(f), path.basename(f), 'unreadable', failedAt.get(f).e); continue; }
      const mk = indexSafeSync(f); if (mk) { files.push(f); marks.set(f, mk); }
    }
  };
  resolve.rebuildSync = rebuildSync;
  const doRefresh = async () => {
    let now;
    try { now = listFiles(null); } catch (e) { note(path.dirname(sourcePath), path.basename(sourcePath), 'unreadable', e); return false; }
    if (isDir) unnote((x) => x.root === path.dirname(sourcePath) && x.name === path.basename(sourcePath)); // the listing note; a file source has none
    unnote((x) => x.reason === 'vanished'); // a pass's own observation; the board's loader reports it live
    forgetUnlisted(now);
    let changed = false;
    // A file indexed earlier and no longer listed (deleted, or set aside by the listing): its entries
    // must go, and whatever replaces it (its sealed copies) be read — rebuild.
    if ([...marks.keys()].some((f) => !now.includes(f))) { await rebuildAll(); changed = true; }
    else for (const f of now) {
      if (unchangedFailure(f)) { note(path.dirname(f), path.basename(f), 'unreadable', failedAt.get(f).e); continue; } // tried again once it changes or retryMs passes
      let st; try { st = statSync(f); } catch (e) { note(path.dirname(f), path.basename(f), 'vanished', e); continue; }
      const m = marks.get(f);
      if (!m) { const mk = await indexSafe(f); if (mk) { files.push(f); marks.set(f, mk); changed = true; if (onIndexChange) onIndexChange(); } continue; } // a new copy: poisoned before any await
      if (st.ino !== m.ino || st.size < m.size || (m.sealed && st.size !== m.size)) { await rebuildAll(); changed = true; break; } // a sealed file never grows
      if (st.size === m.size) continue;
      undoTail(idx, path.basename(f), m.tail);
      const mk = await indexSafe(f, m.end);
      marks.set(f, mk || { ...m, tail: null }); // tail already taken back: never undo it twice
      changed = true;
    }
    if (changed) bodyCache.clear();
    return changed;
  };
  resolve.refresh = () => inflight || (inflight = doRefresh().finally(() => { inflight = null; }));
  return resolve;
}


// Several roots: index each independently and try them in order. Order matters only for a bare-id
// fallback, and the qualified key (`<file>#<id>`) is unaffected, so this cannot invent a winner
// among collisions — a ref that is ambiguous within a root still throws from that root's resolver.
// Which files each root reads is ONE listing across all of them (src/raw/discover.mjs), so an
// original in one root and its sealed copy in another are never both read.
async function buildMultiResolver(roots, { sessionsRoot, exclude, ...opts }) {
  const parts = [];
  const unreadable = [];
  // the roots a listing can include: one that cannot be listed is left out of it (and fails alone)
  const listable = () => roots.filter((r) => { try { listSources([r]); return true; } catch { return false; } });
  const shared = { at: null, ls: null };
  const frameCache = createFrameCache(8);   // one frame LRU for every root's sealed files
  const unreadableSealed = () => parts.flatMap((p) => (p.scan && p.scan.unreadableSealed) || []);
  // Re-poisons every root whenever one root's index changes (a rebuild swapped in, a new file indexed),
  // in the same tick — never on a later await, when a lookup may already have run.
  const poison = () => poisonSplitDuplicates(parts.map((p) => p.index));
  const lister = (root) => {
    const good = listable();
    if (!good.includes(root)) return listRoot(root, sessionsRoot, exclude); // throws this root's own error
    const ls = listSources(good, { sessionsRoot, exclude });
    shared.ls = ls;
    return { ...ls.perRoot.find((p) => p.root === root), superseded: ls.superseded, mismatched: ls.mismatched, unattributed: ls.unattributed };
  };
  for (const r of roots) {
    // FAIL SOFT PER ROOT. A root can be absent, unreadable, or deleted between the caller's existence
    // check and this open — the legacy home is exactly the kind of directory a user tidies away, and
    // the live one is being written to while we read it. One bad root must cost the sessions in that
    // root, never the whole board: throwing here takes down `asight serve` at startup and the user
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
    unattributed: (shared.ls && shared.ls.unattributed) || [],
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
