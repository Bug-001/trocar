// test/helpers/wire-records.mjs — the seven wire shapes (Anthropic SSE / JSON, Responses SSE / JSON / WS, Chat SSE / JSON) as records the
// collector writes, with every block type each one carries. Every body holds a sentinel `S_<name>`, so a reader can follow one piece of
// content from the stored bytes to what is drawn. test/helpers/seven-shapes.mjs is the seven harnesses' requests, a different axis.
import { shapeResponse } from '../../src/collector/core/record/body.mjs'

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const sseResp = (text) => shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(text) })
const jsonResp = (body, tail = '') => shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify(body) + tail) })
// what a record from D40 on says of its bodies; a record from before it has no such field
const wire = { body_wire_bytes: { req: 1, resp: 1 } }
/** A sentinel in a body. Base64 has no `_`, so what is decoded holds the second form. */
export const SENTINEL = /S_[a-z0-9_]+|Sb64[a-z0-9]+/g
// a 1×1 PNG's header, then the sentinel, padded to whole base64 quads: decodes, and reads as an image
const PNG_HEAD = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1') + '\0\0\0\x0dIHDR\0\0\0\x01\0\0\0\x01'
const b64 = (name) => Buffer.from(PNG_HEAD, 'latin1').toString('base64') + `Sb64${name}`.padEnd(Math.ceil((4 + name.length) / 4) * 4, 'A')
// ── Anthropic ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const anthReq = {
  model: 'm', max_tokens: 10, stream: true,
  system: [{ type: 'text', text: 'S_sys_text' }],
  tools: [{ name: 'Bash', description: 'S_tool_desc', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'S_tool_param' } } } },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'S_user_text' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64('img') } },
      { type: 'image', source: { type: 'url', url: 'https://x.test/S_img_url.png' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64('doc') }, title: 'S_doc_title' },
      { type: 'tool_addition', tool: { definition: { name: 'Added', description: 'S_add_desc', input_schema: { type: 'object', properties: { p: { type: 'string', description: 'S_add_param' } } } } } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'S_think_plain', signature: 'S_think_sig' },
      { type: 'thinking', thinking: '', signature: 'S_think_sig_only' },
      { type: 'redacted_thinking', data: 'S_redacted_data' },
      { type: 'text', text: 'S_asst_text' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'S_use_cmd', description: 'S_use_descr' } },
      { type: 'server_tool_use', id: 'stu1', name: 'web_search', input: { query: 'S_srv_query' } },
      { type: 'web_search_tool_result', tool_use_id: 'stu1', content: [{ type: 'web_search_result', title: 'S_srv_title', url: 'https://x.test/S_srv_url', encrypted_content: 'S_srv_enc' }] }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'S_res_string' },
      { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'S_res_part_text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64('resimg') } }] },
      { type: 'tool_result', tool_use_id: 'tu3', content: [{ type: 'tool_reference', tool_name: 'S_res_toolref' }] }] },
  ],
}
const anthBlocks = [
  { start: { type: 'thinking', thinking: '', signature: '' }, deltas: [{ type: 'thinking_delta', thinking: 'S_r_think' }, { type: 'signature_delta', signature: 'S_r_sig' }] },
  { start: { type: 'redacted_thinking', data: 'S_r_redacted' }, deltas: [] },
  { start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'S_r_text' }, { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'S_r_citation', url: 'https://x.test/c' } }] },
  { start: { type: 'tool_use', id: 't9', name: 'Bash', input: {} }, deltas: [{ type: 'input_json_delta', partial_json: '{"command":"S_r_cmd"}' }] },
  { start: { type: 'server_tool_use', id: 's9', name: 'web_search', input: {} }, deltas: [{ type: 'input_json_delta', partial_json: '{"query":"S_r_srv_query"}' }] },
  { start: { type: 'web_search_tool_result', tool_use_id: 's9', content: [{ type: 'web_search_result', title: 'S_r_srv_title', url: 'https://x.test/S_r_srv_url', encrypted_content: 'S_r_srv_enc' }] }, deltas: [] },
  { start: { type: 'mcp_tool_use', id: 'm9', name: 'S_r_mcp_name', server_name: 'x', input: { a: 'S_r_mcp_in' } }, deltas: [] },
]
const anthEvents = [{ type: 'message_start', message: { id: 'msg1', model: 'm', role: 'assistant', usage: { input_tokens: 1 } } },
  ...anthBlocks.flatMap((b, index) => [{ type: 'content_block_start', index, content_block: b.start }, { type: 'ping' },
    ...b.deltas.map((delta) => ({ type: 'content_block_delta', index, delta })), { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
const anthJsonBody = { id: 'msg2', role: 'assistant', model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 }, content: [
  { type: 'thinking', thinking: 'S_r_think', signature: 'S_r_sig' }, { type: 'redacted_thinking', data: 'S_r_redacted' },
  { type: 'text', text: 'S_r_text', citations: [{ type: 'x', cited_text: 'S_r_citation' }] }, { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'S_r_cmd' } },
  { type: 'server_tool_use', id: 's9', name: 'web_search', input: { query: 'S_r_srv_query' } },
  { type: 'web_search_tool_result', tool_use_id: 's9', content: [{ type: 'web_search_result', title: 'S_r_srv_title', url: 'https://x.test/S_r_srv_url', encrypted_content: 'S_r_srv_enc' }] },
  { type: 'mcp_tool_use', id: 'm9', name: 'S_r_mcp_name', server_name: 'x', input: { a: 'S_r_mcp_in' } }] }

// ── Responses ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const respReq = {
  model: 'm', instructions: 'S_sys_text',
  tools: [{ type: 'function', name: 'shell', description: 'S_tool_desc', parameters: { type: 'object', properties: { cmd: { type: 'string', description: 'S_tool_param' } } } },
    { type: 'custom', name: 'apply_patch', description: 'S_custom_desc', format: { type: 'grammar', definition: 'S_custom_grammar' } },
    { type: 'web_search', search_context_size: 'S_ws_size', filters: { allowed: ['S_ws_filter'] } }],
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'S_user_text' }, { type: 'input_image', image_url: `data:image/png;base64,${b64('img')}` },
      { type: 'input_image', image_url: 'https://x.test/S_img_url.png' }, { type: 'input_file', filename: 'a.pdf', file_data: b64('doc') }] },
    { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'S_think_plain' }], content: [{ type: 'reasoning_text', text: 'S_think_content' }], encrypted_content: 'S_think_enc' },
    { type: 'reasoning', id: 'rs2', summary: [], encrypted_content: 'S_think_enc_only' },
    { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'S_asst_text' }, { type: 'refusal', refusal: 'S_refusal' }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'shell', arguments: '{"cmd":"S_use_cmd"}' },
    { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'shell', arguments: '{"cmd":"S_use_trunc' },
    { type: 'function_call_output', call_id: 'c1', output: 'S_res_string' },
    { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'S_res_part_text' }, { type: 'input_image', image_url: `data:image/png;base64,${b64('resimg')}` }] },
    { type: 'custom_tool_call', id: 'ct1', call_id: 'c3', name: 'apply_patch', input: '*** Begin Patch\nS_custom_input\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'c3', output: 'S_custom_out' },
    { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'S_srv_query' } },
    { type: 'item_reference', id: 'S_item_ref' },
    { type: 'compaction', id: 'cp1', encrypted_content: 'S_compaction' },
  ],
}
const respOut = [
  { type: 'reasoning', id: 'rs9', summary: [{ type: 'summary_text', text: 'S_r_think' }], encrypted_content: 'S_r_enc' },
  { type: 'reasoning', id: 'rs8', summary: [], encrypted_content: 'S_r_enc_only' },
  { type: 'message', id: 'm9', role: 'assistant', content: [{ type: 'output_text', text: 'S_r_text', annotations: [{ type: 'url_citation', url: 'https://x.test/S_r_annot' }] }, { type: 'refusal', refusal: 'S_r_refusal' }] },
  { type: 'function_call', id: 'fc9', call_id: 'c9', name: 'shell', arguments: '{"cmd":"S_r_cmd"}' },
  { type: 'custom_tool_call', id: 'ct9', call_id: 'c8', name: 'apply_patch', input: 'S_r_custom' },
  { type: 'web_search_call', id: 'ws9', status: 'completed', action: { type: 'search', query: 'S_r_srv_query' } },
  { type: 'image_generation_call', id: 'ig9', status: 'completed', result: 'S_r_img_b64' },
  { type: 'mcp_list_tools', id: 'ml9', server_label: 'S_r_mcp_label', tools: [] },
]
const responsesEvents = (id) => [{ type: 'response.created', response: { id } },
  ...respOut.flatMap((item, k) => [{ type: 'response.output_item.added', output_index: k, item: { ...item, ...(item.content ? { content: [] } : {}) } },
    { type: 'response.output_text.delta', output_index: k, delta: 'x' },
    { type: 'response.output_item.done', output_index: k, item }]),
  { type: 'response.completed', response: { id, status: 'completed', output: respOut, usage: { input_tokens: 10, output_tokens: 2 } } }]

