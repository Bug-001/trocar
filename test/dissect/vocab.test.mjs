// test/dissect/vocab.test.mjs — the neutral block vocabulary (3.1 adapter contract): a Responses input item
// is classed by the wire's own naming, never by a tool or product name, and every block still slices its own bytes (AC-1);
// a `*_tool_result` block is a tool result on the board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { compBuckets, COMP_KEYS, slimBlock } from '../../src/view/blockmeta.mjs';

const withStream = (r) => (Object.defineProperty(r, '_stream', { value: 'capture-2026-10-21.ndjson', enumerable: false }), r);
const mk = (body) => withStream({ id: 'r1', ts_request: '2026-10-21T00:00:00Z', is_llm_call: true, endpoint: '/v1/responses',
  req_headers: { 'session-id': 'S' }, req_body: body, resp: { status: 200, kind: 'sse', raw_sse: [] } });

// axes: call_id present / absent × type suffix × arguments string / object / none
const SUFFIX = { call: 'x_call', output: 'x_call_output', other: 'x_note' };
const cases = [];
for (const cid of [true, false]) for (const suf of Object.keys(SUFFIX)) for (const args of ['string', 'object', 'none']) {
  const item = { type: SUFFIX[suf], id: 'i1', status: 'completed', ...(cid ? { call_id: 'c1' } : {}) };
  if (args === 'string') item.arguments = '{"q": 1}';
  if (args === 'object') item.arguments = { q: 1 };
  if (suf === 'output') item.output = 'done';
  const want = suf === 'output' ? ['tool_result', 'tool'] : suf === 'call' ? [cid ? 'tool_use' : 'server_tool_use', 'assistant'] : ['json', 'assistant'];
  cases.push({ item, want });
}
cases.push({ item: { type: 'x_note', role: 'user', note: 'n' }, want: ['json', 'user'] });

test('Responses items: kind / role by the type suffix and call_id, each block a verbatim sub-value of req_body', () => {
  for (const { item, want } of cases) {
    const raw = JSON.stringify(item).replace(/,/g, ' ,  '); // odd spacing: only the wire's own bytes match
    const body = `{"model":"m","input":[ ${raw} ]}`;
    const flat = assembleSession([mk(body)]).steps[0].flat.filter((b) => b.sec === 'messages');
    assert.equal(flat.length, 1, raw);
    assert.deepEqual([flat[0].kind, flat[0].role], want, raw);
    const { start, end } = parseTextRef(flat[0].text_ref);
    assert.equal(body.slice(start, end), raw, raw);
    if (want[0] === 'json') { const h = flat[0].head; assert.notEqual(h.tag, 'say', raw); assert.ok(h.label, raw); }
  }
});

test('a *_tool_result block is in the tool_result bucket and heads as an observation', () => {
  const b = { sec: 'messages', kind: 'x_tool_result', role: 'user', block: { type: 'x_tool_result', tool_use_id: 't', content: 'abc' } };
  const c = compBuckets([b]);
  assert.deepEqual(Object.keys(c), COMP_KEYS);
  assert.ok(c.tool_result > 0);
  for (const k of COMP_KEYS) if (k !== 'tool_result') assert.equal(c[k], 0, k);
  assert.ok(slimBlock(b, null).head.tag.startsWith('observation'));
});
