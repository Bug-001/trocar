#!/usr/bin/env node
// src/etl/cli.mjs — populate the derived DuckDB store from an NDJSON capture stream.
// usage: node src/etl/cli.mjs <ndjson|dir> [--db <path>] [--rebuild]
//   --rebuild : DROP the derived projection + re-ingest (source stays the only truth).
// Write path only (openDb read-write); the server (4.4) opens the same store readOnly.
import fs from 'node:fs';
import path from 'node:path';
import { openDb, DEFAULT_DB_PATH } from '../db.mjs';
import { applyDDL } from '../model/schema.mjs';
import { runEtl, rebuild } from './orchestrator.mjs';
import { readRecords } from './ingest.mjs';
import { isCaptureFile } from '../paths.mjs';

// A directory source = its TOP-LEVEL *.ndjson in name order (capture-<date> sorts by date), as the
// board reads a root (4.4:129). Subdirectories (the collector's flows/ audit/ replays/) are never read.
// A symlinked capture is still a capture: the same rule as the board and the resolver
// (src/paths.mjs isCaptureFile); isFile() alone is false for a symlink and drops it without a word.
// The files stream into ONE runEtl, so a session spanning two days keeps one watermark, and every
// record carries the basename of the file it came from (readRecords stamps _stream; 4.2:39).
function sourceList(source) {
  if (!fs.statSync(source).isDirectory()) return [source];
  return fs.readdirSync(source, { withFileTypes: true })
    .filter((e) => isCaptureFile(source, e))
    .map((e) => path.join(source, e.name))
    .sort();
}

export async function etlFile(source, { dbPath = DEFAULT_DB_PATH, rebuild: doRebuild = false } = {}) {
  const files = sourceList(source);
  let count = 0;
  async function* records() {
    for (const f of files) for (const r of await readRecords(f)) { count++; yield r; } // r._stream = basename(f)
  }
  const db = await openDb(dbPath);
  try {
    await applyDDL(db.connection);
    const opts = { streamBasename: path.basename(files[0] || source) }; // fallback only; records carry _stream
    const stats = doRebuild
      ? await rebuild(records(), db.connection, opts)
      : await runEtl(records(), db.connection, opts);
    return { file: source, files, dbPath, records: count, stats };
  } finally {
    await db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const di = args.indexOf('--db');
  const dbPath = di >= 0 ? args[di + 1] : DEFAULT_DB_PATH;
  const doRebuild = args.includes('--rebuild');
  if (!file) {
    console.error('usage: node src/etl/cli.mjs <ndjson|dir> [--db <path>] [--rebuild]');
    process.exit(1);
  }
  const out = await etlFile(file, { dbPath, rebuild: doRebuild });
  console.log(`ETL: ${out.records} records from ${out.file} → ${out.dbPath}`);
  console.log('   ', JSON.stringify(out.stats));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
