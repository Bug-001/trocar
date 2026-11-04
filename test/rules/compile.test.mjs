// Rule compilation, the host index and the tier 1 verdict (spec 5.1 §规则, §分派). The verdict never rests on a guess: `hit` and `miss` are only
// said when the bytes settle it, everything else is `tier2`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, headersMap } from '../../src/rules/compile.mjs';
import { byteBudget, CONDITION_COST, UNIT_BYTES } from '../../src/rules/budget.mjs';
import { checkFile } from '../../src/rules/validate.mjs';

const rule = (name, match, more = {}) => ({ name, on_error: 'forward', do: [{ drop: true }], match: { harness: 'any', ...match }, ...more });
const unit = (more = {}) => Object.freeze({
  on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm',
  status: null, event_index: null, headers: [], req_headers: [], body: null, encoding: null, ...more,
});
const judge = (match, u = {}, budget = byteBudget(), more = {}) => compileRules({ rules: [rule('r', match, more)] }).rules[0].judge(unit(u), budget);
const bodyJudge = (literal, body, more = {}) => judge({ body: literal }, { body: Buffer.from(body), ...more });
const seeded = (seed) => () => { // mulberry32
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};

test('a literal too long for the byte search goes to tier 2 without a pass over the body', () => {
  for (const size of [1024, 64 * 1024]) {
    const literal = 'a'.repeat(size), budget = byteBudget();
    const u = { body: Buffer.alloc(size * 2, 'a') };
    assert.equal(judge({ path: '/v1/*', body: literal }, u, budget), 'tier2');
    assert.ok(budget.spent < size, `spent ${budget.spent}`);
    assert.equal(judge({ path: '/other', body: literal }, u), 'miss');
  }
});

test('4096 contains conditions on a 64 KiB header stop at the first 256 KiB, not after them all', () => {
  const value = 'x'.repeat(64 * 1024), rules = [];
  for (let i = 0; i < 64; i++) rules.push(rule(`r${i}`, { host: '*', header: { 'x-big': Array.from({ length: 63 }, (_, j) => `*needle-${i}-${j}*`) } }));
  assert.deepEqual(checkFile({ rules }), []);
  const budget = byteBudget(), u = unit({ headers: [['X-Big', value]] });
  const verdicts = compileRules({ rules }).rules.map((r) => r.judge(u, budget));
  assert.equal(verdicts.at(-1), 'tier2');
  assert.equal(verdicts.includes('hit'), false);
  assert.ok(budget.over);
  assert.ok(budget.spent <= UNIT_BYTES + value.length + CONDITION_COST, `spent ${budget.spent}`);
});

test('a body over the budget is not scanned: the unit goes to tier 2', () => {
  const body = Buffer.alloc(UNIT_BYTES + 1, 'a'), budget = byteBudget();
  assert.equal(judge({ body: 'ALPHA' }, { body }, budget), 'tier2');
  assert.ok(budget.over);
});

test('the byte search only answers when the bytes settle it', () => {
  const cases = [
    ['<system-reminder>', '{"a":"\\u003csystem-reminder\\u003e"}', 'tier2'],
    ['<system-reminder>', '{"a":"<system-reminder>"}', 'tier2'],
    ['你好', '{"a":"\\u4f60\\u597d"}', 'tier2'],
    ['ABC', '{"a":"\\u0041BC"}', 'tier2'],
    ['41BC', '{"a":"\\u0041BC"}', 'tier2'],
    ['nALPHA', '{"a":"\\nALPHA"}', 'tier2'],
    ['ALPHA', '{"a":"\\nALPHA"}', 'tier2'],
    ['ALPHA', '{"a":"\\nALPHA and ALPHA"}', 'hit'],
    ['ALPHA', '{"a":"ALPHA"}', 'hit'],
    ['ALPHA', 'ALPHA', 'hit'],
    ['ALPHA', '{"a":"BRAVO"}', 'miss'],
    ['ALPHA', '{"a":"\\nBRAVO"}', 'miss'],
    ['ALPHA', '', 'miss'],
    ['ALPHA', '{"a":"\\u0042"}', 'tier2'],
  ];
  for (const [literal, body, want] of cases) assert.equal(bodyJudge(literal, body), want, `${literal} in ${body}`);
});

