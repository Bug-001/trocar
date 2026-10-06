// socks.mjs — SOCKS4 / 4a / 5 proxy preludes (RFC 1928, RFC 1929, SOCKS4/4a; RFC 4.6 §引擎 3 + §记录
// 代理前导, D37). The engine relays every prelude byte verbatim in both directions and only reads copies:
// it never answers for the proxy, so a refusal reaches the client exactly as the proxy sent it (MUST NOT
// synthesize success). Each parser takes the bytes buffered so far and returns null (need more),
// {invalid} (not this protocol: the caller splices the rest verbatim) or the message with its length.

const MAX = 1024 // no legitimate prelude message is longer; past this it is not SOCKS

function cstr(buf, at) { // NUL-terminated string starting at `at` → {s, end} | null | {invalid}
  const nul = buf.indexOf(0, at)
  if (nul < 0) return buf.length - at > 255 ? { invalid: 'unterminated string' } : null
  return { s: buf.subarray(at, nul).toString('latin1'), end: nul + 1 }
}

function addr(buf, at) { // SOCKS5 ATYP + address + port → {host, port, end} | null | {invalid}
  if (buf.length < at + 1) return null
  const atyp = buf[at]
  let host, end
  if (atyp === 1) { if (buf.length < at + 7) return null; host = [...buf.subarray(at + 1, at + 5)].join('.'); end = at + 5 }
  else if (atyp === 3) { if (buf.length < at + 2) return null; const n = buf[at + 1]; if (buf.length < at + 2 + n + 2) return null; host = buf.subarray(at + 2, at + 2 + n).toString('latin1'); end = at + 2 + n }
  else if (atyp === 4) { if (buf.length < at + 19) return null; host = `[${Array.from({ length: 8 }, (_, i) => buf.readUInt16BE(at + 1 + 2 * i).toString(16)).join(':')}]`; end = at + 17 }
  else return { invalid: `bad ATYP ${atyp}` }
  return { host, port: buf.readUInt16BE(end), end: end + 2 }
}

/** SOCKS4/4a request: VN=4 CD DSTPORT DSTIP USERID\0 [DOMAIN\0 when DSTIP = 0.0.0.x, x ≠ 0]. */
export function socks4Request(buf) {
  if (buf.length < 9) return null
  if (buf[0] !== 4) return { invalid: 'not SOCKS4' }
  const user = cstr(buf, 8); if (!user || user.invalid) return user
  const port = buf.readUInt16BE(2)
  const ip = buf.subarray(4, 8)
  if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0) {
    const dom = cstr(buf, user.end); if (!dom || dom.invalid) return dom
    return { kind: 'socks4a', length: dom.end, cmd: buf[1], host: dom.s, port }
  }
  return { kind: 'socks4', length: user.end, cmd: buf[1], host: [...ip].join('.'), port }
}
/** SOCKS4 reply: VN=0 CD(90 granted) DSTPORT DSTIP — 8 bytes. */
export function socks4Reply(buf) {
  if (buf.length < 8) return null
  if (buf[0] !== 0) return { invalid: 'bad SOCKS4 reply version' }
  return { length: 8, ok: buf[1] === 0x5a, code: buf[1] }
}
/** SOCKS5 greeting: VER=5 NMETHODS METHODS… */
export function socks5Greeting(buf) {
  if (buf.length < 2) return null
  if (buf[0] !== 5 || buf[1] === 0) return { invalid: 'not a SOCKS5 greeting' }
  if (buf.length < 2 + buf[1]) return null
  return { length: 2 + buf[1], methods: [...buf.subarray(2, 2 + buf[1])] }
}
/** SOCKS5 method selection: VER=5 METHOD. */
export function socks5Method(buf) {
  if (buf.length < 2) return null
  if (buf[0] !== 5) return { invalid: 'bad SOCKS5 method reply' }
  return { length: 2, method: buf[1] }
}
/** RFC 1929 username/password: VER=1 ULEN UNAME PLEN PASSWD (the proxy credential — stored 0600). */
export function socks5Auth(buf) {
  if (buf.length < 2) return null
  if (buf[0] !== 1) return { invalid: 'bad RFC 1929 version' }
  const ulen = buf[1]; if (buf.length < 3 + ulen) return null
  const plen = buf[2 + ulen]; if (buf.length < 3 + ulen + plen) return null
  return { length: 3 + ulen + plen }
}
/** RFC 1929 status: VER=1 STATUS(0 = success). */
export function socks5AuthStatus(buf) {
  if (buf.length < 2) return null
  return { length: 2, ok: buf[1] === 0 }
}
/** SOCKS5 request / reply: VER=5 CMD|REP RSV ATYP ADDR PORT. */
export function socks5Request(buf) {
  if (buf.length < 4) return null
  if (buf[0] !== 5) return { invalid: 'bad SOCKS5 request' }
  const a = addr(buf, 3); if (!a || a.invalid) return a
  return { length: a.end, cmd: buf[1], host: a.host, port: a.port }
}
export function socks5Reply(buf) {
  const r = socks5Request(buf); if (!r || r.invalid) return r
  return { length: r.length, ok: r.cmd === 0, code: r.cmd }
}

