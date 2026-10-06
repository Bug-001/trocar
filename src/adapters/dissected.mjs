// src/adapters/dissected.mjs — an ETL adapter GENERATED from a D25 dissector object (RFC 3.1 interface):
// one dissector, two readers. The dissector owns the wire (boardFlat with JSON-path locators, normResp,
// consumedBody, messageCount, faithfulnessOf); this file only projects each flat block onto a 3.2 block row
// the way cc.mjs does — content_hash over the VERBATIM span (D19), text_ref = that span — plus the D37 call
// columns. It names no wire: adding a wire format = a dissector object + a registry row + one
// defaultRegistry line (src/etl/orchestrator.mjs).
//
// A dissector whose context spans records (createChain: Responses over WebSocket, D37 ②) makes the adapter
// stateful: begin() returns per-run state the orchestrator threads through every call, so a call's blocks are
// its STITCHED context (3.1:37), and a block whose bytes live in another record or field carries `source` so
// its text_ref points THERE (4.2:40 field segment, gate G1) — never at re-serialized bytes.
import { contentHash, scanJson, spanAt } from './content-hash.mjs';
import { collectExtra } from './contract.mjs';
import { ENVELOPE_CONSUMED } from './envelope.mjs';
import { classOf, nativeId } from '../identity/session-identity.mjs';
import { hintsOf, sessionKeyOf } from '../dissect/harnesses.mjs';
import { wireFormatOf, contextStateOf, flatLaneOf } from '../dissect/registry.mjs';
import { fieldTextOf } from '../dissect/record-fields.mjs';
import { mapUsage } from '../model/schema.mjs';

const parse = (s) => {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string') return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; } // unparseable: no blocks, the call row stays (and says partial when the collector labelled it)
};
// normResp returns usage {} when the wire sent none: then no usage row and no cache_events row, never
// fabricated zeros (invariant 4; 3.1 Edge: an interrupted stream is an error row without usage).
const hasUsage = (u) => !!u && typeof u === 'object' && Object.keys(u).length > 0;
const kindOf = (b) => (b.sec === 'tools' ? 'tool' : b.sec === 'system' ? 'text' : b.kind === 'redacted_thinking' ? 'thinking' : b.kind || 'text');
// the verbatim text of one addressable field of a record (req_body, or a 4.2:40 field segment)
const textOf = (rec, field) => (field === 'req_body' ? (typeof rec.req_body === 'string' ? rec.req_body : null) : (fieldTextOf(rec, field).text ?? null));

