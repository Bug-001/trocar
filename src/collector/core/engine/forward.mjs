// forward.mjs — the door's absolute-form plain http (RFC 4.8 §5.1). A proxy client sends `GET http://host/… HTTP/1.1` to the door: an agent through
// its own http:// proxy setting, or a program that inherited an agent's proxy env. Each authority's run of requests on the connection is one flow,
// handled as a CONNECT's bytes are (handleFlow: framed and recorded when the process is captured, relayed otherwise; its row, off's drain and
// backpressure are the flow's). This file only frames the client's requests: it gives each flow a stand-in for the client socket that carries that
// authority's requests less the door's own lines (every `Proxy-Authorization`: the door's credential, RFC 9110 §11.7.1; every `X-Trocar-Upstream`:
// the hook's hint to the door), tallied for the row's `trocar_removed` (4.6 §记录). It reads the answers the flow sends back only to count them:
// when the client names another authority, the flow goes once every request it was given has its final answer (a pipelining client, RFC 9112 §9.3).
import { Duplex } from 'node:stream'
import { asksUpgrade, createFramer } from '../http1/framer.mjs'
import { HOOK_HEADER } from '../proxymode/chain.mjs'

const LINE_MAX = 16 * 1024
const DOOR_LINES = ['proxy-authorization', HOOK_HEADER] // the lines of a request head that are the door's, not the origin's

