// test/cache/cache-events.test.mjs — RFC 3.3 cache-events derivation (D17 forensics).
// Unit tests per composable function + a real-CC-capture regression. Fixtures are real-shaped
// BlockRow[] (the exact shape src/adapters/cc.mjs::parseBlocks emits): {seq, content_hash, section,
// volatile, cache_control, text}. content_hash is computed with the REAL D19 hasher (contentHash
// from src/adapters/content-hash.mjs) over the block's VERBATIM bytes — so the tests exercise the
// same byte-exact hashing the product uses, and `text` IS the exact bytes content_hash was taken over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  breakKindFor,
  hitRatio,
  declaredBreakpoints,
  divergence,
  classifyCause,
  prefixSha256,
  groundTruthFlag,
  breakKind,
  deriveCacheEvents,
} from '../../src/cache/cache-events.mjs';
import { contentHash } from '../../src/adapters/content-hash.mjs';
import { mapUsage } from '../../src/model/schema.mjs';

// Build a call's BlockRow[] from compact specs. bytes = the block's VERBATIM captured bytes;
// content_hash = the REAL D19 sha-256 over those bytes; text = the same verbatim bytes (byte-exact
// work reads block.text, exactly as the product does — parseBlocks sets text = src.slice(span)).
function mkCall(specs) {
  return specs.map((s, i) => ({
    seq: i,
    content_hash: contentHash(s.bytes),
    section: s.section || 'messages',
    volatile: !!s.volatile,
    cache_control: s.cc || null,
    text: s.bytes,
  }));
}
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Task 1: provider labels + Tier-1 numeric truth ──────────────────────────────
test('breakKindFor maps provider → break_kind + write-billing (RFC 3.3 L82 保真标签)', () => {
  assert.deepEqual(breakKindFor('anthropic'), { break_kind: 'explicit-breakpoint', cache_write_billing: 'charged' });
  assert.deepEqual(breakKindFor('openai'), { break_kind: 'automatic-prefix', cache_write_billing: 'free' });
  assert.deepEqual(breakKindFor('deepseek'), { break_kind: 'automatic-disk', cache_write_billing: 'none' });
  assert.deepEqual(breakKindFor('bedrock'), { break_kind: null, cache_write_billing: 'excluded' });
});

test('hitRatio = cache_read / total_input, null when denom is 0/unknown', () => {
  assert.equal(hitRatio({ cache_read: 300, total_input: 400 }), 0.75);
  assert.equal(hitRatio({ cache_read: 0, total_input: 0 }), null);
  assert.equal(hitRatio({}), null);
});

