// src/view/board.mjs — server-side board data assembly (D18a Option-2). Groups a FLAT raw
// NDJSON (the source of truth, invariant 2) into the shapes the reused demo dashboard polls:
//   /api/projects  → { projects:[{slug,name,path,last_ts,sessions:[meta…]}] }
//   /api/session   → { records(slim), analyzed, probes, meta, truncated }
//   /api/control   → { classes:[…] } | { class, records }
// All provider parsing happens in assembleSession (analyze) HERE, server-side — the browser
// receives only canonical `analyzed` (invariant 3 / AC-3). Pure over its `records` input;
// human-title / cwd enrichment is injected via `enrich(id)` so this module stays testable.
import { assembleSession, sessionIdOf } from './assemble.mjs';

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
  const h = (recs.find((r) => r.request_headers) || {}).request_headers || {};
  const app = String(h['x-app'] || '').toLowerCase(), ua = String(h['user-agent'] || '').toLowerCase();
  if (app === 'desktop' || /desktop/.test(ua)) return 'desktop';
  if (app === 'cli' || /cli|sdk-cli/.test(ua)) return 'cli';
  return null;
}
// harness + provider identity from the request UA — drives the board's agent chip via a TABLE
// (not a hardcode), so onboarding Codex/DeepSeek is a new row here + a new server-side analyzer,
// with the frontend chip table untouched (invariant 3 / AC-3).
function harnessOf(recs) {
  const h = (recs.find((r) => r.request_headers) || {}).request_headers || {};
  const ua = String(h['user-agent'] || '').toLowerCase();
  if (/claude-cli|claude-code/.test(ua)) return { harness: 'claude-code', provider: 'anthropic' };
  if (/codex/.test(ua)) return { harness: 'codex', provider: 'openai' };
  if (/deepseek/.test(ua)) return { harness: 'deepseek-cli', provider: 'deepseek' };
  return { harness: null, provider: null };
}
// a subagent turn carries its own x-claude-code-agent-id (differs from the main lane's absence)
const hasSubagent = (recs) => recs.some((r) => String((r.request_headers || {})['x-claude-code-agent-id'] || '').trim());
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
export function sessionView(records, sessionId, { enrich, bound } = {}) {
  const g = groupSessions(records);
  const recs = g.get(sessionId);
  if (!recs) return null;
  const probes = probeRecs(recs);
  const analyzed = assembleSession(llmRecs(recs));
  const slim = recs.map((r) => ({
    is_llm_call: !!r.is_llm_call, ts_request: r.ts_request, id: r.id,
    response: { status: (r.response && r.response.status) || null },
  }));
  return {
    records: slim,
    analyzed,
    probes: { count: probes.length, series: probeSeries(probes) },
    meta: sessionMetaFor(sessionId, recs, enrich),
    truncated: bound || null, // 保真边界 hook (invariant 4): set when a large session was tail-bounded
  };
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
