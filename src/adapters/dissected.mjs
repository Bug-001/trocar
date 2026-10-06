// src/adapters/dissected.mjs — an ETL adapter GENERATED from a D25 dissector object (RFC 3.1 interface):
// one dissector, two readers. The dissector owns the wire (boardFlat with JSON-path locators, normResp,
// consumedBody, messageCount, faithfulnessOf); this file only projects each flat block onto a 3.2 block row
// the way cc.mjs does — content_hash over the VERBATIM span (D19), text_ref = that span — plus the D37 call
// columns. It names no wire: adding a wire format = a dissector object + a registry row + one
// defaultRegistry line (src/etl/orchestrator.mjs).
import { contentHash, scanJson, spanAt } from './content-hash.mjs';
import { collectExtra } from './contract.mjs';
import { ENVELOPE_CONSUMED } from './envelope.mjs';
import { classOf, nativeId, lane as identityLane } from '../identity/session-identity.mjs';
import { hintsOf, sessionKeyOf } from '../dissect/harnesses.mjs';
import { wireFormatOf, contextStateOf } from '../dissect/registry.mjs';
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

export function dissectorAdapter(d, { name = d.id, priority = 50 } = {}) {
  const consumed = new Set(d.consumedBody || []);
  return {
    name, priority, wireFormat: d.id,
    detect: (rec) => !!rec && rec.is_llm_call === true && wireFormatOf(rec) === d.id,
    parseSession(record) {
      const norm = { ...record, req_body: parse(record.req_body) };
      const n = nativeId(norm);
      const h = hintsOf(record); // harness-declared parent (raw) + aliases: resolved by the ETL (3.4, gate G4)
      return { native_id: n.native_id, native_id_confidence: n.native_id_confidence, parent: h.parent ? h.parent.id : null,
        aliases: sessionKeyOf(norm).aliases, fork_of: null, forked_at: null, lane: identityLane(norm), entrypoint: null, title: null, cwd: null, extra: {} };
    },
    parseCall(record) {
      const req = parse(record.req_body);
      const norm = { ...record, req_body: req };
      const resp = d.normResp(record);
      const env = collectExtra(record, ENVELOPE_CONSUMED);
      const body = collectExtra(req, consumed); // canonical ∪ extra == body keys (3.1:44)
      const extra = { ...env.extra };
      for (const [k, v] of Object.entries(body.extra)) extra['req_body.' + k] = v;
      const r = record.resp || {};
      const h = hintsOf(record);
      const failed = !!(d.failed && d.failed(resp, record));
      return {
        class: classOf(norm), control_kind: null, lane: identityLane(norm),
        endpoint: record.endpoint || '', model: req.model || resp.model || null, stream: req.stream === true,
        usage: hasUsage(resp.usage) ? mapUsage(d.id, resp.usage) : null, stop_reason: resp.stop_reason ?? null, duration_ms: record.duration_ms ?? null,
        error: !!record.error || r.kind === 'error' || (r.status || 0) >= 500 || failed,
        unmapped_count: env.unmapped_count + body.unmapped_count, extra,
        wire_format: d.id, context_state: contextStateOf(record),
        compaction_hint: h.compaction === true, compaction_marker: h.compactionMarker === true,
      };
    },
    parseBlocks(record) {
      const src = typeof record.req_body === 'string' ? record.req_body : '';
      let root = null;
      try { root = src ? scanJson(src) : null; } catch { root = null; } // malformed source: every block says it has no span
      return d.boardFlat(parse(src)).map((b, seq) => {
        const span = root && Array.isArray(b.path) ? spanAt(root, b.path) : null;
        // No span → no text_ref (rebuildContext then reports no-ref), and the row says why: never
        // re-serialized bytes passed off as verbatim (invariant 2/4).
        const text = span ? src.slice(span[0], span[1]) : JSON.stringify(b.block ?? b.schema ?? b.text ?? null);
        return {
          section: b.sec, role: b.role ?? null, kind: kindOf(b), content_hash: contentHash(text), text, text_ref: span,
          chars: text.length, preview: text.slice(0, 200), faithfulness: d.faithfulnessOf ? d.faithfulnessOf(b) : 'verbatim',
          cache_control: null, volatile: !!b.volatile, resource_ref: b.resKey || null,
          extra: span ? {} : { unaddressable: 'no verbatim span for this block in req_body' }, seq,
        };
      });
    },
    // compaction compares message counts call to call (3.4)
    messageCount: (record) => (d.messageCount ? d.messageCount(parse(record.req_body)) : 0),
    parseResources: () => [], // the resource ledger is not extracted for this wire yet (not misreported as empty-by-fact)
  };
}
