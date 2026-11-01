// ingress.mjs — the engine's proxy ingress (RFC 4.8 §5.1, §5.2). Where the transparent listener takes connections a
// kernel steered (Linux eBPF), this takes the ones a proxy client hands over on purpose: on macOS / Windows the agent itself, through
// the proxy entry trocar wrote (D47: the engine is the proxy, one door per group; the user's VPN is never pointed here), sends each
// connection as `CONNECT host:port` with `Proxy-Authorization: Basic <group>:<token>`, or as a SOCKS5 CONNECT with RFC 1929 credentials. The ingress answers like the proxy it is, dials the upstream,
// and only then says yes; the bytes after that are an agent's, and go to handleFlow exactly as a transparent flow's do.
//
// Order per connection (§5.1):
//   1. read the opener — CONNECT, SOCKS5, or an absolute-form `http://` request (a program that inherited an agent's proxy env); an origin-form
//      GET is the PAC's on an open door; anything else is closed, `ingress-unknown`;
//   2. check the token, in constant time — 407 / SOCKS auth failure and `ingress-auth-failed`, zero upstream connections;
//   3. lookupIngress({peer, user, target}) → the flow's meta, or {health:true, group}, or {refuse:{code, reason, unread?}} (the door refused this process:
//      one record, closed unanswered — unless its owner could not be read (`unread`) and the client had already left, which refused nothing: counted `left`, no record), or null (an unknown
//      user: also an auth failure);
//   4. a health probe (the target is the group's re-entry point itself): 200, then 204 to every `HEAD`/`GET /trocar-health/<g>`
//      on the kept-alive tunnel; no upstream, no flows/ row, no envelope. It never leaves the machine (invariant 1);
//   5. dial the upstream — direct, or the proxy prelude trocar writes (http / socks5; the user's proxy credentials ride only here) —
//      and say 200 only once it is up: a failure is `502`, or the proxy's own refusal, never a success first;
//   6. handleFlow(socket, meta, {upstream, redial}); the row carries ingress / pid_source / pid_ms / upstream, no `prelude`
//      (the opener and the proxy prelude are trocar's bytes, not the agent's: invariant 4, §5.6). Absolute-form plain http goes through
//      forwardHttp (forward.mjs): steps 3–6 for each authority the client names, each a flow of its requests less the door's credential.
// The ingress never records an envelope itself and never forwards a byte it has not been asked to.
import crypto from 'node:crypto'
import net from 'node:net'
import { STATUS_CODES } from 'node:http'
import { parseHead } from './sniff.mjs'
import { wentBy } from './flow.mjs'
import { socks5Greeting, socks5Request } from './socks.mjs'
import { HOOK_HEADER as UPSTREAM_HEADER } from '../proxymode/chain.mjs'
import { absTarget, forwardHttp } from './forward.mjs'

const HEAD_MAX = 16 * 1024        // no opener or proxy reply head is longer
const HOLD_MAX = 256 * 1024       // what a client may send while the upstream is being dialled
const sha = (s) => crypto.createHash('sha256').update(s).digest()
const printable = (s, n = 80) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, n)
const ROUTE_NAME = /^[\w-]+\.[\w.-]+$/ // the user an trocar-written route or block authenticates as: <route>.<group>
const msgOf = (e) => String((e && e.message) || e)

