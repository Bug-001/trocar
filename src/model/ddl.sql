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
  request_bytes BIGINT,     -- wire body bytes, counted past the 64 MiB storage cap (D40): INT would overflow on one 3 GiB download
  raw_ref TEXT,
  stop_reason TEXT,
  duration_ms INT,
  error TEXT,
  compaction BOOL,
  compaction_from INT,
  compaction_to INT,
  unmapped_count INT,
  extra JSON,
  wire_format TEXT,         -- D37 (3.2:49) anthropic | openai-responses | openai-chat, per call
  vendor TEXT,              -- D37 (3.2:50) from the envelope host; unknown = NULL
  transport TEXT,           -- D37 (3.2:51) http | ws
  context_state TEXT,       -- D37 (3.2:52) complete | reconstructed | partial | server_edited
  observer_effect JSON,     -- D37 (3.2:53) what capture changed in the client; NULL = none known
  harness TEXT,             -- D40 (3.2) call-level harness id (the read-side table's; NULL = not identified); control rows have one too
  host TEXT,                -- D40 the envelope host (SNI etc.), else the Host header
  traffic_class TEXT,       -- D40 llm | token-count | session-sync | telemetry | files | account | other
  body_retention TEXT,      -- D40 full | log (the operator's setting) | legacy-meta (a non-LLM record from before D40: its length only)
  response_bytes BIGINT,    -- D40 wire response body bytes (body_wire_bytes.resp, counted past the cap); NULL = not recorded (never 0)
  record_bytes BIGINT       -- D40 this record's line on disk, newline included = the stored bytes; NULL = not known
);
-- D37 migration for a store created before these columns existed. Placed BEFORE the views, and a no-op
-- on a fresh store (IF NOT EXISTS). New columns come last on both, so column order matches.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS wire_format TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS vendor TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transport TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS context_state TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS observer_effect JSON;
-- D40 migration, same way: new columns come last on both, so the order matches a fresh store.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS harness TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS host TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS traffic_class TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS body_retention TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS response_bytes BIGINT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS record_bytes BIGINT;
-- The three byte counts are BIGINT: a body is counted whole past the storage cap, and one INT32 overflow rolled back a whole ETL batch
-- and every later one. A store made while they were INT is widened here (a no-op, in milliseconds, once they are BIGINT).
ALTER TABLE calls ALTER COLUMN request_bytes SET DATA TYPE BIGINT;
ALTER TABLE calls ALTER COLUMN response_bytes SET DATA TYPE BIGINT;
ALTER TABLE calls ALTER COLUMN record_bytes SET DATA TYPE BIGINT;

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
