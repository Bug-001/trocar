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
import { harnessOf, LEGACY_PROVIDER, wireProviderOfEndpoint } from '../dissect/harnesses.mjs';
import { openSealed } from '../raw/reader.mjs';

const isProbe = (r) => /count_tokens/.test((r && r.endpoint) || '');

function entrypointFromHeaders(h) {
  const app = String(h['x-app'] || '').toLowerCase();
  const ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (app === 'desktop' || /desktop/.test(ua)) return 'desktop';
  if (app === 'cli' || /cli|sdk-cli/.test(ua)) return 'cli';
  return null;
}

// Harness exactly as board.harnessOf derives it (D37 ①, src/dissect/harnesses.mjs): the first record
// WITH proc decides, else the first record with headers; harness_src remembers which. The provider is
// the legacy pricing key, else the first wire dialect seen in the session (wire_provider).
// A meta.json written before D37 has no harness_src: its harness came from a UA, i.e. from headers.
const srcOf = (m) => m.harness_src || (m.harness != null ? 'headers' : null);
const settle = (m) => { m.provider = m.harness == null ? null : (LEGACY_PROVIDER[m.harness] ?? m.wire_provider ?? null); return m; };

export function emptyMeta(sessionId) {
  return { session_id: sessionId, calls: 0, logged: 0, probes: 0, other: 0, has_subagent: false, last_ts: '', entrypoint: null,
    harness: null, harness_inferred: false, harness_src: null, wire_provider: null, provider: null };
}

export function foldRecord(meta, r) {
  if (!r) return meta;
  // Mirror the sharder's classOf split exactly: call | probe | other. A record is exactly one class,
  // so meta.calls + meta.probes + meta.other equals the session's sharded record count.
  // D40: an inference call kept as a log line only (body_retention:'log') is counted apart — the board cannot draw it, and says so
  if (r.is_llm_call && r.body_retention === 'log') meta.logged = (meta.logged || 0) + 1;
  else if (r.is_llm_call) meta.calls++;
  else if (isProbe(r)) meta.probes++;
  else meta.other++;
  const t = String(r.ts_request || '');
  if (t > meta.last_ts) meta.last_ts = t;
  const h = headersOf(r) || {};
  if (String(h['x-claude-code-agent-id'] || '').trim()) meta.has_subagent = true;
  if (meta.entrypoint == null) { const e = entrypointFromHeaders(h); if (e) meta.entrypoint = e; }
  if (meta.wire_provider == null) meta.wire_provider = wireProviderOfEndpoint(r.endpoint);
  if ((r.proc && meta.harness_src !== 'proc') || (meta.harness_src == null && (r.req_headers || r.request_headers))) {
    const hh = harnessOf(r);
    meta.harness = hh.id; meta.harness_inferred = hh.inferred; meta.harness_src = r.proc ? 'proc' : 'headers';
  }
  return settle(meta);
}

// Combine two metas of the SAME session — how incremental shard runs accumulate: counts add, last_ts
// is the max, has_subagent ORs, the first-seen entrypoint wins, and the harness follows the fold's rule
// (a proc-identified run beats a UA-only one, else the first run with headers wins).
export function mergeMeta(a, b) {
  if (!a) return b;
  if (!b) return a;
  const w = srcOf(a) === 'proc' ? a : srcOf(b) === 'proc' ? b : (srcOf(a) ? a : b);
  return settle({
    session_id: a.session_id || b.session_id,
    calls: a.calls + b.calls,
    logged: (a.logged || 0) + (b.logged || 0),
    probes: a.probes + b.probes,
    other: (a.other || 0) + (b.other || 0),
    has_subagent: a.has_subagent || b.has_subagent,
    last_ts: a.last_ts > b.last_ts ? a.last_ts : b.last_ts,
    entrypoint: a.entrypoint || b.entrypoint,
    harness: w.harness ?? null,
    harness_inferred: w.harness_src ? !!w.harness_inferred : w.harness != null,
    harness_src: srcOf(w),
    wire_provider: a.wire_provider || b.wire_provider || null,
    provider: null, // settle() derives it
  });
}

// Fold the records of sealed files (D35) into `meta`, one frame at a time. Returns null, or the first
// file that could not be read in full — { file, reason, unreadableRecords } — so a caller never takes a
// partial fold for the whole session (no silent shrink).
export function foldSealed(meta, files) {
  for (const f of files) {
    let sf;
    try { sf = openSealed(f); } catch (e) { return { file: f, reason: e.message, unreadableRecords: null }; }
    let bad = 0, first = null;
    try {
      for (const { line } of sf.lines({ onError: (i, e) => { bad++; first = first || e.message; } })) {
        const text = line.toString('utf8').trim();
        if (!text) continue;
        try { foldRecord(meta, JSON.parse(text)); } catch { /* malformed line — no contribution, as in the NDJSON fold */ }
      }
    } finally { sf.close(); }
    if (bad) return { file: f, reason: first, unreadableRecords: bad };
  }
  return null;
}
