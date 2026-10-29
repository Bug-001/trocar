#!/usr/bin/env node
// scripts/storage-e7.mjs — 4.6 E7 7. / D71⑤: everything one session holds on disk (its raw + its derived index) against the
// harness's own session log. Measurement only: reads the home, never writes into it, builds no index.
//
//   node scripts/storage-e7.mjs --home <trocar home> --session <id> --harness-log <path> [--harness-log <path>…]
//
// Prints one JSON document (bytes and ratios only). Apportioning, the same for every harness: a segment's share of the session =
// Σ stored_bytes of its index rows keyed to the session ÷ Σ stored_bytes of all its rows; the session's raw / index / usage bytes
// = Σ share × that segment's file on disk (sealed when there is one, else plain). ctx = the session's directory index/ctx/<k>/
// (plus flat `<k>.*` leftovers). `nearby` = the same over rows with no session key of the session's harness inside its first..last
// ts: an upper bound for the same process's other traffic (telemetry and the like, D40), reported beside the total, not in it.
// Rows the collector would put in a synthesized-key session are known only online; they are not counted (note
// `synth-rows-not-counted` when the window holds such rows). A segment without an index is listed in `unindexed`.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { readIndex, segmentFiles, indexDir } from '../src/query/index-build.mjs'
import { sessionDir } from '../src/query/projection.mjs'
import { SEALED_EXT } from '../src/raw/seal.mjs'

// D71⑤: the hard line for the session's total, the target, and the derived layer's line (each × the harness's own log)
const LINES = { total: 1.5, target: 1.0, derived: 0.1 }

function size(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return { bytes: 0, files: 0 }; }
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  const out = { bytes: 0, files: 0 };
  for (const n of fs.readdirSync(p)) { const s = size(path.join(p, n)); out.bytes += s.bytes; out.files += s.files; }
  return out;
}
const sum = (a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files });
const ratio = (n, d) => (d > 0 ? n / d : null);

function measure({ home, session, logs }) {
  const segments = [], unindexed = [];
  let first = null, last = null;
  const harnessIds = new Map();
  // pass 1: the session's share of each segment, its ts window and its harness
  for (const [segment, at] of segmentFiles(home, fs)) {
    const idxFile = path.join(indexDir(home), `${segment}.json`);
    const idx = readIndex(fs, idxFile);
    if (!idx) { unindexed.push(segment); continue; }
    let all = 0, mine = 0;
    for (const r of idx.records) {
      const b = r.stored_bytes || 0;
      all += b;
      if (r.session_key !== session) continue;
      mine += b;
      if (r.ts && (first === null || r.ts < first)) first = r.ts;
      if (r.ts && (last === null || r.ts > last)) last = r.ts;
      harnessIds.set(r.harness_id, (harnessIds.get(r.harness_id) || 0) + 1);
    }
    const raw = path.join(home, 'raw', `${segment}${at.sealed ? SEALED_EXT : '.ndjson'}`);
    segments.push({ segment, idxFile, all, mine, raw: size(raw).bytes, index: size(idxFile).bytes,
      usage: size(path.join(indexDir(home), `${segment}.usage.json`)).bytes });
  }
  const harnessId = [...harnessIds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // pass 2: rows with no session key of the same harness inside the window (read again, so no segment's rows are held)
  let synth = false;
  for (const s of segments) {
    s.near = 0;
    if (first === null || !s.all) continue;
    for (const r of readIndex(fs, s.idxFile).records) {
      if (r.session_key != null || r.harness_id !== harnessId || !r.ts || r.ts < first || r.ts > last) continue;
      s.near += r.stored_bytes || 0;
      if (r.synth_hash) synth = true;
    }
  }
  const part = (field, of) => Math.round(segments.reduce((n, s) => n + (s.all ? (s[of] / s.all) * s[field] : 0), 0));
  const dir = sessionDir(home, session), base = path.basename(dir);
  let ctx = size(dir);
  try { for (const n of fs.readdirSync(path.dirname(dir))) if (n.startsWith(`${base}.`)) ctx = sum(ctx, size(path.join(path.dirname(dir), n))); } catch { /* no ctx/ */ }
  const harness = logs.map(size).reduce(sum, { bytes: 0, files: 0 });
  const raw = part('raw', 'mine'), index = part('index', 'mine'), usage = part('usage', 'mine');
  const derived = index + usage + ctx.bytes, total = raw + derived, near = part('raw', 'near');
  const r = { total: ratio(total, harness.bytes), derived: ratio(derived, harness.bytes) };
  return {
    session,
    raw: { bytes: raw, segments: segments.filter((s) => s.mine).length },
    index: { bytes: index }, usage: { bytes: usage }, ctx, derived: { bytes: derived }, total: { bytes: total },
    harness, ratio: r, lines: LINES,
    pass: { total: r.total !== null && r.total <= LINES.total, derived: r.derived !== null && r.derived <= LINES.derived },
    nearby: { raw: near, ratio: ratio(near, harness.bytes) },
    unindexed,
    ...(synth ? { note: 'synth-rows-not-counted' } : {}),
  };
}

const { values } = parseArgs({ options: { home: { type: 'string' }, session: { type: 'string' }, 'harness-log': { type: 'string', multiple: true } } });
if (!values.home || !values.session || !values['harness-log']?.length) {
  process.stderr.write('usage: node scripts/storage-e7.mjs --home <trocar home> --session <id> --harness-log <path> [--harness-log <path>…]\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify(measure({ home: values.home, session: values.session, logs: values['harness-log'] }), null, 2) + '\n');
