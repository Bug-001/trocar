// asight · shared DuckDB connection helper (D18b: @duckdb/node-api official binding).
// The single place that OPENS the derived store. ETL (4.2) writes through it; the
// server (4.4) reads through it (readOnly). It NEVER creates schema — that is 3.2
// schema.mjs. Store path authority = SHARED CONTRACT (D18 + PROPOSED LAYOUT) / 3.2+4.2.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo-root/db/asight.duckdb — src/ is one level under repo root.
export const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'db', 'asight.duckdb');

// readOnly=false (default): ETL write path — mkdir + open read-write.
// readOnly=true: the 4.4 server consumes the SAME helper without write capability
// (RFC 4.4:32 服务 MUST NOT 写存储). No mkdir; DuckDB opens the existing file READ_ONLY.
export async function openDb(dbPath = DEFAULT_DB_PATH, { readOnly = false } = {}) {
  if (!readOnly) await mkdir(path.dirname(dbPath), { recursive: true });
  const instance = await DuckDBInstance.create(
    dbPath,
    readOnly ? { access_mode: 'READ_ONLY' } : undefined,
  );
  const connection = await instance.connect();
  return {
    instance,
    connection,
    readOnly,
    async close() {
      // closeSync exists on recent @duckdb/node-api; guarded so the helper stays
      // runnable across binding versions (unclosed handles are GC-reclaimed anyway).
      connection.closeSync?.();
      instance.closeSync?.();
    },
  };
}