test('a compressed body or one not here yet is not searched', () => {
  const budget = byteBudget();
  assert.equal(judge({ body: 'ALPHA' }, { body: Buffer.from('ALPHA'), encoding: 'gzip' }, budget), 'tier2');
  assert.ok(budget.spent < 5 + CONDITION_COST);
  assert.equal(judge({ body: 'ALPHA' }, { body: null }), 'tier2');
});

test('hit and miss agree with the decoded text, however the JSON spells it', () => {
  const rand = seeded(7), pick = (s) => s[Math.floor(rand() * s.length)];
  const spell = (c) => {
    const r = rand();
    if (c === '\n') return '\\n';
    if (r < 0.15) return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    return c;
  };
  const answers = new Set();
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: Math.floor(rand() * 12) }, () => pick('ABn41 \n')).join('');
    const literal = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick('ABn41')).join('');
    const wire = `{"t":"${[...text].map(spell).join('')}"}`;
    assert.equal(JSON.parse(wire).t, text);
    const verdict = bodyJudge(literal, wire), holds = text.includes(literal);
    answers.add(verdict);
    if (verdict === 'hit') assert.ok(holds, `${literal} in ${wire}`);
    if (verdict === 'miss') assert.ok(!holds, `${literal} in ${wire}`);
  }
  assert.deepEqual([...answers].sort(), ['hit', 'miss', 'tier2']);
});

test('a tier 2 condition waits for the others: any tier 1 miss decides first', () => {
  const later = [{ path: { re: '^/v1' } }, { path: 'x'.repeat(257) }, { body: '<a>' }, { blocks: { role: 'system' } }, { path: { not: { re: 'x' } } }];
  for (const part of later) {
    assert.equal(judge({ ...part, method: 'POST' }), 'tier2');
    assert.equal(judge({ ...part, method: 'GET' }), 'miss');
  }
});

test('not and lists keep an unsettled answer unsettled', () => {
  const body = Buffer.from('{"a":"\\nALPHA"}');
  assert.equal(judge({ body: { not: 'ALPHA' } }, { body }), 'tier2');
  assert.equal(judge({ body: ['BRAVO', 'ALPHA'] }, { body }), 'tier2');
  const clean = Buffer.from('ALPHA');
  assert.equal(judge({ body: { not: 'ALPHA' } }, { body: clean }), 'miss');
  assert.equal(judge({ body: { not: 'BRAVO' } }, { body: clean }), 'hit');
  assert.equal(judge({ body: ['BRAVO', 'ALPHA'] }, { body: clean }), 'hit');
});

test('every key compares as a string, and all of them must hold', () => {
  const response = { on: 'response', status: 200, event_index: 3, req_headers: [['X-Sid', 'abc']], headers: [['Content-Type', 'text/event-stream']] };
  const holds = [
    { method: 'POST' }, { method: ['GET', 'POST'] }, { method: { not: 'GET' } }, { path: '/v1/*' }, { path: '*/messages' }, { path: '*/mess*' },
    { class: 'llm' }, { host: '*.EXAMPLE.com' }, { host: 'API.example.com' }, { pid: 42 }, { status: 200 }, { status: '2*' }, { event_index: 3 },
    { header: { 'content-type': 'text/*' } }, { req_header: { 'X-SID': 'abc' } }, { header: { 'x-none': { not: 'a' } } },
  ];
  for (const m of holds) {
    assert.equal(judge(m, response), 'hit', JSON.stringify(m));
    assert.equal(judge({ ...m, class: 'telemetry' }, response), 'miss', JSON.stringify(m));
  }
  for (const m of [{ pid: 41 }, { status: 404 }, { event_index: 4 }, { path: '/v2*' }, { header: { 'x-none': '*' } }, { host: 'other.example.com' }]) {
    assert.equal(judge(m, response), 'miss', JSON.stringify(m));
  }
});

