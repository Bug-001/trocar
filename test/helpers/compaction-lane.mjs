// test/helpers/compaction-lane.mjs — a generated main lane of compactions (3.4 §关键区分「一次压缩只算一次」), on a wire of its own, in the
// records the collector writes. A lane is a list of steps; each names what the call does to the context:
//   grow   the history gets longer            mark   the harness's compaction request: the history as it was, and the wire's header
//   drop   a sharp drop: a summary and the last half   small  a small drop with Claude Code's preamble first (Anthropic only)
//   junk   a body that does not parse (no observed context)
//   failmark / failgrow / faildrop   the same call answered with a failure; a failed drop's history is not kept: the retry sends what it had
// What the steps mean by 3.4 — `fateOf` — is the expectation, from the rule and never from the code under test.
export const SID = 'S'
const T = Date.parse('2026-10-21T08:00:00Z')
const stamp = (i) => new Date(T + i * 1000).toISOString()
const text = (role, t) => ({ role, content: [{ type: 'text', text: t }] })

const WIRES = {
  anthropic: {
    compact: 'x-cc-compaction-request',
    env: (i, body, headers) => ({ endpoint: '/v1/messages', host: 'api.anthropic.com', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' },
      req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': SID, ...headers },
      req_body: body, resp: { status: 200, kind: 'json', body: { id: `msg_${i}`, model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } } }),
    body: (messages) => ({ model: 'claude-opus-4-8', max_tokens: 32000, system: [{ type: 'text', text: 'You are a coding agent.' }],
      tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }], messages }),
  },
  flat: {
    compact: 'x-deepseek-harness-compact',
    env: (i, body, headers) => ({ endpoint: '/chat/completions', host: 'api.deepseek.com', proc: { pid: 2, exe: '/x/dsh', agent: 'dsh' },
      req_headers: { host: 'api.deepseek.com', 'content-type': 'application/json', 'x-deepseek-harness-session-id': SID, ...headers },
      req_body: body, resp: { status: 200, kind: 'json', body: { id: `chatcmpl_${i}`, model: 'deepseek-chat', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 40, completion_tokens: 1, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 30 } } } }),
    body: (messages) => ({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'You are a coding agent.' },
      ...messages.map((m) => ({ role: m.role, content: m.content.map((c) => c.text ?? '').join('\n') }))] }),
  },
}

/** laneOf(wire, steps) → one record a step; the history opens on a tool use of `READ`, so a ledger has something to evict. */
export const READ = '/work/a.mjs'
export function laneOf(wire, steps) {
  const w = WIRES[wire]
  let history = [], turns = 0
  const grow = () => {
    turns++
    history = [...history, { role: 'assistant', content: [{ type: 'text', text: `step ${turns}` }, { type: 'tool_use', id: `toolu_${turns}`, name: 'Read', input: { file_path: READ } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${turns}`, content: `result ${turns}` }] }]
  }
  history = [text('user', 'Fix the retry queue')]
  for (let k = 0; k < 40; k++) grow() // enough history for every drop of a lane to be sharp
  return steps.map((step, i) => {
    let headers = {}
    const failed = step.startsWith('fail'), op = failed ? step.slice(4) : step, before = history
    if (op === 'grow') grow()
    if (op === 'mark') headers = { [w.compact]: '1' }
    if (op === 'drop') history = [text('user', `Summary ${i} of the conversation so far`), ...history.slice(-2 * Math.floor(history.length / 4))]
    if (op === 'small') history = [text('user', `This session is being continued from a previous conversation. Summary ${i}.`), ...history.slice(2, -1)]
    const body = op === 'junk' ? '{"model":"claude-opus-4-8","messages":[{"role"' : JSON.stringify(w.body(history))
    if (step === 'faildrop') history = before
    return { ts: stamp(i), ts_request: stamp(i), id: `r${i}`, method: 'POST', is_llm_call: true, capture: 'transparent', traffic_class: 'llm', ...w.env(i, body, headers),
      ...(failed ? { resp: { status: 500, kind: 'json', body: { error: { type: 'api_error', message: 'overloaded' } } } } : null) }
  })
}

/** LANDS_WITHIN: a harness's request waits for its landing across this many calls with a verdict (3.4). */
export const LANDS_WITHIN = 4
const noVerdict = (op) => op === 'junk' || op.startsWith('fail')

/** fateOf(steps) → what 3.4 says of each step: 'marked' and 'inferred' are the compactions counted, 'lands' the landing of the last marked
 *  one, null nothing. A failed call and a junk one say nothing and change nothing; `mark` arms the wait, each call with a verdict uses one
 *  of it, evidence while it is armed lands and ends it. A preamble already in the history is no evidence. */
export function fateOf(steps) {
  let armed = 0, first = true, carried = false
  return steps.map((op) => {
    if (noVerdict(op)) return null
    const evidence = !first && (op === 'drop' || (op === 'small' && !carried)), was = armed > 0
    armed = op === 'mark' ? LANDS_WITHIN : evidence ? 0 : Math.max(0, armed - 1)
    first = false
    if (op === 'small') carried = true
    if (op === 'drop') carried = false
    if (op === 'mark') return 'marked'
    return evidence ? (was ? 'lands' : 'inferred') : null
  })
}

/** sent(record) → the messages its body holds, read from the bytes. */
export const sent = (rec) => JSON.parse(rec.req_body).messages.length

/** landedOf(steps, records) → {record id: {from, to}} of each landing step, from the bodies: the last call with a verdict and its own. */
export function landedOf(steps, records) {
  const fate = fateOf(steps), out = {}
  let last = null
  records.forEach((rec, i) => {
    if (noVerdict(steps[i])) return
    if (fate[i] === 'lands') out[rec.id] = { from: last, to: sent(rec) }
    last = sent(rec)
  })
  return out
}

/** lanes(wire) → the generated step lists of a wire, every op after every op, with and without junk between. */
export function lanes(wire) {
  const drops = wire === 'anthropic' ? ['drop', 'small'] : ['drop']
  const ops = ['grow', 'mark', ...drops], out = []
  for (const a of ops) for (const b of ops) for (const gap of [[], ['junk']]) out.push(['grow', 'grow', a, ...gap, b, 'grow', 'mark', ...gap, ...drops.slice(0, 1), 'grow'])
  return out
}

/** failLanes() → the step lists of 3.4 「失败的 call」: failed requests × a retry or none × the calls before the drop, with a failed call or
 *  none in front of each of those; and the lanes where the request and the drop all fail. */
export function failLanes() {
  const out = []
  for (let fails = 0; fails <= 2; fails++) {
    const failing = Array(fails).fill('failmark')
    out.push(['grow', 'grow', ...failing, 'faildrop', 'grow', 'grow'])
    for (const retry of [['mark'], []]) for (let between = 0; between <= LANDS_WITHIN + 1; between++) for (const noise of [[], ['failgrow'], ['faildrop']])
      out.push(['grow', 'grow', ...failing, ...retry, ...Array(between).fill([...noise, 'grow']).flat(), ...noise, 'drop', 'grow', 'grow'])
  }
  return out
}
