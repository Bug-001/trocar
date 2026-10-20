// test/helpers/cc-threads.mjs — a small synthetic Claude Code session on Anthropic Message Threads (3.1:35, the wire
// shape measured on Claude Code 2.1.304, 2026-10-20). No captured bytes: every record is built here, and its reply is
// shaped by the collector's own shapeResponse from a synthetic SSE stream, so resp.* is exactly what the collector writes.
//   main  M0 create → M1 continue(M0) → M2 continue(M1)        system / tools in full only on M0
//   sub   S0 create → S1 continue(S0)                           interleaved with the main thread
//   aux   A  no thread, its whole context in its own body      (an auxiliary call such as a suggestion)
// File order is not ts order (the collector writes a call when it ends).
import { shapeResponse } from '../../src/collector/core/record/body.mjs';

const SESSION = 'sess-threads';
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
// A streamed reply: message_start carries the id a continuation names as previous_message_id.
export function replyOf(id, blocks, usage = { input_tokens: 3, cache_read_input_tokens: 1000, output_tokens: 5 }) {
  const ev = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-x', content: [], usage } }];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
  ev.push({ type: 'message_stop' });
  return shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(sse(ev)) });
}

export function record(id, ts, body, reply) {
  return {
    id, is_llm_call: true, ts_request: ts, endpoint: '/v1/messages?beta=true', method: 'POST',
    req_headers: { 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': SESSION, 'user-agent': 'claude-cli/2.1 (external, cli)' },
    req_body: JSON.stringify(body), resp: reply,
  };
}

const billing = (n) => ({ type: 'text', text: `x-anthropic-billing-header: cc_version=2.1; cch=${n};` });
const tool = (name) => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: { x: { type: 'string' } } } });
export const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
export const sysMsg = (...content) => ({ role: 'system', content });
const meta = { user_id: JSON.stringify({ device_id: 'd', session_id: SESSION }) };

export function threadSession() {
  const M0 = record('M0', '2026-10-20T00:00:01.000Z', {
    model: 'claude-opus-x', thread: { type: 'create' }, metadata: meta, max_tokens: 1000, stream: true,
    system: [billing(1), { type: 'text', text: 'You are Claude Code, the main agent.' }, { type: 'text', text: 'Working directory: /w' }],
    tools: [tool('Read'), tool('Agent')],
    messages: [user('please look at the repo'),
      sysMsg({ type: 'text', text: '<env>mac</env>' }, { type: 'tool_addition', tool: { type: 'tool_definition', definition: tool('Grep') } })],
  }, replyOf('msg_m0', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/w/a.txt' } }]));
  const S0 = record('S0', '2026-10-20T00:00:02.000Z', {
    model: 'claude-opus-x', thread: { type: 'create' }, metadata: meta, max_tokens: 1000, stream: true,
    system: [billing(2), { type: 'text', text: 'You are a Claude agent. cc_is_subagent=true' }],
    tools: [tool('Read')],
    messages: [user('subagent task: count files')],
  }, replyOf('msg_s0', [{ type: 'tool_use', id: 'tu_s', name: 'Read', input: { file_path: '/w/b.txt' } }]));
  const M1 = record('M1', '2026-10-20T00:00:03.000Z', {
    model: 'claude-opus-x', thread: { type: 'continue', previous_message_id: 'msg_m0' }, diagnostics: { previous_message_id: 'msg_m0' },
    metadata: meta, max_tokens: 1000, stream: true, system: [billing(3)], tools: [],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file a' }] }, sysMsg({ type: 'text', text: '<total_tokens>900000</total_tokens>' })],
  }, replyOf('msg_m1', [{ type: 'text', text: 'Done reading.' }]));
  const S1 = record('S1', '2026-10-20T00:00:04.000Z', {
    model: 'claude-opus-x', thread: { type: 'continue', previous_message_id: 'msg_s0' }, metadata: meta, max_tokens: 1000, stream: true,
    system: [billing(4)],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_s', content: 'file b' }] }],
  }, replyOf('msg_s1', [{ type: 'text', text: '2 files' }]));
  const A = record('A', '2026-10-20T00:00:05.000Z', {
    model: 'claude-opus-x', metadata: meta, max_tokens: 100, system: [billing(5), { type: 'text', text: 'SUGGESTION MODE' }],
    messages: [user('please look at the repo'), { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] }, user('[SUGGESTION MODE] next?')],
  }, replyOf('msg_a', [{ type: 'text', text: 'run tests' }]));
  const M2 = record('M2', '2026-10-20T00:00:06.000Z', {
    model: 'claude-opus-x', thread: { type: 'continue', previous_message_id: 'msg_m1' }, metadata: meta, max_tokens: 1000, stream: true,
    system: [billing(6)],
    messages: [user('now summarise')],
  }, replyOf('msg_m2', [{ type: 'text', text: 'Summary.' }]));
  return { M0, S0, M1, S1, A, M2, fileOrder: [M2, S1, M0, A, S0, M1] };
}
