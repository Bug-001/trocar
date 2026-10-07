// recorder.mjs — the WebSocket side-copy recorder (RFC 4.6 §传输与帧级记录, D37). After the upstream's
// 101 the engine keeps forwarding the original bytes; this reads a copy of both directions and writes
// one envelope per logical call. Each direction keeps its permessage-deflate context from its first
// frame (parameters from the 101, never the offer).
//   A call = one client data message + the server messages after it, up to the terminal message the
//   harness declared as DATA (RegExp sources on the message head, D20: no provider code here). While
//   it is open, further client data messages join it (req_extra_messages). With no pattern for this
//   path — or once the call's server messages no longer decode, so its terminal message cannot be
//   seen — a call runs to the next client data message or the end of the connection. A server message
//   that arrives with no call open is a call of its own (req_body:null), written at once.
// Frames are numbered across both directions and each lands in exactly one place: a data frame goes
// with its message's call (a message in flight at a cut waits for its own call), a control frame with
// the call that closes past it (frames between calls ride with the next call), and what is left at the
// end is the summary's tail_raw. Sorted by frame number, the envelopes' ws_raw plus tail_raw rebuild
// the connection verbatim (raw.mjs::rebuildWsWire). Recording never throws into the forwarding path.
//   Retention (D40, RFC 4.6 §记录「保存级别」): every call is kept verbatim, whatever the endpoint — before D40 only an LLM
// endpoint's client messages were — unless the operator set this harness × class to `log`. The level is sampled when the
// call's FIRST frame arrives (retention(method, target) → {class, level}; the exchange tee's sampler, the same instant as
// the switch), so a change reaches the calls that start after it. At `log` the call's messages are {raw_chars, verbatim:false}
// (the wire byte count) and its frames keep their headers but no payload; the terminal message is still recognised, so the
// calls are cut where they would be. body_wire_bytes counts every payload byte of the call, kept or not.
//   Switch (C14): a call is recorded or not by the switch at its first frame; a message begun off
// joins a recorded call only if it began inside it, and frames that arrive off and belong to no
// recorded call are dropped; every message is still inflated (state only in memory). partial (C8):
// after a gap (off-window, write-failed, decode-failed) every later call of the connection is marked;
// the collector cannot tell which ones depend on what is missing. Cap (C13): a call keeps at most
// maxCallBytes of message payload, later messages are {omitted_bytes}.
import { createFrameParser, createMessageAssembler, OP } from './frames.mjs'
import { parseExtensions, createInflater } from './deflate.mjs'
import { messageBytes } from './raw.mjs'
import { buildWsEnvelope } from '../record/envelope.mjs'
import { endpointClass } from '../../../capture/envelope.mjs'

const noFailureSink = (r) => { throw Object.assign(new Error(`capture failure with nowhere to be recorded: ${r.code}: ${r.reason}`), { code: r.code }) } // a wiring fault: loud, never dropped

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) // a BOM stays: bytes, not text
const CLOSED = { type: 'ws_closed', message: 'connection closed before the terminal message' }
const REASONS = ['off-window', 'write-failed', 'decode-failed']
export const MAX_CALL_BYTES = 64 << 20 // per call, like the HTTP body cap (RFC 4.6 §传输与帧级记录 大小上限)

/** compileTerminal(spec, target) → null | (bytes) => boolean
 *  spec = [{pathSuffix?, patterns:[RegExp source], headBytes = 256}]: the first entry whose pathSuffix
 *  ends the target's path (query stripped) and has a usable pattern wins; patterns are tested against
 *  the message's first headBytes bytes read as latin1 (byte patterns). A pattern that does not compile is
 *  skipped and handed to onInvalid(source, error) (the recorder writes pattern-invalid, D38). */
export function compileTerminal(spec, target, onInvalid = () => {}) {
  const path = String(target || '').split('?')[0]
  for (const t of [].concat(spec || [])) {
    if (!t || (t.pathSuffix && !path.endsWith(t.pathSuffix))) continue
    const res = []
    for (const src of t.patterns || []) { try { res.push(new RegExp(src)) } catch (e) { onInvalid(src, e) } } // unusable harness data: skipped, reported
    if (!res.length) continue
    const n = t.headBytes ?? 256
    return (bytes) => { const h = bytes.subarray(0, n).toString('latin1'); return res.some((r) => r.test(h)) }
  }
  return null
}

