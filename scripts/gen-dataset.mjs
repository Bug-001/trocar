// scripts/gen-dataset.mjs — the reference dataset of spec 1.6 附录 D.1, as a generator (附录 D: a 1 GB
// fixture does not belong in git, the generator is the readable spec). It writes plaintext segments into
// <home>/raw/ the way the daemon does, and stops rather than fill a disk.
//
//   node scripts/gen-dataset.mjs --home <dir> [--seed 1] [--bytes 1000000000] [--keep-plain 2] [--json]
//
// `--home` is the user's HOME, as everywhere else on the CLI (`HOME=`, scripts/perf-query.mjs): the dataset lands in
// <home>/.asight/raw/. The generate() below takes the ASIGHT home itself (<home>/.asight) — it is the library call.
//
// 附录 D.1 asks the dataset to arrive the way a machine that has been capturing for a while looks: most segments
// SEALED, two left plaintext (one live, one just closed and not sealed yet). sealMost() does that with the real
// sealer (src/raw/seal.mjs), so the query measurements read through the sealed path they will read in the field. The
// daemon is still the only thing that seals a LIVE capture (D35) — this is a dataset being built, not a capture.
//
// The segments are left PLAINTEXT on purpose: what 附录 D.2 measures is the daemon's own auto-sealing
// (which closed segments it sealed, how long each took). The envelopes are built by the one authority
// (src/capture/envelope.mjs) and the harnesses, classes and endpoints come from the read-side tables —
// this script holds dataset SHAPES (how big, how many, how fast they grow), no provider knowledge.
//
// CONTENT (synthetic data must be as complex as real traffic). Every turn's text is
// FRESH: words drawn from a Zipf-distributed vocabulary, code blocks, tool calls and tool results, some
// CJK and emoji, and the odd incompressible base64 blob (an image, a file). So the only repetition left
// between records is the one real agents create — the context that grows by ~7 KB a turn, the
// KV-cache-respecting case the storage layer is optimized for. Slicing every body out of one random pool
// (what this script did until 2026-10-18) made the 1 GB dataset seal at 0.53% while real captures seal at
// 3.5-8.3%: it said nothing about storage.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { buildEnvelope, logResponse } from '../src/capture/envelope.mjs'
import { sealSegment } from '../src/raw/seal.mjs'
import { shapeResponse } from '../src/collector/core/record/body.mjs'
import { HARNESSES } from '../src/dissect/harnesses.mjs'
import { THIRD_PARTY_TELEMETRY } from '../src/dissect/traffic.mjs'

export const DEFAULTS = Object.freeze({
  seed: 1,
  bytes: 1_000_000_000,          // ≈ 1 GB plaintext (附录 D.1 总量)
  segmentBytes: 128 << 20,       // the daemon's rotation size (4.6)
  maxDisk: 3_000_000_000,        // 附录 D.1 磁盘上限: 3 GB peak, generation + the sealer's plaintext original
  start: '2026-10-18T00:00:00Z', // a fixed clock, so one seed means one byte stream
})
// What sealing is expected to leave on disk next to the plaintext, used only for the peak estimate.
const SEALED_SHARE = 0.4
// 附录 D.1 长会话, measured on OpenCode: ~0.8 MB of context at the end, +7 KB a turn, 14-300 calls.
const GROWTH = 7_000, MAX_TURNS = 114, SESSION_SHARE = 0.08
const HUGE = 11 << 20            // the one record past 10 MB (a pasted file), when the budget can hold it
// Per harness: the inference endpoint and wire dialect of its already-captured samples (test/fixtures/).
const WIRE = [
  { endpoint: '/v1/messages', dialect: 'anthropic' },
  { endpoint: '/codex/responses', dialect: 'openai' },
  { endpoint: '/v1/chat/completions', dialect: 'openai' },
]
// What a new session is, in turn: mostly long inference, next to short ones, catalog re-fetches and telemetry.
const KINDS = ['long', 'long', 'long', 'long', 'short', 'catalog', 'telemetry']
const PARALLEL = 4               // sessions in flight: several harnesses interleaved in time, not one after another

const GB = (n) => `${(n / 1e9).toFixed(1)} GB`

/** Deterministic 32-bit PRNG (mulberry32): one seed, one byte stream, on every platform. */
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// ── content: real-text entropy, fresh every turn ───────────────────────────────────────────────────
const CJK = ['把这个函数改成异步的', '缓存命中率只有三成', '这段报错是什么意思', '测试全绿但线上崩了', '继续，别停']
const EMOJI = ['🙂', '🚀', '🔥', '✅', '❌', '🧠', '📦', '🐛']
const TOOLS = ['read', 'grep', 'bash', 'edit']

