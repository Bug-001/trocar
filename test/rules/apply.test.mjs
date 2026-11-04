// applyRules: the one entry of rules test, the live path and resend (spec 5.1 §规则「多条规则都命中时」, §分派, §记录与标注). tier 1 runs on the real
// compiled rules, tier 2 on the real rule-process half, so a disagreement between the two is a red test here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { applyRules } from '../../src/rules/apply.mjs';
import { full } from '../../src/rules/actions.mjs';
import { compileRules } from '../../src/rules/compile.mjs';
import { byteBudget, UNIT_BYTES } from '../../src/rules/budget.mjs';
import { tierOfRule } from '../../src/rules/describe.mjs';
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
const seeded = (seed) => (n) => { // mulberry32: the low bits of a plain LCG cycle, and would never reach most pairs of axes
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};

// Everything a caller reads except the times, which are the only field two runs may differ in.
const outcome = ({ rule_ms, survivors, escalate, skipped, ...rest }) => ({ ...rest, skipped: names(skipped) });

test('9, 63: wherever tier 1 finishes, its bytes, edits and every other field are those of tier 2', async () => {
  const strings = ['ALPHA', 'xALPHAy', 'ALPHA ALPHA', '中文ALPHA😀', 'plain', '中文', 'a\\nALPHA', 'q\\"ALPHA', 'b\\\\ALPHA', 'a\\/ALPHA', '\\u0041LPHA', '\\nALPHA', 'nALPHA', 'a\\/ far enough ALPHA', 'a\t far enough ALPHA', 'a\\n far enough ALPHA'];
  const values = (r) => {
    const s = () => strings[r(strings.length)];
    return [`"${s()}"`, `"${s()}"`, `"${s()}"`, '12', '1.0', 'true', 'null', `["${s()}",7]`, `{"in":"${s()}"}`][r(9)];
  };
  const keys = ['a', 'b', 'ALPHA', '备注', 'k\\n'];
  const shapes = [
    (r) => `{${[0, 1, 2].map(() => `"${keys[r(keys.length)]}":${values(r)}`).join([',', ', ', ',\n  '][r(3)])}}`,
    (r) => `[${[0, 1].map(() => values(r)).join(',')}]`,
    (r) => ` \n{"a":${values(r)}} `,
    (r) => `{"a":${values(r)}`, // cut short: tier 2 reads it as plain text
    (r) => `{"a":tru,"b":${values(r)}}`,
    (r) => `"${strings[r(strings.length)]}"`,
    () => 'ALPHA',
    () => 'plain ALPHA text, ALPHA again',
    () => '',
    () => '{"a":"ALPHA","a":"other"}', // a repeated key
    () => '{"a":"\tALPHA"}', // a raw control character
    () => '{"a":"\\q far enough ALPHA"}', // a bad escape: tier 2 reads the body as plain text
    () => '{"a":"\\/ far enough ALPHA"}', // an escape JSON.stringify would not write back
    () => '{"a":"\ufffd"}', // the byte form a lone surrogate takes in a Buffer
    () => Buffer.from([0x7b, 0xff, 0x41, 0x4c, 0x50, 0x48, 0x41]), // not UTF-8
  ];
  const actions = [
    lit('ALPHA', 'BRAVO'), lit('ALPHA', 'A LONGER ONE'), lit('ALPHA', ''), lit('ALPHA', 'ALPHA'), lit('nALPHA', 'x'), lit('中文', 'Z', { in: 'body' }),
    lit('ALPHA', 'B"\\\n中', { in: 'body' }), lit('ALPHA', 'B"'), lit('中文', 'Z'), lit('😀', 'smile', { in: 'body' }), lit('\ud800', 'Z', { in: 'body' }),
    { header: 'x-note', set: 'on' }, { header: 'content-type', remove: true }, { delay_ms: 1500 }, { inject: 'data: x\n\n' }, { json: '/a', set: 1 },
  ];
  const r = seeded(9);
  const finished = new Set();
  for (let round = 0; round < 1500; round++) {
    const body = shapes[r(shapes.length)](r);
    const list = Array.from({ length: 1 + r(3) }, (_, i) => rule(`r${i}`, [actions[r(actions.length)], actions[r(actions.length)]]));
    const on = ['request', 'response'][r(2)];
    const unit = unitOf(body, { on, sse: on === 'response' && r(2) === 0 });
    const compiled = rules(...list);
    const first = await tier1(unit, compiled);
    if (first.escalate) continue;
    const second = await tier2(unit, compiled);
    assert.deepEqual(outcome(first), outcome(second), `${body} ${JSON.stringify(list)}`);
    if (first.bytes) finished.add(list.flatMap((r) => r.do).find((a) => a.replace)?.in ?? 'text');
  }
  assert.ok(finished.has('body'), 'tier 1 finished edits');
});

