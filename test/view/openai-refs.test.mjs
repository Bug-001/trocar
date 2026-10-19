// test/view/openai-refs.test.mjs — the flat-lane (OpenAI) board path ships LOCATORS (4.2:55 「看全文=回源」),
// and every locator slices the verbatim wire bytes (AC-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { parseTextRef } from '../../src/etl/orchestrator.mjs';

const withStream = (r, s = 'capture-2026-10-06.ndjson') => (Object.defineProperty(r, '_stream', { value: s, enumerable: false }), r);
// Deliberately odd spacing: a re-serialization would not reproduce these bytes.
const RESP_BODY = '{"model":"gpt-x","instructions":"You are Codex.","tools":[{"type":"function","name":"shell", "parameters":{"type":"object"}}],' +
  '"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi  there"}]},' +
  '{"type":"function_call","name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"c1"},' +
  '{"type":"function_call_output","call_id":"c1","output":"a.txt"}]}';
const CHAT_BODY = '{"model":"deepseek-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":[{"type":"text","text":"q"}]},' +
  '{"role":"assistant","content":null,"tool_calls":[{"id":"t1","type":"function","function":{"name":"f","arguments":"{}"}}]},' +
  '{"role":"tool","tool_call_id":"t1","content":"r"}],"tools":[{"type":"function","function":{"name":"f","parameters":{}}}]}';
const mk = (id, endpoint, body) => withStream({ id, ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint,
  req_headers: { 'session-id': 'S' }, req_body: body, resp: { status: 200, kind: 'sse', raw_sse: [] } });

for (const [name, endpoint, body, n] of [['Responses', '/v1/responses', RESP_BODY, 5], ['Chat', '/v1/chat/completions', CHAT_BODY, 5]]) {
  test(`${name}: every block ships a text_ref whose slice is a verbatim sub-value of req_body`, () => {
    const A = assembleSession([mk('r1', endpoint, body)]);
    const flat = A.steps[0].flat;
    assert.equal(flat.length, n);
    for (const b of flat) {
      assert.ok(b.text_ref, `${b.sec}/${b.kind} has a locator`);
      assert.equal(b.unaddressable, undefined);
      assert.equal(b.block, undefined, 'the body is not shipped');
      const { start, end, recordId } = parseTextRef(b.text_ref);
      assert.equal(recordId, 'r1');
      const slice = body.slice(start, end);
      assert.doesNotThrow(() => JSON.parse(slice), 'the span covers exactly one JSON value');
    }
    assert.equal(A.steps[0].rec.request.model !== undefined, true, 'the slim rec keeps the model for cost');
    assert.equal(A.steps[0].rec.request.input, undefined, 'the body is NOT shipped (4.2:55)');
    assert.equal(A.steps[0].rec.request.messages, undefined);
    assert.ok(A.steps[0].comp, 'composition is still computed from the full blocks');
  });
}

test('each block slices exactly its own value on the wire (odd spacing preserved)', () => {
  const at = (flat, pred) => { const { start, end } = parseTextRef(flat.find(pred).text_ref); return [start, end]; };
  let f = assembleSession([mk('r1', '/v1/responses', RESP_BODY)]).steps[0].flat;
  assert.equal(RESP_BODY.slice(...at(f, (b) => b.sec === 'tools')), '{"type":"function","name":"shell", "parameters":{"type":"object"}}');
  assert.equal(RESP_BODY.slice(...at(f, (b) => b.sec === 'system')), '"You are Codex."');
  assert.equal(RESP_BODY.slice(...at(f, (b) => b.kind === 'text')), '{"type":"input_text","text":"hi  there"}');
  assert.equal(RESP_BODY.slice(...at(f, (b) => b.kind === 'tool_result')), '{"type":"function_call_output","call_id":"c1","output":"a.txt"}');
  f = assembleSession([mk('c1', '/v1/chat/completions', CHAT_BODY)]).steps[0].flat;
  assert.equal(CHAT_BODY.slice(...at(f, (b) => b.sec === 'system')), '"sys"');
  assert.equal(CHAT_BODY.slice(...at(f, (b) => b.kind === 'tool_use')), '{"id":"t1","type":"function","function":{"name":"f","arguments":"{}"}}');
  assert.equal(CHAT_BODY.slice(...at(f, (b) => b.kind === 'tool_result')), '"r"');
  assert.equal(CHAT_BODY.slice(...at(f, (b) => b.sec === 'tools')), '{"type":"function","function":{"name":"f","parameters":{}}}');
});

test('a string `input` is one user block, not dropped', () => {
  const A = assembleSession([mk('r1', '/v1/responses', '{"model":"m","input":"just text"}')]);
  const msgs = A.steps[0].flat.filter((b) => b.sec === 'messages');
  assert.equal(msgs.length, 1);
  assert.equal(parseTextRef(msgs[0].text_ref).start, '{"model":"m","input":'.length, 'the ref points at the string value itself');
});

test('a record the resolver cannot address keeps its blocks inline and says so', () => {
  const r = { id: 'r1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/v1/responses', req_headers: {}, req_body: RESP_BODY, resp: { status: 200, kind: 'sse', raw_sse: [] } };
  for (const b of assembleSession([r]).steps[0].flat) {
    assert.equal(b.text_ref, undefined);
    assert.match(b.unaddressable, /NOT resolved from the raw capture/);
  }
});

