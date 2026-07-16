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

// ── /api/compare (D17③ 跨-run 逐步结构 diff) ──────────────────────────────────────
// 两条 run/session 的**确定性离线** content_hash 序列比对(**非**重调模型;复用同一 cache-break 前缀
// 原语,对象=两 session,承 3.3:100 + 3.5 + 1.4)。全服务端(不变式 3:浏览器零 provider 解析)→
// 加 provider 只加服务端 analyzer,compare 页零改(AC-3)。
const resBase = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p;
const resIdentity = (r) => r.kind + '::' + ((r.kind === 'file' || r.kind === 'dir') ? resBase(r.label) : r.label);
function runModel(recs, sessionId, enrich) {
  const A = assembleSession(llmRecs(recs));
  const main = (A.lanes || []).find((l) => l.kind === 'main') || (A.lanes || [])[0] || { calls: [] };
  // per main-lane call: the content_hash sequence (skip per-call nonce blocks — their bytes churn but
  // stay cache-excluded, so they're not part of the structural identity). This IS the cache-break primitive.
  const steps = (main.calls || []).map((c) => ({
    ctx: c.ctx || 0, compaction: !!c.compaction,
    keys: (c.flat || []).filter((b) => !b.volatile).map((b) => b.key),
  }));
  const resMap = new Map();
  for (const l of A.lanes || []) for (const r of l.resources || []) { const k = resIdentity(r); if (!resMap.has(k)) resMap.set(k, { kind: r.kind, label: r.label }); }
  return { meta: sessionMetaFor(sessionId, recs, enrich), stats: A.stats, steps, resources: [...resMap.values()] };
}
// index-aligned stepwise structural diff: walk both runs in lockstep; a step is identical iff its block-key
// SET matches; sharedPrefix = how many leading steps stayed byte-structurally identical (the cross-run
// analogue of the cache-break shared prefix); firstDiverge = where the two runs first differ.
function alignRuns(a, b) {
  const n = Math.min(a.steps.length, b.steps.length), per = [];
  let firstDiverge = -1;
  for (let i = 0; i < n; i++) {
    const ka = a.steps[i].keys, kb = b.steps[i].keys, sa = new Set(ka), sb = new Set(kb);
    const added = kb.filter((k) => !sa.has(k)).length, removed = ka.filter((k) => !sb.has(k)).length;
    const identical = added === 0 && removed === 0 && ka.length === kb.length;
    if (!identical && firstDiverge < 0) firstDiverge = i;
    per.push({ i, identical, added, removed, aBlocks: ka.length, bBlocks: kb.length });
  }
  return { compared: n, firstDiverge, sharedPrefix: firstDiverge < 0 ? n : firstDiverge, aExtra: Math.max(0, a.steps.length - n), bExtra: Math.max(0, b.steps.length - n), per };
}
export function compareView(records, idA, idB, { enrich } = {}) {
  const g = groupSessions(records);
  const ra = g.get(idA), rb = g.get(idB);
  if (!ra || !rb) return null; // 404: at least one session id not in this source
  const a = runModel(ra, idA, enrich), b = runModel(rb, idB, enrich);
  const idxA = new Map(a.resources.map((r) => [resIdentity(r), r])), idxB = new Map(b.resources.map((r) => [resIdentity(r), r]));
  const keys = new Set([...idxA.keys(), ...idxB.keys()]);
  const both = [], aonly = [], bonly = [];
  for (const k of [...keys].sort()) { const inA = idxA.get(k), inB = idxB.get(k); (inA && inB ? both : inA ? aonly : bonly).push(inA || inB); }
  const align = alignRuns(a, b);
  // strip the heavy per-step content_hash arrays off the wire — the page needs ctx/compaction curves,
  // the align summary, and the resource set-diff (not the raw hashes).
  const strip = (run) => ({ meta: run.meta, stats: run.stats, steps: run.steps.map((s) => ({ ctx: s.ctx, compaction: s.compaction })), resources: run.resources });
  return { a: strip(a), b: strip(b), align, resources: { both, aonly, bonly } };
}
