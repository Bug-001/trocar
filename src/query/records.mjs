// src/query/records.mjs — the raw records themselves, for the queries that need more than the index.
//
// The segment index (src/query/index-build.mjs) answers the list queries; `sessions`, `session`, `calls
// --class` and `block` need the envelope, so they read the lines back from the segment. This is the ONE
// place that does it: the records come out as the view layer's readers expect them (the same
// normalizeRecord / expandRequestBody the ETL and the resolver use), stamped with their id
// `<segment>:<line>` (D60) and the file they came from, and nothing else is derived here.
import nodeFs from 'node:fs';
import path from 'node:path';
import { recordId } from '../collector/core/record/segments.mjs';
import { normalizeRecord } from '../etl/ingest.mjs';
import { expandRequestBody } from '../dissect/request-body.mjs';
import { openSealed } from '../raw/reader.mjs';
import { R, FLAG_UNPARSEABLE } from '../raw/format.mjs';
import { allSegments, segmentIndex } from './index-build.mjs';
import { asightHome } from '../paths.mjs';

const NL = 0x0a;

/** Every stored line of one segment file as [lineNo, text] — sealed or plain, the line numbers it was written with.
 *  `all`: keep the lines that were not JSON when they were sealed too — `asight raw` prints bytes, it does not parse them. */
function* lines(file, fs, { all = false } = {}) {
  if (file.endsWith('.sealed')) {
    const sf = openSealed(file, { fs });
    try {
      for (let i = 0; i < sf.count; i++) {
        const r = sf.records[i];
        if (!all && r[R.flags] & FLAG_UNPARSEABLE) continue; // not JSON when it was sealed; the index reports it
        let b = sf.lineAt(i);
        if (b.length && b[b.length - 1] === NL) b = b.subarray(0, b.length - 1);
        if (b.length) yield [Number(r[R.lineNo]) + 1, b.toString('utf8')];
      }
    } finally { sf.close(); }
  } else {
    const parts = fs.readFileSync(file, 'utf8').split('\n');
    if (parts[parts.length - 1] !== '') parts.pop(); // a half line at the end is still being written (4.6 §记录)
    for (let i = 0; i < parts.length; i++) if (parts[i]) yield [i + 1, parts[i]];
  }
}

function recordOf(text, segment, lineNo, stream) {
  const rec = normalizeRecord(expandRequestBody(JSON.parse(text)));
  const out = { ...rec, id: recordId(segment, lineNo) };
  // `_stream` is non-enumerable everywhere it is stamped (src/etl/ingest.mjs): it says which file the
  // bytes are in, for a block's ref, and must never appear in a shipped document.
  Object.defineProperty(out, '_stream', { value: stream, enumerable: false, configurable: true });
  return out;
}

/**
 * allRecords({home, fs, errors}) → every record of every segment, oldest segment first.
 * A segment or a line it cannot read goes into `errors` (D38), never silently missing.
 */
export async function allRecords({ home = asightHome(), fs = nodeFs, errors = [] } = {}) {
  const out = [];
  for (const s of await allSegments({ home, fs })) {
    for (const pr of s.problems) errors.push({ where: `segments/${s.segment}`, reason: `${pr.code}: ${pr.reason}` });
    const stream = path.basename(s.path);
    try {
      for (const [no, text] of lines(s.path, fs)) {
        try { out.push(recordOf(text, s.segment, no, stream)); }
        catch (e) { errors.push({ where: recordId(s.segment, no), reason: `cannot be read back: ${String((e && e.message) || e)}` }); }
      }
    } catch (e) { errors.push({ where: `segments/${s.segment}`, reason: `cannot be read: ${String((e && e.message) || e)}` }); }
  }
  return out;
}

/**
 * recordsAt({home, rows}) → the raw records of the given index rows (src/query/rows.mjs), in the order given.
 * ONE record costs one seek: a plaintext segment is read at the row's byte offset for exactly its stored
 * bytes, a sealed one decodes that record's frame only — so `session` and `block` pay for the records they
 * answer with, never for the segment (1.6 §4.1 速度目标: `session` ≤ 1 s, `block` ≤ 0.3 s).
 * A row whose record cannot be read goes into `errors` (D38), never silently missing.
 */
