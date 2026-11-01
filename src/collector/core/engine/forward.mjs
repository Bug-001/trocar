// forward.mjs — the door's blind forwarder for absolute-form plain http (RFC 4.8 §5.1). A program that inherited an agent's proxy env (a child the
// agent started) sends `GET http://host/… HTTP/1.1` to the door; the door is a plain forward proxy for it: each request goes to its origin as
// received, less every `Proxy-Authorization` line (the door's own credential: it holds the token), and the answers come back raw. Nothing is
// recorded but one flows/ row per authority segment (`row`); no byte is decrypted, framed into an envelope or changed otherwise.
import { asksUpgrade } from '../http1/framer.mjs'

const LINE_MAX = 16 * 1024

/** An absolute-form `http://` request line → its {host, port} (port 80 by default, an IPv6 literal without brackets), else null. */
export function absTarget(startLine) {
  const m = /^[A-Z]{3,7} (\S+) HTTP\/1\.[01]$/.exec(startLine)
  if (!m || !/^http:\/\//i.test(m[1])) return null
  let u
  try { u = new URL(m[1]) } catch { return null }
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1')
  return /^[\x21-\x7e]+$/.test(host) ? { host, port: u.port ? Number(u.port) : 80 } : null
}

// every Proxy-Authorization line of a raw head removed, the other bytes as they came
const stripAuth = (raw) => Buffer.from(raw.toString('latin1').split('\r\n').filter((l) => !/^proxy-authorization:/i.test(l)).join('\r\n'), 'latin1')
const header = (h, name) => { const x = h.find(([k]) => k.toLowerCase() === name); return x ? x[1] : null }
const some = (left) => (b) => (b.length ? { length: Math.min(left, b.length) } : null)
const line = (b) => { const i = b.indexOf('\r\n'); return i >= 0 ? { length: i + 2 } : b.length > LINE_MAX ? { invalid: 'a chunk line longer than 16 KiB' } : null }

// the request body, raw, piece by piece: Content-Length, or chunked (size line, data and CRLF, trailers up to an empty line). → null | {gone} | {invalid}
async function body(headers, r, put) {
  const copy = async (n) => { for (let left = n; left > 0;) { const p = await r.take(some(left)); if (!p.raw) return p; put(p.raw); left -= p.raw.length } return null }
  if (/chunked\s*$/i.test(header(headers, 'transfer-encoding') || '')) {
    for (;;) {
      const s = await r.take(line); if (!s.raw) return s
      put(s.raw)
      const size = parseInt(s.raw.toString('latin1'), 16)
      if (!(size >= 0)) return { invalid: 'a chunk size that is not hex' }
      if (size > 0) { const c = await copy(size + 2); if (c) return c; continue }
      for (;;) { const t = await r.take(line); if (!t.raw) return t; put(t.raw); if (t.raw.length === 2) return null }
    }
  }
  const n = Number(header(headers, 'content-length') || 0)
  return Number.isSafeInteger(n) && n >= 0 ? copy(n) : { invalid: 'a Content-Length that is not a number' }
}

/**
 * forwardHttp({ socket, r, head, next, open, shut }): serve the client's requests one at a time from `head` (the first, already read).
 *   next()          → the next head ({head, raw} | {gone} | {invalid}), no deadline (an idle connection is cut by engine.close())
 *   open(target)    → { sock, row } through the door's lookup and upstream rules, or null (the door has answered and ended); row({bytes_up,
 *                     bytes_down, duration_ms}) writes the segment's flows/ row
 *   shut(why, raw)  → closes the connection with its ingress-unknown record (a later head that is not absolute-form http)
 */
export async function forwardHttp({ socket, r, head, next, open, shut }) {
  let seg = null
  const end = () => {
    if (!seg) return
    const s = seg; seg = null; s.done = true; s.sock.destroy()
    s.row({ bytes_up: s.up, bytes_down: s.down, duration_ms: Date.now() - s.t0 })
  }
  socket.once('close', end)
  const put = (b) => { if (seg) { seg.up += b.length; seg.sock.write(b) } }
  for (let m = head; ;) {
    const t = absTarget(m.head.startLine)
    if (!t) return shut(`a plain HTTP request that is not an http:// absolute-form request (${m.head.startLine.split(' ')[0]}) after forwarded ones`, m.raw)
    const key = `${t.host}:${t.port}`
    if (!seg || seg.key !== key) {
      end() // the client read the previous answer before it sent this request
      const x = await open(t)
      if (!x) return
      if (socket.destroyed) { x.sock.destroy(); return x.row({ bytes_up: 0, bytes_down: 0, duration_ms: 0 }) }
      const s = seg = { sock: x.sock, row: x.row, key, up: 0, down: 0, t0: Date.now(), done: false }
      x.sock.on('data', (d) => { if (!s.done) { s.down += d.length; socket.write(d) } })
      x.sock.on('end', () => { if (!s.done) socket.end() })
      x.sock.on('error', () => { if (!s.done) socket.destroy() })
    }
    put(stripAuth(m.raw))
    if (asksUpgrade(m.head.headers)) { // the rest of the connection is raw bytes both ways
      const rest = r.detach(); if (rest.length) put(rest)
      socket.on('data', put); socket.on('end', () => { if (seg) seg.sock.end() })
      return
    }
    const b = await body(m.head.headers, r, put)
    m = b || await next()
    if (m.gone) { if (m.gone === 'end' && seg) seg.sock.end(); return void r.detach() } // a half-close goes on to the origin; the row comes at close
    if (m.invalid) return shut(m.invalid, Buffer.alloc(0))
  }
}
