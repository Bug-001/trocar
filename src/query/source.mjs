// src/query/source.mjs — resolve a block's text_ref back to its VERBATIM bytes in the
// source NDJSON. The derived store holds NO fulltext (invariant 2: only a pointer); the
// verbatim truth lives in the source, so faithful replay (AC-1) reads back from it here.
//
// MEMORY (RFC 4.4:88 · D24(i)): we DO NOT load every record's req_body into RAM (that was
// O(total source bytes) ≈ O(N²) resident for an append-only quadratic trace). Instead we build a
// lean `recordId → {file, offset, length}` byte-offset index (a byte-scan that never retains a
// body), then on resolve we seek+read only the ONE needed record's line and slice it. A tiny
// req_body LRU makes rendering a call's many blocks read that call's line once, not per block.
import { open } from 'node:fs/promises';
import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseTextRef } from '../etl/orchestrator.mjs';
import { normalizeRecord } from '../etl/ingest.mjs';
import { isCaptureFile, skipReason } from '../paths.mjs';

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
  if (typeof raw.req_body === 'string') return 'verbatim';   // D10: the captured wire string
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

// Byte-scan a file line-by-line from byte `from`, recording each record's { offset, length } WITHOUT
// retaining any body. Peak memory ≈ one chunk + one line + the index (O(records) small entries).
// Returns { size, ino, end, tail }: `end` = the offset just past the last NEWLINE-terminated line,
// where a refresh resumes; `tail` = what the unterminated last line (a record still being written,
// or a file without a final newline) did to the index, so a refresh can undo it and re-read it whole.
async function indexFile(file, idx, from = 0) {
  const base = path.basename(file);
  const fd = await open(file, 'r');
  try {
    const st = await fd.stat();
    const size = st.size;
    const CHUNK = 1 << 20;
    const buf = Buffer.allocUnsafe(CHUNK);
    let filePos = from, lineStart = from, pending = Buffer.alloc(0);
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
          idx.qual.set(qk, prev === undefined ? loc
            : { dup: true, dupCount: (prev.dupCount || 1) + 1, file });
          // bare-id fallback: first writer wins, a second file poisons the entry to AMBIGUOUS
          const prevB = idx.byId.get(id), setB = prevB === undefined ? loc : AMBIGUOUS;
          idx.byId.set(id, setB);
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
    while (filePos < size) {
      const { bytesRead } = await fd.read(buf, 0, CHUNK, filePos);
      if (!bytesRead) break;
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
      filePos += bytesRead;
    }
    const end = lineStart;
    const tail = record(pending); // trailing line without a newline (null when the file ends in one)
    idx.scan.bytesIndexed = (idx.scan.bytesIndexed || 0) + (filePos - from);
    return { size, ino: st.ino, end, tail };
  } finally { await fd.close(); }
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

// Build resolve(text_ref) -> the block's exact byte slice (or null if unresolvable). Lean: holds a
// byte-offset index + ≤ BODY_LRU cached req_body strings, never the whole corpus.
// `source` may be one path or SEVERAL roots (D27: the new home plus the legacy one that still holds
// the user's captures). Scanning only the first would make raw-byte refs from the other root
// unresolvable — the block viewer would report "record not found" for bytes that are on disk.
export async function buildResolver(source, { retryMs = 30000 } = {}) {
  const roots = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (roots.length > 1) return buildMultiResolver(roots, { retryMs });
  const sourcePath = roots[0];
  const files = [];
  // scan (audit 2026-07-19): the directory walk is non-recursive and .ndjson-only, so a nested
  // or compressed capture is simply INVISIBLE — the "source" shrinks and nobody is told. Keep
  // the same (conservative) selection, but record every entry we declined and why, so the
  // omission is reportable rather than silent.
  const scan = { files, skipped: [], corruptLines: 0, corruptByFile: {}, unidentifiedLines: 0, bytesIndexed: 0 };
  const isDir = statSync(sourcePath).isDirectory();
  const listFiles = async (skipped) => {
    if (!isDir) return [sourcePath];
    const out = [];
    for (const ent of await readdir(sourcePath, { withFileTypes: true })) {
      const name = ent.name;
      // NOT `ent.isFile()`: readdir(withFileTypes) does not follow symlinks, so isFile() is FALSE
      // for a symlinked capture — and a capture reached through a symlink is still a capture. Using
      // isFile() here silently dropped a whole harness from the unified board (the live source dir
      // holds codex-capture.ndjson as a symlink) and mislabelled it "not-ndjson". One rule for the
      // three readers (paths.mjs isCaptureFile); a link to nothing is reported, not opened — opening
      // it failed this root's whole index.
      if (isCaptureFile(sourcePath, ent)) { out.push(path.join(sourcePath, name)); continue; }
      if (!skipped) continue;
      skipped.push({ name, reason: skipReason(sourcePath, ent).reason }); // one classifier, paths.mjs
    }
    return out;
  };
  files.push(...await listFiles(scan.skipped));

  // qual: "<streamBasename>#<recordId>" -> { file, offset, length }  (the authoritative key)
  // byId: "<recordId>" -> loc | AMBIGUOUS                            (back-compat fallback only)
  const idx = { qual: new Map(), byId: new Map(), scan };
  const marks = new Map();     // file -> { size, ino, end, tail } as of its last indexing

  // A file that cannot be read is skipped, not fatal, at startup and on refresh: one unreadable
  // capture must not take down the root's index (or `asight serve`). It is noted in scan.skipped
  // (with its root, once per root + name + reason), which the board shows, and the note is dropped
  // once the file indexes. A read that failed after the open may have indexed some lines, so the
  // root is marked dirty and the next refresh rebuilds it rather than index them twice.
  let dirty = false;
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
  const indexSafe = async (f, from = 0) => {
    const sig = statSig(f); // before the read: a change that lands during it must not be absorbed
    try { const mk = await indexFile(f, idx, from); failedAt.delete(f); unnote((x) => x.root === path.dirname(f) && x.name === path.basename(f)); return mk; }
    catch (e) {
      if (!(e && e.syscall === 'open')) dirty = true;
      failedAt.set(f, { sig, e, at: Date.now() });
      note(path.dirname(f), path.basename(f), 'unreadable', e);
      return null;
    }
  };
  for (const f of [...files]) { const mk = await indexSafe(f); if (mk) marks.set(f, mk); else files.splice(files.indexOf(f), 1); }

  const fds = new Map();       // file -> open fd (reused across resolves)
  const fdFor = (f) => { let fd = fds.get(f); if (fd === undefined) { fd = openSync(f, 'r'); fds.set(f, fd); } return fd; };
  const bodyCache = new Map(); // QUALIFIED key -> normalized req_body string (LRU)

  // Locate the ONE record a ref names. Prefers the qualified key; falls back to the bare id only
  // when that id is unambiguous across the whole source. Never picks a winner among collisions.
  const locate = (stream, recordId) => {
    const q = idx.qual.get(stream + '#' + recordId);
    if (q && q.dup) {
      throw new Error(
        `source: ambiguous record id "${recordId}" — it occurs ${q.dupCount} times inside a SINGLE ` +
        `capture file (${path.basename(q.file)}), so the text_ref names more than one record. This is ` +
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

  // → an OUTCOME, never a bare string: { status, reason, text, fidelity }. `text` is the whole
  // record body; the caller slices it. Statuses: ok | absent | corrupt | no-body.
  const bodyOf = (stream, recordId) => {
    const hit = locate(stream, recordId);             // may throw on ambiguity — deliberately loud
    if (!hit) return OUT('absent', `no record "${recordId}" in stream "${stream}" in this source`);
    if (bodyCache.has(hit.key)) return bodyCache.get(hit.key);
    const { loc } = hit;
    const buf = Buffer.allocUnsafe(loc.length);
    readSync(fdFor(loc.file), buf, 0, loc.length, loc.offset);
    let out;
    try {
      const raw = JSON.parse(buf.toString('utf8'));
      const body = normalizeRecord(raw).req_body;
      out = typeof body === 'string'
        ? OUT('ok', null, body, classifyFidelity(raw))
        // present and readable, but it carries no request body — a real answer ("there are no
        // bytes"), categorically different from "the record is missing" or "the bytes are damaged".
        : OUT('no-body', `record "${recordId}" has no request body (neither req_body nor a v0 request)`);
    } catch (e) {
      // The line was parseable when we indexed it and is not now: the source bytes under this
      // record are DAMAGED (truncated / rewritten / partially flushed). Surface it — reporting
      // damage as absence would let a byte-faithfulness tool hide exactly the loss it exists to
      // detect. No fidelity claim is made about bytes we could not parse.
      out = OUT('corrupt',
        `record "${recordId}" in ${path.basename(loc.file)} @${loc.offset}+${loc.length} could not be ` +
        `parsed back from the source (${e.message}) — the bytes changed since indexing or are damaged`);
    }
    // cache on the QUALIFIED key — a bare-id cache key reintroduced the very collision above
    bodyCache.set(hit.key, out);
    if (bodyCache.size > BODY_LRU) bodyCache.delete(bodyCache.keys().next().value);
    return out;
  };

  // The detailed read: every consumer that wants to LABEL what it renders uses this.
  const detail = (textRef) => {
    if (!textRef) return OUT('no-ref', 'block has no text_ref — nothing points at the source');
    const { rawRef, recordId, start, end } = parseTextRef(textRef);
    const got = bodyOf(streamOfRawRef(rawRef), recordId);
    // A ref with NO byte span addresses the WHOLE record body. `slice(null, null)` returns '', which
    // would hand back empty bytes under an "ok" status — a silently wrong answer from the source-truth
    // resolver. Only slice when a real span was supplied.
    if (got.status !== 'ok') return got;
    return (start == null || end == null) ? got : { ...got, text: got.text.slice(start, end) };
  };

  // Back-compat surface: string-or-null, non-throwing (except the deliberate ambiguity throw).
  const resolve = (textRef) => {
    const got = detail(textRef);
    return got.status === 'ok' ? got.text : null;
  };
  resolve.detail = detail;
  resolve.scan = scan;
  resolve.size = idx.qual.size;
  resolve.dispose = () => { for (const fd of fds.values()) try { closeSync(fd); } catch {} fds.clear(); bodyCache.clear(); };

  // LIVE SOURCES (4.4 #10). The index used to be built once, at startup, so under a running
  // collector a call captured after `asight serve` started was listed by the board but its blocks
  // came back `absent` — bytes on disk reported missing. refresh() brings the index up to date:
  // new files are indexed whole; a grown file is indexed from where the last complete line ended
  // (only the new tail is read, so the cost is the new bytes, not the corpus); a file that shrank
  // or was replaced (inode changed) is not append-only, so the whole index is rebuilt. Concurrent
  // callers share one in-flight refresh. Resolves to true when the index changed.
  let inflight = null;
  const rebuildAll = async () => {
    idx.qual.clear(); idx.byId.clear(); marks.clear(); bodyCache.clear();
    for (const fd of fds.values()) try { closeSync(fd); } catch {}
    fds.clear();
    Object.assign(scan, { corruptLines: 0, corruptByFile: {}, unidentifiedLines: 0 });
    dirty = false; unnote(() => true); // re-noted below if still failing
    files.length = 0;
    for (const f of await listFiles(null)) {
      if (unchangedFailure(f)) { note(path.dirname(f), path.basename(f), 'unreadable', failedAt.get(f).e); continue; }
      const mk = await indexSafe(f); if (mk) { files.push(f); marks.set(f, mk); }
    }
  };
  const doRefresh = async () => {
    let now;
    try { now = await listFiles(null); } catch (e) { note(path.dirname(sourcePath), path.basename(sourcePath), 'unreadable', e); return false; }
    if (isDir) unnote((x) => x.root === path.dirname(sourcePath) && x.name === path.basename(sourcePath)); // the listing note; a file source has none
    unnote((x) => x.reason === 'vanished'); // a pass's own observation; the board's loader reports it live
    if (dirty) { await rebuildAll(); bodyCache.clear(); resolve.size = idx.qual.size; return true; }
    let changed = false;
    for (const f of now) {
      if (unchangedFailure(f)) { note(path.dirname(f), path.basename(f), 'unreadable', failedAt.get(f).e); continue; } // tried again once it changes or retryMs passes
      let st; try { st = statSync(f); } catch (e) { note(path.dirname(f), path.basename(f), 'vanished', e); continue; }
      const m = marks.get(f);
      if (!m) { const mk = await indexSafe(f); if (mk) { files.push(f); marks.set(f, mk); changed = true; } continue; }
      if (st.ino !== m.ino || st.size < m.size) { await rebuildAll(); changed = true; break; }
      if (st.size === m.size) continue;
      undoTail(idx, path.basename(f), m.tail);
      const mk = await indexSafe(f, m.end);
      marks.set(f, mk || { ...m, tail: null }); // tail already taken back: never undo it twice
      changed = true;
    }
    if (changed) { bodyCache.clear(); resolve.size = idx.qual.size; }
    return changed;
  };
  resolve.refresh = () => inflight || (inflight = doRefresh().finally(() => { inflight = null; }));
  return resolve;
}


// Several roots: index each independently and try them in order. Order matters only for a bare-id
// fallback, and the qualified key (`<file>#<id>`) is unaffected, so this cannot invent a winner
// among collisions — a ref that is ambiguous within a root still throws from that root's resolver.
async function buildMultiResolver(roots, opts) {
  const parts = [];
  const unreadable = [];
  for (const r of roots) {
    // FAIL SOFT PER ROOT. A root can be absent, unreadable, or deleted between the caller's existence
    // check and this open — the legacy home is exactly the kind of directory a user tidies away, and
    // the live one is being written to while we read it. One bad root must cost the sessions in that
    // root, never the whole board: throwing here takes down `asight serve` at startup and the user
    // sees a crash where they should see the sessions that ARE readable (invariant 2 — a capture on
    // disk stays readable). What is dropped is recorded so `scan` can report it rather than hide it.
    try { parts.push(Object.assign(await buildResolver(r, opts), { rootPath: r })); }
    catch (e) { unreadable.push({ root: r, reason: (e && e.message) || String(e) }); }
  }
  const resolve = (...args) => {
    let lastErr = null;
    for (const p of parts) {
      try { const hit = p(...args); if (hit) return hit; } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;   // an ambiguity/corruption report must not be swallowed by a miss
    return null;
  };
  const scanOf = () => ({
    files: parts.flatMap((p) => (p.scan && p.scan.files) || []),
    skipped: parts.flatMap((p) => (p.scan && p.scan.skipped) || []),
    corruptLines: parts.reduce((n, p) => n + ((p.scan && p.scan.corruptLines) || 0), 0),
    corruptByFile: Object.assign({}, ...parts.map((p) => (p.scan && p.scan.corruptByFile) || {})),
    unidentifiedLines: parts.reduce((n, p) => n + ((p.scan && p.scan.unidentifiedLines) || 0), 0),
    bytesIndexed: parts.reduce((n, p) => n + ((p.scan && p.scan.bytesIndexed) || 0), 0),
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
  resolve.detail = (...a) => {
    let last = null;
    for (const p of parts) {
      if (typeof p.detail !== 'function') continue;
      const v = p.detail(...a);
      if (v && v.status === 'ok') return v;
      if (v) last = v;
    }
    return last;
  };

  // The server reports `source_resolved` as `resolve.size ? true : false` (RFC 4.4:98). With no size
  // the post-D27 DEFAULT configuration announced its capture source was unreadable while serving from
  // it. Sum the roots: the resolved corpus really is all of them.
  const sizeOf = () => parts.reduce((n, p) => n + (typeof p.size === 'number' ? p.size : 0), 0);
  resolve.size = sizeOf();
  resolve.refresh = async () => {
    let changed = false;
    for (const p of parts) {
      try { if (typeof p.refresh === 'function' && await p.refresh()) changed = true; }
      catch (e) { // later roots still refresh; this one is noted once
        const sk = p.scan && p.scan.skipped, root = path.dirname(p.rootPath), name = path.basename(p.rootPath);
        if (sk && !sk.some((x) => x.root === root && x.name === name && x.reason === 'unreadable')) sk.push({ root, name, reason: 'unreadable', error: (e && e.code) || String(e) });
      }
    }
    if (changed) resolve.size = sizeOf();
    return changed;
  };

  // …and teardown. The old loop forwarded 'close', but a resolver's teardown is `dispose`, so no root
  // was ever closed and every indexed file's fd leaked for the life of the process. Idempotent and
  // non-throwing: shutdown paths overlap, and a failure to close must not mask the reason for the
  // shutdown.
  resolve.dispose = () => { for (const p of parts) { try { p.dispose && p.dispose(); } catch {} } };
  return resolve;
}