test('declaredBreakpoints = seq of cache_control blocks (anthropic only)', () => {
  const cur = mkCall([
    { section: 'tools', bytes: '{"name":"Read"}' },
    { section: 'system', bytes: 'SYS', cc: { type: 'ephemeral' } },
    { section: 'messages', bytes: 'hi', cc: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(declaredBreakpoints('anthropic', cur), [1, 2]);
  assert.equal(declaredBreakpoints('openai', cur), null);
});

// ── Task 2: divergence (structural skip-volatile vs raw no-skip) ─────────────────
test('divergence: pure append → structural=prevLen, raw=structural, not firstCall', () => {
  const prev = mkCall([{ bytes: 'A' }, { bytes: 'B' }]);
  const cur = mkCall([{ bytes: 'A' }, { bytes: 'B' }, { bytes: 'C' }]);
  assert.deepEqual(divergence(prev, cur), { structural: 2, raw: 2, firstCall: false });
});

test('divergence: null/empty prev → firstCall true, seqs 0', () => {
  const cur = mkCall([{ bytes: 'A' }]);
  assert.deepEqual(divergence(null, cur), { structural: 0, raw: 0, firstCall: true });
});

test('divergence skips volatile: raw < structural when a volatile block changes first', () => {
  const prev = mkCall([{ bytes: 'NONCE-1', volatile: true }, { bytes: 'X' }, { bytes: 'Y' }]);
  const cur = mkCall([{ bytes: 'NONCE-2', volatile: true }, { bytes: 'X' }, { bytes: 'Z' }]);
  assert.deepEqual(divergence(prev, cur), { structural: 2, raw: 0, firstCall: false });
});

// ── Task 3: classifyCause taxonomy + byte-offset over VERBATIM source (block.text) ──
const clsf = (prev, cur, meta) =>
  classifyCause({ prevBlocks: prev, curBlocks: cur, ...pick(divergence(prev, cur)), meta });
const pick = (d) => ({ structural: d.structural, raw: d.raw });

test('classifyCause: append when only a tail block was added (byteOffset null)', () => {
  const prev = mkCall([{ bytes: 'A' }, { bytes: 'B' }]);
  const cur = mkCall([{ bytes: 'A' }, { bytes: 'B' }, { bytes: 'C' }]);
  const c = clsf(prev, cur);
  assert.equal(c.cause, 'append');
  assert.equal(c.byteOffset, null);
});

test('classifyCause: volatile-nonce-only when only a trailing volatile block changed', () => {
  const prev = mkCall([{ bytes: 'A' }, { bytes: 'NONCE-1', volatile: true }]);
  const cur = mkCall([{ bytes: 'A' }, { bytes: 'NONCE-2', volatile: true }]);
  assert.equal(clsf(prev, cur).cause, 'volatile-nonce-only');
});

// (b) json-key-reorder is CLASSIFIED as the cause, yet content_hash STILL diverges (D19 byte-exact:
//     canonJSON is used only to classify, never to dedup/hash).
test('classifyCause (b): json-key-reorder detected, yet content_hash STILL diverges (D19)', () => {
  const prev = mkCall([{ bytes: '{"a":1,"b":2}' }]);
  const cur = mkCall([{ bytes: '{"b":2,"a":1}' }]); // reordered keys → different wire bytes
  assert.notEqual(prev[0].content_hash, cur[0].content_hash); // byte-exact hash diverges
  const c = clsf(prev, cur);
  assert.equal(c.cause, 'json-key-reorder');
  assert.equal(c.byteOffset, 2); // bytes 0='{' 1='"' equal; 'a' vs 'b' first differ at byte 2
});

test('classifyCause: tool-array-reorder when tools section same set, different order', () => {
  const prev = mkCall([
    { section: 'tools', bytes: '{"name":"Read"}' },
    { section: 'tools', bytes: '{"name":"Bash"}' },
  ]);
  const cur = mkCall([
    { section: 'tools', bytes: '{"name":"Bash"}' },
    { section: 'tools', bytes: '{"name":"Read"}' },
  ]);
  assert.equal(clsf(prev, cur).cause, 'tool-array-reorder');
});

test('classifyCause: content-changed for in-place edit; byteOffset localizes over verbatim bytes', () => {
  const prev = mkCall([{ bytes: 'hello world' }]);
  const cur = mkCall([{ bytes: 'hello there' }]);
  const c = clsf(prev, cur);
  assert.equal(c.cause, 'content-changed');
  assert.equal(c.byteOffset, 6); // 'hello ' shared (bytes 0..5), differ at byte 6
});

// (f) compaction opt (authoritative message-count-drop verdict) OVERRIDES the structural guess.
test('classifyCause (f): compaction opt overrides structural guess → cause=compaction', () => {
  const prev = mkCall([{ bytes: 'hello world' }]);
  const cur = mkCall([{ bytes: 'hello there' }]);
  assert.equal(clsf(prev, cur).cause, 'content-changed'); // bare structure never guesses compaction
  assert.equal(clsf(prev, cur, { compaction: true }).cause, 'compaction');
});

// ── Task 4 / (a): prefixSha256 = REAL sha-256 over VERBATIM source bytes, NOT hash-of-hashes ──
test('prefixSha256 (a): REAL sha-256 over concatenated VERBATIM source bytes, skipping volatile', () => {
  const cur = mkCall([
    { bytes: 'AAA' },
    { bytes: 'NONCE', volatile: true },
    { bytes: 'BBB' },
    { bytes: 'CCC' }, // diverging block at seq 3 → prefix = [0,3) minus volatile = AAA + BBB
  ]);
  const got = prefixSha256(cur, 3);
  // independently recomputed sha-256 of the actual concatenated source bytes
  const expect = sha256hex(Buffer.concat([Buffer.from('AAA'), Buffer.from('BBB')]));
  assert.equal(got, expect);
  // NEGATIVE: MUST NOT be a hash of the content_hashes (demo's structural proxy — RFC L75 hash-of-hashes)
  const hashOfHashes = sha256hex(Buffer.from(cur[0].content_hash + cur[2].content_hash));
  assert.notEqual(got, hashOfHashes);
});

test('prefixSha256 (a-neg): DIFFERS when a prefix block is JSON parse-equal but its WIRE BYTES differ', () => {
  const v1 = mkCall([{ bytes: '{"a":1,"b":2}' }, { bytes: 'TAIL-1' }]);
  const v2 = mkCall([{ bytes: '{"b":2,"a":1}' }, { bytes: 'TAIL-2' }]);
  const p1 = prefixSha256(v1, 1);
  const p2 = prefixSha256(v2, 1);
  assert.deepEqual(JSON.parse(v1[0].text), JSON.parse(v2[0].text)); // parse-EQUAL content
  assert.notEqual(p1, p2); // …but different wire bytes → different prefix_sha256 (proves real bytes)
  assert.equal(p1, sha256hex(Buffer.from('{"a":1,"b":2}')));
  assert.equal(p2, sha256hex(Buffer.from('{"b":2,"a":1}')));
});

test('prefixSha256 null when no reusable prefix (structural<=0)', () => {
  const cur = mkCall([{ bytes: 'X' }]);
  assert.equal(prefixSha256(cur, 0), null);
});

// (c) volatile billing-nonce: bytes change every call but there is NO structural divergence, and the
//     nonce is EXCLUDED from prefix_sha256.
test('(c) volatile billing-nonce: wire bytes change, NO structural divergence, excluded from prefix_sha256', () => {
  const prev = mkCall([
    { section: 'system', bytes: 'x-anthropic-billing-header cch=AAA', volatile: true },
    { section: 'system', bytes: 'You are Claude Code' },
    { section: 'messages', bytes: 'turn-1' },
  ]);
  const cur = mkCall([
    { section: 'system', bytes: 'x-anthropic-billing-header cch=BBB', volatile: true },
    { section: 'system', bytes: 'You are Claude Code' },
    { section: 'messages', bytes: 'turn-1' },
  ]);
  assert.notEqual(prev[0].content_hash, cur[0].content_hash); // nonce bytes DID change
  const d = divergence(prev, cur);
  assert.equal(d.raw, 0); // the nonce changed first
  assert.equal(d.structural, 3); // …but volatile → no structural break in the shared region
  assert.equal(clsf(prev, cur).cause, 'volatile-nonce-only');
  // prefix_sha256 hashes only the two NON-volatile prefix blocks
  const ps = prefixSha256(cur, d.structural);
  assert.equal(ps, sha256hex(Buffer.concat([Buffer.from('You are Claude Code'), Buffer.from('turn-1')])));
});

// ── Task 5 / (d)(e): groundTruthFlag — follows RFC 3.3 L71, only ever SUSPECTS the provider ──
test('(d) groundTruthFlag follows RFC L71: read>0→null, read=0&write>0→ttl-rebuild, read=0&write=0→provider-contradiction', () => {
  assert.equal(groundTruthFlag(3, false, 300, 0), null); // prefix genuinely reused
  assert.equal(groundTruthFlag(3, false, 0, 120), 'ttl-rebuild'); // TTL expired, re-cached (not a contradiction)
  assert.equal(groundTruthFlag(3, false, 0, 0), 'provider-contradiction'); // reusable prefix neither read nor written
});

test('(d) groundTruthFlag: cache_write=NULL (no-write provider) → provider-contradiction per RFC L71 (NOT null)', () => {
  assert.equal(groundTruthFlag(3, false, 0, null), 'provider-contradiction');
});

test('(e) groundTruthFlag: prefix truly reused (read>0) → NULL, no false-positive contradiction', () => {
  assert.equal(groundTruthFlag(5, false, 5000, 0), null);
});

test('groundTruthFlag: no reusable prefix (first call / structural<=0) → null', () => {
  assert.equal(groundTruthFlag(0, false, 0, 0), null);
  assert.equal(groundTruthFlag(0, true, 0, null), null);
});

// ── break_kind (per-call prefix mechanism, Phase-1 CC) ──────────────────────────
test('breakKind: whole-recompute when no reusable prefix; explicit-breakpoint when cc in prefix; else automatic-prefix', () => {
  const noCc = mkCall([{ bytes: 'A' }, { bytes: 'B' }, { bytes: 'C' }]);
  const withCc = mkCall([{ bytes: 'A', cc: { type: 'ephemeral' } }, { bytes: 'B' }, { bytes: 'C' }]);
  assert.equal(breakKind(noCc, 0), 'whole-recompute');
  assert.equal(breakKind(withCc, 2), 'explicit-breakpoint');
  assert.equal(breakKind(noCc, 2), 'automatic-prefix');
});

// ── Task 6: deriveCacheEvents assembles the full row ────────────────────────────
test('deriveCacheEvents assembles a full Anthropic cache_events row (append turn)', () => {
  const prev = mkCall([
    { section: 'tools', bytes: '{"name":"Read"}', cc: { type: 'ephemeral' } },
    { section: 'system', bytes: 'SYS' },
    { section: 'messages', bytes: 'turn-1' },
  ]);
  const cur = mkCall([
    { section: 'tools', bytes: '{"name":"Read"}', cc: { type: 'ephemeral' } },
    { section: 'system', bytes: 'SYS' },
    { section: 'messages', bytes: 'turn-1' },
    { section: 'messages', bytes: 'turn-2' }, // appended
  ]);
  const row = deriveCacheEvents(
    prev,
    cur,
    { cache_read: 3000, cache_write: 0, total_input: 3000 },
    { call_id: 'call_2', provider: 'anthropic', compaction: false },
  );
  assert.equal(row.call_id, 'call_2');
  assert.equal(row.break_kind, 'explicit-breakpoint'); // cache_control sits in the reusable prefix
  assert.equal(row.cache_write_billing, 'charged');
  assert.equal(row.hit_ratio, 1);
  assert.deepEqual(row.declared_breakpoints, [0]);
  assert.equal(row.structural_divergence_seq, 3);
  assert.equal(row.raw_divergence_seq, 3);
  assert.equal(row.divergence_cause, 'append');
  assert.equal(row.divergence_byte_offset, null);
  assert.equal(typeof row.prefix_sha256, 'string');
  assert.equal(row.prefix_sha256.length, 64);
  assert.equal(row.ground_truth_flag, null);
  assert.equal(row.extra.structural_estimate, true);
  // prefix_sha256 = REAL bytes of the non-volatile reusable prefix [0,3)
  const expect = sha256hex(Buffer.concat([Buffer.from('{"name":"Read"}'), Buffer.from('SYS'), Buffer.from('turn-1')]));
  assert.equal(row.prefix_sha256, expect);
});

test('deriveCacheEvents: first in-lane call → cause=unknown + extra.first_call, break_kind=static provider label + prefix_mechanism=whole-recompute, null prefix/offset/ground_truth', () => {
  const cur = mkCall([{ section: 'system', bytes: 'SYS' }]);
  const row = deriveCacheEvents(
    null,
    cur,
    { cache_read: 0, cache_write: 100, total_input: 100 },
    { call_id: 'call_1', provider: 'anthropic' },
  );
  // RFC 3.3 taxonomy has no 'first-call' value → catch-all 'unknown' + extra.first_call (not an invented code)
  assert.equal(row.divergence_cause, 'unknown');
  assert.equal(row.extra.first_call, true);
  assert.equal(row.structural_divergence_seq, 0);
  // break_kind = static provider design (3.2 enum), NOT the per-call outcome
  assert.equal(row.break_kind, 'explicit-breakpoint');
  // the whole-recompute per-call mechanism lives in extra (diagnostic, off the enum column)
  assert.equal(row.extra.prefix_mechanism, 'whole-recompute');
  assert.equal(row.prefix_sha256, null);
  assert.equal(row.divergence_byte_offset, null);
  assert.equal(row.ground_truth_flag, null);
});

test('deriveCacheEvents (f): compaction opt → divergence_cause=compaction (byte offset still localized)', () => {
  const prev = mkCall([{ bytes: 'hello world' }]);
  const cur = mkCall([{ bytes: 'hello there' }]);
  const row = deriveCacheEvents(
    prev,
    cur,
    { cache_read: 0, cache_write: 100, total_input: 100 },
    { compaction: true, provider: 'anthropic' },
  );
  assert.equal(row.divergence_cause, 'compaction');
  assert.equal(row.divergence_byte_offset, 6);
});

// ── Task 7 / (e): real CC-capture regression ────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'cc-session-real.ndjson');

// FIXTURE BUILDER (not the product adapter): the frozen capture is a v0 trace using OLD envelope
// names (request/response) with an already-parsed request object, so parseBlocks (which needs the
// D10 verbatim req_body string) does not apply. Flatten each record into BlockRow[] in adapter
// assembly order tools→system→messages, hashing the per-block bytes with the REAL D19 contentHash
// and setting text = those same bytes. deriveCacheEvents never touches the envelope — only BlockRow[].
function flattenReal(rec) {
  const req = rec.request;
  const rows = [];
  let seq = 0;
  const push = (section, obj, volatile, cc) => {
    const text = JSON.stringify(obj);
    rows.push({ seq: seq++, content_hash: contentHash(text), section, volatile: !!volatile, cache_control: cc || null, text });
  };
  for (const t of req.tools || []) push('tools', t, false, t.cache_control);
  for (const b of req.system || []) push('system', b, /^x-anthropic-billing-header/.test(b.text || ''), b.cache_control);
  for (const m of req.messages || []) {
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const b of content) push('messages', b, false, b && b.cache_control);
  }
  return rows;
}
// approximate the MAIN lane (real lane grouping = 3.4/4.2): opus model, not subagent, not monitor,
// >2 messages. Prevents lane-mixing from fabricating a false structural prefix.
const sysTextOf = (r) => (r.request?.system || []).map((b) => b.text || '').join('\n');
const isMainLane = (r) =>
  /opus/i.test(r.request.model || '') &&
  r.request.messages.length > 2 &&
  !/cc_is_subagent=true/.test(sysTextOf(r)) &&
  !/you are a security monitor/i.test(sysTextOf(r));

// The frozen real trace is gitignored (OBSERVE policy: captured traffic stays local, never
// redistributed) — so this regression runs where the capture exists and SKIPS on a fresh
// checkout / CI rather than breaking. The synthetic tests above are the committed coverage.
test('real CC capture regression: zero false-positive provider-contradiction + prefix_sha256 byte-exact', {
  skip: existsSync(FIXTURE) ? false : 'real-capture fixture absent (gitignored per OBSERVE policy) — local-only regression',
}, () => {
  const recs = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.is_llm_call && r.request && Array.isArray(r.request.messages) && r.request.messages.length)
    .filter(isMainLane);
  assert.ok(recs.length >= 20, `expected a real main-lane run, got ${recs.length}`);

  let prevBlocks = null;
  let contradictions = 0;
  let ttlRebuilds = 0;
  let prefixChecked = false;
  for (const rec of recs) {
    const curBlocks = flattenReal(rec);
    // canonical usage via the real 3.2 mapping (cache_write is a NUMBER for CC, never null → no
    // spurious provider-contradiction from a missing write field).
    const usage = mapUsage('cc', rec.response?.usage || {});
    const row = deriveCacheEvents(prevBlocks, curBlocks, usage, { call_id: rec.id, provider: 'anthropic' });
    if (row.ground_truth_flag === 'provider-contradiction') contradictions++;
    if (row.ground_truth_flag === 'ttl-rebuild') ttlRebuilds++;
    // spot-check prefix_sha256 = REAL source bytes (not hash-of-hashes) on the first call with a prefix
    if (!prefixChecked && row.prefix_sha256 && row.structural_divergence_seq > 0) {
      const prefix = curBlocks.slice(0, row.structural_divergence_seq).filter((b) => !b.volatile);
      const real = sha256hex(Buffer.concat(prefix.map((b) => Buffer.from(b.text))));
      assert.equal(row.prefix_sha256, real, 'prefix_sha256 must equal sha256 of the concatenated verbatim source bytes');
      const hashOfHashes = sha256hex(Buffer.from(prefix.map((b) => b.content_hash).join('')));
      assert.notEqual(row.prefix_sha256, hashOfHashes, 'prefix_sha256 must NOT be a hash-of-content_hashes proxy');
      prefixChecked = true;
    }
    prevBlocks = curBlocks;
  }
  assert.equal(contradictions, 0, 'real capture MUST NOT emit false-positive provider-contradiction');
  assert.ok(prefixChecked, 'expected at least one call with a reusable prefix to byte-verify');
  assert.ok(ttlRebuilds >= 0); // ttl-rebuild is a legitimate non-null flag, not a false positive
});
