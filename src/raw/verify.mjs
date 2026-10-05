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

export function verifyAgainst(sealedFiles, original, { fs = nodeFs } = {}) {
  const name = path.basename(original);
  const cache = createFrameCache(8);
  const files = [];
  let fd = null;
  try {
    const size = fs.statSync(original).size;
    for (const f of sealedFiles) files.push(openSealed(f, { fs, frameCache: cache }));
    const shardIdx = files.map((sf) => sf.shards.findIndex((s) => s.name === name && s.length === size));
    const bad = shardIdx.findIndex((k) => k < 0);
    if (bad >= 0) return fail(`${path.basename(sealedFiles[bad])} does not record ${name} of ${size} bytes (it records ${files[bad].shards.map((s) => `${s.name} of ${s.length}`).join(', ')}) — the original is longer, shorter or another file`);
    const shard = files[0].shards[shardIdx[0]];
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
    if (n !== shard.lines || pos !== size) return fail(`the sealed copies cover ${n} lines / ${pos} bytes of ${name}, which has ${size} bytes (${shard.lines} lines recorded)`);
    if (whole.digest('hex') !== shard.sha256) return fail(`${name} does not hash to the sha256 recorded at sealing`);
    return { ok: true, original, sealed: sealedFiles, records: n, bytes: pos, mode: 'against-original' };
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
  const sealed = [];
  if (fs.statSync(target).isDirectory()) {
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth === 0) walk(p, 1); } else if (isSealedPath(e.name)) sealed.push(p);
      }
    };
    walk(target, 0);
  } else sealed.push(target);
  const groups = new Map(), alone = [];
  for (const f of sealed) {
    const src = sealedSources(f, { fs });
    const orig = src && src.length === 1 ? src[0].abs : null;
    if (orig && fs.existsSync(orig)) { if (!groups.has(orig)) groups.set(orig, []); groups.get(orig).push(f); } else alone.push(f);
  }
  return [...[...groups].map(([orig, files]) => verifyAgainst(files, orig, { fs })), ...alone.map((f) => verifySelf(f, { fs }))];
}

// The CLI's verify: every result, ok or not, is journalled (a failed check MUST leave a durable record).
export function runVerify({ target, against = null, fs = nodeFs, journal = defaultJournalPath() }) {
  const results = against ? [verifyAgainst([target], against, { fs })] : verifyTree(target, { fs });
  for (const r of results) {
    appendJournal({ op: 'verify', outcome: r.ok ? 'ok' : 'failed', mode: r.mode, sealed: r.sealed, original: r.original,
      ...(r.ok ? { records: r.records } : { reason: r.reason }) }, { journal });
  }
  return results;
}