export function recordsAt({ home = asightHome(), fs = nodeFs, rows = [], errors = [] } = {}) {
  const bySegment = new Map();
  for (const r of rows) { if (!bySegment.has(r.segment)) bySegment.set(r.segment, []); bySegment.get(r.segment).push(r); }
  const out = [];
  for (const [segment, rs] of bySegment) {
    const file = segmentFile({ home, fs, segment });
    const stream = path.basename(file);
    let read;
    try { read = file.endsWith('.sealed') ? sealedReader(file, fs) : plainReader(file, fs); }
    catch (e) { for (const r of rs) errors.push({ where: r.id, reason: `cannot be read: ${String((e && e.message) || e)}` }); continue; }
    try {
      for (const r of rs) {
        try { out.push(recordOf(read(r), segment, r.lineNo, stream)); }
        catch (e) { errors.push({ where: r.id, reason: `cannot be read back: ${String((e && e.message) || e)}` }); }
      }
    } finally { read.close(); }
  }
  return out;
}

// The plaintext at a row's own offset, exactly its stored bytes; a row from an index that has no offset
// (a segment sealed when the row was written) falls back to the line scan.
function plainReader(file, fs) {
  const fd = fs.openSync(file, 'r');
  let all = null;
  const read = (r) => {
    if (r.offset == null || r.stored_bytes == null) {
      if (!all) all = [...lines(file, fs, { all: true })];
      const hit = all.find(([no]) => no === r.lineNo);
      if (!hit) throw new Error(`line ${r.lineNo} is not in ${path.basename(file)}`);
      return hit[1];
    }
    const buf = Buffer.allocUnsafe(r.stored_bytes);
    const n = fs.readSync(fd, buf, 0, r.stored_bytes, r.offset);
    return buf.subarray(0, n).toString('utf8');
  };
  read.close = () => fs.closeSync(fd);
  return read;
}

// A sealed segment knows where every record is: its own index names the line number of each frame.
function sealedReader(file, fs) {
  const sf = openSealed(file, { fs });
  const at = new Map();
  for (let i = 0; i < sf.count; i++) at.set(Number(sf.records[i][R.lineNo]) + 1, i);
  const read = (r) => {
    const i = at.get(r.lineNo);
    if (i === undefined) throw new Error(`line ${r.lineNo} is not in ${path.basename(file)}`);
    let b = sf.lineAt(i);
    if (b.length && b[b.length - 1] === NL) b = b.subarray(0, b.length - 1);
    return b.toString('utf8');
  };
  read.close = () => sf.close();
  return read;
}

/**
 * readRecord({home, segment, lineNo}) → the raw envelope of that record (decoded bodies, nothing else
 * derived), or null when the segment holds no such line. The segment index says where the record is, so
 * neither the segment nor its index is scanned for it.
 */
export async function readRecord({ home = asightHome(), fs = nodeFs, segment, lineNo } = {}) {
  const { records } = await segmentIndex({ home, segment, fs });
  const row = records.find((r) => r.id === recordId(segment, lineNo));
  if (!row) return null;
  const file = segmentFile({ home, fs, segment });
  const read = file.endsWith('.sealed') ? sealedReader(file, fs) : plainReader(file, fs);
  try { return expandRequestBody(JSON.parse(read({ ...row, lineNo }))); } finally { read.close(); }
}

/** The file a segment's bytes are in: the plaintext while it exists (4.2:30 明文为准), else the sealed copy. */
function segmentFile({ home, fs, segment }) {
  const plain = path.join(home, 'raw', `${segment}.ndjson`);
  const sealed = path.join(home, 'raw', `${segment}.sealed`);
  const file = fs.existsSync(plain) ? plain : sealed;
  if (!fs.existsSync(file)) throw new Error(`there is no segment ${segment} in ${path.join(home, 'raw')}`);
  return file;
}

/**
 * segmentLines({home, segment}) → [lineNo, text] of one segment, verbatim as it was captured (`asight raw`, 1.6 §5.1):
 * a sealed segment is decoded first, and nothing is parsed. Throws when there is no such segment.
 */
export function* segmentLines({ home = asightHome(), fs = nodeFs, segment } = {}) {
  yield* lines(segmentFile({ home, fs, segment }), fs, { all: true });
}
