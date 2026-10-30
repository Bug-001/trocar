// src/dissect/synth-key.mjs — synthesized session keys (RFC 3.4 Plan 合成键; the default rule is gate G11,
// to be checked against a lab capture). For a harness whose table row says
// `synth: true` (Hermes on a custom endpoint; Kimi without a body key), a keyless inference call joins the open
// session of the same harness and the same system-prompt hash when it starts within SYNTH_GAP_MS of that
// session's latest call; otherwise it opens a new one. pid and connection are NOT inputs (3.4 关键区分: one
// Hermes gateway serves many tasks). Callers feed records in file order; the board and the ETL both read the
// capture files in sorted order, so they assign the same keys. A keyless call that is its harness's compaction request is first
// matched to an open session of the same harness, keyed or synthesized, by the user text both carry (3.4 按内容认亲; pi's summary request). Leaf module.
import { createHash } from 'node:crypto';
import { harnessOf, sessionKeyOf, bodyOf, hintsOf } from './harnesses.mjs';

export const SYNTH_GAP_MS = 30 * 60 * 1000;
export const SYNTH_RULE = 'sha256(first system text) + a 30-minute gap (3.4 合成键, gate G11)';

const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : '') : String(p ?? ''))).join('') : '');
// The task anchor: the first system text of whichever wire the call used (Anthropic `system`, Responses
// `instructions`, else the first system / developer item of its `input`; Chat's leading system / developer
// message). '' when there is none: still an anchor.
export function systemTextOf(body) {
  const b = body || {};
  if (b.system != null) return textOf(b.system);
  if (typeof b.instructions === 'string') return b.instructions;
  const item = Array.isArray(b.input) ? b.input.find((x) => x && (x.role === 'system' || x.role === 'developer')) : null;
  if (item) return textOf(item.content);
  const first = Array.isArray(b.messages) ? b.messages[0] : null;
  if (first && (first.role === 'system' || first.role === 'developer')) return textOf(first.content);
  return '';
}

// 2026-10-06T00:00:00.000Z → 20261006T000000Z: no '/', '#' or ':', so the key is safe inside a raw_ref.
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// The board re-stamps the whole corpus on every request (each poll): a record's facts are derived once.
const FACTS = new WeakMap();

// ── kinship (3.4 合成键 · 按内容认亲) ─────────────────────────────────────────────────────────────────────────────────────
// A keyless call that is its harness's compaction request is looked for in the open sessions of that harness first, by the
// user text both carry. Fingerprints: every WIN-character window of the whitespace-collapsed text, hashed, kept when the hash
// falls on the sample (h % SAMPLE === 0) — the same rule on both sides, so a long enough shared fragment yields shared fingerprints
// when it falls within what both sides keep (the caps below; else the call falls back to its synthesized key). Character windows, not words: CJK has no spaces. A fingerprint is stored as h / SAMPLE (a small integer).
const WIN = 32, SAMPLE = 8, FP_CAP = 64, PROBE_CAP = 1024, STATE_CAP = 4096, MIN_SHARED = 2;
const userTextsOf = (body) => {
  const b = body || {};
  if (typeof b.input === 'string') return [b.input];
  const items = [...(Array.isArray(b.messages) ? b.messages : []), ...(Array.isArray(b.input) ? b.input : [])];
  return items.filter((x) => x && x.role === 'user').map((x) => textOf(x.content));
};
// polynomial rolling hash over UTF-16 units, mod 2^32
const BASE = 0x01000193, TOP = (() => { let p = 1; for (let i = 1; i < WIN; i++) p = Math.imul(p, BASE); return p; })();
function fingerprints(texts, cap) {
  const out = new Set();
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    let h = 0;
    for (let i = 0; i < t.length && out.size < cap; i++) {
      if (i >= WIN) h = (h - Math.imul(t.charCodeAt(i - WIN), TOP)) | 0;
      h = (Math.imul(h, BASE) + t.charCodeAt(i)) | 0;
      if (i >= WIN - 1 && (h >>> 0) % SAMPLE === 0) out.add((h >>> 0) / SAMPLE);
    }
    if (out.size >= cap) break;
  }
  return [...out];
}

export function createSynthKeys({ gapMs = SYNTH_GAP_MS } = {}) {
  const assign = createSynthAssigner({ gapMs });
  return { keyOf: (rec) => { const got = assign(synthFactsOf(rec)); return got ? got.key : null; } };
}

/** What a call brings to the rule, or null when it takes no part in it. Keyless → {harness, ms, hash, fp, probe}: `fp` is the
 *  fingerprints its session is recognized by, `probe` the ones it looks for its session with when it is the harness's
 *  compaction request, else null. Keyed (a `synth: true` harness only) → {harness, ms, key, fp}, with NO hash: a keyed call never opens or moves a synthesized group. A reader that cannot afford the body later (the
 *  segment index, 1.6 §4.1) stores these and asks the assigner below with them. */
