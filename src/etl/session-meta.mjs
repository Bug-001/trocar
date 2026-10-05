// src/etl/session-meta.mjs — the per-session summary the board's session list needs, computed as a
// STREAMING FOLD so it can be built one record at a time without ever holding a whole session (let
// alone the whole corpus) in memory. This is the archive layer that lets `asight serve` list all 24
// sessions of a 7.4 GB capture instantly: the sharder folds each session's meta while it copies
// bytes, writes a tiny meta.json, and the board reads those instead of re-parsing every record
// (which OOMs).
//
// The fields MUST match what `src/view/board.mjs` `sessionMetaFor` derives from records (calls /
// probes / last_ts / entrypoint / harness / provider / has_subagent). Drift between the two would
// make the list disagree with the opened session; `test/etl/session-meta.test.mjs` cross-checks
// `projectsViewFromMetas(fold(records))` against `projectsView(records)` to catch exactly that.
// project_slug / project_path / title are NOT here — they come from the board's `enrich(id)` lookup
// against ~/.claude/projects, which is a board-side concern, not a capture fact.

import { headersOf } from '../view/assemble.mjs';

const isProbe = (r) => /count_tokens/.test((r && r.endpoint) || '');

function entrypointFromHeaders(h) {
  const app = String(h['x-app'] || '').toLowerCase();
  const ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (app === 'desktop' || /desktop/.test(ua)) return 'desktop';
  if (app === 'cli' || /cli|sdk-cli/.test(ua)) return 'cli';
  return null;
}

function harnessFromHeaders(h) {
  const ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (/claude-cli|claude-code/.test(ua)) return { harness: 'claude-code', provider: 'anthropic' };
  if (/codex/.test(ua)) return { harness: 'codex', provider: 'openai' };
  if (/deepseek/.test(ua)) return { harness: 'deepseek-cli', provider: 'deepseek' };
  // OpenCode's provider is wire-derived (D3), which a single-record fold can't see; the board still
  // resolves it from the opened session. Leave provider null here rather than claim one unobserved.
  if (/opencode/.test(ua)) return { harness: 'opencode', provider: null };
  return { harness: null, provider: null };
}

export function emptyMeta(sessionId) {
  return { session_id: sessionId, calls: 0, probes: 0, other: 0, has_subagent: false, last_ts: '', entrypoint: null, harness: null, provider: null };
}

export function foldRecord(meta, r) {
  if (!r) return meta;
  // Mirror the sharder's classOf split exactly: call | probe | other. A record is exactly one class,
  // so meta.calls + meta.probes + meta.other equals the session's sharded record count.
  if (r.is_llm_call) meta.calls++;
  else if (isProbe(r)) meta.probes++;
  else meta.other++;
  const t = String(r.ts_request || '');
  if (t > meta.last_ts) meta.last_ts = t;
  const h = headersOf(r) || {};
  if (String(h['x-claude-code-agent-id'] || '').trim()) meta.has_subagent = true;
  if (meta.entrypoint == null) { const e = entrypointFromHeaders(h); if (e) meta.entrypoint = e; }
  if (meta.harness == null) { const hh = harnessFromHeaders(h); if (hh.harness) { meta.harness = hh.harness; meta.provider = hh.provider; } }
  return meta;
}

// Combine two metas of the SAME session — how incremental shard runs accumulate: counts add, last_ts
// is the max, has_subagent ORs, and the first-seen entrypoint/harness wins (a session's identity
// does not change mid-stream).
export function mergeMeta(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    session_id: a.session_id || b.session_id,
    calls: a.calls + b.calls,
    probes: a.probes + b.probes,
    other: (a.other || 0) + (b.other || 0),
    has_subagent: a.has_subagent || b.has_subagent,
    last_ts: a.last_ts > b.last_ts ? a.last_ts : b.last_ts,
    entrypoint: a.entrypoint || b.entrypoint,
    harness: a.harness || b.harness,
    provider: a.provider || b.provider,
  };
}
