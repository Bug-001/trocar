// session.mjs — what turns single replies into a multi-call agent session (README "Sessions"). All
// of it is read off the request itself, so a retried request gets the same answer and side calls in
// between change nothing.

// Anthropic {name, input_schema}, Responses {name, parameters}, Chat {function: {name, parameters}}.
export const toolsOf = (body) => (Array.isArray(body.tools) ? body.tools : [])
  .map((t) => ({ name: t?.name || t?.function?.name, schema: t?.input_schema || t?.parameters || t?.function?.parameters || {} }))
  .filter((t) => t.name)

const textOf = (m) => typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n') : ''

// The current user turn, read back from the end. rounds: tool results since the user's own last
// message (tool_result blocks, *_call_output items, tool messages);
// quiet: the latest user text opens by forbidding tool calls, as Claude Code's compaction prompt does.
export function turnOf(body) {
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }]
    : Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : []
  let rounds = 0, i = items.length - 1
  for (; i >= 0; i--) {
    const it = items[i] || {}
    if (it.role === 'tool' || /_call_output$/.test(it.type || '') || (it.role === 'user' && Array.isArray(it.content) && it.content.some((b) => b?.type === 'tool_result'))) rounds++
    else if (it.role === 'user') break
  }
  const last = items.findLast((it) => it?.role === 'user')
  const lastText = Array.isArray(last?.content) ? (last.content.findLast((b) => typeof b?.text === 'string')?.text ?? '') : textOf(last)
  return { rounds, quiet: /^[^\n]*\bdo not call any tools\b/i.test(lastText) }
}

// Whether a scenario's turn action (a tool call) applies. A scripted step is used up
// by the one call that pops it, so it always acts. A marker stays in the history, and a header may
// come on every request, so those act in the first N rounds of each user turn (marker `*N`, else 1).
export function acts(turn, sc = {}) {
  const via = sc.via || {}
  if (via.source === 'script') return true
  return turn.rounds < (via.repeat || 1)
}
