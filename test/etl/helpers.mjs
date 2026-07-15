// test/etl/helpers.mjs — shared fixtures + a deterministic full-table dump for the ETL
// (4.2) suites. Uses the REAL 3.2 DDL (schema.mjs applyDDL) and the REAL cc adapter via
// the orchestrator, so these tests exercise the actual capstone wiring, not stand-ins.
import { DuckDBInstance } from '@duckdb/node-api';
import { applyDDL } from '../../src/model/schema.mjs';

export async function freshConn() {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await applyDDL(conn);
  return conn;
}

// Deterministic dump of the derived projection for row-for-row equality assertions.
// TIMESTAMP columns are CAST to VARCHAR (the node-api binding returns a temporal object
// otherwise); BigInt scalars are normalized to Number.
const DUMP_SPEC = [
  ['sessions', 'session_id', '* REPLACE (CAST(started_at AS VARCHAR) AS started_at, CAST(ended_at AS VARCHAR) AS ended_at)'],
  ['calls', 'call_id', '* REPLACE (CAST(ts AS VARCHAR) AS ts)'],
  ['block_contents', 'content_hash', '*'],
  ['call_blocks', 'call_id, seq', '*'],
  ['usage', 'call_id', '*'],
  ['resource_events', 'session_id, seq', '*'],
  ['cache_events', 'call_id', '*'],
];
export async function dumpAll(conn) {
  const norm = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
  const out = {};
  for (const [table, order, proj] of DUMP_SPEC) {
    const rows = (await conn.runAndReadAll(`SELECT ${proj} FROM ${table} ORDER BY ${order}`)).getRowObjects();
    out[table] = JSON.parse(JSON.stringify(rows, norm));
  }
  return out;
}

export const countOf = async (conn, sql) =>
  Number((await conn.runAndReadAll(sql)).getRowObjects()[0].n);

// ── fixtures (VERBATIM req_body strings, D10 shape) ──────────────────────────────────
const SID = 'sess-A';
const HEADERS = { 'x-claude-code-session-id': SID, 'user-agent': 'claude-cli/1.0' };

// shared tools + system objects → identical serialized PREFIX across calls (dedup target).
function reqBodyString(msgs) {
  return JSON.stringify({
    model: 'claude-opus-4-6',
    stream: true,
    tools: [
      {
        name: 'Read',
        description: 'Read a file from disk',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
    system: [{ type: 'text', text: 'You are Claude Code. working directory: /repo' }],
    messages: msgs,
  });
}
function llmRec(id, userText, file, usage) {
  return {
    id,
    ts_request: `2026-07-15T00:00:0${id.slice(-1)}.000Z`,
    endpoint: '/v1/messages',
    method: 'POST',
    is_llm_call: true,
    duration_ms: 1000,
    error: false,
    req_headers: { ...HEADERS },
    req_body: reqBodyString([
      { role: 'user', content: [{ type: 'text', text: userText }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_' + id, name: 'Read', input: { file_path: file } }] },
    ]),
    resp: { kind: 'sse', status: 200, stop_reason: 'tool_use', usage },
  };
}

// Batch A: two llm calls in one session sharing byte-identical tools+system blocks.
export function batchA() {
  return [
    llmRec('req-1', 'hello one', '/repo/a.mjs', {
      input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 50,
      output_tokens: 30, output_tokens_details: { thinking_tokens: 12 },
    }),
    llmRec('req-2', 'hello two', '/repo/b.mjs', {
      input_tokens: 8, cache_read_input_tokens: 150, cache_creation_input_tokens: 0, output_tokens: 4,
    }),
  ];
}
// Batch B: a third llm call appended to the same session.
export function batchB() {
  return [
    llmRec('req-3', 'hello three', '/repo/c.mjs', {
      input_tokens: 9, cache_read_input_tokens: 160, cache_creation_input_tokens: 0, output_tokens: 2,
    }),
  ];
}
// A session-less control-plane record (telemetry) — must land session_id NULL, not in sessions.
export function controlRec() {
  return {
    id: 'ctl-1',
    ts_request: '2026-07-15T00:00:09.000Z',
    endpoint: 'https://api.anthropic.com/v1/event_logging',
    method: 'POST',
    is_llm_call: false,
    duration_ms: 40,
    error: false,
    req_headers: { 'user-agent': 'claude-cli/1.0' },
    req_body: JSON.stringify({ events: [] }),
    resp: { kind: 'json', status: 200, body: {} },
  };
}
// An unclaimable record (non-CC UA, no session header, no CC markers) → quarantine.
export function alienRec() {
  return {
    id: 'weird-1',
    ts_request: '2026-07-15T00:00:10.000Z',
    endpoint: '/unknown/thing',
    is_llm_call: true,
    req_headers: { 'user-agent': 'python-requests/2.0' },
    req_body: '{}',
    resp: { kind: 'json', status: 200, body: {} },
  };
}

// Build the AC-1 resolver: raw_ref -> the ORIGINAL verbatim req_body string. Resolving a
// text_ref slices [start,end) out of that original string — NON-CIRCULAR (never re-serialized).
export function sourceMap(records, streamBasename, mintRawRef) {
  const m = new Map();
  for (const r of records) {
    const sid = r.req_headers?.['x-claude-code-session-id'] ?? null;
    m.set(mintRawRef(sid, streamBasename, r.id), r.req_body);
  }
  return m;
}
