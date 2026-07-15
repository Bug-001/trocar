// Shared D10-envelope builder for identity tests (ported from demo test-sessions.mjs rec()).
//
// BLOCKER FIX (adversarial verify B-fix): the demo fixture set headers['x-app']='cli' whenever sid
// was truthy, but entrypoint() returns x-app BEFORE consulting the cc_entrypoint= system marker, so
// the Task-4 parseSessionCC assertion (entrypoint==='sdk-cli') contradicted the fixture. Here x-app
// is set ONLY when the caller passes an explicit `app` opt — so records exercising the cc_entrypoint
// marker carry no x-app and resolve via the marker, while entrypoint precedence is still tested by
// passing `app` explicitly. entrypoint precedence is UNCHANGED (desktop UA > x-app > cc_entrypoint).
export function rec(sid, opts = {}) {
  const {
    first = 'hi', sub = false, model = 'claude-opus-4-8', cwd = null,
    endpoint = '/v1/messages?beta=true', llm = true, ts = '2026-07-13T00:00:00Z',
    messages, system, ua, app,
  } = opts
  const env = cwd ? `\n<system-reminder>\nworking directory: ${cwd}\n</system-reminder>` : ''
  const headers = {}
  if (sid) headers['x-claude-code-session-id'] = sid
  if (app) headers['x-app'] = app
  if (ua) headers['user-agent'] = ua
  return {
    id: 'r', ts_request: ts, endpoint, is_llm_call: llm,
    req_headers: headers,
    req_body: {
      model,
      messages: messages || [{ role: 'user', content: first + env }],
      system: system || [{ type: 'text', text: sub ? 'x cc_is_subagent=true cc_entrypoint=sdk-cli' : 'You are Claude Code cc_entrypoint=cli' }],
      metadata: {},
    },
    resp: { usage: { input_tokens: 100 } },
  }
}
