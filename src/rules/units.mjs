// units.mjs (src/rules) — a captured record as the units a rule would have seen on the live path (RFC 1.6 §4.4 `rules test`, 5.1 §记录与标注). Pure: bytes in, units out.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isLogOnly, reqIncompleteOf } from '../dissect/capture-labels.mjs'
import { harnessOf, HARNESSES } from '../dissect/harnesses.mjs'
import { sseEvents, storedReply } from '../dissect/sse-spans.mjs'
import { applyEdits } from './edits.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pairsOf = (headers) => Object.entries(headers ?? {}).flatMap(([name, value]) => [].concat(value).map((one) => [name, String(one)]))
const fromB64 = (text) => Buffer.from(text, 'base64')

// A row's `agents` is the read side's id, then the code id when they differ: a rule names the code id.
const codeIdOf = (read) => HARNESSES.find((row) => row.id === read)?.agents.at(-1) ?? read

function wireRequest(rec) {
  if (typeof rec.req_body_b64 === 'string') return fromB64(rec.req_body_b64)
  return typeof rec.req_body === 'string' ? Buffer.from(rec.req_body, 'utf8') : null
}

/** What the agent sent, from what went out and the record's `agent_request`; null when that does not check out. */
function agentRequest(wire, { recover, edits, body_b64: inline, base_sha256: base, result_sha256: result }) {
  const start = wire ?? Buffer.alloc(0)
  if (sha256(start) !== base) return null
  let bytes
  try { bytes = recover === 'inline' ? fromB64(inline) : applyEdits(start, edits) } catch { return null }
  return sha256(bytes) === result ? bytes : null
}

function requestUnits(rec, unit, asSent) {
  const wire = wireRequest(rec), recover = rec.intervention?.agent_request
  const body = recover && !asSent ? agentRequest(wire, recover) : wire
  if (recover && !asSent && !body) return { cannot: 'not-restorable' }
  return { units: [{ ...unit, encoding: rec.req_content_encoding ?? null, body }] }
}

// Each event's cut runs to the next one's, so that what lies between events stays with one of them and the cuts add up to the text. A text without events is one unit.
function eventsOf(text) {
  const ends = sseEvents(text).map((event) => event.end)
  if (!ends.length) return [text]
  ends[ends.length - 1] = text.length
  return ends.map((end, i) => text.slice(ends[i - 1] ?? 0, end))
}

function responseUnits(rec, unit, rule) {
  const { r, part } = storedReply(rec)
  if (!r) return { cannot: 'no-response' }
  if (part.truncated === true) return { cannot: 'truncated' }
  const sse = part.kind === 'sse', head = { ...unit, sse, status: r.status ?? null, headers: pairsOf(r.headers) }
  if (sse && !rule.whole && typeof part.raw === 'string') {
    return { units: eventsOf(part.raw).map((text, i) => ({ ...head, event_index: i, body: Buffer.from(text, 'utf8') })) }
  }
  const text = part.raw ?? (part.body === undefined ? null : JSON.stringify(part.body))
  const body = typeof part.raw_b64 === 'string' ? fromB64(part.raw_b64) : text === null ? null : Buffer.from(text, 'utf8')
  return { units: [{ ...head, body }] }
}

// A message as stored: its text, or `{b64}`. Anything else kept only its size or could not be decoded.
function messageBytes(message) {
  if (typeof message === 'string') return Buffer.from(message, 'utf8')
  return typeof message?.b64 === 'string' && !message.decode_error ? fromB64(message.b64) : null
}

function messageUnits(rec, unit, on) {
  if (rec.ws_truncated === true) return { cannot: 'truncated' }
  const first = typeof rec.req_body_b64 === 'string' ? { b64: rec.req_body_b64 } : rec.req_body
  const messages = on === 'ws-client' ? [...(first == null ? [] : [first]), ...(rec.req_extra_messages ?? [])] : storedReply(rec).part?.messages ?? []
  const bodies = messages.map(messageBytes)
  if (bodies.includes(null)) return { cannot: 'message-not-kept' }
  return { units: bodies.map((body) => ({ ...unit, body })) }
}

/**
 * `rule` is read for `on` and `whole`, `asSent` takes the wire's request over the agent's → `{units}` in applyRules's shape, none when the record is not of the rule's transport, or
 * `{cannot}` with why it cannot be tested: log-only, truncated, partial, no-response, not-restorable, message-not-kept. Head values are as stored, credentials included.
 */
export function unitsOf(rec, rule, { asSent = false } = {}) {
  if (isLogOnly(rec)) return { cannot: 'log-only' }
  const incomplete = reqIncompleteOf(rec)
  if (incomplete) return { cannot: incomplete.truncated ? 'truncated' : 'partial' }
  const { on } = rule, ws = on.startsWith('ws-')
  if (ws !== (rec.transport === 'ws')) return { units: [] }
  const reqHeaders = pairsOf(rec.req_headers)
  const unit = {
    on, harness: codeIdOf(harnessOf(rec).id), pid: rec.proc?.pid ?? null, method: rec.method ?? null, host: rec.host ?? null, path: rec.endpoint ?? null, class: rec.traffic_class ?? null,
    status: null, event_index: null, sse: false, encoding: null, headers: reqHeaders, req_headers: reqHeaders,
  }
  if (ws) return messageUnits(rec, on === 'ws-client' ? unit : { ...unit, headers: pairsOf(rec.resp?.headers) }, on)
  return on === 'request' ? requestUnits(rec, unit, asSent) : responseUnits(rec, unit, rule)
}
