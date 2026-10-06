// src/dissect/synth-key.mjs — synthesized session keys (RFC 3.4 Plan 合成键; the default rule is gate G11,
// to be checked against a lab capture). For a harness whose table row says
// `synth: true` (Hermes on a custom endpoint; Kimi without a body key), a keyless inference call joins the open
// session of the same harness and the same system-prompt hash when it starts within SYNTH_GAP_MS of that
// session's latest call; otherwise it opens a new one. pid and connection are NOT inputs (3.4 关键区分: one
// Hermes gateway serves many tasks). Callers feed records in file order; the board and the ETL both read the
// capture files in sorted order, so they assign the same keys. Leaf module.
import { createHash } from 'node:crypto';
import { harnessOf, sessionKeyOf, bodyOf } from './harnesses.mjs';

export const SYNTH_GAP_MS = 30 * 60 * 1000;
export const SYNTH_RULE = 'sha256(first system text) + a 30-minute gap (3.4 合成键, gate G11)';

const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : '') : String(p ?? ''))).join('') : '');
// The task anchor: the first system text of whichever wire the call used (Anthropic `system`, Responses
// `instructions`, Chat's leading system / developer message). '' when there is none: still an anchor.
export function systemTextOf(body) {
  const b = body || {};
  if (b.system != null) return textOf(b.system);
  if (typeof b.instructions === 'string') return b.instructions;
  const first = Array.isArray(b.messages) ? b.messages[0] : null;
  if (first && (first.role === 'system' || first.role === 'developer')) return textOf(first.content);
  return '';
}

// 2026-10-06T00:00:00.000Z → 20261006T000000Z: no '/', '#' or ':', so the key is safe inside a raw_ref.
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// The board re-stamps the whole corpus on every request (each poll): hash a record's system text once.
const HASHES = new WeakMap();
const hashOf = (rec) => {
  let h = HASHES.get(rec);
  if (h === undefined) { h = createHash('sha256').update(systemTextOf(bodyOf(rec)), 'utf8').digest('hex'); HASHES.set(rec, h); }
  return h;
};

export function createSynthKeys({ gapMs = SYNTH_GAP_MS } = {}) {
  const open = new Map(); // `${harness}\0${hash}` → { key, lastMs }
  return {
    keyOf(rec) {
      if (!rec || rec.is_llm_call !== true || sessionKeyOf(rec).key) return null;
      const h = harnessOf(rec);
      if (!h.row || h.row.synth !== true) return null;
      const ms = Date.parse(rec.ts_request || rec.ts || '');
      if (!Number.isFinite(ms)) return null; // no time, no window: the call stays keyless (and is shown as such)
      const hash = hashOf(rec);
      const g = h.id + '\0' + hash;
      const cur = open.get(g);
      if (cur && Math.abs(ms - cur.lastMs) <= gapMs) { cur.lastMs = Math.max(cur.lastMs, ms); return cur.key; }
      const key = `synth-${h.id}-${hash.slice(0, 12)}-${stampOf(ms)}`;
      open.set(g, { key, lastMs: ms });
      return key;
    },
  };
}

// The board's whole-corpus form: stamp every record, in array order, with a non-enumerable `_synthKey` (null when
// it gets none), so a record serializes exactly as captured (invariant 2).
export function stampSynthKeys(records, opts) {
  const k = createSynthKeys(opts);
  for (const r of records || []) {
    if (r && typeof r === 'object') Object.defineProperty(r, '_synthKey', { value: k.keyOf(r), enumerable: false, configurable: true, writable: true });
  }
  return records;
}
