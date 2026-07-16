// src/etl/ingest.mjs — read an NDJSON capture stream into D10 envelope records, tolerating
// BOTH the product's D10 shape (req_body = verbatim STRING) and the demo v0 shape
// (request/request_headers/response, parsed objects). The v0→D10 bridge is SHARED by the
// ETL CLI and the server's text resolver so both derive byte-identical req_body strings
// (JSON.stringify is deterministic for the same JSON.parse'd object → spans stay aligned).
//
// FIDELITY (invariant 4): v0-converted records carry capture:'v0-converted' — req_body is
// RE-SERIALIZED, not the original wire bytes (demo stored parsed JSON), so AC-1 holds
// against this converted source, NOT against the lost original wire. UI/README MUST label it.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// True D10 record → passthrough. Demo v0 record → convert. Anything else → passthrough.
export function normalizeRecord(raw) {
  if (typeof raw.req_body === 'string') return raw; // already D10
  if (raw.request === undefined) return raw; // not a v0 llm record; leave as-is
  const { request, response, request_headers, ...rest } = raw;
  const req_body = request == null ? '' : (typeof request === 'string' ? request : JSON.stringify(request));
  return {
    ...rest,
    method: raw.method || 'POST',
    req_headers: request_headers || {},
    req_body,
    resp: response || { kind: 'error', status: null },
    capture: raw.capture || 'v0-converted',
  };
}

// Stream NDJSON line-by-line (readline — never readFileSync a whole large trace; V8's
// ~512MB single-string cap bites otherwise). Returns an array of (optionally normalized)
// records. Blank / unparseable lines are skipped.
export async function readRecords(filePath, { normalize = true, limit = Infinity } = {}) {
  const out = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let raw;
    try { raw = JSON.parse(s); } catch { continue; }
    out.push(normalize ? normalizeRecord(raw) : raw);
    if (out.length >= limit) { rl.close(); break; } // bounded read (e.g. the self-test samples a head)
  }
  return out;
}
