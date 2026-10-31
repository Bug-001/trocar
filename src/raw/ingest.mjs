// src/raw/ingest.mjs — read an NDJSON capture stream into D10 envelope records, tolerating
// BOTH the product's D10 shape (req_body = verbatim STRING) and the demo v0 shape
// (request/request_headers/response, parsed objects). The v0→D10 bridge is SHARED by the
// ETL CLI and the server's text resolver so both derive byte-identical req_body strings
// (JSON.stringify is deterministic for the same JSON.parse'd object).
//
// FIDELITY (invariant 4): a record whose request was a parsed object carries capture:'v0-converted' —
// its req_body is RE-SERIALIZED, not the original wire bytes, so no block is addressed into it
// (view/assemble.mjs spanBody): its blocks ship inline and say so, and the board draws the window line.
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { isSealedPath } from '../raw/discover.mjs';
import { openSealed } from '../raw/reader.mjs';
import { expandRequestBody } from '../dissect/request-body.mjs';

// What a record whose req_body was rebuilt from a parsed request says it is, whatever capture it carried (view/assemble.mjs spanBody).
export const V0_CONVERTED = 'v0-converted';

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
    capture: request && typeof request === 'object' ? V0_CONVERTED : raw.capture || V0_CONVERTED,
  };
}

// SKIPPED LINES (invariant 4 — a loss MUST NOT be invisible) ─────────────────
// A capture is an APPEND-ONLY file being written while the session runs, so a TORN FINAL LINE is
// the normal mid-session state, not an exception. The old bare `catch {}` dropped such a line
// silently: the returned array was quietly short and nothing anywhere said so. For a tool whose
// entire claim is "what you see IS what went over the wire", an unreported omission is the worst
// outcome — worse than a visible failure. So corrupt lines are now COUNTED and DESCRIBED.
//
// The return value deliberately stays a plain Array — every caller consumes it as one
// (bin/trocar.mjs:171 `.length`, src/server.mjs:140 re-pushes into its own array,
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
// with every record resident at once — which is why the board could not open it at all.
//
// The caller owns the watermark and MUST reset it to 0 when the file shrinks or is replaced
// (rotation, restore, a new capture reusing the name); see src/server.mjs::makeRecordLoader. This
// function's own contract is narrower and defensive: start where told, and never emit a record from
// a partial line — an offset landing mid-record must drop that fragment rather than half-parse it.
export async function readRecords(filePath, { normalize = true, limit = Infinity, onSkip = null, startOffset = 0, endOffset = Infinity } = {}) {
  const out = [];
  // skipped: one entry per line that carried a record we could NOT recover. blankLines are tracked
  // separately and are NOT a loss (whitespace carries no record) — conflating them would cry wolf.
  const sealed = isSealedPath(filePath);
  const scan = { file: filePath, parsedLines: 0, blankLines: 0, skippedLines: 0, skipped: [], startOffset, ...(sealed ? { sealed: true } : {}) };
  let lineNo = 0;
  // One line (readline's view of it: no "\n", CRLF folded) → a record, a blank, or a reported skip.
  // Returns false once `limit` is reached.
  const take = (line, stream, bytes) => {
    lineNo++;
    const s = line.trim();
    if (!s) { scan.blankLines++; return true; }
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
      return true;
    }
    scan.parsedLines++;
    // a request body the collector left compressed is decoded here, once, for every reader (4.6 §记录, 3.2:132)
    const rec = normalize ? normalizeRecord(expandRequestBody(raw)) : expandRequestBody(raw);
    // Which FILE these bytes came from. A text_ref is `<session>/<stream>#<id>::<start>-<end>`
    // (RFC 4.2:40) and the stream basename is the half that disambiguates: record ids are only
    // unique within a capture file. The record itself never carries it — only the reader knows —
    // so stamp it here, non-enumerably: invisible to JSON.stringify, so no stored or shipped shape
    // changes, but available to anything that has to mint a locator back to these bytes. For a
    // sealed file it is the record's ORIGINAL stream from the index (4.2:39), never the sealed name.
    if (rec && typeof rec === 'object' && !Object.prototype.hasOwnProperty.call(rec, '_stream')) {
      Object.defineProperty(rec, '_stream', { value: stream, enumerable: false, configurable: true });
    }
    // D40 (3.2 calls.record_bytes): how many bytes this record's line takes on disk, trailing newline included — the
    // stored size a per-class size view adds up. Stamped like _stream: never part of the record as captured. The same
    // formula for a plain file and a sealed one, so the number does not change when a shard is sealed.
    if (rec && typeof rec === 'object' && bytes != null) Object.defineProperty(rec, '_bytes', { value: bytes, enumerable: false, configurable: true });
    out.push(rec);
    return out.length < limit; // bounded read (e.g. the self-test samples a head)
  };
  Object.assign(scan, await forEachLine(filePath, take, { startOffset, endOffset }));
  Object.defineProperty(out, 'scan', { value: scan, enumerable: false, configurable: true });
  return out;
}

