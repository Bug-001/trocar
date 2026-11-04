// applyRules: the one entry of rules test, the live path and resend (spec 5.1 §规则「多条规则都命中时」, §分派, §记录与标注). tier 1 runs on the real
// compiled rules, tier 2 on the real rule-process half, so a disagreement between the two is a red test here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { applyRules } from '../../src/rules/apply.mjs';
import { full } from '../../src/rules/actions.mjs';
import { compileRules } from '../../src/rules/compile.mjs';
import { byteBudget, UNIT_BYTES } from '../../src/rules/budget.mjs';
import { applyEdits } from '../../src/rules/edits.mjs';

const KIB = 1024, MIB = 1024 * KIB;
const rule = (name, actions, { match = {}, ...more } = {}) => ({ name, on_error: 'forward', do: [].concat(actions), match: { harness: 'any', ...match }, ...more });
const rules = (...list) => compileRules({ rules: list }).rules;
const unitOf = (body, more = {}) => ({
  on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm', status: null, event_index: null,
  headers: [['content-type', 'application/json']], req_headers: [], encoding: null, body: body === null ? null : Buffer.from(body), ...more,
});
const lit = (replace, to, more = {}) => ({ replace, with: to, literal: true, ...more });
const tier1 = (unit, compiled, budget = byteBudget()) => applyRules(unit, compiled, { tier: 1, budget });
const tier2 = (unit, compiled, more = {}) => applyRules(unit, compiled, { tier: 2, full, ...more });
const text = (result) => result.bytes.toString();
const names = (skipped) => skipped.map(({ rule: name, why }) => [name, why]);
const seeded = (seed) => (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };

// Everything a caller reads except the times, which are the only field two runs may differ in.
const outcome = ({ rule_ms, survivors, escalate, skipped, ...rest }) => ({ ...rest, skipped: names(skipped) });

test('tier 1 never reaches for the rule process, and finishes head-only work with the body unread', async () => {
  const compiled = rules(rule('head', [{ header: 'x-a', set: '1' }, { delay_ms: 10 }]));
  const result = await applyRules(unitOf(null), compiled, { tier: 1, budget: byteBudget(), full: new Proxy({}, { get() { throw new Error('tier 1 touched full'); } }) });
  assert.equal(result.escalate, false);
  assert.deepEqual(result.headers, [['content-type', 'application/json'], ['x-a', '1']]);
  assert.equal(result.bytes, null);
  assert.equal(result.delay_ms, 10);
  assert.deepEqual(result.hits, ['head']);
});

test('hits are the rules that matched: a miss is neither a hit nor a change', async () => {
  const compiled = rules(rule('miss', { drop: true }, { match: { path: '/other' } }), rule('body-miss', { drop: true }, { match: { body: 'BRAVO' } }), rule('hit', { delay_ms: 5 }));
  for (const run of [tier1, tier2]) {
    const result = await run(unitOf('{"a":"ALPHA"}'), compiled);
    assert.deepEqual([result.hits, result.verdict, result.bytes, result.headers, result.delay_ms], [['hit'], 'forward', null, null, 5]);
    assert.deepEqual(Object.keys(result.rule_ms).sort(), ['body-miss', 'hit', 'miss']);
  }
});

test('order: drop before reply before hold, all of them over the changed bytes', async () => {
  const edit = rule('edit', lit('ALPHA', 'BRAVO', { in: 'body' }));
  const drop = rule('d', { drop: true }), reply = rule('r', { reply: { status: 429, body: 'no' } }), hold = rule('h', { hold: true, release_after_ms: 60000 });
  for (const run of [tier1, tier2]) {
    for (const [list, verdict] of [[[hold, reply, drop], 'drop'], [[hold, reply], 'reply'], [[hold], 'hold'], [[], 'forward']]) {
      const result = await run(unitOf('{"a":"ALPHA"}'), rules(...list, edit));
      assert.equal(result.verdict, verdict);
      assert.equal(text(result), '{"a":"BRAVO"}');
      assert.deepEqual(result.reply, verdict === 'reply' ? { status: 429, body: 'no' } : null);
      assert.equal(result.hold_ms, verdict === 'hold' ? 60000 : null);
    }
  }
});

test('order: every match reads the arrival bytes, and edits run in file order on the result before them', async () => {
  const compiled = rules(
    rule('a', lit('X', 'Y', { in: 'body' })),
    rule('b', { delay_ms: 7 }, { match: { body: 'Y' } }), // Y exists only after a
    rule('c', { delay_ms: 9 }, { match: { body: 'X' } }), // X is gone after a
    rule('d', lit('Y', 'Z', { in: 'body' })),
  );
  for (const run of [tier1, tier2]) {
    const result = await run(unitOf('{"v":"X"}'), compiled);
    assert.deepEqual(result.hits, ['a', 'c', 'd']);
    assert.equal(result.delay_ms, 9);
    assert.equal(text(result), '{"v":"Z"}');
    assert.deepEqual(applyEdits(result.bytes, result.edits), Buffer.from('{"v":"X"}'));
  }
});

test('order: delays add up to the 60 s ceiling, injects stay in file order', async () => {
  const compiled = rules(rule('a', [{ delay_ms: 40000 }, { inject: 'one' }]), rule('b', [{ delay_ms: 40000 }, { inject: 'two' }]));
  for (const run of [tier1, tier2]) {
    const result = await run(unitOf('x', { on: 'response' }), compiled);
    assert.equal(result.delay_ms, 60000);
    assert.deepEqual(result.inject, ['one', 'two']);
  }
});

test('would: what rules test cannot do is reported per rule, and reply names its status', async () => {
  const result = await tier2(unitOf('x'), rules(rule('r', { reply: { status: 429 } }), rule('d', [{ delay_ms: 5 }, { drop: true }]), rule('s', { script: '/abs/s.mjs' })));
  assert.ok(result.would.some((w) => w.rule === 'r' && w.text === 'reply 429'));
  assert.deepEqual(result.would.map((w) => w.rule), ['r', 'd', 'd', 's']);
  assert.equal(result.bytes, null);
});

