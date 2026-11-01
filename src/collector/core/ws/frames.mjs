// frames.mjs — passive RFC 6455 framing for ONE direction of a WebSocket (RFC 4.6 §传输与帧级记录,
// D37). It reads the chunks the engine forwards (the tee sees each one just before it is written): it
// never re-frames and never changes a byte; payloads are unmasked into copies. A protocol violation
// stops this direction and is reported, never thrown: the peers fail the connection themselves.
import { MAX_BODY_BYTES } from '../../../capture/envelope.mjs'

export const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 }

/**
 * createFrameParser({maxPayload}) → { push(chunk) → {frames, error} }
 * Frame = { fin, rsv1, rsv2, rsv3, opcode, masked, header, payload, omitted? }
 *   header  = the frame's header bytes as on the wire (2–14 bytes, mask key included)
 *   payload = an unmasked copy of the payload; null with omitted = its length once the data frame would
 *             take its message past maxPayload (D37 W17): that frame and the rest of the message are
 *             reported at their header and their payload bytes are dropped unbuffered, so frame sync
 *             holds and later frames parse normally.
 * Chunks are kept as a list until a whole frame is there, so a large frame arriving in small TCP
 * chunks costs one copy, not one per chunk: this runs on the relay's event loop (§引擎 6).
 */
export function createFrameParser({ maxPayload = MAX_BODY_BYTES } = {}) {
  let parts = [], size = 0, need = 2 // pending chunks; bytes needed before the next frame can be cut
  let skip = 0, msg = 0               // payload bytes still to drop; declared bytes of the current message
  let error = null
  const fail = (msg) => { error = msg; parts = []; return null }
  function next() {
    if (parts.length > 1) parts = [Buffer.concat(parts, size)]
    const buf = parts[0]
    const b0 = buf[0], b1 = buf[1]
    let len = b1 & 0x7f, at = 2
    if (len === 126) { if (buf.length < 4) { need = 4; return null } len = buf.readUInt16BE(2); at = 4 }
    else if (len === 127) {
      if (buf.length < 10) { need = 10; return null }
      const n = buf.readBigUInt64BE(2)
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) return fail(`frame length ${n} is not representable`)
      len = Number(n); at = 10
    }
    const opcode = b0 & 0x0f
    if ((opcode > 2 && opcode < 8) || opcode > 10) return fail(`reserved opcode ${opcode}`)
    if (opcode >= 8 && (!(b0 & 0x80) || len > 125)) return fail('control frame is fragmented or longer than 125 bytes')
    const masked = (b1 & 0x80) !== 0
    const keyAt = at
    if (masked) at += 4
    const base = opcode === 0 ? msg : 0, omit = opcode < 8 && base + len > maxPayload
    if (buf.length < (omit ? at : at + len)) { need = omit ? at : at + len; return null }
    const header = Buffer.from(buf.subarray(0, at))
    let payload = null
    if (!omit) { payload = Buffer.from(buf.subarray(at, at + len)); if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[keyAt + (i & 3)] }
    if (opcode < 8) msg = b0 & 0x80 ? 0 : base + len
    const used = Math.min(buf.length, at + len)
    skip = at + len - used; size -= used; need = 2
    parts = size ? [buf.subarray(used)] : []
    return { fin: (b0 & 0x80) !== 0, rsv1: (b0 & 0x40) !== 0, rsv2: (b0 & 0x20) !== 0, rsv3: (b0 & 0x10) !== 0, opcode, masked, header, payload, ...(omit ? { omitted: len } : {}) }
  }
  return {
    push(chunk) {
      const frames = []
      if (!error) {
        if (skip) { const n = Math.min(skip, chunk.length); skip -= n; chunk = chunk.subarray(n) }
        if (chunk.length) { parts.push(chunk); size += chunk.length }
        for (let f; size >= need && (f = next());) frames.push(f)
      }
      return { frames, error }
    },
  }
}

/**
 * createMessageAssembler() → { push(frame) → event }
 *   {type:'control'}                              ping / pong / close: never joins a message
 *   {type:'data', start, done, opcode, compressed, offset, message?, omitted_bytes?}
 *       start: first frame of a message · offset: where this frame's payload sits in the message ·
 *       done: last frame, with message = the reassembled (still compressed) payload, or, when the parser
 *       omitted any frame of it, message = null and omitted_bytes = its declared size (→ ws_truncated)
 *   {type:'error', error}
 * Control frames between the fragments of a message pass through as 'control' (RFC 6455 §5.4).
 */
export function createMessageAssembler() {
  let cur = null
  return {
    push(f) {
      if (f.opcode >= 8) return { type: 'control' }
      let start = false
      if (f.opcode === OP.CONT) {
        if (!cur) return { type: 'error', error: 'continuation frame without a message' }
      } else {
        if (cur) return { type: 'error', error: 'new message inside a fragmented one' }
        cur = { opcode: f.opcode, compressed: !!f.rsv1, parts: [], size: 0 }
        start = true
      }
      const offset = cur.size
      if (f.payload) cur.parts.push(f.payload); else { cur.omitted = true; cur.parts = [] } // drop what came before
      cur.size += f.payload ? f.payload.length : f.omitted
      const ev = { type: 'data', start, done: f.fin, opcode: cur.opcode, compressed: cur.compressed, offset }
      if (f.fin) { Object.assign(ev, cur.omitted ? { message: null, omitted_bytes: cur.size } : { message: Buffer.concat(cur.parts) }); cur = null }
      return ev
    },
  }
}
