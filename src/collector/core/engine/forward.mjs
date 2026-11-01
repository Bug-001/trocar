// forward.mjs — the door's absolute-form plain http (RFC 4.8 §5.1). A proxy client sends `GET http://host/… HTTP/1.1` to the door: an agent through
// its own http:// proxy setting, or a program that inherited an agent's proxy env. Each authority's run of requests on the connection is one flow,
// handled as a CONNECT's bytes are (handleFlow: framed and recorded when the process is captured, relayed otherwise; its row, off's drain and
// backpressure are the flow's). This file only frames the client's requests: it gives each flow a stand-in for the client socket that carries that
// authority's requests less every `Proxy-Authorization` line (the door's own credential, RFC 9110 §11.7.1: never sent on, never recorded), and when
// the client names another authority it lets the flow go and starts the next one.
import { Duplex } from 'node:stream'
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

// One flow's stand-in for the client socket: it reads what put() gives it and writes, ends and closes the client — until retire(), after which
// nothing it is told reaches the client. Its bytesRead / bytesWritten are that flow's own (the requests as forwarded, the answers as sent back).
// Both directions hold back: a full stand-in pauses the client, a client that cannot take more holds the flow's writes.
function standIn(socket) {
  let retired = false, ended = false, read = 0, written = 0
  const sock = new Duplex({
    read() { if (!retired) socket.resume() },
    write(c, _e, cb) { if (retired || socket.destroyed) return cb(); written += c.length; if (socket.write(c)) cb(); else socket.once('drain', () => cb()) },
    final(cb) { if (!retired) socket.end(); cb() },
    destroy(e, cb) { if (!retired) socket.destroy(); cb(e) },
  })
  Object.defineProperties(sock, { bytesRead: { get: () => read }, bytesWritten: { get: () => written } })
  return {
    sock,
    put(b) { if (ended || sock.destroyed) return; read += b.length; if (!sock.push(b)) socket.pause() },
    end() { if (!ended && !sock.destroyed) { ended = true; sock.push(null) } },
    retire() { retired = true; sock.destroy() },
    /** the flow closed the client itself (off's drain, the origin's close) */
    closedByFlow: () => !retired && (sock.destroyed || sock.writableEnded),
  }
}

/**
 * forwardHttp({ socket, r, head, next, start, shut }): the client's requests one at a time from `head` (the first, already read).
 *   next()               → the next head ({head, raw} | {gone} | {invalid}); no deadline: an idle connection is the flow's (off's drain closes it)
 *   start(target, sock)  → true once a flow for `target` took `sock` (the door's lookup, upstream rules and handleFlow), false if the door
 *                          answered and ended instead
 *   shut(why, raw)       → closes the connection with its ingress-unknown record (a later head that is not absolute-form http)
 */
export async function forwardHttp({ socket, r, head, next, start, shut }) {
  let cur = null, key = null
  socket.on('close', () => { if (cur) cur.sock.destroy() })
  socket.on('error', (e) => { if (cur) cur.sock.destroy(e) })
  const put = (b) => cur.put(b)
  for (let m = head; ;) {
    if (cur && cur.closedByFlow()) { r.detach(); return void socket.destroy() } // nothing more goes on after the flow closed the client
    const t = absTarget(m.head.startLine)
    if (!t) { if (cur) cur.retire(); return shut(`a plain HTTP request that is not an http:// absolute-form request (${m.head.startLine.split(' ')[0]}) after forwarded ones`, m.raw) }
    const k = `${t.host}:${t.port}`
    if (!cur || key !== k) {
      if (cur) { cur.retire(); cur = null } // the client read the previous answer before it sent this request
      const s = standIn(socket)
      if (!(await start(t, s.sock))) return
      cur = s; key = k
    }
    cur.put(stripAuth(m.raw))
    if (asksUpgrade(m.head.headers)) { // the rest of the connection is raw bytes both ways
      const c = cur, rest = r.detach()
      if (rest.length) c.put(rest)
      socket.on('data', (d) => c.put(d)); socket.on('end', () => c.end())
      return
    }
    const b = await body(m.head.headers, r, put)
    m = b || await next()
    if (m.gone) { r.detach(); if (m.gone === 'end') cur.end(); return } // a half-close goes on to the flow
    if (m.invalid) { cur.retire(); return shut(m.invalid, Buffer.alloc(0)) }
  }
}
