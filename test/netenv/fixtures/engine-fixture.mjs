// A stand-in for the asight engine's proxy ingress (4.8 §5.1), only as much as the real-mihomo contract needs. It is NOT the engine: Task 3 writes
// `src/collector/core/engine/ingress.mjs`, and that swap is one commit there (plan Task 0 (b)). Until then this is the thing mihomo's `asight-in-<g>`
// outbound talks to, and it records what the REAL mihomo sent (test/netenv/fixtures/mihomo-probe.bytes comes from `raw`).
//
//   - `CONNECT host:port` with `Proxy-Authorization: Basic <route>.<group>:<token>`; a wrong token gets 407 and nothing else happens.
//   - The health probe (4.8 §3.3): a CONNECT whose target is exactly the group's re-entry point `127.0.0.1:<reenterPort>` is answered `200`, then every
//     `HEAD`/`GET /asight-health/<group>` in the tunnel is answered `204 No Content`, `Content-Length: 0`, connection kept. No upstream is dialled.
//   - Any other CONNECT is dialled DIRECT (this fixture's only upstream; the real engine re-enters the VPN) and the bytes are piped; a failed dial is a 502,
//     never a `200` first (4.8 §5.1).
//   - Anything that is not a CONNECT closes the connection (the real engine records `ingress-unknown`).
// node:* only: the same file runs on Windows.
import net from 'node:net'

const HEAD_END = Buffer.from('\r\n\r\n')
const CRLF2 = '\r\n\r\n'

/** Parses a request head (up to and including the blank line) into { method, target, headers }, or null when it is not an HTTP/1.x request line. */
export function parseHead(buf) {
  const text = buf.toString('latin1')
  const first = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r\n/.exec(text)
  if (!first) return null
  const headers = {}
  for (const line of text.slice(first[0].length, text.length - CRLF2.length).split('\r\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim() }
  return { method: first[1], target: first[2], headers }
}

/**
 * @param {{port?:number, host?:string, token:string, reenterPort:number, onEvent?:(e:object)=>void}} o
 * @returns {Promise<{port:number, events:object[], closeAll:()=>void, close:()=>Promise<void>}>}
 */
export function startEngineFixture({ port = 0, host = '127.0.0.1', token, reenterPort, onEvent = () => {} }) {
  const events = []
  const sockets = new Set()
  const emit = (e) => { const ev = { t: Date.now(), ...e }; events.push(ev); onEvent(ev) }
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => {})
    const raw = []
    let buf = Buffer.alloc(0)
    let state = 'head' // head -> probe | tunnel | closed
    let ctx = null
    const onData = (chunk) => {
      raw.push(chunk)
      if (state === 'tunnel') return
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const end = buf.indexOf(HEAD_END)
        if (end < 0) { if (buf.length > 16384) sock.destroy(); return }
        const head = buf.subarray(0, end + 4); buf = buf.subarray(end + 4)
        if (state === 'head') {
          const req = parseHead(head)
          if (!req || req.method !== 'CONNECT') { emit({ kind: 'unknown', method: req ? req.method : null }); sock.destroy(); return }
          const cred = /^Basic (.+)$/i.exec(req.headers['proxy-authorization'] || '')
          const [user, pass] = cred ? Buffer.from(cred[1], 'base64').toString('utf8').split(/:(.*)/s, 2) : [null, null]
          if (pass !== token) { emit({ kind: 'auth-failed', target: req.target }); sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="asight"\r\nContent-Length: 0\r\n\r\n'); state = 'closed'; return }
          const [route, ...rest] = String(user).split('.')
          ctx = { route, group: rest.join('.'), target: req.target }
          if (req.target === `127.0.0.1:${reenterPort}`) {
            state = 'probe'; sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
            emit({ kind: 'probe-connect', route: ctx.route, group: ctx.group })
            continue // more bytes (the tunnel's HEAD) may already be in buf
          }
          // an ordinary connection: dial it direct, answer 200 only once it is up
          state = 'tunnel'
          const m = /^(.+):(\d+)$/.exec(req.target)
          const up = net.connect({ host: m[1], port: Number(m[2]) })
          sockets.add(up); up.on('close', () => sockets.delete(up)); up.on('error', () => {})
          up.once('connect', () => { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (buf.length) up.write(buf); buf = Buffer.alloc(0); sock.pipe(up); up.pipe(sock); emit({ kind: 'agent-connect', route: ctx.route, group: ctx.group, target: req.target }) })
          up.once('error', () => { if (!sock.destroyed) sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); emit({ kind: 'agent-dial-failed', target: req.target }) })
          sock.removeListener('data', onData); sock.pause() // the pipe owns the stream from here (bytes already read are in `buf`)
          return
        }
        // state === 'probe': a request inside the tunnel
        const req = parseHead(head)
        const probe = req && (req.method === 'HEAD' || req.method === 'GET') && req.target === `/asight-health/${ctx.group}`
        if (!probe) { emit({ kind: 'probe-bad-request', method: req ? req.method : null }); sock.destroy(); return }
        sock.write('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
        emit({ kind: 'probe-request', method: req.method, path: req.target })
      }
    }
    sock.on('data', onData)
    sock.on('close', () => { if (ctx && state === 'probe') emit({ kind: 'probe-closed', raw: Buffer.concat(raw).toString('base64') }) })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({
      port: server.address().port,
      events,
      closeAll() { for (const s of sockets) s.destroy() },
      close() { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(() => r())) },
    }))
  })
}
