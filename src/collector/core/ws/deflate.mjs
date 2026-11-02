// deflate.mjs — permessage-deflate (RFC 7692) for the recorder's side copy (RFC 4.6 §传输与帧级记录).
// Parameters come from the UPSTREAM 101's Sec-WebSocket-Extensions — what the server agreed to —
// never from the client's offer (the caller passes the 101's header). Each direction keeps its LZ77
// context from its first frame: the last 32 KiB of inflated output is the next message's dictionary,
// which is exactly the window a persistent inflateRaw stream holds (zero dependencies, D32③). Doing it
// per message also survives a sender that ends a message with a final block, which would wedge one
// long-lived stream. A receiver's 32 KiB window covers any smaller *_max_window_bits the peer agreed.
// A message that fails to inflate clears the window: a later reference into it then fails too, instead
// of silently decoding against stale history (invariants 2 / 4).
import zlib from 'node:zlib'
import { MAX_BODY_BYTES } from '../../../capture/request-body.mjs'

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]) // RFC 7692 §7.2.2: re-append the stripped sync-flush tail
const WINDOW = 32768

/** parseExtensions(header) → { deflate: null | {serverNoContextTakeover, clientNoContextTakeover, serverMaxWindowBits, clientMaxWindowBits}, other: string[] } */
export function parseExtensions(header) {
  let deflate = null
  const other = []
  for (const item of String(header || '').split(',')) {
    const [name, ...params] = item.split(';').map((s) => s.trim())
    if (!name) continue
    if (name.toLowerCase() !== 'permessage-deflate' || deflate) { other.push(name); continue }
    const p = {}
    for (const kv of params) {
      const eq = kv.indexOf('=')
      const k = (eq < 0 ? kv : kv.slice(0, eq)).trim().toLowerCase()
      p[k] = eq < 0 ? true : kv.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
    }
    const bits = (v) => (v && v !== true ? Number(v) : 15)
    deflate = {
      serverNoContextTakeover: !!p.server_no_context_takeover,
      clientNoContextTakeover: !!p.client_no_context_takeover,
      serverMaxWindowBits: bits(p.server_max_window_bits),
      clientMaxWindowBits: bits(p.client_max_window_bits),
    }
  }
  return { deflate, other }
}

/** createInflater({noContextTakeover, maxOutput}) → { inflate(payload) → Buffer, skip() } (inflate throws on corrupt data or past maxOutput). */
export function createInflater({ noContextTakeover = false, maxOutput = MAX_BODY_BYTES } = {}) {
  let dict = Buffer.alloc(0)
  return {
    inflate(payload) {
      let out
      try {
        out = zlib.inflateRawSync(Buffer.concat([payload, TAIL]), {
          finishFlush: zlib.constants.Z_SYNC_FLUSH, windowBits: 15, maxOutputLength: maxOutput,
          ...(dict.length ? { dictionary: dict } : {}),
        })
      } catch (e) { dict = Buffer.alloc(0); throw e }
      if (!noContextTakeover) {
        const all = dict.length ? Buffer.concat([dict, out]) : out
        dict = Buffer.from(all.subarray(Math.max(0, all.length - WINDOW)))
      }
      return out
    },
    // A compressed message whose payload was omitted (over the cap): with takeover the window is lost,
    // so it is cleared like a failure; a later reference into it then fails. Without takeover: no effect.
    skip() { dict = Buffer.alloc(0) },
  }
}
