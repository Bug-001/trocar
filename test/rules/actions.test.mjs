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
  const state = { bytes, text, headers: unit.headers, steps: [] };
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
