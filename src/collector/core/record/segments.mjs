// src/collector/core/record/segments.mjs — segment names and record ids (D59, RFC 4.6 §记录).
// A record id is `<segment>:<lineNo>` with lineNo 1-based, and it does not change when the segment is
// sealed (1.6 §4.1 「id」) — the sealed index keeps every line's number.
//
// shortcut: this is T6's stand-in holding only the NAME/ID primitives the read side needs;
// T2 owns the write path (rotation at SEGMENT_BYTES, opening a new segment at startup) in this file.

export const SEGMENT_BYTES = 128 << 20;

// YYYYMMDDTHHMMSSZ, with -2 / -3 … when that second already has a segment
const STAMP = /^\d{8}T\d{6}Z(?:-\d+)?$/;

export const segmentName = (date, taken = []) => {
  const base = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base}-${n}`)) return `${base}-${n}`;
};

/** A file name in ~/.asight/raw/ → `{ segment, sealed }`, or null when it is not a segment of ours. */
export const parseSegment = (basename) => {
  for (const [ext, sealed] of [['.ndjson', false], ['.sealed', true]]) {
    if (!basename.endsWith(ext)) continue;
    const segment = basename.slice(0, -ext.length);
    if (STAMP.test(segment)) return { segment, sealed };
  }
  return null;
};

export const recordId = (segment, lineNo) => `${segment}:${lineNo}`;

export const parseRecordId = (id) => {
  const s = String(id), at = s.lastIndexOf(':');
  if (at < 0) return null;
  const segment = s.slice(0, at), lineNo = Number(s.slice(at + 1));
  return STAMP.test(segment) && Number.isInteger(lineNo) && lineNo > 0 ? { segment, lineNo } : null;
};
