// Per-session sharding of the capture stream. This is ETL, deliberately: D20 keeps the capture tee
// pure (it writes one append-only envelope stream and knows nothing about session identity), and
// 4.2:11 puts per-session grouping in this layer. 4.4:34 keeps the read-only server out of it.
//
// Why it exists: one week of real use produced a 7.58 GB single file. `asight serve` could not open
// it — the loader parses every record into one resident array and dies at an 8 GB heap. Sharded, the
// board reads only the session being viewed.
//
// The hard constraint is invariant 2: the source NDJSON is the ONE source of truth. So this module
// COPIES RAW LINE BYTES. It never JSON.parses a record and re-serialises it — that would silently
// renormalise number formatting, key order and unicode escapes, and every "verbatim" claim
// downstream would become a lie. Session identity is read by a bounded scan of the header region,
// which is also why `sessionIdOfLine` works on the raw string instead of a parsed object.

import fs from 'node:fs';
import path from 'node:path';

const NL = 0x0a;
const SID_KEY = /"x-claude-code-session-id"\s*:\s*"([^"]+)"/i;

// Records with no session header still belong to the corpus — dropping them would be an
// invariant-2 violation dressed up as tidying. They get their own bucket.
export const UNASSIGNED = '_unassigned';

/**
 * Read the session id out of a raw NDJSON line without parsing it.
 *
 * The scan is bounded to the `req_headers` object. An unbounded indexOf would also match a session
 * id quoted inside `req_body` — agent transcripts discuss session ids constantly — and would file
 * the record under a session that never made the call.
 */
export function sessionIdOfLine(line) {
  const k = '"req_headers":{';
  const i = line.indexOf(k);
  if (i < 0) return null;
  // `req_body` always follows `req_headers` in the envelope (src/capture/envelope.mjs). Fall back to
  // a generous cap so a malformed record degrades to "unassigned" rather than scanning a 200 KB body.
  let end = line.indexOf('"req_body"', i);
  if (end < 0) end = Math.min(line.length, i + 65536);
  const m = SID_KEY.exec(line.slice(i + k.length, end));
  return m ? m[1] : null;
}

// A session id reaches the filesystem as a directory name. It comes from a header, i.e. from the
// wire, so it is untrusted: `../` or a NUL would escape the shard root.
function safeName(sid) {
  const s = String(sid).replace(/[^A-Za-z0-9._-]/g, '_');
  return !s || s === '.' || s === '..' ? UNASSIGNED : s.slice(0, 128);
}

class ShardWriter {
  constructor(outDir, flushBytes) {
    this.outDir = outDir;
    this.flushBytes = flushBytes;
    this.buffers = new Map();  // name -> { chunks: Buffer[], bytes: number }
  }

  add(name, lineWithNl) {
    let b = this.buffers.get(name);
    if (!b) { b = { chunks: [], bytes: 0 }; this.buffers.set(name, b); }
    b.chunks.push(lineWithNl);
    b.bytes += lineWithNl.length;
    if (b.bytes >= this.flushBytes) this.flush(name);
  }

  flush(name) {
    const b = this.buffers.get(name);
    if (!b || !b.chunks.length) return;
    const file = path.join(this.outDir, name, 'calls.ndjson');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Headers are stored verbatim (2026-07-20: no redaction, local-only deployment), which makes
    // file permissions the only thing protecting the corpus. Shards MUST match the source's 0600.
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, Buffer.concat(b.chunks));
      try { fs.fchmodSync(fd, 0o600); } catch { /* best effort on exotic filesystems */ }
    } finally { fs.closeSync(fd); }
    b.chunks = [];
    b.bytes = 0;
  }

  flushAll() { for (const name of this.buffers.keys()) this.flush(name); }
}

const STATE_FILE = '.shard-state.json';

/**
 * Read the shard watermarks. This file is a CACHE, never a source of truth (invariant 2): if it is
 * missing or corrupt the only cost is re-reading the capture, never lost records.
 */
export function readState(outDir) {
  try {
    const raw = fs.readFileSync(path.join(outDir, STATE_FILE), 'utf8');
    const st = JSON.parse(raw);
    return st && typeof st === 'object' ? st : {};
  } catch { return {}; }
}

function writeState(outDir, state) {
  const file = path.join(outDir, STATE_FILE);
  const tmp = file + '.tmp';
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);   // atomic: a crash mid-write must not leave a truncated watermark
}

