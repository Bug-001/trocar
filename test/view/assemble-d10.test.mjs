import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';

// RFC 3.1 dissector · D18a (2026-07-16 amendment): the board must render the PRODUCT capture format (D10:
// verbatim req_body STRING + resp), not just the demo v0 shape. Before the CC dissector's board-intake
// (hydrateForBoard), a D10 record rendered EMPTY (analyze reads .request, which D10 lacks). This gates it.

// a minimal D10 capture record: req_body = the VERBATIM wire request STRING, response under `resp` (D10)
function d10Record(over = {}) {
  const body = {
    model: 'claude-opus-4',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    tools: [{
      name: 'Read',
      description: 'Read a file from the local filesystem.',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] },
    }],
    messages: [{ role: 'user', content: 'read config.json please' }],
    max_tokens: 4096,
    ...over,
  };
  return {
    id: 'req_d10', is_llm_call: true, ts_request: '2026-07-16T00:00:00Z',
    request_headers: { 'x-claude-code-session-id': 's-d10', 'user-agent': 'claude-cli/1.2' },
    req_body: JSON.stringify(body),
    resp: { status: 200, kind: 'sse', usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0 }, text: 'ok', stop_reason: 'end_turn' },
    capture: 'reverse-proxy',
  };
}

test('board renders a D10 capture (req_body string) — not empty', () => {
  const A = assembleSession([d10Record()]);
  const lane = (A.lanes || []).find((l) => l.kind === 'main') || (A.lanes || [])[0];
  const call = lane && lane.calls[0];
  assert.ok(call, 'D10 record produced a main-lane call');
  const flat = call.flat || [];
  assert.ok(flat.length >= 3, `context window has blocks (got ${flat.length})`);
  assert.deepEqual([...new Set(flat.map((b) => b.sec))].sort(), ['messages', 'system', 'tools']);
});

test('D10 tools render VERBATIM (full input_schema), not metadata — faithful original context', () => {
  const A = assembleSession([d10Record()]);
  const call = ((A.lanes || []).find((l) => l.kind === 'main') || {}).calls[0];
  const tool = (call.flat || []).find((b) => b.sec === 'tools');
  assert.ok(tool, 'a tools block is present');
  assert.equal(tool.verbatim, true, 'tool is verbatim (input_schema present in the wire req_body)');
  assert.ok(tool.schema && tool.schema.properties, 'the full input_schema is carried, not just param names');
  assert.deepEqual(Object.keys(tool.schema.properties).sort(), ['file_path', 'limit']);
  assert.equal(tool.name, 'Read');
});

test('D10 system/message block text is byte-faithful to the wire req_body (AC-1 for D10)', () => {
  const rec = d10Record();
  const body = JSON.parse(rec.req_body);
  const A = assembleSession([rec]);
  const call = ((A.lanes || []).find((l) => l.kind === 'main') || {}).calls[0];
  const flat = call.flat || [];
  const sys = flat.find((b) => b.sec === 'system');
  assert.equal(sys.text, body.system[0].text, 'system block text === verbatim req_body system text');
  const userText = flat.filter((b) => b.sec === 'messages').map((b) => { const bl = b.block; return typeof bl === 'string' ? bl : (bl && bl.text) || ''; });
  assert.ok(userText.some((t) => t.includes('read config.json please')), 'user text is verbatim in the window');
});

test('D10 usage bakes into neutral canonical roles + response is bridged (resp→response)', () => {
  const A = assembleSession([d10Record()]);
  const call = ((A.lanes || []).find((l) => l.kind === 'main') || {}).calls[0];
  assert.deepEqual(call.usage, { read: 0, create: 0, fresh: 12, out: 7 }, 'neutral usage baked from resp.usage');
});

test('hydrate is a no-op for v0 records (already carry .request)', () => {
  // a v0-shaped record: has .request (object) + .response — hydrate must leave it untouched
  const v0 = {
    id: 'req_v0', is_llm_call: true, ts_request: '2026-07-16T00:00:01Z',
    request_headers: { 'x-claude-code-session-id': 's-v0', 'user-agent': 'claude-cli/1.2' },
    request: { model: 'claude-opus-4', system: [{ type: 'text', text: 'hi' }], tools: [], messages: [{ role: 'user', content: 'yo' }], message_count: 1, tool_count: 0, context_chars: 10 },
    response: { status: 200, usage: { input_tokens: 3, output_tokens: 1 }, text: 'ok' },
  };
  const A = assembleSession([v0]);
  const call = (A.lanes || []).flatMap((l) => l.calls || [])[0]; // lane-agnostic: this minimal record may classify off-main
  assert.ok(call && (call.flat || []).length >= 2, 'v0 record still renders (system + messages)');
});