export function dissectorAdapter(d, { name = d.id, priority = 50 } = {}) {
  const consumed = new Set(d.consumedBody || []);
  const planOf = (record, state) => (state && state.chain ? state.chain.plan(record) : null);
  return {
    name, priority, wireFormat: d.id,
    ...(d.createChain ? { begin: () => ({ chain: d.createChain() }) } : {}),
    // a record of this wire that the dissector reads as no call (a server push, a non-create message) is not
    // claimed: it is quarantined with its reason, never dropped (3.1:58)
    // D40: a call kept as a log line only has no body to read: the envelope adapter takes it
    detect: (rec) => !!rec && rec.is_llm_call === true && rec.body_retention !== 'log' && wireFormatOf(rec) === d.id && (!d.admits || d.admits(rec)),
    parseSession(record) {
      const norm = { ...record, req_body: parse(record.req_body) };
      const n = nativeId(norm);
      const h = hintsOf(record); // harness-declared parent (raw) + aliases: resolved by the ETL (3.4, gate G4)
      return { native_id: n.native_id, native_id_confidence: n.native_id_confidence, parent: h.parent ? h.parent.id : null,
        aliases: sessionKeyOf(norm).aliases, fork_of: null, forked_at: null, lane: flatLaneOf(d, record), entrypoint: null, title: null, cwd: null, extra: {} };
    },
    parseCall(record, state) {
      const plan = planOf(record, state);
      const req = parse(record.req_body);
      const norm = { ...record, req_body: req };
      const resp = d.normResp(record);
      const env = collectExtra(record, ENVELOPE_CONSUMED);
      const body = collectExtra(req, consumed); // canonical ∪ extra == body keys (3.1:44)
      const extra = { ...env.extra };
      for (const [k, v] of Object.entries(body.extra)) extra['req_body.' + k] = v;
      // a partial context says what is missing, on the row (3.2:52, invariant 4)
      if (plan && plan.unstored) extra.request_not_stored = plan.unstored; // its own request message (4.6 §传输与帧级记录)
      else if (plan && plan.contextState === 'partial' && plan.missing) extra.missing_predecessor = plan.missing;
      const r = record.resp || {};
      const h = hintsOf(record);
      const failed = !!(d.failed && d.failed(resp, record));
      return {
        // the board's rule exactly (registry.flatLaneOf): Claude Code's lane heuristics are not this wire's
        class: classOf(norm), control_kind: null, lane: flatLaneOf(d, record),
        endpoint: record.endpoint || '', model: req.model || resp.model || null, stream: req.stream === true,
        usage: hasUsage(resp.usage) ? mapUsage(d.id, resp.usage) : null, stop_reason: resp.stop_reason ?? null, duration_ms: record.duration_ms ?? null,
        error: !!record.error || r.kind === 'error' || (r.status || 0) >= 500 || failed,
        unmapped_count: env.unmapped_count + body.unmapped_count, extra,
        wire_format: d.id, context_state: plan ? plan.contextState : contextStateOf(record),
        compaction_hint: h.compaction === true, compaction_marker: h.compactionMarker === true,
      };
    },
    parseBlocks(record, state) {
      const plan = planOf(record, state);
      const roots = new Map(); // `${record id}|${field}` → { text, root }: each field scanned once per call
      const rootOf = (rec, field) => {
        const k = String(rec.id) + '|' + field;
        if (!roots.has(k)) {
          const text = textOf(rec, field);
          let root = null;
          try { root = text != null ? scanJson(text) : null; } catch { root = null; } // malformed: its blocks say they have no span
          roots.set(k, { text, root });
        }
        return roots.get(k);
      };
      const req = plan ? d.stitchedRequest(record, plan) : parse(record.req_body);
      return d.boardFlat(req).map((b, seq) => {
        const loc = plan ? d.locate(b, record, plan) : (Array.isArray(b.path) ? { rec: record, field: 'req_body', path: b.path } : null);
        const src = loc ? rootOf(loc.rec, loc.field) : null;
        const span = src && src.root ? spanAt(src.root, loc.path) : null;
        // No span → no text_ref (rebuildContext then reports no-ref), and the row says why: never
        // re-serialized bytes passed off as verbatim (invariant 2/4).
        const text = span ? src.text.slice(span[0], span[1]) : JSON.stringify(b.block ?? b.schema ?? b.text ?? null);
        const elsewhere = !!span && (loc.rec !== record || loc.field !== 'req_body');
        return {
          section: b.sec, role: b.role ?? null, kind: kindOf(b), content_hash: contentHash(text), text, text_ref: span,
          ...(elsewhere ? { source: { recordId: String(loc.rec.id), stream: loc.rec._stream ?? null, sessionId: sessionKeyOf(loc.rec).key, field: loc.field } } : {}),
          chars: text.length, preview: text.slice(0, 200), faithfulness: d.faithfulnessOf ? d.faithfulnessOf(b) : 'verbatim',
          cache_control: null, volatile: !!b.volatile, resource_ref: b.resKey || null,
          extra: span ? {} : { unaddressable: loc ? `no verbatim span in ${loc.field} of record ${loc.rec.id}` : 'no locator for this block' }, seq,
        };
      });
    },
    // compaction compares message counts call to call (3.4). On a chained wire a record carries only the delta
    // (input:[] right after a warmup), so the count is the STITCHED context's length.
    messageCount(record, state) {
      const plan = planOf(record, state);
      if (plan && plan.unstored) return null; // unknown: no compaction verdict, and the lane keeps its predecessor
      if (plan) return plan.segments.length;
      return d.messageCount ? d.messageCount(parse(record.req_body)) : 0;
    },
    parseResources: () => [], // the resource ledger is not extracted for this wire yet (not misreported as empty-by-fact)
  };
}