test('event_index on a response that is not SSE is no match, not even under not', () => {
  assert.equal(judge({ event_index: 0 }, { event_index: null }), 'miss');
  assert.equal(judge({ event_index: { not: 0 } }, { event_index: null }), 'miss');
});

test('headersMap folds names and joins repeats', () => {
  const map = headersMap([['Set-Cookie', 'a'], ['X-One', '1'], ['set-cookie', 'b']]);
  assert.deepEqual([...map], [['set-cookie', 'a, b'], ['x-one', '1']]);
});

test('each compared condition is charged, and a contains pays for the value it reads', () => {
  const budget = byteBudget(), value = 'x'.repeat(1000);
  assert.equal(judge({ method: 'POST', header: { 'x-v': '*x*' } }, { headers: [['x-v', value]] }, budget), 'hit');
  assert.ok(budget.spent >= 2 * CONDITION_COST + value.length, `spent ${budget.spent}`);
});

const headOf = (n) => Array.from({ length: n }, (_, i) => [`x-h${i}`, 'v']);
const headBytes = (pairs) => pairs.reduce((n, [name, value]) => n + name.length + value.length, 0);

test('the first read of a head is paid by its bytes, once per unit, and a head too big to pay for is not read', () => {
  for (const size of [1, 50, 1000]) {
    const headers = headOf(size), list = compileRules({ rules: [1, 2, 3].map((i) => rule(`r${i}`, { header: { 'x-q': `v${i}` } })) }).rules;
    const budget = byteBudget(), u = unit({ headers });
    assert.deepEqual(list.map((r) => r.judge(u, budget)), ['miss', 'miss', 'miss']);
    assert.ok(budget.spent >= headBytes(headers), `${size} headers`);
    assert.ok(budget.spent < 2 * headBytes(headers) + size * CONDITION_COST + 3 * CONDITION_COST, `${size} headers`);
  }
  for (const headers of [headOf(16_000), [['x-q', 'v'.repeat(UNIT_BYTES + 1)]]]) {
    const budget = byteBudget();
    assert.equal(judge({ header: { 'x-q': 'nothing' } }, { headers }, budget), 'tier2');
    assert.ok(budget.over);
  }
});

test('a host is folded once per unit and paid for: a long one costs one pass, however many rules read it', () => {
  const host = `${'a'.repeat(60 * 1024)}.Example.com`;
  const list = compileRules({ rules: Array.from({ length: 100 }, (_, i) => rule(`r${i}`, { host: '*.example.com' })) }).rules;
  const budget = byteBudget(), u = unit({ host });
  assert.ok(list.every((r) => r.judge(u, budget) === 'hit'));
  assert.ok(budget.spent >= host.length, `spent ${budget.spent}`);
  assert.ok(budget.spent < 2 * host.length, `spent ${budget.spent}`);
  const over = byteBudget();
  assert.equal(judge({ host: '*.example.com' }, { host: 'a'.repeat(UNIT_BYTES + 1) }, over), 'tier2');
  assert.ok(over.over);
  assert.equal(judge({ host: '*.example.com' }, { host: null }), 'miss');
});

test('every look for a second data line is paid for, and a body of them leaves for tier 2', () => {
  for (const count of [1, 100, 3000, 26_000]) {
    const budget = byteBudget(), body = Buffer.from('data:'.repeat(count));
    const verdict = judge({ body: 'ZZ' }, { on: 'response', sse: true, body }, budget);
    if (count * CONDITION_COST > UNIT_BYTES) assert.equal(verdict, 'tier2', `${count} of them`);
    else assert.ok(budget.spent >= count * CONDITION_COST, `${count} of them`);
  }
});

