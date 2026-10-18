// scripts/gen-dataset.mjs — the reference dataset of spec 1.6 附录 D.1, as a generator (附录 D: a 1 GB
// fixture does not belong in git, the generator is the readable spec). It writes plaintext segments into
// <home>/raw/ the way the daemon does, and stops rather than fill a disk.
//
//   node scripts/gen-dataset.mjs --home <dir> [--seed 1] [--bytes 1000000000] [--json]
//
// The segments are left PLAINTEXT on purpose: what 附录 D.2 measures is the daemon's own auto-sealing
// (which closed segments it sealed, how long each took). The envelopes are built by the one authority
// (src/capture/envelope.mjs) and the harnesses, classes and endpoints come from the read-side tables —
// this script holds dataset SHAPES (how big, how many, how fast they grow), no provider knowledge.
import fs from 'node:fs'
import path from 'node:path'
import { buildEnvelope, logResponse } from '../src/capture/envelope.mjs'
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
// 附录 D.1 长会话, measured on OpenCode: ~0.8 MB of context per call, +7 KB a turn, 14-300 calls.
const LONG = { ctx: 800_000, growth: 7_000, minCalls: 14, maxCalls: 300 }
const DIRECTORY_BYTES = 2_700_000  // the one directory response fetched again and again (附录 D.1 非 LLM)
// Per harness: the inference endpoint and wire dialect of its already-captured samples (test/fixtures/).
const WIRE = [
  { endpoint: '/v1/messages', dialect: 'anthropic' },
  { endpoint: '/codex/responses', dialect: 'openai' },
  { endpoint: '/v1/chat/completions', dialect: 'openai' },
]

const GB = (n) => `${(n / 1e9).toFixed(1)} GB`

