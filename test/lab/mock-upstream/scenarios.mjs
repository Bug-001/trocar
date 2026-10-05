// scenarios.mjs — the scenario catalog, how a request picks one, and the dialect-neutral reply plan.
// Every name here has a row in README.md's scenario table (a test keeps the two in sync).
import { createHash } from 'node:crypto'

// A scenario is data the dialects and the transport read: `status` makes it an HTTP error.
export const SCENARIOS = {
  ok: {},
  thinking: { thinking: true },
  'tool-use': { tool: true },
  'http-529': { status: 529 },
}

const MARKER = /\[\[mock:([a-z0-9-]+)\]\]/g
// own keys only: `n in SCENARIOS` would also accept "constructor", "toString", "__proto__"
export const isScenario = (n) => typeof n === 'string' && Object.hasOwn(SCENARIOS, n)

// header > body marker > script queue > default. The header applies to any request (it is explicit
// test intent); markers and the script only steer model calls, so count_tokens / models / hello
// never consume a scripted step. The LAST known marker wins: a marker typed into an agent stays in
// the conversation history, so a later turn can override it by typing another one.
export function pickScenario(headers, body, isModel, queue) {
  if (headers['x-mock-scenario']) return { name: headers['x-mock-scenario'], source: 'header' }
  if (isModel) {
    const marks = [...body.toString('latin1').matchAll(MARKER)].map((m) => m[1]).filter(isScenario)
    if (marks.length) return { name: marks.at(-1), source: 'marker' }
    if (queue.length) return { name: queue.shift(), source: 'script' }
  }
  return { name: 'ok', source: 'default' }
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const tokens = (n) => Math.max(1, Math.ceil(n / 4))

// The shell tool each harness declares and the arguments its schema wants, so the agent really runs
// the command. Unknown harnesses: the first tool whose name looks like a shell, else Codex's `shell`.
export const TOOL_COMMAND = 'echo asight-tool-ok'
const SHELL_TOOLS = {
  Bash: { command: TOOL_COMMAND, description: 'asight mock tool call' }, // Claude Code
  bash: { command: TOOL_COMMAND, description: 'asight mock tool call' }, // OpenCode
  shell: { command: ['bash', '-lc', TOOL_COMMAND] }, // Codex
  shell_command: { command: TOOL_COMMAND }, // Codex, newer
  exec_command: { cmd: TOOL_COMMAND }, // Codex unified exec
  Shell: { command: TOOL_COMMAND }, // Kimi Code
  terminal: { command: TOOL_COMMAND }, // Hermes
}

export function shellCall(names) {
  const known = names.find((n) => n in SHELL_TOOLS)
  if (known) return { name: known, input: SHELL_TOOLS[known] }
  const like = names.find((n) => /bash|shell|terminal/i.test(n))
  return like ? { name: like, input: { command: TOOL_COMMAND } } : { name: 'shell', input: SHELL_TOOLS.shell }
}

// What the model "says", before any dialect shapes it. The text is a pure function of the request,
// so a test (or a person watching an agent) can tell what actually reached the upstream.
// `seen` = { kind: 'text' | 'tool_result', text } from the dialect's reading of the last user turn.
// A tool result is always answered with text, never another call: the scenario marker that asked
// for the call is still in the history, and answering it again would loop the agent forever. A
// request that declares no tools gets text too, as from a real provider: agents' side calls (titles,
// summaries, compaction) carry the typed marker but no tools.
export function plan(seen, raw, body, sc = {}) {
  const head = seen.kind === 'tool_result' ? 'mock-reply: tool-result-received ' : 'mock-reply: '
  const text = `${head}${Array.from(seen.text || '').slice(0, 80).join('')} sha256:${sha256(raw).slice(0, 12)}`
  const thinking = sc.thinking ? `mock-thinking: the last user turn is ${(seen.text || '').length} chars long` : null
  const names = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name || t?.function?.name).filter(Boolean)
  const tool = sc.tool && seen.kind !== 'tool_result' && names.length ? shellCall(names) : null
  return {
    model: body.model || 'mock-model', text, parts: splitEvery(text, 12),
    thinking, thinkingParts: thinking && splitEvery(thinking, 12), tool, toolArgs: tool && JSON.stringify(tool.input),
    inputTokens: tokens(raw.length), outputTokens: tokens(text.length + (thinking || '').length),
  }
}

// Split on code points, never inside a character: deltas stay valid strings, so any mid-character
// split a client sees on the wire is the transport's doing, not the content's.
export function splitEvery(text, n) {
  const cps = Array.from(text), out = []
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''))
  return out
}
