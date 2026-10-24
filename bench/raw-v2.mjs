#!/usr/bin/env node
// bench/raw-v2.mjs — container v1 vs v2 on real sealed segments (4.6 E11, AC2). Not part of `npm test`.
//   node bench/raw-v2.mjs --sealed <dir of COPIED v1 .sealed files> --work <scratch dir>
//                         [--baseline <repo root whose src/raw/seal.mjs writes v1>] [--limit N]
// One segment at a time: rebuild its plaintext from the v1 file, seal it with this checkout (v2) and, with --baseline,
// with the older sealer (v1 encode time on the same machine and data); compare every record v1 vs v2 byte for byte;
// count the frames each v2 record touches; split the segment by envelope traffic_class and seal each class alone.
// Prints sizes, counts and timings only — never record content. Everything it writes lives under --work and is
// removed before the next segment.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sealSegment } from '../src/raw/seal.mjs';
import { openSealed, createFrameCache } from '../src/raw/reader.mjs';

const args = {};
for (let a = process.argv.slice(2); a.length;) { const k = a.shift(); args[k.replace(/^--/, '')] = a.shift(); }
if (!args.sealed || !args.work) { console.error('usage: raw-v2.mjs --sealed <dir> --work <dir> [--baseline <repo>] [--limit N]'); process.exit(2); }
const work = path.resolve(args.work);
const limit = args.limit ? Number(args.limit) : Infinity;
const baseline = args.baseline ? (await import(pathToFileURL(path.join(path.resolve(args.baseline), 'src/raw/seal.mjs')).href)).sealSegment : null;

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const ratio = (a, b) => (b ? +(a / b).toFixed(4) : null);
const lastJournal = (j) => JSON.parse(fs.readFileSync(j, 'utf8').trim().split('\n').at(-1));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// Seal `lines()` of `src` (filtered) as segment `seg` under <work>/<sub>/raw with `seal`; returns { bytes, ms, raw }.
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
async function sealTimed(seal, file, sub) {
  const lock = path.join(work, sub, 'lock'), journal = path.join(work, sub, 'journal.jsonl');
  fs.writeFileSync(lock, JSON.stringify({ segment: '19700101T000000Z' }) + '\n');
  const res = await seal(file, { lockFile: lock, journal });
  const j = lastJournal(journal);
  if (j.outcome !== 'ok') throw new Error(`seal ${j.outcome}: ${j.reason}`);
  return { sealed: res.sealed, bytes: fs.statSync(res.sealed).size, ms: j.took_ms };
}
function classOf(line) {
  try { const c = JSON.parse(line.toString('utf8')).traffic_class; return typeof c === 'string' ? c : '(none)'; } catch { return '(unparseable)'; }
}

const segs = fs.readdirSync(args.sealed).filter((n) => /\.sealed$/.test(n)).sort().slice(0, limit);
const tot = { segments: 0, raw: 0, v1: 0, v2: 0, v1_reencoded: 0, enc_ms_v1: 0, enc_ms_v2: 0, records: 0, mismatches: 0, sha_mismatches: 0, frames: [], classes: {} };
fs.mkdirSync(work, { recursive: true });

for (const name of segs) {
  const seg = name.slice(0, -'.sealed'.length);
  const v1File = path.join(args.sealed, name);
  const v1 = openSealed(v1File);
  const out = { segment: seg, records: v1.records.length, raw: v1.shards[0].length, v1: fs.statSync(v1File).size };
  try {
    // 1. plaintext from the v1 file, checked against the source table.
    const p = writePlain(v1, seg, 'v2');
    if (p.raw !== v1.shards[0].length || p.sha256 !== v1.shards[0].sha256) throw new Error(`${seg}: plaintext rebuilt from v1 does not match its source table`);
    // 2. this checkout's sealer (v2).
    const s2 = await sealTimed(sealSegment, p.file, 'v2');
    out.v2 = s2.bytes; out.v2_over_v1 = ratio(s2.bytes, out.v1); out.enc_ms_v2 = s2.ms;
    // 3. the baseline's sealer (v1 encode time) on the same plaintext.
    if (baseline) {
      const pb = writePlain(v1, seg, 'base');
      const sb = await sealTimed(baseline, pb.file, 'base');
      out.v1_reencoded = sb.bytes; out.enc_ms_v1 = sb.ms;
      rm(path.join(work, 'base'));
    }
    // 4. every record v1 vs v2, and the v2 whole against the plaintext's sha256.
    // 5. frames per v2 record: the frame keys the reader asks for while rebuilding it, with no line cache.
    const touched = new Set(), fc = createFrameCache();
    const v2 = openSealed(s2.sealed, {
      frameCache: { get: (k) => { touched.add(k); return fc.get(k); }, set: (k, v) => { touched.add(k); fc.set(k, v); } },
      lineCache: { get: () => undefined, set: () => {} },
    });
    const frames = [], whole = createHash('sha256');
    let mismatches = 0;
    try {
      for (let i = 0; i < v1.records.length; i++) {
        touched.clear();
        const b = v2.lineAt(i);
        frames.push(touched.size);
        whole.update(b);
        if (!v1.lineAt(i).equals(b)) mismatches++;
      }
    } finally { v2.close(); }
    out.mismatches = mismatches;
    out.sha_ok = whole.digest('hex') === v1.shards[0].sha256;
    out.frames = { p50: pct(frames, 50), p99: pct(frames, 99), max: pct(frames, 100) };
    for (const f of frames) tot.frames.push(f);
    rm(path.join(work, 'v2'));
    // 6. per traffic class: each class alone, sealed with v2 (and the baseline).
    const classes = new Map();
    for (const { line } of v1.lines()) { const c = classOf(line); classes.set(c, (classes.get(c) || 0) + line.length); }
    out.classes = {};
    for (const c of [...classes.keys()].sort()) {
      const row = { raw: classes.get(c) };
      const pc = writePlain(v1, seg, 'cls', (l) => classOf(l) === c);
      row.v2 = (await sealTimed(sealSegment, pc.file, 'cls')).bytes;
      rm(path.join(work, 'cls'));
      if (baseline) { const pcb = writePlain(v1, seg, 'cls', (l) => classOf(l) === c); row.v1 = (await sealTimed(baseline, pcb.file, 'cls')).bytes; rm(path.join(work, 'cls')); }
      out.classes[c] = row;
      const t = (tot.classes[c] ||= { raw: 0, v1: 0, v2: 0 });
      t.raw += row.raw; t.v2 += row.v2; t.v1 += row.v1 || 0;
    }
  } finally {
    v1.close();
    // 7. nothing of this segment survives into the next one.
    for (const sub of ['v2', 'base', 'cls']) rm(path.join(work, sub));
  }
  tot.segments++; tot.raw += out.raw; tot.v1 += out.v1; tot.v2 += out.v2; tot.records += out.records;
  tot.v1_reencoded += out.v1_reencoded || 0; tot.enc_ms_v1 += out.enc_ms_v1 || 0; tot.enc_ms_v2 += out.enc_ms_v2;
  tot.mismatches += out.mismatches; tot.sha_mismatches += out.sha_ok ? 0 : 1;
  console.log(JSON.stringify(out));
}

const { frames, ...rest } = tot;
console.log(JSON.stringify({ total: true, ...rest, v2_over_v1: ratio(tot.v2, tot.v1),
  frames: { p50: pct(frames, 50), p99: pct(frames, 99), max: pct(frames, 100) } }));
