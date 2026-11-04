// Byte-coordinate edits (spec 5.1 §记录与标注). Expected offsets in the fixtures are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  spansToSteps, applySteps, invertSteps, recordEdits, applyEdits,
  editsCost, editsLimit, serializeEdits, recoverOf,
} from '../../src/rules/edits.mjs';

const MIB = 1024 * 1024;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const buf = (s) => Buffer.from(s, 'utf8');

test('a character before the span counts its UTF-8 bytes, not its string index', () => {
  const cases = [
    // [text, span, at, del]
    ['中文ALPHA', { start: 2, end: 7, ins: 'x' }, 6, 5],
    ['😀ALPHA', { start: 2, end: 7, ins: 'x' }, 4, 5],
    ['é中😀ALPHA', { start: 4, end: 9, ins: 'x' }, 9, 5],
    ['ALPHA', { start: 0, end: 5, ins: 'x' }, 0, 5],
    ['a中😀b', { start: 1, end: 4, ins: 'x' }, 1, 7],
  ];
  for (const [text, span, at, del] of cases) {
    const [step] = spansToSteps(text, [span]);
    assert.deepEqual(step, { at, del, ins: 'x', old: text.slice(span.start, span.end) });
  }
});

test('each step is relative to the state the steps before it left', () => {
  // 中 3 + ALPHA 5 + 文 3 + 😀 4 = byte 15 in the original; β replaced 5 bytes with 2, so 12.
  const text = '中ALPHA文😀ALPHA';
  const steps = spansToSteps(text, [{ start: 1, end: 6, ins: 'β' }, { start: 9, end: 14, ins: 'β' }]);
  assert.deepEqual(steps.map((s) => [s.at, s.del]), [[3, 5], [12, 5]]);
  assert.deepEqual(applySteps(buf(text), steps), buf('中β文😀β'));
});

test('offset moves every step by that many bytes', () => {
  const steps = spansToSteps('中文ALPHA', [{ start: 2, end: 7, ins: 'x' }], 100);
  assert.equal(steps[0].at, 106);
  assert.deepEqual(applySteps(Buffer.concat([Buffer.alloc(100, 0xff), buf('中文ALPHA')]), steps),
    Buffer.concat([Buffer.alloc(100, 0xff), buf('中文x')]));
});

test('the record runs from the wire bytes to the agent bytes', () => {
  const steps = spansToSteps('中文ALPHA文ALPHA', [{ start: 2, end: 7, ins: '中' }, { start: 8, end: 13, ins: '中' }]);
  assert.deepEqual(recordEdits('response', steps), [
    { at: 6, del: 5, ins: '中' },
    { at: 12, del: 5, ins: '中' },
  ]);
  const back = [{ at: 12, del: 3, ins: 'ALPHA' }, { at: 6, del: 3, ins: 'ALPHA' }];
  assert.deepEqual(recordEdits('request', steps), back);
  assert.deepEqual(recordEdits('ws-client', steps), back);
  assert.deepEqual(recordEdits('ws-server', steps), recordEdits('response', steps));
});

// Deterministic generator: axes are the alphabet and the shape of the spans.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
}
const ALPHABETS = {
  ascii: ['a', 'b', 'Z', '0', ' ', '"', '\n'],
  cjk: ['中', '文', '字', '節', '한'],
  emoji: ['😀', '🚀', '👍🏽', '🏳️‍🌈'],
  mixed: ['a', 'é', '中', '😀', '\\', '\u0000', ' '],
};
const INSERTS = ['', 'x', '中', '😀', 'longer than most spans', '中文😀 mixed\n'];

// Whole characters, so a span never lands inside a surrogate pair.
function chars(r, alphabet, n) {
  return Array.from({ length: n }, () => alphabet[r(alphabet.length)]);
}
function spansFor(shape, r, parts) {
  const at = parts.reduce((acc, p) => { acc.push(acc.at(-1) + p.length); return acc; }, [0]);
  const n = parts.length;
  const ins = () => INSERTS[r(INSERTS.length)];
  const span = (i, j) => ({ start: at[i], end: at[j], ins: ins() });
  switch (shape) {
    case 'none': return [];
    case 'start': return [span(0, 1 + r(n))];
    case 'end': return [span(n - 1 - r(n), n)];
    case 'whole': return [span(0, n)];
    case 'insert-only': return [span(0, 0), span(n >> 1, n >> 1), span(n, n)];
    case 'adjacent': { // every span starts where the last one ended
      const out = [];
      for (let i = 0; i < n; i += 2) out.push(span(i, Math.min(i + 2, n)));
      return out;
    }
    default: { // scattered
      const out = [];
      for (let i = r(3); i < n; i += 1 + r(4)) {
        const j = Math.min(n, i + r(3));
        out.push(span(i, j));
        i = j;
      }
      return out;
    }
  }
}
function splice(text, spans) {
  let out = '', pos = 0;
  for (const s of spans) { out += text.slice(pos, s.start) + s.ins; pos = s.end; }
  return out + text.slice(pos);
}
function* variants() {
  const shapes = ['none', 'start', 'end', 'whole', 'insert-only', 'adjacent', 'scattered'];
  for (const [name, alphabet] of Object.entries(ALPHABETS)) {
    for (const shape of shapes) {
      for (let seed = 1; seed <= 30; seed++) {
        const r = rng(seed * 2654435761);
        const parts = chars(r, alphabet, 1 + r(40));
        const text = parts.join('');
        const spans = spansFor(shape, r, parts);
        yield { label: `${name}/${shape}/${seed}`, r, alphabet, text, spans };
      }
    }
  }
}