export function synthFactsOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (FACTS.has(rec)) return FACTS.get(rec);
  const f = factsOf(rec);
  FACTS.set(rec, f);
  return f;
}
function factsOf(rec) {
  // a call kept as a log line only (D40) has no system text to anchor a task by: it stays keyless, and is shown as such
  if (rec.is_llm_call !== true || rec.body_retention === 'log') return null;
  const h = harnessOf(rec);
  if (!h.row || h.row.synth !== true) return null;
  const ms = Date.parse(rec.ts_request || rec.ts || '');
  if (!Number.isFinite(ms)) return null; // no time, no window: the call stays keyless (and is shown as such)
  const key = sessionKeyOf(rec).key;
  const texts = userTextsOf(bodyOf(rec)), fp = fingerprints([...texts].reverse(), FP_CAP);
  if (key) return { harness: h.id, ms, key, fp };
  const probe = compactionRequest(rec, h.row) ? fingerprints(texts, PROBE_CAP) : null;
  return { harness: h.id, ms, hash: createHash('sha256').update(systemTextOf(bodyOf(rec)), 'utf8').digest('hex'), fp, probe };
}

// The call that is the compaction request: a header / request-kind hint, or its harness's text marker in its own system text
// (pi's summary request), read as a JSON string so a marker anchored on a string's start holds. A marker in the history (Hermes
// keeps one in every later call) marks a turn of the session it is in, not a call looking for one (3.4 按内容认亲).
function compactionRequest(rec, row) {
  const hint = hintsOf(rec);
  if (hint.compaction === true) return true;
  if (!hint.compactionMarker) return false;
  const sys = JSON.stringify(systemTextOf(bodyOf(rec)));
  return row.compaction.some((c) => c.marker && c.marker.test(sys));
}

/** The rule itself (gate G11), over those facts in the order the calls were captured → {key, kin} | null. Every call adds its
 *  fingerprints to its session's entry; a keyed call gets nothing else (null). A keyless call with a probe joins the session of
 *  its harness — keyed, or synthesized from inferred calls alike — last seen within `gapMs`, that shares the most fingerprints
 *  with it (at least MIN_SHARED; a tie → the later last call; never its own system-prompt group) — kin: true. Otherwise: same
 *  harness + same system-prompt hash within `gapMs` of the open session's latest call → that session; else a new one. */
export function createSynthAssigner({ gapMs = SYNTH_GAP_MS, open = new Map() } = {}) {
  // `${harness}\0${hash}` → { key, lastMs, fp }; `\u0001${harness}\0${key}` → { key, lastMs, fp } (fp: a Set, replaced, never
  // mutated, so a shallow copy of an entry is a snapshot). A caller that resumes the rule part-way (src/query/rows.mjs) hands
  // in the state it saved.
  const mine = (g, harness) => g.startsWith(harness + '\0') || g.startsWith('\u0001' + harness + '\0');
  const prune = (harness, ms) => { for (const [g, e] of open) if (mine(g, harness) && ms - e.lastMs > 2 * gapMs) open.delete(g); };
  const grow = (fp, add) => {
    let next = fp || new Set();
    for (const x of add || []) if (!next.has(x)) { if (next === fp) next = new Set(fp); next.add(x); }
    return next.size > STATE_CAP ? new Set([...next].slice(next.size - STATE_CAP)) : next; // FIFO: the oldest go first
  };
  return (facts) => {
    if (!facts || !facts.harness || !Number.isFinite(facts.ms)) return null;
    const { harness, ms } = facts;
    if (facts.key != null) {
      const g = '\u0001' + harness + '\0' + facts.key;
      const cur = open.get(g);
      if (!cur) prune(harness, ms);
      open.set(g, { key: facts.key, lastMs: Math.max(cur ? cur.lastMs : ms, ms), fp: grow(cur && cur.fp, facts.fp) });
      return null;
    }
    if (facts.hash == null) return null;
    const own = harness + '\0' + facts.hash;
    if (facts.probe && facts.probe.length) {
      prune(harness, ms);
      let best = null, bestN = 0;
      for (const [g, e] of open) {
        if (g === own || !e.fp || !mine(g, harness) || Math.abs(ms - e.lastMs) > gapMs) continue;
        let n = 0;
        for (const x of facts.probe) if (e.fp.has(x)) n++;
        if (n >= MIN_SHARED && (n > bestN || (n === bestN && e.lastMs > best.lastMs))) { best = e; bestN = n; }
      }
      if (best) { best.lastMs = Math.max(best.lastMs, ms); return { key: best.key, kin: true }; }
    }
    const cur = open.get(own);
    if (cur && Math.abs(ms - cur.lastMs) <= gapMs) {
      cur.lastMs = Math.max(cur.lastMs, ms); cur.fp = grow(cur.fp, facts.fp);
      return { key: cur.key, kin: false };
    }
    const key = `synth-${harness}-${facts.hash.slice(0, 12)}-${stampOf(ms)}`;
    open.set(own, { key, lastMs: ms, fp: grow(null, facts.fp) });
    return { key, kin: false };
  };
}

// The board's whole-corpus form: stamp every record, in array order, with a non-enumerable `_synthKey` (null when it gets
// none) and, when it was joined to its session by content, a non-enumerable `_kin: true`, so a record serializes exactly
// as captured (invariant 2).
export function stampSynthKeys(records, { gapMs = SYNTH_GAP_MS } = {}) {
  const assign = createSynthAssigner({ gapMs });
  for (const r of records || []) {
    if (!r || typeof r !== 'object') continue;
    const got = assign(synthFactsOf(r));
    Object.defineProperty(r, '_synthKey', { value: got ? got.key : null, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(r, '_kin', { value: !!(got && got.kin), enumerable: false, configurable: true, writable: true });
  }
  return records;
}
