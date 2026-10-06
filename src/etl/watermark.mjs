// src/etl/watermark.mjs — per-session incremental checkpoints (RFC 4.2 §增量).
//
// DuckDB-backed DERIVED metadata: dropped + rebuilt together with the projection
// tables (派生可丢弃,不变式 2). The watermark is only a fast-forward —
// correctness ultimately rests on the PK upserts in the orchestrator; this table
// merely lets an incremental run skip records already consumed for each session.
//
// KEYED BY session_id, NEVER by source path (RFC 4.2:49). The capture dir slug is
// renamed `_unresolved`→<slug> once identity resolves (demo `ensureLocation`
// renameSync); a path-keyed watermark would re-ingest or drop rows across that
// rename. A session_id key is rename-safe.

// Session-less control-plane records share ONE bucket. NUL-free sentinel: a NUL byte
// in a DuckDB TEXT/VARCHAR value truncates on read, so we avoid '\x00…' here.
export const CONTROL_KEY = '__control__';

export async function ensureWatermarkTable(conn) {
  await conn.run(
    'CREATE TABLE IF NOT EXISTS etl_watermark (' +
      'session_id VARCHAR PRIMARY KEY, records_consumed BIGINT NOT NULL, last_ts VARCHAR)',
  );
}

// How many records have been consumed for `key` (0 when unseen). Number-normalized
// (DuckDB BIGINT round-trips as a JS BigInt).
export async function getConsumed(conn, key) {
  const rows = (
    await conn.runAndReadAll('SELECT records_consumed FROM etl_watermark WHERE session_id = $1', [key])
  ).getRowObjects();
  return rows.length ? Number(rows[0].records_consumed) : 0;
}

export async function setConsumed(conn, key, n, lastTs = null) {
  await conn.run(
    'INSERT INTO etl_watermark VALUES ($1,$2,$3) ON CONFLICT (session_id) ' +
      'DO UPDATE SET records_consumed = excluded.records_consumed, last_ts = excluded.last_ts',
    [key, n, lastTs],
  );
}

// Rebuild path: clear every checkpoint so a full re-ingest replays from record 0.
export async function resetWatermark(conn) {
  await conn.run('DELETE FROM etl_watermark');
}

// The projection version a store was written by (4.2:51 增量 == 全量). Derived metadata like the watermark, in a
// one-row-per-key table; a store with no row was written before versions were stored.
export async function ensureMetaTable(conn) {
  await conn.run('CREATE TABLE IF NOT EXISTS etl_meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
}
export async function getProjectionVersion(conn) {
  const rows = (await conn.runAndReadAll("SELECT value FROM etl_meta WHERE key = 'projection_version'")).getRowObjects();
  return rows.length ? Number(rows[0].value) : null;
}
export async function setProjectionVersion(conn, v) {
  await conn.run("INSERT INTO etl_meta VALUES ('projection_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [String(v)]);
}