const SOCKS_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
const socksReply = (rep) => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0])
const socksRepOf = (code) => (code === 'ECONNREFUSED' ? 5 : code === 'ENETUNREACH' ? 3 : ['EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 4 : 1)

// ── the byte reader the handshakes use ─────────────────────────────────────────────────────────────────────────
// take(parser, deadline): parser(buf) → null (need more) | {invalid} | {length, …}; resolves with the message (and its `raw`), `{invalid}`,
// `{gone}` (the peer closed, ended or errored first) or `{timeout}`. detach() returns the bytes held beyond the last message and lets go
// of the socket, which goes on flowing for whoever attaches next, synchronously (handleFlow does).
function reader(sock, { onTooMuch = null, holdMax = HOLD_MAX } = {}) {
  let buf = Buffer.alloc(0), wake = null, gone = null
  let watchers = []
  const poke = () => { const w = wake; wake = null; if (w) w() }
  const onData = (d) => { buf = Buffer.concat([buf, d]); if (onTooMuch && buf.length > holdMax) { onTooMuch(); return } poke() }
  const goneBy = (why) => (e) => {
    if (!gone) gone = { why, error: e instanceof Error ? e : null }
    for (const f of watchers.splice(0)) f()
    poke()
  }
  const onEnd = goneBy('end'), onClose = goneBy('close'), onError = goneBy('error')
  sock.on('data', onData); sock.on('end', onEnd); sock.on('close', onClose); sock.on('error', onError)
  return {
    isGone: () => gone !== null,
    /** fn() runs once if the peer goes before detach() */
    whenGone(fn) { if (gone) fn(); else watchers.push(fn) },
    async take(parser, deadline = Infinity) {
      for (;;) {
        const m = parser(buf)
        if (m) { if (m.invalid) return m; const raw = buf.subarray(0, m.length); buf = buf.subarray(m.length); return { ...m, raw } }
        if (gone) return { gone: gone.why }
        const left = deadline - Date.now()
        if (left <= 0) return { timeout: true }
        await new Promise((res) => {
          let t = null
          wake = () => { if (t) clearTimeout(t); res() }
          if (deadline !== Infinity) { t = setTimeout(poke, left); if (t.unref) t.unref() }
        })
      }
    },
    detach() {
      sock.removeListener('data', onData); sock.removeListener('end', onEnd); sock.removeListener('close', onClose); sock.removeListener('error', onError)
      watchers = []
      const b = buf; buf = Buffer.alloc(0); return b
    },
  }
}

// ── parsers ─────────────────────────────────────────────────────────────────────────────────────────────────────
// the first bytes: CONNECT, SOCKS5, or another HTTP request line. `length: 0`: nothing is consumed, the next parser reads from the start.
function sniffOpener(buf) {
  if (!buf.length) return null
  if (buf[0] === 0x05) return { kind: 'socks5', length: 0 }
  const s = buf.toString('latin1', 0, 8)
  if (s.startsWith('CONNECT ')) return { kind: 'connect', length: 0 }
  if (/^[A-Z]{3,7} /.test(s)) return { kind: 'http', length: 0 } // absolute-form http is forwarded, an origin-form GET is the PAC's (serve)
  if (/^[A-Z]{1,7}$/.test(s)) return null // a method so far: need more
  return { invalid: `first byte 0x${buf.subarray(0, 1).toString('hex')}: neither CONNECT, SOCKS5 nor an HTTP request` }
}
/** A plain-HTTP opener's method and target host (the absolute URI's host name, else the Host header's; no user info, no port, lower case), from
 *  what the client sent: {} when the bytes are no HTTP request line. Never its path, query or any other header (4.8 §5.1). */
function httpOf(buf) {
  if (!buf || !buf.length) return {}
  const s = buf.toString('latin1', 0, HEAD_MAX)
  const line = /^([A-Z]{3,7}) (\S*)/.exec(s)
  if (!line) return {}
  const abs = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(line[2])
  const hdr = /\r?\nhost:[ \t]*([^\r\n]*)/i.exec(s.slice(0, s.search(/\r?\n\r?\n|$/)))
  const auth = abs ? abs[1] : hdr ? hdr[1].trim() : ''
  const hp = auth.slice(auth.lastIndexOf('@') + 1)
  const host = (hp.startsWith('[') ? hp.slice(0, hp.indexOf(']') + 1) : hp.replace(/:\d*$/, '')).toLowerCase()
  return { method: line[1], ...(/^[a-z0-9.\-_[\]:]{1,253}$/.test(host) ? { host } : {}) }
}
function headOf(buf) {
  const h = parseHead(buf)
  if (!h) return buf.length > HEAD_MAX ? { invalid: 'a head longer than 16 KiB' } : null
  return { length: h.headLength, head: h }
}
function userPass(buf) { // RFC 1929: VER=1 ULEN UNAME PLEN PASSWD
  if (buf.length < 2) return null
  if (buf[0] !== 1) return { invalid: 'bad RFC 1929 version' }
  const ul = buf[1]; if (buf.length < 3 + ul) return null
  const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return null
  return { length: 3 + ul + pl, user: buf.toString('utf8', 2, 2 + ul), pass: buf.toString('utf8', 3 + ul, 3 + ul + pl) }
}
/** "host:port" / "[v6]:port" → {host, port} (an IPv6 literal compressed, no brackets) or null */
export function parseAuthority(a) {
  let host, rest
  if (a.startsWith('[')) {
    const i = a.indexOf(']'); if (i < 0) return null
    rest = a.slice(i + 1)
    try { host = new URL(`http://${a.slice(0, i + 1)}`).hostname.slice(1, -1) } catch { return null }
  } else {
    const i = a.lastIndexOf(':'); if (i < 0) return null
    host = a.slice(0, i); rest = a.slice(i)
    if (host.includes(':')) return null
  }
  if (!/^:\d{1,5}$/.test(rest) || !/^[\x21-\x7e]+$/.test(host)) return null
  const port = Number(rest.slice(1))
  return port >= 1 && port <= 65535 ? { host, port } : null
}
// a compressed IPv6 literal (URL-normalised: hex groups only) → its 16 bytes
function ip6bytes(h) {
  const [a, b] = h.split('::')
  const left = a ? a.split(':') : [], right = b ? b.split(':') : []
  const mid = b === undefined ? [] : Array(8 - left.length - right.length).fill('0')
  return Buffer.from([...left, ...mid, ...right].flatMap((x) => { const n = parseInt(x, 16); return [n >> 8, n & 255] }))
}
const authority = (t) => (t.host.includes(':') ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`)
function basicOf(headers) {
  const h = headers.find(([k]) => k.toLowerCase() === 'proxy-authorization')
  const m = h && /^basic\s+(\S+)$/i.exec(h[1])
  if (!m) return null
  const text = Buffer.from(m[1], 'base64').toString('utf8'), i = text.lastIndexOf(':') // the last colon: a door's user is its group id `<harness>:<route>`, the token is hex
  return i < 0 ? { user: text, pass: '' } : { user: text.slice(0, i), pass: text.slice(i + 1) }
}

// ── the upstream ────────────────────────────────────────────────────────────────────────────────────────────────
function whenConnected(s) {
  return new Promise((resolve, reject) => {
    if (s.destroyed) return reject(Object.assign(new Error('the upstream socket was closed'), { code: 'ECONNRESET' }))
    if (!s.connecting) return resolve()
    const ok = () => { off(); resolve() }
    const bad = (e) => { off(); reject(e || Object.assign(new Error('closed before connecting'), { code: 'ECONNRESET' })) }
    const off = () => { s.removeListener('connect', ok); s.removeListener('error', bad); s.removeListener('close', bad) }
    s.once('connect', ok); s.once('error', bad); s.once('close', bad)
  })
}

// The proxy prelude trocar writes for an agent's connection, and what comes back. Never for a health probe; the credentials (up.auth) are
// the user's own proxy's, used for this one agent connection and nowhere else (§5.2, D30).
async function viaHttp(sock, up, target, deadline) {
  const au = authority(target)
  const cred = up.auth ? `Proxy-Authorization: Basic ${Buffer.from(`${up.auth.username}:${up.auth.password}`).toString('base64')}\r\n` : ''
  const r = reader(sock)
  sock.write(`CONNECT ${au} HTTP/1.1\r\nHost: ${au}\r\n${cred}\r\n`)
  const m = await r.take(headOf, deadline)
  const rest = r.detach()
  if (m.gone || m.timeout || m.invalid) return { ok: false, kind: 'unreachable', error: { type: m.invalid ? 'bad_proxy_reply' : 'proxy_closed', message: m.invalid || `the proxy ${m.timeout ? 'did not answer' : 'closed the connection'} before its reply to CONNECT` } }
  // a reply that is not an HTTP status line is not a refusal the agent should be shown: the proxy is not speaking HTTP (or is not a proxy), so the dial failed
  const line = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(m.head.startLine)
  if (!line) return { ok: false, kind: 'unreachable', error: { type: 'bad_proxy_reply', message: `the proxy's reply to CONNECT is not an HTTP status line (${printable(m.head.startLine, 40)})` } }
  const status = Number(line[1])
  if (status >= 200 && status < 300) return { ok: true, sock, reply: status, rest }
  return { ok: false, kind: 'refused', reason: `proxy-status-${status}`, reply: status, raw: Buffer.concat([m.raw, rest]) }
}
async function viaSocks5(sock, up, target, deadline) {
  const r = reader(sock)
  // before the CONNECT request no target has been named: a failure there is the proxy's own, for every agent of the door (4.8 W73 `proxy: true`)
  const fail = (m, what, proxy = true) => ({ ok: false, kind: 'unreachable', proxy, error: { type: m.timeout ? 'proxy_timeout' : 'proxy_closed', message: `the SOCKS5 proxy ${m.timeout ? 'did not answer' : 'closed the connection'} during ${what}` } })
  const bad = (what, reason) => ({ ok: false, kind: 'refused', reason, reply: null, what })
  try {
    sock.write(up.auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]))
    const m = await r.take((b) => (b.length < 2 ? null : b[0] !== 5 ? { invalid: 'not a SOCKS5 method reply' } : { length: 2, method: b[1] }), deadline)
    if (m.gone || m.timeout) return fail(m, 'the method exchange')
    if (m.invalid) return { ok: false, kind: 'unreachable', proxy: true, error: { type: 'bad_proxy_reply', message: m.invalid } }
    if (m.method === 0xff) return bad('method', 'socks5-no-acceptable-method')
    if (m.method === 2 && up.auth) {
      const u = Buffer.from(up.auth.username), p = Buffer.from(up.auth.password)
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
      const s = await r.take((b) => (b.length < 2 ? null : { length: 2, ok: b[1] === 0 }), deadline)
      if (s.gone || s.timeout) return fail(s, 'authentication')
      if (!s.ok) return bad('auth', 'socks5-auth-failed')
    } else if (m.method !== 0) return bad('method', `socks5-method-${m.method}`)
    const host = Buffer.from(target.host)
    const ip = net.isIP(target.host)
    const addr = ip === 4 ? Buffer.concat([Buffer.from([1]), Buffer.from(target.host.split('.').map(Number))])
      : ip === 6 ? Buffer.concat([Buffer.from([4]), ip6bytes(target.host)])
        : Buffer.concat([Buffer.from([3, host.length]), host])
    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([target.port >> 8, target.port & 255])]))
    const q = await r.take(socks5Request, deadline)
    if (q.gone || q.timeout) return fail(q, 'the CONNECT', false)
    if (q.invalid) return { ok: false, kind: 'unreachable', error: { type: 'bad_proxy_reply', message: q.invalid } }
    const rest = r.detach()
    if (q.cmd === 0) return { ok: true, sock, reply: 0, rest }
    return { ok: false, kind: 'refused', reason: `socks5-reply-${q.cmd}`, reply: q.cmd, raw: null }
  } finally { r.detach() }
}

