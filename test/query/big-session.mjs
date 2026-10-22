// test/query/big-session.mjs — one long agent session on one of the three wire shapes a session can have (RFC 3.5 §内存有界):
//   'http'    Claude Code, every request re-sends the whole context: call n stores ~n × `growth` bytes, n calls ~growth × n² / 2
//   'threads' Claude Code on Message Threads (3.1:35): a create, then continuations that send only their delta; the reply is a
//             stream (the collector's own shapeResponse), so the context is stitched across records
//   'ws'      Codex over WebSocket (3.1:37): response.create with previous_response_id and only the new input; the reply is the
//             server's messages, streamed deltas then response.completed (the collector's own buildWsEnvelope)
//   'chat'    DeepSeek dsh over Chat Completions: the whole context each request; a subagent is marked by its lane hint only (no
//             agent id), so all its subagents share one lane
// The text of each turn is fresh (seeded words, a code block, a tool call and its result), so a parsed record costs in the heap what a
// real one does. Every `subEvery`-th call is a subagent's (its own lane — a thread or a connection of its own — and a short context);
// `subLanes` subagents run side by side (their turns taken in turn), and a subagent's call that finished up to `late` calls (seeded)
// after the ones started after it is written then — as the collector writes a call when it ends — so its line sorts before lines
// already written, and before lines of other subagents that ended sooner.
// `preamble`: text every subagent's first prompt starts with (a workflow's own instructions, shared by all its subagents).
// `cc`: the Anthropic wires send what Claude Code sends besides the conversation — `cc` tool definitions with every request (as a
// thread's continuation does too) and the cache markers (`cache_control` on the system block and on the last message's last block) —
// so a request body has the size and the long keys a real one has.
// `reads`: each turn's tool call is a Bash command that reads `reads` distinct files (cat a b c …), so every call adds as many
// resources to its lane's ledger.
// `names`: each turn's tool call is a tool no call before it used, its name `names` characters long (an MCP tool of a server of its
// own): the fold's tool map keeps each distinct name, so every call keeps that much more for as long as the fold lives.
// `tools`: on the Anthropic wires, how many tool definitions each call carries that no call before it did (fresh names and schemas).
// What the user's live session has besides (every one OFF by default, and drawn from a random stream of its own, so a session
// without them is byte for byte what it was):
// `paths`: each turn's tool result names `paths` file paths and its prose half as many — absolute and relative, half of them new and
//   half named before — so the seen ledger grows the way a real one does.
// `prompt`: each lane's first prompt (main and subagent, after every compaction) starts with `prompt` characters of <system-reminder>
//   blocks, one the same in every lane and one its own, before the ask — the human heads; later turns carry a short one or two.
// `writes`: each turn's tool call is a Write (`content`) or an Edit (`old_string` / `new_string`) of `writes` characters — event args.
// `bigEvery` / `bigBytes` / `bigRun`: every `bigEvery` calls a cluster of `bigRun` main-lane calls each stores about `bigBytes` more
//   (a file read into the context: once on the wires that re-send the context, on every call on the ones that send a delta); the
//   main context compacts after the cluster.
// `shared`: the system prompt every lane sends (subagents included) gains a block of `shared` characters; the `cc` tool definitions
//   are already one set every lane sends.
// `seal()`: seals the segment written so far through the product's sealSegment (frames of `seal` bytes, so reads go through frames
//   and delta chains) and goes on in a new segment; the record ids already written do not change.
// live(scale) gives all of them in the proportions of the user's live session.
// Exports only: node --test runs every .mjs.
import fs from 'node:fs'
import path from 'node:path'
import { replyOf } from '../helpers/cc-threads.mjs'
import { buildWsEnvelope } from '../../src/collector/core/record/envelope.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'

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
function turn(next, i, growth, reads, names) {
  const id = `toolu_${i}`
  const call = () => (names ? { name: `mcp__s${i}__` + words(next, names).trim().replace(/\W+/g, '_'), input: {} } : reads ? { name: 'Bash', input: { command: 'cat ' + Array.from({ length: reads }, (_, k) => `/w/${i}/${k}.mjs`).join(' ') } }
    : { name: ['Read', 'Edit', 'Bash'][i % 3], input: { file_path: `/work/src/${words(next, 8).trim()}.mjs` } })
  return [
    { role: 'user', content: [{ type: 'text', text: words(next, growth * 0.3) }] },
    { role: 'assistant', content: [{ type: 'text', text: words(next, growth * 0.15) }, { type: 'tool_use', id, ...call() }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: i % 3 ? words(next, growth * 0.5) : '```js\n' + words(next, growth * 0.5) + '\n```' }] },
  ]
}

