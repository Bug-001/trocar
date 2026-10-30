// src/raw/seal.mjs — the D35 sealer (RFC 4.2 §自动封存).
//
// Re-encodes ONE closed segment, losslessly, into `<segment>.sealed` beside it. Besides appending and a same-device
// rename (D27③), this is the only write ever allowed on a source file — and it only ever deletes the plaintext after
// the sealed file is proven to rebuild it byte for byte (invariant 2). The order is the MUST:
//
//   temp (0600 at open, in raw/) → write → fsync → decode EVERY record and compare sha256, plus the whole file's
//   length and sha256 → rename to `<segment>.sealed` → fsync dir → only then unlink the plaintext → fsync dir.
//
// A crash at any point leaves the plaintext (alone, or next to a sealed file readers ignore while it exists): the
// plaintext wins and the segment is simply sealed again, over that file. A failed verification keeps the plaintext.
// Only the daemon's queue calls this (src/collector/seal-queue.mjs) — one daemon per user, one segment at a time, so
// there is no seal lock. The daemon's lock is read anyway: the segment it names is refused (defence in depth).
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createSealWriter, FRAME_BYTES } from './writer.mjs';
import { openSealed } from './reader.mjs';
import { appendJournal } from './journal.mjs';
import { VERSION } from './format.mjs';
import { parseSegment } from '../collector/core/record/segments.mjs';
import { fsyncDir } from '../off/fsutil.mjs';

export class SealRefused extends Error { constructor(m) { super(m); this.name = 'SealRefused'; this.code = 'SEAL_REFUSED'; } }

export const SEALED_EXT = '.sealed';
const CHUNK = 8 << 20;

// The segment the live daemon is appending to, from its lock (4.6 §控制面 `lock`), or null when there is no readable
// lock. A lock that cannot be read never licenses a seal: `sealOne` only compares, and an unknown live segment leaves
// every segment sealable — which is why the queue's scan passes the live name it already knows as well.
export function liveSegment(lockFile, { fs = nodeFs } = {}) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')).segment || null; } catch { return null; }
}

/** The one entry. Every outcome — ok, refused, failed — is appended to the raw journal (D38, no silent failures).
 *  A segment whose file is gone (ENOENT) is nothing to do: `{ gone: true }`, no journal line. */
// The journal lies beside the segment it speaks of: the raw/ that holds the segment, never a home derived from the
// environment (a test sealing in a temp dir wrote 146 lines into the developer's real ~/.trocar/raw/journal.jsonl, 2026-10-18).
export async function sealSegment(file, { lockFile, journal = path.join(path.dirname(file), 'journal.jsonl'), fs = nodeFs, frameBytes = FRAME_BYTES, onPhase = () => {} } = {}) {
  if (!lockFile) throw new Error('sealSegment: lockFile is required — the live segment must be refused, not guessed');
  const seg = parseSegment(path.basename(file));
  const t0 = Date.now();
  try {
    const res = await sealOne(file, { lockFile, fs, frameBytes, onPhase });
    // `segment` and `took_ms` are what 附录 D.2 自动封存 asks of every sealed segment (how long each took); the
    // journal is the only place it is recorded, so a report that leaves them out has nothing to read (mac run P2).
    if (!res.gone) appendJournal({ op: 'seal', outcome: 'ok', format: VERSION, file, segment: seg && seg.segment, took_ms: Date.now() - t0, records: res.records, bytes: res.bytes, sha256: res.sha256, sealed: res.sealed, sealedBytes: res.sealedBytes }, { journal, fs });
    return res;
  } catch (e) {
    appendJournal({ op: 'seal', outcome: e instanceof SealRefused ? 'refused' : 'failed', format: VERSION, file, segment: seg && seg.segment, took_ms: Date.now() - t0, reason: e.message,
      originalKept: fs.existsSync(file) }, { journal, fs });
    throw e;
  }
}

