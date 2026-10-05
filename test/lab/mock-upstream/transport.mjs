// transport.mjs — puts a reply { status, headers, pieces } on the socket, one piece (SSE event) per
// write, every byte through io.send so the byte log sees exactly what left the server.
import { STATUS_CODES } from 'node:http'

const REASON = { 529: 'Overloaded' } // not in node's table; Anthropic's overload status
const CRLF = Buffer.from('\r\n')

export const jsonReply = (status, obj, headers = {}) =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, pieces: [JSON.stringify(obj)] })

export function statusLine(status) { return `HTTP/1.1 ${status} ${REASON[status] || STATUS_CODES[status] || 'Unknown'}\r\n` }

// An RST discards whatever the kernel has not sent yet, so give the bytes already written a moment
// to reach the client first; otherwise "after two deltas" could arrive as "after nothing".
const resetSoon = async (io) => { if (await io.sleep(25)) io.reset(); return false }

const halves = (pieces) => { const b = Buffer.concat(pieces.map((p) => Buffer.from(p))); return [b.subarray(0, b.length >> 1), b.subarray(b.length >> 1)] }

// Returns true when the whole framed response went out; false means it was cut short.
// Faults act relative to the first content delta (res.firstDelta, set by stream replies): a stall
// comes after one delta, a cut after two. A JSON reply is split in half so a fault lands mid-body.
export async function writeResponse(io, res, { head = false, close = false, sc = {}, cfg = {} } = {}) {
  if (sc.slowHeaders && !(await io.sleep(cfg.stallMs))) return false
  let pieces = res.pieces, first = res.firstDelta ?? 0
  if (sc.fault && res.firstDelta == null) pieces = halves(pieces)
  if (sc.fault === 'error-event' && res.failEvent) pieces = [...pieces.slice(0, first + 2), res.failEvent(first + 2)]
  const h = { date: new Date().toUTCString(), server: 'asight-mock-upstream', ...res.headers }
  h['transfer-encoding'] = 'chunked'
  h.connection = close ? 'close' : 'keep-alive'
  io.status = res.status
  io.send(statusLine(res.status) + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
  if (sc.fault === 'headers-reset') return resetSoon(io)
  if (!head) {
    const cut = Math.min(first + 2, pieces.length - 1)
    for (const [i, p] of pieces.entries()) {
      if (i === cut && sc.fault === 'reset') return resetSoon(io)
      if (i === cut && sc.fault === 'fin') { io.end(); return false } // clean close, no terminating chunk
      if (i === first + 1 && sc.fault === 'stall' && !(await io.sleep(cfg.stallMs))) return false
      const b = Buffer.from(p)
      if (b.length) io.send(Buffer.concat([Buffer.from(b.length.toString(16) + '\r\n'), b, CRLF])) // 0 would end the body
    }
    io.send('0\r\n\r\n')
  }
  if (close) io.end()
  return !io.closed
}
