-- asight normalized model — DuckDB DDL (RFC 3.2). Central contract.
-- Raw NDJSON stays the byte-faithful source of truth; these tables are the
-- reproducible analytical projection. Every table carries `extra JSON`, holding
-- provider-native fields not mapped into canonical columns (never dropped).
-- NOTE: comments here intentionally contain ';' (e.g. this line; and below) —
-- applyDDL strips line comments BEFORE splitting on ';' so this is safe.

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  harness TEXT,
  provider TEXT,
  native_id TEXT,
  parent_session_id TEXT,
  fork_of_session_id TEXT,
  forked_at_seq INT,
  title TEXT,
  cwd TEXT,
  entrypoint TEXT,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  native_id_confidence TEXT,
  extra JSON
);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT,
  seq INT,
  ts TIMESTAMP,
  endpoint TEXT,
  model TEXT,
  stream BOOL,
  class TEXT,
  control_kind TEXT,
  lane TEXT,
  request_bytes INT,
  raw_ref TEXT,
  stop_reason TEXT,
  duration_ms INT,
  error TEXT,
  compaction BOOL,
  compaction_from INT,
  compaction_to INT,
  unmapped_count INT,
  extra JSON
);

-- Deduped context block content (same bytes across calls stored once).
CREATE TABLE IF NOT EXISTS block_contents (
  content_hash TEXT PRIMARY KEY,
  section TEXT,
  role TEXT,
  kind TEXT,
  chars INT,
  preview TEXT,
  text_ref TEXT,
  faithfulness TEXT,
  extra JSON
);

-- Ordered context of each call (assembly order tools->system->messages).
-- Comparing adjacent calls' content_hash sequences = cache-break signal.
CREATE TABLE IF NOT EXISTS call_blocks (
  call_id TEXT,
  seq INT,
  content_hash TEXT,
  cache_control TEXT,
  volatile BOOL,
  resource_ref TEXT,
  PRIMARY KEY (call_id, seq)
);

-- Normalized usage: fixed canonical roles; adapters map each provider in.
-- cache_write NULL = "provider has no write-cache concept" (MUST NOT be 0).
CREATE TABLE IF NOT EXISTS usage (
  call_id TEXT PRIMARY KEY,
  input_uncached INT,
  cache_read INT,
  cache_write INT,
  output INT,
  reasoning INT,
  total_input INT,
  extra JSON
);

-- Resource lifecycle events (file/dir/link/mcp/skill/tool/image/scaffold).
CREATE TABLE IF NOT EXISTS resource_events (
  session_id TEXT,
  seq INT,
  resource_id TEXT,
  kind TEXT,
  label TEXT,
  event TEXT,
  via TEXT,
  range TEXT,
  extra JSON
);

-- Per-call cache facts (two-layer model, RFC 3.3). D17 forensics columns:
-- structural/raw_divergence_seq, divergence_byte_offset, divergence_cause,
-- prefix_sha256 (verbatim-source ground truth), ground_truth_flag.
CREATE TABLE IF NOT EXISTS cache_events (
  call_id TEXT PRIMARY KEY,
  break_kind TEXT,
  hit_ratio DOUBLE,
  declared_breakpoints TEXT,
  structural_divergence_seq INT,
  raw_divergence_seq INT,
  divergence_byte_offset INT,
  divergence_cause TEXT,
  prefix_sha256 TEXT,
  cache_write_billing TEXT,
  ground_truth_flag TEXT,
  extra JSON
);

-- D9: session-less control noise sidebar projection.
CREATE VIEW IF NOT EXISTS control_calls AS
  SELECT call_id, ts, endpoint, control_kind, error, raw_ref
  FROM calls
  WHERE class = 'control';

-- Fidelity backstop + D7 self-evolution hook: which provider keys are still
-- unmapped, and how common. LEFT JOIN keeps control calls (session_id NULL).
CREATE VIEW IF NOT EXISTS unmapped_fields AS
  SELECT
    COALESCE(s.provider, 'control') AS provider,
    COALESCE(s.harness, 'control')  AS harness,
    t.json_key AS path,
    count(*) AS n
  FROM calls c
  LEFT JOIN sessions s ON s.session_id = c.session_id
  CROSS JOIN UNNEST(json_keys(c.extra)) AS t(json_key)
  GROUP BY 1, 2, 3
  ORDER BY n DESC;