/** A vocabulary of nonsense words — the shape of prose (a few hundred types, Zipf-distributed) without any corpus in git. */
function vocabulary(next, size = 1200) {
  const abc = 'abcdefghijklmnopqrstuvwxyz'
  const out = []
  for (let i = 0; i < size; i++) { let w = ''; for (let n = 2 + Math.floor(next() * 9); n > 0; n--) w += abc[Math.floor(next() * 26)]; out.push(w) }
  return out
}
// Zipf: P(rank) ∝ 1/rank, by inverse transform on a log-uniform rank — a few words carry most of the text, as in real prose.
const word = (next, v) => v[Math.min(v.length - 1, Math.floor(Math.exp(next() * Math.log(v.length))) - 1)]

/** Natural-language-like text of at least `n` characters: sentences, paragraphs, a little CJK and emoji. */
function prose(next, v, n) {
  let s = ''
  while (s.length < n) {
    let sent = ''
    for (let i = 4 + Math.floor(next() * 14); i > 0; i--) sent += (sent ? ' ' : '') + word(next, v)
    if (next() < 0.08) sent += ` ${CJK[Math.floor(next() * CJK.length)]}`
    if (next() < 0.06) sent += ` ${EMOJI[Math.floor(next() * EMOJI.length)]}`
    s += `${s ? ' ' : ''}${sent[0].toUpperCase()}${sent.slice(1)}.`
    if (next() < 0.12) s += '\n\n'
  }
  return s
}
const codeBlock = (next, v, lines) => `\`\`\`js\n${Array.from({ length: lines }, () =>
  `  const ${word(next, v)} = await ${word(next, v)}(${word(next, v)}, { ${word(next, v)}: ${Math.floor(next() * 1000)} })`).join('\n')}\n\`\`\``
/** Incompressible base64: PRNG bytes, as an image or a pasted file arrives. */
function blobB64(next, bytes) {
  const b = Buffer.allocUnsafe(bytes + 4)
  for (let i = 0; i < bytes; i += 4) b.writeUInt32LE((next() * 4294967296) >>> 0, i)
  return b.subarray(0, bytes).toString('base64')
}

/** One turn of a session: the user's words (sometimes an image), the assistant's reply, a tool call and its result. */
function turn(next, v, i) {
  const user = { role: 'user', content: [{ type: 'text', text: prose(next, v, Math.round(GROWTH * 0.35)) }] }
  if (i % 7 === 3) user.content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: blobB64(next, 1_400) } })
  const use = { id: `toolu_${i}`, name: TOOLS[i % TOOLS.length], input: { path: `src/${word(next, v)}/${word(next, v)}.mjs`, pattern: word(next, v), limit: 40 + Math.floor(next() * 400) } }
  return [
    user,
    { role: 'assistant', content: [{ type: 'text', text: prose(next, v, Math.round(GROWTH * 0.15)) }, { type: 'tool_use', ...use }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: i % 3 === 0 ? codeBlock(next, v, 18) : prose(next, v, Math.round(GROWTH * 0.4)) }] },
  ]
}

// One streamed reply per dialect, with usage — the shapes the dissectors already read.
function sseBody(dialect, text, usage) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  if (dialect === 'anthropic') {
    return Buffer.from(
      ev('message_start', { type: 'message_start', message: { id: 'msg_ds', role: 'assistant', model: 'model-x', content: [], usage: { input_tokens: usage.input, output_tokens: 0, cache_read_input_tokens: usage.cache_read } } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output } })
      + ev('message_stop', { type: 'message_stop' }), 'utf8')
  }
  return Buffer.from(
    `data: ${JSON.stringify({ id: 'cmpl_ds', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] })}\n\n`
    + `data: ${JSON.stringify({ id: 'cmpl_ds', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })}\n\n`
    + 'data: [DONE]\n\n', 'utf8')
}

// A session key the read side really groups by: the harness's own first key, in the header or the body.
function sessionKey(harness, id) {
  const key = (harness.sessionKeys || [])[0]
  if (!key) return { headers: {}, body: {} }
  if (key.from === 'header') return { headers: { [key.name]: id }, body: {} }
  const body = {}
  let at = body
  for (const [i, part] of key.path.entries()) { if (i === key.path.length - 1) at[part] = id; else at = (at[part] = {}) }
  return { headers: {}, body }
}

