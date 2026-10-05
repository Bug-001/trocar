// src/raw/seal.mjs — the D35 sealer (RFC 4.2 §原始层封存 「封存流程」, 4.6 §日志体积预算).
//
// Re-encodes ONE closed shard, losslessly, into sealed files: one per session (request-header key
// only, D20 的 D35 修订) under `<sessionsRoot>/<key>/`, plus one beside the shard for lines without a
// key (and for every opaque line). Besides appending, a whole-file rename (D27③) and `asight shard`,
// this is the only write ever allowed on a source file — and it only ever deletes the original
// after the new files are proven to rebuild it byte for byte (invariant 2). The order is the MUST:
//
//   temp (0600 at open, in the target dir) → write → fsync → decode EVERY record, compare sha256
//   → rebuild the shard from all outputs by (shard id, line_no), compare length + whole-file sha256
//   → rename → fsync every target dir → unlink the original → fsync the source dir.
//
// A crash or power cut at any point leaves the original (alone, or next to verified copies the
// readers ignore while it exists — src/raw/discover.mjs). A failed verification keeps the original.
// The original's size / mtime / inode are re-checked after the encode, after verification and once
// more right before it is deleted or kept (lateChange): a byte written in between is in no copy.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createSealWriter, FRAME_BYTES } from './writer.mjs';
import { openSealed, createFrameCache } from './reader.mjs';
import { readIndex } from './format.mjs';
import { closedState, closedMarkerPath, fsyncDir } from './closed.mjs';
import { sessionKeyOfLine } from './session-key.mjs';
import { appendJournal, defaultJournalPath } from './journal.mjs';

export class SealRefused extends Error { constructor(m) { super(m); this.name = 'SealRefused'; this.code = 'SEAL_REFUSED'; } }

export const SEALED_EXT = '.sealed';
// A session key becomes a directory name, and it came off the wire: anything that is not a plain name
// stays in the per-shard file instead (no record is lost, it is only not filed under a session).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const CHUNK = 8 << 20;

// The marker-gated entry: an active shard is never sealed (4.6 E6). The legacy entry for pre-D35
// files without a marker is src/raw/legacy.mjs.
// Every outcome — ok, refused, failed — is appended to the raw journal (journal.mjs; no silent failures).
export async function sealShard(shard, opts = {}) {
  const fs = opts.fs || nodeFs;
  let c;
  try { c = closedState(shard, { fs }); } catch (e) { c = { closed: false, reason: e.message }; }
  if (!c.closed) {
    const reason = `${c.reason}. An active shard is never sealed (4.6 §日志体积预算).`;
    appendJournal({ op: 'seal', outcome: 'refused', file: shard, reason }, { journal: opts.journal === undefined ? defaultJournalPath() : opts.journal });
    throw new SealRefused(`refusing to seal ${shard}: ${reason}`);
  }
  return sealUnchecked(shard, { split: true, deleteOriginal: true, ...opts });
}

// Only for callers that have established "closed" by other means (legacy.mjs). Not exported further.
export async function sealUnchecked(shard, { journal = defaultJournalPath(), ...opts } = {}) {
  try {
    const res = await sealCore(shard, opts);
    appendJournal({ op: 'seal', outcome: 'ok', file: shard, records: res.records, bytes: res.bytes, sha256: res.sha256,
      sealedBytes: res.sealedBytes, deleted: res.deleted, outputs: res.outputs.map((o) => o.path) }, { journal });
    return res;
  } catch (e) {
    appendJournal({ op: 'seal', outcome: e instanceof SealRefused ? 'refused' : 'failed', file: shard, reason: e.message,
      originalKept: (opts.fs || nodeFs).existsSync(shard) }, { journal });
    throw e;
  }
}

