// src/raw/verify.mjs — `asight raw verify`: prove a sealed copy against its original, byte for byte.
//
// The sealer already verifies before it deletes anything (seal.mjs), against hashes it computed while
// reading. This is the operator's independent check (coordinator 2026-10-06), run before deleting an
// original by hand or with `--delete-original`: decode every record of the sealed copies, put them in
// source line order, and compare them with the original file's actual bytes. A mismatch names the
// line and byte offset. With the original gone, a sealed file can still be checked by itself: every
// record decodes and matches its sha256, and a file holding a whole shard rebuilds its recorded sha256.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openSealed, createFrameCache } from './reader.mjs';
import { isSealedPath, sealedSources } from './discover.mjs';
import { appendJournal, defaultJournalPath } from './journal.mjs';

const CHUNK = 8 << 20;
// Is the sealed copy of source shard `src` (an entry of a sealed file's source-shard table) a copy of
// the file now at `file`? By content — a shard's identity is its bytes (4.2): the file's first
// src.length bytes must hash to src.sha256. 'same' = all of it; 'earlier' = its first bytes (it grew
// since); 'other' = another file now stands at that path, e.g. the fresh calls.ndjson `asight shard
// --watch` writes after the sealed one's original was deleted (review 3 F3) — that copy is then the
// only home of its records, and is checked by itself. The inode only spares the hash where it cannot
// match, and an untouched file (same inode, size, mtime) is taken as 'same' here — every caller then
// compares it byte for byte. A copied tree (new inode, same bytes) is 'same' too: sealing it again
// would leave every record twice once the original is deleted.
export function copyRelation(src, file, { fs = nodeFs } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return { rel: 'gone', why: `${file} no longer exists` }; }
  if (st.size < src.length) return { rel: 'other', why: `the file now at ${file} has ${st.size} bytes, fewer than the ${src.length} that were sealed` };
  if (st.size === src.length && st.ino === src.ino && (src.dev == null || st.dev === src.dev) && st.mtimeMs === src.mtimeMs) return { rel: 'same' };
  const h = createHash('sha256'), buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, src.length)));
  const fd = fs.openSync(file, 'r');
  try { for (let pos = 0; pos < src.length;) { const n = fs.readSync(fd, buf, 0, Math.min(buf.length, src.length - pos), pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n; } }
  finally { fs.closeSync(fd); }
  if (h.digest('hex') !== src.sha256) return { rel: 'other', why: `the file now at ${file} does not begin with the ${src.length} bytes that were sealed (${st.ino === src.ino ? 'same inode, rewritten since' : 'another inode'})` };
  return st.size === src.length ? { rel: 'same' } : { rel: 'earlier', why: `${file} grew from ${src.length} to ${st.size} bytes after it was sealed; its first ${src.length} bytes are still the sealed ones` };
}

// `prefix`: the copies may cover only the first bytes of a file that grew since (copyRelation
// 'earlier'); the result then says `covers: 'prefix'`. Never a licence to delete the original.
export function verifyAgainst(sealedFiles, original, { fs = nodeFs, prefix = false } = {}) {
  const name = path.basename(original);
  const cache = createFrameCache(8);
  const files = [];
  let fd = null;
  try {
    const size = fs.statSync(original).size;
    for (const f of sealedFiles) files.push(openSealed(f, { fs, frameCache: cache }));
    const shardIdx = files.map((sf) => sf.shards.findIndex((s) => s.name === name && (s.length === size || (prefix && s.length < size))));
    const bad = shardIdx.findIndex((k) => k < 0);
    if (bad >= 0) return fail(`${path.basename(sealedFiles[bad])} does not record ${name} of ${size} bytes (it records ${files[bad].shards.map((s) => `${s.name} of ${s.length}`).join(', ')}) — the original is longer, shorter or another file`);
    const shard = files[0].shards[shardIdx[0]];
    if (files.some((sf, k) => sf.shards[shardIdx[k]].length !== shard.length)) return fail('the sealed copies record different lengths of the original');
    const its = files.map((sf, k) => (function* () { for (const x of sf.lines()) if (x.entry.shard === shardIdx[k]) yield x; })());
    const heads = its.map((it) => it.next());
    fd = fs.openSync(original, 'r');
    const whole = createHash('sha256');
    let pos = 0, n = 0;
    for (;;) {
      const k = heads.findIndex((h) => !h.done && h.value.entry.lineNo === n);
      if (k < 0) break;
      const { line } = heads[k].value;
      const got = Buffer.alloc(line.length);
      const r = fs.readSync(fd, got, 0, line.length, pos);
      if (r !== line.length || !got.equals(line)) {
        let at = 0; while (at < r && got[at] === line[at]) at++;
        return fail(`line ${n} differs at byte ${pos + at} of ${name}`);
      }
      whole.update(line); pos += line.length; n++;
      heads[k] = its[k].next();
    }
    if (heads.some((h) => !h.done)) return fail(`the sealed copies hold lines beyond line ${n} that are not in sequence`);
    if (n !== shard.lines || pos !== shard.length) return fail(`the sealed copies cover ${n} lines / ${pos} bytes of ${name}, which has ${size} bytes (${shard.lines} lines / ${shard.length} bytes recorded)`);
    if (whole.digest('hex') !== shard.sha256) return fail(`${name} does not hash to the sha256 recorded at sealing`);
    if (pos < size) return { ok: true, original, sealed: sealedFiles, records: n, bytes: pos, mode: 'against-original', covers: 'prefix',
      note: `${name} grew to ${size} bytes after sealing: these copies hold its first ${pos} bytes, byte for byte; the rest is in no sealed copy` };
    return { ok: true, original, sealed: sealedFiles, records: n, bytes: pos, mode: 'against-original', covers: 'whole' };
  } catch (e) {
    return fail(e.message);
  } finally {
    if (fd != null) fs.closeSync(fd);
    for (const sf of files) sf.close();
  }
  function fail(reason) { return { ok: false, original, sealed: sealedFiles, reason, mode: 'against-original' }; }
}

