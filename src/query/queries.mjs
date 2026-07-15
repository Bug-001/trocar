// src/query/queries.mjs — named read-only queries (RFC 3.5). The ONLY contract between
// frontend and the 3.2 tables: the frontend never assembles raw table/column names, and
// every result speaks provider-neutral CANONICAL vocabulary (invariant 3 — no
// cache_read_input_tokens etc. ever leaves here). Read-only; writes go through ETL (4.2).
import { rebuildContext } from '../etl/orchestrator.mjs';

const N = (v) => (typeof v === 'bigint' ? Number(v) : v);
function normRows(list) {
  return list.map((r) => { const o = {}; for (const k in r) o[k] = N(r[k]); return o; });
}
async function q(conn, sql, params = []) {
  const res = params.length ? await conn.runAndReadAll(sql, params) : await conn.runAndReadAll(sql);
  return normRows(res.getRowObjects());
}

// session selector / fork tree (3.5 row 1)
export async function listSessions(conn) {
  return q(conn,
    `SELECT s.session_id, s.harness, s.provider, s.title, s.cwd, s.entrypoint,
            CAST(s.started_at AS VARCHAR) AS started_at, CAST(s.ended_at AS VARCHAR) AS ended_at,
            s.parent_session_id, s.fork_of_session_id,
            count(c.call_id) AS call_count
     FROM sessions s LEFT JOIN calls c ON c.session_id = s.session_id
     GROUP BY ALL
     ORDER BY started_at DESC NULLS LAST, session_id`);
}

// timeline (1.3) + call cards (2.2) + cache overlay (1.3/3.3): calls with usage + cache_events.
// All canonical columns — cache_read/cache_write (not *_input_tokens), break_kind, hit_ratio.
export async function sessionCalls(conn, sessionId) {
  return q(conn,
    `SELECT c.call_id, c.seq, CAST(c.ts AS VARCHAR) AS ts, c.model, c.class, c.lane,
            c.stop_reason, c.error, c.duration_ms, c.compaction, c.request_bytes,
            u.input_uncached, u.cache_read, u.cache_write, u.output, u.reasoning, u.total_input,
            ce.break_kind, ce.hit_ratio, ce.divergence_cause, ce.divergence_byte_offset,
            ce.structural_divergence_seq, ce.ground_truth_flag, ce.declared_breakpoints
     FROM calls c
     LEFT JOIN usage u ON u.call_id = c.call_id
     LEFT JOIN cache_events ce ON ce.call_id = c.call_id
     WHERE c.session_id = $1
     ORDER BY c.seq`, [sessionId]);
}

// resource explorer (2.4): flat resource_events folded into per-resource lifecycle.
export async function sessionResources(conn, sessionId) {
  const evs = await q(conn,
    `SELECT resource_id, kind, label, event, via, range, seq
     FROM resource_events WHERE session_id = $1 ORDER BY seq`, [sessionId]);
  const byId = new Map();
  for (const e of evs) {
    if (!byId.has(e.resource_id)) byId.set(e.resource_id, { resource_id: e.resource_id, kind: e.kind, label: e.label, events: [] });
    byId.get(e.resource_id).events.push({ seq: e.seq, event: e.event, via: e.via, range: e.range });
  }
  return [...byId.values()];
}

// central replay (1.4/2.3): a call's ordered blocks, VERBATIM text via 回源 resolver (AC-1).
// `resolve(text_ref) -> string|null` slices the byte span out of the source NDJSON.
export async function callContext(conn, callId, resolve) {
  return rebuildContext(conn, callId, resolve);
}