test('9, 63: bytes tier 2 refuses get the same answer at any size: a body or a replace on them is never settled by the search', async () => {
  const notText = Buffer.concat([Buffer.from('{"a":"ALPHA"}'), Buffer.from([0xff])]);
  const bodies = [
    [notText, {}], [Buffer.from([0xff, 0x41]), {}],
    ['data: ALPHA\ndata: two\n\n', { on: 'response', sse: true }], ['data: one\ndata: two\n\n', { on: 'response', sse: true }],
    ['data: ALPHA\r\ndata: two\r\n\r\n', { on: 'response', sse: true }],
  ];
  const conditions = [{ body: 'ALPHA' }, { body: { not: 'ALPHA' } }, { body: 'ABSENT' }];
  const actions = [{ drop: true }, { delay_ms: 5 }, { header: 'x-a', set: '1' }];
  const replaces = [lit('ALPHA', 'BRAVO', { in: 'body' }), lit('ABSENT', 'BRAVO', { in: 'body' }), lit('ALPHA', 'BRAVO')];
  const lists = [
    ...conditions.flatMap((match) => actions.map((action) => rule('r', action, { match }))),
    ...replaces.map((action) => rule('r', action)),
  ].flatMap((one) => ['forward', 'drop'].map((on_error) => ({ ...one, on_error })));
  for (const [body, more] of bodies) {
    for (const one of lists) {
      const label = `${String(body)} ${JSON.stringify(one)}`;
      const unit = unitOf(body, more), compiled = rules(one);
      const small = await tier1(unit, compiled), large = await tier1(unitOf(body, more), compiled, byteBudget(0));
      assert.equal(small.escalate, true, label);
      assert.equal(large.escalate, true, label);
      assert.ok((await tier2(unit, compiled)).skipped.every(({ why }) => ['not-utf8', 'multi-line-event'].includes(why)), label);
    }
  }
});

test('one readable pass per unit, however many rules read its body', async () => {
  const body = 'plain text with no hit', list = Array.from({ length: 5 }, (_, i) => rule(`r${i}`, { drop: true }, { match: { body: `ABSENT${i}` } }));
  const spentOn = async (compiled) => { const budget = byteBudget(); await tier1(unitOf(body), compiled, budget); return budget.spent; };
  const one = await spentOn(rules(list[0])), five = await spentOn(rules(...list));
  assert.equal(five - one, 4 * (2 * body.length + 64), 'each further rule pays its search and its look for \\u, and its compare');
});

test('39: a literal past 256 bytes is the rule process\'s, however it is written: the main thread does not look at the body for it', async () => {
  const body = 'a'.repeat(120 * KIB);
  for (const size of [257, 512, 16 * KIB, 64 * KIB]) {
    for (const needle of ['a'.repeat(size), `${'a'.repeat(size - 2)}ba`]) {
      const budget = byteBudget();
      const result = await tier1(unitOf(body), rules(rule('r', lit(needle, 'x', { in: 'body' }))), budget);
      assert.equal(result.escalate, true, `${size} bytes`);
      assert.equal(budget.spent, 0, `${size} bytes: no pass over the body`);
    }
  }
  assert.equal((await tier1(unitOf('a'.repeat(KIB)), rules(rule('r', lit('a'.repeat(256), 'x', { in: 'body' }))))).escalate, false, '256 bytes is the fast path');
});

test('the tier `query rules` says is the tier that runs: one edit on a body it hits', async () => {
  const body = '{"a":"ALPHA <b>"}';
  const axes = [
    ...['ALPHA', '<b>'].flatMap((replace) => ['', 'BRAVO', 'a"b'].flatMap((to) => [{}, { in: 'body' }, { in: 'text' }].map((where) => lit(replace, to, where)))),
    lit('A'.repeat(257), 'x', { in: 'body' }), { replace: 'ALPHA', with: 'x', in: 'body' }, { replace: 'ALPHA', with: 'x' }, lit('ALPHA', 'x', { blocks: { role: 'user' } }),
  ];
  for (const action of axes) {
    const one = rule('r', action, { match: { path: '/v1/messages' } });
    const padded = action.replace.length > 256 ? `${body}${action.replace}` : body;
    assert.equal((await tier1(unitOf(padded), rules(one))).escalate, tierOfRule(one) === 2, JSON.stringify(action));
  }
});