/**
 * createWsRecorder({flow, upgrade, seqStart, genId, recordStore, isRecording, terminal, retention, maxCallBytes, now, onFailure, onTurnEnd})
 *   → { fromClient(chunk), fromUpstream(chunk), end(error|null), summary(), state() }
 * onTurnEnd() is called once a call has closed on its terminal message (the engine's drain gate closes the connection
 * after the chunk that carried it, 1.6 §1.3). state() = where the connection stands: 'idle' = no call open and no
 * message in flight (a connection `off` may close at once); 'open' = a call is open and its terminal message is awaited;
 * 'blind' = the recorder cannot see where a turn ends (the harness declared no terminal message, the open call may have
 * lost its terminal message, or a direction is no longer followed) — such a connection is not closed by off.
 * upgrade = {req:{head}, resp:{head}} (the exchange tee's heads); terminal = FlowExtras.wsTerminal.
 * summary() = {frames, calls, recorded, partial, dropped_frames, tail_raw?, broken?} for flows/.
 * onFailure({event, where:'ws', code, flow_id, reason, …}) = the engine's failure sink (flows/ event lines, D38).
 */
export function createWsRecorder({ flow, upgrade, seqStart = 0, genId, recordStore, isRecording = () => true, terminal = null, retention = null, maxCallBytes = MAX_CALL_BYTES, now = () => new Date(), onFailure = noFailureSink, onTurnEnd = () => {} }) {
  const ext = (upgrade.resp.head.headers || []).filter(([k]) => k.toLowerCase() === 'sec-websocket-extensions').map(([, v]) => v).join(', ')
  const { deflate } = parseExtensions(ext)
  const sampleRt = () => { // {class, level}; a callback that is absent or throws is `full` (keeping too much loses nothing)
    try { const r = retention && retention(upgrade.req.head.method, upgrade.req.head.target); if (r && r.class) return { class: r.class, level: r.level === 'log' ? 'log' : 'full' } } catch { /* full */ }
    return { class: endpointClass(upgrade.req.head.target) || 'other', level: 'full' }
  }
  const side = (noCtx, name) => ({ name, parser: createFrameParser({ maxPayload: maxCallBytes }), asm: createMessageAssembler(), inflater: deflate ? createInflater({ noContextTakeover: noCtx }) : null, msg: null, broken: null })
  const dirs = { c: side(!!deflate && deflate.clientNoContextTakeover, 'c'), s: side(!!deflate && deflate.serverNoContextTakeover, 's') }
  const stats = { frames: 0, calls: 0, recorded: 0, partial: 0, dropped_frames: 0 }
  const lost = new Set() // why later calls are partial (REASONS)
  let kept = []    // frames waiting for an envelope: {i, d, header, payload, msg, off}, in number order
  let open = null  // the call being collected
  let tail = []
  let idx = 0
  let seq = seqStart
  let ended = false
  let failures = 0
  const iso = () => now().toISOString()
  const isTerminal = compileTerminal(terminal, upgrade.req.head.target, (pattern, e) => fail('pattern-invalid', e, { pattern }))

  // A ws_raw entry: p = the payload; m = [k, offset] into message k of this envelope (stored bytes,
  // uncompressed); neither = the payload is not retained (non-LLM client message, past the cap).
  function entry(e, call) {
    const out = { i: e.i, d: e.d, h: e.header.toString('base64') }
    const h = e.msg
    if (h && (h.omit || (!h.call && call && call.capped))) return out // in flight at the end of a call past the cap
    if (h && h.call === call && h.slice) out.m = [h.k, e.off]
    else if (e.payload) out.p = e.payload.toString('base64')
    return out
  }

  // D38 (4.6 §记录): a capture failure is never silent. Each one goes at once, with its reason, to onFailure — a
  // flows/ event line {where:'ws', code, flow_id, reason}; summary().failures counts them for the connection row.
  function fail(code, error, extra) {
    failures++
    onFailure({ event: 'failure', where: 'ws', code, flow_id: flow.id, reason: String((error && error.message) || error), ...extra })
  }

  function newCall(h) {
    stats.calls++
    return { record: h.rec, rt: h.rt, wireC: 0, wireS: 0, client: [], server: [], tsStart: h.ts, tsRespStart: null, seq: seq++, bytes: 0, capped: false, truncated: false, blind: false }
  }

  // Write `call` (or drop it, begun off) with its messages' frames and the control frames below `cut`;
  // at the end of the connection (last) also the frames of messages still in flight.
  function close(call, cut, error, last = false) {
    const mine = (e) => (e.msg ? e.msg.call === call || (last && !e.msg.call) : e.i < cut)
    const take = kept.filter(mine)
    kept = kept.filter((e) => !mine(e))
    if (!call.record) { stats.dropped_frames += take.length; lost.add('off-window'); return } // the frames ride with it
    const partial = REASONS.filter((r) => lost.has(r))
    const env = buildWsEnvelope({
      id: genId(), flow, seq: call.seq, upgrade, error, wsRaw: take.map((e) => entry(e, call)),
      call: { client: call.client, server: call.server, tsStart: call.tsStart, tsRespStart: call.tsRespStart, tsEnd: iso(), partial, truncated: call.truncated || !!(dirs.c.broken || dirs.s.broken), // a stopped direction lost its bytes
        class: call.rt.class, level: call.rt.level, wire: { req: call.wireC, resp: call.wireS } },
    })
    let ok = false, why = null
    try { ok = recordStore.envelope(env) !== false } catch (e) { why = e }
    if (!ok) { lost.add('write-failed'); fail('write-failed', why || recordStore.lastError || 'the store did not write the envelope', { seq: call.seq, id: env.id }); return }
    stats.recorded++
    if (partial.length) stats.partial++
  }

  function join(call, h) {
    h.call = call
    if (h.d === 'c') call.wireC += h.wire; else call.wireS += h.wire // every payload byte of the call, kept or not
    // `log` (D40): the message is its wire byte count, its frames keep a header and no payload (entry() and the loop below)
    if (call.rt.level === 'log') { h.meta = true; h.omit = true; h.slice = false; h.value = { raw_chars: h.wire, verbatim: false } }
    const list = h.d === 'c' ? call.client : call.server
    h.k = list.length
    if (h.omit && !h.meta) call.truncated = true // the parser dropped part of it: past the cap on its own
    else if (!h.meta && (call.capped || call.bytes + h.wire > maxCallBytes)) {
      call.capped = call.truncated = true; h.omit = true; h.value = { omitted_bytes: h.wire }
    } else if (!h.meta) call.bytes += h.wire
    if (h.omit || h.slice) for (const e of h.frames) e.payload = null // not retained, or m-sliced from the message
    list.push(h.value)
    if (h.d === 's' && !call.tsRespStart) call.tsRespStart = h.ts
  }

  function undecodable(h, error) { lost.add('decode-failed'); fail('decode-failed', error, { d: h.d, i: h.first }); return error }

  function decode(D, ev, h) {
    if (ev.message === null) { // past the cap on its own: a takeover window is broken from here
      if (ev.compressed && D.inflater) D.inflater.skip()
      return { value: { omitted_bytes: ev.omitted_bytes }, omitted: true }
    }
    let bytes = ev.message
    if (ev.compressed) {
      if (!D.inflater) return { value: { b64: bytes.toString('base64'), decode_error: undecodable(h, 'RSV1 set but the 101 agreed no permessage-deflate') } }
      try { bytes = D.inflater.inflate(ev.message) } catch (err) {
        return { value: { b64: ev.message.toString('base64'), decode_error: undecodable(h, String((err && err.message) || err)) } }
      }
    }
    if (ev.opcode === OP.TEXT) { try { return { value: utf8.decode(bytes), bytes } } catch { /* not UTF-8: kept as bytes */ } }
    return { value: { b64: bytes.toString('base64') }, bytes }
  }

  // A complete data message joins a call (cut rules in the header comment).
  function complete(D, h, ev) {
    const { value, bytes, omitted } = decode(D, ev, h)
    if (omitted) h.omit = true
    h.value = value
    h.slice = !h.compressed && messageBytes(value) !== null
    if (h.d === 'c') {
      if (!open || !isTerminal || open.blind || dirs.s.broken) {
        if (open) close(open, h.first, null)
        open = newCall(h)
      }
      join(open, h)
    } else if (open && (h.rec || h.start === open)) {
      join(open, h)
      if (value.decode_error || omitted) open.blind = true // this one might have been its terminal message
      else if (isTerminal && bytes && isTerminal(bytes)) { const call = open; open = null; close(call, idx, null); turnEnded() }
    } else if (open) drop(h) // begun off outside the call now open: not part of it, not recorded (C14)
    else { const push = newCall(h); join(push, h); close(push, idx, null) }
  }

  function turnEnded() { try { onTurnEnd() } catch (e) { fail('recorder-error', e) } } // the gate's callback never throws into the forwarding path

  function drop(h) {
    const mine = new Set(h.frames)
    kept = kept.filter((e) => !mine.has(e))
    stats.dropped_frames += mine.size
    lost.add('off-window')
  }

  function onFrame(d, f) {
    const D = dirs[d]
    const i = idx++
    stats.frames++
    const ev = D.asm.push(f)
    let h = null
    if (ev.type === 'data') {
      if (ev.start) {
        const rec = isRecording()
        // kept while it may still be recorded: begun on, or begun inside a recorded call. `rt` = the level this message
        // would open a call at, sampled now (its first frame); a message that joins a call takes that call's level (join())
        D.msg = { d, first: i, ts: iso(), rec, rt: sampleRt(), start: open, keep: rec || !!(open && open.record), compressed: ev.compressed, wire: 0, meta: false, omit: false, frames: [] }
      }
      h = D.msg
      h.wire += f.payload ? f.payload.length : f.omitted
    }
    if (h ? h.keep : (open && open.record) || isRecording()) {
      const e = { i, d, header: f.header, payload: h && h.omit ? null : f.payload, msg: h, off: ev.offset || 0 }
      kept.push(e)
      if (h) h.frames.push(e)
    } else { stats.dropped_frames++; if (h) lost.add('off-window') }
    if (ev.type === 'error') broke(D, ev.error)
    else if (ev.type === 'data' && ev.done) { D.msg = null; complete(D, h, ev) }
  }

  // this direction is not followed any more: the wire data broke it (broken), or asight's own code threw while
  // following it (recorder-error, W-2) — the two are told apart so a bug in asight never reads as bad data
  function broke(D, why, code = 'broken') { D.broken = why; lost.add('decode-failed'); fail(code, why, { d: D.name }) }

  function feed(d, chunk) {
    const D = dirs[d]
    if (ended || D.broken) return
    try {
      const { frames, error } = D.parser.push(chunk)
      for (const f of frames) { onFrame(d, f); if (D.broken) break }
      if (error && !D.broken) broke(D, error)
    } catch (e) { broke(D, String((e && e.message) || e), 'recorder-error') }
  }

  function finish(error) {
    if (ended) return
    ended = true
    try {
      if (open) { const call = open; open = null; close(call, Infinity, error || (isTerminal && !call.blind && !dirs.s.broken ? CLOSED : null), true) }
      tail = kept.map((e) => entry(e, null))
      kept = []
    } catch (e) { fail('recorder-error', e) } // never into the relay, never silent
  }

  function state() {
    if (ended) return 'idle'
    if (!isTerminal || dirs.c.broken || dirs.s.broken || (open && open.blind)) return 'blind'
    return open || dirs.c.msg || dirs.s.msg ? 'open' : 'idle'
  }

  return {
    state,
    fromClient: (chunk) => feed('c', chunk),
    fromUpstream: (chunk) => feed('s', chunk),
    end: (error) => finish(error || null),
    summary: () => {
      const broken = Object.fromEntries(['c', 's'].filter((d) => dirs[d].broken).map((d) => [d, dirs[d].broken]))
      return { ...stats, ...(tail.length ? { tail_raw: tail } : {}), ...(Object.keys(broken).length ? { broken } : {}), ...(failures ? { failures } : {}) }
    },
  }
}
