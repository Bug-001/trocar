// scripts/perf-capture-peer.mjs — the forked peer of scripts/perf-capture.mjs: everything that is NOT asight, so the
// parent's CPU is the daemon's alone. Holds the mock upstream (TLS, a CA of its own, an echo-sized reply) and the
// agent-side client loop (CONNECT through the door with its credentials, TLS trusting the asight root, one request).
import net from 'node:net'
import tls from 'node:tls'
import { createCa, loadCa } from '../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../src/collector/core/tls/leaf.mjs'

const body = (n) => `{"model":"perf","input":"${'x'.repeat(Math.max(0, n - 32))}"}`

export async function peer() {
  const ca = createCa({ commonName: 'perf upstream CA' })
  const issuer = createLeafIssuer(loadCa(ca))
  let replySize = 2048
  const server = tls.createServer({ SNICallback: (s, cb) => cb(null, issuer.secureContextFor(s)) }, (s) => {
    s.on('error', () => {})
    let b = Buffer.alloc(0), len = -1, head = -1
    s.on('data', (d) => {
      b = Buffer.concat([b, d])
      if (head < 0) { const i = b.indexOf('\r\n\r\n'); if (i < 0) return; head = i + 4; len = Number(/content-length: (\d+)/i.exec(b.subarray(0, i).toString('latin1'))[1]) }
      if (b.length - head < len) return
      const payload = body(replySize)
      s.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
      b = Buffer.alloc(0); head = -1
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const target = `localhost:${server.address().port}`
  process.send({ kind: 'up', caPem: ca.certPem, target })

  let cfg = null, cursor = 0
  // One monotonic local port per connection for the whole run, never reused (a reused one is in TIME_WAIT) and never
  // shared between sizes; EADDRINUSE on bind just takes the next. Fixed ports are what lets the parent's fake netstat
  // name this "agent"'s sockets without listing a whole range (which would charge the daemon for the parse).
  const one = async (req, rootPem) => {
    let raw = null
    for (let tries = 0; ; tries++) {
      const localPort = cursor++
      raw = net.connect({ port: cfg.door, host: '127.0.0.1', localAddress: '127.0.0.1', localPort })
      try { await new Promise((res, rej) => { raw.once('connect', res); raw.once('error', rej) }); break } catch (e) {
        raw.destroy()
        if (e.code !== 'EADDRINUSE' || tries > 50) throw e
      }
    }
    raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${cfg.auth}\r\n\r\n`)
    await new Promise((res, rej) => { let s = ''; const on = (d) => { s += d.toString('latin1'); if (s.includes('\r\n\r\n')) { raw.off('data', on); s.startsWith('HTTP/1.1 200') || s.startsWith('HTTP/1.0 200') ? res() : rej(new Error(s.split('\r\n')[0])) } }; raw.on('data', on); raw.once('error', rej) })
    const c = tls.connect({ socket: raw, servername: 'localhost', ca: [rootPem] })
    await new Promise((res, rej) => { c.once('secureConnect', res); c.once('error', rej) })
    const got = new Promise((res, rej) => { let s = 0; c.on('data', (d) => { s += d.length; if (s >= cfg.expect) res(s) }); c.once('error', rej) })
    c.write(req)
    await got
    await new Promise((r) => { c.once('close', r); c.end(); raw.once('close', r) })
  }

  process.on('message', (m) => { handle(m).catch((e) => process.send({ kind: 'error', error: String((e && e.stack) || e) })) })
  async function handle(m) {
    if (m.kind === 'bye') process.exit(0)
    if (m.kind === 'start') return
    if (m.kind === 'run') {
      replySize = m.size
      const payload = body(m.size)
      const req = `POST /v1/responses HTTP/1.1\r\nHost: ${target}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
      cfg = { ...m, req, expect: Buffer.byteLength(body(m.size)) }
      if (!cursor) cursor = m.portBase
      for (let i = 0; i < m.warm; i++) await one(req, m.rootPem)
      process.send({ kind: 'warmed' })
      return
    }
    if (m.kind === 'go') {
      let sent = 0
      for (let i = 0; i < cfg.n; i++) { await one(cfg.req, cfg.rootPem); sent++; if (cfg.gap) await new Promise((r) => setTimeout(r, cfg.gap)) }
      process.send({ kind: 'done', sent })
    }
  }
  await new Promise(() => {})
}
