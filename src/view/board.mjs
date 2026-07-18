// src/view/board.mjs — server-side board data assembly (D18a Option-2). Groups a FLAT raw
// NDJSON (the source of truth, invariant 2) into the shapes the reused demo dashboard polls:
//   /api/projects  → { projects:[{slug,name,path,last_ts,sessions:[meta…]}] }
//   /api/session   → { records(slim), analyzed, probes, meta, truncated }
//   /api/control   → { classes:[…] } | { class, records }
// All provider parsing happens in assembleSession (analyze) HERE, server-side — the browser
// receives only canonical `analyzed` (invariant 3 / AC-3). Pure over its `records` input;
// human-title / cwd enrichment is injected via `enrich(id)` so this module stays testable.
import { assembleSession, sessionIdOf, headersOf } from './assemble.mjs';

// tolerate both envelope shapes: demo v0 `request_headers` + product D10 `req_headers` (Codex).
const anyHeaders = (recs) => headersOf(recs.find((r) => r.request_headers || r.req_headers));

const base = (p) => String(p).replace(/\/+$/, '').split('/').pop() || String(p);
const isProbe = (r) => /count_tokens/.test(r.endpoint || '');

// ── grouping ────────────────────────────────────────────────────────────────
// Records carrying x-claude-code-session-id belong to a session; the rest are the
// session-less control plane (telemetry / config / account).
export function groupSessions(records) {
  const g = new Map();
  for (const r of records) {
    const id = sessionIdOf(r);
    if (!id) continue;
    if (!g.has(id)) g.set(id, []);
    g.get(id).push(r);
  }
  return g;
}
export const controlRecords = (records) => records.filter((r) => !sessionIdOf(r));

// ── per-session derived meta (cheap; no analyze) ──────────────────────────────
const llmRecs = (recs) => recs.filter((r) => r.is_llm_call);
const probeRecs = (recs) => recs.filter(isProbe);
const probeSeries = (precs) =>
  precs.map((r) => ({ ts: r.ts_request, tokens: (r.response && r.response.body && r.response.body.input_tokens) ?? null }))
    .filter((p) => p.tokens != null);
function entrypointOf(recs) {
  const h = anyHeaders(recs);
  const app = String(h['x-app'] || '').toLowerCase(), ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (app === 'desktop' || /desktop/.test(ua)) return 'desktop';
  if (app === 'cli' || /cli|sdk-cli/.test(ua)) return 'cli';
  return null;
}
// harness + provider identity from the request UA — drives the board's agent chip via a TABLE
// (not a hardcode), so onboarding Codex/DeepSeek is a new row here + a new server-side analyzer,
// with the frontend chip table untouched (invariant 3 / AC-3).
function harnessOf(recs) {
  const h = anyHeaders(recs);
  const ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (/claude-cli|claude-code/.test(ua)) return { harness: 'claude-code', provider: 'anthropic' };
  if (/codex/.test(ua)) return { harness: 'codex', provider: 'openai' };
  if (/deepseek/.test(ua)) return { harness: 'deepseek-cli', provider: 'deepseek' };
  return { harness: null, provider: null };
}
// a subagent turn carries its own x-claude-code-agent-id (differs from the main lane's absence)
const hasSubagent = (recs) => recs.some((r) => String(headersOf(r)['x-claude-code-agent-id'] || '').trim());
function lastTs(recs) { let m = ''; for (const r of recs) { const t = String(r.ts_request || ''); if (t > m) m = t; } return m; }

function sessionMetaFor(id, recs, enrich) {
  const info = enrich ? enrich(id) : null; // { slug, cwd, title } | null
  return {
    session_id: id,
    project_slug: info && info.slug ? info.slug : '_unresolved',
    project_path: (info && info.cwd) || null,
    entrypoint: entrypointOf(recs),
    ...harnessOf(recs), // { harness, provider }
    title: (info && info.title) || null,
    calls: llmRecs(recs).length,
    probes: probeRecs(recs).length,
    has_subagent: hasSubagent(recs),
    last_ts: lastTs(recs),
  };
}

// ── /api/projects ─────────────────────────────────────────────────────────────
export function projectsView(records, { enrich } = {}) {
  const g = groupSessions(records);
  const byProj = new Map();
  for (const [id, recs] of g) {
    const m = sessionMetaFor(id, recs, enrich);
    m.project_slug = m.project_slug; // keep as computed
    if (!byProj.has(m.project_slug)) byProj.set(m.project_slug, []);
    byProj.get(m.project_slug).push(m);
  }
  const projects = [...byProj.entries()].map(([slug, sessions]) => {
    sessions.sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
    const anyPath = sessions.find((s) => s.project_path)?.project_path;
    const name = slug === '_unresolved' ? 'unresolved' : anyPath ? base(anyPath) : slug;
    return { slug, path: anyPath || slug, name, last_ts: sessions[0].last_ts, sessions };
  });
  // real projects first (newest), the _unresolved bucket last
  projects.sort((a, b) =>
    a.slug === '_unresolved' ? 1 : b.slug === '_unresolved' ? -1 : String(b.last_ts).localeCompare(String(a.last_ts)));
  return { projects };
}

