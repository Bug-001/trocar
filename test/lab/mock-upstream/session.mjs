// session.mjs — what turns single replies into a multi-call agent session (README "Sessions"). All
// of it is read off the request itself, so a retried request gets the same answer and side calls in
// between change nothing.

// The default size near-limit reports: above Claude Code's auto-compact threshold for a 200k window
// (at most 200k - 20k - 13k = 167k) and below its hard stop (200k - 20k - 3k = 177k).
export const NEAR_LIMIT_TOKENS = 170000

// Anthropic {name, input_schema}, Responses {name, parameters}, Chat {function: {name, parameters}}.
export const toolsOf = (body) => (Array.isArray(body.tools) ? body.tools : [])
  .map((t) => ({ name: t?.name || t?.function?.name, schema: t?.input_schema || t?.parameters || t?.function?.parameters || {} }))
  .filter((t) => t.name)

const textOf = (m) => typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n') : ''

// The current user turn, read back from the end. rounds: tool results since the user's own last
// message (tool_result blocks, *_call_output items, tool messages); prompt: that message's text;
// compacted: a compaction item follows it (Codex keeps the user's messages when it compacts);
// quiet: the latest user text opens by forbidding tool calls, as Claude Code's compaction prompt does.
export function turnOf(body) {
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }]
    : Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : []
  let rounds = 0, compacted = false, i = items.length - 1
  for (; i >= 0; i--) {
    const it = items[i] || {}
    if (it.role === 'tool' || /_call_output$/.test(it.type || '') || (it.role === 'user' && Array.isArray(it.content) && it.content.some((b) => b?.type === 'tool_result'))) rounds++
    else if (/compaction/.test(it.type || '')) compacted = true
    else if (it.role === 'user') break
  }
  const last = items.findLast((it) => it?.role === 'user')
  const lastText = Array.isArray(last?.content) ? (last.content.findLast((b) => typeof b?.text === 'string')?.text ?? '') : textOf(last)
  return { rounds, compacted, compacting: items.at(-1)?.type === 'compaction_trigger', prompt: textOf(items[i]), quiet: /^[^\n]*\bdo not call any tools\b/i.test(lastText) }
}

// Whether a scenario's turn action (a tool call; near-limit usage) applies. A scripted step is used up
// by the one call that pops it, so it always acts. A marker stays in the history, and a header may
// come on every request, so those act in the first N rounds of each user turn (marker `*N`, else 1).
// After a compaction they stop; near-limit also needs its marker typed in this very turn, so the
// summary request and the turns after a compaction do not report it again.
export function acts(turn, sc = {}) {
  const via = sc.via || {}
  if (turn.compacting) return false
  if (via.source === 'script') return true
  if (turn.compacted) return false
  if (sc.nearLimit && via.source === 'marker' && !turn.prompt.includes('[[mock:near-limit')) return false
  return turn.rounds < (via.repeat || 1)
}

// The subagent tool: Claude Code's Agent (Task before 2.1), OpenCode's task, else any tool whose
// schema takes a prompt and a subagent_type. The type is the one each CLI always has.
const SUBAGENT_TOOLS = ['Agent', 'Task', 'task']
export const SUBAGENT_PROMPT = 'asight-mock-subagent: reply in one line'
const filler = (p = {}) => p.enum ? p.enum[0] : ({ boolean: false, number: 0, integer: 0, array: [], object: {} })[p.type] ?? 'asight'

export function subagentCall(tools) {
  const t = tools.find((x) => SUBAGENT_TOOLS.includes(x.name)) || tools.find((x) => x.schema.properties?.prompt && x.schema.properties?.subagent_type)
  if (!t) return null
  const props = t.schema.properties || {}, input = { description: 'asight mock subagent', prompt: SUBAGENT_PROMPT }
  const want = t.name === 'task' ? 'general' : 'general-purpose', types = props.subagent_type?.enum
  if (props.subagent_type) input.subagent_type = !types || types.includes(want) ? want : types[0]
  for (const k of ['run_in_background', 'background']) if (props[k]) input[k] = false // wait for its answer
  for (const k of t.schema.required || []) if (!(k in input)) input[k] = filler(props[k])
  return { name: t.name, input }
}

// Title side calls carry no tools: Claude Code asks for JSON {"title"} (output_config), OpenCode has a
// "title generator" agent. They get a short title, as JSON when the request wants JSON.
const systemText = (b) => [b.system, b.instructions, ...(Array.isArray(b.messages) ? b.messages.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => m.content) : [])]
  .map((s) => (typeof s === 'string' ? s : Array.isArray(s) ? s.map((x) => x?.text || '').join('\n') : '')).join('\n')
const schemaOf = (b) => (b.output_config?.format || b.output_format || b.text?.format || b.response_format?.json_schema || b.response_format)?.schema
export const isTitleRequest = (b) => !toolsOf(b).length && (schemaOf(b)?.properties?.title != null || /title generator|"title" field/i.test(systemText(b)))
export const titleText = (b, id) => (schemaOf(b) || /\bJSON\b/.test(systemText(b)) ? JSON.stringify({ title: `mock title ${id}` }) : `mock title ${id}`)

// near-limit: grow the input side of every usage block in a reply by the same amount, so the last one
// totals `total` (input + cache + output) whatever the dialect computed, and message_start agrees
// with message_delta.
export function withUsageTotal(res, total) {
  const docs = res.pieces.map((p) => { const m = /^((?:event: [^\n]*\n)?data: )?(\{.*\})(\n\n)?$/s.exec(p); return m && { m, o: JSON.parse(m[2]) } })
  const usages = []
  const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (k === 'usage' && v && typeof v === 'object') usages.push(v); else walk(v) }
  for (const d of docs) if (d) walk(d.o)
  const u = usages.at(-1)
  if (!u) return res
  const add = Math.max(0, total - ('prompt_tokens' in u ? u.prompt_tokens + u.completion_tokens
    : u.input_tokens + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + u.output_tokens))
  for (const x of usages) {
    const k = 'prompt_tokens' in x ? 'prompt_tokens' : 'input_tokens'
    x[k] += add
    if ('total_tokens' in x) x.total_tokens += add
    if ('prompt_cache_miss_tokens' in x) x.prompt_cache_miss_tokens += add
  }
  res.pieces = res.pieces.map((p, i) => (docs[i] ? `${docs[i].m[1] || ''}${JSON.stringify(docs[i].o)}${docs[i].m[3] || ''}` : p))
  return res
}
