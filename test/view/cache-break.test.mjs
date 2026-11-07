// test/view/cache-break.test.mjs — RFC 3.3 §分叉成因分类 / §地面真相验证: every cause is decided in cacheBreak from the two block
// sequences and the hints (compaction verdict, model or vendor change, cache read), each with the attribution the cause table gives;
// the ground truth a byte-identical prefix earns follows usage, and a reported-zero write proves a contradiction only on a vendor
// whose cache semantics are known; a model switch starts a new cache and so carries no ground truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheBreak } from '../../src/view/analyze.mjs';
import { realGroundTruth } from '../../src/view/reduce.mjs';
import { sessionDoc } from '../helpers/session-doc.mjs';

const tool = (name, schema = { type: 'object' }) => ({ key: `t:${name}:${JSON.stringify(schema)}`, sec: 'tools', name, desc: `${name} tool`, schema });
const sys = (text, volatile = false) => ({ key: `s:${text}`, sec: 'system', text, ...(volatile ? { volatile } : null) });
const msg = (block) => ({ key: `m:${JSON.stringify(block)}`, sec: 'messages', block });
const text = (t) => msg({ type: 'text', text: t });
const use = (input) => msg({ type: 'tool_use', id: 'tu_1', name: 'Read', input });

const A = tool('A'), B = tool('B'), S = sys('stable system'), U1 = text('first'), U2 = text('second');
const base = [A, B, S, U1];
const PAIRS = {
  append: [base, [...base, U2]],
  'volatile-nonce-only': [[A, B, sys('nonce=1', true), S, U1], [A, B, sys('nonce=2', true), S, U1]],
  'content-changed': [[A, B, sys('abcXdef'), U1], [A, B, sys('abcYdef'), U1]],
  'tool-array-reorder': [base, [B, A, S, U1]],
  'json-key-reorder': [[A, S, use({ alpha: 1, beta: 2 })], [A, S, use({ beta: 2, alpha: 1 })]],
  'first-message-changed': [[A, S, U1, U2], [A, S, text('rewritten'), U2]],
};
const ATTR = { 'first-call': 'harmless', append: 'harmless', 'volatile-nonce-only': 'provider-excluded', compaction: 'harness',
  'tool-array-reorder': 'yours', 'json-key-reorder': 'yours', 'content-changed': 'review', 'model-or-route-change': 'harness' };
const check = (b, cause) => { assert.equal(b.cause, cause); assert.equal(b.attribution, ATTR[cause]); };

test('first call: nothing cached yet', () => {
  const b = cacheBreak(null, base);
  check(b, 'first-call');
  assert.equal(b.firstCall, true);
});

test('append: the whole previous context is the reused prefix', () => {
  const b = cacheBreak(...PAIRS.append);
  check(b, 'append');
  assert.equal(b.firstCall, false);
  assert.equal(b.byteOffset, null);
});

test('only a volatile system block changed → provider-excluded', () => check(cacheBreak(...PAIRS['volatile-nonce-only']), 'volatile-nonce-only'));

test('a system block changed in place → content-changed, localized to the differing byte', () => {
  const b = cacheBreak(...PAIRS['content-changed']);
  check(b, 'content-changed');
  assert.equal(b.byteOffset, 3);
});

test('same tools in another order → tool-array-reorder', () => check(cacheBreak(...PAIRS['tool-array-reorder']), 'tool-array-reorder'));

test('same tool_use input with its keys reordered → json-key-reorder', () => {
  const b = cacheBreak(...PAIRS['json-key-reorder']);
  check(b, 'json-key-reorder');
  assert.equal(typeof b.byteOffset, 'number');
  assert.ok(b.byteContext.startsWith('beta'), b.byteContext);
});

test('the compaction verdict names a rewrite compaction', () => check(cacheBreak(...PAIRS['content-changed'], { compaction: true }), 'compaction'));

test('a changed first message alone never infers compaction', () => check(cacheBreak(...PAIRS['first-message-changed']), 'content-changed'));

// model or vendor change: it refines only a bare content change or an append that read nothing; compaction and the reorders stand
for (const [pair, opts, plain] of [
  ['content-changed', {}, 'content-changed'],
  ['first-message-changed', {}, 'content-changed'],
  ['append', { read: 0 }, 'append'],
  ['append', { read: 50 }, 'append'],
  ['tool-array-reorder', {}, 'tool-array-reorder'],
  ['json-key-reorder', {}, 'json-key-reorder'],
  ['content-changed', { compaction: true }, 'compaction'],
]) {
  const switched = plain === 'content-changed' || (plain === 'append' && opts.read === 0) ? 'model-or-route-change' : plain;
  test(`model switch over ${pair} ${JSON.stringify(opts)} → ${switched}`, () => {
    check(cacheBreak(...PAIRS[pair], { ...opts }), plain);
    check(cacheBreak(...PAIRS[pair], { ...opts, modelChanged: true }), switched);
    // only the refined append keeps every earlier block: the board draws no change line for it
    assert.equal(cacheBreak(...PAIRS[pair], { ...opts, modelChanged: true }).prefixChanged, plain === 'append' && switched !== plain ? false : undefined);
  });
}

for (const [same, read, create, known, gt] of [
  [true, 0, 0, true, 'provider-contradiction'], [true, 0, 0, false, null], [true, 0, null, true, null],
  [true, 0, 90, true, 'ttl-rebuild'], [true, 0, 90, false, 'ttl-rebuild'], [true, 90, 0, true, null], [false, 0, 0, true, null],
]) {
  test(`realGroundTruth(same=${same}, read=${read}, write=${create}, known=${known}) → ${gt}`, () =>
    assert.equal(realGroundTruth(same, read, create, known), gt));
}

test('a model switch in a session: the new cache carries no ground truth', async () => {
  const mk = (i, model, messages, usage) => ({
    id: `req_${i}`, ts_request: `2026-07-16T00:00:0${i}Z`, endpoint: '/v1/messages', host: 'api.anthropic.com',
    req_headers: { 'x-claude-code-session-id': 's-model', 'user-agent': 'claude-cli/1.2' },
    req_body: JSON.stringify({ model, system: [{ type: 'text', text: 'You are a coding assistant.' }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }], messages }),
    resp: { status: 200, kind: 'json', body: { content: [{ type: 'text', text: 'ok' }], usage } },
  });
  const first = [{ role: 'user', content: 'first question' }];
  const { calls: [c1, c2] } = await sessionDoc([
    mk(1, 'claude-opus-4', first, { input_tokens: 100, output_tokens: 10 }),
    mk(2, 'claude-sonnet-4-5', [...first, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'second question' }],
      { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }),
  ], 's-model');
  assert.equal(c2.cacheBreak.refRid, c1.rid, 'call #2 is compared against call #1');
  assert.equal(c2.cacheBreak.cause, 'model-or-route-change');
  assert.equal(c2.cacheBreak.prefixChanged, false, 'a pure append: no earlier block changed');
  assert.equal(c2.gt ?? null, null);
  assert.equal(c2.cacheBreak.gt ?? null, null);
});
