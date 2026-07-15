#!/usr/bin/env node
// src/etl/cli.mjs — populate the derived DuckDB store from an NDJSON capture stream.
// usage: node src/etl/cli.mjs <ndjson> [--db <path>] [--rebuild]
//   --rebuild : DROP the derived projection + re-ingest (source stays the only truth).
// Write path only (openDb read-write); the server (4.4) opens the same store readOnly.
import path from 'node:path';
import { openDb, DEFAULT_DB_PATH } from '../db.mjs';
import { applyDDL } from '../model/schema.mjs';
import { runEtl, rebuild } from './orchestrator.mjs';
import { readRecords } from './ingest.mjs';

export async function etlFile(file, { dbPath = DEFAULT_DB_PATH, rebuild: doRebuild = false } = {}) {
  const records = await readRecords(file);
  const db = await openDb(dbPath);
  try {
    await applyDDL(db.connection);
    const streamBasename = path.basename(file);
    const stats = doRebuild
      ? await rebuild(records, db.connection, { streamBasename })
      : await runEtl(records, db.connection, { streamBasename });
    return { file, dbPath, records: records.length, stats };
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
    console.error('usage: node src/etl/cli.mjs <ndjson> [--db <path>] [--rebuild]');
    process.exit(1);
  }
  const out = await etlFile(file, { dbPath, rebuild: doRebuild });
  console.log(`ETL: ${out.records} records from ${out.file} → ${out.dbPath}`);
  console.log('   ', JSON.stringify(out.stats));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
