// The built-in actions and the tier-2 judge (spec 5.1 §动作, §怎么算改动, §条件的写法). Offsets in the fixtures are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { full, RuleFault } from '../../src/rules/actions.mjs';
import { applySteps, invertSteps } from '../../src/rules/edits.mjs';

const unitOf = (body, extra = {}) => ({
  host: 'api.example.com', path: '/v1/messages', method: 'POST', class: 'llm', harness: 'claude-code', pid: 42, headers: [], encoding: null,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body), ...extra,
});
function run(actions, body, { on = 'request', ...extra } = {}) {
  const unit = unitOf(body, extra), { bytes, text } = full.decode(unit);
  const state = { bytes, text, headers: unit.headers, grown: 0, steps: [] };
  for (const action of [].concat(actions)) full.act(action, state, { on, unit });
  return state;
}
const result = (...args) => run(...args).bytes.toString();
const parsed = (...args) => JSON.parse(result(...args));
const fails = (why, f) => assert.throws(f, (e) => e instanceof RuleFault && e.why === why);
const judged = (match, body = '', extra = {}, on = 'request') => {
  const unit = unitOf(body, extra);
  return full.judge({ on, match }, unit, full.decode(unit));
};
function seeded(seed) {
  let s = seed;
  return (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
}
const undone = (state) => applySteps(state.bytes, invertSteps(state.steps));

// 备注 and 😀 before the target: byte offsets and string indices differ. The value of "a" starts at byte 27, string index 17.
const WIDE = '{"备注":"中文😀","a":"中文😀ALPHA"}';
// The same prefix; the content string starts at byte 60.
const WIDE_CHAT = '{"备注":"中文😀","messages":[{"role":"user","content":"中文😀ALPHA"}]}';

test('every kind of edit undoes to the original bytes, at the offset worked out by hand', () => {
  const cases = [
    ['replace in text', WIDE, { replace: 'ALPHA', with: 'β' }, [27, 17]],
    ['replace in body', WIDE, { replace: 'ALPHA', with: 'β', in: 'body' }, [38, 5]],
    ['blocks', WIDE_CHAT, { blocks: { role: 'user' }, set_text: 'β' }, [60, 17]],
    ['json set', WIDE, { json: '/a', set: 'β' }, [27, 17]],
    ['json remove', WIDE, { json: '/a', remove: true }, [22, 22]],
  ];
  for (const [name, body, action, [at, del]] of cases) {
    const state = run(action, body);
    assert.deepEqual([state.steps[0].at, state.steps[0].del], [at, del], name);
    assert.deepEqual(undone(state), Buffer.from(body), name);
  }
});

test('a chain of actions undoes through every step', () => {
  const state = run([{ replace: 'ALPHA', with: '😀"' }, { json: '/新', set: { n: 1 } }, { json: '/备注', remove: true }], WIDE);
  assert.deepEqual(undone(state), Buffer.from(WIDE));
  assert.deepEqual(JSON.parse(state.bytes.toString()), { a: '中文😀😀"', 新: { n: 1 } });
});

const NOISE = ['plain', '中文', '😀😀', 'quote\\"d', 'line\\nbreak', '\\u4e2d', 'back\\\\slash', ''];
const SEPARATORS = [',', ', ', ',\n  ', ' , '];
function objectWith(rand, hitAt, size) {
  const sep = SEPARATORS[rand(SEPARATORS.length)];
  const entries = Array.from({ length: size }, (_, i) => `"k${i}":${i === hitAt ? `"${NOISE[rand(NOISE.length)]}TOKEN${NOISE[rand(NOISE.length)]}"` : rand(3) ? `"${NOISE[rand(NOISE.length)]}"` : String(i)}`);
  return { entries, sep, text: `{${entries.join(sep)}}` };
}

test('a replace leaves every byte outside the string it hit', () => {
  const rand = seeded(7);
  for (let round = 0; round < 300; round++) {
    const size = 1 + rand(6), hitAt = rand(size);
    const { entries, sep, text } = objectWith(rand, hitAt, size);
    const before = `{${entries.slice(0, hitAt).map((e) => e + sep).join('')}"k${hitAt}":`;
    const after = `${entries.slice(hitAt + 1).map((e) => sep + e).join('')}}`;
    for (const action of [{ replace: 'TOKEN', with: 'x"\ny' }, { replace: 'TO(K)EN', with: '$1' }]) {
      const out = result(action, text);
      assert.ok(out.startsWith(before) && out.endsWith(after), text);
      JSON.parse(out);
    }
    assert.equal(result({ replace: 'ABSENT', with: 'x' }, text), text);
  }
});

test('a json remove keeps every other key, byte for byte, and the result parses', () => {
  const rand = seeded(11);
  for (let round = 0; round < 300; round++) {
    const size = 1 + rand(6), gone = rand(size);
    const { entries, text } = objectWith(rand, -1, size);
    const out = result({ json: `/k${gone}`, remove: true }, text);
    assert.deepEqual(Object.keys(JSON.parse(out)), entries.map((_, i) => `k${i}`).filter((k) => k !== `k${gone}`));
    entries.forEach((e, i) => { if (i !== gone) assert.ok(out.includes(e), text); });
  }
});

test('a replacement with quotes and line breaks stays JSON, and its value is the one asked for', () => {
  assert.deepEqual(parsed({ replace: 'ALPHA', with: 'a"b\nc\\d' }, '{"a":"xALPHAy"}'), { a: 'xa"b\nc\\dy' });
});

test('a text replace leaves keys and numbers alone', () => {
  const body = '{"model":12,"a":"model 12"}';
  assert.equal(result([{ replace: 'model', with: 'M' }, { replace: '12', with: 'N' }], body), '{"model":12,"a":"M N"}');
});

test('a text replace reads the decoded value, so an escaped spelling hits and a string it missed keeps its escapes', () => {
  assert.equal(result({ replace: '中', with: 'x' }, '{"a":"\\u4e2d文","b":"\\u0041"}'), '{"a":"x文","b":"\\u0041"}');
  assert.equal(result({ replace: 'nALPHA', with: 'x' }, '{"a":"\\nALPHA"}'), '{"a":"\\nALPHA"}');
});

test('a body replace works on the text as it stands', () => {
  assert.equal(result({ replace: '"model":12', with: '"model":13', in: 'body' }, '{"model":12}'), '{"model":13}');
});

test('a body that is not JSON is replaced as text', () => {
  for (const body of ['ALPHA', 'x ALPHA y', '{broken ALPHA']) assert.equal(result({ replace: 'ALPHA', with: 'β' }, body), body.replace('ALPHA', 'β'));
});

test('with expands groups unless the rule says literal', () => {
  const cases = [
    [{ replace: '(a)(?<n>b)', with: '[$1|$2|$&|$$|$<n>]' }, 'ab', '[a|b|ab|$|b]'],
    [{ replace: '(a)', with: '$2' }, 'a', '$2'],
    [{ replace: '(a)|(b)', with: '<$2>' }, 'a', '<>'],
    [{ replace: 'a.c', with: '$&', literal: true }, 'abc a.c', 'abc $&'],
  ];
  for (const [action, text, want] of cases) assert.equal(parsed(action, JSON.stringify({ t: text })).t, want);
});

test('an event replace touches the one data line, and a body replace may touch the rest', () => {
  const event = 'event: ALPHA\ndata: {"t":"ALPHA"}\n\n';
  assert.equal(result({ replace: 'ALPHA', with: 'β' }, event, { on: 'response', sse: true }), 'event: ALPHA\ndata: {"t":"β"}\n\n');
  assert.equal(result({ replace: 'ALPHA', with: 'β', in: 'body' }, event, { on: 'response', sse: true }), 'event: β\ndata: {"t":"β"}\n\n');
  assert.equal(result({ replace: 'DONE', with: 'x' }, 'data: [DONE]\r\n\r\n', { on: 'response', sse: true }), 'data: [x]\r\n\r\n');
});

test('an event with several data lines refuses every body action', () => {
  const event = 'data: {"t":\ndata: "ALPHA"}\n\n';
  for (const action of [{ replace: 'ALPHA', with: 'x' }, { replace: 'ALPHA', with: 'x', in: 'body' }, { replace: 'none', with: 'x', in: 'body' }, { json: '/t', set: 'x' }]) {
    fails('multi-line-event', () => run(action, event, { on: 'response', sse: true }));
  }
  fails('multi-line-event', () => judged({ body: 'ALPHA' }, event, { sse: true }, 'response'));
});

test('a body that is not UTF-8 refuses the body actions and the body conditions', () => {
  const body = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
  for (const action of [{ replace: 'a', with: 'b' }, { json: '/a', set: 1 }, { blocks: {}, remove: true }]) fails('not-utf8', () => run(action, body));
  fails('not-utf8', () => judged({ body: 'a' }, body));
  fails('not-utf8', () => judged({ blocks: {} }, body));
  assert.equal(judged({ body: 'a', method: 'GET' }, body), false, 'a condition that already failed needs no body');
});

test('a header action changes the headers only, and keeps the spelling already there', () => {
  const headers = () => [['X-Trace', 'a'], ['Accept', 'b'], ['x-trace', 'c']];
  const set = run({ header: 'x-TRACE', set: 'z' }, 'body', { headers: headers() });
  assert.deepEqual(set.headers, [['X-Trace', 'z'], ['Accept', 'b'], ['x-trace', 'c']]);
  assert.deepEqual(set.steps, []);
  assert.deepEqual(run({ header: 'X-New', set: 'z' }, 'b', { headers: headers() }).headers.at(-1), ['X-New', 'z']);
  assert.deepEqual(run({ header: 'X-TRACE', remove: true }, 'b', { headers: headers() }).headers, [['Accept', 'b']]);
  assert.equal(run({ header: 'X-New', set: 'z' }, Buffer.from([0xff])).headers.length, 1, 'a header action does not read the body');
});

test('a header the check refuses is a rule error at run time', () => {
  for (const action of [{ header: 'Content-Length', set: '1' }, { header: 'X', set: 'a\r\nb' }, { header: 'bad name', set: 'a' }, { header: 'X', set: 'a'.repeat(9000) }, { header: 'Connection', remove: true }]) {
    fails('rule-error', () => run(action, 'b'));
  }
});

test('json set replaces the node, adds a missing key, and only a structural change is parsed', () => {
  assert.equal(result({ json: '/model', set: 'b' }, '{"model": "a" , "n":1}'), '{"model": "b" , "n":1}');
  assert.equal(result({ json: '/n', set: { x: [1] } }, '{"model":"a","n":1}'), '{"model":"a","n":{"x":[1]}}');
  assert.equal(result({ json: '/a', set: null }, '{"a":"x"}'), '{"a":null}');
  assert.deepEqual(parsed({ json: '/new', set: 1 }, '{"a":1}'), { a: 1, new: 1 });
  assert.deepEqual(parsed({ json: '/o/new', set: 1 }, '{"o":{}}'), { o: { new: 1 } });
  const broken = '{"a":"x","b":"l\ni"}';
  assert.equal(result({ json: '/a', set: 'y' }, broken), '{"a":"y","b":"l\ni"}', 'a string over a string cannot break the structure');
  for (const action of [{ json: '/a', set: 1 }, { json: '/c', add: 1 }, { json: '/a', remove: true }]) fails('rule-error', () => run(action, broken));
});

test('json add appends, inserts before an index, and walks the escaped tokens', () => {
  const cases = [
    [{ json: '/m/-', add: 3 }, { m: [1, 2] }, { m: [1, 2, 3] }],
    [{ json: '/m/-', add: 3 }, { m: [] }, { m: [3] }],
    [{ json: '/m/0', add: 3 }, { m: [1, 2] }, { m: [3, 1, 2] }],
    [{ json: '/m/1', add: 3 }, { m: [1, 2] }, { m: [1, 3, 2] }],
    [{ json: '/m/2', add: 3 }, { m: [1, 2] }, { m: [1, 2, 3] }],
    [{ json: '/a~1b/c~0d', add: 1 }, { 'a/b': {} }, { 'a/b': { 'c~d': 1 } }],
    [{ json: '/a~1b', remove: true }, { 'a/b': 1, c: 2 }, { c: 2 }],
    [{ json: '/a', add: 2 }, { a: 1 }, { a: 2 }],
    [{ json: '/m/1', remove: true }, { m: [1, 2, 3] }, { m: [1, 3] }],
    [{ json: '/m/0', remove: true }, { m: [1] }, { m: [] }],
    [{ json: '/gone', remove: true }, { a: 1 }, { a: 1 }],
    [{ json: '/m/9', remove: true }, { m: [1] }, { m: [1] }],
  ];
  for (const [action, body, want] of cases) {
    for (const text of [JSON.stringify(body), JSON.stringify(body, null, 2)]) assert.deepEqual(parsed(action, text), want, text);
  }
});

test('json that has nowhere to go is a rule error', () => {
  for (const [action, body] of [[{ json: '/a/b', set: 1 }, '{}'], [{ json: '/m/5', add: 1 }, '{"m":[]}'], [{ json: '/m/x', add: 1 }, '{"m":[]}'], [{ json: '/a/b', add: 1 }, '{"a":1}'], [{ json: '/a', set: 1 }, 'not json']]) {
    fails('rule-error', () => run(action, body));
  }
});

test('json on an event skips the events with no JSON in them', () => {
  assert.equal(result({ json: '/t', set: 'x' }, 'data: [DONE]\n\n', { on: 'response', sse: true }), 'data: [DONE]\n\n');
  assert.equal(result({ json: '/t', set: 'x' }, 'data: {"t":"a"}\n\n', { on: 'response', sse: true }), 'data: {"t":"x"}\n\n');
});

const CHAT_PATH = { path: '/v1/chat/completions' }, RESPONSES_PATH = { path: '/v1/responses' };
const WIRES = [
  ['anthropic', {}, 'request', { model: 'm', messages: [{ role: 'user', content: 'ALPHA' }] }, (b) => b.messages[0].content],
  ['anthropic parts', {}, 'request', { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'ALPHA' }] }] }, (b) => b.messages[0].content[0].text],
  ['chat', CHAT_PATH, 'request', { model: 'm', messages: [{ role: 'user', content: 'ALPHA' }] }, (b) => b.messages[0].content],
  ['responses', RESPONSES_PATH, 'request', { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ALPHA' }] }] }, (b) => b.input[0].content[0].text],
  ['responses over a socket', RESPONSES_PATH, 'ws-client', { type: 'response.create', model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ALPHA' }] }] }, (b) => b.input[0].content[0].text],
];

test('a block edit lands on the same block on every wire', () => {
  for (const [name, extra, on, body, read] of WIRES) {
    const text = JSON.stringify(body), opts = { ...extra, on };
    assert.equal(read(parsed({ blocks: { role: 'user' }, set_text: 'a"b' }, text, opts)), 'a"b', name);
    assert.equal(read(parsed({ blocks: { role: 'user' }, append_text: '中' }, text, opts)), 'ALPHA中', name);
    assert.equal(read(parsed({ blocks: { role: 'user' }, truncate: 2 }, text, opts)), 'AL', name);
    assert.equal(read(parsed({ replace: 'PH', with: '"', blocks: { role: 'user' } }, text, opts)), 'AL"A', name);
    assert.equal(judged({ blocks: { role: 'user', text: 'ALPHA' } }, text, extra, on), true, name);
    assert.equal(judged({ blocks: { role: 'assistant' } }, text, extra, on), false, name);
  }
});

const conversation = (n) => ({ model: 'm', messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` })) });
const contents = (body) => body.messages.map((m) => m.content);

test('newest and skip_newest count from the end of the selection, and removal keeps the JSON whole', () => {
  for (let n = 1; n <= 6; n++) {
    for (let k = 0; k <= n + 1; k++) {
      const all = contents(conversation(n));
      for (const text of [JSON.stringify(conversation(n)), JSON.stringify(conversation(n), null, 1)]) {
        assert.deepEqual(contents(parsed({ blocks: { newest: k }, remove: true }, text)), all.slice(0, Math.max(0, n - k)));
        assert.deepEqual(contents(parsed({ blocks: { skip_newest: k }, remove: true }, text)), all.slice(Math.max(0, n - k)));
      }
    }
  }
});

test('removing blocks that are not neighbours takes each out on its own', () => {
  const out = parsed({ blocks: { text: 'x' }, remove: true }, JSON.stringify({ model: 'm', messages: ['x0', 'k1', 'x2', 'x3', 'k4', 'x5'].map((content) => ({ role: 'user', content })) }));
  assert.deepEqual(contents(out), ['k1', 'k4']);
});

test('the selector keys narrow the choice', () => {
  const body = JSON.stringify({ model: 'm', system: 'sys', messages: [
    { role: 'user', content: [{ type: 'text', text: 'short' }, { type: 'tool_result', tool_use_id: 't', content: '中'.repeat(100) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }, { type: 'text', text: 'reply' }] },
  ] });
  assert.equal(parsed({ blocks: { section: 'system' }, remove: true }, body).system, undefined);
  assert.deepEqual(parsed({ blocks: { kind: 'tool_use' }, remove: true }, body).messages[1].content.map((b) => b.type), ['text']);
  assert.deepEqual(parsed({ blocks: { name: 'Bash' }, remove: true }, body).messages[1].content.map((b) => b.type), ['text']);
  assert.deepEqual(parsed({ blocks: { min_bytes: 300 }, remove: true }, body).messages[0].content.map((b) => b.type), ['text']);
  assert.equal(parsed({ blocks: { max_bytes: 3, section: 'system' }, set_text: 'x' }, body).system, 'x');
  assert.equal(parsed({ blocks: { max_bytes: 2, section: 'system' }, set_text: 'x' }, body).system, 'sys');
});

test('a body with a NUL is not text, whichever way it got there', () => {
  for (const body of [Buffer.from('{"a":"ALPHA"}', 'utf16le'), Buffer.from('ALPHA\0'), Buffer.from('\0')]) {
    assert.equal(full.decode(unitOf(body)).text, null);
    fails('not-utf8', () => run({ replace: 'ALPHA', with: 'x' }, body));
    fails('not-utf8', () => judged({ body: 'ALPHA' }, body));
  }
  assert.equal(full.decode(unitOf('{"a":"\\u0000"}')).text, '{"a":"\\u0000"}', 'an escape is no NUL byte');
});

test('a text action does not count the blocks that have no text', () => {
  const body = JSON.stringify({ model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'old' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
  ] });
  assert.equal(parsed({ blocks: { newest: 1 }, set_text: 'new' }, body).messages[0].content[0].text, 'new');
  assert.equal(parsed({ blocks: { kind: 'tool_use' }, set_text: 'new' }, body).messages[0].content[1].text, undefined);
});

test('truncate cuts in bytes on a character boundary', () => {
  const body = (t) => JSON.stringify({ model: 'm', messages: [{ role: 'user', content: t }] });
  const cut = (t, n) => parsed({ blocks: { role: 'user' }, truncate: n }, body(t)).messages[0].content;
  assert.equal(cut('中文', 4), '中');
  assert.equal(cut('中文', 3), '中');
  assert.equal(cut('中文', 2), '');
  assert.equal(cut('😀a', 3), '');
  assert.equal(cut('a😀', 5), 'a😀');
  assert.equal(result({ blocks: { role: 'user' }, truncate: 100 }, body('中')), body('中'));
});

test('a body with no blocks stays as it is', () => {
  for (const [path, body] of [['/v1/models', '{"a":"b"}'], ['/v1/messages', 'not json']]) {
    assert.equal(result({ blocks: {}, remove: true }, body, { path }), body);
    assert.equal(result({ replace: 'a', with: 'x', blocks: {} }, body, { path }), body);
    assert.equal(judged({ blocks: {} }, body, { path }), false);
  }
});

test('a pattern that does not compile is a rule error', () => {
  fails('rule-error', () => run({ replace: '(', with: 'x' }, '{"a":"b"}'));
  fails('rule-error', () => judged({ path: { re: '(' } }));
  fails('rule-error', () => judged({ body: { re: '\\p' } }, 'x'), 'the u flag is on');
});

test('the body literal: byte hits, decoded hits, and what only looks like a hit', () => {
  const cases = [
    ['<system-reminder>', '{"a":"\\u003csystem-reminder\\u003e"}', true],
    ['<system-reminder>', '{"a":"<system-reminder>"}', true],
    ['中文', '{"a":"\\u4e2d\\u6587"}', true],
    ['ALPHA', '{"a":"\\nALPHA"}', true],
    ['nALPHA', '{"a":"\\nALPHA"}', false],
    ['41ALPHA', '{"a":"\\u0041ALPHA"}', false],
    ['AALPHA', '{"a":"\\u0041ALPHA"}', true],
    ['\\n', '{"a":"\\nx"}', false],
    ['a\\b', '{"a":"a\\\\b"}', true],
    ['model', '{"model":1}', true],
    ['BETA', '{"a":"ALPHA"}', false],
    ['nALPHA', 'x\\nALPHA', true],
    ['message_stop', 'not json message_stop', true],
  ];
  for (const [literal, body, want] of cases) assert.equal(judged({ body: literal }, body), want, `${literal} in ${body}`);
});

test('a compressed body is judged by what it says', () => {
  const body = Buffer.from('{"a":"\\u003cALPHA"}');
  assert.equal(judged({ body: '<ALPHA' }, zlib.gzipSync(body), { encoding: 'gzip' }), true);
  assert.equal(judged({ body: 'BETA' }, zlib.gzipSync(body), { encoding: 'gzip' }), false);
});

test('a regex reads the decoded strings and the text outside them', () => {
  const cases = [
    [{ re: '^中.$' }, '{"a":"\\u4e2d文"}', true],
    [{ re: '"stream":\\s*true' }, '{"stream": true}', true],
    [{ re: 'nALPHA' }, '{"a":"\\nALPHA"}', false],
    [{ re: '\\p{Script=Han}' }, '{"a":"\\u4e2d"}', true],
    [{ not: { re: 'x' } }, '{"a":"y"}', true],
    [['absent', { re: 'y' }], '{"a":"y"}', true],
  ];
  for (const [condition, body, want] of cases) assert.equal(judged({ body: condition }, body), want, body);
});

test('an event is judged on the event: its lines, and the strings of its data', () => {
  const sse = { sse: true };
  assert.equal(judged({ body: 'message_stop' }, 'event: message_stop\ndata: {}\n\n', sse, 'response'), true);
  assert.equal(judged({ body: '<x' }, 'data: {"t":"\\u003cx"}\n\n', sse, 'response'), true);
  assert.equal(judged({ body: 'x' }, ': ping\n\n', sse, 'response'), false);
  assert.equal(judged({ body: 'DONE' }, 'data: [DONE]\n\n', sse, 'response'), true);
});

test('the fields of a unit answer their conditions', () => {
  const headers = [['X-Session', 'abc'], ['Accept', 'a'], ['accept', 'b']], req_headers = [['X-Id', '7']];
  const extra = { headers, req_headers, status: 503, event_index: 4 };
  const cases = [
    [{ harness: 'any' }, true], [{ harness: ['codex', 'claude-code'] }, true], [{ harness: 'codex' }, false], [{ harness: ['codex'] }, false],
    [{ pid: 42 }, true], [{ pid: 43 }, false],
    [{ host: '*.EXAMPLE.com' }, true], [{ host: 'example.com' }, false], [{ host: { re: '^api\\.' } }, true],
    [{ path: '/v1/*' }, true], [{ path: '*messages' }, true], [{ path: '*1/m*' }, true], [{ path: '/v2/*' }, false], [{ path: '*' }, true],
    [{ method: 'POST' }, true], [{ method: ['GET', 'PUT'] }, false], [{ method: { not: 'GET' } }, true],
    [{ class: 'llm' }, true], [{ class: 'files' }, false],
    [{ header: { 'x-session': 'abc' } }, true], [{ header: { 'x-session': 'abd' } }, false], [{ header: { accept: 'a, b' } }, true], [{ header: { accept: 'b' } }, false], [{ header: { accept: '*b' } }, true],
    [{ header: { absent: '*' } }, false], [{ header: { absent: { not: 'x' } } }, true], [{ header: { 'X-Session': { re: '^a' } } }, true],
    [{ req_header: { 'x-id': '7' } }, true], [{ req_header: { 'x-id': '8' } }, false],
    [{ status: 503 }, true], [{ status: '5*' }, true], [{ status: 200 }, false],
    [{ event_index: 4 }, true], [{ event_index: 5 }, false],
    [{ method: 'POST', class: 'files' }, false], [{}, true],
  ];
  for (const [match, want] of cases) assert.equal(judged(match, '', extra), want, JSON.stringify(match));
  for (const match of [{ event_index: 0 }, { status: { not: 200 } }]) assert.equal(judged(match), false, 'a field the unit lacks is no hit');
  assert.equal(full.decode(unitOf('', { body: null })).text, '', 'no body reads as empty');
});

test('decode undoes every content encoding and says so when it cannot', () => {
  const text = '{"a":"中"}', raw = Buffer.from(text);
  const cases = [['gzip', zlib.gzipSync(raw)], ['deflate', zlib.deflateSync(raw)], ['br', zlib.brotliCompressSync(raw)], ['GZIP', zlib.gzipSync(raw)], ['identity', raw], [null, raw], ['gzip, br', zlib.brotliCompressSync(zlib.gzipSync(raw))]];
  if (zlib.zstdCompressSync) cases.push(['zstd', zlib.zstdCompressSync(raw)]);
  for (const [encoding, bytes] of cases) {
    const out = full.decode(unitOf(bytes, { encoding }));
    assert.deepEqual([out.bytes, out.text], [raw, text], String(encoding));
  }
  fails('encoding', () => full.decode(unitOf(raw, { encoding: 'compress' })));
  fails('encoding', () => full.decode(unitOf(raw, { encoding: 'gzip' })));
  assert.equal(full.decode(unitOf(Buffer.from([0xff]))).text, null);
});

test('zstd without the runtime for it is an encoding skip', () => {
  const saved = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = undefined;
  try { fails('encoding', () => full.decode(unitOf('x', { encoding: 'zstd' }))); } finally { zlib.zstdDecompressSync = saved; }
});

test('a body over 64 MiB is too big, on the wire or once inflated', () => {
  const MIB = 1024 * 1024;
  assert.equal(full.decode(unitOf(Buffer.alloc(64 * MIB))).bytes.length, 64 * MIB);
  fails('too-big', () => full.decode(unitOf(Buffer.alloc(64 * MIB + 1))));
  fails('too-big', () => full.decode(unitOf(zlib.gzipSync(Buffer.alloc(64 * MIB + 1)), { encoding: 'gzip' })));
});

test('a repeated key: replace reaches every value, because a reader may take any of them', () => {
  for (const body of ['{"a":"SECRET","a":"x"}', '{"a":"x","a":"SECRET"}', '{"o":{"a":"SECRET","b":1,"a":["SECRET"]}}']) {
    assert.ok(!result({ replace: 'SECRET', with: 'x' }, body).includes('SECRET'), body);
  }
});

test('json and blocks refuse an object with a repeated key: a removal would bring the hidden value back', () => {
  for (const action of [{ json: '/b', remove: true }, { json: '/b', set: 'x' }, { json: '/a', remove: true }, { json: '/o/b', remove: true }]) {
    fails('rule-error', () => run(action, '{"b":"SECRET","a":1,"b":"x","o":{"b":1}}'));
  }
  assert.deepEqual(parsed({ json: '/o/b', remove: true }, '{"o":{"b":1,"c":2}}'), { o: { c: 2 } });
});