/** A concrete path for one `traffic` entry of the harness table: the regex source without its anchors and groups. */
const samplePath = (source) => (source ? source.replace(/\\(.)/g, '$1').replace(/\([^)]*\)[?*+]?/g, '').replace(/[\^$]/g, '') || '/' : '/')

class Writer {
  constructor({ home, segmentBytes, maxDisk }) {
    Object.assign(this, { dir: path.join(home, 'raw'), segmentBytes, maxDisk })
    this.segments = []
    this.bytes = 0
    this.records = 0
    this.fd = null
  }
  // The daemon's segment name: the UTC second it opened, a suffix on a collision (4.6).
  open(ms) {
    this.maxMs = Math.max(ms, (this.maxMs || 0) + 1_000)         // segments are named in order, seconds apart, as the daemon's are
    const base = new Date(this.maxMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    let name = base
    for (let n = 2; this.segments.some((s) => s.segment === name); n++) name = `${base}-${n}`
    fs.mkdirSync(this.dir, { recursive: true })
    this.fd = fs.openSync(path.join(this.dir, `${name}.ndjson`), 'a', 0o600)
    this.current = { segment: name, records: 0, bytes: 0 }
    this.segments.push(this.current)
  }
  write(env, ms) {
    if (!this.fd) this.open(ms)
    const line = Buffer.from(`${JSON.stringify(env)}\n`, 'utf8')
    fs.writeSync(this.fd, line)
    this.bytes += line.length; this.records++
    this.current.bytes += line.length; this.current.records++
    if (this.bytes > this.maxDisk) throw new Error(`stopped at ${GB(this.bytes)} on disk: past the ${GB(this.maxDisk)} ceiling`)
    if (this.current.bytes >= this.segmentBytes) { fs.closeSync(this.fd); this.fd = null }
  }
  /** The crash every real capture ends in: half a line, no newline, in the segment that was live (4.6 §记录). */
  half(env, ms) {
    if (!this.fd) this.open(ms)
    const text = JSON.stringify(env)
    const line = Buffer.from(text.slice(0, Math.max(40, Math.floor(text.length * 0.6))), 'utf8')
    fs.writeSync(this.fd, line)
    this.bytes += line.length                     // bytes on disk, but not a record: no reader can read it back
    this.current.bytes += line.length
  }
  close() { if (this.fd) { fs.closeSync(this.fd); this.fd = null } }
}

/**
 * generate({home, seed, bytes, segmentBytes, maxDisk, start}) → {seed, bytes, records, sessions, segments:[{segment, records, bytes}]}
 * `home` is the ASIGHT home: it writes <home>/raw/<segment>.ndjson, all of it plaintext (the CLI then seals all
 * but two, 附录 D.1). Every harness opens with one coverage session (every class, both
 * reply shapes, a cut stream, 429/5xx, a `log`-level batch, a gzipped wire body) so the smallest dataset
 * is still complete; the rest of the budget goes to PARALLEL sessions in flight, interleaved by their own
 * clocks. Throws before writing anything when the estimated peak passes the disk ceiling.
 */
export function generate({ home, seed = DEFAULTS.seed, bytes = DEFAULTS.bytes, segmentBytes = DEFAULTS.segmentBytes, maxDisk = DEFAULTS.maxDisk, start = DEFAULTS.start } = {}) {
  const peak = Math.round(bytes * (1 + SEALED_SHARE)) + segmentBytes
  if (peak > maxDisk) throw new Error(`a ${GB(bytes)} dataset peaks at about ${GB(peak)} on disk, past the ${GB(maxDisk)} ceiling: ask for fewer --bytes`)

  const next = rng(seed)
  const v = vocabulary(next)
  const w = new Writer({ home, segmentBytes, maxDisk })
  const startMs = Date.parse(start)
  let sessions = 0
  // A long session's turn count from the budget: its bytes are about GROWTH/2 × turns² (the context is
  // re-sent whole every turn), so one session takes about SESSION_SHARE of the dataset, +7 KB a turn either way.
  const turns = Math.max(3, Math.min(MAX_TURNS, Math.round(Math.sqrt((bytes * SESSION_SHARE) / (GROWTH / 2)))))

  /** One record. `body` is the response as it went over the wire; `gzip` makes the wire bytes differ from the stored ones. */
  const emit = (s, { endpoint, method = 'POST', req = '', body = Buffer.alloc(0), ctype = 'application/json', status = 200, level = 'full', trafficClass = null, truncated = false, gzip = false, host = null }) => {
    const wire = gzip ? zlib.gzipSync(body) : body
    host = host || s.host
    const tsRequest = new Date(s.ms).toISOString()
    s.ms += 200 + Math.floor(next() * 2_000)
    const tsStart = new Date(s.ms).toISOString()
    s.ms += 50 + Math.floor(next() * 500)
    const tsEnd = new Date(s.ms).toISOString()
    const headers = { 'content-type': 'application/json', host, 'user-agent': `${s.harness.id}/1.0`, ...s.headers }
    const env = buildEnvelope({
      id: `ds_${String(w.records + 1).padStart(8, '0')}`,
      tsRequest, tsRespStart: tsStart, tsRespEnd: tsEnd, durationMs: Date.parse(tsEnd) - Date.parse(tsStart),
      method, endpoint, reqBody: level === 'log' ? null : Buffer.from(req, 'utf8'), reqHeaders: headers,
      resp: level === 'log'
        ? logResponse({ status, headers: { 'content-type': ctype }, wireBytes: wire.length })
        : shapeResponse({ status, headers: [['content-type', ctype], ...(gzip ? [['content-encoding', 'gzip']] : [])], body: wire, truncated, llm: trafficClass === 'llm' }),
      capture: 'transparent', host, trafficClass, retention: level,
      reqWireBytes: Buffer.byteLength(req), respWireBytes: wire.length,
    })
    const line = { ...env, scheme: 'https', dst: `${host}:443`, proc: { agent: s.harness.id, pid: 1000 + s.n, exe: `/usr/bin/${s.harness.id}` }, flow_id: `f${s.n}`, seq: s.seq++ }
    if (s.last) w.half(line, Date.parse(tsRequest)); else w.write(line, Date.parse(tsRequest))
  }

  const askBody = (s, extra = {}) => JSON.stringify({ model: 'model-x', ...extra, messages: s.messages, ...s.body })
  const open = (harness, kind) => {
    sessions++
    const wire = WIRE[HARNESSES.indexOf(harness) % WIRE.length]
    const sk = sessionKey(harness, `ds-${harness.id}-${sessions}`)
    return {
      harness, kind, n: sessions, ...wire, host: `api.${harness.id}.example`, headers: sk.headers, body: sk.body,
      seq: 1, i: 0, messages: [], ms: startMs + Math.floor(next() * 30_000) + sessions * 1_000,
      calls: kind === 'short' ? 1 + Math.floor(next() * 5) : kind === 'long' ? turns : kind === 'catalog' ? 6 + Math.floor(next() * 12) : 8,
      steps: kind === 'cover' ? coverSteps(harness) : null,
      catalog: kind === 'catalog' ? JSON.stringify({ entries: Array.from({ length: 300 }, (_, i) => ({ id: i, name: word(next, v), text: prose(next, v, 100) })) }) : null,
    }
  }

  // The non-LLM classes of this harness, from the read-side table: its own traffic entries plus a
  // third-party telemetry endpoint and a bare ping, so every class is in the dataset at any scale.
  const classEntries = (harness) => [
    ...(harness.traffic || []).map((e) => ({ class: e.class, host: e.host.replace('*.', 'cdn.'), path: samplePath(e.path) })),
    { class: 'telemetry', host: THIRD_PARTY_TELEMETRY[HARNESSES.indexOf(harness) % THIRD_PARTY_TELEMETRY.length].replace('*.', 'a.'), path: '/api/events' },
    { class: 'other', host: `other.${harness.id}.example`, path: '/ping' },
  ]

  /** The coverage pass: one call of every situation this harness can be in, all of them small. */
  function coverSteps(harness) {
    const wire = WIRE[HARNESSES.indexOf(harness) % WIRE.length]
    const ask = (s, extra) => { s.messages.push(...turn(next, v, s.i)); return askBody(s, extra) }   // a fresh turn every step: no two requests repeat
    const steps = [
      // token counting, then a non-streamed JSON reply, then a streamed one
      (s) => emit(s, { endpoint: `${wire.endpoint.replace(/\/[^/]+$/, '')}/count_tokens`, req: ask(s), body: Buffer.from(JSON.stringify({ input_tokens: 1234 })) }),
      (s) => emit(s, { endpoint: wire.endpoint, req: ask(s), trafficClass: 'llm', body: Buffer.from(JSON.stringify({ id: 'r', content: [{ type: 'text', text: prose(next, v, 400) }], usage: { input_tokens: 900, output_tokens: 120 } })) }),
      (s) => emit(s, { endpoint: wire.endpoint, req: ask(s, { stream: true }), trafficClass: 'llm', ctype: 'text/event-stream', body: sseBody(wire.dialect, prose(next, v, 300), { input: 900, output: 120, cache_read: 800 }) }),
      // a stream cut mid-event (the agent was killed), then the two failures every long run meets
      (s) => emit(s, { endpoint: wire.endpoint, req: ask(s, { stream: true }), trafficClass: 'llm', ctype: 'text/event-stream', truncated: true, body: sseBody(wire.dialect, prose(next, v, 300), { input: 900, output: 60, cache_read: 800 }).subarray(0, 180) }),
      (s) => emit(s, { endpoint: wire.endpoint, req: ask(s, { stream: true }), trafficClass: 'llm', status: 429, body: Buffer.from(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } })) }),
      (s) => emit(s, { endpoint: wire.endpoint, req: ask(s, { stream: true }), trafficClass: 'llm', status: 503, body: Buffer.from('upstream unavailable'), ctype: 'text/plain' }),
      // a tiny record: the smallest thing on the wire
      (s) => emit(s, { endpoint: '/ping', method: 'GET', trafficClass: 'other', body: Buffer.from('{}') }),
    ]
    // every non-LLM class of this harness, the catalogs gzipped on the wire, telemetry as a `log`-level batch
    for (const [i, e] of classEntries(harness).entries()) {
      steps.push((s) => e.class === 'telemetry'
        ? emit(s, { host: e.host, endpoint: e.path, req: JSON.stringify({ events: Array.from({ length: 20 }, (_, k) => ({ k, t: prose(next, v, 40) })) }), level: 'log', trafficClass: e.class, body: Buffer.from('{"ok":true}') })
        : emit(s, { host: e.host, endpoint: e.path, method: 'GET', trafficClass: e.class, gzip: i % 2 === 0, body: Buffer.from(JSON.stringify({ entries: Array.from({ length: 12 }, () => ({ name: word(next, v), text: prose(next, v, 80) })) })) }))
    }
    return steps
  }

  /** One call of `s`; false when the session is over. */
  const step = (s) => {
    if (s.kind === 'cover') { if (s.i >= s.steps.length) return false; s.steps[s.i](s); s.i++; return true }
    if (s.i >= s.calls) return false
    const i = s.i++
    if (s.kind === 'telemetry') {
      emit(s, { endpoint: '/api/events', req: JSON.stringify({ batch: Array.from({ length: 30 }, (_, k) => ({ k, at: s.ms, text: prose(next, v, 60) })) }), level: 'log', trafficClass: 'telemetry', body: Buffer.from('{"ok":true}') })
      return true
    }
    if (s.kind === 'catalog') {
      // a catalog re-fetched again and again: mostly the same bytes, now and then a changed entry
      const body = i % 5 === 4 ? `${s.catalog.slice(0, -1)},"rev":${i}}` : s.catalog
      emit(s, { endpoint: '/v1/catalog', method: 'GET', trafficClass: 'files', gzip: i % 3 !== 0, body: Buffer.from(body) })
      return true
    }
    s.messages.push(...turn(next, v, i))
    if (s.kind === 'short' && i === 0) {   // the many short sessions start by counting tokens
      emit(s, { endpoint: `${s.endpoint.replace(/\/[^/]+$/, '')}/count_tokens`, req: askBody(s), body: Buffer.from(JSON.stringify({ input_tokens: 2048 })) })
      return true
    }
    const streamed = (s.n + i) % 4 !== 0  // most replies stream; some come back as one JSON document
    const usage = { input: Math.round(JSON.stringify(s.messages).length / 4), output: 120, cache_read: i ? Math.round(JSON.stringify(s.messages).length / 4) : 0 }
    emit(s, {
      endpoint: s.endpoint, req: askBody(s, streamed ? { stream: true } : {}), trafficClass: 'llm',
      ctype: streamed ? 'text/event-stream' : 'application/json',
      body: streamed ? sseBody(s.dialect, prose(next, v, 400), usage)
        : Buffer.from(JSON.stringify({ id: 'r', content: [{ type: 'text', text: prose(next, v, 400) }], usage: { input_tokens: usage.input, output_tokens: usage.output } })),
    })
    return true
  }

  // Phase 1 — coverage: every harness, every class, every shape, all of it small, run to the END (so the
  // smallest useful dataset is still complete; it costs tens of KB a harness and may overshoot a tiny budget).
  const cover = HARNESSES.map((h) => open(h, 'cover'))
  while (cover.length) { cover.sort((a, b) => a.ms - b.ms); if (!step(cover[0])) cover.shift() }

  // Phase 2 — volume: PARALLEL sessions in flight, interleaved in time by their own clocks. The first
  // round is one long session per harness (so every harness has a growing context at any scale); after
  // that the kind steps by 3 — coprime with both table lengths, so every harness sees every kind.
  const kindFor = (n) => (n < HARNESSES.length ? 'long' : KINDS[(n * 3) % KINDS.length])
  let k = 0
  const active = Array.from({ length: PARALLEL }, () => open(HARNESSES[k % HARNESSES.length], kindFor(k++)))
  let huge = bytes >= 4 * HUGE
  while (w.bytes < bytes) {
    active.sort((a, b) => a.ms - b.ms)                            // the earliest clock speaks
    const s = active[0]
    if (!step(s)) {
      if (huge) {   // one record past 10 MB: a whole file pasted into the conversation
        huge = false
        s.messages.push({ role: 'user', content: [{ type: 'document', data: blobB64(next, Math.floor(HUGE * 0.75)) }] })
        emit(s, { endpoint: s.endpoint, req: askBody(s), trafficClass: 'llm', body: Buffer.from(JSON.stringify({ id: 'r', content: [{ type: 'text', text: prose(next, v, 400) }], usage: { input_tokens: 3_000_000, output_tokens: 30 } })) })
      }
      active[0] = open(HARNESSES[k % HARNESSES.length], kindFor(k++))
    }
  }
  const s = active[0]
  s.last = true                                                  // the crash: half a line at the end of the last segment
  s.messages = s.messages.slice(-3)
  step(s)
  w.close()
  return { seed, bytes: w.bytes, records: w.records, sessions, segments: w.segments, peak_estimate_bytes: peak }
}

