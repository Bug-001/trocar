import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeOps, applyOps, pickPredecessor, countCopies, CHAIN_MAX, MAX_HUNKS } from '../../src/raw/delta.mjs';

// D35 record encoding (4.2 §原始层封存): a delta is COPY(offset,len) / INSERT(bytes) against the
// predecessor's LINE BYTES. These tests pin the byte contract only: whatever ops the heuristic picks,
// decoding MUST give back the exact line, because the sealed file is the source truth (invariant 2).

// Deterministic pseudo-random text (no Math.random: a failure must reproduce).
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function words(r, n) {
  const W = ['alpha', 'beta', 'gamma', 'delta', 'file', 'read', 'tool_use', 'result', 'the', 'repo', '{"a":1}', '\\n', 'é', '中文'];
  let s = ''; for (let i = 0; i < n; i++) s += W[Math.floor(r() * W.length)] + ' ';
  return s;
}
const env = (ts, id, body, resp) => Buffer.from(
  JSON.stringify({ ts, endpoint: '/v1/messages', method: 'POST', req_headers: { 'x-claude-code-session-id': 'S1' }, req_body: body, resp, id }) + '\n');

const roundTrip = (a, b) => {
  const ops = encodeOps(a, b);
  const back = applyOps(a, ops);
  assert.ok(back.equals(b), 'decoded line differs from the original line');
  return ops;
};

test('ops round-trip exactly for identical, empty, unrelated and edited lines', () => {
  const r = rng(7);
  const a = Buffer.from(words(r, 4000));
  roundTrip(a, a);
  roundTrip(a, Buffer.alloc(0));
  roundTrip(Buffer.alloc(0), a);
  roundTrip(a, Buffer.from(words(rng(99), 3000)));          // unrelated
  for (let k = 0; k < 40; k++) {                              // random splices: insert / delete / replace
    const at = Math.floor(r() * a.length), del = Math.floor(r() * 300), ins = Buffer.from(words(r, Math.floor(r() * 50)));
    const b = Buffer.concat([a.subarray(0, at), ins, a.subarray(Math.min(a.length, at + del))]);
    roundTrip(a, b);
  }
});

test('an appended conversation turn costs a small fraction of the line', () => {
  const r = rng(3);
  const hist = words(r, 20000);
  const a = env('2026-10-06T00:00:01.000Z', 'req_1', JSON.stringify({ system: [{ text: 'sys v1 ' + words(r, 30) }], messages: [hist] }), { text: words(r, 40) });
  const b = env('2026-10-06T00:00:09.000Z', 'req_2', JSON.stringify({ system: [{ text: 'sys v2 ' + words(r, 30) }], messages: [hist, words(r, 300)] }), { text: words(r, 40) });
  const ops = roundTrip(a, b);
  assert.ok(ops.length < 0.25 * b.length, `delta ${ops.length} B is not small against a ${b.length} B line`);
  assert.ok(countCopies(ops) <= MAX_HUNKS + 1, `copies ${countCopies(ops)} exceed the hunk bound`);
});

test('scattered edits are merged down to at most 8 hunks and still round-trip', () => {
  const r = rng(11);
  const a = Buffer.from(words(r, 30000));
  let b = a;
  for (let k = 0; k < 30; k++) {                              // 30 separated edits → must collapse to ≤ 8
    const at = Math.floor((k + 0.5) * b.length / 30);
    b = Buffer.concat([b.subarray(0, at), Buffer.from(`<edit ${k}>`), b.subarray(at + 5)]);
  }
  const ops = roundTrip(a, b);
  assert.ok(countCopies(ops) <= MAX_HUNKS + 1, `${countCopies(ops)} copy runs; the encoder must merge to ≤ ${MAX_HUNKS} hunks`);
});

test('applyOps refuses a COPY that reaches past the predecessor', () => {
  const a = Buffer.from('x'.repeat(100));
  const ops = encodeOps(a, Buffer.from('x'.repeat(100)));
  assert.throws(() => applyOps(Buffer.from('x'.repeat(10)), ops), /out of range|corrupt/i);
});

test('the predecessor is the candidate sharing the longest request-body prefix, not the newest', () => {
  const r = rng(5);
  const histA = words(r, 3000), histB = words(r, 3000);
  const mk = (i, hist) => ({ idx: i, depth: 0, line: env(`2026-10-06T00:00:0${i}.000Z`, `req_${i}`, JSON.stringify({ messages: [hist] }), { i }) });
  const ring = [mk(0, histA), mk(1, histB), mk(2, histB + 'x')];
  const cur = env('2026-10-06T00:00:09.000Z', 'req_9', JSON.stringify({ messages: [histA + ' more'] }), {});
  assert.equal(pickPredecessor(ring, cur).idx, 0, 'whole-line LCP is ~20 bytes (ts differs); the body prefix must decide');
});

test('candidates already at the chain limit are never chosen', () => {
  const line = env('t', 'a', 'same body', {});
  const ring = [{ idx: 0, depth: 0, line }, { idx: 1, depth: CHAIN_MAX, line }];
  assert.equal(pickPredecessor(ring, line).idx, 0, `a depth-${CHAIN_MAX} predecessor would make a ${CHAIN_MAX + 1}-step chain`);
});