test('5.1 §头的写法: the 8 KiB is the unit\'s, whatever rules and scripts add up to', async () => {
  const big = (name, header, on_error = 'forward') => rule(name, { header, set: 'v'.repeat(7000) }, { on_error });
  const three = rules(big('a', 'x-a'), big('b', 'x-b'), big('c', 'x-c'));
  assert.equal((await tier1(unitOf('{}'), three)).escalate, true, 'tier 1 leaves it to the rule that can say why');
  const after = await tier2(unitOf('{}'), three);
  assert.deepEqual(names(after.skipped), [['b', 'rule-error'], ['c', 'rule-error']]);
  assert.deepEqual(after.headers.map(([name]) => name), ['content-type', 'x-a']);
  assert.deepEqual(after.hits, ['a', 'b', 'c']);

  const drops = await tier2(unitOf('{}'), rules(big('a', 'x-a'), big('b', 'x-b', 'drop')));
  assert.equal(drops.verdict, 'drop', 'on_error goes for a rule that would have grown the headers too far');

  const undone = await tier2(unitOf('{}'), rules(big('a', 'x-a'), rule('b', [{ header: 'x-keep', set: '1' }, { header: 'x-b', set: 'v'.repeat(7000) }])));
  assert.deepEqual(undone.headers.map(([name]) => name), ['content-type', 'x-a'], 'a rule that fails leaves none of its headers');

  const script = async () => ({ headers: [['x-s', 'v'.repeat(7000)]] });
  const scripted = await tier2(unitOf('{}'), rules(big('a', 'x-a'), rule('s', { script: '/abs/s.mjs' })), { script });
  assert.deepEqual(names(scripted.skipped), [['s', 'rule-error']]);

  const room = [['content-type', 'application/json'], ['x-old', 'v'.repeat(7000)]];
  const freed = rules(rule('gone', { header: 'x-old', remove: true }), big('a', 'x-a'), big('b', 'x-b'));
  for (const run of [tier1, tier2]) {
    const result = await run(unitOf('{}', { headers: room }), freed);
    assert.deepEqual(result.skipped, [], 'what a rule took away is room for the next one');
    assert.equal(result.headers.length, 3);
  }
});

test('12g: `in: text` on the main thread stops at the first hit: the search and nothing that parses', async () => {
  for (const size of [4 * KIB, 16 * KIB, 48 * KIB]) {
    const body = `{"a":"${'p'.repeat(size)} ALPHA"}`, budget = byteBudget();
    const result = await tier1(unitOf(body), rules(rule('r', lit('ALPHA', 'BRAVO'))), budget);
    assert.equal(result.escalate, true);
    assert.equal(budget.spent, 2 * body.length, 'UTF-8 and the search');
  }
});

test('9, 63: a rule tier 1 cannot finish hands every survivor to tier 2 and nothing else', async () => {
  const cases = [
    [lit('ALPHA', 'B'), '{"a":"ALPHA"}'], // a hit in a string is escaped again, and the daemon parses no body
    [lit('ALPHA', 'B'), '{"ALPHA":1}'], // the hit is a key
    [lit('ALPHA', 'B'), '{"a":12,"b":"\\u0041"}'], // \u could spell it
    [lit('ALPHA', 'B'), '{"a":"\\nALPHA"}'], // a backslash just before the hit
    [lit('ALPHA', 'B'), '[truALPHA]'], // the hit is in a value that is no string
    [lit('AL.HA', 'B"'), '{"a":"AL.HA"}'], // with needs escaping
    [{ replace: 'ALPHA', with: 'B' }, '{"a":"ALPHA"}'], // a regex
    [{ json: '/a', set: 1 }, '{"a":"ALPHA"}'],
    [{ blocks: { role: 'user' }, remove: true }, '{"a":"ALPHA"}'],
    [lit('ALPHA', 'B', { blocks: { role: 'user' } }), '{"a":"ALPHA"}'],
    [{ script: '/abs/s.mjs' }, '{"a":"ALPHA"}'],
  ];
  for (const [action, body] of cases) {
    const compiled = rules(rule('head', { header: 'x-a', set: '1' }), rule('edit', action), rule('other', { drop: true }, { match: { method: 'GET' } }));
    const result = await tier1(unitOf(body), compiled);
    assert.equal(result.escalate, true, JSON.stringify(action));
    assert.deepEqual(result.survivors.map((c) => c.name), ['head', 'edit']);
    assert.equal(result.bytes, undefined);
  }
  const zipped = await tier1(unitOf(zlib.gzipSync('{"a":"ALPHA"}'), { encoding: 'gzip' }), rules(rule('r', lit('ALPHA', 'B', { in: 'body' }))));
  assert.equal(zipped.escalate, true);
  const unread = await tier1(unitOf(null), rules(rule('r', lit('ALPHA', 'B'))));
  assert.equal(unread.escalate, true);
});

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