// Without its original: decode every record (sha256-checked by the reader); a file that holds every
// line of its shard must also rebuild the shard's recorded length and sha256.
export function verifySelf(file, { fs = nodeFs } = {}) {
  let sf;
  try {
    sf = openSealed(file, { fs });
    const per = sf.shards.map(() => ({ n: 0, bytes: 0, h: createHash('sha256') }));
    for (const { line, entry } of sf.lines()) { const p = per[entry.shard]; p.n++; p.bytes += line.length; p.h.update(line); }
    for (let k = 0; k < sf.shards.length; k++) {
      const s = sf.shards[k], p = per[k];
      if (p.n === s.lines && (p.bytes !== s.length || p.h.digest('hex') !== s.sha256)) {
        return { ok: false, sealed: [file], original: null, mode: 'self', reason: `${s.name}: the decoded lines do not rebuild the recorded length / sha256` };
      }
    }
    return { ok: true, sealed: [file], original: null, mode: 'self', records: sf.count };
  } catch (e) {
    return { ok: false, sealed: [file], original: null, mode: 'self', reason: e.message };
  } finally { if (sf) sf.close(); }
}

// Every sealed file under `target` (a sealed file, or a directory and its immediate subdirectories),
// grouped by the original it was sealed from: against that original while it exists, else by itself.
export function verifyTree(target, { fs = nodeFs } = {}) {
  const sealed = [], failed = [];
  // what cannot be read is a failure naming it, never a stack trace (review 3 confirm, row 4)
  const unreadable = (p, e, what) => failed.push({ ok: false, sealed: [], original: p, mode: 'unreadable', reason: `${what} could not be read (${e.code || e.message}) — not verified; nothing deleted` });
  let st;
  try { st = fs.statSync(target); } catch (e) { unreadable(target, e, target); return failed; }
  if (st.isDirectory()) {
    const walk = (d, depth) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { unreadable(d, e, `the directory ${d}`); return; }
      for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth === 0) walk(p, 1); } else if (isSealedPath(e.name)) sealed.push(p);
      }
    };
    walk(target, 0);
  } else sealed.push(target);
  // grouped by (original, recorded length): copies of one version of a file are proven together
  const groups = new Map(), alone = [];
  for (const f of sealed) {
    const src = sealedSources(f, { fs });
    const one = src && src.length === 1 ? src[0] : null;
    let rel;
    try { rel = one ? copyRelation(one, one.abs, { fs }) : { rel: 'gone' }; }
    catch (e) { unreadable(one.abs, e, `${one.abs}, the original ${path.basename(f)} was sealed from,`); continue; }
    if (rel.rel === 'same' || rel.rel === 'earlier') {
      const k = `${one.abs}\0${one.length}`;
      if (!groups.has(k)) groups.set(k, { orig: one.abs, prefix: rel.rel === 'earlier', files: [] });
      groups.get(k).files.push(f);
    } else alone.push({ f, note: rel.rel === 'other' ? `${rel.why}: another file than the one this was sealed from — checked by itself, and it is the only copy of its records` : null });
  }
  return [...[...groups.values()].map((g) => verifyAgainst(g.files, g.orig, { fs, prefix: g.prefix })),
    ...alone.map(({ f, note }) => { const r = verifySelf(f, { fs }); return note ? { ...r, note } : r; }), ...failed];
}

// The CLI's verify: every result, ok or not, is journalled (a failed check MUST leave a durable record).
export function runVerify({ target, against = null, fs = nodeFs, journal = defaultJournalPath() }) {
  const results = against ? [verifyAgainst([target], against, { fs })] : verifyTree(target, { fs });
  for (const r of results) {
    appendJournal({ op: 'verify', outcome: r.ok ? 'ok' : 'failed', mode: r.mode, sealed: r.sealed, original: r.original,
      ...(r.ok ? { records: r.records } : { reason: r.reason }), ...(r.covers ? { covers: r.covers } : {}), ...(r.note ? { note: r.note } : {}) }, { journal });
  }
  return results;
}
