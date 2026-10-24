#!/usr/bin/env node
// bench/raw-v2.mjs — container v1 vs v2 on real sealed segments (4.6 E11, AC2-AC7). Not part of `npm test`.
//   node bench/raw-v2.mjs --sealed <dir of COPIED v1 .sealed files> --work <scratch dir>
//                         [--baseline <repo root whose sealer writes v1>] [--limit N]
// One segment at a time: rebuild its plaintext from the v1 file and seal it with this checkout (v2) and, with --baseline,
// with the older sealer (v1), each seal in its own process (`bench/raw-bench.mjs seal` of that repo), so time and peak
// RSS are the sealer's alone; compare every record v1 vs v2 byte for byte; count the frames each v2 record touches and
// the frame decodes of an in-order read; per envelope traffic_class, seal the class alone and the segment without it.
// Prints sizes, counts and timings only — never record content. Everything it writes lives under --work and is
// removed before the next segment.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSealed, createFrameCache } from '../src/raw/reader.mjs';

const args = {};
for (let a = process.argv.slice(2); a.length;) { const k = a.shift(); args[k.replace(/^--/, '')] = a.shift(); }
if (!args.sealed || !args.work) { console.error('usage: raw-v2.mjs --sealed <dir> --work <dir> [--baseline <repo>] [--limit N]'); process.exit(2); }
const work = path.resolve(args.work);
const limit = args.limit ? Number(args.limit) : Infinity;
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos = { v2: here, ...(args.baseline ? { v1: path.resolve(args.baseline) } : {}) };

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const ratio = (a, b) => (b ? +(a / b).toFixed(4) : null);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const add = (t, row) => { for (const [k, v] of Object.entries(row)) if (typeof v === 'number') t[k] = +((t[k] || 0) + v).toFixed(3); };

// Write `lines()` of `src` (filtered) as plaintext segment `seg` under <work>/<sub>/raw.
function writePlain(src, seg, sub, keep = () => true) {
  const raw = path.join(work, sub, 'raw');
  fs.mkdirSync(raw, { recursive: true });
  const file = path.join(raw, `${seg}.ndjson`);
  const fd = fs.openSync(file, 'w', 0o600);
  const h = createHash('sha256');
  let n = 0;
  try { for (const { line } of src.lines()) if (keep(line)) { fs.writeSync(fd, line); h.update(line); n += line.length; } } finally { fs.closeSync(fd); }
  return { file, raw: n, sha256: h.digest('hex') };
}
// Seal a fresh plaintext with `repo`'s sealer in a child process; the sealer deletes the plaintext, so every seal
// writes its own. Returns the child's numbers plus took_ms from the journal it writes beside the shard.
function seal(repo, src, seg, sub, keep) {
  const p = writePlain(src, seg, sub, keep);
  const lock = path.join(work, sub, 'lock');
  fs.writeFileSync(lock, JSON.stringify({ segment: '19700101T000000Z' }) + '\n');
  const r = spawnSync(process.execPath, [path.join(repo, 'bench/raw-bench.mjs'), 'seal', p.file, lock], { encoding: 'utf8', maxBuffer: 1 << 20 });
  if (r.status !== 0) throw new Error(`seal (${repo}) exited ${r.status}: ${(r.stderr || '').trim().split('\n').at(-1)}`);
  const o = JSON.parse(r.stdout.trim().split('\n').at(-1));
  const j = JSON.parse(fs.readFileSync(path.join(path.dirname(p.file), 'bench-journal.jsonl'), 'utf8').trim().split('\n').at(-1));
  if (j.outcome !== 'ok') throw new Error(`seal ${j.outcome}: ${j.reason}`);
  return { sealed: j.sealed, plain: p, row: { bytes: fs.statSync(j.sealed).size, took_ms: j.took_ms, encode_s: o.encode_s, verify_s: o.verify_s, peak_rss_mb: o.peak_rss_mb } };
}
function sealBoth(src, seg, sub, keep) {
  const out = {};
  for (const v of Object.keys(repos)) { out[v] = seal(repos[v], src, seg, sub, keep).row.bytes; rm(path.join(work, sub)); }
  return out;
}
function classOf(line) {
  try { const c = JSON.parse(line.toString('utf8')).traffic_class; return typeof c === 'string' ? c : '(none)'; } catch { return '(unparseable)'; }
}

const segs = fs.readdirSync(args.sealed).filter((n) => /\.sealed$/.test(n)).sort().slice(0, limit);
const tot = { segments: 0, raw: 0, v1: 0, records: 0, mismatches: 0, sha_mismatches: 0, seal: {}, decodes: {}, classes: {} };
const frames = [], rss = { v1: [], v2: [] };
fs.mkdirSync(work, { recursive: true });

