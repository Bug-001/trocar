// transport.mjs — puts a reply { status, headers, pieces } on the socket, one piece (SSE event) per
// write, every byte through io.send so the byte log sees exactly what left the server.
import { STATUS_CODES } from 'node:http'
import zlib from 'node:zlib'

const REASON = { 529: 'Overloaded' } // not in node's table; Anthropic's overload status
const CRLF = Buffer.from('\r\n')

export const jsonReply = (status, obj, headers = {}) =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, pieces: [JSON.stringify(obj)] })

export function statusLine(status) { return `HTTP/1.1 ${status} ${REASON[status] || STATUS_CODES[status] || 'Unknown'}\r\n` }

// An RST discards whatever the kernel has not sent yet, so give the bytes already written a moment
// to reach the client first; otherwise "after two deltas" could arrive as "after nothing".
const resetSoon = async (io) => { if (await io.sleep(25)) io.reset(); return false }

const halves = (pieces) => { const b = Buffer.concat(pieces); return [b.subarray(0, b.length >> 1), b.subarray(b.length >> 1)] }
const chunk = (b) => Buffer.concat([Buffer.from(b.length.toString(16) + '\r\n'), b, CRLF])
// cut right after the first multi-byte lead byte, so the two writes split a character
const splitMidChar = (b) => { const i = b.findIndex((x) => x >= 0xc0); return i < 0 ? [b] : [b.subarray(0, i + 1), b.subarray(i + 1)] }

// One compressor across the whole body, flushed after every piece, the way a compressing proxy
// streams SSE: each event is decodable on arrival, and the deflate state carries across events.
// gzip needs Z_SYNC_FLUSH for that: its default flush (Z_FULL_FLUSH) resets the dictionary.
async function compress(pieces, enc) {
  const z = enc === 'br' ? zlib.createBrotliCompress() : zlib.createGzip(), out = []
  const flush = (r) => (enc === 'br' ? z.flush(r) : z.flush(zlib.constants.Z_SYNC_FLUSH, r))
  for (const p of pieces) { z.write(p); await new Promise(flush); out.push(z.read() || Buffer.alloc(0)) }
  z.end()
  const tail = []
  for await (const c of z) tail.push(c)
  return [...out, Buffer.concat(tail)]
}

// Returns true when the whole framed response went out; false means it was cut short.
// Faults act relative to the first content delta (res.firstDelta, set by stream replies): a stall
// comes after one delta, a cut after two. A JSON reply is split in half so a fault lands mid-body.
export async function writeResponse(io, res, { head = false, close = false, sc = {}, cfg = {} } = {}) {
  if (sc.slowHeaders && !(await io.sleep(cfg.stallMs))) return false
  let pieces = res.pieces.map((p) => Buffer.from(p)), first = res.firstDelta ?? 0
  if (sc.fault && res.firstDelta == null) pieces = halves(pieces)
  if (sc.fault === 'error-event' && res.failEvent) pieces = [...pieces.slice(0, first + 2), Buffer.from(res.failEvent(first + 2))]
  const h = { date: new Date().toUTCString(), server: 'asight-mock-upstream', ...res.headers }
  if (sc.encoding && !head) { pieces = await compress(pieces, sc.encoding); h['content-encoding'] = sc.encoding }
  // chunked (default) | length: one content-length | close: no length at all, the FIN ends the body
  const framing = sc.framing || 'chunked'
  if (framing === 'chunked') h['transfer-encoding'] = 'chunked'
  if (framing === 'length') h['content-length'] = String(pieces.reduce((n, p) => n + p.length, 0))
  if (framing === 'close') close = true
  h.connection = close ? 'close' : 'keep-alive'
  if (sc.keepAlive) h['keep-alive'] = 'timeout=600, max=1000'
  io.status = res.status
  io.send(statusLine(res.status) + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
  if (sc.fault === 'headers-reset') return resetSoon(io)
  if (!head) {
    const cut = Math.min(first + 2, pieces.length - 1)
    for (const [i, p] of pieces.entries()) {
      if (i === cut && sc.fault === 'reset') return resetSoon(io)
      if (i === cut && sc.fault === 'fin') { io.end(); return false } // clean close, no terminating chunk
      if (i === first + 1 && sc.fault === 'stall' && !(await io.sleep(cfg.stallMs))) return false
      if (i > 0 && sc.drip && !(await io.sleep(cfg.dripMs))) return false
      if (!p.length) continue // an empty chunk would end the body
      const [a, b] = (sc.splitUtf8 ? splitMidChar : (x) => [x])(framing === 'chunked' ? chunk(p) : p)
      io.send(a)
      // the pause keeps TCP from coalescing the two halves back into one segment
      if (b) { if (!(await io.sleep(30))) return false; io.send(b) }
    }
    if (framing === 'chunked') io.send('0\r\n\r\n')
  }
  if (close) io.end()
  return !io.closed
}
