import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { linearContext } from '../../src/view/analyze.mjs';
import { blockPreview } from '../../src/view/blockmeta.mjs';

// Three "same output, less work" rewrites of the session view (D62 / spec 1.6 §3.1) each replaced a
// build-then-throw-away with a bounded or resumable one. Each is only legitimate while its output is
// IDENTICAL to the form it replaced, and nothing above would notice if it drifted — a preview would
// read slightly differently, a block key would diff against itself, a prefix digest would stop being
// reproducible. So each gets its old definition back here, as the oracle.

// ── 1. the collapsed row's preview: shorten() ────────────────────────────────────────────────────
// Was `String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90)` over the WHOLE body text.
const PREVIEW_REF = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
const long = (unit, n) => unit.repeat(n);
const PREVIEW_CASES = [
  '', ' ', '   \t\n ', 'plain text',
  '  leading', 'trailing   ', '  both  ', 'a  b\t\tc\n\nd',
  '\u00a0\u2003nbsp and em space\u2028\u2029', 'emoji 🙂\t🙂 and 中文  字',
  long('x', 500), long('word ', 300), long(' ', 5000) + 'after a lot of whitespace',
  long('a b', 200), long('\n', 1000), long('中', 300), 'exact' + long(' ', 90) + 'end',
  long('ab ', 30) + 'cut here', long('.', 89), long('.', 90), long('.', 91),
];
test('the preview is whitespace-collapsed, trimmed and clipped exactly as the regex form was', () => {
  for (const s of PREVIEW_CASES) {
    assert.equal(blockPreview({ sec: 'system', text: s }), PREVIEW_REF(s), `preview of ${JSON.stringify(s.slice(0, 40))}…`);
  }
});

// ── 2. the block key: hash(text.slice(0, 4096)) ──────────────────────────────────────────────────
// The text is now built WITH the 4 096-char bound instead of in full and sliced after. The bound is
// what the key means, so it is pinned by its consequences: identical first 4 096 chars → one key,
// a difference inside them → two. Every block kind whose text is a concatenation is covered, because
// capping a part before the join is only the same string while the join stays prefix-stable.
const CAP = 4096;
const keysOf = (messages) => linearContext({ system: [], tools: [], messages }).map((b) => b.key);
const msg = (block) => [{ role: 'user', content: [block] }];
const PAD = long('p', CAP);
const KEY_CASES = [
  ['text', (tail) => ({ type: 'text', text: PAD + tail })],
  ['tool_result · string content', (tail) => ({ type: 'tool_result', tool_use_id: 'tu_1', content: PAD + tail })],
  ['tool_result · array content', (tail) => ({ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: PAD }, { type: 'text', text: tail }] })],
  ['tool_use · json input', (tail) => ({ type: 'tool_use', id: 'tu_1', name: 'Write', input: { content: PAD + tail } })],
];
test('a block key sees the first 4096 chars of its text and nothing past them', () => {
  for (const [what, make] of KEY_CASES) {
    const [a] = keysOf(msg(make('AAAA')));
    const [b] = keysOf(msg(make('BBBB')));
    assert.equal(a, b, `${what}: a difference PAST the 4096-char bound must not change the key`);
  }
  // …and the bound is not so tight that a real difference inside it is lost.
  for (const [what, make] of KEY_CASES) {
    const [a] = keysOf(msg(make('')));
    const near = make('');
    const [b] = keysOf(msg(JSON.parse(JSON.stringify(near).replace(/p/, 'q')))); // flip the FIRST char
    assert.notEqual(a, b, `${what}: a difference inside the bound must change the key`);
  }
});
// Short blocks never reached the bound at all: their keys must be unchanged by the rewrite, which is
// only true if every branch still builds the same text. Pin the whole vocabulary against itself.
test('every block kind still keys on its own text (short blocks, no bound in play)', () => {
  const kinds = [
    'plain string block',
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'thought', signature: 'sig' },
    { type: 'redacted_thinking', signature: 'sig' },
    { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.txt' } },
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: true },
    { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'a' }, { type: 'image' }] },
    { type: 'image', source: { media_type: 'image/png' } },
    { type: 'document', source: { media_type: 'application/pdf' } },
  ];
  const keys = kinds.map((b) => keysOf(msg(b))[0]);
  assert.equal(new Set(keys).size, keys.length, 'each block kind keys differently from the others');
  for (const [i, b] of kinds.entries()) assert.equal(keysOf(msg(b))[0], keys[i], 'and the same block keys the same twice');
  // is_error / a changed id are part of the text, so they must move the key
  assert.notEqual(keys[5], keys[6], 'an error result keys differently from a successful one');
});

