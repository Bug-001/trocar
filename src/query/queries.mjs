// src/query/queries.mjs — named read-only queries (RFC 3.5). The ONLY contract between
// frontend and the 3.2 tables: the frontend never assembles raw table/column names, and
// every result speaks provider-neutral CANONICAL vocabulary (invariant 3 — no
// cache_read_input_tokens etc. ever leaves here). Read-only; writes go through ETL (4.2).
import { rebuildContext } from '../etl/orchestrator.mjs';
import { TRAFFIC_CLASS_IDS } from '../dissect/traffic.mjs';

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
            ce.structural_divergence_seq, ce.ground_truth_flag, ce.declared_breakpoints,
            ce.prefix_sha256 -- D17④ byte-SHA ground-truth moat (was omitted; the real reuse-prefix hash, not the structural proxy)
     FROM calls c
     LEFT JOIN usage u ON u.call_id = c.call_id
     LEFT JOIN cache_events ce ON ce.call_id = c.call_id
     WHERE c.session_id = $1
     ORDER BY c.seq`, [sessionId]);
}

// per-call context composition by section (tools/system/messages) — feeds the multi-color
// timeline bars (1.3) + schema-tax (D17②). Canonical: reads block_contents.section/chars only.
export async function sessionComposition(conn, sessionId) {
  return q(conn,
    `SELECT cb.call_id, bc.section, sum(bc.chars) AS chars, count(*) AS n
     FROM call_blocks cb
     JOIN block_contents bc ON bc.content_hash = cb.content_hash
     JOIN calls c ON c.call_id = cb.call_id
     WHERE c.session_id = $1
     GROUP BY cb.call_id, bc.section
     ORDER BY cb.call_id`, [sessionId]);
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

// ── cross-session analysis (3.5 signature ② · 看懂 cache / 上下文工程 across sessions) ─────────
// The whole-corpus SQL DuckDB is uniquely good at — impossible over per-session NDJSON scans.
// All canonical vocabulary (invariant 3): break_kind / cache_read / hit_ratio, never *_input_tokens.

// "which files ever entered context, across all sessions" (resource kind='file').
export async function filesEverInContext(conn) {
  return q(conn,
    `SELECT label, count(DISTINCT session_id) AS sessions, count(*) AS events,
            sum(CASE WHEN event = 'enter' THEN 1 ELSE 0 END) AS opened,
            sum(CASE WHEN event = 'seen' THEN 1 ELSE 0 END) AS seen
     FROM resource_events WHERE kind = 'file'
     GROUP BY label ORDER BY sessions DESC, events DESC, label`);
}
// per (provider,harness) cache-hit distribution — the KV-cache efficiency profile across sessions.
export async function cacheHitDistribution(conn) {
  return q(conn,
    `SELECT COALESCE(s.provider, '?') AS provider, COALESCE(s.harness, '?') AS harness,
            count(*) AS calls, avg(ce.hit_ratio) AS avg_hit_ratio,
            sum(CASE WHEN ce.hit_ratio >= 0.7 THEN 1 ELSE 0 END) AS hi,
            sum(CASE WHEN ce.hit_ratio >= 0.3 AND ce.hit_ratio < 0.7 THEN 1 ELSE 0 END) AS mid,
            sum(CASE WHEN ce.hit_ratio < 0.3 THEN 1 ELSE 0 END) AS lo
     FROM cache_events ce JOIN calls c ON c.call_id = ce.call_id
     LEFT JOIN sessions s ON s.session_id = c.session_id
     GROUP BY ALL ORDER BY calls DESC`);
}
// three-provider break_kind comparison (3.5 验收: "三家 break_kind 对比") — how each provider's
// cache breaks distribute; the signature "can express all three cache designs" evidence.
export async function breakKindComparison(conn) {
  return q(conn,
    `SELECT COALESCE(s.provider, '?') AS provider, ce.break_kind, count(*) AS n
     FROM cache_events ce JOIN calls c ON c.call_id = ce.call_id
     LEFT JOIN sessions s ON s.session_id = c.session_id
     GROUP BY ALL ORDER BY provider, n DESC`);
}
// 未映射告警面 (D7 self-evolution / 保真兜底): provider keys still unmapped, most-common first.
export async function unmappedFields(conn) {
  return q(conn, `SELECT provider, harness, path, n FROM unmapped_fields ORDER BY n DESC LIMIT 200`);
}

// recursive fork/parent lineage → nested tree rooted at a session (3.5 fork 树 / 3.4 血缘).
export async function forkTree(conn, rootId) {
  const rows = await q(conn,
    `SELECT session_id, parent_session_id, fork_of_session_id, title, forked_at_seq, native_id_confidence,
            CAST(started_at AS VARCHAR) AS started_at
     FROM sessions`);
  const byParent = new Map();
  for (const r of rows) {
    const p = r.parent_session_id || r.fork_of_session_id || null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(r);
  }
  const seen = new Set();
  const build = (id) => {
    if (seen.has(id)) return null; // cycle guard
    seen.add(id);
    const node = rows.find((r) => r.session_id === id) || { session_id: id };
    return { ...node, children: (byParent.get(id) || []).map((c) => build(c.session_id)).filter(Boolean) };
  };
  return build(rootId);
}

// resource explorer (2.4): fold flat events into per-resource lifecycle — resident segments
// (enter → evict, or open-ended when still resident) + a loads/seen list — so the frontend renders
// the folded result instead of re-folding (3.5 query set row '资源管理器').
export async function resourceLifecycle(conn, sessionId) {
  const rows = await sessionResources(conn, sessionId); // [{resource_id,kind,label,events:[{seq,event,via,range}]}]
  return rows.map((r) => {
    const segments = [], loads = []; let open = null;
    for (const e of r.events) {
      if (e.event === 'enter' || e.event === 'open') { if (!open) open = { enter: e.seq, via: e.via }; }
      else if (e.event === 'evict' || e.event === 'close') { if (open) { open.evict = e.seq; segments.push(open); open = null; } }
      else loads.push({ seq: e.seq, event: e.event, via: e.via }); // seen / load / read …
    }
    if (open) segments.push(open); // still resident at session end (no evict observed)
    return { resource_id: r.resource_id, kind: r.kind, label: r.label, segments, loads };
  });
}

// ── 保存什么 (D40 · 3.5 查询集「保存什么」行 · 2.6 §D · 4.4 /api/retention) ───────────────────────────────────────────
// What each (harness, traffic class, body_retention) holds, over the last 24 h, the last 7 d and everything: the number of
// calls, the body bytes that went over the wire (request; response — with the calls whose response size was never recorded
// counted apart, never added as 0), and the bytes stored (`record_bytes`, one NDJSON line each: the size before sealing;
// calls whose stored size is unknown are counted apart too). `as_of` is the newest `ts` the projection holds — the numbers are
// as of the last `asight etl`, never live. Every number comes from `calls` and nothing else: no source file is read.
export const SIZE_WINDOWS = Object.freeze([['24h', 24 * 3600e3], ['7d', 7 * 24 * 3600e3], ['all', null]]);
const RETENTION_ORDER = ['full', 'log', 'legacy-meta'];
export const SIZE_COLUMNS = ['calls', 'request_bytes', 'response_bytes', 'response_unrecorded', 'stored_bytes', 'stored_unrecorded'];
export async function retentionSizes(conn, { now = Date.now() } = {}) {
  const have = new Set((await q(conn, "SELECT column_name FROM information_schema.columns WHERE table_name = 'calls'")).map((r) => r.column_name));
  const missing = ['harness', 'traffic_class', 'body_retention', 'response_bytes', 'record_bytes'].filter((c) => !have.has(c));
  if (missing.length) {
    const e = new Error(`the analytics store predates D40 (no ${missing.join(', ')} on calls): run asight etl <source> --rebuild`);
    e.code = 'predates-d40';
    throw e;
  }
  const params = SIZE_WINDOWS.filter(([, ms]) => ms != null).map(([, ms]) => new Date(now - ms).toISOString());
  const sel = [];
  let pi = 0;
  for (const [name, ms] of SIZE_WINDOWS) {
    const w = ms == null ? 'TRUE' : `ts >= CAST($${++pi} AS TIMESTAMP)`;
    sel.push(`count(*) FILTER (WHERE ${w}) AS "${name}_calls"`,
      `COALESCE(sum(request_bytes) FILTER (WHERE ${w}), 0) AS "${name}_request_bytes"`,
      `COALESCE(sum(response_bytes) FILTER (WHERE ${w}), 0) AS "${name}_response_bytes"`,
      `count(*) FILTER (WHERE ${w} AND response_bytes IS NULL) AS "${name}_response_unrecorded"`,
      `COALESCE(sum(record_bytes) FILTER (WHERE ${w}), 0) AS "${name}_stored_bytes"`,
      `count(*) FILTER (WHERE ${w} AND record_bytes IS NULL) AS "${name}_stored_unrecorded"`);
  }
  const got = await q(conn,
    `SELECT COALESCE(harness, 'unknown') AS harness, COALESCE(traffic_class, 'other') AS class, COALESCE(body_retention, 'full') AS retention, ${sel.join(', ')}
     FROM calls GROUP BY ALL`, params);
  const rank = (list, v) => (list.indexOf(v) < 0 ? list.length : list.indexOf(v));
  const rows = got.map((r) => ({ harness: r.harness, class: r.class, retention: r.retention,
    windows: Object.fromEntries(SIZE_WINDOWS.map(([name]) => [name, Object.fromEntries(SIZE_COLUMNS.map((c) => [c, r[`${name}_${c}`]]))])) }))
    .sort((a, b) => (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0) || rank(TRAFFIC_CLASS_IDS, a.class) - rank(TRAFFIC_CLASS_IDS, b.class) || rank(RETENTION_ORDER, a.retention) - rank(RETENTION_ORDER, b.retention));
  const [{ as_of }] = await q(conn, 'SELECT CAST(max(ts) AS VARCHAR) AS as_of FROM calls');
  return { as_of: as_of ?? null, windows_end: new Date(now).toISOString(), rows };
}
