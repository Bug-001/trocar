// http1.mjs — the mock upstream's own HTTP/1.1 request framing.
//
// Why not node:http: the byte log must hold, per request, exactly the bytes the client wrote, and on
// a keep-alive connection node:http neither says where one request ends and the next begins nor lets
// a reply stop mid-chunk, split a character across writes, or end in a TCP RST. Owning the socket
// gives both: reads are sliced at request boundaries here, and every write goes through one send().

// Parse one request off the front of buf. null = need more bytes. `size` is how many bytes the request
// occupies on the wire (head + framed body, chunk framing included), so buf.subarray(0, size) is its
// raw form and the rest belongs to the next request.
export function parseRequest(buf) {
  const headEnd = buf.indexOf('\r\n\r\n')
  if (headEnd < 0) return null
  const [line, ...fields] = buf.subarray(0, headEnd).toString('latin1').split('\r\n')
  const [method, target] = line.split(' ')
  const headers = {}
  for (const f of fields) {
    const i = f.indexOf(':')
    if (i <= 0) continue
    const k = f.slice(0, i).trim().toLowerCase(), v = f.slice(i + 1).trim()
    headers[k] = k in headers ? `${headers[k]}, ${v}` : v
  }
  const pos = headEnd + 4
  if (/chunked/i.test(headers['transfer-encoding'] || '')) return parseChunked(buf, pos, { method, target, headers })
  const len = Number(headers['content-length'] || 0)
  if (buf.length < pos + len) return null
  return { method, target, headers, body: buf.subarray(pos, pos + len), size: pos + len }
}

function parseChunked(buf, pos, req) {
  const parts = []
  for (;;) {
    const eol = buf.indexOf('\r\n', pos)
    if (eol < 0) return null
    const n = parseInt(buf.subarray(pos, eol).toString('latin1'), 16) // parseInt stops at a ";ext"
    if (Number.isNaN(n)) throw new Error('mock-upstream: bad chunk size line')
    if (n === 0) {
      // from eol: CRLF, optional trailer lines, CRLF — so the first blank line ends the request.
      const end = buf.indexOf('\r\n\r\n', eol)
      return end < 0 ? null : { ...req, body: Buffer.concat(parts), size: end + 4 }
    }
    if (buf.length < eol + 2 + n + 2) return null
    if (buf.readUInt16BE(eol + 2 + n) !== 0x0d0a) throw new Error('mock-upstream: chunk data not followed by CRLF')
    parts.push(buf.subarray(eol + 2, eol + 2 + n))
    pos = eol + 2 + n + 2
  }
}
