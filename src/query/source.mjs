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

// Byte-scan a file line-by-line, recording each record's { offset, length } WITHOUT retaining any
// body. Peak memory ≈ one chunk + one line + the index (O(records) small entries).
async function indexFile(file, idx) {
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
      try { const id = JSON.parse(lineBuf.toString('utf8')).id; if (id != null) idx.set(String(id), { file, offset: lineStart, length: lineBuf.length }); } catch {}
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

  const idx = new Map(); // recordId -> { file, offset, length }
  for (const f of files) await indexFile(f, idx);

  const fds = new Map();       // file -> open fd (reused across resolves)
  const fdFor = (f) => { let fd = fds.get(f); if (fd === undefined) { fd = openSync(f, 'r'); fds.set(f, fd); } return fd; };
  const bodyCache = new Map(); // recordId -> normalized req_body string (LRU)

  const bodyOf = (recordId) => {
    if (bodyCache.has(recordId)) return bodyCache.get(recordId);
    const loc = idx.get(recordId);
    if (!loc) return null;
    const buf = Buffer.allocUnsafe(loc.length);
    readSync(fdFor(loc.file), buf, 0, loc.length, loc.offset);
    let body = null;
    try { body = normalizeRecord(JSON.parse(buf.toString('utf8'))).req_body; } catch {}
    bodyCache.set(recordId, body);
    if (bodyCache.size > BODY_LRU) bodyCache.delete(bodyCache.keys().next().value);
    return body;
  };

  const resolve = (textRef) => {
    if (!textRef) return null;
    const { recordId, start, end } = parseTextRef(textRef);
    const body = bodyOf(recordId);
    return typeof body === 'string' ? body.slice(start, end) : null;
  };
  resolve.size = idx.size;
  resolve.dispose = () => { for (const fd of fds.values()) try { closeSync(fd); } catch {} fds.clear(); bodyCache.clear(); };
  return resolve;
}