test('38: the output limits send an edit to tier 2 before anything is allocated', async () => {
  const big = () => byteBudget(1024 * MIB);
  const cases = [
    ['256 KiB of spaces, a 3000-byte with', ' '.repeat(256 * KIB), lit(' ', 'x'.repeat(3000), { in: 'body' }), byteBudget()],
    ['the same on a roomy budget', ' '.repeat(256 * KIB), lit(' ', 'x'.repeat(3000), { in: 'body' }), big()],
    ['over 4096 hits, no growth', 'a'.repeat(4097), lit('a', 'b', { in: 'body' }), big()],
    ['grows by over 256 KiB', 'a'.repeat(100), lit('a', 'x'.repeat(3 * KIB), { in: 'body' }), big()],
    ['over 1 MiB out', `${'.'.repeat(MIB)}a`, lit('a', 'xx', { in: 'body' }), big()],
  ];
  for (const [name, body, action, budget] of cases) {
    for (const more of [{}, { on: 'response', sse: true }]) {
      const result = await tier1(unitOf(body, more), rules(rule('r', action)), budget);
      assert.equal(result.escalate, true, name);
    }
  }
  const atTheLimit = await tier1(unitOf('a'.repeat(4096)), rules(rule('r', lit('a', 'b', { in: 'body' }))), big());
  assert.equal(atTheLimit.escalate, false);
});

test('38: rules that grow the body one after another pay for the body as it is, so the bill stays bounded', async () => {
  const chain = Array.from({ length: 12 }, (_, i) => rule(`r${i}`, lit(`m${i}`, `m${i + 1} ${'x'.repeat(60 * KIB)} `, { in: 'body' })));
  for (const more of [{}, { on: 'response', sse: true }]) {
    const budget = byteBudget();
    const result = await tier1(unitOf('m0', more), rules(...chain), budget);
    assert.equal(result.escalate, true);
    assert.ok(budget.spent <= UNIT_BYTES + 2 * MIB, `spent ${budget.spent}`);
  }
  const passes = [];
  const counting = { spend(n) { passes.push(n); return true; }, get over() { return false; }, get spent() { return 0; } };
  const two = await tier1(unitOf('m0'), rules(...chain.slice(0, 2)), counting);
  assert.equal(two.escalate, false);
  assert.equal(Math.max(...passes), two.bytes.length, 'a pass is charged at the length it reads');
  assert.ok(passes.includes(2 + 60 * KIB + 1 + 1), 'the second rule pays for the first rule\'s output');
});

test('61: the second script of a unit is skipped, by its on_error, and the first one stands', async () => {
  const calls = [];
  const script = (r, message) => { calls.push(r.name); return { body: `${message.text}!` }; };
  const compiled = (onError) => rules(rule('a', { script: '/abs/a.mjs' }), rule('b', [{ header: 'x-b', set: '1' }, { script: '/abs/b.mjs' }], { on_error: onError, match: { host: '*' } }));
  const forward = await tier2(unitOf('body'), compiled('forward'), { script });
  assert.deepEqual(calls, ['a']);
  assert.equal(text(forward), 'body!');
  assert.equal(forward.headers, null, 'the skipped rule keeps none of its changes');
  assert.deepEqual(names(forward.skipped), [['b', 'multi-script']]);
  assert.equal(forward.verdict, 'forward');
  assert.equal((await tier2(unitOf('body'), compiled('drop'), { script })).verdict, 'drop');
});