/**
 * createIngress({ token, lookupIngress, handleFlow, connectUpstream, failure, timing, refuse, ownerOfPeer }) → { attach(server), handle(socket), stats(), closeIdle() }
 *   token            the install's ingress token (4.8 §3); a connection that does not present it gets 407 / auth failure
 *   lookupIngress    async ({peer, user, target:{address, port, family?}}) → IngressMeta | {health:true, group} | {refuse:{code, reason, unread?}} | null (an unknown user)
 *   handleFlow       (socket, meta, {upstream, redial}) — the engine's flow starter; `redial` re-dials through the same upstream when the
 *                    upstream carries no credentials (4.6 让路), else undefined
 *   connectUpstream  ({address, port}) → a connecting net.Socket (the engine's; tests inject)
 *   failure          (rec) the engine's failure sink; the ingress writes where:'ingress' records through it
 *   refuse           (meta, info) — the flows/ row of a connection the upstream refused or could not be reached (no flow started)
 *   ownerOfPeer      optional async (peer) → { pid, process?, why? }: who holds the client's end (the door's own owner question); an `ingress-unknown`
 *                    record names that process, or says why it could not be told (`owner_unread`)
 *   timing           {ingressOpenerMs = 10000, ingressHealthIdleMs = 30000, ingressDialMs = 0 (no limit), upstreamSlowMs = 5000 (one upstream-slow event while a proxy has not answered)}
 * The connection handlers take an optional DOOR (D47, 4.9 §3): `null` = the engine's own ingress (the global token, the client's own user),
 * `{ user, token, open }` = one of the engine's per-group doors — `user` is the group id the lookup is asked with (whoever the client did or did
 * not authenticate as), `token` that door's password (the listener token), `open:true` a door that takes no credentials at all (the desktop
 * launcher's `auth:false` group: a CONNECT with no Proxy-Authorization is accepted; SOCKS5 keeps requiring its handshake, so an open door serves CONNECT).
 */
