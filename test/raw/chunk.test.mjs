import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutPoints } from '../../src/raw/chunk.mjs';

// 4.2 §封存格式 · 编码器: cutPoints(line) is a pure function of the line bytes; the cut points only steer
// compression, never correctness. The contract pinned here: integers, first 0, last = length, strictly
// increasing, deterministic, input untouched, and the pieces splice back to the exact line — for any
// bytes at all (valid JSON, broken JSON, deep nesting, non-UTF-8). Cut positions and counts are free.

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

function gen(r) {
  const int = (n) => Math.floor(r() * n);
  const pick = (a) => a[int(a.length)];
  const PIECES = ['a', 'word ', '"', '\\', '\n', 'é', '😀', '{', '[', ' ', '\\u00', '\r'];
  const str = (n) => { let s = ''; while (s.length < n) s += pick(PIECES); return s; };
  const value = (d) => {
    const k = d > 4 ? int(3) : int(6);
    if (k === 0) return str(int(80));
    if (k === 1) return r() * 1e6 - 5e5;
    if (k === 2) return pick([true, false, null]);
    if (k === 3) return Array.from({ length: int(12) }, () => value(d + 1));
    if (k === 4) return JSON.stringify(value(d + 1)); // a string whose content is JSON
    const o = {}; for (let i = int(10); i > 0; i--) o[str(1 + int(8))] = value(d + 1); return o;
  };
  const sized = (target) => { const a = []; let s = '[]'; while (s.length < target) { a.push(str(1 + int(40))); s = JSON.stringify(a); } return s; };
  const big = (n) => (r() < 0.5 ? str(n) : Buffer.from(Array.from({ length: n * 3 / 4 | 0 }, () => int(256))).toString('base64'));
  const deep = (n) => (r() < 0.5 ? '['.repeat(n) + ']'.repeat(n) : '{"k":'.repeat(n) + '1' + '}'.repeat(n));
  const envelope = () => JSON.stringify({ ts: int(1e9), endpoint: '/x', req_body: JSON.stringify({ items: Array.from({ length: 40 + int(80) }, () => value(3)) }), resp: value(0), id: int(1e6) });
  const valid = () => pick([
    () => JSON.stringify(value(0)),
    envelope,
    () => sized(1024 - 40 + int(80)),
    () => JSON.stringify({ a: sized(1000 + int(60)), b: [sized(1000 + int(60))] }),
    () => JSON.stringify({ s: big(65536 + int(4096)) }),
    () => JSON.stringify({ s: JSON.stringify({ t: big(65536) }) }),
    () => deep(10000 + int(100)),
    () => JSON.stringify({ s: deep(10000) }),
  ])();
  const k = int(9);
  if (k === 0) return Buffer.from(int(2) ? '' : '\n');
  if (k === 1) return Buffer.from(Array.from({ length: int(70000) }, () => int(256))); // non-UTF-8 bytes
  let s = valid();
  if (k === 2) s = s.slice(0, int(s.length + 1)); // cut at a random point
  if (k === 3) s += pick(['\\', '\\u12', '"\\', '{"a":"\\u', ']]]', '{{{', '"']); // broken tail
  if (k === 4) s = pick(['{', '[', '"', '}']) + s; // unbalanced head
  if (k === 5) s += '\r\n';
  if (k === 6) s += '\n';
  const b = Buffer.from(s);
  return k === 7 // byte-level cut (may split UTF-8)
     ? b.subarray(0, int(b.length + 1)) : b;
}

test('cut points tile any line exactly, deterministically, without touching the bytes', () => {
  for (const seed of [1, 2, 3, 0xdecaf, 20261024]) {
    const r = rng(seed);
    for (let n = 0; n < 80; n++) {
      const line = gen(r);
      const copy = Buffer.from(line);
      const c = cutPoints(line);
      assert.ok(Array.isArray(c) && c.every(Number.isInteger), 'an array of integers');
      assert.equal(c[0], 0);
      assert.equal(c[c.length - 1], line.length);
      for (let i = 1; i < c.length; i++) assert.ok(c[i] > c[i - 1], 'strictly increasing');
      assert.deepEqual(cutPoints(line), c, 'deterministic');
      assert.ok(line.equals(copy), 'input unchanged');
      const pieces = []; for (let i = 0; i + 1 < c.length; i++) pieces.push(line.subarray(c[i], c[i + 1]));
      assert.ok(Buffer.concat(pieces).equals(line), 'pieces splice back to the line');
    }
  }
});
