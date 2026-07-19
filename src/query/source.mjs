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
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseTextRef } from '../etl/orchestrator.mjs';
import { normalizeRecord } from '../etl/ingest.mjs';

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
const COMPRESSED = new Set(['.gz', '.zst', '.bz2', '.xz', '.zip', '.br', '.lz4']);

// Byte-scan a file line-by-line, recording each record's { offset, length } WITHOUT retaining any
// body. Peak memory ≈ one chunk + one line + the index (O(records) small entries).
async function indexFile(file, idx) {
  const base = path.basename(file);
  const fd = await open(file, 'r');
  try {
    const size = (await fd.stat()).size;
    const CHUNK = 1 << 20;
    const buf = Buffer.allocUnsafe(CHUNK);
    let filePos = 0, lineStart = 0, pending = Buffer.alloc(0);
    const record = (lineBuf) => {
      if (!lineBuf.length) return;
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
          idx.byId.set(id, idx.byId.has(id) ? AMBIGUOUS : loc);
        } else {
          // parseable, but nothing to key on — indexable content silently dropped. Report it.
          idx.scan.unidentifiedLines++;
        }
      } catch {
        // A corrupt NDJSON line can never be indexed, so it can never surface per-record: the
        // record it was meant to carry just looks ABSENT. Count it so the omission is at least
        // reportable at scan level (invariant 4 — never let a loss be invisible).
        idx.scan.corruptLines++;
        idx.scan.corruptByFile[base] = (idx.scan.corruptByFile[base] || 0) + 1;
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
    record(pending); // trailing line without a newline
  } finally { await fd.close(); }
}

// Build resolve(text_ref) -> the block's exact byte slice (or null if unresolvable). Lean: holds a
// byte-offset index + ≤ BODY_LRU cached req_body strings, never the whole corpus.
// `source` may be one path or SEVERAL roots (D27: the new home plus the legacy one that still holds
// the user's captures). Scanning only the first would make raw-byte refs from the other root
// unresolvable — the block viewer would report "record not found" for bytes that are on disk.
export async function buildResolver(source) {
  const roots = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (roots.length > 1) return buildMultiResolver(roots);
  const sourcePath = roots[0];
  const files = [];
  // scan (audit 2026-07-19): the directory walk is non-recursive and .ndjson-only, so a nested
  // or compressed capture is simply INVISIBLE — the "source" shrinks and nobody is told. Keep
  // the same (conservative) selection, but record every entry we declined and why, so the
  // omission is reportable rather than silent.
  const scan = { files, skipped: [], corruptLines: 0, corruptByFile: {}, unidentifiedLines: 0 };
  if (statSync(sourcePath).isDirectory()) {
    for (const ent of await readdir(sourcePath, { withFileTypes: true })) {
      const name = ent.name;
      // NOT `ent.isFile()`: readdir(withFileTypes) does not follow symlinks, so isFile() is FALSE
      // for a symlinked capture — and a capture reached through a symlink is still a capture. Using
      // isFile() here silently dropped a whole harness from the unified board (the live source dir
      // holds codex-capture.ndjson as a symlink) and mislabelled it "not-ndjson". Exclude only what
      // we can positively identify as a directory.
      if (!ent.isDirectory() && name.endsWith('.ndjson')) { files.push(path.join(sourcePath, name)); continue; }
      const reason = ent.isDirectory() ? 'directory'
        : COMPRESSED.has(path.extname(name).toLowerCase()) ? 'compressed'
        : 'not-ndjson';
      scan.skipped.push({ name, reason });
    }
  } else files.push(sourcePath);

  // qual: "<streamBasename>#<recordId>" -> { file, offset, length }  (the authoritative key)
  // byId: "<recordId>" -> loc | AMBIGUOUS                            (back-compat fallback only)
  const idx = { qual: new Map(), byId: new Map(), scan };
  for (const f of files) await indexFile(f, idx);

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
  return resolve;
}


// Several roots: index each independently and try them in order. Order matters only for a bare-id
// fallback, and the qualified key (`<file>#<id>`) is unaffected, so this cannot invent a winner
// among collisions — a ref that is ambiguous within a root still throws from that root's resolver.
async function buildMultiResolver(roots) {
  const parts = [];
  for (const r of roots) parts.push(await buildResolver(r));
  const resolve = (...args) => {
    let lastErr = null;
    for (const p of parts) {
      try { const hit = p(...args); if (hit) return hit; } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;   // an ambiguity/corruption report must not be swallowed by a miss
    return null;
  };
  resolve.scan = {
    files: parts.flatMap((p) => (p.scan && p.scan.files) || []),
    skipped: parts.flatMap((p) => (p.scan && p.scan.skipped) || []),
    corruptLines: parts.reduce((n, p) => n + ((p.scan && p.scan.corruptLines) || 0), 0),
    corruptByFile: Object.assign({}, ...parts.map((p) => (p.scan && p.scan.corruptByFile) || {})),
    unidentifiedLines: parts.reduce((n, p) => n + ((p.scan && p.scan.unidentifiedLines) || 0), 0),
  };
  for (const k of ['detail', 'close']) {
    if (typeof parts[0]?.[k] === 'function') {
      resolve[k] = (...a) => { for (const p of parts) { const v = p[k](...a); if (k === 'detail' && v) return v; } return null; };
    }
  }
  return resolve;
}