async function sealCore(shard, { fs = nodeFs, sessionsRoot, split = true, deleteOriginal = true,
  frameBytes = FRAME_BYTES, onPhase = () => {} } = {}) {
  if (split && !sessionsRoot) throw new Error('sealUnchecked: sessionsRoot is required to split by session');
  const srcDir = path.dirname(shard), name = path.basename(shard);
  const lock = acquireLock(fs, shard);
  const outs = new Map();            // key ('' = per-shard) → { dir, tmp, fd, writer }
  let renamed = false;
  try {
    const st0 = fs.statSync(shard);
    if (!st0.isFile()) throw new SealRefused(`refusing to seal ${shard}: not a regular file`);
    const outFor = (key) => {
      let o = outs.get(key);
      if (o) return o;
      const dir = key ? path.join(sessionsRoot, key) : srcDir;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.${name}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      o = { key, dir, tmp, fd, writer: createSealWriter({ fd, fs, frameBytes }) };
      outs.set(key, o);
      return o;
    };

    // Pass 1: read the shard once, hash it whole, route and encode every line.
    const whole = createHash('sha256');
    let lineNo = 0, length = 0;
    const fd = fs.openSync(shard, 'r');
    try {
      for (const line of readLines(fs, fd)) {
        whole.update(line); length += line.length;
        const nl = line.length && line[line.length - 1] === 0x0a;
        let id = null, unparseable = false;
        try { const v = JSON.parse(line.toString('utf8', 0, line.length - (nl ? 1 : 0))).id; id = v == null ? null : String(v); }
        catch { unparseable = true; }
        let key = split && !unparseable ? sessionKeyOfLine(line) : null;
        if (key != null && !SAFE_KEY.test(key)) key = null;
        outFor(key || '').writer.add(line, { id, stream: name, shard: 0, lineNo, unparseable });
        lineNo++;
      }
    } finally { fs.closeSync(fd); }
    const sum = whole.digest('hex');
    if (!outs.size) outFor('');                          // an empty shard still leaves its record
    for (const o of outs.values()) {
      o.stats = o.writer.finish([{ name, sha256: sum, length, lines: lineNo,
        path: path.relative(o.dir, shard).split(path.sep).join('/'), dev: st0.dev, ino: st0.ino, mtimeMs: st0.mtimeMs }]);
      fs.fsyncSync(o.fd); fs.closeSync(o.fd); o.fd = null;
    }
    await onPhase('written');

    // "Did it change?" is asked after the encode, after verification, and once more right before the
    // original is deleted (or kept): a byte appended at any point in between is in no sealed copy.
    const changed = () => { const s = fs.statSync(shard); return s.size !== st0.size || s.mtimeMs !== st0.mtimeMs || s.ino !== st0.ino ? s : null; };
    let st1 = changed();
    if (st1) throw new SealRefused(`refusing to finish sealing ${shard}: it changed while being sealed (size ${st0.size} → ${st1.size})`);
    verify(fs, [...outs.values()], { name, sum, length, lines: lineNo });
    await onPhase('verified');
    if ((st1 = changed())) throw new SealRefused(`refusing to finish sealing ${shard}: it changed while being verified (size ${st0.size} → ${st1.size})`);

    // Copies left by an interrupted earlier run of the SAME source are superseded by this verified
    // set. Removing them first is safe: the original still holds every byte.
    const ours = new Set([...outs.values()].map((o) => o.tmp));
    for (const o of outs.values()) { removeEarlierCopies(fs, o.dir, name, { sum, length }); cleanStaleTemps(fs, o.dir, name, ours); }
    for (const o of outs.values()) {
      o.final = path.join(o.dir, nextSegmentName(fs, o.dir, name));
      fs.renameSync(o.tmp, o.final);
      renamed = true;
      await onPhase('renamed');
    }
    for (const dir of new Set([...outs.values()].map((o) => o.dir))) fsyncDir(fs, dir);
    await onPhase('synced');
    if ((st1 = changed())) lateChange(fs, shard, [...outs.values()], { sum, length, was: st0.size, now: st1.size });
    if (deleteOriginal) {
      fs.unlinkSync(shard);
      try { fs.unlinkSync(closedMarkerPath(shard)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fsyncDir(fs, srcDir);
      await onPhase('deleted');
    }
    const outputs = [...outs.values()].map((o) => ({ path: o.final, session: o.key || null, records: o.stats.records, bytes: o.stats.bytes }));
    return { shard, records: lineNo, bytes: length, sha256: sum, outputs, sealedBytes: outputs.reduce((a, o) => a + o.bytes, 0), deleted: deleteOriginal };
  } catch (e) {
    // Before any rename nothing is visible yet: drop the temps. After a rename the verified copies
    // stay (the original is still there, readers use only one of them, a re-run supersedes them).
    for (const o of outs.values()) {
      if (o.fd != null) try { fs.closeSync(o.fd); } catch {}
      if (!o.final) try { fs.unlinkSync(o.tmp); } catch {}
    }
    if (!renamed && e && !(e instanceof SealRefused) && !/verif/i.test(e.message)) e.message = `seal aborted, original kept: ${e.message}`;
    throw e;
  } finally { releaseLock(fs, lock); }
}

// The original changed after its copies were verified (and renamed). If it only GREW — its first
// `length` bytes still hash to what was sealed — every byte of the copies is still in the original:
// remove them (a copy of an earlier version beside the grown file would double its first lines) and
// refuse. If it was rewritten in place, the copies are the only place its earlier bytes still exist:
// keep both, fail loudly; readers report the pair as a mismatch (discover.mjs) until an operator acts.
function lateChange(fs, shard, outs, { sum, length, was, now }) {
  const h = createHash('sha256'), buf = Buffer.allocUnsafe(CHUNK), fd = fs.openSync(shard, 'r');
  try { for (let pos = 0; pos < length;) { const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, length - pos), pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n; } }
  finally { fs.closeSync(fd); }
  if (now >= length && h.digest('hex') === sum) {
    for (const o of outs) fs.unlinkSync(o.final);
    for (const dir of new Set(outs.map((o) => o.dir))) fsyncDir(fs, dir);
    throw new SealRefused(`refusing to finish sealing ${shard}: it grew after verification (size ${was} → ${now}); its sealed copies were removed and the original is kept whole — seal it again once nothing writes it`);
  }
  throw new Error(`seal failed after rename: ${shard} was rewritten in place after verification — original kept, and the sealed copies ${outs.map((o) => path.basename(o.final)).join(', ')} hold its earlier bytes; compare with \`asight raw verify\` before removing either`);
}

// Every line of the shard as its own Buffer, "\n" included (CR stays part of the line); the last
// line may lack its "\n". One chunk plus the current line in memory.
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

// Decode every record of every output (the reader checks each line's sha256 against the index, which
// was computed from the source line), then rebuild the whole shard in line order and compare its
// length and sha256 with what was read. Any gap, duplicate or mismatch throws.
export { verify as verifySealedOutputs };
function verify(fs, outs, { name, sum, length, lines }) {
  const cache = createFrameCache(8);
  const files = outs.map((o) => openSealed(o.tmp, { fs, frameCache: cache }));
  try {
    const its = files.map((f) => f.lines());
    const heads = its.map((it) => it.next());
    const whole = createHash('sha256');
    let total = 0;
    for (let want = 0; want < lines; want++) {
      const k = heads.findIndex((h) => !h.done && h.value.entry.lineNo === want);
      if (k < 0) throw new Error(`verification failed: line ${want} of ${name} is in no sealed output`);
      const { line, entry } = heads[k].value;
      if (entry.stream !== name || entry.shard !== 0) throw new Error(`verification failed: line ${want} carries the wrong source`);
      whole.update(line); total += line.length;
      heads[k] = its[k].next();
    }
    if (heads.some((h) => !h.done)) throw new Error('verification failed: a sealed output holds more lines than the shard');
    if (total !== length || whole.digest('hex') !== sum) throw new Error(`verification failed: rebuilt ${name} does not match the original (length ${total} vs ${length})`);
    for (const f of files) {
      const s = f.shards[0];
      if (f.shards.length !== 1 || s.name !== name || s.sha256 !== sum || s.length !== length) throw new Error('verification failed: source-shard table mismatch');
    }
  } catch (e) {
    if (!/^verification failed/.test(e.message)) e.message = `verification failed: ${e.message}`;
    throw e;
  } finally { for (const f of files) f.close(); }
}

const segRe = (name) => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d{4,})\\' + SEALED_EXT + '$');
function nextSegmentName(fs, dir, name) {
  const re = segRe(name);
  let max = 0;
  for (const f of fs.readdirSync(dir)) { const m = re.exec(f); if (m) max = Math.max(max, Number(m[1])); }
  return `${name}.${String(max + 1).padStart(4, '0')}${SEALED_EXT}`;
}