test('steps turn a into b, inverted steps turn b into a, and the record goes the way each side needs', () => {
  for (const { label, text, spans } of variants()) {
    const a = buf(text);
    const b = buf(splice(text, spans));
    const steps = spansToSteps(text, spans);
    assert.deepEqual(applySteps(a, steps), b, label);
    assert.deepEqual(applySteps(b, invertSteps(steps)), a, label);
    assert.deepEqual(applyEdits(b, recordEdits('request', steps)), a, label);
    assert.deepEqual(applyEdits(a, recordEdits('response', steps)), b, label);
  }
});

test('rules applied one after another chain into one list that still inverts', () => {
  for (const { label, r, alphabet, text, spans } of variants()) {
    const mid = splice(text, spans);
    const parts = [...mid]; // code points: every boundary is a safe one
    const second = spansFor('scattered', r, parts.length ? parts : chars(r, alphabet, 1));
    const end = splice(mid, parts.length ? second : []);
    const steps = [...spansToSteps(text, spans), ...spansToSteps(mid, parts.length ? second : [])];
    assert.deepEqual(applySteps(buf(text), steps), buf(end), label);
    assert.deepEqual(applyEdits(buf(end), recordEdits('request', steps)), buf(text), label);
  }
});

test('applying does not touch the input', () => {
  const a = buf('中文ALPHA');
  const before = Buffer.from(a);
  applySteps(a, spansToSteps('中文ALPHA', [{ start: 0, end: 7, ins: '' }]));
  assert.deepEqual(a, before);
});

test('edits apply on bytes that are not text', () => {
  const a = Buffer.from([0xff, 0x41, 0xfe]);
  assert.deepEqual(applyEdits(a, [{ at: 1, del: 1, ins: '中' }]), Buffer.from([0xff, 0xe4, 0xb8, 0xad, 0xfe]));
});

test('an edit costs the bytes of its insert plus 32', () => {
  assert.equal(editsCost([]), 0);
  assert.equal(editsCost([{ at: 0, del: 1, ins: '' }, { at: 9, del: 0, ins: '中😀' }]), 32 + 7 + 32);
});

test('the limit is the unit size, held between 1 MiB and 8 MiB', () => {
  const cases = [[0, MIB], [MIB - 1, MIB], [MIB, MIB], [MIB + 1, MIB + 1], [8 * MIB, 8 * MIB], [8 * MIB + 1, 8 * MIB], [64 * MIB, 8 * MIB]];
  for (const [unit, limit] of cases) assert.equal(editsLimit(unit), limit);
});

test('serialized edits go between brackets as JSON and stay on one line', () => {
  assert.equal(serializeEdits([]).length, 0);
  for (const edits of [
    [{ at: 0, del: 1, ins: 'a' }],
    [{ at: 3, del: 0, ins: '中\n😀"\\' }, { at: 9, del: 2, ins: '' }],
  ]) {
    const bytes = serializeEdits(edits);
    assert.equal(bytes[0], 0x7b);
    assert.equal(bytes.at(-1), 0x7d);
    assert.equal(bytes.indexOf(0x0a), -1);
    assert.deepEqual(JSON.parse(`[${bytes}]`), edits);
  }
});

const BODY = '中文'.repeat(100);
const small = [{ at: 0, del: 3, ins: '中' }];
const wire = buf(`文${BODY.slice(1)}`);
const agent = buf(BODY);

test('a patch smaller than the body is recorded as a patch', () => {
  assert.deepEqual(recoverOf({ wire, agent, edits: small, compressed: false }), {
    recover: 'patch', edits: small, base_sha256: sha(wire), result_sha256: sha(agent),
  });
});

function assertInline(got, w, a) {
  assert.equal(got.recover, 'inline');
  assert.equal('edits' in got, false);
  assert.deepEqual(Buffer.from(got.body_b64, 'base64'), a);
  assert.equal(got.base_sha256, sha(w));
  assert.equal(got.result_sha256, sha(a));
}

test('a patch bigger than the whole body goes inline', () => {
  const w = buf('x');
  const a = buf('y');
  assertInline(recoverOf({ wire: w, agent: a, edits: [{ at: 0, del: 1, ins: 'y' }], compressed: false }), w, a);
});

test('a compressed body goes inline however small the patch', () => {
  assertInline(recoverOf({ wire, agent, edits: small, compressed: true }), wire, agent);
});

test('bytes to recover that are not UTF-8 go inline', () => {
  const a = Buffer.concat([agent, Buffer.from([0xff])]);
  const w = Buffer.concat([wire, Buffer.from([0xff])]);
  assertInline(recoverOf({ wire: w, agent: a, edits: small, compressed: false }), w, a);
});