// ── Chat ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const chatReq = {
  model: 'm', stream: true,
  tools: [{ type: 'function', function: { name: 'shell', description: 'S_tool_desc', parameters: { type: 'object', properties: { cmd: { type: 'string', description: 'S_tool_param' } } } } }],
  messages: [{ role: 'system', content: 'S_sys_text' },
    { role: 'user', content: [{ type: 'text', text: 'S_user_text' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64('img')}` } }, { type: 'image_url', image_url: { url: 'https://x.test/S_img_url.png' } },
      { type: 'file', file: { file_data: b64('doc') } }, { type: 'input_audio', input_audio: { data: 'S_audio_data', format: 'wav' } }] },
    { role: 'assistant', reasoning_content: 'S_think_plain', content: 'S_asst_text', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"S_use_cmd"}' } },
      { id: 'c3', type: 'function', function: { name: 'shell', arguments: '{"cmd":"S_use_trunc' } }] },
    { role: 'assistant', content: null, refusal: 'S_refusal' },
    { role: 'tool', tool_call_id: 'c1', content: 'S_res_string' },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'S_res_part_text' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64('resimg')}` } }] },
    { role: 'system', content: 'S_midsys' }],
}
const chunk = (delta, extra = {}) => ({ id: 'cc1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, ...extra }] })
const chatSse = [chunk({ role: 'assistant', reasoning_content: 'S_r_' }), chunk({ reasoning_content: 'think' }), chunk({ content: 'S_r_' }), chunk({ content: 'text' }),
  chunk({ tool_calls: [{ index: 0, id: 'c9', type: 'function', function: { name: 'shell', arguments: '{"cmd":' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '"S_r_cmd"}' } }] }),
  chunk({ refusal: 'S_r_refusal' }), { id: 'cc1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }]
const chatSseText = chatSse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
const chatJsonBody = { id: 'cc2', object: 'chat.completion', usage: { prompt_tokens: 1, completion_tokens: 2 }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', reasoning_content: 'S_r_think', content: 'S_r_text', refusal: 'S_r_refusal', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'shell', arguments: '{"cmd":"S_r_cmd"}' } }] } }] }
const chatRefusalBody = { id: 'cc3', object: 'chat.completion', usage: { prompt_tokens: 1, completion_tokens: 2 }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'S_r_refusal_only' } }] }
const at = '2026-11-02T10:00:00Z', sid = 'SX'
const anthBase = { ts_request: at, endpoint: '/v1/messages', host: 'api.anthropic.com', req_headers: { 'x-claude-code-session-id': sid }, req_body: JSON.stringify(anthReq), ...wire }
const oaBase = { ts_request: at, endpoint: '/v1/responses', host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' }, req_headers: { 'session-id': sid }, req_body: JSON.stringify(respReq), ...wire }
const chatBase = { ts_request: at, endpoint: '/v1/chat/completions', host: 'api.deepseek.com', proc: { pid: 3, exe: '/x/dsh', agent: 'deepseek' }, req_headers: { 'x-session-id': sid }, req_body: JSON.stringify(chatReq), ...wire }
const respJsonBody = { id: 'r2', status: 'completed', output: respOut, usage: { input_tokens: 10, output_tokens: 2 } }

// ── the shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const jsonWires = (tail = '') => ({ anthropic: { ...anthBase, resp: jsonResp(anthJsonBody, tail) }, responses: { ...oaBase, resp: jsonResp(respJsonBody, tail) },
  chat: [{ ...chatBase, resp: jsonResp(chatJsonBody, tail) }, { ...chatBase, ts_request: '2026-11-02T10:01:00Z', resp: jsonResp(chatRefusalBody, tail) }] })
const each = (wires, suffix, change = (r) => r) => Object.fromEntries(Object.entries(wires).map(([k, v]) => [`${k}-${suffix}`, [v].flat().map(change)]))
const preD40 = ({ body_wire_bytes, ...r }) => r

/** name → the records of that wire. */
export const WIRES = {
  'anthropic-sse': [{ ...anthBase, resp: sseResp(sse(anthEvents)) }],
  'responses-sse': [{ ...oaBase, resp: sseResp(sse(responsesEvents('r1'))) }],
  'responses-ws': [{ ...oaBase, transport: 'ws', flow_id: 'F', seq: 1, ws_ext: '', req_body: JSON.stringify({ type: 'response.create', ...respReq }), resp: { kind: 'ws', messages: responsesEvents('r3').map((e) => JSON.stringify(e)) } }],
  'chat-sse': [{ ...chatBase, resp: sseResp(chatSseText) }],
  ...each(jsonWires(), 'json'),
  ...each(jsonWires('\n'), 'json-newline'), // the wire text is not what re-serializing gives, so the record keeps it in raw
}
/** The JSON replies of records from before D40: the parse is all there is, its blocks still have refs. */
export const PRE_D40 = each(jsonWires(), 'json-pre-d40', preD40)

// A stream whose blocks' events interleave has no run of its own for any block: those blocks are read from their stored parse.
const textStart = (index) => ({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
const textDelta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const interleaved = [anthEvents[0], textStart(0), textStart(1), textDelta(0, 'S_il_first'), textDelta(1, 'S_il_second'), textDelta(0, ' more'), textDelta(1, ' more'),
  { type: 'content_block_stop', index: 0 }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
const chatInterleaved = [chunk({ role: 'assistant', reasoning_content: 'S_il_first' }), chunk({ content: 'S_il_second' }), chunk({ reasoning_content: ' more' }), chunk({ content: ' more' })]
export const INTERLEAVED = {
  'anthropic-sse': [{ ...anthBase, resp: sseResp(sse(interleaved)) }],
  'chat-sse': [{ ...chatBase, resp: sseResp(chatInterleaved.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n') }],
}

// The same tool calls on each wire, their input keys spelled as each harness spells them.
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const spelled = (input, key) => Object.fromEntries(Object.entries(input).map(([k, v]) => [key(k), v]))
const CALLS = [{ id: 'k1', name: 'Edit', input: { file_path: '/n/a.txt', old_string: 'S_edit_old', new_string: 'S_edit_new' }, result: 'S_edit_ack' },
  { id: 'k2', name: 'Read', input: { file_path: '/n/a.md' }, result: 'S_read_md' }]
const stop = { status: 200, kind: 'json', body: { id: 'x', usage: { input_tokens: 1, output_tokens: 1 } } }
const callRecords = (key) => {
  const calls = CALLS.map((c) => ({ ...c, input: spelled(c.input, key) }))
  return {
    anthropic: { ...anthBase, resp: stop, req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: calls.map(({ id, name, input }) => ({ type: 'tool_use', id, name, input })) },
      { role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: c.result })) }] }) },
    responses: { ...oaBase, resp: stop, req_body: JSON.stringify({ model: 'm', input: calls.flatMap((c) => [
      { type: 'function_call', id: `f${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.input) }, { type: 'function_call_output', call_id: c.id, output: c.result }]) }) },
    chat: { ...chatBase, resp: stop, req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) },
      ...calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.result }))] }) },
  }
}
export const CALL_WIRES = { ...each(callRecords((k) => k), 'snake'), ...each(callRecords(camel), 'camel') }

/** The oldest capture's record: the request stored parsed, under the old field names. */
export const V0_RECORD = (({ req_body, req_headers, resp, body_wire_bytes, ...rest }) => ({ ...rest, request: JSON.parse(req_body), request_headers: req_headers, response: resp }))({ ...anthBase, resp: jsonResp(anthJsonBody) })
