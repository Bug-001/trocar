// transport.mjs — puts a reply on the socket. A reply is { status, headers, pieces }: pieces are the
// body in the order and granularity it should be written (one SSE event each), and every byte goes
// through io.send so the byte log sees exactly what left the server.
import { STATUS_CODES } from 'node:http'

const REASON = { 529: 'Overloaded' } // not in node's table; Anthropic's overload status
const CRLF = Buffer.from('\r\n')

export const jsonReply = (status, obj, headers = {}) =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, pieces: [JSON.stringify(obj)] })

export function statusLine(status) { return `HTTP/1.1 ${status} ${REASON[status] || STATUS_CODES[status] || 'Unknown'}\r\n` }

// Returns true when the whole framed response went out; false means it was cut short.
export async function writeResponse(io, res, { head = false, close = false } = {}) {
  const h = { date: new Date().toUTCString(), server: 'asight-mock-upstream', ...res.headers }
  h['transfer-encoding'] = 'chunked'
  h.connection = close ? 'close' : 'keep-alive'
  io.status = res.status
  io.send(statusLine(res.status) + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
  if (!head) {
    for (const p of res.pieces) {
      const b = Buffer.from(p)
      if (b.length) io.send(Buffer.concat([Buffer.from(b.length.toString(16) + '\r\n'), b, CRLF])) // 0 would end the body
    }
    io.send('0\r\n\r\n')
  }
  if (close) io.end()
  return !io.closed
}
