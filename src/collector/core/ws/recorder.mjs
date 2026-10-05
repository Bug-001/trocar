// recorder.mjs — the WebSocket side-copy recorder (RFC 4.6 §传输与帧级记录, D37). After the upstream's
// 101 the engine keeps forwarding the original bytes; this reads a copy of both directions and writes
// one envelope per logical call. Each direction keeps its permessage-deflate context from its first
// frame (parameters from the 101, never the offer).
//   A call = one client data message + the server messages after it, up to the terminal message the
//   harness declared as DATA (RegExp sources on the message head, D20: no provider code here). While
//   it is open, further client data messages join it (req_extra_messages). With no pattern for this
//   path a call runs to the next client data message or the end of the connection. A server message
//   that arrives with no call open is a call of its own (req_body:null), written at once.
// Frames are numbered across both directions. Each frame lands in exactly one place, in number order:
// a call takes every waiting frame below its cut (frames between calls ride with the next call), and
// what is left at the end is the summary's tail_raw. So the envelopes' ws_raw plus tail_raw rebuild
// the connection verbatim (raw.mjs::rebuildWsWire). Recording never throws into the forwarding path.
import { createFrameParser, createMessageAssembler, OP } from './frames.mjs'
import { parseExtensions, createInflater } from './deflate.mjs'
import { messageBytes } from './raw.mjs'
import { buildWsEnvelope } from '../record/envelope.mjs'
import { isLlmCall } from '../../../capture/envelope.mjs'

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) // a BOM stays: bytes, not text
const CLOSED = { type: 'ws_closed', message: 'connection closed before the terminal message' }

/** compileTerminal(spec, target) → null | (bytes) => boolean
 *  spec = [{pathSuffix?, patterns:[RegExp source], headBytes = 256}]: the first entry whose pathSuffix
 *  ends the target's path (query stripped) and has a usable pattern wins; patterns are tested against
 *  the message's first headBytes bytes read as latin1 (byte patterns). */
export function compileTerminal(spec, target) {
  const path = String(target || '').split('?')[0]
  for (const t of [].concat(spec || [])) {
    if (!t || (t.pathSuffix && !path.endsWith(t.pathSuffix))) continue
    const res = []
    for (const src of t.patterns || []) { try { res.push(new RegExp(src)) } catch { /* unusable harness data: skipped */ } }
    if (!res.length) continue
    const n = t.headBytes ?? 256
    return (bytes) => { const h = bytes.subarray(0, n).toString('latin1'); return res.some((r) => r.test(h)) }
  }
  return null
}

/**
 * createWsRecorder({flow, upgrade, seqStart, genId, recordStore, isRecording, terminal, maxCallBytes, now})
 *   → { fromClient(chunk), fromUpstream(chunk), end(error|null), summary() }
 * upgrade = {req:{head}, resp:{head}} (the exchange tee's heads); terminal = FlowExtras.wsTerminal.
 * summary() = {frames, calls, recorded, partial, dropped_frames, tail_raw?, broken?} for flows/.
 */
