// test/fixtures/cc-record.mjs — synthetic-but-shaped CC unified-envelope records
// (D10 field names). The frozen real NDJSON fixtures live in the separate fixtures
// unit; these builders keep the adapter tests self-contained and deterministic.
//
// over.req  → shallow-overrides the request-body sub-objects it names (model / tools /
//             system / messages), keeping the rest.
// over.env  → shallow-overrides envelope fields (endpoint / resp / error / novel …).

export function ccLlmRecord(over = {}) {
  const req = {
    model: 'claude-opus-4-6',
    stream: true,
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header cch=abc123' },
      { type: 'text', text: 'You are Claude Code, cc_entrypoint=cli;cc_is_subagent=false' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'working directory: /repo\nhello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/a.mjs' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file bytes' }] },
    ],
    ...(over.req || {}),
  };
  return {
    id: 'rec-1',
    ts_request: '2026-07-15T00:00:00.000Z',
    endpoint: '/v1/messages',
    method: 'POST',
    is_llm_call: true,
    duration_ms: 1200,
    error: false,
    req_headers: { 'x-claude-code-session-id': 'sess-abc', 'user-agent': 'claude-cli/1.0' },
    req_body: JSON.stringify(req), // D10: req_body is the VERBATIM captured request STRING
    resp: {
      kind: 'sse',
      status: 200,
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 50,
        output_tokens: 30,
        output_tokens_details: { thinking_tokens: 12 },
      },
    },
    ...(over.env || {}),
  };
}

// A FULL D10 envelope: every observ-meta field present (B-env). Used to prove
// unmapped_count is inflated ONLY by genuinely-novel fields, never by the D10 meta.
export function ccFullEnvelopeRecord(extraFields = {}) {
  return {
    ...ccLlmRecord(), // id, ts_request, endpoint, method, is_llm_call, duration_ms, error, req_headers, req_body, resp
    ts: '2026-07-15T00:00:00.000Z',
    ts_response_start: '2026-07-15T00:00:00.500Z',
    ts_response_end: '2026-07-15T00:00:01.200Z',
    capture: { source: 'mitm', host: 'api.anthropic.com' },
    auth_mode: 'oauth',
    ...extraFields, // e.g. { novel_probe: 42 }
  };
}

export function ccControlRecord() {
  return {
    id: 'ctl-1',
    ts_request: '2026-07-15T00:00:01.000Z',
    endpoint: 'https://api.anthropic.com/v1/event_logging',
    method: 'POST',
    is_llm_call: false,
    duration_ms: 40,
    error: false,
    req_headers: { 'user-agent': 'claude-cli/1.0' },
    req_body: JSON.stringify({ events: [] }),
    resp: { kind: 'json', status: 200, body: {} },
  };
}

export function nonCcRecord() {
  return {
    id: 'x-1',
    endpoint: '/v1/chat/completions',
    is_llm_call: true,
    req_headers: { 'user-agent': 'python-requests/2.0' },
    req_body: '{}',
    resp: { kind: 'json', status: 200, body: {} },
  };
}