for (const name of segs) {
  const seg = name.slice(0, -'.sealed'.length);
  const v1File = path.join(args.sealed, name);
  const v1 = openSealed(v1File);
  const out = { segment: seg, records: v1.records.length, raw: v1.shards[0].length, v1: fs.statSync(v1File).size, seal: {} };
  try {
    // 1. each sealer on the plaintext rebuilt from the v1 file (checked against its source table); v2's file is kept.
    let v2File;
    for (const v of Object.keys(repos)) {
      const s = seal(repos[v], v1, seg, v);
      if (s.plain.raw !== out.raw || s.plain.sha256 !== v1.shards[0].sha256) throw new Error(`${seg}: plaintext rebuilt from v1 does not match its source table`);
      out.seal[v] = s.row; rss[v].push(s.row.peak_rss_mb);
      if (v === 'v2') v2File = s.sealed; else rm(path.join(work, v));
    }
    out.v1_reencoded = out.seal.v1?.bytes ?? null;
    out.v2_over_v1 = ratio(out.seal.v2.bytes, out.v1);
    // 2. every record v1 vs v2 and the v2 whole against the source sha256; frames per v2 record, with no line cache.
    const touched = new Set(), fc = createFrameCache();
    const v2 = openSealed(v2File, {
      frameCache: { get: (k) => { touched.add(k); return fc.get(k); }, set: (k, v) => { touched.add(k); fc.set(k, v); } },
      lineCache: { get: () => undefined, set: () => {} },
    });
    const segFrames = [], whole = createHash('sha256');
    let mismatches = 0;
    try {
      for (let i = 0; i < v1.records.length; i++) {
        touched.clear();
        const b = v2.lineAt(i);
        segFrames.push(touched.size);
        whole.update(b);
        if (!v1.lineAt(i).equals(b)) mismatches++;
      }
    } finally { v2.close(); }
    out.mismatches = mismatches;
    out.sha_ok = whole.digest('hex') === v1.shards[0].sha256;
    out.frames = { p50: pct(segFrames, 50), p99: pct(segFrames, 99), max: pct(segFrames, 100) };
    frames.push(...segFrames);
    // 3. in-order reads of the v2 file with the default frame cache: decodes = cache sets for lineAt(0..n-1), and
    // brotli calls for lines().
    const dc = { frames: 0, lineAt_decodes: 0, lines_decodes: 0, lineAt_ms: 0, lines_ms: 0 };
    const cache = createFrameCache(), set = cache.set.bind(cache);
    cache.set = (k, v) => { dc.lineAt_decodes++; return set(k, v); };
    const a = openSealed(v2File, { frameCache: cache });
    dc.frames = a.frames.length;
    let t0 = performance.now();
    try { for (let i = 0; i < a.records.length; i++) a.lineAt(i); } finally { a.close(); }
    dc.lineAt_ms = Math.round(performance.now() - t0);
    const brotli = zlib.brotliDecompressSync;
    zlib.brotliDecompressSync = (...x) => { dc.lines_decodes++; return brotli(...x); };
    const b = openSealed(v2File);
    t0 = performance.now();
    try { for (const _ of b.lines()); } finally { b.close(); zlib.brotliDecompressSync = brotli; }
    dc.lines_ms = Math.round(performance.now() - t0);
    out.decodes = dc;
    rm(path.join(work, 'v2'));
    // 4. per traffic class: the class alone, and the segment without it (its in-file contribution = all − without).
    const classes = new Map();
    for (const { line } of v1.lines()) { const c = classOf(line); classes.set(c, (classes.get(c) || 0) + line.length); }
    out.classes = {};
    for (const c of [...classes.keys()].sort()) {
      const alone = sealBoth(v1, seg, 'cls', (l) => classOf(l) === c);
      const without = classes.size > 1 ? sealBoth(v1, seg, 'cls', (l) => classOf(l) !== c) : { v1: 0, v2: 0 };
      const row = { raw: classes.get(c), v1: alone.v1 ?? null, v2: alone.v2,
        infile_v1: out.seal.v1 ? out.seal.v1.bytes - without.v1 : null, infile_v2: out.seal.v2.bytes - without.v2 };
      out.classes[c] = row;
      add((tot.classes[c] ||= {}), row);
    }
  } finally {
    v1.close();
    // 5. nothing of this segment survives into the next one.
    for (const sub of ['v1', 'v2', 'cls']) rm(path.join(work, sub));
  }
  tot.segments++; tot.raw += out.raw; tot.v1 += out.v1; tot.records += out.records;
  tot.mismatches += out.mismatches; tot.sha_mismatches += out.sha_ok ? 0 : 1;
  for (const v of Object.keys(out.seal)) { const { peak_rss_mb, ...r } = out.seal[v]; add((tot.seal[v] ||= {}), r); }
  add(tot.decodes, out.decodes);
  console.log(JSON.stringify(out));
}

for (const v of Object.keys(tot.seal)) Object.assign(tot.seal[v], { peak_rss_mb_max: pct(rss[v], 100), peak_rss_mb_median: pct(rss[v], 50) });
console.log(JSON.stringify({ total: true, ...tot, v2_over_v1: ratio(tot.seal.v2?.bytes, tot.v1),
  frames: { p50: pct(frames, 50), p99: pct(frames, 99), max: pct(frames, 100) } }));
