// src/query/rows.mjs — the segment index as ONE list of rows, and which session each row belongs to.
//
// `sessions` and `session` must agree on membership, so it is computed here once (3.4: membership is a
// read-side decision) and both ask this module: `sessions` counts the rows, `session` reads back only the
// records of the one session it was asked for. Nothing here parses a record: a row is what the segment
// index already stored (src/query/index-build.mjs), which is why `sessions` can meet its ≤ 1 s budget on
// 1 GB (1.6 §4.1 速度目标) where reading every record back cost 4.5 s on Windows and 7 s on macOS.
import nodeFs from 'node:fs';
import { createSynthAssigner } from '../dissect/synth-key.mjs';
import { LEGACY_PROVIDER, wireProviderOfEndpoint } from '../dissect/harnesses.mjs';
import { allSegments, segmentIndex } from './index-build.mjs';
import { asightHome } from '../paths.mjs';

/**
 * indexRows({home, fs, errors}) → [{…index row, segment, lineNo, session_id}], oldest segment first,
 * capture order inside a segment — the order the synthesized keys (3.4 合成键) are assigned in, the same
 * order the board stamps them in, so both name a session the same.
 * What a segment could not say goes into `errors` (D38), never silently missing.
 */
export async function indexRows({ home = asightHome(), fs = nodeFs, errors = [] } = {}) {
  const assign = createSynthAssigner();
  const out = [];
  for (const s of await allSegments({ home, fs })) {
    for (const pr of s.problems) errors.push({ where: `segments/${s.segment}`, reason: `${pr.code}: ${pr.reason}` });
    const { records } = await segmentIndex({ home, segment: s.segment, fs });
    for (const r of records) {
      const synth = r.synth_hash ? assign({ harness: r.harness_id, hash: r.synth_hash, ms: Date.parse(r.ts || '') }) : null;
      out.push({ ...r, segment: s.segment, lineNo: Number(String(r.id).split(':').pop()), session_id: r.session_key ?? synth ?? null, synthesized: !!synth });
    }
  }
  return out;
}

/** The rows of every session, in the order the sessions were first seen. A row with no session id is the
 *  session-less control plane (telemetry / config / account) and is in no group. */
export function sessionGroups(rows) {
  const g = new Map();
  for (const r of rows) {
    if (!r.session_id) continue;
    if (!g.has(r.session_id)) g.set(r.session_id, []);
    g.get(r.session_id).push(r);
  }
  return g;
}

const isProbe = (r) => /count_tokens/.test(r.path || '');

/** One session's facts, the way src/view/board.mjs derives them from the records themselves (sessionMetaFor):
 *  the harness of the first row that had `proc`, else of the first that had headers; the entrypoint of the
 *  first row that had headers; calls / logged / probes / other complementary, so they sum to the session. */
export function sessionFactsOf(id, rows) {
  const first = rows.find((r) => r.has_proc) || rows.find((r) => r.has_headers);
  const harness = first ? first.harness_id : null;
  const withHeaders = rows.find((r) => r.has_headers);
  return {
    session_id: id,
    entrypoint: withHeaders ? withHeaders.entrypoint : null,
    harness,
    harness_inferred: !!(first && first.harness_inferred),
    // a harness that can be pointed at ANY backend has no provider unless the wire showed one (gate G10)
    provider: harness == null ? null : LEGACY_PROVIDER[harness] ?? rows.map((r) => wireProviderOfEndpoint(r.path)).find(Boolean) ?? null,
    calls: rows.filter((r) => r.is_llm && !r.log_only).length,
    logged: rows.filter((r) => r.is_llm && r.log_only).length,
    probes: rows.filter(isProbe).length,
    other: rows.filter((r) => !r.is_llm && !isProbe(r)).length,
    has_subagent: rows.some((r) => r.subagent),
    last_ts: rows.reduce((m, r) => (String(r.ts || '') > m ? String(r.ts || '') : m), ''),
    session_synthesized: rows.some((r) => r.synthesized),
  };
}