test('61: a rule that fails loses only its own changes, later rules run, and on_error decides', async () => {
  const before = rule('before', lit('ALPHA', 'BRAVO', { in: 'body' }));
  const after = rule('after', lit('BRAVO', 'CHARLIE', { in: 'body' }));
  const bad = (onError) => rule('bad', [lit('}', '!', { in: 'body' }), { header: 'x-bad', set: '1' }, { delay_ms: 50 }, { json: '/x/y', set: 1 }], { on_error: onError, match: { host: '*' } });
  const forward = await tier2(unitOf('{"a":"ALPHA"}'), rules(before, bad('forward'), after));
  assert.equal(text(forward), '{"a":"CHARLIE"}');
  assert.deepEqual(applyEdits(forward.bytes, forward.edits), Buffer.from('{"a":"ALPHA"}'));
  assert.deepEqual(names(forward.skipped), [['bad', 'rule-error']]);
  assert.equal(typeof forward.skipped[0].ms, 'number');
  assert.deepEqual([forward.headers, forward.delay_ms, forward.verdict], [null, 0, 'forward']);
  assert.deepEqual(forward.hits, ['before', 'bad', 'after']);
  assert.equal((await tier2(unitOf('{"a":"ALPHA"}'), rules(before, bad('drop'), after))).verdict, 'drop');
});

test('61: a script that throws is a rule-error, and what a script may return is checked', async () => {
  const compiled = rules(rule('s', { script: '/abs/s.mjs' }));
  const skippedBy = async (script) => names((await tier2(unitOf('body'), compiled, { script })).skipped);
  assert.deepEqual(await skippedBy(() => { throw new Error('boom'); }), [['s', 'rule-error']]);
  assert.deepEqual(await skippedBy(() => ({ headers: [['content-length', '1']] })), [['s', 'rule-error']]);
  assert.deepEqual(await skippedBy(() => ({ headers: [['x', 'a\r\nb']] })), [['s', 'rule-error']]);
  assert.deepEqual(await skippedBy(() => ({ body: 7 })), [['s', 'bad-result']]);
  assert.deepEqual(await skippedBy(() => 7), [['s', 'bad-result']]);
});