/**
 * bigSession({home, id, wire, growth, seed, subEvery, subLen, segment}) → a writer of ONE session into <home>/raw/<segment>.ndjson.
 * A subagent's context starts over (a new subagent) once it holds more than `subLen` messages; the main one (a compaction: a new
 * thread or chain) once it holds more than `compactAt` characters.
 * `append(n)` appends the next n calls (as the daemon would, one line each) and returns the session's stored bytes so far.
 */
export function bigSession({ home, id = 'big-0000-4a1b-9c2d-000000000001', wire = 'http', growth = 2_500, seed = 7, subEvery = 5, subLen = 30, subLanes = 1, late = 0, compactAt = 1_000_000, segment = '20261020T164737Z', preamble = '', cc = 0, reads = 0, names = 0, tools = 0,
  paths = 0, prompt = 0, writes = 0, bigEvery = 0, bigBytes = 2_000_000, bigRun = 4, shared = 0, seal = 64 << 10 } = {}) {
  const next = rng(seed), delay = rng(seed + 1), xr = rng(seed + 2)
  let file = path.join(home, 'raw', `${segment}.ndjson`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const fresh = (k) => ({ k, msgs: [], sent: 0, prev: null, n: 0, chars: 0 })
  const main = fresh(0), subs = Array.from({ length: subLanes }, (_, k) => fresh(k))
  const held = [] // [line, the call count at which it is written]
  let n = 0, nsub = 0, stored = 0, ms = Date.parse('2026-10-20T16:47:37Z'), bigLeft = 0
  const system = [{ type: 'text', text: 'You are a coding assistant operating in a terminal.' }, ...(shared ? [{ type: 'text', text: words(xr, shared) }] : [])]
  const sysText = system.map((b) => b.text).join('\n\n')
  const named = [], slug = (k) => words(xr, k).trim().replace(/[\s.]+/g, '-')
  const pathOf = () => {
    if (named.length && xr() < 0.5) return named[Math.floor(xr() * named.length)]
    const p = xr() < 0.5 ? `/work/${slug(6)}/${slug(8)}.mjs` : `src/${slug(6)}/${slug(8)}.ts`
    named.push(p)
    return p
  }
  const remind = (t) => ({ type: 'text', text: `<system-reminder>\n${t}\n</system-reminder>` })
  const everyLane = prompt ? remind(words(xr, prompt / 2)) : null
  const ccTools = Array.from({ length: cc }, (_, k) => ({ name: `Tool${k}`, description: words(next, 2_500),
    input_schema: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string', description: words(next, 300) } }, required: ['file_path'] },
    eager_input_streaming: true }))
  const line = () => {
    if (bigEvery > 0 && n % bigEvery === bigEvery - 1) bigLeft = bigRun
    const big = bigLeft > 0
    const sub = !big && subEvery > 0 && n % subEvery === subEvery - 1
    const lane = sub ? subs[nsub++ % subLanes] : main
    if (sub ? lane.msgs.length > subLen : lane.chars > compactAt) Object.assign(lane, { msgs: [], sent: 0, prev: null, n: lane.n + 1, chars: 0 })
    const t = turn(next, n, sub ? Math.round(growth / 4) : growth, reads, names)
    lane.msgs.push(...t)
    if (sub && preamble && lane.msgs.length === 3) lane.msgs[0].content[0].text = `${preamble}\n${lane.msgs[0].content[0].text}` // a subagent's first prompt
    if (prompt && lane.msgs.length === 3) t[0].content.unshift(everyLane, remind(words(xr, prompt / 2)))
    else if (prompt) { t[2].content.push(remind(words(xr, 240))); if (n % 2) t[0].content.unshift(remind(words(xr, 160))) } // as Claude Code adds to a turn
    if (paths) {
      const some = (k) => Array.from({ length: k }, pathOf)
      t[0].content[t[0].content.length - 1].text += ` See ${some(Math.ceil(paths / 2)).join(' and ')}.`
      t[2].content[0].content += '\n' + some(paths).map((p, k) => `${p}:${k + 1}: ${slug(4)}`).join('\n')
    }
    if (writes) {
      const use = t[1].content[1], file_path = paths ? pathOf() : `/work/src/w${n}.mjs`
      Object.assign(use, n % 2 ? { name: 'Edit', input: { file_path, old_string: words(xr, writes / 4), new_string: words(xr, writes * 3 / 4) } }
        : { name: 'Write', input: { file_path, content: words(xr, writes) } })
    }
    if (big) {
      // a big file read into the context: the wires that re-send the context carry it on to the cluster's next calls
      if (bigLeft === bigRun || wire === 'threads' || wire === 'ws') t[0].content.push({ type: 'text', text: words(xr, bigBytes) })
      if (--bigLeft === 0) lane.chars = Infinity // the context compacts on the next main call
    }
    lane.chars += sub ? Math.round(growth / 4) : growth
    const ts = new Date((ms += 4_000)).toISOString()
    const text = words(next, 200)
    const agent = sub ? `agent-${lane.k}-${lane.n}` : null
    const reqId = `req_${String(n + 1).padStart(5, '0')}`
    const usage = { input_tokens: 40, output_tokens: 120, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 300 }
    const ask = lane.msgs.slice(0, -2), delta = ask.slice(lane.sent)
    lane.sent = ask.length
    let env
    if (wire === 'ws') {
      const msgId = `resp_${n}`
      const input = delta.map((m) => ({ type: 'message', role: m.role, content: m.content.map((c) => ({ type: m.role === 'user' ? 'input_text' : 'output_text', text: c.text ?? (typeof c.content === 'string' ? c.content : JSON.stringify(c.input ?? c)) })) }))
      const body = { type: 'response.create', model: 'gpt-x', instructions: sysText, tools: [], input, ...(lane.prev ? { previous_response_id: lane.prev } : {}) }
      const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
      const server = [JSON.stringify({ type: 'response.created', response: { id: msgId } }),
        ...text.match(/.{1,40}/gs).map((d) => JSON.stringify({ type: 'response.output_text.delta', delta: d })),
        JSON.stringify({ type: 'response.completed', response: { id: msgId, status: 'completed', output, usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 1000 * n }, output_tokens: 120 } } })]
      const key = sub ? `key-${agent}` : 'key-main'
      const headers = [['Host', 'api.openai.com'], ['Upgrade', 'websocket'], ['session-id', id], ['Sec-WebSocket-Key', key], ...(sub ? [['x-openai-subagent', agent]] : [])]
      env = buildWsEnvelope({ id: reqId, seq: n, wsRaw: [],
        flow: { id: key, host: 'api.openai.com', scheme: 'https', dst: { address: '127.0.0.1', port: 443 }, proc: { pid: 4243, exe: '/x/codex', agent: 'codex' } },
        upgrade: { req: { head: { raw: Buffer.from('GET /v1/responses HTTP/1.1\r\n\r\n', 'latin1'), method: 'GET', target: '/v1/responses', headers } },
          resp: { head: { raw: Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n', 'latin1'), headers: [['Upgrade', 'websocket']] } } },
        call: { client: [JSON.stringify(body)], server, tsStart: ts, tsRespStart: ts, tsEnd: ts, partial: [], truncated: false } })
      env.is_llm_call = true
      lane.prev = msgId
    } else if (wire === 'chat') {
      const chat = (m) => ({ role: m.role, content: m.content.map((c) => c.text ?? (typeof c.content === 'string' ? c.content : JSON.stringify(c.input ?? c))).join('\n') })
      const body = { model: 'deepseek-chat', messages: [{ role: 'system', content: sysText }, ...ask.map(chat)],
        ...(sub ? { dsh_session_log: { session: { origin: 'subagent' } } } : {}) }
      env = {
        ts, endpoint: '/chat/completions', method: 'POST',
        req_headers: { host: 'api.deepseek.com', 'content-type': 'application/json', 'x-deepseek-harness-session-id': id },
        req_body: JSON.stringify(body),
        resp: { status: 200, kind: 'json', body: { id: `chatcmpl_${n}`, model: 'deepseek-chat', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
          usage: { prompt_tokens: 40, completion_tokens: 120, prompt_cache_hit_tokens: 1000 * n, prompt_cache_miss_tokens: 300 } } },
        id: reqId, ts_request: ts, ts_response_start: ts, ts_response_end: ts, duration_ms: 900,
        is_llm_call: true, capture: 'transparent', host: 'api.deepseek.com', traffic_class: 'llm', proc: { pid: 4244, exe: '/x/dsh', agent: 'dsh' },
      }
    } else {
      const msgId = `msg_${n}`
      const reply = [{ type: 'text', text }, ...(n % 4 ? [{ type: 'tool_use', id: `toolu_r${n}`, name: 'Read', input: { file_path: '/work/x.mjs' } }] : [])]
      const threads = wire === 'threads'
      const defs = Array.from({ length: tools }, (_, k) => ({ name: `tool_${n}_${k}`, description: words(next, 160), input_schema: { type: 'object', properties: { [words(next, 6).trim()]: { type: 'string', description: words(next, 60) } } } }))
      const sent = [...(cc ? ccTools : []), ...defs]
      const mark = (ms) => (cc && ms.length ? [...ms.slice(0, -1), { ...ms[ms.length - 1], content: ms[ms.length - 1].content.map((c, i, a) => (i === a.length - 1 ? { ...c, cache_control: { type: 'ephemeral' } } : c)) }] : ms)
      const sys = cc ? system.map((b, i, a) => (i === a.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b)) : system
      const body = { model: MODEL, max_tokens: 4096, ...(sent.length ? { tools: sent } : {}), ...(threads && lane.prev ? { thread: { type: 'continue', previous_message_id: lane.prev }, messages: mark(delta) }
        : { ...(threads ? { thread: { type: 'create' } } : {}), system: sys, messages: mark(ask) }) }
      env = {
        ts, endpoint: '/v1/messages', method: 'POST',
        req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-app': 'cli', 'x-claude-code-session-id': id, ...(agent ? { 'x-claude-code-agent-id': agent } : {}), 'anthropic-version': '2023-06-01' },
        req_body: JSON.stringify(body),
        resp: threads ? replyOf(msgId, reply, usage) : { status: 200, kind: 'json', body: { id: msgId, model: MODEL, stop_reason: n % 4 ? 'tool_use' : 'end_turn', content: reply, usage } },
        id: reqId, ts_request: ts, ts_response_start: ts, ts_response_end: ts, duration_ms: 900,
        is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm', proc: { pid: 4242, exe: '/x/claude', agent: 'claude-code' },
      }
      // a thread's context goes on with the reply as the server kept it; the plain wire re-sends what the generator wrote
      if (threads) { lane.prev = msgId; lane.msgs.splice(lane.sent, 0, { role: 'assistant', content: reply }); lane.sent++ }
    }
    n++
    const due = sub && late ? n + Math.floor(delay() * (late + 1)) : n
    if (due > n) { held.push([JSON.stringify(env), due]); return null }
    return JSON.stringify(env)
  }
  // the lines written once call `n` is: its own (unless it ends late), then every held one whose time has come
  const written = () => {
    const out = [line()].filter(Boolean)
    for (let i = 0; i < held.length;) if (held[i][1] <= n) out.push(held.splice(i, 1)[0][0]); else i++
    return out
  }
  return {
    get file() { return file }, id,
    get calls() { return n },
    /** How many calls that ended late are not written yet (each written once its time has come). */
    get held() { return held.length },
    append(k = 1) {
      let out = [], len = 0
      const flush = () => {
        if (!out.length) return
        const s = out.join('\n') + '\n'
        fs.appendFileSync(file, s, { mode: 0o600 })
        stored += Buffer.byteLength(s)
        out = []; len = 0
      }
      for (let i = 0; i < k; i++) for (const l of written()) { out.push(l); if ((len += l.length) > 64 << 20) flush() } // a string has a ceiling
      flush()
      return stored
    },
    /** Appends calls until the session's stored bytes reach `bytes`. */
    growTo(bytes) { while (stored < bytes) this.append(1); return stored },
    /** Seals the segment written so far (frames of `seal` bytes) and goes on in a new segment one second later. */
    async seal() {
      if (fs.existsSync(file)) await sealSegment(file, { lockFile: path.join(home, 'collector', 'lock'), journal: null, frameBytes: seal })
      segment = new Date(Date.parse(segment.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')) + 1_000).toISOString().replace(/[-:]|\.\d+/g, '')
      file = path.join(home, 'raw', `${segment}.ndjson`)
    },
  }
}

/** live(scale) → bigSession options (and `calls`, how many to append) in the proportions of the user's live Claude Code session
 *  (12.5k calls, ~36 calls a lane, ~149 KB a record, ~1 % of records over 1 MB in clusters, first prompts up
 *  to 16 KB of system-reminders, one system prompt and tool set across lanes). A regression seed, not an expectation: scale 1 is
 *  the user's size. */
export function live(scale = 1) {
  return { calls: Math.max(1, Math.round(12_500 * scale)), wire: 'http', growth: 2_500, subEvery: 2, subLanes: 12, subLen: 54, late: 6,
    compactAt: 110_000, cc: 16, shared: 12_000, paths: 4, prompt: 12_000, writes: 1_200, bigEvery: 400, bigBytes: 2_000_000, bigRun: 4 }
}

/** firstAskOf(record, records) → what 4.4 §看板 v2 需要的补充 says a lane's `task` is, read straight off the request bytes: the first
 *  user text of the call's context that is not only <system-reminder> blocks, whitespace runs squashed to one space, trimmed, at most
 *  80 characters. A call that continues a server-held context (a `previous_*_id`) has its predecessors' messages first. */
export function firstAskOf(rec, records = []) {
  const users = [], prev = []
  const walk = (o) => {
    if (Array.isArray(o)) { for (const x of o) walk(x); return }
    if (!o || typeof o !== 'object') return
    if (o.role === 'user') users.push(o)
    for (const [k, v] of Object.entries(o)) if (/^previous_\w+_id$/.test(k) && typeof v === 'string') prev.push(v); else walk(v)
  }
  walk(JSON.parse(rec.req_body))
  const answered = (r) => { const t = JSON.stringify(r.resp); return t.includes(`"${prev[0]}"`) || t.includes(`\\"${prev[0]}\\"`) }
  const before = prev.length ? records.find((r) => r !== rec && answered(r)) : null
  const head = before ? firstAskOf(before, records) : null
  if (head) return head
  for (const m of users) {
    const parts = typeof m.content === 'string' ? [m.content] : (m.content || []).filter((p) => p && typeof p.text === 'string').map((p) => p.text)
    for (const t of parts) {
      const h = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim()
      if (h) return h.slice(0, 80)
    }
  }
  return null
}
