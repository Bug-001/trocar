// src/cache/cache-events.mjs — RFC 3.3 cache-events derivation (D17 forensics · trocar's
// differentiating moat, D17 · spec 3.3). Pure, offline functions: given a class='llm' call's
// ordered BlockRow[] + its same-lane predecessor's BlockRow[] + canonical usage, derive ONE
// cache_events row (3.2 columns).
//
// UPGRADES over the v0 prototype's cacheBreak/groundTruth (D17 · spec 3.3):
//   • block identity = full sha-256 content_hash (D19, over VERBATIM wire bytes) — NOT the demo's
//     32-bit blkKey over the first 4096 chars.
//   • divergence_byte_offset over the block's VERBATIM source bytes (BlockRow.text = the exact
//     captured req_body slice) — NOT over a reconstructed preview string (RFC 3.3 L36 「回 NDJSON,
//     非 preview」).
//   • prefix_sha256 = a REAL sha-256 over the concatenated VERBATIM source bytes of the reusable
//     prefix (skip volatile) — NOT the demo's structural content_hash-sequence proxy (hash-of-hashes,
//     RFC 3.3 L75). This is the independent, re-computable byte fact = the ground-truth moat.
//   • cross-provider break_kind + cache_write_billing labels (RFC 3.3 L82) — demo was Anthropic-only.
//
// INVARIANT 1 (OBSERVE-only): every field is derived from ALREADY-captured bytes; nothing here ever
//   re-sends a request to verify.
// INVARIANT 4 (保真边界写明): structural_divergence_seq / raw_divergence_seq / divergence_byte_offset
//   / divergence_cause are STRUCTURAL ESTIMATES (extra.structural_estimate=true, MUST be rendered as
//   「结构估计, 非 provider 真实 cache 边界」). Numeric truth stays with real usage; on any
//   structure-vs-usage conflict, usage wins (RFC 3.3 真相规则).
// D19: canonJSON / key-sorting below is used ONLY to CLASSIFY json-key-reorder / tool-array-reorder,
//   NEVER to compute content_hash (that stays byte-exact — see src/adapters/content-hash.mjs).
import { createHash } from 'node:crypto';

// ── Tier-2 vendor capability + write-billing labels (RFC 3.3 L82 跨 provider cache 保真标签) ──
// This is the static capability table. It owns cache_write_billing (how a vendor bills the cache WRITE
// side) — the load-bearing label that stops a cross-vendor overlay from summing non-comparable numbers
// (RFC 3.3 L87: `none`/`excluded` MUST NOT render as 0). D37 (3.3:89): it is keyed by the VENDOR (the
// upstream host, src/dissect/vendors.mjs), not by the wire format — dsh speaks the Anthropic wire to
// DeepSeek. `cc` is the pre-D37 alias of `anthropic`, kept for old callers.
const PROVIDER_CACHE = {
  anthropic: { break_kind: 'explicit-breakpoint', cache_write_billing: 'charged' },
  cc: { break_kind: 'explicit-breakpoint', cache_write_billing: 'charged' },
  openai: { break_kind: 'automatic-prefix', cache_write_billing: 'free' },
  deepseek: { break_kind: 'automatic-disk', cache_write_billing: 'none' },
  bedrock: { break_kind: null, cache_write_billing: 'excluded' },
};
// 3.3:89 OPEN (its recommended default, not a decision made here): a vendor row established on ONE wire
// only is not vouched for on another. DeepSeek's row comes from its Chat Completions API; DeepSeek through
// its Anthropic endpoint (dsh) is listed in the OPEN as unproven, so until a real capture settles it the
// labels are NULL + 「厂商缓存语义未知」. Deleting the row here is the whole change once it is verified.
const VERIFIED_WIRES = { deepseek: ['openai-chat'] };
const UNKNOWN_LABELS = Object.freeze({ break_kind: null, cache_write_billing: null });
// → the labels, or NULL/NULL when the vendor's cache semantics are unknown (unknown vendor, or a wire its
// row was not established on). MUST NOT borrow another vendor's semantics (3.3:89). `wireFormat` null =
// a pre-D37 caller that did not say: the vendor row applies as before.
export function breakKindFor(vendor, wireFormat = null) {
  const row = PROVIDER_CACHE[vendor];
  if (!row) return UNKNOWN_LABELS;
  const only = VERIFIED_WIRES[vendor];
  return only && wireFormat != null && !only.includes(wireFormat) ? UNKNOWN_LABELS : row;
}
// true when the vendor's cache semantics are established for this wire — false = the DB writes NULL labels and
// 「厂商缓存语义未知」. The board bakes the same answer per call (wire.cacheSemanticsKnown, src/view/assemble.mjs).
export const cacheSemanticsKnown = (vendor, wireFormat) => breakKindFor(vendor, wireFormat) !== UNKNOWN_LABELS;
const semanticsKnown = cacheSemanticsKnown;

