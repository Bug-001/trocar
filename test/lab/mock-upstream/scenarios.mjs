// scenarios.mjs — the scenario catalog, how a request picks one, and the dialect-neutral reply plan.
// Every name here has a row in README.md's scenario table (a test keeps the two in sync).
import { createHash } from 'node:crypto'
import { toolsOf, turnOf, acts, subagentCall, isTitleRequest, titleText } from './session.mjs'

// A scenario is data the dialects and the transport read: `status` makes it an HTTP error, `extra`
// adds deltas after the reply text, and `fault` / `slowHeaders` / `drip` / `splitUtf8` / `encoding`
// / `framing` / `keepAlive` change how the bytes go on the wire (transport.mjs).
export const SCENARIOS = {
  ok: {},
  thinking: { thinking: true },
  'tool-use': { tool: true },
  subagent: { subagent: true },
  'near-limit': { tool: true, nearLimit: true }, // usage: session.mjs withUsageTotal
  ...Object.fromEntries([400, 401, 403, 404, 408, 409, 413, 422, 500, 503, 504, 529].map((s) => [`http-${s}`, { status: s }])),
  'http-429': { status: 429, retryAfter: 1 },
  'http-429-long': { status: 429, retryAfter: 120 },
  'http-502-html': { status: 502, html: true },
  'no-retry': { status: 500, headers: { 'x-should-retry': 'false' } }, // both SDKs obey it over the status
  'sse-error-event': { fault: 'error-event' },
  'mid-stream-reset': { fault: 'reset' },
  'mid-stream-fin': { fault: 'fin' },
  'stall-after-first': { fault: 'stall' },
  'slow-headers': { slowHeaders: true },
  'headers-then-reset': { fault: 'headers-reset' },
  'long-stream': { extra: () => Array.from({ length: 200 }, (_, i) => ` w${i}`) },
  'slow-drip': { drip: true },
  'long-drip': { extra: () => Array.from({ length: 120 }, (_, i) => ` d${i}`), drip: true }, // a stream that lasts 120 × dripMs (the end-to-end suite's G items act across it)
  'unicode-split': { extra: () => [' 你好🙂', ' 你好🙂'], splitUtf8: true },
  'big-response': { extra: () => Array.from({ length: 128 }, (_, i) => `\n[block ${i}] `.padEnd(16384, 'abcdefghijklmnopqrstuvwxyz0123456789')) },
  gzip: { encoding: 'gzip' },
  br: { encoding: 'br' },
  'content-length': { framing: 'length' },
  'conn-close': { framing: 'close' },
  keepalive: { keepAlive: true },
  'slow-tool-close': { tool: true, slowHeaders: true, framing: 'close' }, // the next call needs a new connection
}

// What a relay in front of the provider (nginx here) answers when the provider is unreachable.
const NGINX_502 = '<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n<center><h1>502 Bad Gateway</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n'

export function errorFor(sc, dialect) {
  if (sc.html) return { status: sc.status, headers: { 'content-type': 'text/html' }, pieces: [NGINX_502] }
  const res = dialect.errorReply(sc.status)
  if (sc.retryAfter) {
    const s = sc.retryAfter, at = new Date(Date.now() + s * 1000).toISOString()
    Object.assign(res.headers, { 'retry-after': String(s) })
    for (const [k, limit] of [['requests', 50], ['tokens', 40000]]) {
      Object.assign(res.headers, {
        [`anthropic-ratelimit-${k}-limit`]: String(limit), [`anthropic-ratelimit-${k}-remaining`]: '0', [`anthropic-ratelimit-${k}-reset`]: at,
        [`x-ratelimit-limit-${k}`]: String(limit), [`x-ratelimit-remaining-${k}`]: '0', [`x-ratelimit-reset-${k}`]: `${s}s`,
      })
    }
  }
  Object.assign(res.headers, sc.headers)
  return res
}

const MARKER = /\[\[mock:([a-z0-9-]+)(?:\*([1-9]\d{0,2}))?\]\]/g // `*N`: N tool rounds per user turn
// own keys only: `n in SCENARIOS` would also accept "constructor", "toString", "__proto__"
export const isScenario = (n) => typeof n === 'string' && Object.hasOwn(SCENARIOS, n)

// header > body marker > script queue > default. The header applies to any request (it is explicit
// test intent); markers and the script only steer model calls, so count_tokens / models / hello
// never consume a scripted step. The LAST known marker wins: a marker typed into an agent stays in
// the conversation history, so a later turn can override it by typing another one.
export function pickScenario(headers, body, isModel, queue) {
  if (headers['x-mock-scenario']) return { name: headers['x-mock-scenario'], source: 'header' }
  if (isModel) {
    const mark = [...body.toString('latin1').matchAll(MARKER)].filter((m) => isScenario(m[1])).at(-1)
    if (mark) return { name: mark[1], source: 'marker', repeat: Number(mark[2] || 1) }
    if (queue.length) return { name: queue.shift(), source: 'script' }
  }
  return { name: 'ok', source: 'default' }
}

// Script steps: "name" or "name*N" (N copies, 1..999). Returns the expanded queue and the bad steps.
export function expandSteps(steps) {
  const out = [], bad = []
  for (const s of steps) {
    const m = typeof s === 'string' && /^([a-z0-9-]+)(?:\*([1-9]\d{0,2}))?$/.exec(s)
    if (m && isScenario(m[1])) out.push(...Array(Number(m[2] || 1)).fill(m[1]))
    else bad.push(s)
  }
  return { out, bad }
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
// A call is made only while the scenario acts (session.mjs `acts`): the marker that asked for it is
// still in the history, so past its N rounds a tool result is answered with text, or the agent would
// loop forever. A request that declares no tools gets text too, as from a real provider: agents' side
// calls (summaries, compaction) carry the typed marker but no tools. A title call gets a short title.
export function plan(seen, raw, body, sc = {}) {
  const head = seen.kind === 'tool_result' ? 'mock-reply: tool-result-received ' : 'mock-reply: '
  const reply = isTitleRequest(body) ? titleText(body, sha256(raw).slice(0, 12))
    : `${head}${Array.from(seen.text || '').slice(0, 80).join('')} sha256:${sha256(raw).slice(0, 12)}`
  const extra = sc.extra ? sc.extra() : [], text = reply + extra.join('')
  const thinking = sc.thinking ? `mock-thinking: the last user turn is ${(seen.text || '').length} chars long` : null
  const tools = toolsOf(body), turn = turnOf(body), act = !turn.quiet && acts(turn, sc)
  const tool = !act ? null : sc.subagent ? subagentCall(tools) : sc.tool && tools.length ? shellCall(tools.map((t) => t.name)) : null
  return {
    model: body.model || 'mock-model', text, parts: [...splitEvery(reply, 12), ...extra],
    thinking, thinkingParts: thinking && splitEvery(thinking, 12), tool, toolArgs: tool && JSON.stringify(tool.input), compaction: turn.compacting,
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
