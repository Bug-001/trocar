#!/usr/bin/env node
// bench/raw-bench.mjs — D35 benchmarks on a generated shard (4.6 E3 / E4). Not part of `npm test`.
//   node bench/raw-bench.mjs seal <raw/<segment>.ndjson> <lock>   E4: seal one segment, default heap
//   node bench/raw-bench.mjs read <dir of .sealed> [n=1000] [seed=7] E3: random raw_ref reads in a NEW process
// Prints one JSON line of numbers. Run on synthetic data only (bench/raw-gen.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { sealSegment } from '../src/raw/seal.mjs';
import { openSealed } from '../src/raw/reader.mjs';
import { buildResolver } from '../src/query/source.mjs';

const [mode, a, b, c] = process.argv.slice(2);
const mb = (x) => Math.round(x / 1048576);
const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(2); };
const rssMB = () => mb(process.memoryUsage().rss);

if (mode === 'seal') {
  const shard = a, lock = b, journal = path.join(path.dirname(shard), 'bench-journal.jsonl');
  const size = fs.statSync(shard).size;
  const t0 = Date.now(), at = {};
  const res = await sealSegment(shard, { lockFile: lock, journal, onPhase: (p) => { at[p] = at[p] || Date.now() - t0; } });
  const total = Date.now() - t0;
  console.log(JSON.stringify({ e4: 'seal', input_bytes: size, input_gib: +(size / 2 ** 30).toFixed(3), records: res.records,
    sealed_bytes: res.sealedBytes, sealed_pct: +(res.sealedBytes / size * 100).toFixed(3),
    encode_s: +(at.written / 1000).toFixed(1), verify_s: +((at.verified - at.written) / 1000).toFixed(1), total_s: +(total / 1000).toFixed(1),
    peak_rss_mb: mb(process.resourceUsage().maxRSS * 1024), heap_limit_mb: mb((await import('node:v8')).getHeapStatistics().heap_size_limit) }));
} else if (mode === 'read') {
  const ses = a, n = Number(b || 1000);
  let seed = Number(c || 7) >>> 0;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const files = fs.readdirSync(ses).filter((x) => x.endsWith('.sealed')).map((x) => path.join(ses, x));   // flat, as raw/ holds them
  const refs = [];
  let totalFrames = 0, totalBytes = 0;
  const pool = [];
  for (const f of files) {
    const sf = openSealed(f); totalFrames += sf.frames.length; totalBytes += sf.size;
    for (let i = 0; i < sf.count; i++) { const e = sf.entry(i); if (e.id) pool.push(`${e.stream}#${e.id}::0-64`); }
    sf.close();
  }
  for (let i = 0; i < n; i++) refs.push(pool[Math.floor(rnd() * pool.length)]);
  const t0 = Date.now();
  const resolve = await buildResolver(ses);
  const indexMs = Date.now() - t0, rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const pass = () => refs.map((r) => {
    const t = process.hrtime.bigint();
    const out = resolve.detail(r);
    if (out.status !== 'ok') throw new Error(`${r}: ${out.status} ${out.reason}`);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    peak = Math.max(peak, process.memoryUsage().rss);
    return ms;
  });
  const cold = pass(), hot = pass();
  console.log(JSON.stringify({ e3: 'random raw_ref reads', sealed_files: files.length, sealed_bytes: totalBytes, frames_total: totalFrames, refs: n,
    index_build_ms: indexMs, cold_p50_ms: pct(cold, 50), cold_p95_ms: pct(cold, 95), cold_max_ms: pct(cold, 100),
    hot_p50_ms: pct(hot, 50), hot_p95_ms: pct(hot, 95), frame_decodes: resolve.frameStats.decodes, frame_hits: resolve.frameStats.hits, max_frames_resident: resolve.frameStats.maxResident, rss_after_index_mb: mb(rss0), rss_growth_mb: mb(peak - rss0), peak_rss_mb: mb(process.resourceUsage().maxRSS * 1024) }));
  resolve.dispose();
} else {
  console.error('usage: node bench/raw-bench.mjs seal <shard> <sessionsDir> | read <sessionsDir> [n] [seed]');
  process.exit(1);
}