async function sealOne(file, { lockFile, fs, frameBytes, onPhase }) {
  const dir = path.dirname(file), seg = parseSegment(path.basename(file));
  if (!seg || seg.sealed) throw new SealRefused(`refusing to seal ${file}: it is not a plaintext segment of the raw layer`);
  if (seg.segment === liveSegment(lockFile, { fs })) throw new SealRefused(`refusing to seal ${file}: the daemon's lock ${lockFile} names it as the segment being appended to`);
  let st0;
  try { st0 = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return { file, gone: true }; throw e; }
  if (!st0.isFile()) throw new SealRefused(`refusing to seal ${file}: not a regular file`);
  const out = path.join(dir, seg.segment + SEALED_EXT);
  const tmp = path.join(dir, `.${seg.segment}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const name = path.basename(file);
  let fd = fs.openSync(tmp, 'wx', 0o600), renamed = false;
  try {
    // Pass 1: read the segment once, hash it whole, encode every line.
    const writer = createSealWriter({ fd, fs, frameBytes });
    const whole = createHash('sha256');
    let lines = 0, length = 0;
    const src = fs.openSync(file, 'r');
    try {
      for (const line of readLines(fs, src)) {
        whole.update(line); length += line.length;
        const nl = line.length && line[line.length - 1] === 0x0a;
        // The same parse names the record's stream group: trocar's own envelope host + endpoint path (query cut off),
        // so lines of one conversation share chunk buffers (4.2 §封存格式). No host or endpoint → no group.
        let id = null, group = null, unparseable = false;
        try {
          const o = JSON.parse(line.toString('utf8', 0, line.length - (nl ? 1 : 0)));
          id = o.id == null ? null : String(o.id);
          const h = typeof o.host === 'string' ? o.host : '', ep = typeof o.endpoint === 'string' ? o.endpoint.split('?')[0] : '';
          if (typeof o.host === 'string' || typeof o.endpoint === 'string') group = `${h}\n${ep}`;
        } catch { unparseable = true; }
        writer.add(line, { id, stream: name, shard: 0, lineNo: lines, unparseable, group });
        lines++;
      }
    } finally { fs.closeSync(src); }
    const sum = whole.digest('hex');
    const stats = writer.finish([{ name, sha256: sum, length, lines, path: name, dev: st0.dev, ino: st0.ino, mtimeMs: st0.mtimeMs }]);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    await onPhase('written');

    // "Did it change?" is asked after the encode and once more right before the plaintext is deleted: a byte appended
    // in between is in no sealed copy, so the plaintext is kept and the segment sealed again later.
    const changed = () => { const s = fs.statSync(file); return s.size !== st0.size || s.mtimeMs !== st0.mtimeMs || s.ino !== st0.ino ? s : null; };
    let st1 = changed();
    if (st1) throw new SealRefused(`refusing to finish sealing ${file}: it changed while being sealed (size ${st0.size} → ${st1.size})`);
    verifySealed(fs, tmp, { name, sum, length, lines });
    await onPhase('verified');
    fs.renameSync(tmp, out);          // a sealed file an interrupted earlier run left is superseded by this verified one
    renamed = true;
    fsyncDir(fs, dir);
    await onPhase('renamed');
    if ((st1 = changed())) throw new Error(`${file} was written to after its sealed copy was verified (size ${st0.size} → ${st1.size}) — the plaintext is kept and wins; ${path.basename(out)} holds its earlier bytes and is replaced the next time it is sealed`);
    fs.unlinkSync(file);
    fsyncDir(fs, dir);
    await onPhase('deleted');
    return { file, sealed: out, records: lines, bytes: length, sha256: sum, sealedBytes: stats.bytes };
  } catch (e) {
    if (fd != null) try { fs.closeSync(fd); } catch { /* already closed */ }
    if (!renamed) try { fs.unlinkSync(tmp); } catch { /* never written, or gone */ }
    if (!(e instanceof SealRefused) && !/verification failed|was written to after/.test(e.message)) e.message = `seal aborted, the plaintext is kept: ${e.message}`;
    throw e;
  }
}

// Every line of the segment as its own Buffer, "\n" included (CR stays part of the line); the last line may lack its
// "\n". One chunk plus the current line in memory.
function* readLines(fs, fd) {
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = 0, pending = [], pendLen = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, CHUNK, pos);
    if (!n) break;
    pos += n;
    let from = 0;
    for (let i = buf.indexOf(0x0a, from); i >= 0 && i < n; i = buf.indexOf(0x0a, from)) {
      const piece = buf.subarray(from, i + 1);
      yield pendLen ? Buffer.concat([...pending, piece], pendLen + piece.length) : Buffer.from(piece);
      pending = []; pendLen = 0; from = i + 1;
    }
    if (from < n) { pending.push(Buffer.from(buf.subarray(from, n))); pendLen += n - from; }
  }
  if (pendLen) yield Buffer.concat(pending, pendLen);
}

// Decode every record (the reader checks each line's sha256 against the index, which was computed from the source
// line), then rebuild the whole segment in line order and compare its length and sha256 with what was read. Any gap,
// duplicate or mismatch throws.
export function verifySealed(fs, sealed, { name, sum, length, lines }) {
  const f = openSealed(sealed, { fs });
  try {
    const whole = createHash('sha256');
    let total = 0, want = 0;
    for (const { line, entry } of f.lines()) {
      if (entry.lineNo !== want) throw new Error(`verification failed: line ${want} of ${name} is not the next record (${entry.lineNo})`);
      if (entry.stream !== name || entry.shard !== 0) throw new Error(`verification failed: line ${want} carries the wrong source`);
      whole.update(line); total += line.length; want++;
    }
    const s = f.shards[0];
    if (want !== lines || total !== length || whole.digest('hex') !== sum) throw new Error(`verification failed: rebuilt ${name} does not match the original (${want} of ${lines} lines, length ${total} of ${length})`);
    if (f.shards.length !== 1 || s.name !== name || s.sha256 !== sum || s.length !== length) throw new Error('verification failed: source-segment table mismatch');
  } catch (e) {
    if (!/^verification failed/.test(e.message)) e.message = `verification failed: ${e.message}`;
    throw e;
  } finally { f.close(); }
}
