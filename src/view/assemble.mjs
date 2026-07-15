// src/view/assemble.mjs — server-side view assembler (D18a Option-2). Runs the demo's
// analyze pipeline SERVER-SIDE over ONE session's raw records and BAKES per-call flat +
// cacheBreak + groundTruth, so the reused demo render code reads PRE-COMPUTED fields instead
// of calling analyze functions in the browser. Result: the demo's exact look, with ZERO
// provider parsing in the browser → invariant 3 / AC-3 intact (adding a provider = a new
// server-side analyzer, frontend unchanged).
import { analyze, linearContext, cacheBreak, groundTruth, normResp } from './analyze.mjs';

const SIDH = ['x-claude-code-session-id', 'x-session-id'];
export function sessionIdOf(rec) {
  const h = rec.request_headers || {};
  for (const k of SIDH) if (h[k]) return h[k];
  return null;
}
export function recordsForSession(records, sessionId) {
  return records.filter((r) => sessionIdOf(r) === sessionId);
}

// records = ONE session's raw (v0/demo-shape) records. Returns analyze() output with each
// call augmented: .flat (linearContext), .cacheBreak (vs prev in lane), .gt (groundTruth).
export function assembleSession(records) {
  const A = analyze(records);
  for (const lane of A.lanes || []) {
    let prevFlat = null;
    for (const call of lane.calls || []) {
      if (!call.rec || !call.rec.request) { call.flat = []; call.cacheBreak = null; call.gt = null; continue; }
      const flat = linearContext(call.rec.request);
      call.flat = flat;
      call.norm = call.norm || normResp(call.rec);
      if (prevFlat) {
        const brk = cacheBreak(prevFlat, flat, { compaction: !!call.compaction });
        const u = call.norm.usage || {};
        call.cacheBreak = brk;
        call.gt = groundTruth(brk, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0);
      } else { call.cacheBreak = null; call.gt = null; }
      prevFlat = flat;
    }
  }
  return A;
}