// ── 3. the prefix SHA-256: a RESUMED hash must equal a from-scratch one ──────────────────────────
// The chain resumes each call's digest from the previous call's state at the first diverging block,
// so the SAME call now reaches the same digest by a different route depending on what came before it.
// The digest is defined over that call's own blocks [0, idx) alone, so the route must not show.
const turns = (n) => {
  const m = [];
  for (let k = 1; k <= n; k++) {
    m.push({ role: 'user', content: [{ type: 'text', text: `U${k} ${long('ctx ', 200)}` }] });
    if (k < n) m.push({ role: 'assistant', content: [{ type: 'text', text: `A${k} ${long('reply ', 200)}` }] });
  }
  return m;
};
const call = (i, { status = 200, sys = 'SYS', turnCount }) => ({
  id: `req_0000${i}`, ts_request: `2026-10-19T00:00:0${i}.000Z`,
  is_llm_call: true, endpoint: '/v1/messages',
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.0.0' },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', system: [{ type: 'text', text: sys }], tools: [], messages: turns(turnCount) }),
  resp: { status, kind: 'json', body: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 9 } } },
});
const digestOf = (records, id) => {
  const s = assembleSession(records).steps.find((c) => c.id === id);
  return { pfx: s.prefixSha256, idx: s.cacheBreak.idx, gt: s.gt };
};
test('a call\'s prefix digest is the same whichever call the hash resumed from', () => {
  const c3 = call(3, { turnCount: 5 });
  const short = digestOf([call(2, { turnCount: 4 }), c3], 'req_00003');
  assert.match(short.pfx, /^[0-9a-f]{64}$/, 'sanity: a full SHA-256 hex');
  // one more identical turn in front: a longer chain, the same divergence for #3
  const longer = digestOf([call(1, { turnCount: 3 }), call(2, { turnCount: 4 }), c3], 'req_00003');
  assert.equal(longer.idx, short.idx, 'sanity: #3 diverges from #2 at the same block either way');
  assert.equal(longer.pfx, short.pfx, 'the digest is over #3\'s own prefix bytes, not over the chain');
  // a FAILED call in between: #3 resumes from #1's state, two calls back
  const skipped = digestOf([call(2, { turnCount: 4 }), call(9, { status: 502, sys: 'MUTATED', turnCount: 4 }), c3], 'req_00003');
  assert.equal(skipped.pfx, short.pfx, 'resuming across a call that never cached must not change the digest');
});
test('two prefixes that differ in bytes get different digests, equal ones the same', () => {
  const a = digestOf([call(1, { turnCount: 3 }), call(2, { turnCount: 4 })], 'req_00002');
  // the same two calls again: the digest is reproducible, which is the whole claim of D17④
  const b = digestOf([call(1, { turnCount: 3 }), call(2, { turnCount: 4 })], 'req_00002');
  assert.equal(a.pfx, b.pfx, 'same prefix bytes → same digest');
  // a system block changed in #2 moves the divergence to block 0: no reusable prefix, so no digest
  const c = digestOf([call(1, { turnCount: 3 }), call(2, { turnCount: 4, sys: 'OTHER' })], 'req_00002');
  assert.equal(c.idx, 0, 'sanity: the changed system block IS the first block');
  assert.equal(c.pfx, null, 'nothing before the divergence → no prefix to claim byte-identity for');
  // changed further in: #2 and #3 of a session whose history was edited share a prefix of the same
  // LENGTH but not the same bytes, so the digests must differ
  const edited = [call(1, { turnCount: 3, sys: 'SYS-2' }), call(2, { turnCount: 4, sys: 'SYS-2' })];
  const d = digestOf(edited, 'req_00002');
  assert.ok(d.idx > 0 && d.pfx, 'sanity: #2 still shares a prefix with #1');
  assert.equal(d.idx, a.idx, 'sanity: the same number of shared blocks');
  assert.notEqual(d.pfx, a.pfx, 'the same prefix LENGTH over different bytes → a different digest');
});