// ── /api/session ──────────────────────────────────────────────────────────────
// analyze() sees LLM calls only (count_tokens probes are passed separately, as the demo did);
// `records` is SLIMMED to what the browser still needs locally (errStats status + change-sig) —
// the heavy request bodies ride inside `analyzed.…calls[].rec`, never duplicated.
//
// PAGING (4.4:88② · 3.5 游标契约 · D25 轻路):`page = {cursor, limit}` returns only the view page.
// Cursor unit = the GLOBAL call index `gi` (analyze's step order = timeline order). Every call still
// carries its CHEAP meta (ctx/usage/cacheBreak/gi — the overview strip + brush need the whole strip);
// the HEAVY payload (rec request body / flat verbatim blocks / norm.text) rides ONLY on calls whose gi
// is in [cursor, cursor+limit). Out-of-window calls are marked `paged_out` (invariant 4 — the body was
// not shipped on THIS page, not silently dropped). No `page` → full send (back-compat; render gate/demo
// board unchanged). Windowing is a SHALLOW non-mutating transform over an already-assembled view, so a
// memoized full view (D21) can back many page requests without re-running analyze.
// Tail-bound a session's records to a raw-bytes budget (4.4:90 "服务端只回当前视图所需的页 · 不再整条下发").
// An UNBOUNDED session view is the whole-page-breaks bug: assembling + JSON.stringify-ing a large
// session overruns V8's max string length (500 "Invalid string length") and can OOM the process, so
// the board falls through to its empty state and LIES that there are no calls. Keep the MOST RECENT
// calls that fit; the omitted ones stay intact in the raw NDJSON and the view is MARKED non-complete
// (invariant 4) via `truncated`, which the board renders as the 非完整视图 banner.
export function tailBound(recs, maxBytes) {
  const bytesOf = (r) => (typeof r.req_body === 'string' ? r.req_body.length
    : (r.request ? JSON.stringify(r.request).length : 0));
  const calls = (rs) => rs.reduce((n, r) => n + (r.is_llm_call ? 1 : 0), 0);
  let total = 0;
  for (const r of recs) total += bytesOf(r);
  if (!maxBytes || total <= maxBytes) return { recs, bound: null };
  let kept = 0, i = recs.length;
  while (i > 0 && kept + bytesOf(recs[i - 1]) <= maxBytes) kept += bytesOf(recs[--i]);
  if (i === recs.length && recs.length) { i = recs.length - 1; kept = bytesOf(recs[i]); } // always keep ≥1
  const out = recs.slice(i);
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;
  return { recs: out, bound: { shown: calls(out), total: calls(recs), kept_mb: mb(kept), file_mb: mb(total) } };
}

export function sessionView(records, sessionId, { enrich, bound, page, maxBytes } = {}) {
  const g = groupSessions(records);
  let recs = g.get(sessionId);
  if (!recs) return null;
  let autoBound = null;
  ({ recs, bound: autoBound } = tailBound(recs, maxBytes));
  const probes = probeRecs(recs);
  const analyzed = assembleSession(llmRecs(recs));
  const slim = recs.map((r) => ({
    is_llm_call: !!r.is_llm_call, ts_request: r.ts_request, id: r.id,
    response: { status: (r.response && r.response.status) || null },
  }));
  const view = {
    records: slim,
    analyzed,
    probes: { count: probes.length, series: probeSeries(probes) },
    meta: sessionMetaFor(sessionId, recs, enrich),
    truncated: bound || autoBound || null, // 保真边界 (invariant 4): set when a large session was tail-bounded
  };
  return page ? pageView(view, page) : view;
}

// Slim a call to CHEAP meta only — drop the heavy request body + reconstructed blocks + response text,
// keep everything the timeline/overview reads (ctx/usage/gi/cacheBreak/error/compaction) plus the model
// (so cost + labels still resolve). Non-mutating: returns a NEW object, leaves the source call intact.
function slimCall(c) {
  const { rec, flat, norm, _comp, ...rest } = c;
  return {
    ...rest,
    paged_out: true, // invariant 4: this call's body was not shipped on this page
    flat: [],
    norm: norm ? { usage: norm.usage } : norm,
    rec: rec ? { id: rec.id, request: { model: rec.request && rec.request.model } } : rec,
  };
}

// Apply the cursor/limit window over an assembled view WITHOUT mutating it (clones only the lane/call
// spine; shares in-window call objects, slims out-of-window ones). Returns the view + `page` metadata.
export function pageView(view, { cursor = 0, limit = Infinity } = {}) {
  const lo = Math.max(0, cursor | 0);
  const hi = limit === Infinity ? Infinity : lo + Math.max(0, limit | 0);
  const lanes = (view.analyzed && view.analyzed.lanes) || [];
  let total = 0, returned = 0;
  const pagedLanes = lanes.map((lane) => {
    const calls = (lane.calls || []).map((c) => {
      total++;
      const inWin = c.gi >= lo && c.gi < hi;
      if (inWin) { returned++; return c; }
      return slimCall(c);
    });
    return { ...lane, calls };
  });
  const analyzed = { ...view.analyzed, lanes: pagedLanes };
  const nextCursor = hi !== Infinity && hi < total ? hi : null;
  const page = { cursor: lo, limit: limit === Infinity ? null : (limit | 0), total, returned, nextCursor, hasMore: nextCursor != null };
  return { ...view, analyzed, page };
}

// ── /api/control ──────────────────────────────────────────────────────────────
function controlClass(r) {
  const e = String(r.endpoint || '');
  if (/count_tokens/.test(e)) return 'telemetry';
  if (/oauth|token|account|organization|profile/.test(e)) return 'account';
  if (/mcp|registry|marketplace|extension/.test(e)) return 'registry';
  if (/statsig|telemetry|event|metric|flag/.test(e)) return 'telemetry';
  return 'control';
}
export function controlView(records, cls) {
  const ctrl = controlRecords(records);
  if (cls) return { class: cls, records: ctrl.filter((r) => controlClass(r) === cls) };
  const counts = new Map();
  for (const r of ctrl) { const c = controlClass(r); counts.set(c, (counts.get(c) || 0) + 1); }
  return { classes: [...counts.entries()].map(([c, n]) => ({ class: c, count: n })) };
}
