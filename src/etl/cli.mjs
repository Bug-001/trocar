#!/usr/bin/env node
// src/etl/cli.mjs — populate the derived DuckDB store from an NDJSON capture stream.
// usage: node src/etl/cli.mjs <ndjson|sealed|dir> [--db <path>] [--rebuild]
//   --rebuild : DROP the derived projection + re-ingest (source stays the only truth).
// Write path only (openDb read-write); the server (4.4) opens the same store readOnly.
import fs from 'node:fs';
import path from 'node:path';
import { openDb, DEFAULT_DB_PATH } from '../db.mjs';
import { applyDDL } from '../model/schema.mjs';
import { runEtl, rebuild } from './orchestrator.mjs';
import { readRecords } from './ingest.mjs';
import { isCaptureFile, skipReason } from '../paths.mjs';
import { appendJournal, sealedReadProblem, defaultJournalPath } from '../raw/journal.mjs';

// A directory source = its TOP-LEVEL *.ndjson in name order (capture-<date> sorts by date), as the
// board reads a root (4.4:129). Subdirectories (the collector's flows/ audit/ replays/) are never read.
// A symlinked capture is still a capture: the same rule as the board and the resolver
// (src/paths.mjs isCaptureFile); isFile() alone is false for a symlink and drops it without a word.
// The files stream into ONE runEtl, so a session spanning two days keeps one watermark, and every
// record carries the basename of the file it came from (readRecords stamps _stream; 4.2:39).
// What is not read is returned with its reason and printed (4.4:83 · invariant 4), never dropped.
function sourceList(source) {
  if (!fs.statSync(source).isDirectory()) return { files: [source], skipped: [] };
  const files = [], skipped = [];
  for (const e of fs.readdirSync(source, { withFileTypes: true })) {
    if (isCaptureFile(source, e)) files.push(path.join(source, e.name));
    else skipped.push({ name: e.name, ...skipReason(source, e) });
  }
  return { files: files.sort(), skipped: skipped.sort((a, b) => (a.name < b.name ? -1 : 1)) };
}

export async function etlFile(source, { dbPath = DEFAULT_DB_PATH, rebuild: doRebuild = false, journal = defaultJournalPath() } = {}) {
  const { files, skipped } = sourceList(source);
  let count = 0;
  const corrupt = {}; // file → lines holding a record that would not parse (not ingested; counted, printed)
  // A sealed file that could not be read in full: ingest what was readable, and leave a durable,
  // reasoned record of what was not (user requirement 2026-10-06 — no silent failures).
  const sourceErrors = [];
  async function* records() {
    for (const f of files) {
      const recs = await readRecords(f); // r._stream = basename(f); for a sealed file, the record's ORIGINAL stream (D35)
      if (recs.scan && recs.scan.skippedLines) corrupt[f] = recs.scan.skippedLines;
      const problem = sealedReadProblem(recs.scan);
      if (problem) { problem.journaled = appendJournal({ op: 'read', reader: 'etl', outcome: 'failed', ...problem }, { journal }); sourceErrors.push(problem); }
      for (const r of recs) { count++; yield r; }
    }
  }
  const db = await openDb(dbPath);
  try {
    await applyDDL(db.connection);
    // readRecords stamps every record with the stream it was read from — for a sealed file, the
    // record's ORIGINAL stream (D35) — so raw_ref is the same before and after sealing.
    const opts = { streamBasename: path.basename(files[0] || source), streamOf: (r) => r._stream }; // basename: fallback only
    const stats = doRebuild
      ? await rebuild(records(), db.connection, opts)
      : await runEtl(records(), db.connection, opts);
    return { file: source, files, skipped, corrupt_lines: corrupt, dbPath, records: count, stats, sourceErrors };
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
    console.error('usage: node src/etl/cli.mjs <ndjson|sealed|dir> [--db <path>] [--rebuild]');
    process.exit(1);
  }
  const out = await etlFile(file, { dbPath, rebuild: doRebuild });
  console.log(`ETL: ${out.records} records from ${out.file} → ${out.dbPath}`);
  console.log('   ', JSON.stringify(out.stats));
  reportSkips(out);
  if (out.sourceErrors.length) process.exitCode = 1;
}

// Printed by both entry points (this file and `asight etl`): a capture-like entry that was not read,
// or a line that would not parse, goes to stderr; subdirectories and other files are counted and named.
export function reportSkips(out, log = console.error) {
  // a sealed file read only in part (journalled by etlFile); the callers also fail the command
  for (const e of out.sourceErrors || []) log(`ETL: ${e.file} could not be read in full (${e.unreadableRecords ?? 'all'} records unreadable): ${e.reason}${e.journaled ? ' — recorded in the raw journal' : ' — and the raw journal could not be written'}`);
  const warn = out.skipped.filter((x) => x.attention), rest = out.skipped.length - warn.length;
  for (const x of warn) log(`ETL: not read: ${x.name} (${x.reason})`);
  for (const [f, n] of Object.entries(out.corrupt_lines)) log(`ETL: ${n} unparseable line(s) not ingested: ${f}`);
  const dirs = out.skipped.filter((x) => !x.attention && x.reason === 'directory').map((x) => x.name);
  const files = out.skipped.filter((x) => !x.attention && x.reason !== 'directory').map((x) => x.name);
  if (dirs.length) log(`ETL: ${dirs.length} subdirector${dirs.length !== 1 ? 'ies' : 'y'} not descended (only top-level *.ndjson is read): ${dirs.join(', ')}`);
  if (files.length) log(`ETL: ${files.length} other file${files.length !== 1 ? 's' : ''} not read (not *.ndjson): ${files.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