/** An absolute-form `http://` request line → its {host, port} (port 80 by default, an IPv6 literal without brackets), else null. */
export function absTarget(startLine) {
  const m = /^[A-Z]{3,7} (\S+) HTTP\/1\.[01]$/.exec(startLine)
  if (!m || !/^http:\/\//i.test(m[1])) return null
  let u
  try { u = new URL(m[1]) } catch { return null }
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1')
  return /^[\x21-\x7e]+$/.test(host) ? { host, port: u.port ? Number(u.port) : 80 } : null
}

// a raw head less the door's lines, the other bytes as they came; each line removed is tallied in `removed` ([{header, lines, bytes}], CRLF included)
function strip(raw, removed) {
  const keep = []
  for (const l of raw.toString('latin1').split('\r\n')) {
    const name = l.slice(0, Math.max(0, l.indexOf(':'))).toLowerCase()
    if (!DOOR_LINES.includes(name)) { keep.push(l); continue }
    let x = removed.find((e) => e.header === name)
    if (!x) removed.push(x = { header: name, lines: 0, bytes: 0 })
    x.lines++; x.bytes += l.length + 2
  }
  return Buffer.from(keep.join('\r\n'), 'latin1')
}
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

// One flow's stand-in for the client socket: it reads what head() / put() give it and writes, ends and closes the client — until retire(), after
// which nothing it is told reaches the client. Its bytesRead / bytesWritten are that flow's own (the requests as forwarded, the answers as sent
// back). Both directions hold back: a full stand-in pauses the client, a client that cannot take more holds the flow's writes; `resume` lets the
// client's bytes flow again when the flow wants more. A copy of the answers goes through a response framer that counts the final ones (settled()).
// `marks`: null, or the offsets in what it carries where each request line ends (set by whoever must add a line there, 4.8 §5.2).
function standIn(socket, resume) {
  let retired = false, ended = false, read = 0, written = 0
  let asked = 0, answered = 0, switched = false, unframed = false, wake = null
  const removed = []
  const gone = () => sock.destroyed || sock.writableEnded
  const poke = () => { if (wake && (switched || unframed || answered >= asked || gone())) { const w = wake; wake = null; w() } }
  const answers = createFramer('response', {
    onHead() {}, onBody() {},
    onEnd: (e) => { if (!e.interim) answered++; poke() },
    onUpgrade: () => { switched = true; poke() },
    onError: () => { unframed = true; poke() },
  })
  const sock = new Duplex({
    read() { if (!retired) resume() },
    write(c, _e, cb) { if (retired || socket.destroyed) return cb(); written += c.length; answers.push(c); if (socket.write(c)) cb(); else socket.once('drain', () => cb()) },
    final(cb) { if (!retired) { answers.end(); socket.end() } cb(); poke() },
    destroy(e, cb) { if (!retired) socket.destroy(); cb(e); poke() },
  })
  Object.defineProperties(sock, { bytesRead: { get: () => read }, bytesWritten: { get: () => written } })
  const put = (b) => { if (ended || sock.destroyed) return; read += b.length; if (!sock.push(b)) socket.pause() }
  const side = {
    sock, removed, marks: null,
    /** one request head, less the door's lines; its answer is waited for */
    head(raw, method) {
      const b = strip(raw, removed)
      asked++; answers.expect({ method })
      if (side.marks) side.marks.push(read + b.indexOf('\r\n') + 2)
      put(b)
    },
    put,
    end() { if (!ended && !sock.destroyed) { ended = true; sock.push(null) } },
    retire() { retired = true; sock.destroy() },
    /** the flow closed the client itself (off's drain, the origin's close) */
    closedByFlow: () => !retired && gone(),
    /** → once every request given has its final answer, or an answer was 101, or the answers cannot be framed, or the flow closed the client */
    settled: () => new Promise((res) => { wake = res; poke() }),
    switched: () => switched,
  }
  return side
}

/**
 * The upstream of a forwarded flow through the user's http proxy when that proxy takes credentials (4.8 §5.2): what the flow writes goes to the
 * proxy as it is (absolute-form requests), with `credential` (a `Proxy-Authorization` line) after each request line; `marks` = where each request
 * line ends in what the flow writes, in order (the stand-in's). The line is in the bytes sent to the proxy only: never in the flow's, never recorded.
 */
export function withCredential(up, credential, marks) {
  let at = 0
  const d = new Duplex({
    read() { up.resume() },
    write(c, _e, cb) {
      const parts = []
      let from = 0
      while (marks.length && marks[0] <= at + c.length) { const cut = marks.shift() - at; parts.push(c.subarray(from, cut), credential); from = cut }
      parts.push(c.subarray(from)); at += c.length
      if (up.write(Buffer.concat(parts))) cb(); else up.once('drain', () => cb())
    },
    final(cb) { up.end(); cb() },
    destroy(e, cb) { up.destroy(); cb(e) },
  })
  up.on('data', (b) => { if (!d.push(b)) up.pause() })
  up.on('end', () => d.push(null))
  up.on('error', (e) => d.destroy(e))
  up.on('close', () => d.destroy())
  return d
}

/**
 * forwardHttp({ socket, r, head, next, start, shut }): the client's requests one at a time from `head` (the first, already read).
 *   next()                  → the next head ({head, raw} | {gone} | {invalid}); no deadline: an idle connection is the flow's (off's drain closes it)
 *   start(target, side, m)  → true once a flow for `target` took the stand-in `side` (the door's lookup with the head `m`, upstream rules and
 *                             handleFlow), false if the door answered and ended instead
 *   shut(why, raw)          → closes the connection with its ingress-unknown record (a later head that is not absolute-form http)
 * The reader `r` holds what is not yet read with backpressure (holdBack): while a flow is looked up and dialled, or waits for its answers, the
 * client is paused once 256 KiB wait, not cut.
 */
export async function forwardHttp({ socket, r, head, next, start, shut }) {
  let cur = null, key = null
  socket.on('close', () => { if (cur) cur.sock.destroy() })
  socket.on('error', (e) => { if (cur) cur.sock.destroy(e) })
  const put = (b) => cur.put(b)
  const over = () => { r.detach(); socket.destroy() } // nothing more goes on after the flow closed the client: unanswered requests are retried (RFC 9112 §9.3.2)
  for (let m = head; ;) {
    if (cur && cur.closedByFlow()) return over()
    const t = absTarget(m.head.startLine)
    if (!t) { if (cur) cur.retire(); return shut(`a plain HTTP request that is not an http:// absolute-form request (${m.head.startLine.split(' ')[0]}) after forwarded ones`, m.raw) }
    const k = `${t.host}:${t.port}`
    if (!cur || key !== k) {
      if (cur) { // the previous flow's answers reach the client first; then it goes
        await cur.settled()
        if (cur.closedByFlow()) return over()
        cur.retire(); cur = null
      }
      const s = standIn(socket, () => r.resume())
      if (!(await start(t, s, m))) return
      cur = s; key = k
    }
    cur.head(m.raw, m.head.startLine.split(' ')[0])
    const b = await body(m.head.headers, r, put)
    if (!b && asksUpgrade(m.head.headers)) { // its answer decides: after a 101 the rest of the connection is raw bytes both ways, after any other the next request
      await cur.settled()
      if (cur.closedByFlow()) return over()
      if (cur.switched()) {
        const c = cur, rest = r.detach()
        if (rest.length) c.put(rest)
        socket.on('data', (d) => c.put(d)); socket.on('end', () => c.end())
        return
      }
    }
    m = b || await next()
    if (m.gone) { r.detach(); if (m.gone === 'end') cur.end(); return } // a half-close goes on to the flow
    if (m.invalid) { cur.retire(); return shut(m.invalid, Buffer.alloc(0)) }
  }
}
