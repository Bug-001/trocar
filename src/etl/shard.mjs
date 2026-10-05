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
import { emptyMeta, foldRecord, mergeMeta } from './session-meta.mjs';

const NL = 0x0a;
const SID_KEY = /"x-claude-code-session-id"\s*:\s*"([^"]+)"/i;

// Records with no session header still belong to the corpus — dropping them would be an
// invariant-2 violation dressed up as tidying. Session-LESS traffic is the control plane; it lands
// under `control/<class>.ndjson`, bucketed by endpoint (4.2:51 · demo sessions.mjs controlClass).
export const CONTROL_DIR = 'control';

// Which per-session stream a record belongs to (4.2:51 · demo sessions.mjs classOf). The split keeps
// the board's calls timeline clean: `calls.ndjson` = real inference (the ReAct spine, feeds every
// table), `probes.ndjson` = count_tokens context-size measurements (the probe rail — a ruler, not a
// turn), `other.ndjson` = any other session-tagged non-inference traffic. Storing them apart is what
// lets the big-session read path load only the calls it draws, not the probe flood interleaved with it.
const STREAM_FILE = { call: 'calls.ndjson', probe: 'probes.ndjson', other: 'other.ndjson' };
export function classOf(rec) {
  if (rec && rec.is_llm_call) return 'call';                    // /v1/messages — real inference
  if (/\/messages\/count_tokens/.test(String((rec && rec.endpoint) || ''))) return 'probe';
  return 'other';
}

