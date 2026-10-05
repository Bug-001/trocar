// der.mjs — a minimal DER (Distinguished Encoding Rules) writer + TLV reader, just enough to
// build and walk X.509 v3 certificates with zero dependencies (RFC 4.6 §身份与信任: node:crypto
// self-signed, zero deps / D18). Everything here is pure byte assembly; crypto lives in cert.mjs.

// Length octets (DER definite form): < 0x80 → one byte; otherwise 0x80|n then n big-endian bytes.
function encodeLen(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256) }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** tlv(tag, ...parts) → a TLV: tag byte, DER length, then the concatenated parts as the value. */
export function tlv(tag, ...parts) {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), encodeLen(body.length), body])
}

export const seq = (...p) => tlv(0x30, ...p)       // SEQUENCE
export const set = (...p) => tlv(0x31, ...p)       // SET

function bigintToBytes(v) {
  if (v === 0n) return Buffer.from([0])
  const bytes = []
  let x = v
  while (x > 0n) { bytes.unshift(Number(x & 0xffn)); x >>= 8n }
  return Buffer.from(bytes)
}

/** INTEGER, minimal and non-negative. Accepts a bigint or a magnitude Buffer (e.g. a serial). */
export function int(v) {
  let mag
  if (typeof v === 'bigint') {
    mag = bigintToBytes(v)
  } else {
    mag = Buffer.from(v)
    let i = 0
    while (i < mag.length - 1 && mag[i] === 0) i++   // strip redundant leading zeros
    mag = mag.subarray(i)
    if (mag.length === 0) mag = Buffer.from([0])
  }
  if (mag[0] & 0x80) mag = Buffer.concat([Buffer.from([0]), mag])  // keep it positive
  return tlv(0x02, mag)
}

/** OBJECT IDENTIFIER from a dotted string: first byte 40*a+b, then base-128 with continuation bits. */
export function oid(dotted) {
  const parts = dotted.split('.').map(Number)
  const bytes = [40 * parts[0] + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]
    const stack = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
    bytes.push(...stack)
  }
  return tlv(0x06, Buffer.from(bytes))
}

export const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))       // UTF8String
export const printable = (s) => tlv(0x13, Buffer.from(s, 'ascii')) // PrintableString
export const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'))       // IA5String
export const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf])) // 0 unused bits
export const octet = (buf) => tlv(0x04, buf)                        // OCTET STRING
export const bool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0x00]))// BOOLEAN
export const explicit = (n, buf) => tlv(0xa0 | n, buf)             // [n] EXPLICIT

/** UTCTime (YYMMDDHHMMSSZ) before 2050, else GeneralizedTime (YYYYMMDDHHMMSSZ). */
export function time(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const Y = date.getUTCFullYear()
  const mm = pad(date.getUTCMonth() + 1), dd = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours()), mi = pad(date.getUTCMinutes()), ss = pad(date.getUTCSeconds())
  if (Y < 2050) return tlv(0x17, Buffer.from(`${pad(Y % 100)}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'))
  return tlv(0x18, Buffer.from(`${Y}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'))
}

/** Read one TLV at `offset`: {tag, headerLen, len, start (value offset), end}. Handles long length. */
export function readTlv(buf, offset = 0) {
  const tag = buf[offset]
  let i = offset + 1
  let len = buf[i++]
  let headerLen
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++]
    headerLen = 2 + n
  } else {
    headerLen = 2
  }
  const start = offset + headerLen
  return { tag, headerLen, len, start, end: start + len }
}
