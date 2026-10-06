// sniff.mjs — look at the first bytes of a flow and decide what it is (RFC 4.6 §引擎 2), plus the
// two parsers the router needs: a ClientHello reader (SNI/ALPN, reassembling across TLS records and
// TCP segments) and a shared HTTP head reader (CONNECT line + plain HTTP). All passive: it only
// reads, never rewrites bytes.

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']
const TOKENS = ['CONNECT ', ...METHODS.map((m) => m + ' ')]

/** 'need-more' | 'tls' | 'connect' | 'socks' | 'http' | 'unknown' */
export function classify(buf) {
  if (buf.length === 0) return 'need-more'
  if (buf.length >= 2 && buf[0] === 0x16 && buf[1] === 0x03) return 'tls' // TLS handshake record
  if (buf[0] === 0x04 || buf[0] === 0x05) return 'socks'                  // SOCKS4/4a or SOCKS5 prelude (D37)
  const s = buf.toString('latin1')
  if (s.startsWith('CONNECT ')) return 'connect'
  for (const m of METHODS) if (s.startsWith(m + ' ')) return 'http'
  if (buf.length < 8) {
    if (buf[0] === 0x16) return 'need-more'                 // maybe TLS, waiting on the version byte
    for (const c of TOKENS) if (c.startsWith(s)) return 'need-more' // a partial request/CONNECT line
  }
  return 'unknown'
}

// Concatenate the payloads of complete handshake (type 22) TLS records; stop at the first
// non-handshake record or an incomplete one.
function collectHandshake(buf) {
  let off = 0
  const parts = []
  while (off + 5 <= buf.length) {
    const type = buf[off]
    const len = (buf[off + 3] << 8) | buf[off + 4]
    if (type !== 22) return Buffer.concat(parts)
    if (off + 5 + len > buf.length) return Buffer.concat(parts) // body not fully arrived yet
    parts.push(buf.subarray(off + 5, off + 5 + len))
    off += 5 + len
  }
  return Buffer.concat(parts)
}

function parseHelloBody(body) {
  let p = 0
  const need = (n) => { if (p + n > body.length) throw new Error('overrun') }
  need(2); p += 2                                   // legacy_version
  need(32); p += 32                                 // random
  need(1); const sidLen = body[p]; p += 1; need(sidLen); p += sidLen                   // session_id
  need(2); const csLen = (body[p] << 8) | body[p + 1]; p += 2; need(csLen); p += csLen // cipher_suites
  need(1); const compLen = body[p]; p += 1; need(compLen); p += compLen                // compression_methods
  let sni = null, alpn = null
  if (p === body.length) return { sni, alpn }        // no extensions block
  need(2); const extTotal = (body[p] << 8) | body[p + 1]; p += 2
  const extEnd = p + extTotal
  if (extEnd > body.length) throw new Error('overrun')
  while (p < extEnd) {
    if (p + 4 > extEnd) throw new Error('overrun')
    const extType = (body[p] << 8) | body[p + 1]; p += 2
    const extLen = (body[p] << 8) | body[p + 1]; p += 2
    if (p + extLen > extEnd) throw new Error('overrun')
    const ext = body.subarray(p, p + extLen)
    if (extType === 0) sni = parseSni(ext)
    else if (extType === 16) alpn = parseAlpn(ext)
    p += extLen
  }
  return { sni, alpn }
}

function parseSni(ext) {
  if (ext.length < 2) return null                    // server_name_list length prefix
  let q = 2
  while (q + 3 <= ext.length) {
    const nameType = ext[q]; q += 1
    const nameLen = (ext[q] << 8) | ext[q + 1]; q += 2
    if (q + nameLen > ext.length) break
    const nm = ext.subarray(q, q + nameLen); q += nameLen
    if (nameType === 0) return nm.toString('ascii')  // host_name
  }
  return null
}

function parseAlpn(ext) {
  if (ext.length < 2) return null
  const listLen = (ext[0] << 8) | ext[1]
  const end = Math.min(ext.length, 2 + listLen)
  let q = 2
  const out = []
  while (q < end) {
    const l = ext[q]; q += 1
    if (q + l > end) break
    out.push(ext.subarray(q, q + l).toString('ascii')); q += l
  }
  return out.length ? out : null
}

/**
 * {complete:false} until the whole ClientHello has arrived, then
 * {complete:true, sni, alpn} or {complete:true, malformed:true}.
 */
export function parseClientHello(buf) {
  if (buf.length < 5) return { complete: false }
  const hs = collectHandshake(buf)
  if (hs.length < 4) return { complete: false }
  if (hs[0] !== 1) return { complete: true, malformed: true } // handshake type must be ClientHello
  const hsLen = (hs[1] << 16) | (hs[2] << 8) | hs[3]
  if (hs.length < 4 + hsLen) return { complete: false }
  try {
    return { complete: true, ...parseHelloBody(hs.subarray(4, 4 + hsLen)) }
  } catch {
    return { complete: true, malformed: true }
  }
}

/** null until the head terminator; then {headLength, startLine, headers:[[name,value]]} (name case kept). */
export function parseHead(buf) {
  const s = buf.toString('latin1')
  const idx = s.indexOf('\r\n\r\n')
  if (idx === -1) return null
  const lines = s.slice(0, idx).split('\r\n')
  const headers = []
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':')
    if (colon === -1) continue
    headers.push([lines[i].slice(0, colon), lines[i].slice(colon + 1).trim()])
  }
  return { headLength: idx + 4, startLine: lines[0], headers }
}