// ── Tier-1 numeric truth: hit_ratio = cache_read / total_input (RFC 3.3 L12) ──
// null when the denominator is 0/unknown (guard div0). Phase-1 = Anthropic, whose denominator IS
// total_input; DeepSeek hit/(hit+miss) & Bedrock's cache-excluded denominator are Phase-4 (RFC L85 —
// then thread `provider` in or move the ratio into the provider table, MUST carry the 保真标签).
export function hitRatio(usage) {
  const denom = usage?.total_input || 0;
  if (!denom) return null;
  return (usage.cache_read || 0) / denom;
}

// ── Anthropic declared breakpoints = seq of blocks carrying cache_control (≤4). null otherwise ──
// (RFC 3.3 L14/L94: only Anthropic declares real breakpoints on the wire; OpenAI/DeepSeek → null.)
export function declaredBreakpoints(provider, curBlocks) {
  if (provider !== 'anthropic' && provider !== 'cc') return null;
  const bp = [];
  for (const b of curBlocks || []) if (b.cache_control != null) bp.push(b.seq);
  return bp;
}

// ── Divergence localization (RFC 3.3 前缀分叉定位) ──
// Compare the content_hash sequences of two same-lane calls (N−1, N), position by position:
//   structural = first NON-volatile mismatch → the cache-relevant break (= demo `idx`).
//   raw        = first mismatch of ANY kind (= demo `rawIdx`); raw < structural ⇔ a cache-irrelevant
//                block (e.g. CC's billing nonce) changed first but was correctly excluded — used to
//                annotate 「为何这个先变的块不算断点」.
//   No true divergence in the shared region ⇒ structural = min(prevLen, curLen) (pure append: the new
//                content is the appended tail). First in-lane call ⇒ firstCall, seqs 0.
export function divergence(prevBlocks, curBlocks) {
  if (!prevBlocks || prevBlocks.length === 0) return { structural: 0, raw: 0, firstCall: true };
  const n = Math.min(prevBlocks.length, curBlocks.length);
  let raw = -1;
  let structural = -1;
  for (let i = 0; i < n; i++) {
    if (prevBlocks[i].content_hash === curBlocks[i].content_hash) continue;
    if (raw < 0) raw = i;
    if (curBlocks[i].volatile) continue; // billing nonce — differs every call but cache-irrelevant
    structural = i;
    break;
  }
  if (structural < 0) structural = n; // shared region identical → new content is the appended tail
  if (raw < 0) raw = structural;
  return { structural, raw, firstCall: false };
}