export function createIngress({ token, lookupIngress, handleFlow, connectUpstream, failure, timing = {}, refuse = () => {}, servePac = null, ownerOfPeer = null }) {
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('the ingress needs the install\'s token (a string of at least 16 characters)')
  for (const [n, f] of Object.entries({ lookupIngress, handleFlow, connectUpstream, failure })) if (typeof f !== 'function') throw new TypeError(`createIngress: ${n} is required`)
  const tokenHash = sha(token)
  const tokenOk = (given, against = tokenHash) => crypto.timingSafeEqual(sha(String(given)), against)
  // Who a record says tried: a name shaped like "<route>.<group>" that does not hold the token. Anything else is a client that put something else in
  // the username field, and when that is the token (a generator that swapped username and password, a credential with no colon) it must not be written
  // to flows/: no token, right or wrong, is in any record (§5.1).
  const shownUser = (u) => (u === '' ? '' : ROUTE_NAME.test(u) && !u.includes(token) ? printable(u) : '(not a route name)')
  const openerMs = timing.ingressOpenerMs ?? 10_000, healthIdleMs = timing.ingressHealthIdleMs ?? 30_000
  const counters = { connections: 0, flows: 0, health: 0, challenged: 0, authFailed: 0, unknown: 0, refused: 0, unreachable: 0, left: 0 }
  // Did the client leave while it was being judged (4.8 §5.1, 4.11 P10)? Asked one event-loop turn later: a peer whose end had no holder when its owner
  // was read had closed before that read, so its FIN (or reset) was in this socket's queue before the lookup answered, and the poll before the turn
  // delivers it even when the answer and the FIN came in one batch. A client that left is refused nothing and is no failure (it sent only its opener,
  // nothing of the agent's was lost, D38): it is counted, never recorded. Left = closed or half-closed (its FIN reads as 'end' before any 'close'); asked
  // only of a refusal whose owner could not be read, and a live process that half-closes still holds its end, so its owner is read and it is not asked.
  const leftWhileJudged = async (r) => { await new Promise((res) => setImmediate(res)); if (!r.isGone()) return false; counters.left++; return true }
  const now = timing.now || Date.now, lastUnreachable = new Map() // door group → when its upstream-unreachable event was written (1.6 §9.7: at most one per form per 60 s)
  const idle = new Set() // sockets that are not a flow: still in the handshake, or a health tunnel (closeIdle ends them; flows finish on their own)

  async function handle(socket, door = null) {
    const acceptedAt = Date.now() // before the opener, the lookup and the dial: the engine's slowness counts from here (flow.mjs SLOW_ENGINE_MS)
    counters.connections++
    idle.add(socket); socket.once('close', () => idle.delete(socket))
    socket.on('error', () => {}) // ours from accept: a reset while we answer is this connection's end, never an uncaught exception (handleFlow adds its own once it owns the socket)
    const peer = { address: socket.remoteAddress, port: socket.remotePort }
    // the opener's sender, asked while its end is still open (the answer, a close, waits for it: nothing else does), and of a plain-HTTP opener its
    // method and host from the bytes held (`held`): never a path, a query or another header (4.8 §5.1)
    const unknown = async (reason, held = null) => {
      counters.unknown++
      let who = {}
      if (ownerOfPeer) {
        try { const o = await ownerOfPeer(peer); who = o && o.pid != null ? { pid: o.pid, ...(o.process ? { process: printable(o.process) } : {}), ...(o.why ? { owner_unread: printable(o.why) } : {}) } : { owner_unread: printable((o && o.why) || 'unanswered') } } catch (e) { who = { owner_unread: printable(msgOf(e), 200) } }
      }
      failure({ where: 'ingress', code: 'ingress-unknown', peer, ...httpOf(held), ...who, reason })
    }
    const authFailed = (user, reason) => { counters.authFailed++; failure({ where: 'ingress', code: 'ingress-auth-failed', peer, user: shownUser(user), reason }) }
    const r = reader(socket, { onTooMuch: () => { unknown('the client sent more than 256 KiB before the tunnel was open').catch(() => {}); socket.destroy() } }) // cut at once; its record follows
    const w = { up: 0, down: 0 } // the opener's bytes in, and trocar's answers out: not the agent's (§5.6)
    const say = (b) => { w.down += b.length; if (!socket.destroyed) socket.write(b) }
    try { await serve(socket, r, peer, w, say, unknown, authFailed, door, acceptedAt) } catch (e) {
      socket.destroy()
      failure({ code: 'engine-error', peer, reason: `the proxy ingress failed on a connection: ${msgOf(e)}` })
    }
  }

  async function serve(socket, r, peer, w, say, unknown, authFailed, door = null, acceptedAt = Date.now()) {
    const doorHash = door && typeof door.token === 'string' && door.token.length > 0 ? sha(door.token) : null
    const deadline = Date.now() + openerMs
    const shut = async (why, end = 'destroy', before = null) => { const held = r.detach(); await unknown(why, before ? Buffer.concat([before, held]) : held); socket[end]() } // read no more, record, then close
    const first = await r.take(sniffOpener, deadline)
    if (first.gone) return void r.detach()
    if (first.timeout || first.invalid) return shut(first.invalid || `no opener within ${openerMs} ms`)
    // what the client asked, in its own dialect: who, for where, and how each answer is spoken
    const httpSays = {
      denied: () => { say('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="trocar"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); socket.end() },
      badGateway: () => { say('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); socket.end() },
      refusedBy: (d) => { if (d.raw) { say(d.raw); socket.end() } else httpSays.badGateway() },
    }
    let o
    if (first.kind === 'http') {
      const m = await r.take(headOf, deadline)
      if (m.gone) return void r.detach()
      if (m.timeout || m.invalid) return shut(m.invalid || `no complete request head within ${openerMs} ms`)
      const target = absTarget(m.head.startLine)
      if (!target) {
        if (door && door.open && typeof servePac === 'function' && m.head.startLine.startsWith('GET ')) return servePacGet(socket, r, peer, say, unknown, door, m)
        return shut(`a plain HTTP request that is not an http:// absolute-form request (${printable(m.head.startLine.split(' ')[0], 10)}): the door takes CONNECT, SOCKS5 and those`, 'destroy', m.raw)
      }
      const c = basicOf(m.head.headers)
      o = { target, user: c ? c.user : '', pass: c ? c.pass : null, authed: false, forward: { head: m }, ok: () => {}, ...httpSays }
    } else if (first.kind === 'connect') {
      const m = await r.take(headOf, deadline)
      if (m.gone) return void r.detach()
      if (m.timeout || m.invalid) return shut(m.invalid || `no complete CONNECT within ${openerMs} ms`)
      w.up += m.length
      const line = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(m.head.startLine)
      const target = line && parseAuthority(line[1])
      if (!target) return shut('a CONNECT whose target is not host:port')
      const c = basicOf(m.head.headers)
      const hh = m.head.headers.find(([k]) => k.toLowerCase() === UPSTREAM_HEADER) // the hook's prior proxy (4.11 P7 step 1): handed to the lookup, never forwarded (the ingress writes its own prelude) nor recorded
      o = {
        target, user: c ? c.user : '', pass: c ? c.pass : null, authed: false, ...(hh ? { header: hh[1] } : {}),
        ok: () => say('HTTP/1.1 200 Connection established\r\n\r\n'), ...httpSays,
      }
    } else {
      const g = await r.take(socks5Greeting, deadline)
      if (g.gone) return void r.detach()
      if (g.timeout || g.invalid) return shut(g.invalid || `no complete SOCKS5 greeting within ${openerMs} ms`)
      w.up += g.length
      if (!g.methods.includes(2)) { say(Buffer.from([5, 0xff])); authFailed('', 'no username/password method offered'); r.detach(); return socket.end() }
      say(Buffer.from([5, 2]))
      const a = await r.take(userPass, deadline)
      if (a.gone) return void r.detach()
      if (a.timeout || a.invalid) return shut(a.invalid || `no complete SOCKS5 credentials within ${openerMs} ms`)
      w.up += a.length
      if (!tokenOk(a.pass, doorHash ?? tokenHash)) { say(Buffer.from([1, 1])); authFailed(a.user, 'token mismatch'); r.detach(); return socket.end() }
      say(Buffer.from([1, 0]))
      const q = await r.take(socks5Request, deadline)
      if (q.gone) return void r.detach()
      if (q.timeout || q.invalid) return shut(q.invalid || `no complete SOCKS5 request within ${openerMs} ms`)
      w.up += q.length
      if (q.cmd !== 1) { say(socksReply(7)); return shut(`SOCKS5 command ${q.cmd} is not CONNECT`, 'end') }
      if (!/^[\x21-\x7e]+$/.test(q.host) || q.port < 1) { say(socksReply(8)); return shut('a SOCKS5 target that is not a host name or an address', 'end') } // the name goes into the proxy prelude: no control bytes
      o = {
        target: { host: q.host, port: q.port }, user: a.user, pass: a.pass, authed: true,
        ok: () => say(SOCKS_OK),
        denied: () => { say(socksReply(2)); socket.end() },
        badGateway: (code) => { say(socksReply(socksRepOf(code))); socket.end() },
        refusedBy: () => { say(socksReply(2)); socket.end() },
      }
    }

    // 2. the token, in constant time; a connection that did not present one never gets as far as a lookup. A door of an `auth:false` group
    //    (D47) takes no credentials at all: the connection is judged by its process, not by a password any process could copy.
    //    A CONNECT with no Proxy-Authorization at all is the first leg of Basic auth (RFC 7235), not a wrong credential: Chromium (VS Code's
    //    network service) sends none until a 407 asks, then answers from http.proxy's user:token. It gets the 407 challenge, is counted
    //    (`challenged`), and writes no failure line; a wrong token is `ingress-auth-failed` (4.8 §5.1).
    if (!o.authed && !(door && door.open) && o.pass === null) { counters.challenged++; r.detach(); return o.denied() }
    if (!o.authed && !(door && door.open) && !tokenOk(o.pass, doorHash ?? tokenHash)) { authFailed(o.user, 'token mismatch'); r.detach(); return o.denied() }
    // who this connection is for: a door names its group (the client's own user is only the engine's own ingress's to say), and the lookup
    // answers it with the process the socket belongs to, not with anything the credentials claim
    const who = door && typeof door.user === 'string' && door.user !== '' ? door.user : o.user
    if (o.forward) {
      let first = true
      const start = async (target, sock) => {
        const at = first ? acceptedAt : Date.now(); first = false
        if (!socket.destroyed) idle.add(socket) // while it is judged and dialled, closeIdle cuts it; a flow then finishes on its own
        const a = await admit({ ...o, target })
        if (!a) return false
        idle.delete(socket)
        flow(sock, target, a, at, { up: 0, down: 0 }) // the stand-in counts the forwarded requests and the answers only
        return true
      }
      return forwardHttp({ socket, r, head: o.forward.head, next: () => r.take(headOf), start, shut: (why, raw) => shut(why, 'destroy', raw) })
    }
    const a = await admit(o)
    if (!a) return
    o.ok()
    // 6. an agent's flow from here on. The credentials stay in this closure; the flow only knows whether the upstream has some.
    const rest = r.detach(); idle.delete(socket)
    if (rest.length) socket.unshift(rest)
    flow(socket, o.target, a, acceptedAt, { up: w.up, down: w.down })

    function flow(sock, target, { base, shown, d, up }, at, wire) {
      if (d.rest.length) d.sock.unshift(d.rest)
      counters.flows++
      const credentialed = !!up.auth
      // a direct upstream is redialled as the transparent door does it (a connecting socket, at once); a proxy needs its prelude again (a Promise)
      const redial = credentialed ? undefined : (up.kind || 'direct') === 'direct' ? () => connectUpstream({ address: target.host, port: target.port }) : async () => {
        const x = await dialUpstream(up, target, () => {}, { slow: false }) // the flow's own wait (flow.mjs waitFor) records a slow second prelude, once
        // the OS's `syscall` goes along: wentBy tells a reset off the wire (kept as ECONNRESET) from Node's invented one (a close) by it
        if (!x.ok) throw Object.assign(new Error(x.kind === 'refused' ? `the upstream refused the second connection (${x.reason})` : x.error.message), { code: x.kind === 'refused' ? 'proxy-refused' : x.error.type, ...(x.syscall ? { syscall: x.syscall } : {}) })
        if (x.rest.length) x.sock.unshift(x.rest)
        return x.sock
      }
      handleFlow(sock, { ...base, acceptedAt: at, upstream: { ...shown, ...(d.reply != null ? { reply: d.reply } : {}), credentialed }, wire }, { upstream: d.sock, redial })
    }

    // steps 3–5 for one target: the lookup, its refusals, the health probe, the upstream dial and its refusal rows. → {base, shown, d} with the upstream
    // up, or undefined (the client has been answered and the connection ended). CONNECT, SOCKS5 and every forwarded authority come through here.
    async function admit(o) {
      // 3. who is this
      const dst = { address: o.target.host, port: o.target.port, ...(net.isIP(o.target.host) ? { family: net.isIP(o.target.host) } : {}) }
      let meta
      try { meta = await lookupIngress({ peer, user: who, target: dst, ...(o.header !== undefined ? { header: o.header } : {}) }) } catch (e) {
        if (e && e.code === 'upstream-unavailable') { // the redirector would not hand over a connection it cannot dial (no login for the upstream, none to dial): trocar's own code and the ingress's own part, not a lookup that failed (4.8 §12)
          failure({ where: 'ingress', code: 'upstream-unavailable', peer, ...(typeof e.why === 'string' ? { why: e.why } : {}), reason: `the upstream of the connection of ${shownUser(o.user)} to ${o.target.host}:${o.target.port} cannot be dialled (${msgOf(e)}); it was refused with a 502` })
        } else {
          const code = e && e.code === 'loader-timeout' ? 'loader-timeout' : 'loader-down'
          failure({ code, peer, reason: `looking up the ingress connection of ${shownUser(o.user)} for ${o.target.host}:${o.target.port} failed (${msgOf(e)}); it was refused with a 502` })
        }
        r.detach(); return o.badGateway('lookup')
      }
      if (!meta) { authFailed(o.user, 'unknown user'); r.detach(); return o.denied() }
      // a door that refused this process (the PAC door, 4.11 P10): one record of its own code, and the connection closed unanswered — a 407 would ask
      // for credentials the door never takes (and Chromium does not fall over to the PAC's next entry on one). A refusal for an owner that could not be
      // read (`unread`) of a client that had left is no refusal: a client that closed has no holder, hence the unread owner; it is counted `left`
      if (meta.refuse) {
        if (!(meta.refuse.unread && await leftWhileJudged(r))) failure({ where: 'ingress', code: meta.refuse.code, peer, reason: meta.refuse.reason })
        r.detach(); return void socket.destroy()
      }
      // the client left while the lookup ran: nobody is waiting for a dial, and the user's proxy must not get its credentials for one (§5.1, §5.2)
      if (r.isGone()) { counters.left++; return void r.detach() }

      // 4. a health probe: answered here, nothing leaves the machine
      if (meta.health) { await (o.forward ? shut('a plain HTTP request for the door\'s own health target') : healthTunnel(socket, r, o, meta.group, unknown)); return }

      // 5. the upstream
      const i = who.indexOf('.')
      const route = i < 0 ? who : who.slice(0, i), group = i < 0 ? '' : who.slice(i + 1)
      const up = meta.upstream || { kind: 'direct' }
      let current = null
      r.whenGone(() => { if (current) current.destroy() })
      const dial = () => dialUpstream(up, o.target, (s) => { current = s })
      const shown = { kind: up.kind || 'direct', ...(up.host ? { host: up.host } : {}), ...(up.port != null ? { port: up.port } : {}) }
      // The negative cache's key is part of the lookup's contract (§5.5); one that comes without it is keyed here the way the contract says, so a lookup that
      // forgets it cannot make every connection without a pid share the key "null" and poison one another's hosts.
      const base = { ...meta, dst: meta.dst ?? dst, ingress: meta.ingress ?? { route, group }, negKey: meta.negKey ?? (meta.pid != null ? String(meta.pid) : who) }
      const waited = { phase: shown.kind === 'direct' ? 'connect' : 'proxy-reply', t0: Date.now() }
      const d = await dial()
      current = null
      // the client left while the upstream was dialled: no flow existed and nothing more is dialled or sent, but the give-up is a row (RFC 4.6 §记录
      // 经代理入口的连接行); a socket the ingress cut itself (it ended or errored on neither side: onTooMuch) has its own record
      if (r.isGone()) {
        if (d.ok) d.sock.destroy()
        r.detach()
        if (!socket.readableEnded && !socket.errored) return
        const error = wentBy('client', socket.errored, waited)
        return void refuse({ ...base, upstream: shown }, { decision: 'error', not_captured: 'error', error, duration_ms: error.wait?.ms ?? 0 })
      }
      if (!d.ok) {
        r.detach()
        if (d.kind === 'refused') { counters.refused++; refuse({ ...base, upstream: { ...shown, ...(d.reply != null ? { reply: d.reply } : {}) } }, { decision: 'tunnel', not_captured: 'proxy-refused', reason: d.reason }); return o.refusedBy(d) }
        counters.unreachable++
        const at = now(), last = lastUnreachable.get(group)
        // only a failure of the door's upstream proxy itself blames the door (4.8 W73): a dead target host — dialled direct, or dropped by a proxy that took
        // the TCP connection — is that connection's row alone, and must not use up the 60 s window a real proxy outage needs
        if (d.proxy && (last === undefined || at - last >= 60_000)) { lastUnreachable.set(group, at); failure({ where: 'netenv', code: 'upstream-unreachable', group, upstream: shown, reason: `the upstream of ${group || 'this door'} cannot be dialled (${d.error.type}: ${d.error.message}); its agents get 502 until it is back (one event per 60 s)` }) }
        refuse({ ...base, upstream: shown }, { decision: 'error', not_captured: 'error', error: { type: d.error.type, message: d.error.message, side: 'upstream' } })
        return o.badGateway(d.error.type)
      }
      return { base, shown, d, up }
    }
  }

  async function dialUpstream(up, target, track, { slow: watchSlow = true } = {}) {
    const kind = up.kind || 'direct'
    // `proxy: true` marks a failure of the door's upstream itself (every connection of the door fails the same way), as opposed to one target (4.8 W73)
    if (!['direct', 'http', 'socks5'].includes(kind)) return { ok: false, kind: 'unreachable', proxy: true, error: { type: 'unsupported_upstream', message: `the upstream kind ${JSON.stringify(printable(kind))} is not one the ingress dials (direct, http, socks5)` } }
    const to = kind === 'direct' ? { address: target.host, port: target.port } : { address: up.host, port: up.port }
    // Waiting on the user's proxy has no time limit (D31: cutting the agent because a proxy is slow would break it), but it is not silent either (D38):
    // once, past upstreamSlowMs, the same upstream-slow event the flow raises for the waits it owns (flow.mjs waitFor). No flow exists yet, so no flow_id.
    let slow = null
    if (kind !== 'direct' && watchSlow) {
      const ms = timing.upstreamSlowMs ?? 5000, t0 = Date.now()
      slow = setTimeout(() => { slow = null; const waited = Math.max(ms, Date.now() - t0); failure({ code: 'upstream-slow', host: target.host, phase: 'proxy-reply', waited_ms: waited, reason: `${target.host} has not answered the proxy request for ${waited} ms; still waiting` }) }, ms) // a timer can fire a ms early
      if (slow.unref) slow.unref()
    }
    try {
      let sock
      const viaProxy = kind !== 'direct' // a direct dial reaches the target itself: its failure is that one host's, not the door's upstream
      const failed = (e) => ({ ok: false, kind: 'unreachable', proxy: viaProxy, ...(e && e.syscall ? { syscall: e.syscall } : {}), error: { type: e.code || 'upstream_error', message: msgOf(e) } })
      try { sock = connectUpstream(to) } catch (e) { return failed(e) }
      track(sock)
      sock.on('error', () => {}) // the handshake owns the outcome; a late error must not be uncaught
      try { await whenConnected(sock) } catch (e) { sock.destroy(); return failed(e) }
      if (kind === 'direct') return { ok: true, sock, reply: null, rest: Buffer.alloc(0) }
      const deadline = timing.ingressDialMs ? Date.now() + timing.ingressDialMs : Infinity
      const d = kind === 'socks5' ? await viaSocks5(sock, up, target, deadline) : await viaHttp(sock, up, target, deadline)
      if (!d.ok) sock.destroy()
      return d
    } finally { if (slow) clearTimeout(slow) }
  }

  // an origin-form GET (4.11 P10) on an auth:false door with a PAC server (serve routes only those here; on any other door it is closed and
  // `ingress-unknown`), its head `m` already read: answered by `servePac({ peer, user, path, left })` → { status, headers, body } | null (not the
  // PAC: closed); `left()` → Promise<boolean>: whether the requester left while it was judged (then counted `left`).
  async function servePacGet(socket, r, peer, say, unknown, door, m) {
    const bad = async (why) => { const held = r.detach(); await unknown(why, Buffer.concat([m.raw, held])); socket.destroy() }
    const line = /^GET (\/\S*) HTTP\/1\.[01]$/.exec(m.head.startLine)
    if (!line) return bad('a GET that is not origin-form')
    let res
    try { res = await servePac({ peer, user: door.user, path: line[1], left: () => leftWhileJudged(r) }) } catch (e) { return bad(`the PAC could not be served: ${msgOf(e)}`) }
    r.detach()
    if (!res) return socket.destroy()
    const body = Buffer.from(res.body || '')
    const head = Object.entries({ ...(res.headers || {}), 'content-length': body.length, connection: 'close' }).map(([k, v]) => `${k}: ${v}\r\n`).join('')
    say(Buffer.concat([Buffer.from(`HTTP/1.1 ${res.status || 200} ${STATUS_CODES[res.status || 200] || ''}\r\n${head}\r\n`), body]))
    socket.end()
  }

  // a health probe tunnel (4.8 §5.1): the group's own re-entry point, answered with what an http / socks5 proxy client's health check looks for
  async function healthTunnel(socket, r, o, group, unknown) {
    counters.health++
    o.ok()
    for (;;) {
      const m = await r.take(headOf, Date.now() + healthIdleMs)
      if (m.gone) return void r.detach()
      if (m.timeout) { r.detach(); return socket.destroy() }
      const line = !m.invalid && /^(HEAD|GET) (\S+) HTTP\/1\.[01]$/.exec(m.head.startLine)
      if (!line || line[2].split('?')[0] !== `/trocar-health/${group}`) {
        r.detach(); await unknown(`a request that is not the health probe inside the health tunnel (${m.invalid || printable(m.head.startLine.split(' ').slice(0, 2).join(' '))})`)
        return socket.destroy()
      }
      socket.write('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
    }
  }

  // the 'connection' listener: handle() reports its own failures; this is only the last resort, so a throw never goes unhandled. `door` is the
  // per-group context of the listener this connection arrived on (D47), or null on the engine's own ingress.
  const connection = (s, door = null) => { handle(s, door).catch((e) => { s.destroy(); failure({ code: 'engine-error', reason: `the proxy ingress failed: ${msgOf(e)}` }) }) }
  return {
    attach(server) { server.on('connection', connection) },
    connection,
    handle,
    stats: () => ({ ...counters }),
    /** end what is not a flow (handshakes, health tunnels): engine.close() waits for flows, never for these */
    closeIdle() { for (const s of [...idle]) s.destroy() },
  }
}