function removeEarlierCopies(fs, dir, name, { sum, length }) {
  const re = segRe(name);
  let removed = false;
  for (const f of fs.readdirSync(dir)) {
    if (!re.test(f)) continue;
    const p = path.join(dir, f);
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const { tables } = readIndex(fs, fd, fs.fstatSync(fd).size, f);
      if (tables.shards.length === 1 && tables.shards[0].name === name && tables.shards[0].sha256 === sum && tables.shards[0].length === length) {
        fs.closeSync(fd); fd = null; fs.unlinkSync(p); removed = true;
      }
    } catch { /* not ours, or unreadable: leave it, the readers report it */ }
    finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  }
  if (removed) fsyncDir(fs, dir);
}

// One sealer per shard at a time. A lock left by a dead process (kill -9) is taken over.
function acquireLock(fs, shard) {
  const p = shard + '.sealing';
  for (let tries = 0; tries < 2; tries++) {
    try { const fd = fs.openSync(p, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return p; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(p, 'utf8'));
      let alive = false;
      try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (k) { alive = k.code === 'EPERM'; }
      if (alive && pid !== process.pid) throw new SealRefused(`refusing to seal ${shard}: another sealer (pid ${pid}) holds ${path.basename(p)}`);
      fs.unlinkSync(p);
    }
  }
  throw new SealRefused(`refusing to seal ${shard}: could not take ${path.basename(p)}`);
}
function releaseLock(fs, p) { try { fs.unlinkSync(p); } catch {} }
// Temps a killed run left in a target dir. We hold the shard's lock, so any temp of this shard that
// is not one of ours is dead weight (a temp is never a reader's input: no .sealed / .ndjson suffix).
function cleanStaleTemps(fs, dir, name, ours) {
  const re = new RegExp('^\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.\\d+-[0-9a-f]{8}\\.tmp$');
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (re.test(f) && !ours.has(p)) try { fs.unlinkSync(p); } catch {}
  }
}
