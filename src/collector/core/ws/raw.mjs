// raw.mjs — the `ws_raw` encoding (RFC 4.6 §传输与帧级记录, D37). Each entry is one frame as it
// crossed the wire: {i, d, h, p?|m?}. i = frame number on the connection (both directions share one
// counter), d = 'c' (client→server) | 's', h = the header bytes in base64, mask key included. The
// payload is either p (base64 of the unmasked payload: control frames, compressed frames, frames of a
// message this envelope does not carry) or m = [k, offset]: a byte slice of the k-th (0-based) stored
// message of that direction in this same envelope (an uncompressed data frame), so text is never
// stored twice. Neither p nor m = payload not retained (non-LLM request body, truncated call): the
// reader MUST label it non-verbatim (invariant 4); rebuildWsWire throws rather than invent bytes.

/** messageBytes(v) → Buffer for a stored message value: a string (UTF-8 text) or {b64}; else null
 *  ({omitted_bytes}, {raw_chars}, and {b64, decode_error}, whose b64 is still compressed). */
export function messageBytes(v) {
  if (typeof v === 'string') return Buffer.from(v, 'utf8')
  if (v && typeof v.b64 === 'string' && !v.decode_error) return Buffer.from(v.b64, 'base64')
  return null
}

/** The stored messages of one direction of a WebSocket envelope, in order (k of an m-slice indexes this). */
export function messagesOf(env, d) {
  if (d === 'c') {
    const first = env.req_body_b64 != null ? { b64: env.req_body_b64 } : env.req_body
    return [first, ...(env.req_extra_messages || [])]
  }
  const r = env.resp || {}
  return (r.kind === 'ws' ? r.messages : r.partial && r.partial.messages) || []
}

/** rebuildWsWire(env, dirs = 'cs') → { c: Buffer, s: Buffer }: the exact wire bytes of the frames in env.ws_raw.
 *  Pass dirs = 'c' or 's' to rebuild one direction when the other kept no payloads (non-LLM path). */
export function rebuildWsWire(env, dirs = 'cs') {
  const out = { c: [], s: [] }
  const msgs = { c: messagesOf(env, 'c'), s: messagesOf(env, 's') }
  for (const e of env.ws_raw) {
    if (!dirs.includes(e.d)) continue
    const h = Buffer.from(e.h, 'base64')
    let len = h[1] & 0x7f
    let at = 2
    if (len === 126) { len = h.readUInt16BE(2); at = 4 } else if (len === 127) { len = Number(h.readBigUInt64BE(2)); at = 10 }
    if (h.length !== at + (h[1] & 0x80 ? 4 : 0)) throw new Error(`frame ${e.i}: header is ${h.length} bytes, its length field needs ${at + (h[1] & 0x80 ? 4 : 0)}`)
    let p
    if (e.p != null) p = Buffer.from(e.p, 'base64')
    else if (e.m) {
      const bytes = messageBytes(msgs[e.d][e.m[0]])
      if (!bytes) throw new Error(`frame ${e.i}: message ${e.m[0]} not stored`)
      p = Buffer.from(bytes.subarray(e.m[1], e.m[1] + len))
    } else throw new Error(`frame ${e.i}: payload not retained`)
    if (p.length !== len) throw new Error(`frame ${e.i}: payload is ${p.length} bytes, header says ${len}`)
    if (h[1] & 0x80) for (let i = 0; i < p.length; i++) p[i] ^= h[at + (i & 3)]
    out[e.d].push(h, p)
  }
  return { c: Buffer.concat(out.c), s: Buffer.concat(out.s) }
}