/**
 * sealMost(asightHome, {keep}) → [{segment, bytes, sealedBytes, ms}] for the segments it sealed.
 * 附录 D.1 总量: most segments sealed, `keep` left plaintext (the live one and the one just closed).
 */
export async function sealMost(asightHome, { keep = 2 } = {}) {
  const dir = path.join(asightHome, 'raw')
  const plain = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()
  const out = []
  for (const f of plain.slice(0, Math.max(0, plain.length - keep))) {
    const file = path.join(dir, f), bytes = fs.statSync(file).size, at = Date.now()
    // no daemon is running on a dataset being built, so no lock names a live segment; the last `keep` files are never passed in
    const r = await sealSegment(file, { lockFile: path.join(asightHome, 'lock'), journal: path.join(asightHome, 'journal.ndjson') })
    out.push({ segment: f.replace(/\.ndjson$/, ''), bytes, sealedBytes: r.sealedBytes, ms: Date.now() - at })
  }
  return out
}

async function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!args.home) { console.error('usage: node scripts/gen-dataset.mjs --home <dir> [--seed 1] [--bytes 1000000000] [--keep-plain 2] [--json]   (--home is the HOME; the dataset lands in <home>/.asight/raw)'); process.exit(2) }
  const num = (k) => (args[k] === undefined ? undefined : Number(args[k]))
  const home = path.join(args.home, '.asight')
  const started = Date.now()
  const out = generate({ home, seed: num('seed'), bytes: num('bytes'), segmentBytes: num('segment-bytes'), maxDisk: num('max-disk'), start: args.start })
  const took = Date.now() - started
  const sealedAt = Date.now()
  const sealed = await sealMost(home, { keep: num('keep-plain') ?? 2 })
  const summary = { ...out, home, sealed, took_ms: took, seal_ms: Date.now() - sealedAt }
  if ('json' in args) { console.log(JSON.stringify(summary, null, 2)); return }
  console.log(`seed ${out.seed}  records ${out.records}  bytes ${out.bytes}  sessions ${out.sessions}  segments ${out.segments.length}  ${took} ms`)
  for (const s of out.segments) {
    const z = sealed.find((x) => x.segment === s.segment)
    console.log(`  ${s.segment}  ${String(s.records).padStart(8)} records  ${String(s.bytes).padStart(12)} bytes  ${z ? `sealed ${String(z.sealedBytes).padStart(11)} bytes (${((z.sealedBytes / z.bytes) * 100).toFixed(2)}%, ${z.ms} ms)` : 'plaintext'}`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main(process.argv.slice(2))
