// src/collector/core/record/segments.mjs — names and record ids of the raw layer's segments (D60①, RFC 4.6 §记录).
// A segment is `~/.trocar/raw/<segment>.ndjson` while it is plain text and `<segment>.sealed` once sealed; a record is
// named `<segment>:<line>` (line from 1), and that name does not change when the segment is sealed (V88).
const NAME = String.raw`\d{8}T\d{6}Z(?:-\d+)?` // the opening instant in UTC, plus the suffix a collision takes
const FILE = new RegExp(`^(${NAME})\\.(ndjson|sealed)$`)
const ID = new RegExp(`^(${NAME}):([1-9]\\d*)$`)

export const SEGMENT_BYTES = 128 << 20 // a segment is closed once it has grown past this (1.6 §5.1)

/** The name of a segment opened at `date`: the UTC instant, and `-2`, `-3` … while `taken` already holds it. */
export const segmentName = (date, taken = []) => {
  const base = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`
  return name
}

/** `{ segment, sealed }` for a segment file's basename, null for anything else in raw/ (journal, locks, temp files). */
export const parseSegment = (basename) => {
  const m = FILE.exec(basename)
  return m ? { segment: m[1], sealed: m[2] === 'sealed' } : null
}

export const recordId = (segment, lineNo) => `${segment}:${lineNo}`

/** `{ segment, lineNo }` for a record id, null when it is not one (an id from an older location, say). */
export const parseRecordId = (id) => {
  const m = ID.exec(String(id))
  return m ? { segment: m[1], lineNo: Number(m[2]) } : null
}
