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
import { basename } from 'node:path';
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

// SKIPPED LINES (audit 2026-07-19 · invariant 4 — a loss MUST NOT be invisible) ─────────────────
// A capture is an APPEND-ONLY file being written while the session runs, so a TORN FINAL LINE is
// the normal mid-session state, not an exception. The old bare `catch {}` dropped such a line
// silently: the returned array was quietly short and nothing anywhere said so. For a tool whose
// entire claim is "what you see IS what went over the wire", an unreported omission is the worst
// outcome — worse than a visible failure. So corrupt lines are now COUNTED and DESCRIBED.
//
// The return value deliberately stays a plain Array — every caller consumes it as one
// (bin/asight.mjs:171 `.length`, src/server.mjs:140 re-pushes into its own array, src/etl/cli.mjs:13,
// plus the capture/adapters/query/view suites). Changing the shape to {records, scan} would break
// all of them, so the report rides ALONGSIDE as a NON-ENUMERABLE `.scan` property: invisible to
// spread / JSON.stringify / for…in, readable by anyone who asks. Callers that concatenate several
// files' arrays lose that property by construction, so `onSkip` gives them a push-based channel.
const EXCERPT = 160;

// `startOffset` — READ ONLY WHAT ARRIVED SINCE LAST TIME (spec 4.2:49).
//
// The streams are append-only, so "what is new" is exactly `size - lastOffset`. Without this the
// board re-read and re-parsed every capture file on every refresh: measured on a real 6.88 GB
// capture, 286 MB parses in 2,931 ms against a 70 ms read, i.e. ~70 s of pure JSON.parse per refresh
// with every record resident at once — which is why `asight serve` could not open it at all.
//
// The caller owns the watermark and MUST reset it to 0 when the file shrinks or is replaced
// (rotation, restore, a new capture reusing the name); see src/server.mjs::makeRecordLoader. This
// function's own contract is narrower and defensive: start where told, and never emit a record from
// a partial line — an offset landing mid-record must drop that fragment rather than half-parse it.
export async function readRecords(filePath, { normalize = true, limit = Infinity, onSkip = null, startOffset = 0 } = {}) {
  const out = [];
  // skipped: one entry per line that carried a record we could NOT recover. blankLines are tracked
  // separately and are NOT a loss (whitespace carries no record) — conflating them would cry wolf.
  const scan = { file: filePath, parsedLines: 0, blankLines: 0, skippedLines: 0, skipped: [], startOffset };
  const start = Number(startOffset) > 0 ? Number(startOffset) : 0;
  if (start > 0) {
    // Past EOF is an EMPTY read, not an error: it is the normal steady state (nothing new since the
    // last poll) and also what a stale watermark on a shrunken file looks like.
    let size = 0;
    try { size = (await import('node:fs')).statSync(filePath).size; } catch { return out; }
    if (start >= size) return out;
  }
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8', start }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const s = line.trim();
    if (!s) { scan.blankLines++; continue; }
    let raw;
    try {
      raw = JSON.parse(s);
    } catch (e) {
      scan.skippedLines++;
      // Bounded excerpt: enough to diagnose (which record, where it tore) without ever retaining a
      // whole body — these files run to gigabytes and a torn line can itself be huge.
      const info = { line: lineNo, bytes: Buffer.byteLength(s, 'utf8'), excerpt: s.slice(0, EXCERPT), error: e.message };
      scan.skipped.push(info);
      if (onSkip) onSkip({ file: filePath, ...info });
      continue;
    }
    scan.parsedLines++;
    const rec = normalize ? normalizeRecord(raw) : raw;
    // Which FILE these bytes came from. A text_ref is `<session>/<stream>#<id>::<start>-<end>`
    // (RFC 4.2:40) and the stream basename is the half that disambiguates: record ids are only
    // unique within a capture file. The record itself never carries it — only the reader knows —
    // so stamp it here, non-enumerably: invisible to JSON.stringify, so no stored or shipped shape
    // changes, but available to anything that has to mint a locator back to these bytes.
    if (rec && typeof rec === 'object' && !Object.prototype.hasOwnProperty.call(rec, '_stream')) {
      Object.defineProperty(rec, '_stream', { value: basename(filePath), enumerable: false, configurable: true });
    }
    out.push(rec);
    if (out.length >= limit) { rl.close(); break; } // bounded read (e.g. the self-test samples a head)
  }
  Object.defineProperty(out, 'scan', { value: scan, enumerable: false, configurable: true });
  return out;
}
