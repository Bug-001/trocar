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
          idx.qual.set(base + '#' + id, loc);
          // bare-id fallback: first writer wins, a second file poisons the entry to AMBIGUOUS
          idx.byId.set(id, idx.byId.has(id) ? AMBIGUOUS : loc);
        }
      } catch {}
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
export async function buildResolver(sourcePath) {
  const files = [];
  if (statSync(sourcePath).isDirectory()) {
    for (const f of await readdir(sourcePath)) if (f.endsWith('.ndjson')) files.push(path.join(sourcePath, f));
  } else files.push(sourcePath);

  // qual: "<streamBasename>#<recordId>" -> { file, offset, length }  (the authoritative key)
  // byId: "<recordId>" -> loc | AMBIGUOUS                            (back-compat fallback only)
  const idx = { qual: new Map(), byId: new Map() };
  for (const f of files) await indexFile(f, idx);

  const fds = new Map();       // file -> open fd (reused across resolves)
  const fdFor = (f) => { let fd = fds.get(f); if (fd === undefined) { fd = openSync(f, 'r'); fds.set(f, fd); } return fd; };
  const bodyCache = new Map(); // QUALIFIED key -> normalized req_body string (LRU)

  // Locate the ONE record a ref names. Prefers the qualified key; falls back to the bare id only
  // when that id is unambiguous across the whole source. Never picks a winner among collisions.
  const locate = (stream, recordId) => {
    const q = idx.qual.get(stream + '#' + recordId);
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

  const bodyOf = (stream, recordId) => {
    const hit = locate(stream, recordId);             // may throw on ambiguity — deliberately loud
    if (!hit) return null;
    if (bodyCache.has(hit.key)) return bodyCache.get(hit.key);
    const { loc } = hit;
    const buf = Buffer.allocUnsafe(loc.length);
    readSync(fdFor(loc.file), buf, 0, loc.length, loc.offset);
    let body = null;
    try { body = normalizeRecord(JSON.parse(buf.toString('utf8'))).req_body; } catch {}
    // cache on the QUALIFIED key — a bare-id cache key reintroduced the very collision above
    bodyCache.set(hit.key, body);
    if (bodyCache.size > BODY_LRU) bodyCache.delete(bodyCache.keys().next().value);
    return body;
  };

  const resolve = (textRef) => {
    if (!textRef) return null;
    const { rawRef, recordId, start, end } = parseTextRef(textRef);
    const body = bodyOf(streamOfRawRef(rawRef), recordId);
    return typeof body === 'string' ? body.slice(start, end) : null;
  };
  resolve.size = idx.qual.size;
  resolve.dispose = () => { for (const fd of fds.values()) try { closeSync(fd); } catch {} fds.clear(); bodyCache.clear(); };
  return resolve;
}