export function createWsRecorder({ flow, upgrade, seqStart = 0, genId, recordStore, isRecording = () => true, terminal = null, maxCallBytes = 64 << 20, now = () => new Date() }) {
  const ext = (upgrade.resp.head.headers || []).filter(([k]) => k.toLowerCase() === 'sec-websocket-extensions').map(([, v]) => v).join(', ')
  const { deflate } = parseExtensions(ext)
  const isTerminal = compileTerminal(terminal, upgrade.req.head.target)
  const keepClient = isLlmCall(upgrade.req.head.target) // a non-LLM client message is metadata only (RFC 4.1)
  const side = (noCtx) => ({ parser: createFrameParser({ maxPayload: maxCallBytes }), asm: createMessageAssembler(), inflater: deflate ? createInflater({ noContextTakeover: noCtx }) : null, msg: null, broken: null })
  const dirs = { c: side(!!deflate && deflate.clientNoContextTakeover), s: side(!!deflate && deflate.serverNoContextTakeover) }
  const stats = { frames: 0, calls: 0, recorded: 0, partial: 0, dropped_frames: 0 }
  let kept = []    // frames waiting for an envelope: {i, d, header, payload, msg, off}
  let open = null  // the call being collected
  let tail = []
  let idx = 0
  let seq = seqStart
  let ended = false
  const iso = () => now().toISOString()

  // A ws_raw entry: p = the payload; m = [k, offset] into message k of this envelope (stored bytes,
  // uncompressed); neither = the payload is not retained (non-LLM client message, past the cap).
  function entry(e, call) {
    const out = { i: e.i, d: e.d, h: e.header.toString('base64') }
    const h = e.msg
    if (h && h.omit) return out
    if (h && h.call === call && h.slice) out.m = [h.k, e.off]
    else if (e.payload) out.p = e.payload.toString('base64')
    return out
  }

  function openCall(h) {
    open = { record: true, client: [], server: [], tsStart: h.ts, tsRespStart: null, seq: seq++ }
    stats.calls++
  }

  // Close the open call with every waiting frame numbered below `cut`.
  function close(cut, error) {
    const call = open; open = null
    const take = kept.filter((e) => e.i < cut)
    kept = kept.filter((e) => e.i >= cut)
    const env = buildWsEnvelope({
      id: genId(), flow, seq: call.seq, upgrade, error, wsRaw: take.map((e) => entry(e, call)),
      call: { client: call.client, server: call.server, tsStart: call.tsStart, tsRespStart: call.tsRespStart, tsEnd: iso(), partial: [], truncated: false },
    })
    let ok = false
    try { ok = recordStore.envelope(env) !== false } catch { ok = false }
    if (ok) stats.recorded++
  }

  function join(call, h) {
    h.call = call
    const list = h.d === 'c' ? call.client : call.server
    h.k = list.length
    list.push(h.value)
    if (h.d === 's' && !call.tsRespStart) call.tsRespStart = h.ts
  }

  function decode(D, ev) {
    let bytes = ev.message
    if (ev.compressed) {
      if (!D.inflater) return { value: { b64: bytes.toString('base64'), decode_error: 'RSV1 set but the 101 agreed no permessage-deflate' } }
      try { bytes = D.inflater.inflate(ev.message) } catch (err) {
        return { value: { b64: ev.message.toString('base64'), decode_error: String((err && err.message) || err) } }
      }
    }
    if (ev.opcode === OP.TEXT) { try { return { value: utf8.decode(bytes), bytes } } catch { /* not UTF-8: kept as bytes */ } }
    return { value: { b64: bytes.toString('base64') }, bytes }
  }

  // A complete data message joins a call (cut rules in the header comment).
  function complete(D, h, ev) {
    const { value, bytes } = decode(D, ev)
    h.value = h.meta ? { raw_chars: bytes ? bytes.length : h.wire, verbatim: false } : value
    h.slice = !h.meta && !h.compressed && messageBytes(value) !== null
    if (h.d === 'c') {
      if (!(open && isTerminal)) {
        if (open) close(h.first, null)
        openCall(h)
      }
      join(open, h)
    } else if (open) {
      join(open, h)
      if (isTerminal && bytes && isTerminal(bytes)) close(idx, null)
    } else {
      openCall(h); join(open, h); close(idx, null)
    }
  }

  function onFrame(d, f) {
    const D = dirs[d]
    const i = idx++
    stats.frames++
    const ev = D.asm.push(f)
    let h = null
    if (ev.type === 'data') {
      if (ev.start) D.msg = { d, first: i, ts: iso(), compressed: ev.compressed, wire: 0, meta: d === 'c' && !keepClient }
      h = D.msg
      h.wire += f.payload ? f.payload.length : f.omitted
      if (h.meta) h.omit = true // its frames never keep a payload, in whichever envelope they land
    }
    kept.push({ i, d, header: f.header, payload: f.payload, msg: h, off: ev.offset || 0 })
    if (ev.type === 'error') D.broken = ev.error
    else if (ev.type === 'data' && ev.done) { D.msg = null; complete(D, h, ev) }
  }

  function feed(d, chunk) {
    const D = dirs[d]
    if (ended || D.broken) return
    try {
      const { frames, error } = D.parser.push(chunk)
      for (const f of frames) { onFrame(d, f); if (D.broken) break }
      if (error && !D.broken) D.broken = error
    } catch (e) { D.broken = String((e && e.message) || e) }
  }

  function finish(error) {
    if (ended) return
    ended = true
    try {
      if (open) close(Infinity, error || (isTerminal ? CLOSED : null))
      tail = kept.map((e) => entry(e, null))
      kept = []
    } catch { /* never into the relay */ }
  }

  return {
    fromClient: (chunk) => feed('c', chunk),
    fromUpstream: (chunk) => feed('s', chunk),
    end: (error) => finish(error || null),
    summary: () => {
      const broken = Object.fromEntries(['c', 's'].filter((d) => dirs[d].broken).map((d) => [d, dirs[d].broken]))
      return { ...stats, ...(tail.length ? { tail_raw: tail } : {}), ...(Object.keys(broken).length ? { broken } : {}) }
    },
  }
}