// ── cause-classification helpers (STRICTLY for classification; NEVER for hashing — D19) ──
// canonJSON: sort object keys recursively so a pure key/array reorder can be told apart from a real
// content change. It touches ONLY the classification path — content_hash stays byte-exact.
function canonJSON(v) {
  if (Array.isArray(v)) return v.map(canonJSON);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonJSON(v[k]);
    return o;
  }
  return v;
}
function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}
// first differing BYTE offset between two verbatim strings' UTF-8 encodings (structural estimate of
// the byte where the prefix broke). −1 when identical.
function firstDiffByte(aStr, bStr) {
  const a = Buffer.from(aStr, 'utf8');
  const b = Buffer.from(bStr, 'utf8');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
// same content up to JSON key/array ordering, but different raw bytes → nondeterministic serialization.
function keyReorderText(prevText, curText) {
  const pj = tryParse(prevText);
  const cj = tryParse(curText);
  if (pj === undefined || cj === undefined) return false; // plain text — not a key reorder
  if (JSON.stringify(pj) === JSON.stringify(cj)) return false; // byte-diff isn't from key order
  return JSON.stringify(canonJSON(pj)) === JSON.stringify(canonJSON(cj));
}

// ── classifyCause: taxonomy (RFC 3.3 L44) + first differing byte over VERBATIM source ──
// STRUCTURAL inference; usage stays authoritative. meta.compaction (calls.compaction, the message-
// count-drop verdict) is AUTHORITATIVE — bare structure NEVER guesses compaction (RFC L57: CC
// re-injects scaffolding / forks into the first message and would false-fire a naive heuristic).
// meta.causeOverride refines only the generic 'content-changed' bucket with adapter-owned provider-
// rule causes (breakpoint-out-of-window / mid-turn-retry / model-or-route-change — RFC L59, they
// belong to 3.1) and never overrides a specific cause. Catch-all is 'unknown' (RFC L55).
export function classifyCause({ prevBlocks, curBlocks, structural, raw, meta = {} }) {
  const prev = prevBlocks || [];
  const n = Math.min(prev.length, curBlocks.length);
  if (structural >= n) {
    // shared prefix fully reused: only a volatile block changed, or new content was appended
    const cause = curBlocks.length <= prev.length && raw < n ? 'volatile-nonce-only' : 'append';
    return { cause, byteOffset: null, byteContext: '' };
  }
  const cur = curBlocks[structural];
  const pv = prev[structural];
  const prevText = pv.text ?? '';
  const curText = cur.text ?? '';
  let cause;
  if (cur.section === 'tools') {
    const ph = prev.filter((b) => b.section === 'tools').map((b) => b.content_hash);
    const ch = curBlocks.filter((b) => b.section === 'tools').map((b) => b.content_hash);
    const sameSet =
      ph.length === ch.length && [...ph].sort().join('\x01') === [...ch].sort().join('\x01');
    if (sameSet && ph.join('\x01') !== ch.join('\x01')) cause = 'tool-array-reorder';
    else cause = keyReorderText(prevText, curText) ? 'json-key-reorder' : 'content-changed';
  } else {
    cause = keyReorderText(prevText, curText) ? 'json-key-reorder' : 'content-changed';
  }
  const off = firstDiffByte(prevText, curText);
  const byteOffset = off < 0 ? null : off;
  const byteContext = off < 0 ? '' : Buffer.from(curText, 'utf8').slice(off, off + 48).toString('utf8');
  if (cause === 'content-changed' && meta.causeOverride) cause = meta.causeOverride;
  if (meta.compaction) cause = 'compaction'; // authoritative override (RFC L48/L57)
  return { cause, byteOffset, byteContext };
}

// ── prefixSha256 (★ RFC 3.3 L63 地面真相验证 · 独立字节真相护城河) ──
// A REAL sha-256 over the concatenated VERBATIM source bytes (BlockRow.text) of the reusable prefix
// [0, structural), SKIPPING volatile blocks. These are the exact bytes content_hash was taken over
// (src/adapters/cc.mjs mkBlock: content_hash = sha256(src.slice(span)) === sha256(block.text)), so
// this hash is byte-identical to what actually went on the wire. It is NOT a hash of content_hashes
// (that would be hash-of-hashes and forfeit the "independent ground truth" claim — RFC L75). null
// when there is no reusable prefix (structural<=0 / first call). OBSERVE-only: hashes captured bytes,
// never re-sends to verify.
export function prefixSha256(curBlocks, structural) {
  if (!(structural > 0)) return null; // no reusable prefix (first call / whole-window recompute)
  const h = createHash('sha256');
  for (let i = 0; i < structural && i < curBlocks.length; i++) {
    if (curBlocks[i].volatile) continue; // billing nonce — bytes change but excluded from the cache key
    h.update(curBlocks[i].text ?? '', 'utf8');
  }
  return h.digest('hex');
}

// ── ground_truth_flag (RFC 3.3 L63 地面真相验证) ──
// With a reusable prefix (structural>0 ⇒ [0,structural) content_hashes matched ⇒ my outbound prefix
// is byte-identical), cross-check what real usage actually credited:
//   cache_read>0                       → prefix genuinely reused                → null
//   cache_read=0 & cache_write>0       → cache entry TTL-expired & re-cached    → 'ttl-rebuild' (NOT a contradiction)
//   cache_read=0 & cache_write 0/NULL  → reusable prefix NEITHER read NOR written → 'provider-contradiction'
// The `cache_write=0/NULL → provider-contradiction` mapping follows RFC 3.3 L71 EXACTLY (both the 0
// and the NULL case; NULL = a no-write-concept provider, e.g. DeepSeek). `null > 0` is false, so NULL
// falls through to provider-contradiction — no special-casing needed. First call / whole-window
// recompute (structural<=0) → null.
// STRICT WORDING (invariant 4, RFC L73): the claim is ONLY 「my outbound prefix is byte-identical ⇒
// the suspicion points at the provider (mis-cache/mis-bill)」 — the 'provider-contradiction' flag
// MUST be rendered as *suspecting* the provider, and MUST NOT be rendered as asserting the provider
// is wrong (provider internals remain a black box; numeric truth stays = real usage).
export function groundTruthFlag(structural, firstCall, cacheRead, cacheWrite) {
  if (firstCall || structural <= 0) return null; // no reusable prefix to reason about
  if (cacheRead > 0) return null; // prefix genuinely reused
  return cacheWrite > 0 ? 'ttl-rebuild' : 'provider-contradiction';
}

// ── break_kind for the emitted row (Phase-1 CC · per-call prefix mechanism) ──
// Refines the static provider label into the mechanism actually in play for THIS call:
//   whole-recompute     — no reusable prefix (first call / structural<=0): the whole window recomputes.
//   explicit-breakpoint — a cache_control breakpoint sits inside the reusable prefix (the Anthropic case).
//   automatic-prefix    — a reusable prefix exists but carries no declared breakpoint.
// For real CC calls (cache_control always present in the prefix) this reduces to the RFC's Anthropic
// break_kind='explicit-breakpoint'; it only differs for the edge cases the static label can't express.
export function breakKind(curBlocks, structural) {
  if (!(structural > 0)) return 'whole-recompute';
  for (let i = 0; i < structural && i < curBlocks.length; i++) {
    if (curBlocks[i].cache_control != null) return 'explicit-breakpoint';
  }
  return 'automatic-prefix';
}

// ── deriveCacheEvents: assemble ONE cache_events row (3.2 columns) ──
// Signature (Phase-1, block.text-carrying BlockRow[] straight from src/adapters/cc.mjs::parseBlocks —
// no readSource injection needed, the block already carries its verbatim bytes):
//   deriveCacheEvents(prevBlocks, curBlocks, usage, opts) where
//     prevBlocks : BlockRow[] | null  (same-lane predecessor; null = first in-lane call)
//     curBlocks  : BlockRow[]         (this call, ordered tools→system→messages by seq)
//     usage      : { cache_read, cache_write (number|null — NOT coerced to 0), total_input }
//     opts       : { compaction?:bool (calls.compaction, authoritative), causeOverride?:string,
//                    call_id?:string (3.2 PK), vendor?:string|null (D37; `provider` = pre-D37 alias,
//                    default 'anthropic'), wireFormat?:string|null, contextState?:string|null }
export function deriveCacheEvents(prevBlocks, curBlocks, usage = {}, opts = {}) {
  const { compaction = false, causeOverride, call_id = null } = opts;
  // D37 (3.3:89): labels by VENDOR. `provider` is the pre-D37 alias, read only when `vendor` is absent.
  const vendor = 'vendor' in opts ? opts.vendor : (opts.provider ?? 'anthropic');
  // Declared breakpoints are a WIRE fact (cache_control markers on the Anthropic wire), not a vendor fact.
  const wireFormat = opts.wireFormat ?? (vendor === 'anthropic' || vendor === 'cc' ? 'anthropic' : null);
  // 3.2:124: a partial or server-edited context has no byte prefix we can vouch for → NULL prefix + flag.
  // 'reconstructed' (stitched, every predecessor present) stays authoritative.
  const contextState = opts.contextState ?? null;
  const blind = contextState === 'partial' || contextState === 'server_edited';
  const div = divergence(prevBlocks, curBlocks);
  const { cause, byteOffset, byteContext } = classifyCause({
    prevBlocks: prevBlocks || [],
    curBlocks,
    structural: div.structural,
    raw: div.raw,
    meta: { compaction, causeOverride },
  });
  const { break_kind, cache_write_billing } = breakKindFor(vendor, opts.wireFormat ?? null);
  const firstCall = div.firstCall;
  return {
    call_id,
    // break_kind = the STATIC provider cache design (RFC 3.3 L14; 3.2 enum
    // explicit-breakpoint|automatic-prefix|automatic-disk). The per-call prefix
    // mechanism (whole-recompute / hit a breakpoint / plain prefix) is a different
    // axis (this call's outcome, also in structural_divergence_seq) → extra.prefix_mechanism,
    // so downstream switching on break_kind never sees an out-of-enum value.
    break_kind,
    hit_ratio: hitRatio(usage),
    declared_breakpoints: declaredBreakpoints(wireFormat === 'anthropic' ? 'anthropic' : null, curBlocks),
    structural_divergence_seq: div.structural,
    raw_divergence_seq: div.raw,
    // whole-new-block / first call ⇒ NULL byte offset (RFC L36); else the first differing byte.
    divergence_byte_offset: firstCall ? null : byteOffset,
    // No 'first-call' enum value exists in the RFC taxonomy (RFC L44-55); the first in-lane call has
    // no prefix to diverge from → catch-all 'unknown' with extra.first_call=true (not an invented code).
    divergence_cause: firstCall ? 'unknown' : cause,
    prefix_sha256: blind ? null : prefixSha256(curBlocks, div.structural),
    cache_write_billing,
    ground_truth_flag: blind ? null : groundTruthFlag(div.structural, firstCall, usage.cache_read || 0, usage.cache_write),
    extra: {
      structural_estimate: true, // invariant 4: all seq/offset/cause here are structural estimates
      raw_before_structural: div.raw < div.structural,
      first_call: firstCall || undefined,
      byte_context: byteContext || undefined,
      // per-call prefix mechanism (diagnostic refinement, NOT the enum break_kind):
      // whole-recompute (no reusable prefix) | explicit-breakpoint (cache_control in prefix) | automatic-prefix
      prefix_mechanism: breakKind(curBlocks, div.structural),
      // rendered 「厂商缓存语义未知」: the two labels above are NULL because nothing vouches for them (3.3:89)
      vendor_cache_semantics: semanticsKnown(vendor, opts.wireFormat ?? null) ? undefined : 'unknown',
      // why prefix_sha256 / ground_truth_flag are NULL on a non-complete context (3.2:124)
      context_state: contextState && contextState !== 'complete' ? contextState : undefined,
    },
  };
}