test('a compiled rule carries its place in the file, its tier and whether it reads the body', () => {
  const { rules } = compileRules({ rules: [rule('a', { path: '/x' }), rule('b', { path: '/x', body: 'ALPHA' }), rule('c', { path: { re: 'x' } }), rule('d', { path: '/x', blocks: { role: 'system' } })] });
  assert.deepEqual(rules.map((r) => [r.name, r.index, r.tier, r.readsBody]), [['a', 0, 1, false], ['b', 1, 1, true], ['c', 2, 2, false], ['d', 3, 2, true]]);
  assert.equal(rules[0].rule.on, 'request');
});

test('a file of 500 rules of 64 hosts and 500 wildcards under any stays small: no cartesian index', () => {
  const rules = [];
  for (let i = 0; i < 500; i++) rules.push(rule(`exact-${i}`, { host: Array.from({ length: 64 }, (_, j) => `h${i}-${j}.example.com`) }));
  for (let i = 0; i < 500; i++) rules.push(rule(`wild-${i}`, { host: `*.w${i}.example.com` }));
  assert.deepEqual(checkFile({ rules }), []);
  const before = process.memoryUsage().heapUsed;
  const compiled = compileRules({ rules });
  assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024);
  assert.deepEqual(compiled.lookup('request', 'codex', 'h7-9.example.com').map((r) => r.index), [7, ...Array.from({ length: 500 }, (_, i) => 500 + i)]);
});

test('lookup equals a walk over every rule, in file order', () => {
  const rand = seeded(11), pick = (a) => a[Math.floor(rand() * a.length)];
  const positions = ['request', 'response', 'ws-client', 'ws-server'], harnesses = ['codex', 'claude-code', 'kimi-code', 'any'];
  const hosts = ['a.example.com', 'B.example.com', 'c.example.com'];
  const hostShapes = [
    () => undefined, () => pick(hosts), () => [pick(hosts), pick(hosts)], () => `*.${pick(hosts)}`, () => '*', () => ({ re: 'a' }), () => ({ not: pick(hosts) }),
    () => [pick(hosts), `*${pick(hosts)}`],
  ];
  const exactOf = (host) => (typeof host === 'string' && !host.includes('*') ? [host] : Array.isArray(host) && host.every((h) => !h.includes('*')) ? host : null);
  for (let round = 0; round < 200; round++) {
    const rules = Array.from({ length: Math.floor(rand() * 12) }, (_, i) => {
      const host = pick(hostShapes)(), harness = pick(harnesses);
      const match = { harness: harness === 'any' || rand() < 0.5 ? harness : [harness, pick(harnesses.slice(0, 3))] };
      if (host !== undefined) match.host = host;
      return rule(`r${i}`, match, { on: pick(positions) });
    });
    const compiled = compileRules({ rules });
    for (let probe = 0; probe < 20; probe++) {
      const on = pick(positions), harness = pick(harnesses), host = pick([...hosts, 'A.EXAMPLE.COM', 'none.example.com']);
      const want = rules.flatMap((r, index) => {
        const names = [].concat(r.match.harness), exact = exactOf(r.match.host);
        const reach = r.on === on && (names.includes('any') || names.includes(harness)) && (!exact || exact.some((h) => h.toLowerCase() === host.toLowerCase()));
        return reach ? [index] : [];
      });
      assert.deepEqual(compiled.lookup(on, harness, host).map((r) => r.index), want);
    }
  }
});

test('rules of another harness cost nothing', () => {
  const rules = Array.from({ length: 100 }, (_, i) => rule(`r${i}`, { harness: 'codex', host: i % 2 ? 'a.example.com' : '*' }));
  assert.deepEqual(compileRules({ rules }).lookup('request', 'kimi-code', 'a.example.com'), []);
});
