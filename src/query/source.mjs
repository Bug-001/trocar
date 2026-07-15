// src/query/source.mjs — resolve a block's text_ref back to its VERBATIM bytes in the
// source NDJSON. The derived store holds NO fulltext (invariant 2: only a pointer); the
// verbatim truth lives in the source, so faithful replay (AC-1) reads back from it here.
// Uses the SAME normalizeRecord as the ETL → the server's req_body strings are byte-identical
// to what the spans were computed against.
import { readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { parseTextRef } from '../etl/orchestrator.mjs';
import { readRecords } from '../etl/ingest.mjs';

// Build an id -> verbatim req_body map from a source NDJSON file (or a dir of them),
// and return resolve(text_ref) -> the block's exact byte slice (or null if unresolvable).
export async function buildResolver(sourcePath) {
  const files = [];
  if (statSync(sourcePath).isDirectory()) {
    for (const f of await readdir(sourcePath)) if (f.endsWith('.ndjson')) files.push(path.join(sourcePath, f));
  } else files.push(sourcePath);
  const byId = new Map();
  for (const f of files) for (const r of await readRecords(f)) if (r.id != null) byId.set(r.id, r.req_body);
  const resolve = (textRef) => {
    if (!textRef) return null;
    const { recordId, start, end } = parseTextRef(textRef);
    const body = byId.get(recordId);
    if (typeof body !== 'string') return null;
    return body.slice(start, end);
  };
  resolve.size = byId.size;
  return resolve;
}