/**
 * socksHandshake(io, firstByte) → {ok, kind, host, port, reason, opaque?}
 *   io.client(parser) / io.proxy(parser): resolve with the next parsed message ({raw, …}) from that
 *   side, or with {invalid}; io.toProxy(raw) / io.toClient(raw) forward bytes verbatim.
 * ok:false + reason: the proxy refused (its answer is already relayed); opaque:true: something we do
 * not follow (GSSAPI, BIND, UDP, garbage) — the caller splices everything from here on.
 */
export async function socksHandshake(io, first) {
  const opaque = (reason, extra = {}) => ({ ok: false, opaque: true, reason, ...extra })
  if (first === 4) {
    const r = await io.client((b) => { const q = socks4Request(b); return q === null && b.length > MAX ? { invalid: 'too long' } : q })
    if (r.invalid) return opaque(`socks4: ${r.invalid}`)
    io.toProxy(r.raw)
    if (r.cmd !== 1) return opaque('socks4: not CONNECT', { kind: r.kind })
    const rep = await io.proxy(socks4Reply)
    if (rep.invalid) return opaque(`socks4: ${rep.invalid}`, { kind: r.kind })
    io.toClient(rep.raw)
    return { ok: rep.ok, kind: r.kind, host: r.host, port: r.port, reason: rep.ok ? null : `socks4-reply-${rep.code}` }
  }
  const g = await io.client(socks5Greeting); if (g.invalid) return opaque(`socks5: ${g.invalid}`)
  io.toProxy(g.raw)
  const m = await io.proxy(socks5Method); if (m.invalid) return opaque(`socks5: ${m.invalid}`, { kind: 'socks5' })
  io.toClient(m.raw)
  if (m.method === 0xff) return { ok: false, kind: 'socks5', reason: 'socks5-no-acceptable-method' }
  if (m.method === 2) {
    const a = await io.client(socks5Auth); if (a.invalid) return opaque(`socks5: ${a.invalid}`, { kind: 'socks5' })
    io.toProxy(a.raw)
    const s = await io.proxy(socks5AuthStatus)
    io.toClient(s.raw)
    if (!s.ok) return { ok: false, kind: 'socks5', reason: 'socks5-auth-failed' }
  } else if (m.method !== 0) return opaque(`socks5: method ${m.method} not followed`, { kind: 'socks5' })
  const r = await io.client(socks5Request); if (r.invalid) return opaque(`socks5: ${r.invalid}`, { kind: 'socks5' })
  io.toProxy(r.raw)
  if (r.cmd !== 1) return opaque('socks5: not CONNECT', { kind: 'socks5' })
  const rep = await io.proxy(socks5Reply); if (rep.invalid) return opaque(`socks5: ${rep.invalid}`, { kind: 'socks5' })
  io.toClient(rep.raw)
  return { ok: rep.ok, kind: 'socks5', host: r.host, port: r.port, reason: rep.ok ? null : `socks5-reply-${rep.code}` }
}