/**
 * Shard whatever is new since the last run, persisting the watermark.
 *
 * The watermark is only valid while the file is the SAME file. Size alone cannot tell appending
 * from rotation — a fresh capture at the same path that has already grown past the old watermark
 * looks identical to an append, and resuming would skip every record of it. So identity (inode) is
 * tracked too, and a break falls back to a full re-read and is REPORTED (invariant 4).
 */
export async function shardOnce({ file, outDir, ...opts } = {}) {
  const state = readState(outDir);
  const prev = state[file];
  let st;
  try { st = fs.statSync(file); } catch { return { records: 0, bytes: 0, offset: 0, rotated: false, missing: true }; }

  // Two different things break a watermark and they are NOT interchangeable: the path may point at
  // a different file (unlink + recreate → new inode), or the same file may have been emptied
  // (truncate → same inode, size below the watermark). Reporting one as the other is exactly the
  // "render a guess as a measurement" failure this codebase keeps auditing itself for, so the
  // reason is derived, not assumed.
  const newInode = Boolean(prev) && prev.ino !== st.ino;
  const shrank = Boolean(prev) && !newInode && st.size < prev.offset;
  const rotated = newInode || shrank;
  const reason = newInode ? 'replaced (new inode)' : shrank ? 'truncated (same inode)' : null;
  const from = rotated || !prev ? 0 : prev.offset;

  const r = await shardStream({ file, outDir, fromOffset: from, ...opts });
  state[file] = { ino: st.ino, offset: r.offset, size: st.size, at: new Date().toISOString() };
  writeState(outDir, state);
  return { ...r, rotated, reason, resumedFrom: from };
}

/**
 * Split an append-only capture stream into per-session shards.
 *
 * @param {string}  file        source NDJSON
 * @param {string}  outDir      shard root; one `<session>/calls.ndjson` per session
 * @param {number}  fromOffset  resume point in bytes (the stream is append-only, so this is enough)
 * @param {number}  chunkSize   read buffer
 * @param {number}  flushBytes  per-session write buffer
 * @param {Function} onProgress called with {records, bytes} periodically
 * @returns {{records, bytes, offset, sessions, unassigned, partial}}
 */
export async function shardStream({
  file, outDir, fromOffset = 0, chunkSize = 1024 * 1024,
  flushBytes = 4 * 1024 * 1024, onProgress = null,
} = {}) {
  const size = fs.statSync(file).size;
  const start = Number(fromOffset) > 0 ? Number(fromOffset) : 0;
  const counts = new Map();
  const out = {
    records: 0, bytes: 0, offset: start, sessions: counts, unassigned: 0, partial: false,
  };
  if (start >= size) return out;

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const w = new ShardWriter(outDir, flushBytes);

  // `carry` holds bytes after the last newline in the previous chunk. A real record reaches ~200 KB
  // and so straddles chunk boundaries routinely; splitting one would write two invalid fragments.
  let carry = Buffer.alloc(0);
  let consumed = start;
  let sinceProgress = 0;

  const stream = fs.createReadStream(file, { start, highWaterMark: chunkSize });
  for await (const chunk of stream) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let from = 0;
    for (;;) {
      const nl = buf.indexOf(NL, from);
      if (nl < 0) break;
      const lineWithNl = buf.subarray(from, nl + 1);
      from = nl + 1;
      if (lineWithNl.length > 1) {
        const sid = sessionIdOfLine(lineWithNl.subarray(0, Math.min(lineWithNl.length, 8192)).toString('utf8'));
        const name = sid ? safeName(sid) : UNASSIGNED;
        if (!sid) out.unassigned++;
        w.add(name, lineWithNl);
        counts.set(name, (counts.get(name) || 0) + 1);
        out.records++;
      }
      out.bytes += lineWithNl.length;
      consumed += lineWithNl.length;
      if (onProgress && ++sinceProgress >= 500) {
        sinceProgress = 0;
        onProgress({ records: out.records, bytes: out.bytes, offset: consumed, size });
      }
    }
    carry = from < buf.length ? Buffer.from(buf.subarray(from)) : Buffer.alloc(0);
    buf = null;
  }

  // Anything after the last newline is a record still being written. Committing it would shard a
  // half record; the reported offset stops before it so the next run reads it whole.
  out.partial = carry.length > 0;
  out.offset = consumed;
  w.flushAll();
  return out;
}