// Bucket session-LESS control-plane traffic by endpoint (4.2:51 · demo sessions.mjs controlClass).
// This is a STORAGE bucket only; the board's own control-plane VIEW re-derives its display classes
// server-side (board.mjs controlClass) — 3.1's normalized `control_kind` is the eventual home, and
// per 2.6:106 the two class vocabularies are knowingly parallel. Keeping the demo's exact buckets here
// is the faithful port; the board reads the raw records back out, it does not read these filenames.
export function controlClass(endpoint) {
  const e = String(endpoint || '');
  if (/event_logging/.test(e)) return 'telemetry';
  if (/mcp[-_]registry|mcp_servers/.test(e)) return 'registry';
  if (/oauth|account/.test(e)) return 'account';
  if (/bootstrap|grove|penguin|eval|triggers|code\//.test(e)) return 'control';
  return 'other';
}

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

// A session id that survives sanitisation but is still an unusable directory name ('' / '.' / '..').
// The record HAS a session id (so it isn't control-plane), just one we can't make a folder from —
// park it under a reserved bucket rather than crash or let it escape the shard root.
const UNSAFE_SID = '_badsid';

// A session id reaches the filesystem as a directory name. It comes from a header, i.e. from the
// wire, so it is untrusted: `../` or a NUL would escape the shard root.
function safeName(sid) {
  const s = String(sid).replace(/[^A-Za-z0-9._-]/g, '_');
  return !s || s === '.' || s === '..' ? UNSAFE_SID : s.slice(0, 128);
}

class ShardWriter {
  constructor(outDir, flushBytes) {
    this.outDir = outDir;
    this.flushBytes = flushBytes;
    this.buffers = new Map();  // relPath -> { chunks: Buffer[], bytes: number }
  }

  // relPath is the shard file this line belongs in, e.g. `<sid>/calls.ndjson`, `<sid>/probes.ndjson`,
  // or `control/telemetry.ndjson` — the demo's per-class split (sessions.mjs classOf/controlClass),
  // now in the ETL layer per D20.
  add(relPath, lineWithNl) {
    let b = this.buffers.get(relPath);
    if (!b) { b = { chunks: [], bytes: 0 }; this.buffers.set(relPath, b); }
    b.chunks.push(lineWithNl);
    b.bytes += lineWithNl.length;
    if (b.bytes >= this.flushBytes) this.flush(relPath);
  }

  flush(relPath) {
    const b = this.buffers.get(relPath);
    if (!b || !b.chunks.length) return;
    const file = path.join(this.outDir, relPath);
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

  flushAll() { for (const relPath of this.buffers.keys()) this.flush(relPath); }
}

const STATE_FILE = '.shard-state.json';

/**
 * Rebuild meta.json for every already-written shard under `outDir`, by STREAMING each
 * `<id>/calls.ndjson` (never reading a whole shard into memory — the biggest is multi-GB). Used to
 * backfill shards written before the archive layer; going forward `shardOnce` keeps meta fresh
 * incrementally, so this is a one-time / repair operation.
 */
export async function rebuildMeta(outDir) {
  const { createInterface } = await import('node:readline');
  let sessions = 0, records = 0;
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return { sessions: 0, records: 0 }; }
  for (const e of entries) {
    // control/ is session-less (no meta); skip it. Everything else is a session dir.
    if (!e.isDirectory() || e.name === CONTROL_DIR) continue;
    const meta = emptyMeta(e.name);
    let seen = false;
    // Fold ALL of a session's streams (calls/probes/other) so meta.calls/probes/other match the split
    // — reading only calls.ndjson would undercount probes and other, which the board lists.
    for (const stream of Object.values(STREAM_FILE)) {
      const shard = path.join(outDir, e.name, stream);
      let size = 0;
      try { size = fs.statSync(shard).size; } catch { continue; }
      if (!size) continue;
      seen = true;
      const rl = createInterface({ input: fs.createReadStream(shard, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        records++;
        try { foldRecord(meta, JSON.parse(line)); } catch { /* malformed line — skip its contribution */ }
      }
    }
    if (!seen) continue;
    try { fs.writeFileSync(path.join(outDir, e.name, 'meta.json'), JSON.stringify(meta), { mode: 0o600 }); sessions++; } catch { /* best-effort */ }
  }
  return { sessions, records };
}

// Sum bytes of every *.ndjson file under `dir` (one level of nesting: dir/*.ndjson + dir/*/*.ndjson).
function ndjsonBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { for (const f of fs.readdirSync(p)) if (f.endsWith('.ndjson')) total += fs.statSync(path.join(p, f)).size; }
    else if (e.name.endsWith('.ndjson')) total += fs.statSync(p).size;
  }
  return total;
}

/**
 * Migrate LEGACY shards (written before the classOf split, when a session's whole traffic sat in ONE
 * `calls.ndjson`) into the split layout `{calls,probes,other}.ndjson` + `control/<class>.ndjson`.
 *
 * These shards are now the SOURCE TRUTH for their sessions (the monolith they came from was deleted),
 * so the migration MUST NOT lose or rewrite a byte. It reuses the SAME tested `shardStream` to do the
 * classification, guards on exact byte conservation before swapping anything in, and keeps the
 * original as `calls.ndjson.premigrate` until every rename has landed — so a crash at any point leaves
 * either the intact original or the complete new set, never a half-written session (invariant 2).
 *
 * Idempotent: a dir already carrying `probes.ndjson`/`other.ndjson` or the `.split-v2` marker is skipped.
 */
export async function resplitShards(outDir) {
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return { done: 0, skipped: 0, failed: 0 }; }
  let done = 0, skipped = 0, failed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name === CONTROL_DIR) continue;
    const sdir = path.join(outDir, e.name);
    const calls = path.join(sdir, 'calls.ndjson');
    if (!fs.existsSync(calls)) { skipped++; continue; }
    if (fs.existsSync(path.join(sdir, 'probes.ndjson')) || fs.existsSync(path.join(sdir, 'other.ndjson'))
      || fs.existsSync(path.join(sdir, '.split-v2'))) { skipped++; continue; }

    const before = fs.statSync(calls).size;
    const tmp = path.join(sdir, '.resplit-tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      // Re-run the tested split over just this session's mixed calls.ndjson. Every line already carries
      // this session's id, so they land under tmp/<e.name>/; any truly session-less line (there should
      // be none in a session shard) would surface under tmp/control/ and is handled below.
      await shardStream({ file: calls, outDir: tmp });
      const after = ndjsonBytes(tmp);
      if (after !== before) { // byte-conservation guard: refuse to swap if a single byte went missing
        failed++;
        fs.rmSync(tmp, { recursive: true, force: true });
        continue;
      }
      const produced = path.join(tmp, e.name);
      // Back the original up (instant rename, same fs), then move each produced stream into place.
      fs.renameSync(calls, calls + '.premigrate');
      for (const s of Object.values(STREAM_FILE)) {
        const src = path.join(produced, s);
        if (fs.existsSync(src)) fs.renameSync(src, path.join(sdir, s));
      }
      // shardStream already folded the correct split meta while copying — carry it into place so a
      // direct resplit leaves the archive layer consistent without a separate rebuildMeta pass.
      const pmeta = path.join(produced, 'meta.json');
      if (fs.existsSync(pmeta)) fs.renameSync(pmeta, path.join(sdir, 'meta.json'));
      // Fold any stray control lines up into the shared control/ bucket (append, byte-exact).
      const tmpControl = path.join(tmp, CONTROL_DIR);
      if (fs.existsSync(tmpControl)) {
        const dstControl = path.join(outDir, CONTROL_DIR);
        fs.mkdirSync(dstControl, { recursive: true, mode: 0o700 });
        for (const f of fs.readdirSync(tmpControl)) {
          if (!f.endsWith('.ndjson')) continue;
          const buf = fs.readFileSync(path.join(tmpControl, f));
          const fd = fs.openSync(path.join(dstControl, f), 'a', 0o600);
          try { fs.writeSync(fd, buf); } finally { fs.closeSync(fd); }
        }
      }
      fs.writeFileSync(path.join(sdir, '.split-v2'), '', { mode: 0o600 });
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(calls + '.premigrate', { force: true }); // new set is fully in place; drop the backup
      done++;
    } catch {
      // Roll forward-safe: if the original was backed up but the swap failed, restore it.
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(calls) && fs.existsSync(calls + '.premigrate')) fs.renameSync(calls + '.premigrate', calls);
      failed++;
    }
  }
  return { done, skipped, failed };
}

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
  // Per-session meta accumulated by folding each record — the archive layer that lets the board list
  // every session without loading records (src/etl/session-meta.mjs). Built alongside the raw byte
  // copy; the shard bytes stay verbatim, the meta is a derived projection.
  const metas = new Map();
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
        // Parse the record ONCE, for classification (classOf/controlClass need is_llm_call + endpoint)
        // and the meta fold. The RAW bytes are still what gets written — this parse never touches the
        // shard content, so invariant 2 holds. A partial/malformed line fails to parse (rec=null); its
        // bytes are still kept, it just can't be classified beyond its session id.
        let rec = null;
        try { rec = JSON.parse(lineWithNl.subarray(0, lineWithNl.length - 1).toString('utf8')); } catch { /* keep bytes, skip derivation */ }
        let relPath, name;
        if (sid) {
          name = safeName(sid);
          // Unparseable-but-session-tagged records default to the calls stream: they belong to the
          // session, and 'calls' is the stream the read path always loads, so a byte-preserved record
          // is never orphaned into a stream the board might skip.
          relPath = name + '/' + STREAM_FILE[rec ? classOf(rec) : 'call'];
          // Fold every session-tagged record (calls/probes/other) into its meta; foldRecord itself
          // decides which counter each one bumps. Malformed → bytes kept above, meta contribution skipped.
          if (rec) {
            let meta = metas.get(name);
            if (!meta) { meta = emptyMeta(sid); metas.set(name, meta); }
            foldRecord(meta, rec);
          }
        } else {
          // Session-less control plane: bucket by endpoint (demo controlClass). No per-session meta —
          // control traffic never appears in the board's session list (4.2:51 "不进 3.2 会话表").
          out.unassigned++;
          name = CONTROL_DIR;
          relPath = CONTROL_DIR + '/' + controlClass(rec ? rec.endpoint : '') + '.ndjson';
        }
        w.add(relPath, lineWithNl);
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

  // Write each touched session's meta.json. A resumed run (start>0) only saw NEW records, so its meta
  // MERGES with what is already on disk; a full run (start===0) saw everything from the top and
  // OVERWRITES (else a re-shard would double-count). The board reads these instead of the records.
  for (const [name, meta] of metas) {
    const metaPath = path.join(outDir, name, 'meta.json');
    let merged = meta;
    if (start > 0) {
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* first meta for this session */ }
      merged = mergeMeta(prev, meta);
    }
    try {
      fs.mkdirSync(path.dirname(metaPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(metaPath, JSON.stringify(merged), { mode: 0o600 });
    } catch { /* best-effort: a missing meta only means the list re-derives from records */ }
  }
  return out;
}
