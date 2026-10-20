// test/query/big-session.mjs — one long agent session, the shape that grows a session's stored bytes quadratically (RFC 3.5 §内存有界).
//
// Every request re-sends the whole context, so call n stores ~n × `growth` bytes and a session of n calls stores ~growth × n² / 2.
// The text of each turn is fresh (seeded words, a code block, a tool call and its result), so a parsed record costs in the heap what a
// real one does. Every `subEvery`-th call is a subagent's (its own lane, a short context). Exports only: node --test runs every .mjs.
import fs from 'node:fs'
import path from 'node:path'

const MODEL = 'claude-opus-4-8'
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const SYL = ['ka', 'ro', 'mi', 'tu', 'sel', 'van', 'qu', 'lo', 'pre', 'dax', 'ne', 'ost', 'fi', 'gru', 'he', 'zan']
function words(next, chars) {
  let s = ''
  while (s.length < chars) {
    let w = ''
    for (let k = 1 + Math.floor(next() * 3); k > 0; k--) w += SYL[Math.floor(next() * SYL.length)]
    s += w + (next() < 0.08 ? '.\n' : ' ')
  }
  return s
}
/** One turn's three messages, ~`growth` bytes of fresh text. */
function turn(next, i, growth) {
  const id = `toolu_${i}`
  return [
    { role: 'user', content: [{ type: 'text', text: words(next, growth * 0.3) }] },
    { role: 'assistant', content: [{ type: 'text', text: words(next, growth * 0.15) }, { type: 'tool_use', id, name: ['Read', 'Edit', 'Bash'][i % 3], input: { file_path: `/work/src/${words(next, 8).trim()}.mjs` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: i % 3 ? words(next, growth * 0.5) : '```js\n' + words(next, growth * 0.5) + '\n```' }] },
  ]
}

/**
 * bigSession({home, id, calls, growth, seed, subEvery, segment}) → a writer of ONE session into <home>/raw/<segment>.ndjson.
 * `append(n)` appends the next n calls (as the daemon would, one line each) and returns the session's stored bytes so far.
 */
export function bigSession({ home, id = 'big-0000-4a1b-9c2d-000000000001', growth = 2_500, seed = 7, subEvery = 5, segment = '20261020T164737Z' } = {}) {
  const next = rng(seed)
  const file = path.join(home, 'raw', `${segment}.ndjson`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lanes = { main: [], sub: [] }
  let n = 0, stored = 0, ms = Date.parse('2026-10-20T16:47:37Z')
  const system = [{ type: 'text', text: 'You are a coding assistant operating in a terminal.' }]
  const line = () => {
    const sub = subEvery > 0 && n % subEvery === subEvery - 1
    const lane = sub ? lanes.sub : lanes.main
    if (sub && lane.length > 30) lane.length = 0 // a new subagent: its own short context
    lane.push(...turn(next, n, sub ? Math.round(growth / 4) : growth))
    const ts = new Date((ms += 4_000)).toISOString()
    const text = words(next, 200)
    const env = {
      ts, endpoint: '/v1/messages', method: 'POST',
      req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-app': 'cli', 'x-claude-code-session-id': id, ...(sub ? { 'x-claude-code-agent-id': `agent-${Math.floor(n / 40)}` } : {}), 'anthropic-version': '2023-06-01' },
      req_body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: lane.slice(0, -2) }),
      resp: { status: 200, kind: 'json', body: { id: `msg_${n}`, model: MODEL, stop_reason: n % 4 ? 'tool_use' : 'end_turn', content: [{ type: 'text', text }, ...(n % 4 ? [{ type: 'tool_use', id: `toolu_r${n}`, name: 'Read', input: { file_path: '/work/x.mjs' } }] : [])], usage: { input_tokens: 40, output_tokens: 120, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 300 } } },
      id: `req_${String(n + 1).padStart(5, '0')}`, ts_request: ts, ts_response_start: ts, ts_response_end: ts, duration_ms: 900,
      is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm', proc: { pid: 4242, exe: '/x/claude', agent: 'claude-code' },
    }
    n++
    return JSON.stringify(env)
  }
  return {
    file, id,
    get calls() { return n },
    append(k = 1) {
      const out = []
      for (let i = 0; i < k; i++) out.push(line())
      const s = out.join('\n') + '\n'
      fs.appendFileSync(file, s, { mode: 0o600 })
      stored += Buffer.byteLength(s)
      return stored
    },
    /** Appends calls until the session's stored bytes reach `bytes`. */
    growTo(bytes) { while (stored < bytes) this.append(1); return stored },
  }
}