/** Deterministic 32-bit PRNG (mulberry32): one seed, one byte stream, on every platform. */
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** A pool of pseudo-random text; bodies are slices of it, so megabytes cost no per-character randomness. */
function pool(next, size = 1 << 16) {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.'
  let s = ''
  while (s.length < size) s += abc[Math.floor(next() * abc.length)]
  return s
}
const filler = (p, offset, n) => {
  let s = p.slice(offset % p.length) // always a whole-pool chunk after the first: never one character at a time
  while (s.length < n) s += p
  return s.slice(0, n)
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
  constructor({ home, segmentBytes, maxDisk, startMs }) {
    Object.assign(this, { dir: path.join(home, 'raw'), segmentBytes, maxDisk, startMs })
    this.segments = []
    this.bytes = 0
    this.records = 0
    this.fd = null
  }
  // The daemon's segment name: the UTC second it opened, a suffix on a collision (4.6).
  open(ms) {
    const base = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
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
  close() { if (this.fd) { fs.closeSync(this.fd); this.fd = null } }
}

/**
 * generate({home, seed, bytes, segmentBytes, maxDisk, start}) → {seed, bytes, records, sessions, segments:[{segment, records, bytes}]}
 * Writes <home>/raw/<segment>.ndjson. Each harness gets an equal share of the byte target, spent on long
 * inference sessions, many short ones and its non-LLM classes, so every harness and class is present at
 * any scale. Throws before writing anything when the estimated peak passes the disk ceiling.
 */
export function generate({ home, seed = DEFAULTS.seed, bytes = DEFAULTS.bytes, segmentBytes = DEFAULTS.segmentBytes, maxDisk = DEFAULTS.maxDisk, start = DEFAULTS.start } = {}) {
  const peak = Math.round(bytes * (1 + SEALED_SHARE)) + segmentBytes
  if (peak > maxDisk) throw new Error(`a ${GB(bytes)} dataset peaks at about ${GB(peak)} on disk, past the ${GB(maxDisk)} ceiling: ask for fewer --bytes`)

  const next = rng(seed)
  const p = pool(next)
  const w = new Writer({ home, segmentBytes, maxDisk, startMs: Date.parse(start) })
  let ms = Date.parse(start)
  let sessions = 0
  const share = bytes / HARNESSES.length

  const call = ({ harness, session, endpoint, host, method, reqBody, respBody, ctype, level, trafficClass, wireResp }) => {
    const tsRequest = new Date(ms).toISOString()
    ms += 200 + Math.floor(next() * 2_000)
    const tsStart = new Date(ms).toISOString()
    ms += 50 + Math.floor(next() * 500)
    const tsEnd = new Date(ms).toISOString()
    const headers = { 'content-type': 'application/json', host, 'user-agent': `${harness.id}/1.0`, ...session.headers }
    const env = buildEnvelope({
      id: `ds_${String(w.records + 1).padStart(8, '0')}`,
      tsRequest, tsRespStart: tsStart, tsRespEnd: tsEnd, durationMs: Date.parse(tsEnd) - Date.parse(tsStart),
      method, endpoint, reqBody: level === 'log' ? null : Buffer.from(reqBody, 'utf8'), reqHeaders: headers,
      resp: level === 'log'
        ? logResponse({ status: 200, headers: { 'content-type': ctype }, wireBytes: wireResp })
        : shapeResponse({ status: 200, headers: [['content-type', ctype]], body: respBody, llm: trafficClass === 'llm' }),
      capture: 'transparent', host, trafficClass, retention: level,
      reqWireBytes: Buffer.byteLength(reqBody), respWireBytes: wireResp,
    })
    w.write({ ...env, scheme: 'https', dst: `${host}:443`, proc: { agent: harness.id, pid: 1000 + sessions, exe: `/usr/bin/${harness.id}` }, flow_id: `f${sessions}`, seq: session.seq++ }, Date.parse(tsRequest))
  }

  for (const [hi, harness] of HARNESSES.entries()) {
    const wire = WIRE[hi % WIRE.length]
    const host = `api.${harness.id}.example`
    const newSession = () => { sessions++; return { ...sessionKey(harness, `ds-${harness.id}-${sessions}`), seq: 1 } }
    // Each harness owns the slice [hi*share, (hi+1)*share) of the target: a round that overshoots its own
    // budget eats into THIS harness's later rounds, never into the harnesses after it (so every harness and
    // every class is present at any scale). `bytes` is the scale knob: a few hundred KB in the self-test,
    // ~1 GB.
    const ceiling = (hi + 1) * share
    const spend = (budget, fn) => {
      const until = Math.min(w.bytes + budget, ceiling)
      const more = () => w.bytes < until
      while (more()) { const before = w.bytes; fn(more); if (w.bytes === before) return }
    }

    // the non-LLM classes: the harness's own traffic entries (one directory response fetched again and
    // again, a different wire size every time) plus small telemetry batches kept at the `log` level
    const entries = [...(harness.traffic || []).map((e) => ({ class: e.class, host: e.host.replace('*.', 'cdn.'), path: samplePath(e.path) })),
      { class: 'telemetry', host: THIRD_PARTY_TELEMETRY[hi % THIRD_PARTY_TELEMETRY.length].replace('*.', 'a.'), path: '/api/events' },
      { class: 'other', host: `other.${harness.id}.example`, path: '/ping' }]
    spend(share * 0.25, () => {
      const s = newSession()
      // one whole pass per round, so every class of this harness is present even at the smallest scale;
      // the per-fetch size is derived from the budget, so a pass cannot overshoot it by much
      for (const e of entries) {
        if (e.class === 'telemetry') {
          for (let i = 0; i < 40; i++) call({ harness, session: s, endpoint: e.path, host: e.host, method: 'POST', reqBody: filler(p, i, 300), respBody: Buffer.alloc(0), ctype: 'application/json', level: 'log', trafficClass: e.class, wireResp: 20 + Math.floor(next() * 200) })
          continue
        }
        const size = Math.max(500, Math.min(DIRECTORY_BYTES, Math.floor(share * 0.25 / (entries.length * 2))))
        const respBody = Buffer.from(JSON.stringify({ entries: filler(p, Math.floor(next() * p.length), size) }), 'utf8')
        // the same body, a different wire size each fetch: compression and framing differ per request
        call({ harness, session: s, endpoint: e.path, host: e.host, method: 'GET', reqBody: '', respBody, ctype: 'application/json', level: 'full', trafficClass: e.class, wireResp: Math.round(respBody.length * (0.3 + next() * 0.4)) })
      }
    })
    // short sessions (1-5 calls) and token counting: the many, the shape lists and paging really see
    spend(share * 0.15, () => {
      const s = newSession()
      const calls = 1 + Math.floor(next() * 5)
      for (let i = 0; i < calls; i++) {
        const tokenCount = i === 0 // every short session starts by counting tokens, so the class is always in the dataset
        const text = filler(p, i * 31, 2_000 + Math.floor(next() * 20_000))
        const reqBody = JSON.stringify({ model: 'model-x', messages: [{ role: 'user', content: text }], ...s.body })
        const respBody = Buffer.from(JSON.stringify(tokenCount ? { input_tokens: Math.round(text.length / 4) } : { id: 'r', content: [{ type: 'text', text: filler(p, i, 500) }], usage: { input_tokens: 9, output_tokens: 7 } }), 'utf8')
        call({ harness, session: s, endpoint: tokenCount ? `${wire.endpoint.replace(/\/[^/]+$/, '')}/count_tokens` : wire.endpoint, host, method: 'POST', reqBody, respBody, ctype: 'application/json', level: 'full', trafficClass: null, wireResp: respBody.length })
      }
    })

    // long inference sessions (60% of the share): a growing context, streamed replies with usage
    const ctx = Math.max(2_000, Math.min(LONG.ctx, Math.floor(share * 0.6 / LONG.minCalls)))
    const growth = Math.max(16, Math.round(ctx * (LONG.growth / LONG.ctx)))
    spend(share * 0.6, (more) => {
      const s = newSession()
      const calls = LONG.minCalls + Math.floor(next() * (LONG.maxCalls - LONG.minCalls))
      for (let i = 0; i < calls && more(); i++) {
        const text = filler(p, i * 97, ctx + i * growth)
        const reqBody = JSON.stringify({ model: 'model-x', stream: true, messages: [{ role: 'user', content: text }], ...s.body })
        const respBody = sseBody(wire.dialect, filler(p, i, 400), { input: Math.round(text.length / 4), output: 100, cache_read: i ? Math.round(text.length / 4) : 0 })
        call({ harness, session: s, endpoint: wire.endpoint, host, method: 'POST', reqBody, respBody, ctype: 'text/event-stream', level: 'full', trafficClass: 'llm', wireResp: respBody.length })
      }
    })

  }
  w.close()
  return { seed, bytes: w.bytes, records: w.records, sessions, segments: w.segments, peak_estimate_bytes: peak }
}

function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!args.home) { console.error('usage: node scripts/gen-dataset.mjs --home <dir> [--seed 1] [--bytes 1000000000] [--json]'); process.exit(2) }
  const num = (k) => (args[k] === undefined ? undefined : Number(args[k]))
  const started = Date.now()
  const out = generate({ home: args.home, seed: num('seed'), bytes: num('bytes'), segmentBytes: num('segment-bytes'), maxDisk: num('max-disk'), start: args.start })
  const summary = { ...out, home: args.home, took_ms: Date.now() - started }
  if ('json' in args) { console.log(JSON.stringify(summary, null, 2)); return }
  console.log(`seed ${out.seed}  records ${out.records}  bytes ${out.bytes}  sessions ${out.sessions}  segments ${out.segments.length}  ${summary.took_ms} ms`)
  for (const s of out.segments) console.log(`  ${s.segment}  ${String(s.records).padStart(8)} records  ${String(s.bytes).padStart(12)} bytes`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2))