// Every line of a capture file as readline sees it — an NDJSON stream, or a sealed file decoded frame
// by frame (never whole in memory, 4.6 §日志体积预算) and cut the same way — with the stream it came
// from (for a sealed file, each record's ORIGINAL stream) and its size on disk (`onLine(text, stream, bytes)`, D40). The one line source of readRecords (board,
// ETL, doctor), `trocar shard --rebuild-meta` and `trocar raw compare`, so they count the same lines
// (review 3 F11, F1). `onLine(text, stream)` returns false to stop. Returns what a sealed read could
// not do — { sealedError } or { unreadableRecords, unreadable } — counted, never a silently short read
// (user requirement 2026-10-06; callers label it: the ETL journals it, the board reports it).
export async function forEachLine(filePath, onLine, { startOffset = 0, endOffset = Infinity } = {}) {
  const sealed = isSealedPath(filePath);
  const start = Number(startOffset) > 0 ? Number(startOffset) : 0;
  if (start > 0) {
    // Past EOF is an EMPTY read, not an error: it is the normal steady state (nothing new since the
    // last poll) and also what a stale watermark on a shrunken file looks like.
    let size = 0;
    try { size = statSync(filePath).size; } catch { return {}; }
    if (start >= size) return {};
    // A sealed file never grows (D35); a byte offset inside it addresses no line boundary.
    if (sealed) throw new Error(`${filePath}: a sealed file is read whole — startOffset ${start} lies inside it`);
  }
  if (!sealed) {
    // endOffset (exclusive): a live reader stops at the end of the last complete line, so a record the
    // writer is still writing is read whole on the next pass instead of torn now (server.mjs). A plain
    // file only: a sealed file never grows and is read whole (D35).
    if (Number.isFinite(endOffset) && endOffset <= start) return {};
    const end = Number.isFinite(endOffset) ? { end: endOffset - 1 } : {};
    const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8', start, ...end }), crlfDelay: Infinity });
    const stream = basename(filePath);
    for await (const line of rl) if (onLine(line, stream, lineBytes(line)) === false) { rl.close(); break; }
    return {};
  }
  let sf;
  try { sf = openSealed(filePath); } catch (e) { return { sealedError: e.message }; }
  const rep = { unreadableRecords: 0, unreadable: [] };
  const onError = (i, e, ent) => {
    rep.unreadableRecords++;
    if (rep.unreadable.length < 20) rep.unreadable.push({ record: i, lineNo: ent.lineNo, id: ent.id, stream: ent.stream, reason: e.message });
  };
  try {
    outer: for (const { line, entry } of sf.lines({ onError })) {
      for (const piece of readlinePieces(line, entry.newline)) if (onLine(piece, entry.stream, lineBytes(piece)) === false) break outer;
    }
  } finally { sf.close(); }
  return rep;
}

// A line's size on disk as the readers count it: its text as UTF-8 plus the newline readline took off (the last line of a
// file without one is counted with it; a few bytes in a whole capture, and the same for plain and sealed files).
const lineBytes = (text) => Buffer.byteLength(text, 'utf8') + 1;

// readline (crlfDelay: Infinity) breaks lines at "\n", "\r\n" and a lone "\r", and drops a "\r" at
// EOF. A sealed record is one source line up to and including its "\n"; this cuts it the same way.
function readlinePieces(buf, newline) {
  let t = buf.toString('utf8');
  if (newline) t = t.slice(0, -1);
  if (t.endsWith('\r')) t = t.slice(0, -1);
  return t.split('\r');
}