test('a script reads the message of 5.1, on the bytes the rules before it left, with credentials blanked', async () => {
  let seen;
  const script = (_, message) => { seen = message; };
  const unit = unitOf('ALPHA', { headers: [['authorization', 'Bearer real'], ['x-api-key', 'real'], ['accept', '*/*']] });
  const result = await tier2(unit, rules(rule('a', lit('ALPHA', '中文', { in: 'body' })), rule('s', { script: '/abs/s.mjs' })), { script });
  assert.deepEqual(seen.bytes, Buffer.from('中文'));
  assert.equal(seen.text, '中文');
  assert.deepEqual({ ...seen, bytes: 0, text: 0 }, { on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', status: null, headers: [['authorization', ''], ['x-api-key', ''], ['accept', '*/*']], bytes: 0, text: 0 });
  assert.equal(text(result), '中文', 'an empty return changes nothing');

  await tier2(unitOf(Buffer.from([0xff, 0xfe])), rules(rule('s', { script: '/abs/s.mjs' })), { script });
  assert.equal('text' in seen, false);
});

test('a script changes the body and the headers, in binary too', async () => {
  const binary = Buffer.from([0, 0xff, 1]);
  const compiled = rules(rule('s', { script: '/abs/s.mjs' }));
  const headers = await tier2(unitOf('x'), compiled, { script: () => ({ headers: [['x-a', '1'], ['content-type', null]] }) });
  assert.deepEqual(headers.headers, [['x-a', '1']]);
  assert.equal(headers.bytes, null);

  const up = await tier2(unitOf(binary), compiled, { script: () => Buffer.from([1, 2]) });
  assert.deepEqual(up.bytes, Buffer.from([1, 2]));
  assert.equal(up.recover.recover, 'inline');
  assert.equal(up.recover.body_b64, binary.toString('base64'));

  const down = await tier2(unitOf('plain', { on: 'response' }), compiled, { script: () => binary });
  assert.equal(down.recover.recover, 'inline');
  assert.equal(down.recover.body_b64, binary.toString('base64'));

  const same = await tier2(unitOf('plain'), compiled, { script: () => 'plain' });
  assert.equal(same.bytes, null);
});

test('rules test without --run-script: the script is reported, not run', async () => {
  const result = await tier2(unitOf('body'), rules(rule('s', [{ header: 'x-a', set: '1' }, { script: '/abs/s.mjs' }])));
  assert.deepEqual(result.would, [{ rule: 's', text: 'script' }]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.bytes, null);
});

test('a unit that cannot be read skips the rules that read it, not the rest', async () => {
  const notUtf8 = await tier2(unitOf(Buffer.from([0xff, 0x41])), rules(
    rule('text', lit('A', 'B', { in: 'body' })), rule('body', { delay_ms: 3 }, { match: { body: 'A' } }), rule('head', { delay_ms: 5 }), rule('other-host', { drop: true }, { match: { host: 'x', body: 'A' } }),
  ));
  assert.deepEqual(names(notUtf8.skipped), [['body', 'not-utf8'], ['text', 'not-utf8']]);
  assert.deepEqual([notUtf8.delay_ms, notUtf8.verdict], [5, 'forward']);

  const coded = rules(rule('edit', lit('A', 'B'), { on_error: 'drop', match: { host: '*' } }), rule('head', { header: 'x-a', set: '1' }));
  const unknown = await tier2(unitOf('A', { encoding: 'nonsense' }), coded);
  assert.deepEqual(names(unknown.skipped), [['edit', 'encoding']]);
  assert.deepEqual([unknown.verdict, unknown.bytes, unknown.headers.at(-1)], ['drop', null, ['x-a', '1']]);
});

test('edits-full: a change the record cannot hold is no change, and on_error decides', async () => {
  const wide = 'x'.repeat(2 * MIB);
  const compiled = (onError) => rules(rule('a', lit('ALPHA', wide, { in: 'body' }), { on_error: onError, match: { host: '*' } }), rule('h', { header: 'x-a', set: '1' }));
  const response = { on: 'response' };
  const forward = await tier2(unitOf('ALPHA', response), compiled('forward'));
  assert.deepEqual([forward.bytes, forward.headers, forward.recover, forward.edits, forward.verdict], [null, null, null, [], 'forward']);
  assert.deepEqual(names(forward.skipped), [['a', 'edits-full'], ['h', 'edits-full']]);
  assert.equal((await tier2(unitOf('ALPHA', response), compiled('drop'))).verdict, 'drop');
  const fits = await tier2(unitOf('ALPHA'), compiled('forward')); // going up the record holds what was taken out
  assert.equal(fits.bytes.length, wide.length);
  assert.deepEqual(fits.skipped, []);
});

test('AC-I: edits take the wire bytes back to the agent\'s bytes, each way, across wide characters', async () => {
  const body = `{"备注":"中文😀","a":"中文😀ALPHA","b":"ALPHA ALPHA","pad":"${'p'.repeat(600)}"}`;
  const edit = rule('r', lit('ALPHA', 'β'.repeat(3), { in: 'body' }));
  const fast = rule('f', lit('ALPHA', 'BR'));
  const settled = async (unit, compiled) => { const first = await tier1(unit, compiled); return first.escalate ? tier2(unit, compiled) : first; };
  for (const list of [[edit], [fast], [fast, rule('g', lit('BR', 'ALPHA ', { in: 'body' }))]]) {
    for (const run of [settled, tier2]) {
      const up = await run(unitOf(body), rules(...list));
      assert.deepEqual(applyEdits(up.bytes, up.edits), Buffer.from(body));
      assert.equal(up.recover.recover, 'patch');
      assert.deepEqual(up.recover.edits, up.edits);
      const down = await run(unitOf(body, { on: 'response' }), rules(...list));
      assert.deepEqual(applyEdits(Buffer.from(body), down.edits), down.bytes);
    }
  }
});

test('AC-I: a compressed body goes out plain, without content-encoding, and the record keeps what the agent sent', async () => {
  const plain = `{"a":"ALPHA","pad":"${'p'.repeat(600)}"}`, zipped = zlib.gzipSync(plain);
  const headers = [['Content-Encoding', 'gzip'], ['content-type', 'application/json']];
  const compiled = rules(rule('r', lit('ALPHA', 'BRAVO')));
  const up = await tier2(unitOf(zipped, { encoding: 'gzip', headers }), compiled);
  assert.equal(text(up), plain.replace('ALPHA', 'BRAVO'));
  assert.deepEqual(up.headers, [['content-type', 'application/json']]);
  assert.equal(up.recover.recover, 'inline');
  assert.deepEqual(Buffer.from(up.recover.body_b64, 'base64'), zipped);

  const down = await tier2(unitOf(zipped, { on: 'response', encoding: 'gzip', headers }), compiled);
  assert.deepEqual(down.headers, [['content-type', 'application/json']]);
  assert.deepEqual(applyEdits(Buffer.from(plain), down.recover.edits), down.bytes, 'the base of a response is its decoded text, so a patch still holds');

  const untouched = await tier2(unitOf(zipped, { encoding: 'gzip', headers }), rules(rule('r', lit('BRAVO', 'X'))));
  assert.deepEqual([untouched.bytes, untouched.headers, untouched.recover], [null, null, null]);
});
